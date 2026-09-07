import type { NodeResult, Workflow } from "./types.js";

/**
 * 一次工作流运行的执行上下文。
 * 负责保存每个节点的输出，并为模板插值提供作用域。
 */
export class ExecutionContext {
  readonly runId: string;
  readonly workflow: Workflow;
  readonly trigger: string;
  readonly payload: unknown;

  private readonly outputs = new Map<string, unknown>();
  private readonly results: NodeResult[] = [];

  constructor(opts: {
    runId: string;
    workflow: Workflow;
    trigger: string;
    payload?: unknown;
  }) {
    this.runId = opts.runId;
    this.workflow = opts.workflow;
    this.trigger = opts.trigger;
    this.payload = opts.payload ?? null;
  }

  setOutput(nodeId: string, output: unknown): void {
    this.outputs.set(nodeId, output);
  }

  getOutput(nodeId: string): unknown {
    return this.outputs.get(nodeId);
  }

  addResult(result: NodeResult): void {
    this.results.push(result);
  }

  getResults(): NodeResult[] {
    return this.results;
  }

  /** 最后一个成功节点的输出，便于快速取结果 */
  lastOutput(): unknown {
    for (let i = this.results.length - 1; i >= 0; i--) {
      const r = this.results[i];
      if (r.status === "success") return r.output;
    }
    return null;
  }

  /**
   * 构建插值作用域。
   * 注意：这里刻意不把完整 process.env 暴露出去，只暴露 MINIFLOW_EXPOSED_ENV
   * 白名单里列出的变量，避免 API Key 之类的密钥被写进提示词或执行日志。
   */
  scope(currentInput: unknown): Record<string, unknown> {
    const nodeBag: Record<string, Record<string, unknown>> = {};
    for (const [id, output] of this.outputs) {
      // 同时支持两种写法：
      //   $node.fetch.data.title      —— 节点输出是对象时的快捷访问
      //   $node.fetch.json            —— 完整的节点输出（与 n8n 习惯一致）
      const entry: Record<string, unknown> = {};
      if (output && typeof output === "object" && !Array.isArray(output)) {
        Object.assign(entry, output);
      }
      entry.json = output;
      nodeBag[id] = entry;
    }

    const allowed = (process.env.MINIFLOW_EXPOSED_ENV ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const envBag: Record<string, string | undefined> = {};
    for (const key of allowed) envBag[key] = process.env[key];

    return {
      $json: currentInput,
      $node: nodeBag,
      $env: envBag,
      $payload: this.payload,
      $runId: this.runId,
      $now: new Date().toISOString(),
    };
  }
}
