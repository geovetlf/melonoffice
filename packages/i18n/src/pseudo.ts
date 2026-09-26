const ACCENTED: Readonly<Record<string, string>> = {
  a: 'á',
  e: 'é',
  i: 'í',
  o: 'ó',
  u: 'ú',
  A: 'Á',
  E: 'É',
  I: 'Í',
  O: 'Ó',
  U: 'Ú',
  n: 'ñ',
  c: 'ç',
};

/**
 * Pseudo-localises an ICU message for testing: accents letters and pads the
 * text by about 40% so hard-coded strings and truncation stand out. Text
 * inside ICU braces (placeholders, plural/select syntax) is left unchanged.
 */
export function pseudoLocalize(message: string): string {
  let depth = 0;
  let out = '';
  let letters = 0;
  for (const char of message) {
    if (char === '{') depth += 1;
    if (depth === 0) {
      out += ACCENTED[char] ?? char;
      if (/\p{L}/u.test(char)) letters += 1;
    } else {
      out += char;
    }
    if (char === '}') depth = Math.max(0, depth - 1);
  }
  return `[${out}${'~'.repeat(Math.ceil(letters * 0.4))}]`;
}

export function pseudoLocalizeCatalog<T extends Readonly<Record<string, string>>>(
  catalog: T,
): Record<keyof T, string> {
  const result = {} as Record<keyof T, string>;
  for (const key of Object.keys(catalog) as (keyof T)[]) {
    result[key] = pseudoLocalize(catalog[key] as string);
  }
  return result;
}
