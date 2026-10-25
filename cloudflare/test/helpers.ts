import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import type { MessageEvent, Route } from "../src/protocol.ts";
import type { Sql, Row } from "../src/store.ts";
export const secret="whsec_"+Buffer.alloc(32,7).toString("base64");
export const route: Route={agent:"#alpha",channel:"#room",buffer:"irc.docker.#room",nick:"cuse-alpha",profile:"alpha-native",subscriptionId:"sub-test",generation:"review-1",after:"2026-10-24T00:00:00Z"};
export function event(n=1): MessageEvent { return {eventId:"evt_"+n.toString(16).padStart(64,"0"),name:"message.created",timestamp:"2026-10-25T00:00:00Z",cursor:`opaque:${n}`,data:{channel_id:route.buffer,message_id:`epoch:${n}`,nick:"human",text:`hello ${n}`}}; }
export function signed(value: unknown=event(), now=Date.now(), key=secret, id=event().eventId): Request {
 const body=JSON.stringify(value),stamp=Math.floor(now/1000).toString();
 const signature=createHmac("sha256",Buffer.from(key.slice(6),"base64")).update(`${id}.${stamp}.${body}`).digest("base64");
 return new Request("https://example.invalid/events/test",{method:"POST",body,headers:{"webhook-id":id,"webhook-timestamp":stamp,"webhook-signature":`v1,${signature}`,"x-mcp-subscription-id":route.subscriptionId}});
}
export function database(path=":memory:"): {db:DatabaseSync;sql:Sql} {
 const db=new DatabaseSync(path);
 const sql:Sql={all:(query,...args)=>db.prepare(query).all(...args) as Row[],transaction:fn=>{
  db.exec("BEGIN IMMEDIATE");
  try {const result=fn();db.exec("COMMIT");return result;} catch(error){db.exec("ROLLBACK");throw error;}
 }};
 return {db,sql};
}
