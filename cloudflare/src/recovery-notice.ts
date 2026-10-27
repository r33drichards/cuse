import {objectKey,type Route} from './protocol.ts';
import type {Sql} from './store.ts';

/** Project audited loss into the existing no-replay outbox, never into a model prompt. */
export function queueRecoveryNotices(sql:Sql,route:Route):number {
  const prefix=objectKey(route)+':recovery-gap:';
  return sql.transaction(()=>{
    const missing=sql.all(`SELECT a.incarnation,a.generation FROM cuse_grant_gap_audit a
      LEFT JOIN cuse_effects e ON e.id=? || a.incarnation || ':' || a.generation
      WHERE e.id IS NULL ORDER BY a.recorded_at,a.incarnation,a.generation LIMIT 16`,prefix);
    for(const row of missing){
      const id=prefix+String(row.incarnation)+':'+Number(row.generation);
      sql.all("INSERT INTO cuse_effects(id,event,payload,state) VALUES (?,?,?,'pending')",id,id,JSON.stringify({
        agent:route.agent,channel:route.channel,profile:route.profile,
        text:'Automatic recovery resumed after a history gap. Some older messages may not have been processed. Already-queued work is preserved; uncertain actions are not repeated.',
      }));
    }
    return missing.length;
  });
}
