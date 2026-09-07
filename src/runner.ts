import { randomUUID } from "node:crypto";
import { executeWorkflow } from "./engine/executor.js";
import type { RunRecord, Workflow } from "./engine/types.js";
import type { Store } from "./store/db.js";

export interface StartedRun {
  runId: string;
  done: Promise<RunRecord>;
}

/**
 * 启动一次工作流运行。
 * 执行结果会自动写入数据库，因此调用方可以选择 await 等待，也可以直接返回 runId 轮询。
 */
export function startRun(
  store: Store,
  workflow: Workflow,
  trigger = "manual",
  payload: unknown = null,
): StartedRun {
  const runId = randomUUID();

  const done = executeWorkflow({ workflow, trigger, payload, runId })
    .then((record) => {
      store.saveRun(record);
      return record;
    })
    .catch((err: unknown) => {
      const record: RunRecord = {
        id: runId,
        workflowId: workflow.id ?? "",
        workflowName: workflow.name,
        status: "failed",
        trigger,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 0,
        results: [],
        error: (err as Error).message ?? String(err),
      };
      store.saveRun(record);
      return record;
    });

  // 后台执行，避免未 await 时产生未处理的 rejection
  done.catch(() => undefined);

  return { runId, done };
}
