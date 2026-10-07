import type { ToolRecordRef, ToolSchema } from '@melonoffice/domain';

/** The records a string input may name by id (ADR-0184): a hint for screens, never a grant. */
export const TOOL_RECORD_REFS = ['contact'] as const satisfies readonly ToolRecordRef[];

/** Limits that keep schemas and inputs small and bounded. */
export const MAX_SCHEMA_DEPTH = 8;
export const MAX_PROPERTIES = 64;
export const MAX_STRING_LENGTH = 100_000;
export const MAX_ITEMS = 1_000;

const PROPERTY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Field names that carry authority or credentials. They come from verified context or from a
 * future credential engine, never from a tool input, so no schema may declare them and no input
 * may carry them, at any depth (ADR-0026). Compared lowercase, without separators.
 */
const AUTHORITY_FIELDS = new Set([
  'organizationid',
  'organization',
  'orgid',
  'tenantid',
  'tenant',
  'userid',
  'actor',
  'role',
  'roles',
  'permission',
  'permissions',
  'approval',
  'approvalid',
  'approved',
  'override',
  'executionid',
  'specialistid',
  'membershipid',
  'authorization',
  'auth',
  'bearer',
  'cookie',
  'session',
  'sessionid',
]);
const CREDENTIAL_PARTS = [
  'apikey',
  'secret',
  'token',
  'password',
  'passwd',
  'credential',
  'privatekey',
  'accesskey',
  'clientsecret',
];

const normalize = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Whether a field name is one a tool input may never carry. */
export function isForbiddenField(name: string): boolean {
  const key = normalize(name);
  return AUTHORITY_FIELDS.has(key) || CREDENTIAL_PARTS.some((part) => key.includes(part));
}

/**
 * Values that look like credentials: bearer tokens, JWTs, private keys and common API key
 * shapes. A tool input carrying one is refused even when its field name looks harmless.
 */
const CREDENTIAL_VALUES = [
  /^bearer\s+\S+/i,
  /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^sk-[A-Za-z0-9_-]{16,}/,
  /^AIza[0-9A-Za-z_-]{30,}/,
  /^gh[pousr]_[A-Za-z0-9]{20,}/,
  /^xox[abprs]-[A-Za-z0-9-]{10,}/,
  /^AKIA[0-9A-Z]{16}$/,
];

export const looksLikeCredential = (value: string): boolean =>
  CREDENTIAL_VALUES.some((pattern) => pattern.test(value.trim()));

/**
 * Checks a schema definition: closed objects, bounded strings and arrays, no forbidden field
 * names, bounded depth. Returns the first problem as a path, or undefined.
 */
export function schemaProblem(schema: unknown, path = '$', depth = 0): string | undefined {
  if (depth > MAX_SCHEMA_DEPTH) return `${path}:depth`;
  if (typeof schema !== 'object' || schema === null) return `${path}:schema`;
  const s = schema as Record<string, unknown>;
  switch (s.type) {
    case 'string': {
      const { maxLength, minLength = 0, enum: values } = s;
      if (
        typeof maxLength !== 'number' ||
        !Number.isSafeInteger(maxLength) ||
        maxLength < 1 ||
        maxLength > MAX_STRING_LENGTH
      ) {
        return `${path}:maxLength`;
      }
      if (typeof minLength !== 'number' || !Number.isSafeInteger(minLength) || minLength < 0) {
        return `${path}:minLength`;
      }
      if (
        values !== undefined &&
        (!Array.isArray(values) || values.length === 0 || values.some((v) => typeof v !== 'string'))
      ) {
        return `${path}:enum`;
      }
      if (s.ref !== undefined && !(TOOL_RECORD_REFS as readonly unknown[]).includes(s.ref)) {
        return `${path}:ref`;
      }
      return undefined;
    }
    case 'number':
    case 'integer': {
      for (const bound of ['minimum', 'maximum'] as const) {
        const value = s[bound];
        if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
          return `${path}:${bound}`;
        }
      }
      return undefined;
    }
    case 'boolean':
      return undefined;
    case 'array': {
      const { maxItems } = s;
      if (
        typeof maxItems !== 'number' ||
        !Number.isSafeInteger(maxItems) ||
        maxItems < 0 ||
        maxItems > MAX_ITEMS
      ) {
        return `${path}:maxItems`;
      }
      return schemaProblem(s.items, `${path}[]`, depth + 1);
    }
    case 'object': {
      const { properties, required = [] } = s;
      if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
        return `${path}:properties`;
      }
      const names = Object.keys(properties);
      if (names.length > MAX_PROPERTIES) return `${path}:properties`;
      for (const name of names) {
        if (!PROPERTY.test(name)) return `${path}.${name}:name`;
        if (isForbiddenField(name)) return `${path}.${name}:forbidden`;
        const problem = schemaProblem(
          (properties as Record<string, unknown>)[name],
          `${path}.${name}`,
          depth + 1,
        );
        if (problem !== undefined) return problem;
      }
      if (
        !Array.isArray(required) ||
        required.some((r) => typeof r !== 'string' || !names.includes(r))
      ) {
        return `${path}:required`;
      }
      return undefined;
    }
    default:
      return `${path}:type`;
  }
}

/** Why a value does not match its schema. `forbidden_field` and `credential_value` are security refusals. */
export type InputProblemCode =
  | 'type'
  | 'missing'
  | 'unknown_field'
  | 'forbidden_field'
  | 'credential_value'
  | 'too_long'
  | 'too_short'
  | 'not_allowed'
  | 'out_of_range'
  | 'too_many';

export type ValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly path: string; readonly code: InputProblemCode };

const fail = (path: string, code: InputProblemCode): ValidationResult =>
  Object.freeze({ valid: false, path, code });
const OK: ValidationResult = Object.freeze({ valid: true });

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/**
 * Validates a value against a schema. Objects are closed: a property the schema does not list is
 * refused, and a forbidden field name is refused before anything else, so no input can smuggle
 * an organization, an approval or a credential into a tool.
 */
export function validate(schema: ToolSchema, value: unknown, path = '$'): ValidationResult {
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return fail(path, 'type');
      if (looksLikeCredential(value)) return fail(path, 'credential_value');
      const length = [...value].length;
      if (length > schema.maxLength) return fail(path, 'too_long');
      if (length < (schema.minLength ?? 0)) return fail(path, 'too_short');
      if (schema.enum !== undefined && !schema.enum.includes(value))
        return fail(path, 'not_allowed');
      return OK;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail(path, 'type');
      if (schema.type === 'integer' && !Number.isSafeInteger(value)) return fail(path, 'type');
      if (schema.minimum !== undefined && value < schema.minimum) return fail(path, 'out_of_range');
      if (schema.maximum !== undefined && value > schema.maximum) return fail(path, 'out_of_range');
      return OK;
    }
    case 'boolean':
      return typeof value === 'boolean' ? OK : fail(path, 'type');
    case 'array': {
      if (!Array.isArray(value)) return fail(path, 'type');
      if (value.length > schema.maxItems) return fail(path, 'too_many');
      for (const [i, item] of value.entries()) {
        const result = validate(schema.items, item, `${path}[${i}]`);
        if (!result.valid) return result;
      }
      return OK;
    }
    case 'object': {
      if (!isPlainObject(value)) return fail(path, 'type');
      for (const name of Object.keys(value)) {
        if (isForbiddenField(name)) return fail(`${path}.${name}`, 'forbidden_field');
      }
      for (const name of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, name))
          return fail(`${path}.${name}`, 'unknown_field');
      }
      for (const name of schema.required ?? []) {
        if (value[name] === undefined) return fail(`${path}.${name}`, 'missing');
      }
      for (const [name, item] of Object.entries(value)) {
        const property = schema.properties[name];
        if (item === undefined || property === undefined) continue;
        const result = validate(property, item, `${path}.${name}`);
        if (!result.valid) return result;
      }
      return OK;
    }
  }
}
