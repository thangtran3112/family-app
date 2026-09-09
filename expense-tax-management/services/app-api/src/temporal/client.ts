import { Client, Connection } from "@temporalio/client";
import type { JobReferenceV1 } from "@expense-tax/contracts";

export interface StartWorkflowInput {
  readonly workflowType: string;
  readonly workflowId: string;
  readonly taskQueue: string;
  readonly args: readonly [JobReferenceV1];
}

export interface StartWorkflowResult {
  readonly runId: string;
}

/**
 * Narrow, injectable interface over the Temporal TS client. App API only
 * ever *starts* workflows -- the Python worker owns execution (design doc
 * section 4.3) -- so this deliberately does not expose the full
 * @temporalio/client surface. Tests inject a fake implementation instead of
 * needing a real Temporal server, the same DI convention `buildApp` already
 * uses for `database`/`authVerifiers`.
 */
export interface TemporalWorkflowStarter {
  start(input: StartWorkflowInput): Promise<StartWorkflowResult>;
  close(): Promise<void>;
}

export interface TemporalClientConfig {
  readonly address: string;
  readonly namespace: string;
}

export function createTemporalWorkflowStarter(
  config: TemporalClientConfig,
): TemporalWorkflowStarter {
  let connectionPromise: Promise<Connection> | undefined;

  async function connection(): Promise<Connection> {
    connectionPromise ??= Connection.connect({ address: config.address });
    return connectionPromise;
  }

  return {
    async start(input) {
      const client = new Client({
        connection: await connection(),
        namespace: config.namespace,
      });
      const handle = await client.workflow.start(input.workflowType, {
        workflowId: input.workflowId,
        taskQueue: input.taskQueue,
        args: [...input.args],
        workflowIdConflictPolicy: "USE_EXISTING",
      });
      return { runId: handle.firstExecutionRunId };
    },
    async close() {
      if (connectionPromise) {
        await (await connectionPromise).close();
      }
    },
  };
}
