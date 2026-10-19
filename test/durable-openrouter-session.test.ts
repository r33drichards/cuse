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
