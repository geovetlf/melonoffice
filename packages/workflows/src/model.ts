import { isDepartmentTypeId } from '@melonoffice/departments';
import type {
  DepartmentTypeId,
  IsoTimestamp,
  OrganizationId,
  RoleId,
  UserId,
  Workflow,
  WorkflowId,
  WorkflowStatus,
  WorkflowStep,
  WorkflowVersion,
} from '@melonoffice/domain';
import { checkProposal } from '@melonoffice/planning';
import { digestOf, isDigest, sameDigest } from '@melonoffice/tools';
import { randomUUID } from 'node:crypto';
import { WorkflowError } from './errors.js';
import { canChangeWorkflowStatus, isWorkflowStatus } from './lifecycle.js';

export const MAX_NAME_LENGTH = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export const isWorkflowId = (value: unknown): value is WorkflowId =>
  typeof value === 'string' && UUID.test(value);

const invalid = (detail: string): never => {
  throw new WorkflowError('invalid_workflow', detail);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function checkName(value: unknown): string {
  if (typeof value !== 'string') return invalid('name');
  const name = value.normalize('NFC').trim();
  if (name.length === 0 || [...name].length > MAX_NAME_LENGTH || CONTROL.test(name)) {
    return invalid('name');
  }
  return name;
}

/**
 * Checks a workflow's steps with the plan proposal schema itself (no second schema): a workflow
 * step is a plan step template whose specialist step names a department type and a role, never
 * a specialist, so the same workflow means the same thing in every organization.
 */
export function checkWorkflowSteps(name: string, value: unknown): readonly WorkflowStep[] {
  if (!Array.isArray(value)) return invalid('steps');
  const assignees = value.map((step, i) => {
    if (!isRecord(step)) return invalid(`steps.${i}`);
    const { assignee } = step;
    if (step.kind === 'specialist') {
      if (
        !isRecord(assignee) ||
        Object.keys(assignee).some((k) => k !== 'departmentTypeId' && k !== 'roleId')
      ) {
        return invalid(`steps.${i}.assignee`);
      }
      if (!isDepartmentTypeId(assignee.departmentTypeId))
        invalid(`steps.${i}.assignee.departmentTypeId`);
      if (typeof assignee.roleId !== 'string' || !ROLE_ID.test(assignee.roleId)) {
        invalid(`steps.${i}.assignee.roleId`);
      }
      if (step.specialistId !== undefined || step.departmentId !== undefined) {
        invalid(`steps.${i}.specialistId`);
      }
      return {
        departmentTypeId: assignee.departmentTypeId as DepartmentTypeId,
        roleId: assignee.roleId as RoleId,
      };
    }
    if (assignee !== undefined) invalid(`steps.${i}.assignee`);
    return undefined;
  });
  const templates = value.map((step: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(step).filter(([key]) => key !== 'assignee')),
  );
  const checked = checkProposal({ summary: name, objective: name, steps: templates });
  if (!checked.ok) {
    return checked.reason === 'invalid_proposal'
      ? invalid(checked.detail)
      : invalid(checked.reason);
  }
  return checked.proposal.steps.map((step, i): WorkflowStep => {
    const assignee = assignees[i];
    return {
      ...step,
      ...(assignee === undefined ? {} : { assignee }),
    } as WorkflowStep;
  });
}

const contentOf = (v: Omit<WorkflowVersion, 'digest' | 'createdAt' | 'createdBy'>) => ({
  workflowId: v.workflowId,
  organizationId: v.organizationId,
  version: v.version,
  name: v.name,
  steps: v.steps,
});

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
};

function versionOf(
  workflowId: WorkflowId,
  organizationId: OrganizationId,
  version: number,
  name: string,
  steps: readonly WorkflowStep[],
  by: UserId,
  at: IsoTimestamp,
): WorkflowVersion {
  const content = { workflowId, organizationId, version, name, steps };
  return deepFreeze(
    structuredClone({
      ...content,
      digest: digestOf(contentOf(content)),
      createdAt: at,
      createdBy: by,
    }),
  );
}

export interface WorkflowWrite {
  readonly workflow: Workflow;
  readonly version?: WorkflowVersion;
}

export interface NewWorkflow {
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly steps: unknown;
}

/** A new workflow in `draft`, at version 1. Pure apart from its random id. */
export function newWorkflow(
  request: NewWorkflow,
  by: UserId,
  at: IsoTimestamp,
): Required<WorkflowWrite> {
  const id = randomUUID() as WorkflowId;
  const name = checkName(request.name);
  const steps = checkWorkflowSteps(name, request.steps);
  return {
    workflow: Object.freeze({
      id,
      organizationId: request.organizationId,
      status: 'draft',
      version: 1,
      name,
      revision: 1,
      createdAt: at,
      createdBy: by,
      updatedAt: at,
    }),
    version: versionOf(id, request.organizationId, 1, name, steps, by, at),
  };
}

const later = (workflow: Workflow, at: IsoTimestamp): IsoTimestamp =>
  Date.parse(at) >= Date.parse(workflow.updatedAt) ? at : workflow.updatedAt;

/**
 * A new version with new steps. The previous versions stay as they were: an execution that used
 * one keeps meaning the same thing. An archived workflow gets no new version.
 */
export function newWorkflowVersion(
  workflow: Workflow,
  change: { readonly name?: string; readonly steps: unknown },
  by: UserId,
  at: IsoTimestamp,
): Required<WorkflowWrite> {
  if (workflow.status === 'archived') throw new WorkflowError('invalid_workflow_transition');
  const name = change.name === undefined ? workflow.name : checkName(change.name);
  const steps = checkWorkflowSteps(name, change.steps);
  const version = workflow.version + 1;
  const when = later(workflow, at);
  return {
    workflow: Object.freeze({
      ...workflow,
      version,
      name,
      revision: workflow.revision + 1,
      updatedAt: when,
    }),
    version: versionOf(workflow.id, workflow.organizationId, version, name, steps, by, when),
  };
}

export function applyWorkflowStatus(
  workflow: Workflow,
  from: WorkflowStatus,
  to: WorkflowStatus,
  at: IsoTimestamp,
): Workflow {
  if (workflow.status !== from) throw new WorkflowError('workflow_concurrency_conflict');
  if (!canChangeWorkflowStatus(from, to)) throw new WorkflowError('invalid_workflow_transition');
  return Object.freeze({
    ...workflow,
    status: to,
    revision: workflow.revision + 1,
    updatedAt: later(workflow, at),
  });
}

export function checkStoredWorkflow(workflow: Workflow): Workflow {
  if (!isWorkflowId(workflow.id)) invalid('id');
  if (!isWorkflowStatus(workflow.status)) invalid('status');
  if (!Number.isSafeInteger(workflow.version) || workflow.version < 1) invalid('version');
  if (!Number.isSafeInteger(workflow.revision) || workflow.revision < 1) invalid('revision');
  return workflow;
}

/** A stored version whose content no longer matches its digest is refused, never used. */
export function checkStoredWorkflowVersion(version: WorkflowVersion): WorkflowVersion {
  if (!isWorkflowId(version.workflowId)) invalid('workflowId');
  if (!isDigest(version.digest) || !sameDigest(digestOf(contentOf(version)), version.digest)) {
    invalid('digest');
  }
  return version;
}
