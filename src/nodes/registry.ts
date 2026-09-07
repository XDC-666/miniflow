import type { NodeType, WorkflowNode } from "../engine/types.js";
import type { ExecutionContext } from "../engine/context.js";

export interface NodeRunArgs {
  node: WorkflowNode;
  /** 已完成模板插值的参数 */
  params: Record<string, any>;
  /** 上游节点传入的数据 */
  input: unknown;
  ctx: ExecutionContext;
}

export interface NodeDefinition {
  type: NodeType;
  label: string;
  description: string;
  /** 节点参数示例，用于文档和 UI 提示 */
  example: Record<string, unknown>;
  run(args: NodeRunArgs): Promise<unknown>;
}

const registry = new Map<NodeType, NodeDefinition>();

export function registerNode(def: NodeDefinition): void {
  registry.set(def.type, def);
}

export function getNode(type: NodeType): NodeDefinition {
  const def = registry.get(type);
  if (!def) {
    throw new Error(
      `未注册的节点类型 "${type}"，可用类型：${[...registry.keys()].join(", ")}`,
    );
  }
  return def;
}

export function listNodes(): NodeDefinition[] {
  return [...registry.values()];
}
