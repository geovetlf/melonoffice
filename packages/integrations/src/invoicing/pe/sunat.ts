import type {
  FiscalAuthorityStatus,
  FiscalDocumentType,
  FiscalVoidStatus,
  TaxIdentifier,
} from '@melonoffice/domain';

/**
 * Peru's codes and rules (ADR-0193), for the adapters that read Peruvian invoicing. The gateway
 * and the normalized model know none of this: an adapter maps SUNAT's values into them here.
 *
 * Sources, read on 2026-10-13:
 * - Manual de Consulta Integrada de Comprobante de Pago por Servicio Web v2.0 (`estadoCp`):
 *   https://cpe.sunat.gob.pe/sites/default/files/inline-files/Manual-de-Consulta-Integrada-de-Comprobante-de-Pago-por-ServicioWEB_v2_0.pdf
 * - Operatividad del SEE (acceptance, observations, rejection, voiding):
 *   https://orientacion.sunat.gob.pe/3529-operatividad
 */

export const PE_RUC_SCHEME = 'PE:RUC';
export const PE_DNI_SCHEME = 'PE:DNI';

const RUC_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;

/** Whether a RUC is 11 digits with a known prefix and a valid check digit (modulo 11). */
export function isValidRuc(value: string): boolean {
  if (!/^(10|15|17|20)\d{9}$/.test(value)) return false;
  const sum = RUC_WEIGHTS.reduce((total, weight, i) => total + weight * Number(value[i]), 0);
  const check = (11 - (sum % 11)) % 10;
  return check === Number(value[10]);
}

export const peRuc = (value: string): TaxIdentifier | undefined =>
  isValidRuc(value) ? { scheme: PE_RUC_SCHEME, value } : undefined;

/**
 * SUNAT's document types (catálogo 01) that version 1 reads, and what each is across
 * jurisdictions. Anything else is `other`, its code kept as `sourceType`.
 */
const DOCUMENT_TYPES: Readonly<Record<string, FiscalDocumentType>> = Object.freeze({
  '01': 'invoice',
  '03': 'receipt',
  '07': 'credit_note',
  '08': 'debit_note',
});

export const peDocumentType = (code: string): FiscalDocumentType => DOCUMENT_TYPES[code] ?? 'other';

/**
 * The Consulta Integrada's `estadoCp`, as the authority status and the void status, apart:
 *
 * - 0 NO EXISTE: SUNAT has no record of it.
 * - 1 ACEPTADO.
 * - 2 ANULADO: it was accepted and then voided (comunicación de baja).
 * - 3 AUTORIZADO: a printed document authorized through its printer; valid.
 * - 4 NO AUTORIZADO: a printed document without authorization; no fiscal effect.
 *
 * An unknown value is not guessed: `not_reported`, its code kept for tracing.
 */
export function peConsultaStatus(estadoCp: string): {
  readonly authorityStatus: FiscalAuthorityStatus;
  readonly voidStatus: FiscalVoidStatus;
  readonly authorityStatusCode: string;
} {
  const code = `sunat_cp:${estadoCp}`;
  switch (estadoCp) {
    case '0':
      return { authorityStatus: 'not_found', voidStatus: 'none', authorityStatusCode: code };
    case '1':
    case '3':
      return { authorityStatus: 'accepted', voidStatus: 'none', authorityStatusCode: code };
    case '2':
      return { authorityStatus: 'accepted', voidStatus: 'voided', authorityStatusCode: code };
    case '4':
      return { authorityStatus: 'rejected', voidStatus: 'none', authorityStatusCode: code };
    default:
      return {
        authorityStatus: 'not_reported',
        voidStatus: 'none',
        authorityStatusCode: /^[A-Za-z0-9]{1,8}$/.test(estadoCp) ? code : 'sunat_cp:unknown',
      };
  }
}
