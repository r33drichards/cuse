import test from 'node:test';import assert from 'node:assert/strict';
import {routeBindings,modelSettings} from '../src/agent-bindings.ts';import {route,secret} from './helpers.ts';
const existing={route,secret,activationPending:false};
const added={binding:{route:{...route,agent:'#second',channel:'#second',buffer:'irc.docker.#second',profile:'second-native',subscriptionId:'second-sub',generation:'second-generation'},secret:'separate-key',activationPending:true},modelConfig:{providers:{second:{models:[]}}},modelSecrets:{SECOND_KEY:'synthetic-second'}};
test('adding an agent preserves the existing live route and isolates model configuration',()=>{
 const raw=JSON.stringify({existing}),env={WEBHOOK_ROUTES:raw,MODEL_CONFIG:'{}',MODEL_SECRETS:'{"FIRST_KEY":"synthetic-first"}',CUSE_AGENT_SECOND:JSON.stringify(added)};
 const routes=routeBindings(env);assert.deepEqual(routes.existing,existing);assert.equal(routes.second.activationPending,true);assert.equal(env.WEBHOOK_ROUTES,raw);
 assert.deepEqual(modelSettings(env,route).secrets,{FIRST_KEY:'synthetic-first'});assert.deepEqual(modelSettings(env,added.binding.route),{config:added.modelConfig,secrets:added.modelSecrets});
 assert.equal(routes.second.route.subscriptionId,'second-sub');
});
test('additional agents cannot overwrite routes or reuse an agent, native profile, or signing key',()=>{
 for(const collision of [{route},{route:{...added.binding.route,agent:route.agent}},{route:{...added.binding.route,profile:route.profile}},{secret}]){
  const candidate={...added,binding:{...added.binding,...collision}};
  assert.throws(()=>routeBindings({WEBHOOK_ROUTES:JSON.stringify({existing}),CUSE_AGENT_SECOND:JSON.stringify(candidate)}),/agent_binding_conflict/);
 }
 assert.throws(()=>routeBindings({WEBHOOK_ROUTES:JSON.stringify({second:existing}),CUSE_AGENT_SECOND:JSON.stringify(added)}),/agent_binding_conflict/);
});
