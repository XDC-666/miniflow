import { z } from "zod";

/** 支持的节点类型 */
export const NodeTypeSchema = z.enum([
  "http",
  "llm",
  "agent",
  "condition",
  "code",
  "template",
  "delay",
]);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const WorkflowNodeSchema = z.object({
  id: z.string().min(1),
  type: NodeTypeSchema,
  name: z.string().optional(),
  params: z.record(z.any()).default({}),
});

export const WorkflowEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  /** 可选的 JS 表达式，求值为真时该连线才会被走通 */
  condition: z.string().optional(),
});

export const TriggerSchema = z.object({
  type: z.enum(["manual", "webhook", "schedule"]).default("manual"),
  /** webhook 触发时的路径片段 */
  path: z.string().optional(),
  /** 定时触发的 cron 表达式 */
  cron: z.string().optional(),
});

export const WorkflowSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  trigger: TriggerSchema.default({ type: "manual" }),
  nodes: z.array(WorkflowNodeSchema).min(1),
  edges: z.array(WorkflowEdgeSchema).default([]),
});

export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;
export type TriggerConfig = z.infer<typeof TriggerSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;

/** 单个节点的执行结果 */
export interface NodeResult {
  nodeId: string;
  type: NodeType;
  name: string;
  status: "success" | "failed" | "skipped";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  input: unknown;
  output: unknown;
  error?: string;
}

/** 一次工作流运行的完整记录 */
export interface RunRecord {
  id: string;
  workflowId: string;
  workflowName: string;
  status: "running" | "success" | "failed";
  trigger: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  results: NodeResult[];
  error?: string;
}
