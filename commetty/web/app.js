/* Commetty Book — keep a record of every commetty (chit / BC) installment.
   Data lives on your own server; the server backs it up every night. The last loaded data is
   cached by the service worker so the app still opens (read-only) without internet. */
'use strict';

const MODES = ['PhonePe', 'Google Pay', 'Paytm', 'UPI (other)', 'Cash', 'Bank transfer', 'Other'];

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const shotUrl = (id) => `api/shots/${id}`;

// ------------------------------------------------------------------ dates (stored as YYYY-MM-DD)
const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => toISO(new Date());
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDate = (s) => (s ? parseISO(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const fmtDateTime = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
function addMonths(iso, n) {
  const d = parseISO(iso);
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  t.setDate(Math.min(d.getDate(), new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()));
  return toISO(t);
}

// ------------------------------------------------------------------ server API
class LoginRequired extends Error {}

async function api(method, url, body) {
  const headers = { 'X-CB': '1' };
  if (body instanceof Blob) headers['Content-Type'] = body.type || 'application/octet-stream';
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(url, { method, headers, body, credentials: 'same-origin' });
  } catch {
    throw new Error('Internet / server se connect nahi ho paya');
  }
  if (res.headers.get('X-Offline')) S.offline = true;
  const data = (res.headers.get('Content-Type') || '').includes('json') ? await res.json() : null;
  if (res.status === 401 && url !== 'api/login') throw new LoginRequired();
  if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
  return data;
}

// ------------------------------------------------------------------ state
const S = { committees: [], deposits: [], server: {}, offline: false, loggedIn: false };

async function loadState() {
  S.offline = false;
  const d = await api('GET', 'api/data');
  d.committees.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
  Object.assign(S, { committees: d.committees, deposits: d.deposits, server: d.server || {}, loggedIn: true });
}

const committee = (id) => S.committees.find((c) => c.id === id);
const depositsOf = (id) => S.deposits.filter((d) => d.committeeId === id)
  .sort((a, b) => a.installmentNo - b.installmentNo || a.date.localeCompare(b.date));

function stats(c) {
  const deps = depositsOf(c.id);
  const paid = deps.reduce((s, d) => s + Number(d.amount || 0), 0);
  const lastNo = deps.reduce((m, d) => Math.max(m, d.installmentNo), 0);
  const last = deps.filter((d) => d.installmentNo === lastNo).sort((a, b) => b.date.localeCompare(a.date))[0] || null;
  const total = Number(c.months) || 0;
  const completed = total > 0 && lastNo >= total;
  const nextNo = lastNo + 1;
  const nextDue = c.startDate ? addMonths(c.startDate, nextNo - 1) : null;
  const daysLeft = nextDue ? daysBetween(todayISO(), nextDue) : null;
  return { deps, paid, lastNo, last, total, completed, nextNo, nextDue, daysLeft };
}

function dueLabel(st) {
  if (st.completed) return { text: 'All installments paid 🎉', cls: 'ok' };
  if (st.daysLeft == null) return { text: '', cls: '' };
  if (st.daysLeft < 0) return { text: `${-st.daysLeft} day${st.daysLeft === -1 ? '' : 's'} overdue`, cls: 'bad' };
  if (st.daysLeft === 0) return { text: 'Due today', cls: 'warn' };
  if (st.daysLeft <= 5) return { text: `Due in ${st.daysLeft} day${st.daysLeft === 1 ? '' : 's'}`, cls: 'warn' };
  return { text: `Due in ${st.daysLeft} days`, cls: 'ok' };
}

// Runs a write, then reloads data. Errors become a toast; an expired session shows the login screen.
async function save(fn, okMsg = 'Saved ✔') {
  if (S.offline) { toast('Offline hai — internet aane par save karein'); return false; }
  try {
    await fn();
    await loadState();
    if (okMsg) toast(okMsg);
    return true;
  } catch (err) {
    if (err instanceof LoginRequired) { viewLogin(); return false; }
    toast(err.message);
    return false;
  }
}

// ------------------------------------------------------------------ UI helpers
const app = $('#app');
let toastTimer;
function toast(msg, ms = 2800) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// Modal with buttons; resolves with the clicked button's value (or null when dismissed).
function ask(html, buttons) {
  const dlg = $('#dlg');
  dlg.innerHTML = `<div class="dlg-body">${html}</div><div class="dlg-actions">${buttons.map((b, i) =>
    `<button type="button" class="btn ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`;
  return new Promise((resolve) => {
    dlg.onclick = (e) => {
      const b = e.target.closest('[data-i]');
      if (b) { dlg.close(); resolve(buttons[b.dataset.i].value); } else if (e.target === dlg) { dlg.close(); resolve(null); }
    };
    dlg.oncancel = () => resolve(null);
    dlg.showModal();
  });
}
const confirmBox = (html, label, cls = '') => ask(html, [{ label: 'Cancel', cls: 'ghost', value: false }, { label, cls, value: true }]);

function viewImage(src) {
  const v = $('#viewer');
  v.querySelector('img').src = src;
  v.hidden = false;
}
$('#viewer').onclick = () => { $('#viewer').hidden = true; };

const ICON = {
  back: '<svg viewBox="0 0 24 24"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M3 17.2V21h3.8L17.8 9.9l-3.7-3.7zM20.7 7c.4-.4.4-1 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7z"/></svg>',
  backup: '<svg viewBox="0 0 24 24"><path d="M19.4 10A7.5 7.5 0 0 0 5.4 8 6 6 0 0 0 6 20h13a5 5 0 0 0 .4-10zM14 13v4h-4v-4H7l5-5 5 5z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M18 16a3 3 0 0 0-2 .8l-7.1-4.2a3 3 0 0 0 0-1.2L16 7.2A3 3 0 1 0 15 5v.6L7.9 9.8a3 3 0 1 0 0 4.4l7.1 4.2-.1.6a3 3 0 1 0 3-3z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/></svg>',
};

function bar(title, { back, actions = '' } = {}) {
  return `<header class="bar">
    ${back ? `<a class="icon-btn" href="${back}" aria-label="Back">${ICON.back}</a>` : '<span class="logo"><img src="icons/icon.svg" alt=""></span>'}
    <h1>${esc(title)}</h1>${actions}</header>
    ${S.offline ? '<div class="offline">📴 Offline — purana data dikh raha hai, abhi kuch save nahi hoga</div>' : ''}`;
}

// ------------------------------------------------------------------ router
window.addEventListener('hashchange', route);
// Navigate without leaving the form in history; re-render if we are already there.
function go(hash) {
  if (location.hash === hash) route(); else location.replace(hash);
}
function route() {
  if (!S.loggedIn) return viewLogin();
  const p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  window.scrollTo(0, 0);
  if (p[0] === 'new') return viewCommitteeForm(null);
  if (p[0] === 'backup') return viewBackup();
  if (p[0] === 'c' && committee(p[1])) {
    if (p[2] === 'edit') return viewCommitteeForm(committee(p[1]));
    if (p[2] === 'pay') return viewDepositForm(committee(p[1]), null);
    return viewCommittee(committee(p[1]), p[2] === 'history' ? 'history' : 'deposits');
  }
  if (p[0] === 'd') {
    const d = S.deposits.find((x) => x.id === p[1]);
    if (d) return viewDepositForm(committee(d.committeeId), d);
  }
  return viewHome();
}

// ------------------------------------------------------------------ login
function viewLogin() {
  S.loggedIn = false;
  app.innerHTML = `<main class="login">
    <img src="icons/icon.svg" alt="">
    <h1>Commetty Book</h1>
    <form class="card form" id="lform">
      <label>Password<input name="password" type="password" autocomplete="current-password" required autofocus></label>
      <button class="btn block" type="submit">Login</button>
      <p class="small muted" id="lerr" role="alert"></p>
    </form></main>`;
  $('#lform').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      await api('POST', 'api/login', { password: e.target.password.value });
      await loadState();
      route();
    } catch (err) {
      $('#lerr').textContent = err.message;
      btn.disabled = false;
    }
  };
}

// ------------------------------------------------------------------ home
function viewHome() {
  const totalPaid = S.deposits.reduce((s, d) => s + Number(d.amount || 0), 0);
  const cards = S.committees.map((c) => {
    const st = stats(c), due = dueLabel(st);
    const pct = st.total ? Math.min(100, Math.round(st.lastNo / st.total * 100)) : 0;
    return `<a class="card c-card" href="#/c/${c.id}">
      <div class="row"><h2>${esc(c.name)}</h2><span class="amt">${inr(c.totalAmount)}</span></div>
      <div class="muted small">Started ${fmtDate(c.startDate)} · Paid ${inr(st.paid)}</div>
      ${st.total ? `<div class="progress"><i style="width:${pct}%"></i></div>` : ''}
      <div class="row small">
        <span>Last: ${st.lastNo ? `<b>#${st.lastNo}</b> on ${fmtDate(st.last.date)}` : 'none yet'}${st.total ? ` · ${st.lastNo}/${st.total}` : ''}</span>
        ${st.completed ? '' : `<span>Next <b>#${st.nextNo}</b> · ${fmtDate(st.nextDue)}</span>`}
      </div>
      ${due.text ? `<span class="pill ${due.cls}">${due.text}</span>` : ''}
    </a>`;
  }).join('');

  app.innerHTML = `${bar('Commetty Book', { actions: `<a class="icon-btn" href="#/backup" aria-label="Backup & restore">${ICON.backup}</a>` })}
    <main>
      ${S.committees.length ? `<div class="totals"><div><span>${S.committees.length}</span>Commetty</div><div><span>${S.deposits.length}</span>Deposits</div><div><span>${inr(totalPaid)}</span>Total jama</div></div>
        ${cards}` : `<div class="empty"><img src="icons/icon.svg" alt="">
        <h2>Koi commetty nahi hai</h2><p>Apni pehli commetty add karein — naam, total amount aur start date.</p>
        <a class="btn" href="#/new">+ Nayi Commetty</a>
        <p class="small muted">Purana backup hai? <a href="#/backup">Restore karein</a></p></div>`}
    </main>
    ${S.committees.length ? `<a class="fab" href="#/new" aria-label="New commetty">${ICON.plus}<span>Commetty</span></a>` : ''}`;
}

// ------------------------------------------------------------------ committee detail
function viewCommittee(c, tab) {
  const st = stats(c), due = dueLabel(st);
  const rows = [...st.deps].reverse();
  const list = !rows.length ? '<p class="empty-small">Abhi koi deposit nahi. Neeche “Add deposit” dabayein.</p>'
    : tab === 'deposits'
      ? `<div class="card list">${rows.map((d) => `<a class="li" href="#/d/${d.id}">
          <span class="no">#${d.installmentNo}</span><b>${inr(d.amount)}</b><span class="sep">|</span><span>${fmtDate(d.date)}</span></a>`).join('')}</div>`
      : rows.map((d) => `<div class="card hist">
          <div class="row"><b class="big">${inr(d.amount)}</b><a class="icon-btn sm" href="#/d/${d.id}" aria-label="Edit">${ICON.edit}</a></div>
          <div class="kv">
            <span>Installment</span><b>${ordinal(d.installmentNo)}</b>
            <span>Date</span><b>${fmtDate(d.date)}</b>
            <span>Paid via</span><b>${esc(d.mode || '—')}</b>
            ${d.txnId ? `<span>Txn / UTR</span><b class="mono">${esc(d.txnId)}</b>` : ''}
            ${d.paidTo ? `<span>Paid to</span><b>${esc(d.paidTo)}</b>` : ''}
            ${d.note ? `<span>Note</span><b>${esc(d.note)}</b>` : ''}
          </div>
          ${d.screenshots?.length ? `<div class="shots">${d.screenshots.map((s, i) => `<img src="${shotUrl(s)}" alt="Screenshot ${i + 1}" loading="lazy" data-view>`).join('')}</div>` : ''}
        </div>`).join('');

  app.innerHTML = `${bar(c.name, { back: '#/', actions: `<button type="button" class="icon-btn" data-act="share-summary" aria-label="Share summary">${ICON.share}</button><a class="icon-btn" href="#/c/${c.id}/edit" aria-label="Edit">${ICON.edit}</a>` })}
    <main>
      <section class="hero">
        <div class="small">Commetty total amount</div>
        <div class="hero-amt">${inr(c.totalAmount)}</div>
        <div class="hero-grid">
          <div><span>Started</span>${fmtDate(c.startDate)}</div>
          <div><span>Installments paid</span>${st.lastNo}${st.total ? ' / ' + st.total : ''}</div>
          <div><span>Total jama</span>${inr(st.paid)}</div>
          ${c.monthly ? `<div><span>Monthly</span>${inr(c.monthly)}</div>` : ''}
          ${c.organizer ? `<div><span>Organizer</span>${esc(c.organizer)}</div>` : ''}
          ${c.receivedAmount ? `<div><span>Commetty uthayi</span>${inr(c.receivedAmount)}${c.receivedDate ? ' · ' + fmtDate(c.receivedDate) : ''}</div>` : ''}
        </div>
      </section>
      <div class="two">
        <div class="card stat"><span class="small muted">Last installment</span>
          ${st.lastNo ? `<b class="big">#${st.lastNo}</b><span class="small">paid on ${fmtDate(st.last.date)}<br>${inr(st.last.amount)}</span>` : '<b class="big">—</b><span class="small">none yet</span>'}</div>
        <div class="card stat"><span class="small muted">Next installment</span>
          ${st.completed ? '<b class="big">✔</b><span class="small">Completed</span>'
            : `<b class="big">#${st.nextNo}</b><span class="small">due ${fmtDate(st.nextDue)}</span>`}
          ${due.text ? `<span class="pill ${due.cls}">${due.text}</span>` : ''}</div>
      </div>
      ${c.notes ? `<div class="card small">${esc(c.notes)}</div>` : ''}
      <div class="tabs">
        <a href="#/c/${c.id}" class="${tab === 'deposits' ? 'on' : ''}">Old deposits</a>
        <a href="#/c/${c.id}/history" class="${tab === 'history' ? 'on' : ''}">Deposit history</a>
      </div>
      ${list}
    </main>
    ${st.completed ? '' : `<a class="fab" href="#/c/${c.id}/pay">${ICON.plus}<span>Add deposit</span></a>`}`;
  app.dataset.committee = c.id;
}

function summaryText(c) {
  const st = stats(c);
  const lines = [
    `*${c.name}*`,
    `Total: ${inr(c.totalAmount)} | Started: ${fmtDate(c.startDate)}`,
    `Paid: ${st.lastNo}${st.total ? '/' + st.total : ''} installments, ${inr(st.paid)}`,
    st.lastNo ? `Last: #${st.lastNo} paid on ${fmtDate(st.last.date)}` : null,
    st.completed ? 'All installments paid ✔' : `Next: #${st.nextNo} due ${fmtDate(st.nextDue)}`,
    '', 'Deposits:',
    ...st.deps.map((d) => `#${d.installmentNo} ${inr(d.amount)} | ${fmtDate(d.date)}${d.mode ? ' | ' + d.mode : ''}`),
  ];
  return lines.filter((l) => l !== null).join('\n');
}

// ------------------------------------------------------------------ committee form
function viewCommitteeForm(c) {
  const v = c || { startDate: todayISO() };
  app.innerHTML = `${bar(c ? 'Edit commetty' : 'Nayi commetty', { back: c ? `#/c/${c.id}` : '#/' })}
    <main><form class="card form" id="cform" autocomplete="off">
      <label>Commetty name *<input name="name" required maxlength="200" value="${esc(v.name)}" placeholder="e.g. Santosh uncle January 2026"></label>
      <label>Commetty total amount (₹) *<input name="totalAmount" type="number" inputmode="decimal" min="0" step="any" required value="${esc(v.totalAmount)}" placeholder="105000"></label>
      <label>Commetty started date *<input name="startDate" type="date" required value="${esc(v.startDate)}"></label>
      <div class="grid2">
        <label>Monthly installment (₹)<input name="monthly" type="number" inputmode="decimal" min="0" step="any" value="${esc(v.monthly || '')}" placeholder="7000"></label>
        <label>Total installments<input name="months" type="number" inputmode="numeric" min="0" max="1000" step="1" value="${esc(v.months || '')}" placeholder="15"></label>
      </div>
      <label>Organizer / head<input name="organizer" maxlength="200" value="${esc(v.organizer)}" placeholder="Santosh uncle"></label>
      <label>Notes<textarea name="notes" rows="2" maxlength="4000" placeholder="Members, rules, bid details…">${esc(v.notes)}</textarea></label>
      <details ${v.receivedAmount ? 'open' : ''}><summary>Commetty uthayi? (payout received)</summary>
        <div class="grid2">
          <label>Amount received (₹)<input name="receivedAmount" type="number" inputmode="decimal" min="0" step="any" value="${esc(v.receivedAmount || '')}"></label>
          <label>Received on<input name="receivedDate" type="date" value="${esc(v.receivedDate)}"></label>
        </div></details>
      <p class="small muted">Har installment ki due date start date ke hisaab se nikalti hai (start 5 Jan → #2 due 5 Feb, #3 due 5 Mar…).</p>
      <button class="btn block" type="submit">${c ? 'Save changes' : 'Create commetty'}</button>
      ${c ? '<button class="btn danger block" type="button" data-act="del-committee">Delete commetty</button>' : ''}
    </form></main>`;

  $('#cform').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const rec = {
      name: f.name, totalAmount: Number(f.totalAmount), startDate: f.startDate, monthly: Number(f.monthly) || 0, months: Number(f.months) || 0,
      organizer: f.organizer, notes: f.notes, receivedAmount: Number(f.receivedAmount) || 0, receivedDate: f.receivedDate || '',
    };
    let saved;
    if (await save(async () => { saved = await (c ? api('PUT', `api/committees/${c.id}`, rec) : api('POST', 'api/committees', rec)); })) go(`#/c/${saved.id}`);
  };
}

// ------------------------------------------------------------------ deposit form
// Screenshots are shrunk on the phone (max 1600px JPEG) before upload, so the server does no image work.
async function compressImage(file, max = 1600, quality = 0.8) {
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * s); cv.height = Math.round(bmp.height * s);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    return await new Promise((resolve) => cv.toBlob(resolve, 'image/jpeg', quality));
  } catch {
    return file;
  }
}

function viewDepositForm(c, d) {
  const st = stats(c);
  const prev = st.deps[st.deps.length - 1];
  const v = d || { installmentNo: st.nextNo, amount: c.monthly || prev?.amount || '', date: todayISO(), mode: prev?.mode || 'PhonePe', paidTo: prev?.paidTo || c.organizer || '' };
  const shots = [...(v.screenshots || [])];

  app.innerHTML = `${bar(d ? 'Edit deposit' : 'Add deposit', { back: `#/c/${c.id}` })}
    <main><div class="muted small pad">${esc(c.name)}${d ? '' : ` · next due ${fmtDate(st.nextDue)}`}</div>
    <form class="card form" id="dform" autocomplete="off">
      <div class="grid2">
        <label>Installment no. *<input name="installmentNo" type="number" inputmode="numeric" min="1" max="1000" step="1" required value="${esc(v.installmentNo)}"></label>
        <label>Amount (₹) *<input name="amount" type="number" inputmode="decimal" min="0" step="any" required value="${esc(v.amount)}"></label>
      </div>
      <label>Paid on *<input name="date" type="date" required value="${esc(v.date)}"></label>
      <fieldset><legend>Paid via</legend><div class="chips">${MODES.map((m) =>
        `<label class="chip"><input type="radio" name="mode" value="${esc(m)}" ${v.mode === m ? 'checked' : ''}><span>${esc(m)}</span></label>`).join('')}</div></fieldset>
      <label>Transaction ID / UTR<input name="txnId" maxlength="100" value="${esc(v.txnId)}" placeholder="e.g. T2601051234…"></label>
      <label>Paid to<input name="paidTo" maxlength="200" value="${esc(v.paidTo)}" placeholder="Name / UPI ID"></label>
      <label>Note<textarea name="note" rows="2" maxlength="4000" placeholder="Bid, late fee, kisne liya…">${esc(v.note)}</textarea></label>
      <fieldset><legend>Payment screenshot</legend>
        <div class="shots edit" id="shots"></div>
        <label class="btn ghost block" id="shotBtn">📷 Screenshot / photo add karein<input id="shotInput" type="file" accept="image/*" multiple hidden></label>
      </fieldset>
      <button class="btn block" type="submit">${d ? 'Save changes' : 'Save deposit'}</button>
      ${d ? '<button class="btn danger block" type="button" data-act="del-deposit">Delete deposit</button>' : ''}
    </form></main>`;

  const drawShots = () => {
    $('#shots').innerHTML = shots.map((s, i) => `<div class="shot"><img src="${shotUrl(s)}" alt="" data-view><button type="button" data-rm="${i}" aria-label="Remove">✕</button></div>`).join('');
  };
  drawShots();
  $('#shots').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { shots.splice(Number(b.dataset.rm), 1); drawShots(); } };
  let uploading = 0;
  $('#shotInput').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    $('#shotBtn').firstChild.textContent = '⏳ Upload ho raha hai… ';
    uploading++;
    try {
      for (const f of files) shots.push((await api('POST', 'api/shots', await compressImage(f))).id);
    } catch (err) {
      if (err instanceof LoginRequired) return viewLogin();
      toast(err.message);
    } finally {
      uploading--;
      if ($('#shotBtn')) $('#shotBtn').firstChild.textContent = '📷 Screenshot / photo add karein';
    }
    if ($('#shots')) drawShots();
  };

  $('#dform').onsubmit = async (e) => {
    e.preventDefault();
    if (uploading) return toast('Screenshot upload hone dein…');
    const f = Object.fromEntries(new FormData(e.target));
    const rec = {
      committeeId: c.id, installmentNo: Number(f.installmentNo), amount: Number(f.amount), date: f.date, mode: f.mode || '',
      txnId: f.txnId, paidTo: f.paidTo, note: f.note, screenshots: shots,
    };
    const dup = !d && S.deposits.some((x) => x.committeeId === c.id && x.installmentNo === rec.installmentNo);
    if (dup && !(await confirmBox(`<p>Installment <b>#${rec.installmentNo}</b> ka deposit pehle se hai. Phir bhi ek aur add karein? (e.g. part payment)</p>`, 'Add anyway'))) return;
    if (await save(() => (d ? api('PUT', `api/deposits/${d.id}`, rec) : api('POST', 'api/deposits', rec)), 'Deposit saved ✔')) go(`#/c/${c.id}/history`);
  };
  app.dataset.deposit = d ? d.id : '';
  app.dataset.committee = c.id;
}

// ------------------------------------------------------------------ backup & restore
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function exportCsv() {
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = [['Commetty', 'Total amount', 'Started', 'Installment', 'Amount', 'Date', 'Paid via', 'Txn/UTR', 'Paid to', 'Note', 'Screenshots']];
  for (const c of S.committees) for (const d of depositsOf(c.id)) {
    rows.push([c.name, c.totalAmount, c.startDate, d.installmentNo, d.amount, d.date, d.mode, d.txnId, d.paidTo, d.note, d.screenshots?.length || 0]);
  }
  downloadBlob(new Blob(['﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n')], { type: 'text/csv' }), `CommettyDeposits_${todayISO()}.csv`);
}

const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const backupLabel = (name) => ({ auto: 'Daily auto', manual: 'Manual', prerestore: 'Restore se pehle' }[name.replace(/^.*-(\w+)\.zip$/, '$1')] || '');

async function restoreConfirmed(what) {
  return confirmBox(`<h3>Restore karein?</h3><p>${what}</p>
    <p class="small">Abhi ka saara data is backup se <b>replace</b> ho jayega. Abhi wale data ka backup pehle apne aap ban jayega (“Restore se pehle”), to galti hone par wapas la sakte hain.</p>`, 'Restore');
}

async function viewBackup() {
  const sv = S.server;
  let list = [];
  try { list = await api('GET', 'api/backups'); } catch (err) { if (err instanceof LoginRequired) return viewLogin(); }
  if (!location.hash.startsWith('#/backup')) return;
  app.innerHTML = `${bar('Backup & restore', { back: '#/' })}
    <main>
      <div class="card">
        <h3>Automatic backup ✔</h3>
        <p class="small muted">Server roz raat <b>${pad(sv.backupHour ?? 2)}:00</b> baje backup leta hai (agar kuch badla ho) aur aakhri <b>${sv.backupKeep ?? 30}</b> backups rakhta hai.
        ${sv.telegram ? '<br>📨 Har backup <b>Telegram</b> par bhi bheja jata hai.' : '<br>Telegram off hai — server ke <code>TELEGRAM_BOT_TOKEN</code> set karke off-site copy pa sakte hain.'}</p>
        <p class="small">${sv.lastBackup ? `Last backup: <b>${fmtDateTime(sv.lastBackup.time)}</b>` : 'Abhi tak koi backup nahi.'}${sv.pending ? ' · <span class="pill warn">naye changes baaki</span>' : ''}</p>
        <button type="button" class="btn block" data-act="backup-now">☁ Abhi backup lo${sv.telegram ? ' + Telegram' : ''}</button>
        <a class="btn ghost block" href="api/backup" download>⬇ Poora backup phone me download karo (.zip)</a>
      </div>
      <div class="card">
        <h3>Server par saved backups</h3>
        ${list.length ? `<div class="blist">${list.map((b) => `<div class="bi">
          <div><b>${fmtDateTime(b.time)}</b><span class="small muted">${backupLabel(b.name)} · ${fmtSize(b.size)}</span></div>
          <a class="icon-btn sm" href="api/backups/${b.name}" download aria-label="Download">⬇</a>
          <button type="button" class="btn ghost mini" data-restore="${b.name}">Restore</button></div>`).join('')}</div>`
          : '<p class="small muted">Koi backup nahi.</p>'}
      </div>
      <div class="card">
        <h3>File se restore</h3>
        <p class="small muted">Phone me rakhi backup .zip file (ya Telegram se download ki hui) choose karein.</p>
        <label class="btn block">📂 Backup .zip choose karo<input id="restoreInput" type="file" accept=".zip,application/zip" hidden></label>
      </div>
      <div class="card">
        <h3>Export</h3>
        <button type="button" class="btn ghost block" data-act="export-csv">📊 Excel / Sheets (CSV) export</button>
      </div>
      <button type="button" class="btn danger block" data-act="logout">Logout</button>
    </main>`;

  $('#restoreInput').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f || !(await restoreConfirmed(`File: <b>${esc(f.name)}</b> (${fmtSize(f.size)})`))) return;
    toast('Restore ho raha hai…', 60000);
    if (await save(() => api('POST', 'api/restore', f), 'Restore ho gaya ✔')) go('#/');
  };
}

// ------------------------------------------------------------------ global actions
app.addEventListener('click', async (e) => {
  const img = e.target.closest('img[data-view]');
  if (img) return viewImage(img.src);
  const rb = e.target.closest('[data-restore]');
  if (rb) {
    if (!(await restoreConfirmed(`Backup: <b>${esc(rb.closest('.bi').querySelector('b').textContent)}</b>`))) return;
    if (await save(() => api('POST', `api/backups/${rb.dataset.restore}/restore`), 'Restore ho gaya ✔')) go('#/');
    return;
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'reload') return location.reload();
  if (act === 'export-csv') return exportCsv();
  if (act === 'backup-now') {
    el.disabled = true;
    let r;
    if (await save(async () => { r = await api('POST', 'api/backups'); }, null)) {
      toast(r.telegramError ? 'Backup bana, par Telegram fail: ' + r.telegramError : r.telegram ? 'Backup bana aur Telegram par bheja ✔' : 'Backup ban gaya ✔', 4000);
      viewBackup();
    } else el.disabled = false;
    return;
  }
  if (act === 'logout') {
    if (!(await confirmBox('<p>Is phone se logout karein?</p>', 'Logout'))) return;
    await api('POST', 'api/logout').catch(() => {});
    await caches.delete('commetty-data').catch(() => {});
    Object.assign(S, { committees: [], deposits: [], loggedIn: false });
    location.hash = '';
    return viewLogin();
  }
  if (act === 'share-summary') {
    const text = summaryText(committee(app.dataset.committee));
    if (navigator.share) navigator.share({ text }).catch(() => {});
    else window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
    return;
  }
  if (act === 'del-committee') {
    const c = committee(app.dataset.committee);
    const n = depositsOf(c.id).length;
    if (!(await confirmBox(`<p><b>${esc(c.name)}</b> aur uske ${n} deposit${n === 1 ? '' : 's'} delete karein? (Purane backup se wapas la sakte hain.)</p>`, 'Delete', 'danger'))) return;
    if (await save(() => api('DELETE', `api/committees/${c.id}`), 'Deleted')) go('#/');
  }
  if (act === 'del-deposit') {
    if (!(await confirmBox('<p>Ye deposit delete karein?</p>', 'Delete', 'danger'))) return;
    if (await save(() => api('DELETE', `api/deposits/${app.dataset.deposit}`), 'Deleted')) go(`#/c/${app.dataset.committee}/history`);
  }
});

// ------------------------------------------------------------------ start
(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    await loadState();
  } catch (err) {
    if (!(err instanceof LoginRequired)) {
      app.innerHTML = `<main class="empty"><h2>Server se connect nahi ho paya</h2><p>${esc(err.message)}</p><button class="btn" type="button" data-act="reload">Retry</button></main>`;
      return;
    }
  }
  route();
})();
