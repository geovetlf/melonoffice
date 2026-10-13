#!/usr/bin/env node
/**
 * Anonymizes exported SUNAT UBL 2.1 files on this machine (procedure:
 * `packages/integrations/src/invoicing/pe/fixtures/ANONYMIZE.md`). Nothing is sent anywhere.
 *
 *   pnpm --filter @melonoffice/integrations build
 *   node packages/integrations/scripts/anonymize-ubl.mjs --ruc <organization RUC> <input dir> <output dir>
 *
 * Both directories must be outside the repository, and the output directory must be empty. Each
 * file is written only if its checks pass; the report lists counts and file numbers, never the
 * original values or file names.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repository = realpathSync(resolve(here, '../../..'));
const built = join(here, '../dist/invoicing/pe/anonymize.js');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const at = args.indexOf('--ruc');
const ruc = at >= 0 ? args[at + 1] : undefined;
const [input, output] = args.filter((_, i) => i !== at && i !== at + 1);
if (ruc === undefined || input === undefined || output === undefined) {
  fail('Usage: anonymize-ubl.mjs --ruc <organization RUC> <input dir> <output dir>');
}
if (!existsSync(built)) fail('Build first: pnpm --filter @melonoffice/integrations build');

const inside = (path) => {
  const r = relative(repository, path);
  return r === '' || (!r.startsWith('..') && !r.startsWith('/'));
};
const inputDir = realpathSync(resolve(input));
// Checked before anything is created, and again once links are resolved.
if (inside(inputDir) || inside(resolve(output))) {
  fail('Originals and anonymized files stay outside the repository.');
}
mkdirSync(resolve(output), { recursive: true });
const outputDir = realpathSync(resolve(output));
if (inside(outputDir)) fail('Originals and anonymized files stay outside the repository.');
if (readdirSync(outputDir).length > 0) fail('The output directory must be empty.');

const { createUblAnonymizer } = await import(built);
const anonymizer = createUblAnonymizer();
const testRuc = anonymizer.rucFor(ruc);
const files = readdirSync(inputDir)
  .filter((name) => name.toLowerCase().endsWith('.xml'))
  .sort();
const report = [];
let written = 0;
files.forEach((name, i) => {
  const number = String(i + 1).padStart(3, '0');
  try {
    const result = anonymizer.anonymize(readFileSync(join(inputDir, name)), { taxId: ruc });
    writeFileSync(join(outputDir, `anon-${number}.xml`), result.content);
    written += 1;
    report.push(`anon-${number}.xml  ok  ${JSON.stringify(result.replaced)}`);
  } catch (error) {
    // The detail is a stable code (`anonymize.leftover`, `not_this_account`…), never file content.
    const code = error && typeof error === 'object' && 'detail' in error ? error.detail : 'error';
    report.push(`file ${number}  not written  ${code}`);
  }
});
const summary = [
  `Test connection RUC: ${testRuc}`,
  `Files read: ${files.length}; written: ${written}`,
  ...report,
].join('\n');
writeFileSync(join(outputDir, 'REPORT.txt'), `${summary}\n`);
process.stdout.write(`${summary}\n`);
