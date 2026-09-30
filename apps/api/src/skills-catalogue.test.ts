import { ACTION_CATALOGUE } from '@melonoffice/decisions';
import {
  AGENT_TEMPLATES,
  createSkillCatalogue,
  grantsOf,
  SKILL_CATALOGUE,
} from '@melonoffice/specialists';
import {
  createToolRegistry,
  defaultToolRegistry,
  isRuntimeInvocable,
  TOOL_CATALOGUE,
} from '@melonoffice/tools';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

/**
 * The skill catalogue against the tool catalogue and the Decision Engine (SK-1, ADR-0069). The
 * packages cannot import each other, so the check lives here, where all three are wired.
 */
describe('skills grant only what exists, and only to agents (SK-1)', () => {
  const tools = defaultToolRegistry();

  it("every tool a skill grants exists at that version and is the runtime's to call", () => {
    for (const skill of SKILL_CATALOGUE) {
      for (const grant of skill.tools) {
        expect(grant.versions.length).toBeGreaterThan(0);
        for (const version of grant.versions) {
          const found = tools.resolve(grant.id, version);
          expect(found, `${skill.id} grants ${grant.id}@${version}`).toBeDefined();
          // A person's own versions (message_send@1, follow_up_schedule@1) are never an agent's.
          expect(isRuntimeInvocable(found?.version as never), `${grant.id}@${version}`).toBe(true);
        }
      }
    }
  });

  it('every action a skill grants is in the Decision Engine and allows agents', () => {
    const actions = new Map(ACTION_CATALOGUE.map((a) => [a.id, a]));
    for (const skill of SKILL_CATALOGUE) {
      for (const action of skill.actions) {
        expect(actions.get(action)?.proposers, `${skill.id} grants ${action}`).toContain('agent');
      }
    }
  });

  it("every template's skills resolve; only the commercial agent's grant a tool: its follow-up, approved each time (ADR-0084)", () => {
    const catalogue = createSkillCatalogue();
    const tools = defaultToolRegistry();
    for (const template of AGENT_TEMPLATES) {
      for (const ref of template.skills) {
        expect(catalogue.resolve(ref.id, ref.version), `${template.id}: ${ref.id}`).toBeDefined();
      }
      const granted = [...grantsOf(template.skills, catalogue).tools];
      expect(granted, template.id).toEqual(
        template.id === 'commercial' ? ['follow_up_schedule@2'] : [],
      );
      for (const key of granted) {
        const [id, version] = key.split('@');
        expect(tools.resolve(id as string, Number(version))?.version.approvalPolicy).toBe(
          'approval_required',
        );
      }
      // Every agent may propose facts for the company memory, for the owner to confirm.
      expect([...grantsOf(template.skills, catalogue).actions]).toContain('knowledge.propose_fact');
    }
  });

  it('what each skill grants, exactly (ADR-0083, ADR-0084)', () => {
    expect(
      SKILL_CATALOGUE.filter((s) => s.tools.length > 0).map((s) => [
        `${s.id}@${s.version}`,
        s.tools.map((t) => `${t.id}@${t.versions.join('|')}`),
      ]),
    ).toEqual([
      ['conversation_reply@1', ['message_send@2|3', 'conversation_handoff@1']],
      ['customer_follow_up@2', ['follow_up_schedule@2']],
      ['customer_follow_up@3', ['follow_up_schedule@3']],
    ]);
    expect(
      SKILL_CATALOGUE.filter((s) => s.actions.length > 0).map((s) => [
        `${s.id}@${s.version}`,
        [...s.actions],
      ]),
    ).toEqual([
      ['company_knowledge@2', ['knowledge.propose_fact']],
      ['customer_follow_up@2', ['follow_up.schedule']],
      ['customer_follow_up@3', ['follow_up.schedule']],
    ]);
    // Version 1 of every skill grants no action, as before.
    expect(SKILL_CATALOGUE.filter((s) => s.version === 1).flatMap((s) => s.actions)).toEqual([]);
  });

  it('a published skill version never changes: a change needs a new version', () => {
    const digest = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
    const published = Object.fromEntries(
      SKILL_CATALOGUE.map((s) => [
        `${s.id}@${s.version}`,
        digest({ tools: s.tools, actions: s.actions, reads: s.reads }),
      ]),
    );
    // Pinned on purpose: when this fails, give the changed skill a new version instead.
    expect(published).toMatchInlineSnapshot(`
      {
        "campaign_analysis@1": "d71dcf655bed",
        "company_knowledge@1": "39a1e0299b99",
        "company_knowledge@2": "a70483029a3a",
        "content_drafting@1": "39a1e0299b99",
        "conversation_reply@1": "338e7530cc39",
        "customer_follow_up@1": "ffa7c617dfde",
        "customer_follow_up@2": "bc1f3e84c7c7",
        "customer_follow_up@3": "c559f1e6a76d",
        "design_briefing@1": "39a1e0299b99",
        "finance_review@1": "b6fdaaa61bbc",
        "market_research@1": "973fa6cccfce",
        "operations_tracking@1": "0ef075e7f3f2",
        "pipeline_analysis@1": "0f3ee33c30a3",
      }
    `);
  });
});

/**
 * SK-2 (ADR-0083): nothing reaches an agent by default. A new tool, a new skill or a new version
 * of a skill changes no existing agent and no template until someone assigns it explicitly.
 */
describe('agents gain no capability by default (SK-2)', () => {
  const catalogue = createSkillCatalogue();

  it('a new tool in the registry is granted by no skill, so no agent gets it', () => {
    const base = TOOL_CATALOGUE[0];
    const newTool = {
      ...base,
      id: 'invoice_send',
      versions: base?.versions.map((v) => ({ ...v, toolId: 'invoice_send' })),
    };
    const registry = createToolRegistry([...TOOL_CATALOGUE, newTool as never]);
    expect(registry.resolve('invoice_send', 2)).toBeDefined();
    for (const template of AGENT_TEMPLATES) {
      const granted = grantsOf(template.skills, catalogue).tools;
      expect([...granted].some((key) => key.startsWith('invoice_send@'))).toBe(false);
    }
  });

  it("a new skill or a skill's new version changes no template and no agent pinned to version 1", () => {
    const reply = catalogue.resolve('conversation_reply', 1);
    const wider = createSkillCatalogue([
      ...SKILL_CATALOGUE,
      {
        ...reply,
        version: 2,
        tools: [...(reply?.tools ?? []), { id: 'invoice_send', versions: [1] }],
      },
      { ...reply, id: 'sales_offers', actions: ['opportunity.offer_discount'] },
    ] as never);
    const pinned = [{ id: 'conversation_reply', version: 1 }];
    expect([...grantsOf(pinned, wider).tools].sort()).toEqual(
      [...grantsOf(pinned, catalogue).tools].sort(),
    );
    expect(grantsOf(pinned, wider).actions.size).toBe(0);
    // Templates name their skills and versions; a new skill joins none of them.
    expect(AGENT_TEMPLATES.find((t) => t.id === 'commercial')?.skills).toEqual([
      { id: 'company_knowledge', version: 2 },
      { id: 'customer_follow_up', version: 2 },
      { id: 'pipeline_analysis', version: 1 },
    ]);
    for (const template of AGENT_TEMPLATES) {
      expect(template.skills.some((s) => s.id === 'sales_offers')).toBe(false);
    }
  });

  it('no skill grants a tool version that only a person may use', () => {
    const humanOnly = TOOL_CATALOGUE.flatMap((t) =>
      t.versions.filter((v) => !isRuntimeInvocable(v)).map((v) => `${t.id}@${v.version}`),
    );
    expect(humanOnly.sort()).toEqual(['follow_up_schedule@1', 'message_send@1']);
    for (const skill of SKILL_CATALOGUE) {
      for (const grant of skill.tools) {
        for (const version of grant.versions) {
          expect(humanOnly).not.toContain(`${grant.id}@${version}`);
        }
      }
    }
  });
});
