import test from 'node:test';import assert from 'node:assert/strict';
import {readOnlyBrowserProbe} from '../src/read-recovery.ts';
import {DesktopLedger} from '../src/desktop-coordinator.ts';import {database} from './helpers.ts';
const code="console.log((await mcp.callTool('browser','browser_execute',{tab:'cuse2-railway',operations:[{type:'evaluate',params:{script:'({url:location.href,text:document.body.innerText.slice(0,16000)})'}}]})).content[0].text);";
test('reviewed read recovery recognizes only a bounded DOM inspection grammar',()=>{
 assert.equal(readOnlyBrowserProbe(code),true);
 for(const unsafe of [code.replace('location.href','location.href=evil'),code.replace('16000','16e9'),code.replace('document.body.innerText','fetch("/delete")'),code+'deleteEverything()',code.replace("tab:'cuse2-railway'","tab:evil()"),code.replace("type:'evaluate'","type:'click'"),undefined])assert.equal(readOnlyBrowserProbe(unsafe),false);
});
test('read recovery requires exact held operation and replay cannot release a newer lock',()=>{
 const {db,sql}=database();try{const ledger=new DesktopLedger(sql);const ticket=ledger.acquire('read-1');ledger.settle(ticket,false);
 assert.throws(()=>ledger.reconcileRead('wrong'),/mismatch/);assert.throws(()=>ledger.acquire('new'),/reconciliation/);
 ledger.reconcileRead('read-1');const next=ledger.acquire('new');ledger.reconcileRead('read-1');assert.doesNotThrow(()=>ledger.verify(next));
 }finally{db.close();}
});
