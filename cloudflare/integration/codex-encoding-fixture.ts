import {compressCodexRequest} from '../src/codex-encoding.worker.ts';import {codexRequestFetch} from '../src/codex-encoding.ts';
import {configuredModels} from '../src/models.ts';
export default {async fetch(){
 const token='eyJhbGciOiJub25lIn0.'+btoa(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'synthetic-account'}}))+'.synthetic';
 const credential={type:'oauth' as const,access:token,refresh:'synthetic',expires:Date.now()+3600000};
 const models=configuredModels({}, {},{read:async p=>p==='openai-codex'?credential:undefined,list:async()=>[{providerId:'openai-codex',type:'oauth' as const}],modify:async()=>{throw Error('no_refresh');},delete:async()=>{}});
 let captured:ArrayBuffer|undefined,calls=0;const tools=Array.from({length:128},(_,i)=>({name:'tool_'+i,description:('Schema detail '+i+'; λ 🙂 ').repeat(120),parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}}));
 const encoded=codexRequestFetch(compressCodexRequest,async(_url,init)=>{calls++;if(new Headers(init?.headers).get('content-encoding')!=='zstd')throw Error('encoding_missing');captured=init?.body as ArrayBuffer;return Response.json({error:{message:'synthetic_stop_no_network'}},{status:400});});
 await models.completeSimple(models.getModel('openai-codex','gpt-6.1-sol')!,{messages:[{role:'user',content:'Synthetic protocol check.',timestamp:1}],tools},{transport:'sse',maxRetries:0,maxTokens:16,fetch:encoded});
 if(!captured)throw Error('body_missing');return new Response(captured,{headers:{'content-type':'application/zstd','x-provider-network-requests':'0','x-captured-requests':String(calls)}});
}};
