/** A checkpointed yield, never a request to replay an external action. */
export class ExecutionYield extends Error {}
/** Gate only native engine hooks before model dispatch or tool intent. */
export class ExecutionSlice {
 readonly ready:Promise<void>;private resolve!:()=>void;private used=0;private started=Date.now();
 readonly capacity:number;readonly durationMs:number;
 constructor(capacity=30,durationMs=150000){this.capacity=capacity;this.durationMs=durationMs;this.ready=new Promise(resolve=>{this.resolve=resolve;});}
 async admit(cost:number,signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();
  if(this.used+cost<=this.capacity && (this.used===0 || Date.now()-this.started<this.durationMs)){this.used+=cost;return;}
  this.resolve();
  // Harness.close seals the session before signalling this invocation. Its
  // checkpoint still precedes dispatch, so reopening can safely continue it.
  await new Promise<never>((_resolve,reject)=>{
   if(!signal){reject(Error('slice_signal_required'));return;}
   if(signal.aborted){reject(signal.reason);return;}
   signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });
 }
}
