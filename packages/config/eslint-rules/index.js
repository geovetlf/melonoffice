import { noPlanNameComparison } from './no-plan-name-comparison.js';

/** Local ESLint plugin with MelonOffice architecture guardrails. */
const plugin = {
  meta: { name: '@melonoffice/eslint-plugin' },
  rules: {
    'no-plan-name-comparison': noPlanNameComparison,
  },
};

export default plugin;
