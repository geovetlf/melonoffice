import type { Firestore, Timestamp as FirestoreTimestamp } from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import type {
  AgentOutputRecord,
  ExecutionId,
  ExecutionNodeId,
  IsoTimestamp,
  OrganizationId,
} from '@melonoffice/domain';
import type { AgentOutputRepository } from '@melonoffice/execution';

/**
 * `agentOutputs/{executionId}_{nodeId}` (ADR-0043): an agent node's answer, kept for the nodes
 * after it. The organization is a field every read checks. Written only by the runtime in the
 * worker, never by clients. A retried node's answer replaces the last one.
 */
export const AGENT_OUTPUTS = 'agentOutputs';

interface AgentOutputDocument {
  readonly organizationId: string;
  readonly executionId: string;
  readonly nodeId: string;
  readonly requestId: string;
  /** JSON, so any structured answer is stored exactly as the model gave it. */
  readonly output: string;
  readonly createdAt: FirestoreTimestamp;
}

export class FirestoreAgentOutputRepository implements AgentOutputRepository {
  constructor(private readonly db: Firestore) {}

  async save(record: AgentOutputRecord): Promise<void> {
    const document: AgentOutputDocument = {
      organizationId: record.organizationId,
      executionId: record.executionId,
      nodeId: record.nodeId,
      requestId: record.requestId,
      output: JSON.stringify(record.output),
      createdAt: Timestamp.fromDate(new Date(record.createdAt)),
    };
    await this.db
      .collection(AGENT_OUTPUTS)
      .doc(`${record.executionId}_${record.nodeId}`)
      .set(document);
  }

  async find(
    organizationId: OrganizationId,
    executionId: ExecutionId,
    nodeId: string,
  ): Promise<AgentOutputRecord | undefined> {
    const snapshot = await this.db.collection(AGENT_OUTPUTS).doc(`${executionId}_${nodeId}`).get();
    const data = snapshot.data() as AgentOutputDocument | undefined;
    if (data?.organizationId !== organizationId || data.executionId !== executionId) {
      return undefined;
    }
    let output: unknown;
    try {
      output = JSON.parse(data.output) as unknown;
    } catch {
      return undefined;
    }
    if (typeof output !== 'object' || output === null || Array.isArray(output)) return undefined;
    const { text, structured } = output as { text?: unknown; structured?: unknown };
    return Object.freeze({
      organizationId,
      executionId,
      nodeId: data.nodeId as ExecutionNodeId,
      requestId: data.requestId,
      output: {
        ...(typeof text === 'string' ? { text } : {}),
        ...(structured === undefined ? {} : { structured }),
      },
      createdAt: data.createdAt.toDate().toISOString() as IsoTimestamp,
    });
  }
}
