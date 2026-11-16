import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {schema as migration} from './schema.mjs';
const make=()=>{const db=new DatabaseSync(':memory:');db.exec(migration);return db;};
function scan(db,requestId,barcode,direction){
  const prior=db.prepare('SELECT * FROM movements WHERE request_id=?').get(requestId);
  if(prior)return prior;
  // Same conditional INSERT the API uses (location 1 = Main store).
  db.prepare(`INSERT INTO movements (request_id,item_id,item_name,barcode,direction,quantity,resulting_balance,location_id,location_balance)
    SELECT ?, i.id, i.name, i.barcode, ?, 1, i.quantity + CASE WHEN ? = 'in' THEN 1 ELSE -1 END, 1, COALESCE(s.quantity,0) + CASE WHEN ? = 'in' THEN 1 ELSE -1 END
    FROM items i LEFT JOIN stock s ON s.item_id=i.id AND s.location_id=1 WHERE i.barcode=? AND (?='in' OR COALESCE(s.quantity,0)>0)`).run(requestId,direction,direction,direction,barcode,direction);
  return db.prepare('SELECT * FROM movements WHERE request_id=?').get(requestId);
}
test('acceptance: barcode leading zeros, 3 in + 1 out, four records in date-range export',()=>{
  const db=make();db.prepare('INSERT INTO items(name,barcode) VALUES (?,?)').run('Test Item','001234');
  assert.equal(db.prepare('SELECT quantity FROM items').get().quantity,0);
  for(let i=0;i<3;i++)assert.equal(scan(db,`scan-${i}`,'001234','in').resulting_balance,i+1);
  assert.equal(scan(db,'scan-3','001234','out').resulting_balance,2);
  assert.equal(db.prepare('SELECT quantity FROM items').get().quantity,2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM movements').get().n,4);
  const date=new Date().toISOString().slice(0,10);
  const report=db.prepare('SELECT * FROM movements WHERE created_at >= ? AND created_at < ?').all(`${date}T00:00:00Z`,`${date}T23:59:59.999Z`);
  assert.equal(report.length,4);
  assert.equal(report.filter(x=>x.direction==='in').length,3);
  assert.equal(report.filter(x=>x.direction==='out').length,1);
  assert.equal(db.prepare('SELECT barcode FROM items').get().barcode,'001234');db.close();
});
test('unknown barcode and zero stock out leave stock and movements unchanged',()=>{
  const db=make();db.prepare('INSERT INTO items(name,barcode) VALUES (?,?)').run('Zero','000');
  assert.equal(scan(db,'u','missing','in'),undefined);
  assert.equal(scan(db,'z','000','out'),undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM movements').get().n,0);
  assert.equal(db.prepare('SELECT quantity FROM items').get().quantity,0);db.close();
});
test('idempotent retries do not count twice but intentional scans do',()=>{
  const db=make();db.prepare('INSERT INTO items(name,barcode) VALUES (?,?)').run('Unit','009');
  scan(db,'same','009','in');scan(db,'same','009','in');scan(db,'new','009','in');
  assert.equal(db.prepare('SELECT quantity FROM items').get().quantity,2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM movements').get().n,2);db.close();
});
test('two withdrawals for one unit: exactly one succeeds (conditional SQL)',()=>{
  const db=make();db.prepare('INSERT INTO items(name,barcode,quantity) VALUES (?,?,?)').run('One','001',1);db.prepare('INSERT INTO stock(item_id,location_id,quantity) VALUES (1,1,1)').run();
  const a=scan(db,'a','001','out');const b=scan(db,'b','001','out');
  assert.equal(Number(!!a)+Number(!!b),1);
  assert.equal(db.prepare('SELECT quantity FROM items').get().quantity,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM movements').get().n,1);db.close();
});
test('duplicate barcode rejected by unique constraint',()=>{const db=make();db.prepare('INSERT INTO items(name,barcode) VALUES (?,?)').run('A','01');assert.throws(()=>db.prepare('INSERT INTO items(name,barcode) VALUES (?,?)').run('B','01'));db.close();});
