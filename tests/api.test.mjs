import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {generateKeyPairSync,sign} from 'node:crypto';
import worker,{maltaMidnight} from '../src/worker.ts';
import {schema as migration} from './schema.mjs';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'test-key',alg:'RS256',use:'sig'};
const issuer='https://stockroom-test.cloudflareaccess.com',aud='test-audience';
const b64 = x=>Buffer.from(typeof x==='string'?x:JSON.stringify(x)).toString('base64url');
const signed=()=>{const h=b64({alg:'RS256',kid:'test-key'}), p=b64({iss:issuer,aud:[aud],exp:Math.floor(Date.now()/1000)+300});const input=`${h}.${p}`;return input+'.'+sign('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url');};
const originalFetch=globalThis.fetch;
globalThis.fetch=async url=>{
  if(String(url)===issuer+'/cdn-cgi/access/certs')return Response.json({keys:[jwk]});
  throw new Error('Unexpected fetch '+url);
};
function dbAdapter(db){return {prepare(sql){let args=[];return {bind(...v){args=v;return this;},async first(){return db.prepare(sql).get(...args)??null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){return db.prepare(sql).run(...args);}};}};}
function setup(){const db=new DatabaseSync(':memory:');db.exec(migration);const env={DB:dbAdapter(db),ASSETS:{fetch:async()=>new Response('APP')},CF_ACCESS_TEAM_DOMAIN:issuer,CF_ACCESS_AUD:aud};return {db,env};}
async function request(env,path,method='GET',payload,token=signed()){
 const headers={'Cf-Access-Jwt-Assertion':token};
 if(payload!==undefined)headers['Content-Type']='application/json';
 return worker.fetch(new Request('https://stock.example.com'+path,{method,headers,body:payload===undefined?undefined:JSON.stringify(payload)}),env);
}
test('worker API, report and CSV accept full end date in Europe/Malta',async()=>{
 const {db,env}=setup();
 const create=await request(env,'/api/items','POST',{name:'Widget',barcode:'001234'});
 assert.equal(create.status,201);assert.equal((await create.json()).item.quantity,0);
 const duplicate=await request(env,'/api/items','POST',{name:'Again',barcode:'001234'});
 assert.equal(duplicate.status,409);
 let first;
 for(let i=0;i<4;i++){
  const id=`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
  const direction=i===3?'out':'in';
  const r=await request(env,'/api/scan','POST',{barcode:'001234',direction,requestId:id});assert.equal(r.status,200);
  if(i===0)first={id,direction};
 }
 const retry=await request(env,'/api/scan','POST',{barcode:'001234',direction:first.direction,requestId:first.id});
 assert.equal((await retry.json()).duplicate,true);
 const stock=await (await request(env,'/api/items?q=001234')).json();
 assert.equal(stock.items[0].quantity,2);
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Malta',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const dateParts=date.match(/\d+/g);const maltaDate=dateParts?.length===3&&dateParts[0].length===4?dateParts.join('-'):new Date().toISOString().slice(0,10);
 const report=await request(env,`/api/history?start=${maltaDate}&end=${maltaDate}`);
 assert.equal(report.status,200);const data=await report.json();assert.equal(data.movements.length,4);
 assert.deepEqual(data.totals,{received:3,issued:1,transferred:0});
 const csv=await request(env,`/api/history.csv?start=${maltaDate}&end=${maltaDate}`);
 assert.equal(csv.status,200);const text=await csv.text();
 assert.equal(text.trim().split('\r\n').length,5);
 assert.match(text,/="001234"/);
 const unknown=await request(env,'/api/scan','POST',{barcode:'UNKNOWN',direction:'in',requestId:'00000000-0000-4000-8000-000000009901'});
 assert.equal(unknown.status,404);
 db.close();
});
test('authentication covers frontend and every API, bad token cannot bypass',async()=>{
 const {db,env}=setup();
 for(const path of ['/','/app.js','/api/items','/api/history.csv?start=2026-11-16&end=2026-11-16']){
  assert.equal((await worker.fetch(new Request('https://example.com'+path),env)).status,401);
  assert.equal((await request(env,path,'GET',undefined,'fake.token.signature')).status,401);
 }
 const valid=await request(env,'/');assert.equal(await valid.text(),'APP');db.close();
});
test('Malta date boundaries change across daylight savings',()=>{
 assert.equal(maltaMidnight('2026-03-29'),'2026-03-28T23:00:00.000Z');
 assert.equal(maltaMidnight('2026-03-30'),'2026-03-29T22:00:00.000Z');
 assert.equal(maltaMidnight('2026-10-25'),'2026-10-24T22:00:00.000Z');
 assert.equal(maltaMidnight('2026-10-26'),'2026-10-25T23:00:00.000Z');
});
test('weekly summary gives opening, in, out and closing per item',async()=>{
 const {db,env}=setup();
 await request(env,'/api/items','POST',{name:'SFP',barcode:'0099'});
 const scan=async(i,direction)=>request(env,'/api/scan','POST',{barcode:'0099',direction,requestId:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`});
 for(let i=0;i<5;i++)await scan(i,'in');
 // Move the first 5 receipts into the previous week (Malta time).
 db.prepare("UPDATE movements SET created_at='2026-11-05T10:00:00.000Z'").run();
 db.prepare("UPDATE items SET created_at='2026-11-01T10:00:00.000Z'").run();
 await scan(10,'out');await scan(11,'out');await scan(12,'in');
 db.prepare("UPDATE movements SET created_at='2026-11-10T10:00:00.000Z' WHERE created_at > '2026-11-06'").run();
 const r=await request(env,'/api/summary?start=2026-11-09&end=2026-11-15');
 assert.equal(r.status,200);
 const [row]=(await r.json()).items;
 assert.deepEqual({opening:row.opening,received:row.received,issued:row.issued,closing:row.closing},{opening:5,received:1,issued:2,closing:4});
 assert.equal((await request(env,'/api/summary?start=2026-11-15&end=2026-11-09')).status,400);
 const csv=await request(env,'/api/history.csv?start=2026-11-09&end=2026-11-15');
 assert.match(csv.headers.get('content-disposition'),/stockroom-movements_2026-11-09_to_2026-11-15\.csv/);
 db.close();
});
test('production records the Access email as "who" and ignores a spoofed header',async()=>{
 const {db,env}=setup();
 const h=b64({alg:'RS256',kid:'test-key'}), p=b64({iss:issuer,aud:[aud],exp:Math.floor(Date.now()/1000)+300,email:'tristan@enemalta.example'});
 const token=`${h}.${p}.`+sign('RSA-SHA256',Buffer.from(`${h}.${p}`),privateKey).toString('base64url');
 const send=(path,method,body)=>worker.fetch(new Request('https://stock.example.com'+path,{method,headers:{'Cf-Access-Jwt-Assertion':token,'content-type':'application/json','X-Stockroom-User':'someone-else'},body:body&&JSON.stringify(body)}),env);
 await send('/api/items','POST',{name:'AP',barcode:'Q9'});
 const r=await (await send('/api/scan','POST',{barcode:'Q9',direction:'in',requestId:'00000000-0000-4000-8000-00000000abcd'})).json();
 assert.equal(r.movement.actor,'tristan@enemalta.example');
 assert.deepEqual(await (await send('/api/me','GET')).json(),{name:'tristan@enemalta.example',source:'access'});
 db.close();
});
