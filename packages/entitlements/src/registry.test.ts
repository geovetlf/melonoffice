import { describe, expect, it } from 'vitest';
import {
  assertValidBlock,
  defaultValues,
  ENTITLEMENT_KEYS,
  isValidValue,
  kindOf,
} from './registry.js';

describe('entitlement registry', () => {
  it('denies everything by default', () => {
    const values = defaultValues();
    for (const key of ENTITLEMENT_KEYS) {
      const value: unknown = values[key];
      switch (kindOf(key)) {
        case 'feature':
          expect(value, key).toBe(false);
          break;
        case 'limit':
          expect(value, key).toBe(0);
          break;
        case 'limitMap':
          expect(value, key).toEqual({ default: 0, byScope: {} });
          break;
        case 'list':
          expect(value, key).toEqual([]);
          break;
      }
    }
  });

  it('declares the future corporate capabilities as features that default to off', () => {
    for (const key of ['security.sso', 'security.auditExport', 'admin.teams'] as const) {
      expect(kindOf(key)).toBe('feature');
      expect(defaultValues()[key]).toBe(false);
    }
  });

  it('checks each value against its kind', () => {
    expect(isValidValue('gia.voice', true)).toBe(true);
    expect(isValidValue('gia.voice', 1)).toBe(false);
    expect(isValidValue('users.max', 3)).toBe(true);
    expect(isValidValue('users.max', 'unlimited')).toBe(true);
    expect(isValidValue('users.max', -1)).toBe(false);
    expect(isValidValue('users.max', 1.5)).toBe(false);
    expect(isValidValue('users.max', null)).toBe(false);
    expect(isValidValue('roles.allowed', ['a'])).toBe(true);
    expect(isValidValue('roles.allowed', [1])).toBe(false);
    expect(isValidValue('agents.perDepartmentMax', { default: 1, byScope: { x: 2 } })).toBe(true);
    expect(isValidValue('agents.perDepartmentMax', { default: 1, byScope: { x: -2 } })).toBe(false);
    expect(isValidValue('agents.perDepartmentMax', 3)).toBe(false);
  });

  it('rejects unknown keys and wrong shapes', () => {
    expect(() => assertValidBlock({ 'users.maximum': 1 }, 'test')).toThrow(
      /unknown entitlement key/,
    );
    expect(() => assertValidBlock({ 'users.max': 'lots' }, 'test')).toThrow(/invalid value/);
    expect(() => assertValidBlock({ 'users.max': 1, 'gia.voice': false }, 'test')).not.toThrow();
  });
});
