/** Local private rehearsal only; does not upload or activate a Worker.
 * node scripts/import.mjs SNAPSHOT.json [TARGET.sqlite FENCE.json]
 * Without target+fence it is a read-only dry run. */
import {readFileSync,openSync,closeSync,chmodSync,realpathSync,constants} from 'node:fs';
import {resolve,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dryRun,importSnapshot} from '../src/migration.ts';
import {ShadowJournal} from '../src/journal.ts';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
try{
 const snapshot=JSON.parse(readFileSync(process.argv[2],'utf8'));const plan=await dryRun(snapshot);
 if(process.argv[3]){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');if(resolve(process.argv[3]).startsWith(root+sep))throw Error();
  const target=resolve(realpathSync(dirname(resolve(process.argv[3]))),process.argv[3].split('/').at(-1));if(target.startsWith(root+sep))throw Error();
  const fence=JSON.parse(readFileSync(process.argv[4],'utf8'));
  const fd=openSync(target,constants.O_APPEND|constants.O_CREAT|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);closeSync(fd);if(realpathSync(target)!==target)throw Error();chmodSync(target,0o600);
  const journal=await ShadowJournal.open(await openNodeSqliteStorage(target));
  try{await importSnapshot(journal.harness,snapshot,fence);}finally{await journal.close();}
 }
 // Do not print identities/history/config values in command output.
 console.log(JSON.stringify({hash:plan.hash,archiveEntries:plan.archiveEntries,contextMessages:plan.contextMessages,blockers:plan.blockers,applied:!!process.argv[3]}));
}catch{console.error('migration_validation_failed');process.exitCode=1;}
