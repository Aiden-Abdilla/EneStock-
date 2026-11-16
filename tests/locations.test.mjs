import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrations,schema} from './schema.mjs';
import worker from '../src/worker.local.ts';
function dbAdapter(db){return {prepare(sql){let args=[];return {bind(...v){args=v;return this;},async first(){return db.prepare(sql).get(...args)??null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){return db.prepare(sql).run(...args);}};}};}
const setup=()=>{const db=new DatabaseSync(':memory:');db.exec(schema);return {db,env:{DB:dbAdapter(db),ASSETS:{fetch:async()=>new Response('APP')}}};};
let n=0;const uuid=()=>`00000000-0000-4000-9000-${String(++n).padStart(12,'0')}`;
const call=async(env,path,method='GET',body,user)=>{const h={};if(body)h['content-type']='application/json';if(user)h['X-Stockroom-User']=encodeURIComponent(user);const r=await worker.fetch(new Request('http://localhost:8787'+path,{method,headers:h,body:body?JSON.stringify(body):undefined}),env);return {status:r.status,body:await r.json()};};
const totalsMatch=db=>db.prepare('SELECT COUNT(*) n FROM items i WHERE i.quantity != COALESCE((SELECT SUM(quantity) FROM stock s WHERE s.item_id=i.id),0)').get().n===0;

test('0003 upgrade moves existing stock and history into "Main store"',()=>{
  const db=new DatabaseSync(':memory:');db.exec(migrations[0].sql);db.exec(migrations[1].sql);
  db.exec("INSERT INTO items(name,barcode) VALUES ('SFP','A'),('Unused','B')");
  db.exec("INSERT INTO movements(request_id,item_id,item_name,barcode,direction,quantity,resulting_balance,note) VALUES ('1',1,'SFP','A','in',5,5,NULL),('2',1,'SFP','A','out',2,3,'Installed')");
  for(const m of migrations.slice(2))db.exec(m.sql);
  assert.deepEqual(db.prepare('SELECT id,name FROM locations').all().map(r=>({...r})),[{id:1,name:'Main store'}]);
  assert.deepEqual(db.prepare('SELECT item_id,location_id,quantity FROM stock').all().map(r=>({...r})),[{item_id:1,location_id:1,quantity:3}]);
  assert.deepEqual(db.prepare('SELECT request_id,location_id,location_balance,resulting_balance,note FROM movements ORDER BY id').all().map(r=>({...r})),
    [{request_id:'1',location_id:1,location_balance:5,resulting_balance:5,note:null},{request_id:'2',location_id:1,location_balance:3,resulting_balance:3,note:'Installed'}]);
  assert.ok(totalsMatch(db));db.close();
});

test('stock per location: in, out, transfer, and totals always add up',async()=>{
  const {db,env}=setup();
  const dps=(await call(env,'/api/locations','POST',{name:'DPS store'})).body.location;
  assert.equal((await call(env,'/api/locations','POST',{name:'dps STORE'})).status,409);
  await call(env,'/api/items','POST',{name:'SFP-10G-SR',barcode:'10-2415-03',category:'SFPs',min_qty:4});
  await call(env,'/api/scan','POST',{barcode:'10-2415-03',direction:'in',quantity:6,location_id:1,requestId:uuid()});
  // Nothing at DPS yet: stock out there is refused even though Main store has 6.
  let r=await call(env,'/api/scan','POST',{barcode:'10-2415-03',direction:'out',location_id:dps.id,requestId:uuid()});
  assert.equal(r.status,409);assert.match(r.body.error,/None at DPS store\. 6 held elsewhere/);
  r=await call(env,'/api/transfer','POST',{barcode:'10-2415-03',from:1,to:dps.id,quantity:2,note:'For Delimara job',requestId:uuid()},'Tristan');
  assert.equal(r.status,200);
  assert.deepEqual({d:r.body.movement.direction,from:r.body.movement.location_name,to:r.body.movement.to_location_name,a:r.body.movement.location_balance,b:r.body.movement.to_location_balance,t:r.body.movement.resulting_balance,by:r.body.movement.actor},
    {d:'transfer',from:'Main store',to:'DPS store',a:4,b:2,t:6,by:'Tristan'});
  assert.equal((await call(env,'/api/transfer','POST',{barcode:'10-2415-03',from:1,to:dps.id,quantity:9,requestId:uuid()})).status,409);
  assert.equal((await call(env,'/api/transfer','POST',{barcode:'10-2415-03',from:1,to:1,requestId:uuid()})).status,400);
  r=await call(env,'/api/scan','POST',{barcode:'10-2415-03',direction:'out',location_id:dps.id,note:'Installed',requestId:uuid()},'Glenn');
  assert.equal(r.body.movement.location_balance,1);assert.equal(r.body.movement.resulting_balance,5);assert.equal(r.body.movement.actor,'Glenn');
  const item=(await call(env,'/api/items')).body.items[0];
  assert.equal(item.quantity,5);assert.equal(item.category,'SFPs');assert.equal(item.min_qty,4);
  assert.deepEqual(item.stock.sort((a,b)=>a.location_id-b.location_id),[{location_id:1,quantity:4},{location_id:dps.id,quantity:1}]);
  // Weekly report: transfers don't count as in or out.
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Malta'}).format(new Date());
  const h=(await call(env,`/api/history?start=${day}&end=${day}`)).body;
  assert.deepEqual(h.totals,{received:6,issued:1,transferred:2});
  const s=(await call(env,`/api/summary?start=${day}&end=${day}`)).body;
  assert.deepEqual({o:s.items[0].opening,i:s.items[0].received,u:s.items[0].issued,c:s.items[0].closing},{o:0,i:6,u:1,c:5});
  assert.equal(s.locations.length,2);
  assert.ok(totalsMatch(db));db.close();
});

test('count at one location only changes that location',async()=>{
  const {db,env}=setup();
  const dps=(await call(env,'/api/locations','POST',{name:'DPS store'})).body.location;
  const {body:{item}}=await call(env,'/api/items','POST',{name:'Cat6 2m',barcode:'5060123450012'});
  await call(env,'/api/scan','POST',{barcode:'5060123450012',direction:'in',quantity:10,location_id:1,requestId:uuid()});
  await call(env,'/api/scan','POST',{barcode:'5060123450012',direction:'in',quantity:3,location_id:dps.id,requestId:uuid()});
  const r=await call(env,`/api/items/${item.id}/count`,'POST',{count:8,location_id:1,requestId:uuid(),note:'Stock take'},'Tristan');
  assert.equal(r.status,200);
  assert.deepEqual({d:r.body.movement.direction,q:r.body.movement.quantity,lb:r.body.movement.location_balance,t:r.body.movement.resulting_balance,by:r.body.movement.actor},{d:'out',q:2,lb:8,t:11,by:'Tristan'});
  assert.equal(r.body.item.quantity,11);
  assert.ok(totalsMatch(db));db.close();
});

test('categories, minimum levels and validation',async()=>{
  const {db,env}=setup();
  const {body:{item}}=await call(env,'/api/items','POST',{name:'LC-LC 3m',barcode:'X1',category:'  Cables ',min_qty:10});
  assert.equal(item.category,'Cables');assert.equal(item.min_qty,10);
  let r=await call(env,`/api/items/${item.id}`,'PATCH',{min_qty:null,category:''});
  assert.equal(r.body.item.min_qty,null);assert.equal(r.body.item.category,null);
  assert.equal((await call(env,`/api/items/${item.id}`,'PATCH',{min_qty:-1})).status,400);
  assert.equal((await call(env,`/api/items/${item.id}`,'PATCH',{min_qty:'5'})).status,400);
  await call(env,`/api/items/${item.id}`,'PATCH',{category:'Cables'});
  await call(env,'/api/items','POST',{name:'Other',barcode:'X2',category:'cables'});
  assert.deepEqual((await call(env,'/api/categories')).body.categories.map(c=>c.items),[2]);
  db.close();
});

test('locations: rename, and remove only when unused',async()=>{
  const {db,env}=setup();
  const a=(await call(env,'/api/locations','POST',{name:'Naxxar DC'})).body.location;
  const b=(await call(env,'/api/locations','POST',{name:'Typo'})).body.location;
  assert.equal((await call(env,`/api/locations/1`,'PATCH',{name:'MPS store'})).body.location.name,'MPS store');
  await call(env,'/api/items','POST',{name:'AP',barcode:'Q1'});
  await call(env,'/api/scan','POST',{barcode:'Q1',direction:'in',location_id:a.id,requestId:uuid()});
  assert.equal((await call(env,`/api/locations/${a.id}`,'DELETE')).status,409);
  assert.equal((await call(env,`/api/locations/${b.id}`,'DELETE')).status,200);
  assert.deepEqual((await call(env,'/api/locations')).body.locations.map(l=>[l.name,l.units]),[['MPS store',0],['Naxxar DC',1]]);
  db.close();
});

test('who: local name header is recorded, production ignores it in favour of the Access email',async()=>{
  const {db,env}=setup();
  assert.deepEqual((await call(env,'/api/me','GET',undefined,'Tristan B')).body,{name:'Tristan B',source:'local'});
  db.close();
});
