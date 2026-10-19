import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DurableChannelSession} from "../.runtime/pi/packages/coding-agent/src/cuse/durable-session.ts";
import {ModelRuntime} from "../.runtime/pi/packages/coding-agent/src/core/model-runtime.ts";
import {SettingsManager} from "../.runtime/pi/packages/coding-agent/src/core/settings-manager.ts";
import {DefaultResourceLoader} from "../.runtime/pi/packages/coding-agent/src/core/resource-loader.ts";

test("real durable session persists OpenRouter selection and switches back without inference", async () => {
 const root=mkdtempSync(join(tmpdir(),"cuse-openrouter-session-"));const agent=join(root,"agent");mkdirSync(agent);
 const auth=join(agent,"auth.json");
 writeFileSync(auth,JSON.stringify({openrouter:{type:"api_key",key:"synthetic-openrouter-not-a-real-key"},"openai-codex":{type:"oauth",access:"synthetic-access",refresh:"synthetic-refresh",expires:Date.now()+3600000,accountId:"synthetic-account"}}),{mode:0o600});
 const original=globalThis.fetch;let requests=0;globalThis.fetch=async()=>{requests++;throw Error("network forbidden");};
 let session:DurableChannelSession|undefined;
 try {
  const runtime=await ModelRuntime.create({authPath:auth,modelsPath:null,allowModelNetwork:false});
  const deps:any={cwd:root,agentDir:agent,sessionDir:join(root,"sessions"),modelRuntime:runtime,delegate:{},log:()=>{},communication:{tools:async()=>[],call:async()=>{throw Error("unexpected tool");}},
   createResources:async()=>{const settingsManager=SettingsManager.inMemory({defaultProvider:"openai-codex",defaultModel:"gpt-5.4"});const resourceLoader=new DefaultResourceLoader({cwd:root,agentDir:agent,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});await resourceLoader.reload();return{settingsManager,resourceLoader};}};
  session=await DurableChannelSession.open("#test",deps);
  assert.equal(session.modelLabel(),"openai-codex/gpt-5.4");
  const model=runtime.getModel("openrouter","anthropic/claude-sonnet-4.6")!;assert.ok(model);
  await session.setModel(model);assert.equal(session.modelLabel(),"openrouter/anthropic/claude-sonnet-4.6");
  const file=session.sessionFile,id=session.sessionId;await session.close();session=undefined;
  session=await DurableChannelSession.open("#test",deps,{sessionFile:file});assert.equal(session.sessionId,id);assert.equal(session.modelLabel(),"openrouter/anthropic/claude-sonnet-4.6");
  await session.setModel(runtime.getModel("openai-codex","gpt-5.4")!);assert.equal(session.modelLabel(),"openai-codex/gpt-5.4");assert.equal(requests,0);
 }finally{await session?.close();globalThis.fetch=original;rmSync(root,{recursive:true,force:true});}
});

test("new live-catalog model survives real runtime and durable session restart without network", async () => {
 const { OpenRouterCatalog } = await import("../.runtime/pi/packages/coding-agent/src/cuse/openrouter-catalog.ts");
 const root=mkdtempSync(join(tmpdir(),"cuse-live-openrouter-session-"));const agent=join(root,"agent");mkdirSync(agent);
 const auth=join(agent,"auth.json"),cachePath=join(agent,"openrouter-catalog.json");
 writeFileSync(auth,JSON.stringify({openrouter:{type:"api_key",key:"synthetic-not-a-real-key"},"openai-codex":{type:"oauth",access:"synthetic-access",refresh:"synthetic-refresh",expires:Date.now()+3600000,accountId:"synthetic-account"}}),{mode:0o600});
 const original=globalThis.fetch;let requests=0;globalThis.fetch=async()=>{requests++;throw Error("external network forbidden");};
 let session:DurableChannelSession|undefined;
 try {
  const create=()=>ModelRuntime.create({authPath:auth,modelsPath:null,allowModelNetwork:false});
  let runtime=await create();
  const pinned=structuredClone(runtime.getModel("openrouter","anthropic/claude-sonnet-4.6"));
  let catalogRequests=0, now=Date.now();
  const liveId="synthetic/new-tool-model";
  const catalog=new OpenRouterCatalog(runtime,{cachePath,now:()=>now,fetch:async(input,init)=>{
   catalogRequests++;assert.equal(String(input),"https://openrouter.ai/api/v1/models");assert.equal(init?.headers,undefined);
   return new Response(JSON.stringify({data:[{id:catalogRequests === 1 ? liveId : "synthetic/replacement-model",name:"Synthetic new model",context_length:100000,top_provider:{max_completion_tokens:8192},architecture:{input_modalities:["text","image"],output_modalities:["text"]},supported_parameters:["tools","reasoning"],pricing:{prompt:"0.000001",completion:"0.000002"}}]}));
  }});
  const found=await catalog.search("new tool");assert.equal(found.models[0].id,liveId);
  const discovered=await catalog.resolve(liveId);assert.ok(discovered);assert.equal(catalogRequests,1);
  assert.equal(discovered.contextWindow,100000);assert.equal(discovered.maxTokens,8192);assert.deepEqual(discovered.input,["text","image"]);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.getModel("openrouter","anthropic/claude-sonnet-4.6"))),pinned);
  assert.ok(await runtime.getAuth(discovered));
  const deps=(modelRuntime:ModelRuntime):any=>({cwd:root,agentDir:agent,sessionDir:join(root,"sessions"),modelRuntime,delegate:{},log:()=>{},communication:{tools:async()=>[],call:async()=>{throw Error("unexpected tool");}},
   createResources:async()=>{const settingsManager=SettingsManager.inMemory({defaultProvider:"openai-codex",defaultModel:"gpt-5.4"});const resourceLoader=new DefaultResourceLoader({cwd:root,agentDir:agent,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});await resourceLoader.reload();return{settingsManager,resourceLoader};}});
  session=await DurableChannelSession.open("#test",deps(runtime));await session.setModel(discovered);
  now+=300001;await catalog.search("replacement");assert.equal(await catalog.resolve(liveId),undefined);
  const file=session.sessionFile,id=session.sessionId;await session.close();session=undefined;
  runtime=await create();assert.equal(runtime.getModel("openrouter",liveId),undefined);
  await new OpenRouterCatalog(runtime,{cachePath,now:()=>now}).restore();assert.ok(runtime.getModel("openrouter",liveId));
  session=await DurableChannelSession.open("#test",deps(runtime),{sessionFile:file});
  assert.equal(session.sessionId,id);assert.equal(session.modelLabel(),`openrouter/${liveId}`);assert.equal(requests,0);
 }finally{await session?.close();globalThis.fetch=original;rmSync(root,{recursive:true,force:true});}
});
