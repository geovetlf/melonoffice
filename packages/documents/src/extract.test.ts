import { describe, expect, it } from 'vitest';
import { DOCX_CONTENT_TYPE } from './content.js';
import { decodeXmlText, docxText, readZipEntry, wordXmlText } from './docx.js';
import { createTextExtractor, pdfText } from './extract.js';
import { blankPage, buildDocx, buildPdf, buildZip, textPage, wordXml } from './test-fixtures.js';

describe('DOCX text (ADR-0079)', () => {
  it('reads runs, tabs, breaks and paragraphs', () => {
    const docx = buildDocx(
      '<w:p><w:r><w:t>Lista de precios</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t xml:space="preserve">Café </w:t><w:tab/><w:t>12 &amp; 13 &lt;USD&gt;</w:t>' +
        '<w:br/><w:t>&#241;&#x00E1;&quot;&apos;</w:t></w:r></w:p>',
    );
    expect(docxText(docx)).toEqual({
      text: 'Lista de precios\nCafé \t12 & 13 <USD>\nñá"\'\n',
      truncated: false,
    });
  });

  it('never treats deleted text, field codes or other markup as text', () => {
    expect(
      wordXmlText(
        wordXml(
          '<w:p><w:r><w:delText>borrado</w:delText><w:instrText>HYPERLINK</w:instrText>' +
            '<w:t>visible</w:t></w:r></w:p>',
        ),
      ).text,
    ).toBe('visible\n');
  });

  it('decodes only the five entities and numeric references', () => {
    expect(decodeXmlText('&lt;&gt;&amp;&quot;&apos;&xxe;&#0;&#xD800;&#65;')).toBe('<>&"\'&xxe;��A');
  });

  it('refuses a document type declaration', () => {
    expect(() =>
      wordXmlText('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><w:t>&e;</w:t>'),
    ).toThrow('unreadable');
  });

  it('cuts long text and says so', () => {
    const body = `<w:p><w:r><w:t>${'a'.repeat(50)}</w:t></w:r></w:p>`.repeat(10);
    expect(wordXmlText(wordXml(body), 120)).toEqual({
      text: `${'a'.repeat(50)}\n${'a'.repeat(50)}\n${'a'.repeat(18)}`,
      truncated: true,
    });
  });

  it('reads stored (uncompressed) entries', () => {
    const zip = buildZip([{ name: 'word/document.xml', data: Buffer.from('hola'), method: 0 }]);
    expect(Buffer.from(readZipEntry(zip, 'word/document.xml', 100) ?? []).toString()).toBe('hola');
  });

  const failureOf = async (bytes: Uint8Array) => {
    const result = await createTextExtractor().extract(DOCX_CONTENT_TYPE, bytes);
    return result.status === 'failed' ? result.code : result.status;
  };

  it('refuses malformed and hostile archives with closed codes', async () => {
    const xml = Buffer.from(wordXml('<w:p><w:r><w:t>x</w:t></w:r></w:p>'));
    // Not a zip at all, or cut short.
    expect(await failureOf(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toBe('unreadable');
    const good = buildDocx('<w:p><w:r><w:t>x</w:t></w:r></w:p>');
    expect(await failureOf(good.subarray(0, good.length - 30))).toBe('unreadable');
    // No document.xml.
    expect(await failureOf(buildZip([{ name: 'other.xml', data: xml }]))).toBe('unreadable');
    // Encrypted.
    expect(await failureOf(buildZip([{ name: 'word/document.xml', data: xml, flags: 1 }]))).toBe(
      'encrypted',
    );
    // Zip64.
    expect(
      await failureOf(buildZip([{ name: 'word/document.xml', data: xml }], { zip64: true })),
    ).toBe('unreadable');
    // A wrong checksum, or a size that does not match what the data inflates to.
    expect(await failureOf(buildZip([{ name: 'word/document.xml', data: xml, crc: 1 }]))).toBe(
      'unreadable',
    );
    expect(
      await failureOf(
        buildZip([{ name: 'word/document.xml', data: xml, declaredSize: xml.length + 10 }]),
      ),
    ).toBe('unreadable');
    // A local header that disagrees with the directory, or an unknown compression method.
    const disagreeing = buildZip([{ name: 'word/document.xml', data: xml, method: 0 }]);
    Buffer.from(disagreeing.buffer).writeUInt16LE(99, 8);
    expect(await failureOf(disagreeing)).toBe('unreadable');
    const unknown = buildZip([{ name: 'word/document.xml', data: xml, method: 0 }]);
    const central = unknown.length - 22 - 46 - 'word/document.xml'.length;
    Buffer.from(unknown.buffer).writeUInt16LE(99, 8);
    Buffer.from(unknown.buffer).writeUInt16LE(99, central + 10);
    expect(await failureOf(unknown)).toBe('unreadable');
    // The same entry twice.
    expect(
      await failureOf(
        buildZip([
          { name: 'word/document.xml', data: xml },
          { name: 'word/document.xml', data: xml },
        ]),
      ),
    ).toBe('unreadable');
    // Not UTF-8.
    expect(
      await failureOf(
        buildZip([{ name: 'word/document.xml', data: new Uint8Array([0xff, 0xfe]) }]),
      ),
    ).toBe('unreadable');
  });

  it('stops a zip bomb at the declared size and the size limit', async () => {
    const huge = new Uint8Array(21 * 1024 * 1024);
    // Declared larger than the limit: refused before inflating.
    expect(await failureOf(buildZip([{ name: 'word/document.xml', data: huge }]))).toBe(
      'too_large',
    );
    // Declared small, inflating to far more: stopped at the declared size.
    expect(
      await failureOf(buildZip([{ name: 'word/document.xml', data: huge, declaredSize: 1000 }])),
    ).toBe('too_large');
  });

  it('refuses an archive with too many entries', async () => {
    const files = Array.from({ length: 5_001 }, (_, i) => ({
      name: `f${i}`,
      data: new Uint8Array(0),
      method: 0 as const,
    }));
    expect(await failureOf(buildZip(files))).toBe('too_large');
  });

  it('reads an empty document as blank text', async () => {
    const result = await createTextExtractor().extract(DOCX_CONTENT_TYPE, buildDocx(''));
    expect(result).toEqual({ status: 'text', text: '', truncated: false });
  });
});

describe('PDF text (ADR-0079), in a worker thread', () => {
  it('reads the text of every page', async () => {
    const result = await pdfText(buildPdf([textPage('Hola mundo'), textPage('Segunda pagina')]));
    expect(result.status).toBe('text');
    if (result.status !== 'text') return;
    expect(result.pages).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.text).toContain('Hola mundo');
    expect(result.text).toContain('Segunda pagina');
  });

  it('gives blank text for a page with no text layer', async () => {
    const result = await pdfText(buildPdf([blankPage]));
    expect(result).toMatchObject({ status: 'text', pages: 1, truncated: false });
    expect(result.status === 'text' && result.text.trim()).toBe('');
  });

  it('refuses a PDF with more pages than it reads', async () => {
    expect(await pdfText(buildPdf([blankPage, blankPage, blankPage]), { maxPages: 2 })).toEqual({
      status: 'failed',
      code: 'too_many_pages',
      pages: 3,
    });
  });

  it('cuts long text and says so', async () => {
    const result = await pdfText(buildPdf([textPage('x'.repeat(80))]), { maxCharacters: 10 });
    expect(result).toMatchObject({ status: 'text', text: 'x'.repeat(10), truncated: true });
  });

  it('answers encrypted for a PDF that needs a password', async () => {
    expect(await pdfText(buildPdf([textPage('secreto')], { encrypted: true }))).toEqual({
      status: 'failed',
      code: 'encrypted',
    });
  });

  it('answers unreadable for bytes that are not a PDF', async () => {
    const garbage = new Uint8Array(Buffer.from('%PDF-1.7\nthis is not a pdf at all'));
    expect(await pdfText(garbage)).toEqual({ status: 'failed', code: 'unreadable' });
  });

  it('reads one PDF at a time, the others waiting their turn', async () => {
    const extractor = createTextExtractor({ maxConcurrent: 1 });
    const results = await Promise.all(
      ['uno', 'dos', 'tres'].map((word) =>
        extractor.extract('application/pdf', buildPdf([textPage(word)])),
      ),
    );
    expect(results.map((r) => r.status === 'text' && r.text.trim())).toEqual([
      'uno',
      'dos',
      'tres',
    ]);
  });

  it('ends the worker when it takes too long', async () => {
    expect(await pdfText(buildPdf([textPage('a')]), { timeoutMs: 1 })).toEqual({
      status: 'failed',
      code: 'timeout',
    });
  });
});
