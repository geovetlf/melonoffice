import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import { noPlanNameComparison, PLAN_IDENTIFIERS } from './no-plan-name-comparison.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
});

ruleTester.run('no-plan-name-comparison', noPlanNameComparison, {
  valid: [
    // Entitlement and limit queries are the intended pattern.
    { code: "if (entitlements.has('gia.voice')) { enableVoice(); }" },
    { code: "const max = limits.get('agents.max');" },
    // Ordinary string comparisons unrelated to plans.
    { code: "if (status === 'active') {}" },
    { code: "if (role.id === 'meta-ads') {}" },
    { code: "if (department.name === 'Marketing') {}" },
    // Comparing a plan id to another variable (e.g. to detect a change) is allowed.
    { code: 'const changed = previous.planId !== next.planId;' },
    // Plan identifiers as plain data (not compared) are allowed, e.g. in config.
    { code: "const ids = ['entrepreneur'];" },
    { code: "switch (status) { case 'active': break; }" },
  ],
  invalid: [
    { code: "if (plan === 'empresa') {}", errors: [{ messageId: 'planLiteral' }] },
    { code: "if (plan == 'Corporativo') {}", errors: [{ messageId: 'planLiteral' }] },
    { code: "if ('entrepreneur' !== org.planId) {}", errors: [{ messageId: 'planLiteral' }] },
    { code: "if (tier === 'business') {}", errors: [{ messageId: 'planLiteral' }] },
    { code: 'if (x === `corporate`) {}', errors: [{ messageId: 'planLiteral' }] },
    { code: "if (org.plan === 'pro') {}", errors: [{ messageId: 'planReference' }] },
    {
      code: "if (subscription?.planId === 'starter') {}",
      errors: [{ messageId: 'planReference' }],
    },
    { code: "if (org.plan.id === 'x') {}", errors: [{ messageId: 'planReference' }] },
    { code: 'switch (plan.name) { default: }', errors: [{ messageId: 'planSwitch' }] },
    {
      code: "switch (org.planId) { case 'x': break; }",
      errors: [{ messageId: 'planSwitch' }],
    },
    {
      code: "switch (value) { case 'emprendedor': break; }",
      errors: [{ messageId: 'planLiteral' }],
    },
  ],
});

describe('PLAN_IDENTIFIERS', () => {
  it('covers the three plans in English and Spanish', () => {
    if (PLAN_IDENTIFIERS.length !== 6) throw new Error('Expected six plan identifiers');
  });
});
