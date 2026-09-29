import { crc32, deflateRawSync } from 'node:zlib';

/** Files built by hand for tests (ADR-0079): no binary fixture is committed. */

/** A minimal, valid PDF: one content stream per page, with a correct cross-reference table. */
export function buildPdf(
  pages: readonly string[],
  options: { readonly encrypted?: boolean } = {},
): Uint8Array {
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const first = 4 + pages.length * 2;
  if (options.encrypted === true) {
    // The standard security handler with a user password that the empty one does not match.
    const hex = 'ab'.repeat(32);
    objects[first] = `<< /Filter /Standard /V 1 /R 2 /O <${hex}> /U <${hex}> /P -4 >>`;
  }
  pages.forEach((content, i) => {
    const page = 4 + i * 2;
    objects[page] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R >>`;
    objects[page + 1] =
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i += 1) {
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i += 1) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const encrypt =
    options.encrypted === true
      ? ` /Encrypt ${first} 0 R /ID [<${'01'.repeat(16)}> <${'01'.repeat(16)}>]`
      : '';
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R${encrypt} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

export const textPage = (text: string) => `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
/** A page with only a filled rectangle: what a scan without a text layer looks like to a reader. */
export const blankPage = '0 0 1 rg 10 10 100 100 re f';

interface ZipFile {
  readonly name: string;
  readonly data: Uint8Array;
  readonly method?: 0 | 8;
  readonly flags?: number;
  /** Overrides what the central directory says. */
  readonly declaredSize?: number;
  readonly crc?: number;
}

/** A zip archive written by hand, so that each field can be made wrong on purpose. */
export function buildZip(files: readonly ZipFile[], options: { zip64?: boolean } = {}): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const method = file.method ?? 8;
    const body = method === 8 ? deflateRawSync(file.data) : Buffer.from(file.data);
    const name = Buffer.from(file.name, 'utf8');
    const crc = file.crc ?? crc32(file.data);
    const size = file.declaredSize ?? file.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(file.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(file.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const locator = Buffer.alloc(options.zip64 === true ? 20 : 0);
  if (options.zip64 === true) locator.writeUInt32LE(0x07064b50, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, locator, end]));
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
export const wordXml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body}</w:body></w:document>`;
export const buildDocx = (body: string) =>
  buildZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: 'word/document.xml', data: Buffer.from(wordXml(body)) },
  ]);
