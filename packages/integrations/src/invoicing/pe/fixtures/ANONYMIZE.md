# Anonymizing exported UBL files

How to turn XML files a customer exported (facturas, boletas, notas) into files that can test the `pe_ubl_files` adapter without anyone keeping identifiable fiscal documents ([ADR-0193](../../../../../../docs/adr/0193-billing-integration-gateway.md)).

## Rules

- The originals never leave the machine that holds them: no upload, no chat, no e-mail, no cloud drive, no external validator.
- Neither the originals nor the anonymized files go into this repository. The script refuses an input or output directory inside it.
- The script needs no network and calls nothing. It reads files, writes files and prints counts.
- Use only files the customer has agreed to lend for this test, and delete the originals from the working machine when done.

## Steps

1. On a machine with the repository and Node 22 (for example Cloud Shell), put the originals in a directory outside the repository, such as `~/ubl-originales/`.
2. Build the package once:

   ```sh
   pnpm --filter @melonoffice/integrations build
   ```

3. Run the script with the RUC of the company the files belong to:

   ```sh
   node packages/integrations/scripts/anonymize-ubl.mjs --ruc <RUC de la empresa> ~/ubl-originales ~/ubl-anonimizados
   ```

4. Read `~/ubl-anonimizados/REPORT.txt`. It gives the synthetic RUC that stands for the company (use it as the test connection's RUC), and for each file either `ok` with counts of what was replaced, or `not written` with a code. It never shows original values or file names.
5. Review a couple of output files by eye before sharing them.

## What it changes and keeps

Replaced: every RUC (by a valid synthetic RUC of the same type, `XX999NNNNNC`), DNI and other party identifiers, registered and trade names, contact names, addresses, e-mails and phones, item descriptions and product codes, legends (`cbc:Note`), note reasons, bank accounts, every signature value and certificate, and comments. The same original gets the same replacement in every file of one run, so a note still points at its invoice and a customer is still the same customer.

Kept: the structure, namespaces and prefixes, document type, series and number, dates, currency, quantities, unit codes, prices, amounts, tax codes and the references between documents. These are what the adapter reads. Amounts and dates together may still let someone who already knows the business guess a document; if that matters, choose files where it does not.

## How a file is checked before it is written

A file is written only if all three checks pass; otherwise it is reported as `not written` and nothing of it is kept:

1. No original value that was replaced appears anywhere in the output: text, CDATA, attributes or raw bytes (`anonymize.leftover`).
2. Every valid RUC left in the output is one of the synthetic ones (`anonymize.leftover`).
3. The adapter reads the output as the same document: direction, type, series, number, dates, currency, totals, every line's quantity, unit, price, amounts and tax code, and the references (`anonymize.changed`).

A file the adapter itself refuses (another company's, malformed, unsafe) is reported with the adapter's own code, such as `not_this_account` or `doctype`.

The same procedure runs in the tests on the synthetic fixtures (`anonymize.test.ts`).

## Limits

- Values the adapter does not know as identifying (a name hidden in an unusual extension element, for instance) are caught only if they are a valid RUC. Review the output by eye.
- A value written in an attribute is not replaced; the file is refused instead (check 1).
- Files in encodings other than UTF-8 and ISO-8859-1, and ZIP files, are not read: unzip first.
