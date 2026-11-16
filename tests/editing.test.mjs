import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrations,schema} from './schema.mjs';
import worker from '../src/worker.local.ts';
function dbAdapter(db){return {prepare(sql){let args=[];return {bind(...v){args=v;return this;},async first(){return db.prepare(sql).get(...args)??null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){return db.prepare(sql).run(...args);}};}};}
const setup=()=>{const db=new DatabaseSync(':memory:');db.exec(schema);return {db,env:{DB:dbAdapter(db),ASSETS:{fetch:async()=>new Response('APP')}}};};
let n=0;const uuid=()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;
const call=async(env,path,method='GET',body)=>{const r=await worker.fetch(new Request('http://localhost:8787'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined}),env);return {status:r.status,body:await r.json()};};

test('0002 migration keeps existing stock and history, and the trigger still guards balances',()=>{
  const db=new DatabaseSync(':memory:');db.exec(migrations[0].sql);
  db.prepare("INSERT INTO items(name,barcode) VALUES ('SFP','0042')").run();
  for(const [i,d] of [[1,'in'],[2,'in'],[3,'out']])db.prepare(`INSERT INTO movements (request_id,item_id,item_name,barcode,direction,quantity,resulting_balance) SELECT ?, id, name, barcode, ?, 1, quantity + CASE WHEN ?='in' THEN 1 ELSE -1 END FROM items`).run('r'+i,d,d);
  db.exec(migrations[1].sql); // 0002 only: this test is about that upgrade step
  assert.equal(db.prepare('SELECT quantity FROM items').get().quantity,1);
  assert.deepEqual(db.prepare('SELECT request_id,direction,resulting_balance,reason FROM movements ORDER BY id').all().map(r=>({...r})),
    [{request_id:'r1',direction:'in',resulting_balance:1,reason:'scan'},{request_id:'r2',direction:'in',resulting_balance:2,reason:'scan'},{request_id:'r3',direction:'out',resulting_balance:1,reason:'scan'}]);
  // A movement whose expected balance is stale must be rejected.
  assert.throws(()=>db.prepare("INSERT INTO movements (request_id,item_id,item_name,barcode,direction,quantity,resulting_balance) VALUES ('bad',1,'SFP','0042','in',5,99)").run(),/stale/);
  db.prepare("INSERT INTO movements (request_id,item_id,item_name,barcode,direction,quantity,resulting_balance) VALUES ('ok',1,'SFP','0042','in',5,6)").run();
  assert.equal(db.prepare('SELECT quantity FROM items').get().quantity,6);
  db.close();
});

test('scan with quantity, and stock out cannot exceed what is on hand',async()=>{
  const {db,env}=setup();
  await call(env,'/api/items','POST',{name:'Cat6 2m',barcode:'5060123450012'});
  let r=await call(env,'/api/scan','POST',{barcode:'5060123450012',direction:'in',quantity:10,requestId:uuid()});
  assert.equal(r.status,200);assert.equal(r.body.movement.quantity,10);assert.equal(r.body.movement.resulting_balance,10);
  r=await call(env,'/api/scan','POST',{barcode:'5060123450012',direction:'out',quantity:11,requestId:uuid()});
  assert.equal(r.status,409);assert.match(r.body.error,/only 10 at Main store/);
  r=await call(env,'/api/scan','POST',{barcode:'5060123450012',direction:'out',quantity:4,requestId:uuid()});
  assert.equal(r.body.movement.resulting_balance,6);
  for(const bad of [0,-1,1.5,'3',10001])assert.equal((await call(env,'/api/scan','POST',{barcode:'5060123450012',direction:'in',quantity:bad,requestId:uuid()})).status,400);
  // Same request ID retried = no double count; same ID with different qty = rejected.
  const id=uuid();await call(env,'/api/scan','POST',{barcode:'5060123450012',direction:'in',quantity:2,requestId:id});
  assert.equal((await call(env,'/api/scan','POST',{barcode:'5060123450012',direction:'in',quantity:2,requestId:id})).body.duplicate,true);
  assert.equal((await call(env,'/api/scan','POST',{barcode:'5060123450012',direction:'in',quantity:3,requestId:id})).status,409);
  assert.equal(db.prepare('SELECT quantity FROM items').get().quantity,8);
  db.close();
});

test('invisible scanner characters do not stop a registered barcode matching',async()=>{
  const {db,env}=setup();
  const reg=await call(env,'/api/items','POST',{name:'MR46',barcode:'\u001dN224C7290034\r'});
  assert.equal(reg.body.item.barcode,'N224C7290034');
  const r=await call(env,'/api/scan','POST',{barcode:'​N224C7290034 ',direction:'in',requestId:uuid()});
  assert.equal(r.status,200);assert.equal(r.body.movement.resulting_balance,1);
  db.close();
});

test('edit name and barcode, history keeps the old snapshot',async()=>{
  const {db,env}=setup();
  const {body:{item}}=await call(env,'/api/items','POST',{name:'Wrong name',barcode:'N224C729OO34'});
  await call(env,'/api/items','POST',{name:'Other',barcode:'TAKEN'});
  await call(env,'/api/scan','POST',{barcode:'N224C729OO34',direction:'in',requestId:uuid()});
  let r=await call(env,`/api/items/${item.id}`,'PATCH',{name:'Meraki MR46',barcode:'N224C7290034'});
  assert.equal(r.status,200);assert.equal(r.body.item.barcode,'N224C7290034');assert.equal(r.body.item.quantity,1);
  assert.equal((await call(env,`/api/items/${item.id}`,'PATCH',{barcode:'TAKEN'})).status,409);
  assert.equal((await call(env,`/api/items/${item.id}`,'PATCH',{name:'  '})).status,400);
  assert.equal((await call(env,'/api/scan','POST',{barcode:'N224C7290034',direction:'in',requestId:uuid()})).body.movement.resulting_balance,2);
  const hist=(await call(env,`/api/items/${item.id}/movements`)).body.movements;
  assert.deepEqual(hist.map(m=>m.barcode),['N224C7290034','N224C729OO34']);
  db.close();
});

test('stock-take count records one adjustment for the difference',async()=>{
  const {db,env}=setup();
  const {body:{item}}=await call(env,'/api/items','POST',{name:'SFP-10G-SR',barcode:'10-2415-03'});
  await call(env,'/api/scan','POST',{barcode:'10-2415-03',direction:'in',quantity:9,requestId:uuid()});
  const id=uuid();
  let r=await call(env,`/api/items/${item.id}/count`,'POST',{count:7,requestId:id,note:'Stock take'});
  assert.equal(r.status,200);assert.equal(r.body.item.quantity,7);
  assert.deepEqual({d:r.body.movement.direction,q:r.body.movement.quantity,reason:r.body.movement.reason,note:r.body.movement.note},{d:'out',q:2,reason:'adjustment',note:'Stock take'});
  assert.equal((await call(env,`/api/items/${item.id}/count`,'POST',{count:7,requestId:id})).body.duplicate,true);
  r=await call(env,`/api/items/${item.id}/count`,'POST',{count:12,requestId:uuid()});
  assert.equal(r.body.movement.direction,'in');assert.equal(r.body.movement.quantity,5);
  r=await call(env,`/api/items/${item.id}/count`,'POST',{count:12,requestId:uuid()});
  assert.equal(r.body.movement,null);
  for(const bad of [-1,2.5,'4'])assert.equal((await call(env,`/api/items/${item.id}/count`,'POST',{count:bad,requestId:uuid()})).status,400);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM movements').get().n,3);
  assert.equal((await call(env,'/api/items/999/count','POST',{count:1,requestId:uuid()})).status,404);
  db.close();
});

test('delete only allowed for items with no history',async()=>{
  const {db,env}=setup();
  const a=(await call(env,'/api/items','POST',{name:'Typo',barcode:'X1'})).body.item;
  const b=(await call(env,'/api/items','POST',{name:'Used',barcode:'X2'})).body.item;
  await call(env,'/api/scan','POST',{barcode:'X2',direction:'in',requestId:uuid()});
  assert.equal((await call(env,`/api/items/${a.id}`,'DELETE')).status,200);
  assert.equal((await call(env,`/api/items/${b.id}`,'DELETE')).status,409);
  assert.deepEqual(db.prepare('SELECT barcode FROM items').all().map(r=>r.barcode),['X2']);
  db.close();
});

test('cross-site edits are refused',async()=>{
  const {db,env}=setup();
  const r=await worker.fetch(new Request('http://localhost:8787/api/items/1',{method:'PATCH',headers:{Origin:'https://evil.example','content-type':'application/json'},body:'{}'}),env);
  assert.equal(r.status,403);db.close();
});

test('stock out can carry a reason, and it reaches the CSV export',async()=>{
  const {db,env}=setup();
  await call(env,'/api/items','POST',{name:'SFP-10G-LR',barcode:'10-2457-02'});
  await call(env,'/api/scan','POST',{barcode:'10-2457-02',direction:'in',quantity:4,requestId:uuid()});
  const r=await call(env,'/api/scan','POST',{barcode:'10-2457-02',direction:'out',quantity:2,note:'  Installed at Naxxar DC\n',requestId:uuid()});
  assert.equal(r.body.movement.note,'Installed at Naxxar DC');
  const noNote=await call(env,'/api/scan','POST',{barcode:'10-2457-02',direction:'out',note:'   ',requestId:uuid()});
  assert.equal(noNote.body.movement.note,null);
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Malta'}).format(new Date());
  const csv=await (await worker.fetch(new Request(`http://localhost:8787/api/history.csv?start=${day}&end=${day}`),env)).text();
  assert.match(csv,/"Installed at Naxxar DC"/);
  db.close();
});
