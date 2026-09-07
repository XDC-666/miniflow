import { randomUUID } from "node:crypto";
import { ExecutionContext } from "./context.js";
import { getNode } from "../nodes/registry.js";
import { evaluateCondition, interpolateDeep } from "../utils/interpolate.js";
import type { NodeResult, RunRecord, Workflow, WorkflowEdge } from "./types.js";

export interface ExecuteOptions {
  workflow: Workflow;
  trigger?: string;
  payload?: unknown;
  /** 外部指定的运行 ID，不传则自动生成 */
  runId?: string;
  /** 每执行完一个节点回调一次，便于实时推送进度 */
  onProgress?: (result: NodeResult) => void;
}

/** Kahn 拓扑排序，存在环时抛错 */
function topoSort(nodes: Workflow["nodes"], edges: WorkflowEdge[]): string[] {
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    indegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }
  for (const edge of edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    adjacency.get(edge.from)?.push(edge.to);
  }

  const queue = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }

  if (order.length !== nodes.length) {
    throw new Error("工作流中存在循环依赖，无法执行");
  }
  return order;
}

export async function executeWorkflow(
  opts: ExecuteOptions,
): Promise<RunRecord> {
  const { workflow, trigger = "manual", payload = null, onProgress, runId } = opts;

  const effectiveRunId = runId ?? randomUUID();
  const ctx = new ExecutionContext({
    runId: effectiveRunId,
    workflow,
    trigger,
    payload,
  });
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const nodeMap = new Map(workflow.nodes.map((n) => [n.id, n]));
  for (const edge of workflow.edges) {
    if (!nodeMap.has(edge.from)) {
      throw new Error(`连线引用了不存在的节点 "${edge.from}"`);
    }
    if (!nodeMap.has(edge.to)) {
      throw new Error(`连线引用了不存在的节点 "${edge.to}"`);
    }
  }

  const order = topoSort(workflow.nodes, workflow.edges);

  const incoming = new Map<string, WorkflowEdge[]>();
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const node of workflow.nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  }
  for (const edge of workflow.edges) {
    incoming.get(edge.to)?.push(edge);
    outgoing.get(edge.from)?.push(edge);
  }

  // 没有上游的节点作为起点
  const activated = new Set(
    workflow.nodes.filter((n) => (incoming.get(n.id) ?? []).length === 0).map((n) => n.id),
  );

  let status: RunRecord["status"] = "running";
  let errorMessage: string | undefined;

  for (const nodeId of order) {
    const node = nodeMap.get(nodeId) as Workflow["nodes"][number];

    if (!activated.has(nodeId)) {
      const skipped: NodeResult = {
        nodeId,
        type: node.type,
        name: node.name ?? node.id,
        status: "skipped",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 0,
        input: null,
        output: null,
      };
      ctx.addResult(skipped);
      onProgress?.(skipped);
      continue;
    }

    // 汇总上游被激活节点的输出：单个直接透传，多个打包成数组
    const upstream = (incoming.get(nodeId) ?? [])
      .filter((e) => activated.has(e.from))
      .map((e) => ctx.getOutput(e.from));
    const input =
      upstream.length === 1
        ? upstream[0]
        : upstream.length > 1
          ? upstream
          : payload;

    const startedAtNode = new Date().toISOString();
    const nodeStart = Date.now();
    let result: NodeResult;

    try {
      const definition = getNode(node.type);
      const params = interpolateDeep(node.params ?? {}, ctx.scope(input));
      const output = await definition.run({ node, params, input, ctx });
      ctx.setOutput(nodeId, output);

      result = {
        nodeId,
        type: node.type,
        name: node.name ?? node.id,
        status: "success",
        startedAt: startedAtNode,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - nodeStart,
        input,
        output,
      };
      ctx.addResult(result);

      // 放行下游：连线条件为真（或无条件）才激活
      for (const edge of outgoing.get(nodeId) ?? []) {
        if (!edge.condition) {
          activated.add(edge.to);
          continue;
        }
        if (evaluateCondition(edge.condition, ctx.scope(output))) {
          activated.add(edge.to);
        }
      }
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      result = {
        nodeId,
        type: node.type,
        name: node.name ?? node.id,
        status: "failed",
        startedAt: startedAtNode,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - nodeStart,
        input,
        output: null,
        error: message,
      };
      ctx.addResult(result);
      status = "failed";
      errorMessage = `节点 "${node.name ?? nodeId}" 执行失败：${message}`;
    }

    onProgress?.(result);
    if (status === "failed") break;
  }

  if (status !== "failed") status = "success";
  const endedAt = new Date().toISOString();

  return {
    id: effectiveRunId,
    workflowId: workflow.id ?? "",
    workflowName: workflow.name,
    status,
    trigger,
    startedAt,
    endedAt,
    durationMs: Date.now() - t0,
    results: ctx.getResults(),
    error: errorMessage,
  };
}
