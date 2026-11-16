import {parentPort, workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
const db = new DatabaseSync(workerData.path);
db.exec('PRAGMA busy_timeout = 5000');
const gate = new Int32Array(workerData.gate);
Atomics.add(gate,0,1);
Atomics.notify(gate,0);
Atomics.wait(gate,1,0,5000);
try {
  const result=db.prepare(`INSERT INTO movements (request_id,item_id,item_name,barcode,direction,quantity,resulting_balance)
    SELECT ?, id, name, barcode, 'out', 1, quantity - 1 FROM items WHERE barcode = ? AND quantity > 0`).run(workerData.id,'001');
  parentPort.postMessage({changed: result.changes});
} catch (e) { parentPort.postMessage({error:String(e)}); }
finally {db.close();}
