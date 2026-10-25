// Compatibility port from cuse 934717c^; preserves task/evidence and finite-allowance semantics.
export type GoalPhase = "paused" | "active" | "blocked" | "review" | "completed" | "cancelled";
export interface GoalEvidence { kind: "native-test" | "artifact" | "inspection" | "peer-review"; ref: string; result: "pass" | "fail" | "blocked" }
export interface GoalTask { id: string; title: string; parent?: string; state: "pending" | "working" | "done"; evidence: GoalEvidence[] }
export interface Goal {
 version: 1; id: string; channel: string; sender: string; objective: string; ordered: boolean;
 phase: GoalPhase; reason: string; generation: number; sequence: number; stepsRemaining: number;
 modelsRemaining: number; toolsRemaining: number; expiresAt: number; createdAt: number;
 tasks: GoalTask[]; reportedRun?: string; recoveryRequired?: boolean;
}
export type GoalCommand =
 | { action: "add"; objective: string; ordered: boolean }
 | { action: "list" | "status"; id?: string }
 | { action: "start"; id: string; steps: number; durationMs?: number }
 | { action: "pause" | "cancel" | "approve"; id: string }
 | { action: "recover"; id: string; acknowledge: "inspected" };
export type GoalUpdate =
 | { action: "plan"; tasks: { id: string; title: string; parent?: string }[] }
 | { action: "task"; id: string; state: GoalTask["state"]; evidence?: GoalEvidence[] }
 | { action: "block"; reason: string }
 | { action: "submit" };
export const MAX_GOAL_STEPS = 200;
export const MIN_GOAL_RUN_DURATION_MS = 60_000;
export const DEFAULT_GOAL_RUN_DURATION_MS = 30 * MIN_GOAL_RUN_DURATION_MS;
export const MAX_GOAL_RUN_DURATION_MS = 3 * 24 * 60 * MIN_GOAL_RUN_DURATION_MS;
export function isGoalRunDuration(value:unknown):value is number {
 return typeof value==="number"&&Number.isSafeInteger(value)&&value>=MIN_GOAL_RUN_DURATION_MS&&value<=MAX_GOAL_RUN_DURATION_MS&&value%MIN_GOAL_RUN_DURATION_MS===0;
}
export const GOAL_USAGE = `Usage: ,goal add [ordered] :: objective | list | status [ID] | start ID [1-${MAX_GOAL_STEPS} steps, default 4] [duration 1m-3d, m/h/d, default 30m] | pause/cancel/approve ID | recover ID inspected. Add is inert; start explicitly authorizes bounded continuation.`;
export function parseGoalCommand(argument: string): GoalCommand | undefined {
 const value = argument.trim();
 if (!value || value === "list") return {action:"list"};
 const add = /^add(?:\s+(ordered))?\s*::\s*([\s\S]+)$/.exec(value);
 if (add && add[2]!.trim().length <= 8000) return {action:"add",objective:add[2]!.trim(),ordered:!!add[1]};
 const status = /^status(?:\s+([a-zA-Z0-9_-]{1,80}))?$/.exec(value);
 if (status) return {action:"status",...(status[1] ? {id:status[1]} : {})};
 const start = /^start\s+([a-zA-Z0-9_-]{1,80})(?:\s+(\d+))?(?:\s+(\d+)([mhd]))?$/.exec(value);
 if (start) {
  const steps=Number(start[2]??4);
  const units={m:MIN_GOAL_RUN_DURATION_MS,h:60*MIN_GOAL_RUN_DURATION_MS,d:24*60*MIN_GOAL_RUN_DURATION_MS};
  const durationMs=start[3]===undefined?undefined:Number(start[3])*units[start[4] as keyof typeof units];
  if(Number.isInteger(steps)&&steps>=1&&steps<=MAX_GOAL_STEPS&&(durationMs===undefined||isGoalRunDuration(durationMs)))return {action:"start",id:start[1]!,steps,...(durationMs===undefined?{}:{durationMs})};
 }
 const recovery=/^recover\s+([a-zA-Z0-9_-]{1,80})\s+inspected$/.exec(value);
 if(recovery)return {action:"recover",id:recovery[1]!,acknowledge:"inspected"};
 const control = /^(pause|cancel|approve)\s+([a-zA-Z0-9_-]{1,80})$/.exec(value);
 return control ? {action:control[1] as "pause"|"cancel"|"approve",id:control[2]!} : undefined;
}
export function validateTasks(tasks: GoalTask[]): void {
 if (!Array.isArray(tasks)||tasks.length<1||tasks.length>50) throw Error("Task count");
 const ids=new Set<string>();
 for (const task of tasks) {
  if(!/^[a-zA-Z0-9_-]{1,80}$/.test(task.id)||ids.has(task.id)||!task.title.trim()||task.title.length>1000)throw Error("Task schema");
  ids.add(task.id);
  if(!["pending","working","done"].includes(task.state)||!Array.isArray(task.evidence)||task.evidence.length>8)throw Error("Task state");
  for(const e of task.evidence){
   if(!["native-test","artifact","inspection","peer-review"].includes(e.kind)||!["pass","fail","blocked"].includes(e.result)||!e.ref.trim()||e.ref.length>512)throw Error("Evidence schema");
   if(/-----BEGIN|(?:token|password|secret|api[_-]?key)=/i.test(e.ref))throw Error("Evidence must reference artifacts, not secrets");
  }
  if(task.state==="done"&&(!task.evidence.length||task.evidence.some(e=>e.result!=="pass")||task.evidence.every(e=>e.kind==="peer-review")))throw Error("Done requires passing non-peer evidence references");
 }
 if(tasks[0]?.id!=="objective"||tasks[0]?.parent)throw Error("Immutable objective root required");
 for(const task of tasks.slice(1)){
  let parent=task.parent;const visited=new Set([task.id]);let depth=0;
  while(parent){if(visited.has(parent)||++depth>8)throw Error("Task cycle/depth");visited.add(parent);const node=tasks.find(t=>t.id===parent);if(!node)throw Error("Missing parent");parent=node.parent;}
  if(!visited.has("objective"))throw Error("Detached task");
 }
 for(const t of tasks)if(t.state==="done"&&tasks.some(c=>c.parent===t.id&&c.state!=="done"))throw Error("Parent has incomplete children");
}
export function taskOrder(tasks: GoalTask[]): GoalTask[] {
 const result:GoalTask[]=[];
 const visit=(id:string)=>{for(const t of tasks.filter(t=>t.parent===id))visit(t.id);result.push(tasks.find(t=>t.id===id)!);};visit("objective");return result;
}
export function formatGoal(g:Goal):string {
 const expiry=new Date(g.expiresAt);
 const deadline=g.expiresAt>0&&Number.isFinite(expiry.getTime())?" · deadline "+expiry.toISOString():"";
 return `${g.id}: ${g.phase} · ${g.tasks.filter(t=>t.state==="done").length}/${g.tasks.length} tasks · ${g.stepsRemaining} steps, ${g.modelsRemaining} model requests, ${g.toolsRemaining} tools left · ${g.reason || g.objective.slice(0,100)}${deadline}${g.recoveryRequired?" · outcome inspection required: ,goal recover "+g.id+" inspected":""}`;
}
