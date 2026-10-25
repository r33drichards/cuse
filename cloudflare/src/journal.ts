import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, createRegistry, defineDocFamily, type ConversationId } from "@earendil-works/pi-durable";
import type { Storage } from "@earendil-works/pi-durable";
import type { MessageEvent, Route } from "./protocol.ts";
const Address = defineDocFamily<{conversationId?: ConversationId},null>({family:true,kind:"cuse.address",version:1,scope:"session",initial:()=>({})});
/** Stage one is a PASSIVE Pi Durable journal. No credentials, model defaults,
 * provider calls, tools or IRC writes. Production histories remain authoritative. */
export class ShadowJournal {
  readonly harness: Harness;
  private constructor(harness: Harness) { this.harness=harness; }
  static async open(storage: Storage, onFailure: () => void = () => {}): Promise<ShadowJournal> {
    const harness = await Harness.open(storage,{
      models:createModels(),registry:createRegistry(),settings:{documentRetentionMs:0},
      onReport: () => onFailure(),
    },BACKGROUND_CONTEXT);
    return new ShadowJournal(harness);
  }
  async record(route: Route, event: MessageEvent): Promise<number> {
    const key=JSON.stringify([route.agent,route.channel,route.generation]);
    const id=await this.harness.commit(async tx=>{
      const doc=await tx.doc(Address,key,null);
      if (doc.conversationId !== undefined) return doc.conversationId;
      const conversation=await tx.createConversation({ownership:{kind:"ownerless"}});
      doc.conversationId=conversation.id;
      return conversation.id;
    },BACKGROUND_CONTEXT);
    const conversation=await this.harness.conversation(id,BACKGROUND_CONTEXT);
    if (!conversation) throw Error("conversation_missing");
    await conversation.submit({type:"write",requestId:event.eventId,entry:{kind:"cuse.shadow-message",data:{
      eventId:event.eventId, timestamp:event.timestamp, agent:route.agent, channel:route.channel,
      nick:event.data.nick,text:event.data.text,
    }}},BACKGROUND_CONTEXT);
    return id;
  }
  async close(): Promise<void> { await this.harness.close(BACKGROUND_CONTEXT); }
}
