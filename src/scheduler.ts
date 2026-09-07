import { Cron } from "croner";
import { startRun } from "./runner.js";
import type { Store } from "./store/db.js";

/**
 * 定时调度器。
 * 每次工作流发生变更时调用 resync()，重新按最新的工作流列表建立 cron 任务。
 */
export class Scheduler {
  private readonly jobs = new Map<string, Cron>();

  constructor(private readonly store: Store) {}

  resync(): number {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();

    const scheduled = this.store
      .listWorkflows()
      .filter((wf) => wf.enabled && wf.trigger.type === "schedule" && wf.trigger.cron);

    for (const wf of scheduled) {
      const id = wf.id as string;
      try {
        const job = new Cron(
          wf.trigger.cron as string,
          { name: id },
          async () => {
            const fresh = this.store.getWorkflow(id);
            if (!fresh || !fresh.enabled) return;
            const { done } = startRun(this.store, fresh, "schedule", null);
            const record = await done;
            console.log(
              `[scheduler] ${fresh.name} -> ${record.status} (${record.durationMs}ms)`,
            );
          },
        );
        this.jobs.set(id, job);
      } catch (err) {
        console.error(
          `[scheduler] 工作流 "${wf.name}" 的 cron 表达式无效：${(err as Error).message}`,
        );
      }
    }

    return this.jobs.size;
  }

  stop(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  get size(): number {
    return this.jobs.size;
  }
}
