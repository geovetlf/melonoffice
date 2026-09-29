import { describe, expect, it } from 'vitest';
import { createModelPolicyCatalogue, DEFAULT_MODEL_POLICY } from './policy.js';

describe('the model policy catalogue', () => {
  it('lists every policy, the default first, as the platform administrator reads them', () => {
    const gia = { ...DEFAULT_MODEL_POLICY, id: 'gia', version: 2 };
    const catalogue = createModelPolicyCatalogue([gia]);
    expect(catalogue.list().map((p) => `${p.id}@${p.version}`)).toEqual([
      `${DEFAULT_MODEL_POLICY.id}@${DEFAULT_MODEL_POLICY.version}`,
      'gia@2',
    ]);
    expect(catalogue.resolve({ id: 'gia', version: 2 })).toEqual(gia);
    expect(Object.isFrozen(catalogue.list()[1])).toBe(true);
  });
});
