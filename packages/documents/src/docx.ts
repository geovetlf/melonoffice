import { crc32, inflateRawSync } from 'node:zlib';

/**
 * Reading a Word document's text (Document Engine DOC-2, ADR-0079), with no third-party code.
 * A DOCX is a zip archive; its text is in `word/document.xml`. The file is untrusted: the zip
 * reader reads only the central directory and that one entry, within fixed limits, and refuses
 * what it cannot read safely (zip64, encryption, sizes that do not add up, too many entries, an
 * entry larger than the limit). The XML is never given to an XML parser: a small tokenizer reads
 * the text runs, so no DTD or external entity can ever be resolved.
 */

/** The most `word/document.xml` may inflate to. */
export const MAX_DOCX_XML_BYTES = 20 * 1024 * 1024;
/** The most entries an archive may list. Word writes a few dozen. */
export const MAX_ZIP_ENTRIES = 5_000;
/** The most text kept; anything longer is cut and marked `truncated`. */
export const MAX_EXTRACTED_CHARACTERS = 200_000;

export type DocxFailure = 'unreadable' | 'too_large' | 'encrypted';

export class DocxError extends Error {
  override readonly name = 'DocxError';
  constructor(readonly code: DocxFailure) {
    super(code);
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;

const unreadable = () => new DocxError('unreadable');

/** One entry of the central directory, as far as this reader needs it. */
interface ZipEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

/**
 * The bytes of one entry of a zip archive, or undefined when the archive has no such entry.
 * Only stored and deflated entries, never encrypted ones or zip64 archives; the entry's declared
 * size must be within `maxBytes` and its data must inflate to exactly that size and checksum.
 */
export function readZipEntry(
  bytes: Uint8Array,
  wanted: string,
  maxBytes: number,
): Uint8Array | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  if (bytes.length < EOCD_SIZE) throw unreadable();

  // The end of central directory record: the last one whose comment reaches the end exactly.
  let eocd = -1;
  const lowest = Math.max(0, bytes.length - EOCD_SIZE - MAX_COMMENT);
  for (let at = bytes.length - EOCD_SIZE; at >= lowest; at -= 1) {
    if (u32(at) === EOCD_SIGNATURE && at + EOCD_SIZE + u16(at + 20) === bytes.length) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw unreadable();
  // Zip64 is never needed for a 10 MB file: refused rather than read.
  if (eocd >= 20 && u32(eocd - 20) === ZIP64_LOCATOR_SIGNATURE) throw unreadable();
  const disk = u16(eocd + 4);
  const directoryDisk = u16(eocd + 6);
  const entriesHere = u16(eocd + 8);
  const entries = u16(eocd + 10);
  const directorySize = u32(eocd + 12);
  const directoryOffset = u32(eocd + 16);
  if (
    disk !== 0 ||
    directoryDisk !== 0 ||
    entriesHere !== entries ||
    entries === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw unreadable();
  }
  if (entries > MAX_ZIP_ENTRIES) throw new DocxError('too_large');
  if (directoryOffset + directorySize > eocd) throw unreadable();

  let found: ZipEntry | undefined;
  let at = directoryOffset;
  const end = directoryOffset + directorySize;
  for (let i = 0; i < entries; i += 1) {
    if (at + CENTRAL_SIZE > end || u32(at) !== CENTRAL_SIGNATURE) throw unreadable();
    const nameLength = u16(at + 28);
    const next = at + CENTRAL_SIZE + nameLength + u16(at + 30) + u16(at + 32);
    if (next > end) throw unreadable();
    const name = new TextDecoder('latin1').decode(
      bytes.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength),
    );
    const entry: ZipEntry = {
      name,
      flags: u16(at + 8),
      method: u16(at + 10),
      crc: u32(at + 16),
      compressedSize: u32(at + 20),
      size: u32(at + 24),
      localOffset: u32(at + 42),
    };
    if (entry.name === wanted) {
      // Two entries with the same name could be read differently by different readers.
      if (found !== undefined) throw unreadable();
      found = entry;
    }
    at = next;
  }
  if (found === undefined) return undefined;
  return entryData(bytes, u16, u32, found, directoryOffset, maxBytes);
}

function entryData(
  bytes: Uint8Array,
  u16: (at: number) => number,
  u32: (at: number) => number,
  entry: ZipEntry,
  directoryOffset: number,
  maxBytes: number,
): Uint8Array {
  // Bit 0: encrypted; bit 6: strong encryption.
  if ((entry.flags & 0x41) !== 0) throw new DocxError('encrypted');
  if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff) throw unreadable();
  if (entry.size > maxBytes) throw new DocxError('too_large');
  const local = entry.localOffset;
  if (local + LOCAL_SIZE > directoryOffset || u32(local) !== LOCAL_SIGNATURE) throw unreadable();
  // The local header must say the same as the directory: readers that trust one or the other
  // must never see different files.
  if (u16(local + 8) !== entry.method || (u16(local + 6) & 0x41) !== 0) throw unreadable();
  const start = local + LOCAL_SIZE + u16(local + 26) + u16(local + 28);
  const stop = start + entry.compressedSize;
  // The data lies before the central directory, inside the file.
  if (stop > directoryOffset) throw unreadable();
  const raw = bytes.subarray(start, stop);
  let data: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw unreadable();
    data = raw;
  } else if (entry.method === 8) {
    try {
      // Never inflates past the declared size: a zip bomb stops here.
      data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
    } catch (error) {
      throw (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE'
        ? new DocxError('too_large')
        : unreadable();
    }
  } else {
    throw unreadable();
  }
  if (data.length !== entry.size || crc32(data) >>> 0 !== entry.crc) throw unreadable();
  return data;
}

const ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/** A character reference as text: only a valid, non-control code point; otherwise U+FFFD. */
function codePoint(value: number): string {
  const allowed =
    value === 0x9 ||
    value === 0xa ||
    value === 0xd ||
    (value >= 0x20 && value <= 0xd7ff) ||
    (value >= 0xe000 && value <= 0xfffd) ||
    (value >= 0x10000 && value <= 0x10ffff);
  return allowed ? String.fromCodePoint(value) : '�';
}

/**
 * Decodes the five predefined XML entities and numeric character references. Any other entity
 * is left as written: nothing is ever looked up in a DTD.
 */
export function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (whole, ref: string) => {
    if (ref.startsWith('#x')) return codePoint(Number.parseInt(ref.slice(2), 16));
    if (ref.startsWith('#')) return codePoint(Number.parseInt(ref.slice(1), 10));
    return ENTITIES[ref] ?? whole;
  });
}

/**
 * The text of a WordprocessingML body: the `w:t` runs, a tab for `w:tab`, a line break for
 * `w:br`, `w:cr` and the end of each paragraph. Deleted text and field codes are not text.
 * A document type declaration is refused outright.
 */
export function wordXmlText(
  xml: string,
  maxCharacters = MAX_EXTRACTED_CHARACTERS,
): { readonly text: string; readonly truncated: boolean } {
  if (/<!DOCTYPE/i.test(xml)) throw unreadable();
  const out: string[] = [];
  let length = 0;
  let inText = false;
  const push = (piece: string): boolean => {
    out.push(piece);
    length += piece.length;
    return length > maxCharacters;
  };
  // A tag, or the text up to the next tag. Neither can backtrack: each is one negated class.
  const token = /<[^>]*>|[^<]+/g;
  for (let match = token.exec(xml); match !== null; match = token.exec(xml)) {
    const value = match[0];
    if (!value.startsWith('<')) {
      if (inText && push(decodeXmlText(value))) break;
      continue;
    }
    const tag = /^<(\/?)w:([A-Za-z]+)[\s/>]/.exec(value);
    if (tag === null) continue;
    const closing = tag[1] === '/';
    const name = tag[2];
    const selfClosing = value.endsWith('/>');
    if (name === 't') {
      inText = !closing && !selfClosing;
    } else if (!closing && name === 'tab') {
      if (push('\t')) break;
    } else if (!closing && (name === 'br' || name === 'cr')) {
      if (push('\n')) break;
    } else if (closing && name === 'p') {
      if (push('\n')) break;
    }
  }
  const text = out.join('');
  return text.length > maxCharacters
    ? { text: text.slice(0, maxCharacters), truncated: true }
    : { text, truncated: false };
}

/** A DOCX's text, read from `word/document.xml` only. */
export function docxText(bytes: Uint8Array): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const xml = readZipEntry(bytes, 'word/document.xml', MAX_DOCX_XML_BYTES);
  if (xml === undefined) throw unreadable();
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(xml);
  } catch {
    throw unreadable();
  }
  return wordXmlText(decoded);
}
