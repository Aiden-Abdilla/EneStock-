import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {generateKeyPairSync,sign} from 'node:crypto';
import worker,{maltaMidnight} from '../src/worker.ts';
const migration=readFileSync(new URL('../migrations/0001_inventory.sql',import.meta.url),'utf8');
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
 assert.deepEqual(data.totals,{received:3,issued:1});
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
