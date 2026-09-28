import type {
  Message,
  MessageTemplateRef,
  OutboundMediaRef,
  OutboundMediaType,
  TemplateValues,
} from '@melonoffice/domain';
import { ConversationError } from './errors.js';

/**
 * What an outbound message may carry, whatever the channel (CV-6D phase 2, ADR-0046): text,
 * media from a link, or one of the organization's templates. These checks are the shape only;
 * whether a connection can send it, and whether a template's values fit that template, are the
 * Integration Engine's.
 */

export const OUTBOUND_MEDIA_TYPES = [
  'image',
  'document',
  'audio',
  'video',
] as const satisfies readonly OutboundMediaType[];
/** The longest caption of a media message (WhatsApp's limit, the strictest we speak). */
export const MAX_CAPTION_LENGTH = 1024;
export const MAX_MEDIA_URL_LENGTH = 2048;
export const MAX_FILENAME_LENGTH = 240;
/** One template value: plain text, bounded. */
export const MAX_TEMPLATE_VALUE_LENGTH = 1024;
export const MAX_TEMPLATE_VALUES = 50;
const TEMPLATE_ID = /^[0-9a-f]{64}$/;
/** A provider's template name: lower case, digits and underscores (Meta's own rule). */
export const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
/** A template language: `es`, `en_US`, `pt_BR`, `zh_Hant_HK`… (Meta's locale codes). */
export const TEMPLATE_LANGUAGE = /^[a-z]{2,3}(_[A-Z][a-z]{3})?(_[A-Z]{2})?$/;

const invalid = (detail: string): never => {
  throw new ConversationError('invalid_request', detail);
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LINE_BREAKS = /[\n\r\t]/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const only = (value: Record<string, unknown>, keys: readonly string[], field: string) => {
  if (Object.keys(value).some((k) => !keys.includes(k))) invalid(`${field}.fields`);
};

/**
 * A media link: `https`, a host name (not an address, not local), no user or password, bounded.
 * It is the organization's own; the provider fetches it. It is never logged or audited.
 */
export function checkMediaUrl(value: unknown, field = 'media.url'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MEDIA_URL_LENGTH) {
    invalid(field);
  }
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    return invalid(field);
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    host.length === 0 ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    /^[0-9.]+$/.test(host) ||
    host.includes(':') ||
    !host.includes('.')
  ) {
    invalid(field);
  }
  return url.toString();
}

export function checkMediaRef(value: unknown, field = 'media'): OutboundMediaRef {
  if (!isObject(value)) invalid(field);
  const m = value as Record<string, unknown>;
  only(m, ['type', 'url', 'filename'], field);
  if (!(OUTBOUND_MEDIA_TYPES as readonly unknown[]).includes(m.type)) invalid(`${field}.type`);
  const url = checkMediaUrl(m.url, `${field}.url`);
  let filename: string | undefined;
  if (m.filename !== undefined) {
    if (
      m.type !== 'document' ||
      typeof m.filename !== 'string' ||
      m.filename.trim().length === 0 ||
      m.filename.length > MAX_FILENAME_LENGTH ||
      CONTROL.test(m.filename) ||
      LINE_BREAKS.test(m.filename) ||
      /[/\\]/.test(m.filename)
    ) {
      invalid(`${field}.filename`);
    }
    filename = m.filename as string;
  }
  return Object.freeze({
    type: m.type as OutboundMediaType,
    url,
    ...(filename === undefined ? {} : { filename }),
  });
}

/** One value: plain text on one line, as providers require for template parameters. */
function checkValue(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_TEMPLATE_VALUE_LENGTH ||
    CONTROL.test(value) ||
    LINE_BREAKS.test(value) ||
    / {5,}/.test(value)
  ) {
    invalid(field);
  }
  return value as string;
}

function checkValues(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_TEMPLATE_VALUES) invalid(field);
  return Object.freeze((value as unknown[]).map((v, i) => checkValue(v, `${field}.${i + 1}`)));
}

/** A template's values, as a person gives them: the shape only. */
export function checkTemplateValues(value: unknown, field = 'template.values'): TemplateValues {
  if (value === undefined) return Object.freeze({ body: Object.freeze([]) });
  if (!isObject(value)) invalid(field);
  const v = value as Record<string, unknown>;
  only(v, ['header', 'headerMedia', 'body', 'buttons'], field);
  const body = v.body === undefined ? Object.freeze([]) : checkValues(v.body, `${field}.body`);
  const header = v.header === undefined ? undefined : checkValues(v.header, `${field}.header`);
  const headerMedia =
    v.headerMedia === undefined ? undefined : checkMediaRef(v.headerMedia, `${field}.headerMedia`);
  if (headerMedia !== undefined && headerMedia.type === 'audio') {
    invalid(`${field}.headerMedia.type`);
  }
  let buttons: { readonly index: number; readonly text: string }[] | undefined;
  if (v.buttons !== undefined) {
    if (!Array.isArray(v.buttons) || v.buttons.length > 10) invalid(`${field}.buttons`);
    buttons = (v.buttons as unknown[]).map((b, i) => {
      if (!isObject(b)) return invalid(`${field}.buttons.${i}`);
      only(b, ['index', 'text'], `${field}.buttons.${i}`);
      if (typeof b.index !== 'number' || !Number.isInteger(b.index) || b.index < 0 || b.index > 9) {
        invalid(`${field}.buttons.${i}.index`);
      }
      return Object.freeze({
        index: b.index as number,
        text: checkValue(b.text, `${field}.buttons.${i}.text`),
      });
    });
    if (new Set(buttons.map((b) => b.index)).size !== buttons.length) {
      invalid(`${field}.buttons`);
    }
  }
  return Object.freeze({
    ...(header === undefined ? {} : { header }),
    ...(headerMedia === undefined ? {} : { headerMedia }),
    body,
    ...(buttons === undefined ? {} : { buttons: Object.freeze(buttons) }),
  });
}

export const isTemplateId = (value: unknown): value is MessageTemplateRef['templateId'] =>
  typeof value === 'string' && TEMPLATE_ID.test(value);

/** A template message's reference, checked: the template's id, name and language, and values. */
export function checkTemplateRef(value: MessageTemplateRef): MessageTemplateRef {
  if (!isTemplateId(value.templateId)) invalid('template.templateId');
  if (!TEMPLATE_NAME.test(value.name)) invalid('template.name');
  if (!TEMPLATE_LANGUAGE.test(value.language)) invalid('template.language');
  return Object.freeze({
    templateId: value.templateId,
    name: value.name,
    language: value.language,
    values: checkTemplateValues(value.values),
  });
}

/** The content of an outbound message, as it is compared: the same key names one content. */
export function contentKeyOf(m: Pick<Message, 'type' | 'text' | 'media' | 'template'>): string {
  return JSON.stringify({
    type: m.type,
    text: m.text ?? null,
    media: m.media ?? null,
    template:
      m.template === undefined ? null : { id: m.template.templateId, values: m.template.values },
  });
}
