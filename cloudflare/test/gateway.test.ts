import test from 'node:test';
import assert from 'node:assert/strict';
import {gateway} from '../src/gateway.ts';
import {route} from './helpers.ts';
import type {Snapshot} from '../src/migration.ts';

test('Worker uses native desktop handshake once across tool calls and does not replay uncertain dispatch',async()=>{
 const s={route,desktopId:'desk',policy:{timeoutMs:3000}} as Snapshot;s.tools=[{name:'run_js',description:'script',inputSchema:{type:'object'},target:'desktop'}];
 const methods:string[]=[];let fail=false;
 const f:typeof fetch=async(_input,init)=>{
  const body=JSON.parse(String(init?.body));methods.push(body.method);
  if(body.method==='notifications/initialized')return new Response(null,{status:202});
  if(fail && body.method==='tools/call')throw Error('transport lost after dispatch');
  return Response.json({jsonrpc:'2.0',id:body.id,result:body.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{}}:{content:[{type:'text',text:'ok'}]}},{headers:{'Mcp-Session-Id':'synthetic-session'}});
 };
 const g=gateway(s,{mcp:{url:'https://example.invalid',bearer:'synthetic'} as any,fullControl:true,exclusiveProfile:true,desktop:{id:'desk',baseUrl:'https://example.invalid',bearer:'synthetic'}},undefined,f);
 await g.call('desktop','run_js',{code:'1'},new AbortController().signal);
 await g.call('desktop','run_js',{code:'2'},new AbortController().signal);
 assert.deepEqual(methods,['initialize','notifications/initialized','tools/call','tools/call']);
 fail=true;await assert.rejects(g.call('desktop','run_js',{code:'3'},new AbortController().signal),/desktop_tool_uncertain/);
 assert.equal(methods.filter(m=>m==='tools/call').length,3);
});
