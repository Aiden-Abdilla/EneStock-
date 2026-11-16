import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const migration=readFileSync(new URL('../migrations/0001_inventory.sql',import.meta.url),'utf8');
test('two simultaneous separate SQLite connections cannot withdraw the last unit twice', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'stockroom-concurrent-'));const path=join(dir,'db.sqlite');
  try {
    const db=new DatabaseSync(path);db.exec(migration);db.prepare('INSERT INTO items (name,barcode,quantity) VALUES (?,?,?)').run('Last unit','001',1);db.close();
    const gate=new SharedArrayBuffer(8);const flags=new Int32Array(gate);
    const workers=['one','two'].map(id=>new Worker(new URL('./concurrent-withdrawal.worker.mjs',import.meta.url),{workerData:{id,path,gate}}));
    const outcomes=workers.map(w=>new Promise((resolve,reject)=>{w.once('message',resolve);w.once('error',reject);w.once('exit',code=>{if(code!==0)reject(new Error('Worker exited '+code));});}));
    while(Atomics.load(flags,0)<2) await new Promise(resolve=>setTimeout(resolve,10));
    Atomics.store(flags,1,1);Atomics.notify(flags,1,2);
    const results=await Promise.all(outcomes);
    assert.deepEqual(results.map(r=>r.changed).sort(),[0,1]);
    const check=new DatabaseSync(path);assert.equal(check.prepare('SELECT quantity FROM items').get().quantity,0);
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM movements').get().n,1);check.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
