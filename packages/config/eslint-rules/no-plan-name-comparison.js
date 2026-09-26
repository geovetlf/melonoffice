/**
 * Architecture decision D-25: application logic must ask for entitlements,
 * limits, features and permissions, never for a plan by name.
 *
 * This rule reports:
 *  - comparisons (===, ==, !==, !=) against a plan identifier literal, such
 *    as `plan === 'empresa'`;
 *  - comparisons of a plan-like variable or property (`plan`, `planId`,
 *    `planName`, `planKey`, `planTier`, or `plan.id` / `plan.name`) against any
 *    string literal;
 *  - `switch` statements on a plan-like value, or with a plan identifier as a
 *    `case`.
 */

/** Plan identifiers in English (config ids) and Spanish (product names). */
export const PLAN_IDENTIFIERS = Object.freeze([
  'entrepreneur',
  'business',
  'corporate',
  'emprendedor',
  'empresa',
  'corporativo',
]);

const PLAN_LIKE_NAME =
  /^(?:current|active|org|organization|subscription)?plan(?:id|name|key|tier|slug)?$/i;
const PLAN_ATTRIBUTE = /^(?:id|name|key|tier|slug)$/i;
const COMPARISON_OPERATORS = new Set(['===', '==', '!==', '!=']);

function staticString(node) {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

function isPlanIdentifierLiteral(node) {
  const value = staticString(node);
  return value !== undefined && PLAN_IDENTIFIERS.includes(value.trim().toLowerCase());
}

function isPlanLikeReference(node) {
  if (!node) return false;
  if (node.type === 'Identifier') return PLAN_LIKE_NAME.test(node.name);
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    if (PLAN_LIKE_NAME.test(node.property.name)) return true;
    // `plan.id`, `org.plan.name`, ...
    return PLAN_ATTRIBUTE.test(node.property.name) && isPlanLikeReference(node.object);
  }
  if (node.type === 'ChainExpression') return isPlanLikeReference(node.expression);
  if (node.type === 'TSNonNullExpression' || node.type === 'TSAsExpression') {
    return isPlanLikeReference(node.expression);
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export const noPlanNameComparison = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow branching on plan names; query entitlements, limits, features or permissions instead (D-25).',
    },
    schema: [],
    messages: {
      planLiteral:
        "Do not compare against the plan name '{{value}}'. Ask the entitlement system for the capability or limit instead (D-25).",
      planReference:
        'Do not compare a plan identifier with a string. Ask the entitlement system for the capability or limit instead (D-25).',
      planSwitch:
        'Do not switch on a plan identifier. Ask the entitlement system for the capability or limit instead (D-25).',
    },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (!COMPARISON_OPERATORS.has(node.operator)) return;
        for (const side of [node.left, node.right]) {
          if (isPlanIdentifierLiteral(side)) {
            context.report({ node, messageId: 'planLiteral', data: { value: staticString(side) } });
            return;
          }
        }
        const [a, b] = [node.left, node.right];
        if (
          (isPlanLikeReference(a) && staticString(b) !== undefined) ||
          (isPlanLikeReference(b) && staticString(a) !== undefined)
        ) {
          context.report({ node, messageId: 'planReference' });
        }
      },
      SwitchStatement(node) {
        if (isPlanLikeReference(node.discriminant)) {
          context.report({ node, messageId: 'planSwitch' });
          return;
        }
        for (const switchCase of node.cases) {
          if (isPlanIdentifierLiteral(switchCase.test)) {
            context.report({
              node: switchCase,
              messageId: 'planLiteral',
              data: { value: staticString(switchCase.test) },
            });
          }
        }
      },
    };
  },
};
