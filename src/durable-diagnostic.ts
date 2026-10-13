/** Only fixed classifications, never arbitrary message/stack/cause strings or tool arguments. */
function data(value:unknown,key:string):unknown {
 if(typeof value!=="object"||value===null)return undefined;
 try{return Object.getOwnPropertyDescriptor(value,key)?.value;}catch{return undefined;}
}
export function durableDiagnostic(error:unknown):string {
 const name=data(error,"name");const cause=data(error,"cause");
 if(name==="HarnessFault"&&data(cause,"message")==="Assistant response is aborted while durable control is running")return "provider-abort-control-mismatch";
 if(name==="HarnessFault")return "harness-fault";
 if(name==="AbortError"||name==="TimeoutError")return "request-interrupted";
 return "unclassified";
}
