# Synthetic SUNAT UBL 2.1 fixtures

These files test the `pe_ubl_files` adapter ([ADR-0193](../../../../../../docs/adr/0193-billing-integration-gateway.md)). **They are not real fiscal documents.** Every party, RUC, DNI, series, number and amount is invented, and the signature is a placeholder. The RUCs pass SUNAT's check digit but were chosen in an unused-looking range (`2099999901x`…); `ubl-fixtures.test.ts` fails if any other valid RUC appears in a fixture.

They follow SUNAT's _Guía de elaboración de documentos XML_ for UBL 2.1 (factura and boleta, version 1.0), read from cpe.sunat.gob.pe on 2026-10-13, and the structures later guides and most systems use. SUNAT publishes no downloadable sample files that this environment can reach, so no official sample is included.

Passing these files proves what the reader does with each structure. It does not prove that files a real system exports read the same: **the adapter is not operational** until real exported files, anonymized with [`ANONYMIZE.md`](ANONYMIZE.md), pass the same suite.

## Files

| File                                     | Document                          | What it covers                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `factura-estructura-2018.xml`            | Factura (01), PEN                 | The 2018 guide's parties: `cac:PartyTaxScheme/cbc:CompanyID@schemeID` and `cbc:RegistrationName`; trade name in `cac:PartyName`. `IssueTime`, `DueDate`, legends (`cbc:Note`), `LineCountNumeric`, UNSPSC, `AllowanceTotalAmount`, `ChargeTotalAmount`, `PrepaidAmount` 0. `&`, `<` and quotes inside CDATA. |
| `factura-prefijos-distintos.xml`         | Factura (01)                      | The same document with a prefixed root (`inv:Invoice`), other prefixes for `cac`/`cbc` (`agg`, `basic`) and a namespace declared again inside a party (`x:`).                                                                                                                                                |
| `factura-afectaciones-y-gratuita.xml`    | Factura (01)                      | Lines gravada (10), exonerada (20), inafecta (30) and a free retiro (11, `PriceTypeCode` 02, `PriceAmount` 0). Document subtotals 1000, 9997, 9998 and 9996.                                                                                                                                                 |
| `factura-isc-icbper.xml`                 | Factura (01)                      | ISC (2000, `TierRange` 01) listed before IGV on the same line, and ICBPER (7152, `PerUnitAmount`, `BaseUnitMeasure`) on a bag line.                                                                                                                                                                          |
| `factura-exportacion-usd.xml`            | Factura (01), USD, operation 0200 | Export (40, tax scheme 9995). A non-domiciled buyer, catálogo 06 code `0`.                                                                                                                                                                                                                                   |
| `factura-anticipo-detraccion-cuotas.xml` | Factura (01), operation 1001      | An advance deducted (`PrepaidPayment`, `AdditionalDocumentReference` 02, `PrepaidAmount`), detracción (`PaymentMeans`, `PaymentTerms` 037 at 12 %), credit in two instalments (`FormaPago`, `Cuota001`, `Cuota002`). No `DueDate`.                                                                           |
| `boleta-cliente-sin-documento.xml`       | Boleta (03)                       | A customer with no document: `schemeID="0"`, `-`, name `-`.                                                                                                                                                                                                                                                  |
| `boleta-dni-iso-8859-1.xml`              | Boleta (03)                       | ISO-8859-1 bytes, a DNI customer (`schemeID="1"`), accented letters and `Ñ` in names, character references (`&#8211;`, `&#37;`) and `&lt;…&gt;` in a description written without CDATA.                                                                                                                      |
| `nota-credito-sobre-boleta.xml`          | Nota de crédito (07)              | A note on a boleta (`DocumentTypeCode` 03), reason 07 (devolución por ítem), `CreditedQuantity`.                                                                                                                                                                                                             |
| `nota-credito-varias-facturas.xml`       | Nota de crédito (07)              | One note correcting two facturas (two `BillingReference`s), reason 04 (descuento global).                                                                                                                                                                                                                    |
| `nota-debito-intereses.xml`              | Nota de débito (08)               | `RequestedMonetaryTotal`, `DebitedQuantity`, reason 01 (intereses por mora).                                                                                                                                                                                                                                 |
| `compra-recibida.xml`                    | Factura (01) received             | A purchase: the organization is the customer, the issuer a persona natural (RUC 10…), series `E001` (SEE-SOL), a line with no product code.                                                                                                                                                                  |

## What the adapter reads, and what it leaves out

Read from every document: type (catálogo 01), series and number, issue and due dates, currency, the issuer and the customer (RUC, DNI, carné de extranjería or pasaporte; any other catálogo 06 code is kept by name only), totals (`LineExtensionAmount`, the one document `TaxTotal/TaxAmount`, `PayableAmount`), and per line the quantity and unit, `Price/PriceAmount`, `LineExtensionAmount`, the line's total tax, the IGV affectation code (catálogo 07, from whichever subtotal carries it), the seller's product code and the description (cut at 500 characters). A note keeps every document it corrects.

Read but not kept separately: the breakdown of taxes by scheme (IGV, ISC, ICBPER, exports and free operations count only inside the line and document totals), allowances and charges, the advance (`PrepaidAmount` only lowers `PayableAmount`), detracción, instalments (`FormaPago`), legends, the note's reason code (`DiscrepancyResponse`), referential prices (`PricingReference`), UNSPSC codes, addresses and the trade name when a registered name exists.

Never read: the digital signature (not verified), SUNAT's answer (that is the CDR, a separate file: every document stays `not_reported`), payments.

## Refused on purpose

- Any `<!DOCTYPE` or other declaration (no XXE, no entity expansion), an undeclared entity, a bare `&`, control characters, an undeclared prefix, crossed or unclosed tags, a second root, encodings other than UTF-8 and ISO-8859-1.
- More than 64 levels, 50,000 elements, 1,000 lines or 2 MB (the API takes at most 1 MB).
- An amount whose `currencyID` is missing, misspelt (one SUNAT guide example writes `CurrencyID`) or differs from the document's currency.
- A supplier without a valid RUC, a party whose `PartyIdentification` and `PartyTaxScheme` disagree, a document of another company, a note that names no document, UBL other than 2.1.

## Not covered yet

Guías de remisión, retenciones and percepciones (other roots), resúmenes diarios and comunicaciones de baja, the CDR, ZIP files, and real exports from any PSE or from SEE-SOL.
