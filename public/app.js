const $ = id => document.getElementById(id);
let mode = null;
let busy = false;
const fmt = new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/Malta',dateStyle:'short',timeStyle:'medium'});
const day = new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Malta',year:'numeric',month:'2-digit',day:'2-digit'});
const today = () => {const p=Object.fromEntries(day.formatToParts(new Date()).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;};
$('start').value = today(); $('end').value = today();
async function api(url, options){const res=await fetch(url,{...options,headers:{'content-type':'application/json',...options?.headers}});const data=await res.json();if(!res.ok)throw new Error(data.error || `HTTP ${res.status}`);return data;}
function message(el, value, ok){el.textContent=value;el.className=ok?'ok':'error';}
function cell(tr, value){const td=document.createElement('td');td.textContent=String(value);tr.append(td);}
async function items(){const data=await api('/api/items?q='+encodeURIComponent($('search').value));const tbody=$('items');tbody.replaceChildren();for(const item of data.items){const tr=document.createElement('tr');[item.name,item.barcode,item.quantity].forEach(v=>cell(tr,v));tbody.append(tr);}if(!data.items.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=3;td.textContent='No matching stock items';tr.append(td);tbody.append(tr);}}
function params(){return new URLSearchParams({start:$('start').value,end:$('end').value});}
async function history(){const d=await api('/api/history?'+params());$('totals').textContent=`Received: ${d.totals.received} units  |  Issued: ${d.totals.issued} units  |  Movements: ${d.movements.length}`;const tbody=$('history');tbody.replaceChildren();for(const m of d.movements){const tr=document.createElement('tr');[fmt.format(new Date(m.created_at)),m.item_name,m.barcode,m.direction==='in'?'Stock In':'Stock Out',m.quantity,m.resulting_balance].forEach(x=>cell(tr,x));tbody.append(tr);}}
async function refresh(){await Promise.all([items(),history()]);}
for(const which of ['in','out'])$(which).addEventListener('click',()=>{mode=which;$('in').classList.toggle('selected',mode==='in');$('out').classList.toggle('selected',mode==='out');$('in').setAttribute('aria-pressed',String(mode==='in'));$('out').setAttribute('aria-pressed',String(mode==='out'));$('modeLabel').textContent=mode==='in'?'Mode: STOCK IN (+1 per scan)':'Mode: STOCK OUT (−1 per scan)';$('scan').disabled=false;$('scan').placeholder='Scan or enter barcode';$('scan').focus();});
$('scan').addEventListener('keydown',async e=>{if(e.key!=='Enter')return;e.preventDefault();if(!mode||busy)return;const barcode=$('scan').value.trim();if(!barcode)return;busy=true;$('scan').disabled=true;const requestId=crypto.randomUUID();try{const data=await api('/api/scan',{method:'POST',body:JSON.stringify({barcode,direction:mode,requestId})});message($('feedback'),`${data.movement.item_name} (${data.movement.barcode}) — new balance: ${data.movement.resulting_balance}`,true);await refresh();}catch(err){message($('feedback'),err.message,false);}finally{$('scan').value='';$('scan').disabled=false;$('scan').focus();busy=false;}});
$('showAdd').addEventListener('click',()=>{$('add').hidden=!$('add').hidden;if(!$('add').hidden)$('barcode').focus();});
$('addForm').addEventListener('submit',async e=>{e.preventDefault();try{const d=await api('/api/items',{method:'POST',body:JSON.stringify({name:$('name').value,barcode:$('barcode').value})});message($('addStatus'),`Registered ${d.item.name} with balance 0.`,true);$('addForm').reset();await items();}catch(err){message($('addStatus'),err.message,false);}});
let debounce;$('search').addEventListener('input',()=>{clearTimeout(debounce);debounce=setTimeout(()=>items().catch(e=>message($('feedback'),e.message,false)),200);});
$('apply').addEventListener('click',()=>history().catch(e=>message($('feedback'),e.message,false)));
$('csv').addEventListener('click',()=>{if(!$('start').value||!$('end').value){message($('feedback'),'Choose valid report dates.',false);return;}window.location.href='/api/history.csv?'+params();});
refresh().catch(err=>message($('feedback'),err.message,false));
