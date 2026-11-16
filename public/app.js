import { buildXlsx, S, ref } from '/xlsx.js';
import { code128Svg, code128Modules } from '/code128.js';

const $ = id => document.getElementById(id);
const TZ = 'Europe/Malta';
const MAX_QTY = 10000;

// ───────────────────────── Helpers ─────────────────────────
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const stampFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const whenFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const hmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' });
const clockFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const shortDay = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const nf = new Intl.NumberFormat('en-GB');
const longDay = { format: d => `${shortDay.format(d)} ${d.getUTCFullYear()}` };

const partsOf = (fmt, d) => Object.fromEntries(fmt.formatToParts(d).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
const maltaDay = d => { const p = partsOf(dayFmt, d); return `${p.year}-${p.month}-${p.day}`; };
const today = () => maltaDay(new Date());
const utc = s => new Date(`${s}T00:00:00Z`);
const addDays = (s, n) => { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mondayOf = s => addDays(s, -((utc(s).getUTCDay() + 6) % 7));
const isoWeek = s => { const d = utc(s); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3); const y = d.getUTCFullYear(); const jan4 = new Date(Date.UTC(y, 0, 4)); return { week: 1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7), year: y }; };
const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + nf.format(Math.abs(n));
const signClass = n => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero');
const intOf = v => { const n = parseInt(String(v).replace(/\D/g, ''), 10); return Number.isFinite(n) ? n : 0; };
const optInt = v => { const s = String(v).trim(); return s === '' ? null : intOf(s); };
const store = {
  get(k, d = null) { try { const v = localStorage.getItem('stockroom.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('stockroom.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

function lastMoved(iso) {
  if (!iso) return 'Never moved';
  const d = new Date(iso), days = Math.round((utc(today()) - utc(maltaDay(d))) / 864e5);
  if (days <= 0) return `Today, ${hmFmt.format(d)}`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return dmFmt.format(d);
}

// ── Who is using the app ──
let me = { name: null, source: 'local' };
const localName = () => store.get('user', '') || '';

async function api(url, options) {
  const headers = { 'content-type': 'application/json', ...options?.headers };
  if (me.source === 'local' && localName()) headers['X-Stockroom-User'] = encodeURIComponent(localName());
  const res = await fetch(url, { ...options, headers });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) { const e = new Error(data.error || `Request failed (HTTP ${res.status})`); e.status = res.status; e.data = data; throw e; }
  return data;
}
const post = (url, body, method = 'POST') => api(url, { method, body: JSON.stringify(body) });

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}
const td = (text, cls) => el('td', { class: cls, text: String(text) });

let toastTimer;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3000); }

function setRadio(group, attr, value) {
  group.querySelectorAll(`[${attr}]`).forEach(b => b.setAttribute('aria-checked', String(b.getAttribute(attr) === value)));
}
const dialogs = ['addDialog', 'itemDialog', 'labelDialog', 'locDialog', 'whoDialog'];
const anyDialogOpen = () => dialogs.some(id => $(id).open);

// Short confirmation tones so the operator can scan without watching the screen.
let audio;
function beep(ok) {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'sine'; o.frequency.value = ok ? 1320 : 220;
    g.gain.setValueAtTime(0.0001, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, audio.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + (ok ? 0.12 : 0.35));
    o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.4);
  } catch { /* audio unavailable */ }
}

// Generic − / + steppers: <button data-step="-1" data-for="inputId">
document.addEventListener('click', e => {
  const b = e.target.closest('[data-step][data-for]');
  if (!b) return;
  const input = $(b.dataset.for);
  const min = input.id === 'moveQty' || input.id === 'labelCopies' ? 1 : 0;
  input.value = String(Math.max(min, Math.min(1_000_000, intOf(input.value) + Number(b.dataset.step))));
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
for (const id of ['addQty', 'itemCount', 'qty', 'moveQty', 'labelCopies', 'addMin', 'itemMin']) {
  $(id).addEventListener('input', e => { const v = e.target.value.replace(/\D/g, ''); if (v !== e.target.value) e.target.value = v; });
  $(id).addEventListener('focus', e => e.target.select());
}

// ───────────────────────── Locations ─────────────────────────
let locations = [];
const locName = id => locations.find(l => l.id === Number(id))?.name ?? '—';

function fillSelect(sel, { blank, keep = true } = {}) {
  const prev = sel.value;
  sel.replaceChildren(...(blank ? [el('option', { value: '', text: blank })] : []), ...locations.map(l => el('option', { value: String(l.id), text: l.name })));
  if (keep && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}
async function loadLocations() {
  locations = (await api('/api/locations')).locations;
  for (const id of ['loc', 'toLoc', 'addLoc', 'countLoc', 'moveFrom', 'moveTo']) fillSelect($(id));
  fillSelect($('invLoc'), { blank: 'All locations' });
  const saved = String(store.get('loc', locations[0]?.id ?? 1));
  $('loc').value = locations.some(l => String(l.id) === saved) ? saved : String(locations[0]?.id ?? '');
  const savedTo = String(store.get('toLoc', ''));
  if (locations.some(l => String(l.id) === savedTo)) $('toLoc').value = savedTo;
  fixMoveTarget();
  if (!$('invLoc').value) $('invLoc').value = '';
}
// A move needs two different places.
function fixMoveTarget() {
  if ($('toLoc').value === $('loc').value || !$('toLoc').value) {
    const other = locations.find(l => String(l.id) !== $('loc').value);
    if (other) $('toLoc').value = String(other.id);
  }
}
$('loc').addEventListener('change', () => { store.set('loc', Number($('loc').value)); fixMoveTarget(); if (mode) $('scan').focus(); });
$('toLoc').addEventListener('change', () => {
  if ($('toLoc').value === $('loc').value) { const other = locations.find(l => String(l.id) !== $('toLoc').value); if (other) $('loc').value = String(other.id); store.set('loc', Number($('loc').value)); }
  store.set('toLoc', Number($('toLoc').value)); if (mode) $('scan').focus();
});

function renderLocDialog() {
  const list = $('locList');
  list.replaceChildren();
  for (const l of locations) {
    const input = el('input', { value: l.name, maxlength: '80', 'aria-label': `Rename ${l.name}` });
    const save = async () => {
      const name = input.value.trim();
      if (!name || name === l.name) { input.value = l.name; return; }
      try { await post(`/api/locations/${l.id}`, { name }, 'PATCH'); toast(`Renamed to ${name}`); await refreshAfterLocationChange(); }
      catch (err) { $('locStatus').textContent = err.message; input.value = l.name; }
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    const rm = el('button', { type: 'button', class: 'rm', text: 'Remove', hidden: l.used > 0 || l.units > 0 || locations.length <= 1 });
    rm.addEventListener('click', async () => {
      try { await api(`/api/locations/${l.id}`, { method: 'DELETE' }); toast(`Removed ${l.name}`); await refreshAfterLocationChange(); }
      catch (err) { $('locStatus').textContent = err.message; }
    });
    list.append(el('li', {}, input, el('span', { class: 'units', text: l.units ? `${nf.format(l.units)} units` : 'Empty' }), rm));
  }
}
async function refreshAfterLocationChange() { await loadLocations(); renderLocDialog(); inventoryDirty = true; if (view === 'inventory') await loadInventory(); }
$('showLocations').addEventListener('click', async () => { $('locStatus').textContent = ''; await loadLocations(); renderLocDialog(); $('locDialog').showModal(); $('newLoc').focus(); });
$('closeLoc').addEventListener('click', () => $('locDialog').close());
$('locForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('newLoc').value.trim();
  if (!name) return;
  try { await post('/api/locations', { name }); $('newLoc').value = ''; $('locStatus').textContent = ''; toast(`Added ${name}`); await refreshAfterLocationChange(); $('newLoc').focus(); }
  catch (err) { $('locStatus').textContent = err.message; }
});

// ───────────────────────── Who ─────────────────────────
function renderUser() {
  const chip = $('userChip');
  const name = me.source === 'access' ? me.name : localName();
  chip.classList.toggle('unset', !name);
  chip.disabled = me.source === 'access';
  $('userName').textContent = name || 'Set your name';
  $('userAvatar').textContent = name ? name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') : '?';
  chip.title = me.source === 'access' ? `Signed in as ${name}` : 'Who is using this PC (saved on every movement)';
}
async function loadMe() {
  try { me = await api('/api/me'); } catch { me = { name: null, source: 'local' }; }
  renderUser();
}
$('userChip').addEventListener('click', () => { if (me.source === 'access') return; $('whoName').value = localName(); $('whoDialog').showModal(); $('whoName').focus(); });
$('cancelWho').addEventListener('click', () => $('whoDialog').close());
$('whoForm').addEventListener('submit', e => { e.preventDefault(); store.set('user', $('whoName').value.trim().slice(0, 60)); renderUser(); $('whoDialog').close(); toast(localName() ? `Hi ${localName()}` : 'Name cleared'); });
for (const id of dialogs) $(id).addEventListener('close', () => setTimeout(focusDefault));

// ───────────────────────── Navigation ─────────────────────────
let view = 'scan';
const loaders = { scan: async () => {}, inventory: () => loadInventory(), reports: () => loadReport() };
function show(name) {
  if (!loaders[name]) name = 'scan';
  view = name;
  document.querySelectorAll('.tabs [data-view]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === name)));
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== `view-${name}`; });
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  loaders[name]().catch(err => toast(err.message));
  focusDefault();
}
function focusDefault() {
  if (anyDialogOpen()) return;
  const target = view === 'scan' && mode ? $('scan') : view === 'inventory' ? $('search') : null;
  if (!target) return;
  // After a <dialog> closes, Chrome restores focus to this input but can leave the
  // text caret outside it, so keystrokes (scanner input) are silently dropped.
  // Blurring first forces a real focus change, which places the caret correctly.
  if (document.activeElement === target) target.blur();
  target.focus();
}
document.querySelectorAll('.tabs [data-view]').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));
window.addEventListener('hashchange', () => show(location.hash.slice(1)));

const tick = () => { $('clock').textContent = clockFmt.format(new Date()); };
tick(); setInterval(tick, 15000);

// Keep scanner keystrokes landing in the right box even if focus wandered off.
document.addEventListener('keydown', e => {
  if (anyDialogOpen() || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
  const a = document.activeElement;
  if (a === $('qty') && !/\d/.test(e.key) && mode) { setQty(getQty()); $('scan').focus(); return; }
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')) return;
  if (view === 'scan' && mode) $('scan').focus();
  else if (view === 'inventory') $('search').focus();
});

// ───────────────────────── Scan ─────────────────────────
let mode = null, busy = false;
const session = [];
const HINTS = {
  in: 'Stock in. Set Qty for boxes or bundles; it goes back to 1 after each scan.',
  out: 'Stock out. Add a reason if you like; it stays until you clear it.',
  move: 'Move stock between locations. Totals don’t change, so moves don’t count as in or out.',
};

function setMode(m) {
  // A quantity left over from another mode (e.g. after a failed scan) is a trap: start at 1.
  if (m !== mode) setQty(1);
  mode = m;
  for (const b of document.querySelectorAll('.segmented.big [data-mode]')) b.setAttribute('aria-checked', String(b.dataset.mode === m));
  $('scanbox').dataset.mode = m;
  const s = $('scan');
  s.disabled = false;
  s.placeholder = { in: 'Scan to add stock', out: 'Scan to remove stock', move: 'Scan to move stock' }[m];
  $('reasonRow').hidden = m === 'in';
  $('reasonLabel').textContent = m === 'move' ? 'Note' : 'Reason';
  $('reasonChips').hidden = m === 'move';
  $('reason').placeholder = m === 'move' ? 'Optional, e.g. Spares for Delimara job' : 'Optional, e.g. Installed at Naxxar DC · Faulty, RMA';
  $('locLabel').textContent = m === 'move' ? 'From' : 'At';
  $('toPick').hidden = $('toArrow').hidden = m !== 'move';
  $('modeHint').textContent = m === 'move' && locations.length < 2 ? 'Add a second location first: Inventory → Locations.' : HINTS[m];
  fixMoveTarget();
  s.focus();
}
for (const b of document.querySelectorAll('.segmented.big [data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));

const getQty = () => Math.max(1, Math.min(MAX_QTY, intOf($('qty').value) || 1));
function setQty(n) {
  n = Math.max(1, Math.min(MAX_QTY, n || 1));
  $('qty').value = String(n);
  $('qtyBadge').hidden = n === 1;
  $('qtyBadge').textContent = `×${nf.format(n)}`;
}
$('qtyDown').addEventListener('click', () => { setQty(getQty() - 1); if (mode) $('scan').focus(); });
$('qtyUp').addEventListener('click', () => { setQty(getQty() + 1); if (mode) $('scan').focus(); });
$('qty').addEventListener('input', () => { const n = intOf($('qty').value); $('qtyBadge').hidden = n <= 1; $('qtyBadge').textContent = `×${nf.format(Math.min(n, MAX_QTY))}`; });
$('qty').addEventListener('blur', () => setQty(getQty()));
$('qty').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); setQty(getQty()); if (mode) $('scan').focus(); } });

// ── Reason / note: stays filled between scans (one job often needs several items).
let recentReasons = store.get('reasons', []).filter(x => typeof x === 'string').slice(0, 12);
function renderReasonList() { $('reasonList').replaceChildren(...recentReasons.map(r => el('option', { value: r }))); }
function rememberReason(r) {
  if (!r) return;
  recentReasons = [r, ...recentReasons.filter(x => x !== r)].slice(0, 12);
  store.set('reasons', recentReasons);
  renderReasonList();
}
function syncReasonUi() {
  const v = $('reason').value.trim();
  $('clearReason').hidden = !v;
  $('reasonChips').querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', String(c.textContent === v)));
}
$('reason').addEventListener('input', syncReasonUi);
$('reason').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('scan').focus(); } });
$('clearReason').addEventListener('click', () => { $('reason').value = ''; syncReasonUi(); $('scan').focus(); });
$('reasonChips').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  $('reason').value = c.getAttribute('aria-pressed') === 'true' ? '' : c.textContent;
  syncReasonUi(); $('scan').focus();
});
renderReasonList();

function showResult({ kind, title, sub, balance, balanceLabel = 'on hand', action, qty = 1, note }) {
  const r = $('result');
  r.hidden = false;
  r.className = `result ${kind}`;
  const badge = kind === 'in' ? `+${qty}` : kind === 'out' ? `−${qty}` : kind === 'move' ? `⇄${qty}` : '!';
  r.replaceChildren(
    el('div', { class: `badge-icon${badge.length > 3 ? ' long' : ''}`, 'aria-hidden': 'true', text: badge }),
    el('div', {}, el('div', { class: 'r-title', text: title }), el('div', { class: 'r-sub', text: sub }), note ? el('div', { class: 'r-note', text: `${kind === 'move' ? 'Note' : 'Reason'}: ${note}` }) : null),
    balance !== undefined
      ? el('div', { class: 'r-bal' }, el('b', { text: nf.format(balance) }), el('span', { text: balanceLabel }))
      : (action || el('span')),
  );
  r.style.animation = 'none'; void r.offsetWidth; r.style.animation = '';
}

function renderFeed() {
  const feed = $('feed');
  feed.replaceChildren();
  if (!session.length) { feed.append(el('li', { class: 'feed-empty', text: 'Scanned items will appear here.' })); $('sessionCount').textContent = 'No scans yet'; return; }
  const sum = d => session.filter(s => s.direction === d).reduce((a, s) => a + s.quantity, 0);
  const moves = sum('transfer');
  $('sessionCount').textContent = `${session.length} scan${session.length === 1 ? '' : 's'} · ${nf.format(sum('in'))} in · ${nf.format(sum('out'))} out${moves ? ` · ${nf.format(moves)} moved` : ''}`;
  for (const m of session.slice(0, 25)) {
    const t = m.direction === 'transfer';
    feed.append(el('li', {},
      el('span', { class: `dir ${t ? 'move' : m.direction}`, text: (t ? '⇄' : m.direction === 'in' ? '+' : '−') + (m.quantity > 1 || t ? m.quantity : '') }),
      el('span', {}, el('span', { class: 'strong', text: m.item_name }), el('span', { class: 'code', text: m.barcode }), m.note ? el('span', { class: 'note', text: m.note }) : null),
      el('span', { class: 'bal', text: t ? `${m.location_name} → ${m.to_location_name}` : `${nf.format(m.location_balance)} at ${m.location_name}` }),
      el('span', { class: 't', text: timeFmt.format(new Date(m.created_at)) }),
    ));
  }
}

function afterMovement(m) {
  session.unshift(m);
  renderFeed();
  beep(true);
  inventoryDirty = true;
  if (m.note) rememberReason(m.note);
}
async function recordScan(barcode, direction, quantity, location_id, note = null) {
  const { movement: m } = await post('/api/scan', { barcode, direction, quantity, note, location_id, requestId: crypto.randomUUID() });
  afterMovement(m);
  showResult({ kind: direction, title: m.item_name, sub: `${direction === 'in' ? 'Stock in' : 'Stock out'} · ${m.location_name} · ${m.barcode}`, balance: m.location_balance, balanceLabel: `at ${m.location_name}`, qty: m.quantity, note: m.note });
  return m;
}
async function recordMove(barcode, quantity, from, to, note = null) {
  const { movement: m } = await post('/api/transfer', { barcode, quantity, from, to, note, requestId: crypto.randomUUID() });
  afterMovement(m);
  showResult({ kind: 'move', title: m.item_name, sub: `${m.location_name} → ${m.to_location_name} · ${m.barcode}`, balance: m.to_location_balance, balanceLabel: `now at ${m.to_location_name}`, qty: m.quantity, note: m.note });
  return m;
}

$('scan').addEventListener('keydown', async e => {
  if (e.key === 'Escape') { $('scan').value = ''; return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (!mode || busy) return;
  const barcode = $('scan').value.trim();
  if (!barcode) return;
  busy = true;
  const direction = mode, quantity = getQty(), loc = Number($('loc').value), note = $('reason').value.trim() || null;
  try {
    if (direction === 'move') {
      if (locations.length < 2) throw Object.assign(new Error('Add a second location first: Inventory → Locations.'), { status: 400 });
      await recordMove(barcode, quantity, loc, Number($('toLoc').value), note);
    } else {
      await recordScan(barcode, direction, quantity, loc, direction === 'out' ? note : null);
    }
    setQty(1);
  } catch (err) {
    beep(false);
    if (err.status === 404 && direction === 'in') {
      const btn = el('button', { class: 'btn primary', type: 'button', text: `Register & add ${quantity}` });
      btn.addEventListener('click', () => openRegister({ barcode: err.data?.barcode || barcode, pending: { quantity, location_id: loc } }));
      showResult({ kind: 'error', title: 'Unknown barcode', sub: `${barcode} isn’t registered yet`, action: btn });
    } else if (err.status === 404) {
      const btn = el('button', { class: 'btn', type: 'button', text: 'Register' });
      btn.addEventListener('click', () => openRegister({ barcode: err.data?.barcode || barcode }));
      showResult({ kind: 'error', title: 'Unknown barcode', sub: `${barcode} isn’t registered yet`, action: btn });
    } else if (err.status === 409 && direction !== 'in') {
      showResult({ kind: 'error', title: direction === 'move' ? 'Can’t move that many' : 'Not enough stock here', sub: `${barcode} · ${err.message}` });
    } else {
      showResult({ kind: 'error', title: 'Not recorded', sub: err.message });
    }
  } finally {
    $('scan').value = '';
    busy = false;
    if (!anyDialogOpen()) $('scan').focus();
  }
});

renderFeed();

// ───────────────────────── Inventory ─────────────────────────
let allItems = [], inventoryDirty = true, invFilter = 'all';
const collapsed = new Set(store.get('collapsed', []));
const expanded = new Set();

async function loadInventory(force = false) {
  if (inventoryDirty || force) {
    const [{ items }] = await Promise.all([api('/api/items?q='), loadLocations()]);
    allItems = items;
    inventoryDirty = false;
  }
  renderInventory();
}

const stockAt = (i, loc) => i.stock?.find(s => s.location_id === Number(loc))?.quantity ?? 0;
const isLow = i => i.min_qty !== null && i.min_qty !== undefined && i.quantity < i.min_qty;
const matches = (i, q) => !q || i.name.toLowerCase().includes(q) || i.barcode.toLowerCase().includes(q) || (i.category || '').toLowerCase().includes(q);
const groupKey = i => i.name.trim().toLowerCase();
const latest = list => list.map(i => i.last_moved).filter(Boolean).sort().pop() || null;

function qtyCell(n, low) {
  if (!n) return el('span', { class: 'right' }, el('span', { class: 'qty zero', text: 'Out' }));
  return el('span', { class: 'right' }, low ? el('span', { class: 'low-tag', text: 'Low' }) : null, el('span', { class: `qty${low ? ' low' : ''}`, text: nf.format(n) }));
}
function itemRow(i, { child = false, loc = '' } = {}) {
  const qty = loc ? stockAt(i, loc) : i.quantity;
  const places = (i.stock || []).length;
  const meta = child ? [lastMoved(i.last_moved)] : [el('span', { class: 'bc', text: i.barcode }), ` · ${lastMoved(i.last_moved)}`, !loc && places > 1 ? ` · ${places} locations` : ''];
  return el('div', { class: 'row', tabindex: '0', role: 'button', 'data-id': String(i.id), 'aria-label': `${i.name}, ${i.barcode}, ${qty} on hand` },
    el('div', {}, el('div', { class: 'title', text: child ? i.barcode : i.name }), el('div', { class: 'meta' }, ...meta)),
    qtyCell(qty, !loc && isLow(i)), el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }));
}

function renderList(items, loc, flashId, q) {
  const groups = new Map();
  for (const i of items) { const k = groupKey(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
  const list = el('ul', { class: 'list' });
  for (const [k, members] of groups) {
    if (members.length === 1) {
      const li = el('li', {}, itemRow(members[0], { loc }));
      if (members[0].id === flashId) li.classList.add('flash');
      list.append(li);
      continue;
    }
    // Same name = same product (e.g. several APs registered by serial): show once, expand for serials.
    const open = expanded.has(k) || (q && members.some(i => i.barcode.toLowerCase().includes(q))) || members.some(i => i.id === flashId);
    const total = members.reduce((a, i) => a + (loc ? stockAt(i, loc) : i.quantity), 0);
    const mins = members.map(i => i.min_qty).filter(v => v !== null && v !== undefined);
    const low = !loc && mins.length > 0 && total < Math.max(...mins);
    const head = el('div', { class: 'row group', tabindex: '0', role: 'button', 'aria-expanded': String(!!open), 'data-group': k },
      el('div', {}, el('div', { class: 'title', text: members[0].name }), el('div', { class: 'meta', text: `${members.length} serials · ${lastMoved(latest(members))}` })),
      qtyCell(total, low), el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }));
    const li = el('li', {}, head);
    if (open) {
      const kids = el('ul', { class: 'children' });
      for (const i of members) { const c = el('li', {}, itemRow(i, { child: true, loc })); if (i.id === flashId) c.classList.add('flash'); kids.append(c); }
      li.append(kids);
    }
    list.append(li);
  }
  return list;
}

function renderInventory(flashId) {
  const units = allItems.reduce((a, i) => a + i.quantity, 0);
  const zero = allItems.filter(i => i.quantity === 0).length, low = allItems.filter(isLow).length;
  $('invSummary').textContent = allItems.length
    ? `${nf.format(allItems.length)} item${allItems.length === 1 ? '' : 's'} · ${nf.format(units)} unit${units === 1 ? '' : 's'} on hand${locations.length > 1 ? ` · ${locations.length} locations` : ''}`
    : 'Nothing registered yet';
  $('zeroCount').textContent = zero ? String(zero) : '';
  $('lowCount').textContent = low ? String(low) : '';
  $('invLoc').hidden = locations.length < 2;

  const q = $('search').value.trim().toLowerCase();
  const loc = $('invLoc').value;
  const visible = allItems.filter(i => matches(i, q)
    && (invFilter === 'all' || (invFilter === 'zero' ? i.quantity === 0 : isLow(i)))
    && (!loc || stockAt(i, loc) > 0 || invFilter === 'zero'));

  const root = $('items');
  root.replaceChildren();
  if (!visible.length) {
    root.append(el('div', { class: 'list' }, el('div', { class: 'empty-state', text: !allItems.length ? 'Scan a barcode above or press Register to add your first item.'
      : q ? `Nothing matches “${$('search').value.trim()}”. Press Enter to register it.`
      : invFilter === 'low' ? 'Nothing is below its minimum level.' : invFilter === 'zero' ? 'Nothing is out of stock.' : `Nothing stored at ${locName(loc)}.` })));
    return;
  }
  // Sections by category, only once at least one item has a category.
  const useSections = allItems.some(i => i.category);
  if (!useSections) { root.append(renderList(visible, loc, flashId, q)); return; }
  const bySection = new Map();
  for (const i of visible) { const c = i.category || 'Uncategorised'; if (!bySection.has(c)) bySection.set(c, []); bySection.get(c).push(i); }
  const names = [...bySection.keys()].sort((a, b) => a === 'Uncategorised' ? 1 : b === 'Uncategorised' ? -1 : a.localeCompare(b, 'en', { sensitivity: 'base' }));
  for (const name of names) {
    const items = bySection.get(name);
    const units = items.reduce((a, i) => a + (loc ? stockAt(i, loc) : i.quantity), 0);
    const isCollapsed = collapsed.has(name) && !q;
    const sec = el('section', { class: 'section', 'data-collapsed': String(isCollapsed), 'data-section': name },
      el('div', { class: 'section-head', role: 'button', tabindex: '0', 'aria-expanded': String(!isCollapsed) },
        el('span', { class: 'tw', 'aria-hidden': 'true', text: '▾' }), el('h3', { text: name }),
        el('span', { class: 'muted', text: `${items.length} item${items.length === 1 ? '' : 's'} · ${nf.format(units)} units` })),
      renderList(items, loc, flashId, q));
    root.append(sec);
  }
}

function toggleSection(head) {
  const name = head.parentElement.dataset.section;
  collapsed.has(name) ? collapsed.delete(name) : collapsed.add(name);
  store.set('collapsed', [...collapsed]);
  renderInventory();
}
function activateRow(row) {
  if (row.dataset.group !== undefined) {
    const k = row.dataset.group;
    expanded.has(k) ? expanded.delete(k) : expanded.add(k);
    renderInventory();
    $('items').querySelector(`[data-group="${CSS.escape(k)}"]`)?.focus();
  } else openItem(allItems.find(i => i.id === Number(row.dataset.id)));
}
$('items').addEventListener('click', e => {
  const h = e.target.closest('.section-head'); if (h) return toggleSection(h);
  const r = e.target.closest('.row'); if (r) activateRow(r);
});
$('items').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const h = e.target.closest('.section-head'); if (h) { e.preventDefault(); return toggleSection(h); }
  const r = e.target.closest('.row'); if (r) { e.preventDefault(); activateRow(r); }
});

let debounce;
$('search').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => renderInventory(), 100); });
// Scanning into the inventory box opens the item straight away, or offers to register it.
$('search').addEventListener('keydown', async e => {
  if (e.key === 'Escape') { $('search').value = ''; renderInventory(); return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const v = $('search').value.trim();
  if (!v) return;
  if (inventoryDirty) await loadInventory();
  const exact = allItems.find(i => i.barcode === v) || allItems.find(i => i.barcode.toLowerCase() === v.toLowerCase());
  const hits = allItems.filter(i => matches(i, v.toLowerCase()));
  const target = exact || (hits.length === 1 ? hits[0] : null);
  if (target) { $('search').value = ''; renderInventory(); openItem(target); beep(true); }
  else if (!hits.length) { beep(false); openRegister({ barcode: v }); $('search').value = ''; renderInventory(); }
});
document.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => {
  invFilter = b.dataset.filter; setRadio(b.parentElement, 'data-filter', invFilter); renderInventory();
}));
$('invLoc').addEventListener('change', () => renderInventory());

// ───────────────────────── Register dialog ─────────────────────────
let pendingScan = null, generated = false;
function openRegister({ barcode = '', pending = null } = {}) {
  pendingScan = pending;
  generated = false;
  $('addForm').reset();
  $('addStatus').textContent = '';
  $('barcode').value = barcode;
  $('addQty').value = '0';
  $('addLoc').value = String(pending?.location_id ?? $('loc').value ?? '');
  $('addQtyField').hidden = !!pending;
  $('saveAdd').textContent = pending ? `Register & add ${pending.quantity}` : 'Register';
  $('addDialog').showModal();
  // Barcode first: a scanner fired straight away lands in the right field.
  (barcode ? $('name') : $('barcode')).focus();
}
// Readable, unambiguous codes for things without a barcode (no 0/O, 1/I/L).
function newCode() {
  const A = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  for (;;) {
    const r = crypto.getRandomValues(new Uint8Array(6));
    const code = 'SR-' + [...r].map(b => A[b % A.length]).join('');
    if (!allItems.some(i => i.barcode === code)) return code;
  }
}
$('genCode').addEventListener('click', () => { $('barcode').value = newCode(); generated = true; $('name').focus(); });
$('barcode').addEventListener('input', () => { generated = false; });
$('showAdd').addEventListener('click', () => openRegister());
$('cancelAdd').addEventListener('click', () => $('addDialog').close());
// A scanner sends Enter after the barcode: move on to the name instead of submitting.
$('barcode').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('name').focus(); } });
$('addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const barcode = $('barcode').value.trim(), name = $('name').value.trim(), opening = intOf($('addQty').value);
  if (!barcode) { $('addStatus').textContent = 'Scan or type the barcode, or press Generate.'; $('barcode').focus(); return; }
  if (!name) { $('addStatus').textContent = 'Give the item a name.'; $('name').focus(); return; }
  $('saveAdd').disabled = true;
  try {
    const { item } = await post('/api/items', { name, barcode, category: $('addCat').value.trim() || null, min_qty: optInt($('addMin').value) });
    let msg = `Registered ${item.name}`;
    if (pendingScan) {
      const m = await recordScan(item.barcode, 'in', pendingScan.quantity, pendingScan.location_id);
      setQty(1);
      msg += ` · +${m.quantity} in`;
    } else if (opening > 0) {
      const loc = Number($('addLoc').value);
      await post(`/api/items/${item.id}/count`, { count: opening, location_id: loc, requestId: crypto.randomUUID(), note: 'Opening count at registration' });
      msg += ` · ${nf.format(opening)} at ${locName(loc)}`;
    }
    const wasGenerated = generated;
    $('addDialog').close();
    toast(msg);
    inventoryDirty = true;
    if (view === 'inventory') { await loadInventory(); renderInventory(item.id); }
    if (wasGenerated) openLabel(item);
  } catch (err) {
    $('addStatus').textContent = err.message;
  } finally {
    $('saveAdd').disabled = false;
  }
});

// ───────────────────────── Item sheet ─────────────────────────
let current = null, countRequestId = null, deleteArmed = false, deleteTimer;

function renderWhere() {
  const list = $('itemWhere');
  list.replaceChildren();
  const rows = [...(current.stock || [])].sort((a, b) => b.quantity - a.quantity);
  if (!rows.length) { list.append(el('li', { text: 'None in stock' })); return; }
  for (const s of rows) list.append(el('li', {}, locName(s.location_id), el('b', { text: nf.format(s.quantity) })));
  if (rows.length > 1) list.append(el('li', { class: 'total' }, 'Total', el('b', { text: nf.format(current.quantity) })));
  if (current.min_qty !== null && current.min_qty !== undefined) list.append(el('li', { class: 'total' }, isLow(current) ? '⚠ Below minimum ' : 'Minimum ', el('b', { text: nf.format(current.min_qty) })));
}
function setCountBaseline() {
  $('itemCount').value = String(stockAt(current, $('countLoc').value));
  countRequestId = crypto.randomUUID();
  updateCountHint();
}
function updateCountHint() {
  if (!current) return;
  const here = stockAt(current, $('countLoc').value), count = intOf($('itemCount').value), diff = count - here;
  const hint = $('countHint');
  hint.replaceChildren();
  if ($('itemCount').value === '') hint.textContent = 'Type the number you counted.';
  else if (!diff) hint.textContent = `Matches the system (${nf.format(here)} at ${locName($('countLoc').value)}).`;
  else hint.append(`Was ${nf.format(here)} · records `, el('b', { class: diff > 0 ? 'pos' : 'neg', text: signed(diff) }), ' as a stock-take adjustment');
  $('noteField').hidden = !diff;
}
$('itemCount').addEventListener('input', updateCountHint);
$('countLoc').addEventListener('change', setCountBaseline);

function movementLine(m) {
  const by = m.actor ? ` · ${m.actor.replace(/@.*/, '')}` : '';
  if (m.direction === 'transfer') return [`Moved ${m.location_name} → ${m.to_location_name}`, `${m.note ? m.note + ' · ' : ''}${lastMoved(m.created_at)}${by}`];
  const what = m.reason === 'adjustment' ? 'Count adjusted' : m.direction === 'in' ? 'Stock in' : 'Stock out';
  return [`${what} · ${m.location_name}`, `${m.note ? m.note + ' · ' : ''}${lastMoved(m.created_at)}${by}`];
}

async function loadItemFeed(item) {
  const feed = $('itemFeed');
  feed.replaceChildren(el('li', { class: 'feed-empty', text: 'Loading…' }));
  try {
    const { movements } = await api(`/api/items/${item.id}/movements`);
    if (current?.id !== item.id) return;
    feed.replaceChildren();
    if (!movements.length) feed.append(el('li', { class: 'feed-empty', text: 'No movements yet.' }));
    for (const m of movements) {
      const t = m.direction === 'transfer';
      const [line, sub] = movementLine(m);
      feed.append(el('li', {},
        el('span', { class: `dir ${t ? 'move' : m.direction}`, text: (t ? '⇄' : m.direction === 'in' ? '+' : '−') + m.quantity }),
        el('span', {}, line, el('span', { class: 'sub', text: sub })),
        el('span', { class: 't', text: t ? '' : `→ ${nf.format(m.location_balance)}` }),
      ));
    }
  } catch (err) { feed.replaceChildren(el('li', { class: 'feed-empty', text: err.message })); }
}

function fillItemSheet(item) {
  current = item;
  $('itemTitle').textContent = item.name;
  $('itemCode').textContent = item.barcode;
  $('itemCat').hidden = !item.category;
  $('itemCat').textContent = item.category || '';
  renderWhere();
  const best = [...(item.stock || [])].sort((a, b) => b.quantity - a.quantity)[0]?.location_id;
  $('countLoc').value = String(item.stock?.some(s => s.location_id === Number($('loc').value)) || !best ? $('loc').value : best);
  setCountBaseline();
  $('moveFrom').value = String(best ?? $('loc').value);
  const other = locations.find(l => String(l.id) !== $('moveFrom').value);
  if (other) $('moveTo').value = String(other.id);
  $('moveQty').value = '1';
  $('moveDetails').hidden = locations.length < 2;
}

async function openItem(item) {
  if (!item) return;
  if (!locations.length) await loadLocations();
  deleteArmed = false;
  fillItemSheet(item);
  $('itemNote').value = '';
  $('itemName').value = item.name;
  $('itemBarcode').value = item.barcode;
  $('itemCatInput').value = item.category || '';
  $('itemMin').value = item.min_qty ?? '';
  $('editDetails').open = false;
  $('moveDetails').open = false;
  $('itemStatus').textContent = '';
  $('deleteItem').hidden = !!item.last_moved;
  $('deleteItem').textContent = 'Delete';
  $('itemDialog').showModal();
  $('itemCount').focus();
  loadItemFeed(item);
}

$('closeItem').addEventListener('click', () => $('itemDialog').close());
$('cancelItem').addEventListener('click', () => $('itemDialog').close());
$('itemDialog').addEventListener('close', () => { current = null; });
$('labelItem').addEventListener('click', () => { if (current) openLabel(current); });

$('doMove').addEventListener('click', async () => {
  if (!current) return;
  const from = Number($('moveFrom').value), to = Number($('moveTo').value), qty = Math.max(1, intOf($('moveQty').value));
  if (from === to) { $('itemStatus').textContent = 'Choose two different locations.'; return; }
  $('doMove').disabled = true;
  try {
    const m = await recordMove(current.barcode, qty, from, to, $('itemNote').value.trim() || null);
    const { item } = await api(`/api/items/${current.id}`);
    fillItemSheet(item);
    loadItemFeed(item);
    $('itemStatus').textContent = '';
    toast(`Moved ${m.quantity} to ${m.to_location_name}`);
    inventoryDirty = true;
  } catch (err) { $('itemStatus').textContent = err.message; }
  finally { $('doMove').disabled = false; }
});

$('itemForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!current) return;
  const item = current;
  const name = $('itemName').value.trim(), barcode = $('itemBarcode').value.trim();
  const category = $('itemCatInput').value.trim() || null, min_qty = optInt($('itemMin').value);
  const countRaw = $('itemCount').value.trim(), count = intOf(countRaw), loc = Number($('countLoc').value);
  if (!name || !barcode) { $('itemStatus').textContent = 'Name and barcode can’t be empty.'; $('editDetails').open = true; return; }
  if (countRaw === '') { $('itemStatus').textContent = 'Enter the counted quantity.'; $('itemCount').focus(); return; }
  const changes = [];
  $('saveItem').disabled = true;
  try {
    if (name !== item.name || barcode !== item.barcode || category !== (item.category || null) || min_qty !== (item.min_qty ?? null)) {
      await post(`/api/items/${item.id}`, { name, barcode, category, min_qty }, 'PATCH');
      changes.push('details updated');
    }
    if (count !== stockAt(item, loc)) {
      const r = await post(`/api/items/${item.id}/count`, { count, location_id: loc, requestId: countRequestId, note: $('itemNote').value.trim() || null });
      changes.push(`${nf.format(count)} at ${locName(loc)} (${signed(r.movement ? (r.movement.direction === 'in' ? r.movement.quantity : -r.movement.quantity) : 0)})`);
    }
    $('itemDialog').close();
    toast(changes.length ? `${name}: ${changes.join(', ')}` : 'No changes');
    if (changes.length) { inventoryDirty = true; if (view === 'inventory') { await loadInventory(); renderInventory(item.id); } }
  } catch (err) {
    $('itemStatus').textContent = err.message;
    if (err.status === 409 && /changed while/.test(err.message)) {
      // Someone scanned this item meanwhile: refresh the baseline, keep the typed count.
      const typed = $('itemCount').value;
      const { item: fresh } = await api(`/api/items/${item.id}`);
      fillItemSheet(fresh); $('itemCount').value = typed; updateCountHint();
    }
  } finally {
    $('saveItem').disabled = false;
  }
});

$('deleteItem').addEventListener('click', async () => {
  if (!current) return;
  if (!deleteArmed) {
    deleteArmed = true; $('deleteItem').textContent = 'Tap again to delete';
    clearTimeout(deleteTimer); deleteTimer = setTimeout(() => { deleteArmed = false; $('deleteItem').textContent = 'Delete'; }, 3000);
    return;
  }
  const item = current;
  try {
    await api(`/api/items/${item.id}`, { method: 'DELETE' });
    $('itemDialog').close();
    toast(`Deleted ${item.name}`);
    inventoryDirty = true; await loadInventory();
  } catch (err) { $('itemStatus').textContent = err.message; }
});

// ───────────────────────── Labels ─────────────────────────
const LABEL_SIZES = { '62x29': [62, 29], '50x25': [50, 25], '57x32': [57, 32], '102x51': [102, 51], a4: [70, 37.125] };
const DOT = 0.125; // mm: one dot on a 203 dpi thermal printer
let labelItem = null;

function buildLabel(item, size) {
  const [w, h] = LABEL_SIZES[size];
  const pad = 2.5, usable = w - 2 * pad;
  const modules = code128Modules(item.barcode).length + 20; // + quiet zones
  // Whole printer dots per bar keeps bars crisp; aim for 2 dots (0.25 mm) or more.
  // If that would drop below 2 dots, use the full label width instead: thicker bars beat crisp-but-thin ones.
  const snapped = Math.floor(usable / modules / DOT) * DOT;
  const mw = snapped >= 0.25 ? snapped : usable / modules;
  const label = el('div', { class: 'label' });
  label.style.width = `${w}mm`; label.style.height = `${h}mm`;
  const name = el('div', { class: 'l-name', text: item.name });
  name.style.fontSize = `${Math.min(4.2, h * 0.11)}mm`;
  const bars = el('div', { class: 'l-bars' });
  bars.innerHTML = code128Svg(item.barcode, { height: 40 });
  const svg = bars.firstElementChild;
  svg.style.width = `${Math.min(usable, modules * mw)}mm`; svg.style.margin = '0 auto';
  const code = el('div', { class: 'l-code', text: item.barcode });
  code.style.fontSize = `${Math.min(3.4, h * 0.085)}mm`;
  label.append(name, bars, code);
  return { label, tight: mw < 0.25 };  // below ~2 printer dots per bar, some scanners struggle
}
function renderLabelPreview() {
  if (!labelItem) return;
  try {
    const { label, tight } = buildLabel(labelItem, $('labelSize').value);
    $('labelPreview').replaceWith(Object.assign(label, { id: 'labelPreview' }));
    $('labelStatus').textContent = tight ? 'This barcode is long for this label width. If it doesn’t scan, use a wider label.' : '';
    $('doPrintLabel').disabled = false;
  } catch (err) { $('labelStatus').textContent = err.message; $('doPrintLabel').disabled = true; }
}
function openLabel(item) {
  labelItem = item;
  $('labelSize').value = store.get('labelSize', '62x29');
  $('labelCopies').value = '1';
  renderLabelPreview();
  $('labelDialog').showModal();
}
$('labelSize').addEventListener('change', () => { store.set('labelSize', $('labelSize').value); renderLabelPreview(); });
$('closeLabel').addEventListener('click', () => $('labelDialog').close());
$('labelForm').addEventListener('submit', e => {
  e.preventDefault();
  if (!labelItem) return;
  const size = $('labelSize').value, copies = Math.max(1, Math.min(240, intOf($('labelCopies').value) || 1));
  const sheet = $('labelSheet');
  sheet.replaceChildren();
  sheet.className = size === 'a4' ? 'a4' : '';
  for (let i = 0; i < copies; i++) sheet.append(buildLabel(labelItem, size).label);
  const [w, h] = LABEL_SIZES[size];
  $('labelPageStyle').textContent = size === 'a4'
    ? '@page { size: A4; margin: 0; }'
    : `@page { size: ${w}mm ${h}mm; margin: 0; }`;
  document.body.classList.add('printing-labels');
  const done = () => { document.body.classList.remove('printing-labels'); sheet.replaceChildren(); $('labelPageStyle').textContent = ''; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
});

// ───────────────────────── Reports ─────────────────────────
const report = { start: mondayOf(today()), end: addDays(mondayOf(today()), 6), summaryRows: 'moved', logOpen: false, data: null };
const LOG_PREVIEW = 15;

function presetFor(start, end) {
  const thisMon = mondayOf(today());
  if (start === thisMon && end === addDays(thisMon, 6)) return 'this';
  if (start === addDays(thisMon, -7) && end === addDays(thisMon, -1)) return 'last';
  return 'custom';
}
const isWholeWeek = (s, e) => s === mondayOf(s) && e === addDays(s, 6);

function describePeriod() {
  const { start, end } = report;
  const preset = presetFor(start, end);
  const wk = isoWeek(start);
  const title = preset === 'this' ? 'This week' : preset === 'last' ? 'Last week'
    : isWholeWeek(start, end) ? `Week ${wk.week}, ${wk.year}` : 'Custom range';
  const range = start === end ? longDay.format(utc(start)) : `${shortDay.format(utc(start))} – ${longDay.format(utc(end))}`;
  const label = isWholeWeek(start, end) ? `Week ${wk.week} · ${range}` : range;
  return { preset, title, label, wk };
}

function syncPeriodControls() {
  const { preset, title, label } = describePeriod();
  $('rTitle').textContent = title;
  $('rSub').textContent = `${label} · Malta time`;
  setRadio(document.querySelector('.period'), 'data-preset', $('custom').hidden ? preset : 'custom');
  $('start').value = report.start; $('end').value = report.end;
  $('nextWeek').disabled = report.start >= mondayOf(today());
}

async function loadReport() {
  syncPeriodControls();
  const qs = new URLSearchParams({ start: report.start, end: report.end });
  const [summary, hist] = await Promise.all([api('/api/summary?' + qs), api('/api/history?' + qs)]);
  report.data = { summary: summary.items, stock: summary.stock, locations: summary.locations, movements: hist.movements, totals: hist.totals, start: report.start, end: report.end };
  renderReport();
}

const belowMin = items => items.filter(r => r.min_qty !== null && r.on_hand < r.min_qty).sort((a, b) => (b.min_qty - b.on_hand) - (a.min_qty - a.on_hand));
function byCategory(items) {
  const m = new Map();
  for (const r of items) {
    const k = r.category || 'Uncategorised';
    const c = m.get(k) || { name: k, moved: 0, in: 0, out: 0, closing: 0 };
    c.moved += (r.received || r.issued) ? 1 : 0; c.in += r.received; c.out += r.issued; c.closing += r.closing;
    m.set(k, c);
  }
  return [...m.values()].sort((a, b) => a.name === 'Uncategorised' ? 1 : b.name === 'Uncategorised' ? -1 : a.name.localeCompare(b.name));
}
function typePill(m) {
  if (m.direction === 'transfer') return el('span', { class: 'pill adj', text: 'Move' });
  if (m.reason === 'adjustment') return el('span', { class: 'pill adj', text: 'Count adj.', title: m.note || 'Stock-take count adjustment' });
  return el('span', { class: `pill ${m.direction}`, text: m.direction === 'in' ? 'In' : 'Out' });
}
const whereText = m => m.direction === 'transfer' ? `${m.location_name} → ${m.to_location_name}` : m.location_name;

function renderReport() {
  const { summary, movements, totals } = report.data;
  const moved = summary.filter(r => r.received || r.issued);
  const net = totals.received - totals.issued;
  const reorder = belowMin(summary);
  $('rIn').textContent = nf.format(totals.received);
  $('rOut').textContent = nf.format(totals.issued);
  $('rNet').textContent = signed(net);
  $('rNet').className = `stat-value ${net > 0 ? 'in' : net < 0 ? 'out' : ''}`;
  $('rLow').textContent = nf.format(reorder.length);
  $('rLow').className = `stat-value ${reorder.length ? 'warn' : ''}`;

  // Needs reordering
  $('reorderCard').hidden = !reorder.length;
  $('reorder').replaceChildren(...reorder.map(r => el('tr', {},
    td(r.name, 'strong'), td(r.category || '—', 'muted'), td(nf.format(r.min_qty), 'num'), td(nf.format(r.on_hand), `num ${r.on_hand ? '' : 'neg'}`), td(nf.format(r.min_qty - r.on_hand), 'num strong warn'))));

  // By category
  const cats = byCategory(summary);
  $('catCard').hidden = !summary.some(r => r.category);
  $('cats').replaceChildren(...cats.map(c => el('tr', {},
    td(c.name, 'strong'), td(nf.format(c.moved), 'num'), td(c.in ? nf.format(c.in) : '–', `num ${c.in ? 'pos' : 'zero'}`), td(c.out ? nf.format(c.out) : '–', `num ${c.out ? 'neg' : 'zero'}`),
    td(signed(c.in - c.out), `num ${signClass(c.in - c.out)}`), td(nf.format(c.closing), 'num strong'))));

  // By item
  const rows = report.summaryRows === 'all' ? summary : moved;
  const tb = $('summary'), tf = $('summaryFoot');
  tb.replaceChildren(); tf.replaceChildren();
  if (!rows.length) {
    tb.append(el('tr', { class: 'empty' }, el('td', { colspan: '7', text: report.summaryRows === 'all' ? 'No items registered.' : 'No stock moved in or out in this period.' })));
  } else {
    for (const r of rows) {
      const n = r.received - r.issued;
      tb.append(el('tr', {},
        td(r.name, 'strong'), td(r.barcode, 'code'),
        td(nf.format(r.opening), 'num'),
        td(r.received ? nf.format(r.received) : '–', `num ${r.received ? 'pos' : 'zero'}`),
        td(r.issued ? nf.format(r.issued) : '–', `num ${r.issued ? 'neg' : 'zero'}`),
        td(signed(n), `num ${signClass(n)}`),
        td(nf.format(r.closing), `num strong ${r.closing ? '' : 'neg'}`),
      ));
    }
    const sum = k => rows.reduce((a, r) => a + r[k], 0);
    const n = sum('received') - sum('issued');
    tf.append(el('tr', {},
      td('Total'), td(`${rows.length} item${rows.length === 1 ? '' : 's'}`, 'muted'),
      td(nf.format(sum('opening')), 'num'), td(nf.format(sum('received')), 'num pos'), td(nf.format(sum('issued')), 'num neg'),
      td(signed(n), `num ${signClass(n)}`), td(nf.format(sum('closing')), 'num'),
    ));
  }

  // Log
  $('logCount').textContent = `${nf.format(movements.length)} movement${movements.length === 1 ? '' : 's'}${totals.transferred ? ` · ${nf.format(totals.transferred)} units moved between locations` : ''}`;
  const hb = $('history');
  hb.replaceChildren();
  if (!movements.length) hb.append(el('tr', { class: 'empty' }, el('td', { colspan: '6', text: 'No movements in this period.' })));
  [...movements].reverse().forEach((m, i) => {
    const t = m.direction === 'transfer';
    const q = t ? m.quantity : m.direction === 'in' ? m.quantity : -m.quantity;
    hb.append(el('tr', { class: i >= LOG_PREVIEW && !report.logOpen ? 'more' : undefined },
      td(whenFmt.format(new Date(m.created_at))),
      el('td', { class: 'strong' }, m.item_name, m.note ? el('span', { class: 'log-note', text: m.note }) : null),
      td(whereText(m), 'muted'),
      el('td', {}, typePill(m)),
      td(t ? nf.format(q) : signed(q), `num ${t ? '' : signClass(q)}`),
      td(m.actor ? m.actor.replace(/@.*/, '') : '—', 'muted'),
    ));
  });
  const more = $('logMore');
  more.hidden = movements.length <= LOG_PREVIEW;
  more.textContent = report.logOpen ? 'Show fewer' : `Show all ${nf.format(movements.length)}`;
}
$('logMore').addEventListener('click', () => { report.logOpen = !report.logOpen; renderReport(); });

function setPeriod(start, end) { report.start = start; report.end = end; loadReport().catch(err => toast(err.message)); }

document.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
  const p = b.dataset.preset, mon = mondayOf(today());
  $('custom').hidden = p !== 'custom';
  if (p === 'this') setPeriod(mon, addDays(mon, 6));
  else if (p === 'last') setPeriod(addDays(mon, -7), addDays(mon, -1));
  else { syncPeriodControls(); $('start').focus(); }
}));
$('prevWeek').addEventListener('click', () => { $('custom').hidden = true; const s = mondayOf(report.start); setPeriod(addDays(s, -7), addDays(s, -1)); });
$('nextWeek').addEventListener('click', () => { $('custom').hidden = true; const s = addDays(mondayOf(report.start), 7); setPeriod(s, addDays(s, 6)); });
for (const id of ['start', 'end']) $(id).addEventListener('change', () => {
  const s = $('start').value, e = $('end').value;
  if (!s || !e) return;
  if (s > e) { toast('Start date must be on or before end date'); return; }
  setPeriod(s, e);
});
document.querySelectorAll('[data-sum]').forEach(b => b.addEventListener('click', () => {
  report.summaryRows = b.dataset.sum; setRadio(b.parentElement, 'data-sum', report.summaryRows);
  if (report.data) renderReport();
}));

$('print').addEventListener('click', () => window.print());
$('csv').addEventListener('click', () => { window.location.href = '/api/history.csv?' + new URLSearchParams({ start: report.start, end: report.end }); });
$('xlsx').addEventListener('click', async () => {
  const btn = $('xlsx');
  btn.disabled = true;
  try {
    if (!report.data || report.data.start !== report.start || report.data.end !== report.end) await loadReport();
    const blob = workbook(report.data);
    const { wk } = describePeriod();
    const name = isWholeWeek(report.start, report.end)
      ? `Stock-take_W${String(wk.week).padStart(2, '0')}-${wk.year}_${report.start}_to_${report.end}.xlsx`
      : `Stock-take_${report.start}_to_${report.end}.xlsx`;
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Report downloaded');
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

// ───────────────────────── Excel workbook ─────────────────────────
function workbook({ summary, stock, locations: locs, movements, totals, start, end }) {
  const { label } = describePeriod();
  const generated = clockFmt.format(new Date());
  const moved = summary.filter(r => r.received || r.issued);
  const outAtEnd = summary.filter(r => r.closing === 0).length;
  const adjustments = movements.filter(m => m.reason === 'adjustment').length;
  const reorder = belowMin(summary);
  const H = v => ({ v, s: S.header }), HN = v => ({ v, s: S.headerNum });
  const who = me.source === 'access' ? me.name : localName();

  // Sheet 1: Summary
  const s1 = [
    [{ v: `Enemalta Network Stock Take — ${isWholeWeek(start, end) ? 'Weekly ' : ''}Movement Report`, s: S.title }],
    [{ v: `${label} (Europe/Malta)`, s: S.subtitle }],
    [{ v: `Generated ${generated}${who ? ` by ${who}` : ''}`, s: S.subtitle }],
    [],
    [{ v: 'Units in', s: S.subtitle }, { v: totals.received, s: S.kpi }],
    [{ v: 'Units out', s: S.subtitle }, { v: totals.issued, s: S.kpi }],
    [{ v: 'Net change', s: S.subtitle }, { v: totals.received - totals.issued, s: S.kpiNet }],
    [{ v: 'Units moved between locations', s: S.subtitle }, { v: totals.transferred || 0, s: S.kpi }],
    [{ v: 'Items moved in/out', s: S.subtitle }, { v: moved.length, s: S.kpi }],
    [{ v: 'Count adjustments', s: S.subtitle }, { v: adjustments, s: S.kpi }],
    [{ v: 'Items below minimum (now)', s: S.subtitle }, { v: reorder.length, s: S.kpi }],
    [{ v: 'Items at zero (period end)', s: S.subtitle }, { v: outAtEnd, s: S.kpi }],
    [],
  ];
  if (summary.some(r => r.category)) {
    s1.push([{ v: 'By category', s: S.totalLabel }]);
    s1.push([H('Category'), HN('Items moved'), HN('In'), HN('Out'), HN('Net'), HN('Closing')]);
    for (const c of byCategory(summary)) s1.push([c.name, { v: c.moved, s: S.int }, { v: c.in, s: S.inInt }, { v: c.out, s: S.outInt }, { v: c.in - c.out, s: S.net }, { v: c.closing, s: S.int }]);
    s1.push([]);
  }
  s1.push([{ v: 'By item (moved in or out)', s: S.totalLabel }]);
  const head1 = s1.length;
  s1.push([H('Item'), H('Barcode'), HN('Opening'), HN('In'), HN('Out'), HN('Net'), HN('Closing'), H('Category')]);
  if (!moved.length) s1.push([{ v: 'No stock moved in or out in this period.', s: S.subtitle }]);
  for (const r of moved) s1.push([r.name, r.barcode, { v: r.opening, s: S.int }, { v: r.received, s: S.inInt }, { v: r.issued, s: S.outInt }, { v: r.received - r.issued, s: S.net }, { v: r.closing, s: S.int }, r.category || '']);
  if (moved.length) {
    const sum = k => moved.reduce((a, r) => a + r[k], 0);
    s1.push([{ v: 'Total', s: S.totalLabel }, { v: `${moved.length} items`, s: S.totalLabel }, { v: sum('opening'), s: S.totalInt }, { v: sum('received'), s: S.totalInt }, { v: sum('issued'), s: S.totalInt }, { v: sum('received') - sum('issued'), s: S.netBold }, { v: sum('closing'), s: S.totalInt }, { v: '', s: S.totalLabel }]);
  }

  // Sheet 2: Reorder
  const sR = [[H('Item'), H('Barcode'), H('Category'), HN('Minimum'), HN('On hand'), HN('Short by')]];
  if (!reorder.length) sR.push([{ v: 'Nothing is below its minimum level.', s: S.subtitle }]);
  for (const r of reorder) sR.push([r.name, r.barcode, r.category || '', { v: r.min_qty, s: S.int }, { v: r.on_hand, s: r.on_hand ? S.int : S.outInt }, { v: r.min_qty - r.on_hand, s: S.outInt }]);

  // Sheet 3: Movements (chronological)
  const s2 = [[H('Date'), H('Time'), H('Item'), H('Barcode'), H('Type'), HN('Qty'), H('Location'), H('To'), HN('At location after'), HN('Total after'), H('Reason / note'), H('By')]];
  for (const m of movements) {
    const [d, t] = stampFmt.format(new Date(m.created_at)).split(' ');
    const tr = m.direction === 'transfer';
    const type = tr ? 'Move' : m.reason === 'adjustment' ? 'Count adjustment' : m.direction === 'in' ? 'In' : 'Out';
    s2.push([d, t, m.item_name, m.barcode,
      { v: type, s: tr || m.reason === 'adjustment' ? S.subtitle : m.direction === 'in' ? S.greenText : S.redText },
      { v: tr ? m.quantity : m.direction === 'in' ? m.quantity : -m.quantity, s: tr ? S.int : S.net },
      m.location_name || '', tr ? m.to_location_name || '' : '',
      { v: m.location_balance, s: S.int }, { v: m.resulting_balance, s: S.int },
      m.note || '', m.actor || '']);
  }

  // Sheet 4: Stock position (now), one column per location
  const at = new Map();
  for (const s of stock) at.set(`${s.item_id}:${s.location_id}`, s.quantity);
  const s3 = [[H('Item'), H('Barcode'), H('Category'), ...locs.map(l => HN(l.name)), HN('Total now'), HN('Minimum'), H('Status')]];
  for (const r of summary) {
    const status = r.on_hand === 0 ? 'Out of stock' : r.min_qty !== null && r.on_hand < r.min_qty ? 'Below minimum' : 'OK';
    s3.push([r.name, r.barcode, r.category || '', ...locs.map(l => ({ v: at.get(`${r.id}:${l.id}`) || 0, s: S.int })), { v: r.on_hand, s: S.totalInt },
      r.min_qty === null ? '' : { v: r.min_qty, s: S.int }, { v: status, s: status === 'OK' ? S.greenText : S.redText }]);
  }
  const lastCol3 = 3 + locs.length + 2;

  return buildXlsx([
    { name: 'Summary', rows: s1, cols: [44, 22, 11, 9, 9, 9, 11, 16], freezeRow: 0, heights: { 0: 24 } },
    { name: 'Reorder', rows: sR, cols: [44, 22, 16, 11, 11, 11], freezeRow: 1, autoFilter: reorder.length ? `A1:${ref(5, reorder.length)}` : undefined },
    { name: 'Movements', rows: s2, cols: [12, 10, 40, 20, 16, 7, 16, 16, 16, 12, 34, 24], freezeRow: 1, autoFilter: movements.length ? `A1:${ref(11, movements.length)}` : undefined },
    { name: 'Stock by location', rows: s3, cols: [44, 22, 16, ...locs.map(() => 14), 12, 11, 15], freezeRow: 1, autoFilter: summary.length ? `A1:${ref(lastCol3, summary.length)}` : undefined },
  ], { title: `Stock take ${start} to ${end}`, author: 'Enemalta Stockroom' });
}

// ───────────────────────── Boot ─────────────────────────
setQty(1);
Promise.all([loadMe(), loadLocations()]).catch(err => toast(err.message)).finally(() => show(location.hash.slice(1) || 'scan'));
