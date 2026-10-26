import {ExecutionYield} from './execution-slice.ts';
import { InboxStore, type Job } from "./store.ts";
/** Adapter must explicitly distinguish a failure BEFORE all model/tool side effects.
 * Ordinary throws (including tool timeout) are blocked for reconciliation. */
export class BeforeEffectsError extends Error {}
export interface Executor {
  completed?(job:Job):void;
  failed?(job:Job):void;
  run(job: Job, checkpoint: (value: string) => void, signal: AbortSignal): Promise<readonly string[]>;
}
export class Runner {
  readonly store: InboxStore;
  readonly executor: Executor;
  private active?: {id:string; abort:AbortController};
  constructor(store: InboxStore, executor: Executor) { this.store=store; this.executor=executor; }
  async step(now=Date.now(), timeoutMs=30000): Promise<void> {
    if (this.active) return;
    const job = this.store.claim(now);
    if (!job) return;
    const abort = new AbortController();
    this.active={id:job.id,abort};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_,reject) => { timer=setTimeout(() => { abort.abort(); reject(Error("execution_timeout")); },timeoutMs); });
      const outputs = await Promise.race([this.executor.run(job,value=>this.store.checkpoint(job.id,value),abort.signal),timeout]);
      this.store.complete(job.id,outputs,()=>this.executor.completed?.(job));
    } catch (error) { if(error instanceof ExecutionYield){this.store.defer(job.id,now);return;}this.store.fail(job.id,error instanceof BeforeEffectsError,now); if(this.store.job(job.id)?.state==="blocked")this.executor.failed?.(job); }
    finally { clearTimeout(timer); this.active=undefined; }
  }
  cancel(id: string): void {
    this.store.cancel(id); // persist first, even if the executor ignores cancellation
    if (this.active?.id === id) this.active.abort.abort();
  }
}
