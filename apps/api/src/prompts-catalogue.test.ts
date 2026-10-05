import {
  AGENT_TASK_PROMPT,
  AI_REVIEW_PROMPT,
  agentTaskMessages,
  aiReviewMessages,
} from '@melonoffice/agents';
import { promptLabel, type AIMessage, type PromptRef } from '@melonoffice/ai-gateway';
import { EXTRACTOR_INSTRUCTIONS, EXTRACTOR_PROMPT } from '@melonoffice/brain';
import {
  AGENT_TURN_PROMPT,
  ASSIST_PROMPT,
  agentTurnMessages,
  assistMessages,
} from '@melonoffice/conversations';
import { ROUTING_INSTRUCTIONS, ROUTING_PROMPT } from '@melonoffice/decisions';
import { DOCUMENT_TRANSCRIPTION_PROMPT, TRANSCRIPTION_PROMPT } from '@melonoffice/documents';
import { GIA_PROMPT, GIA_SUMMARY_PROMPT, giaMessages, summaryMessages } from '@melonoffice/gia';
import { PLANNER_PROMPT, plannerMessages } from '@melonoffice/planning';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

/**
 * Prompt versions (G-3, ADR-0133): every prompt MelonOffice sends a model, as it reads for a fixed
 * example, has a digest pinned to its version. Changing a prompt's text fails this test until its
 * version goes up and its new digest is added below. The list is append-only: never edit a line,
 * so results and costs recorded under a version always mean the same text.
 */
const PINNED: Readonly<Record<string, string>> = {
  'agent_task@1': '4c802f6b603dd883',
  'agent_task@2': '7cbf9919f11e258c',
  'agent_task@3': 'd246e61075037ad7',
  'agent_review@1': '60005fe16ca9ad33',
  'conversation_agent_turn@1': '8024d43d6e56d016',
  'conversation_assist@1': '825fc0fd51ed67b8',
  'gia_chat@1': 'e4ea7909751cc79a',
  'gia_summary@1': 'e126b5d20b20b7d2',
  'plan_proposal@1': '650c44eda6d62802',
  'plan_proposal@2': '9370266c27166687',
  'plan_proposal@3': 'a86c344bb73205d5',
  'plan_proposal@4': '93b66fbbd13bbf97',
  'plan_proposal@5': '486587d7d70b3897',
  'plan_proposal@6': '31a92145d88e8190',
  'plan_proposal@7': '2000793138f6e23d',
  'knowledge_extract@1': 'ab0b59dc318b3411',
  'decision_routing@1': '9a5af5413a6a79ba',
  'document_transcription@1': 'a08544ea7764db64',
};

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const textOf = (messages: readonly AIMessage[]) =>
  messages
    .flatMap((m) => m.content.map((c) => `${m.role}:${c.type === 'text' ? c.text : c.type}`))
    .join('\n');

const context = {
  channel: 'whatsapp',
  status: 'open',
  department: null,
  contact: { name: 'Ana', phoneKnown: true, emailKnown: false },
  messages: [{ from: 'customer', text: 'Hola', at: '2026-10-03T12:00:00Z' }],
} as never;

const PROMPTS: readonly (readonly [PromptRef, string])[] = [
  [
    AGENT_TASK_PROMPT,
    textOf(
      agentTaskMessages(
        {
          name: 'Lucía',
          configuration: { mainRoleId: 'commercial_agent', purpose: 'Sells.' } as never,
        },
        [{ id: 'company_knowledge', description: 'Reads the company memory.' }],
        [],
        'Resume las oportunidades abiertas',
      ),
    ),
  ],
  [AI_REVIEW_PROMPT, textOf(aiReviewMessages('Escribe un post', 'Aquí está el post.'))],
  [AGENT_TURN_PROMPT, textOf(agentTurnMessages({ instructions: 'Sé amable.' }, 'Lucía', context))],
  [ASSIST_PROMPT, textOf(assistMessages('reply', context, 'es'))],
  [
    GIA_PROMPT,
    textOf(
      giaMessages({
        locale: 'es',
        facts: [],
        missing: [],
        activity: [],
        departments: ['sales'],
        history: [],
        message: '¿Cómo vamos?',
      }),
    ),
  ],
  [
    GIA_SUMMARY_PROMPT,
    textOf(
      summaryMessages('es', [
        { label: 'Estudio', departmentId: 'research', status: 'completed', answer: 'Listo.' },
      ]),
    ),
  ],
  [
    PLANNER_PROMPT,
    // From @2 (ADR-0171) the digest covers the whole call: instructions, context shape, request.
    textOf(
      plannerMessages(
        {
          agents: [
            {
              specialistId: 'agent-1',
              departmentType: 'sales',
              roleId: 'commercial_agent',
              skills: ['company_knowledge@3'],
              tools: [
                {
                  id: 'knowledge_search',
                  version: 1,
                  action: 'search',
                  changesData: false,
                  riskLevel: 'low',
                  usableAsStep: true,
                  approvalRequired: false,
                  inputFromAllowed: true,
                },
              ],
            },
          ],
          checkActions: ['discount'],
        },
        'Prepara una campaña',
      ),
    ),
  ],
  [EXTRACTOR_PROMPT, EXTRACTOR_INSTRUCTIONS],
  [ROUTING_PROMPT, ROUTING_INSTRUCTIONS],
  [TRANSCRIPTION_PROMPT, DOCUMENT_TRANSCRIPTION_PROMPT],
];

describe('prompt versions (G-3, ADR-0133)', () => {
  it('pins every prompt’s text to its version', () => {
    const current = Object.fromEntries(
      PROMPTS.map(([ref, text]) => [promptLabel(ref), digest(text)]),
    );
    expect(current).toEqual(
      Object.fromEntries(Object.keys(current).map((label) => [label, PINNED[label]])),
    );
  });

  it('keeps every earlier version of each prompt, and one id per prompt', () => {
    const ids = PROMPTS.map(([ref]) => ref.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [ref] of PROMPTS) {
      for (let v = 1; v <= ref.version; v += 1) {
        expect(PINNED[`${ref.id}@${v}`], `${ref.id}@${v}`).toMatch(/^[0-9a-f]{16}$/);
      }
    }
  });
});
