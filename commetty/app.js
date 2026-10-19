/* Commetty Book — keep a record of every commetty (chit / BC) installment, fully offline.
   Data lives in IndexedDB on the phone; backups are a single file you share to WhatsApp/Drive
   and restore with one tap. */
'use strict';

const APP_ID = 'commetty-book';
const BACKUP_VERSION = 1;
const MODES = ['PhonePe', 'Google Pay', 'Paytm', 'UPI (other)', 'Cash', 'Bank transfer', 'Other'];
const DEFAULT_SETTINGS = { autoPrompt: true, autoDownload: false, remindDays: 7 };

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

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

// ------------------------------------------------------------------ state
const S = { committees: [], deposits: [], settings: { ...DEFAULT_SETTINGS }, lastBackupAt: null, changes: 0 };

async function loadState() {
  const [committees, deposits, settings, lastBackupAt, changes] = await Promise.all([
    DB.all('committees'), DB.all('deposits'), DB.get('meta', 'settings'), DB.get('meta', 'lastBackupAt'), DB.get('meta', 'changes'),
  ]);
  committees.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
  Object.assign(S, { committees, deposits, settings: { ...DEFAULT_SETTINGS, ...settings }, lastBackupAt: lastBackupAt || null, changes: changes || 0 });
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

// Every save goes through here: counts unsaved changes, optionally auto-downloads a backup
// and offers a one-tap WhatsApp backup.
async function afterChange(kind) {
  S.changes += 1;
  await DB.put('meta', S.changes, 'changes');
  await loadState();
  if (S.settings.autoDownload) await downloadBackup(true);
  if (S.settings.autoPrompt && kind === 'deposit') {
    toast('Deposit saved ✔', { label: 'Backup bhejo', fn: shareBackup }, 7000);
  } else {
    toast('Saved ✔');
  }
}

const backupDue = () => S.committees.length > 0 && S.changes > 0 && (!S.lastBackupAt
  || (Date.now() - new Date(S.lastBackupAt)) / 86400000 >= S.settings.remindDays || S.changes >= 5);

// ------------------------------------------------------------------ UI helpers
const app = $('#app');
let toastTimer;
function toast(msg, action, ms = 2600) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; action.fn(); };
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
    <h1>${esc(title)}</h1>${actions}</header>`;
}

// ------------------------------------------------------------------ router
window.addEventListener('hashchange', route);
// Navigate without leaving the form in history; re-render if we are already there.
function go(hash) {
  if (location.hash === hash) route(); else location.replace(hash);
}
async function route() {
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

  const banner = backupDue() ? `<div class="banner">
      <div><b>${S.changes} change${S.changes === 1 ? '' : 's'} ka backup baaki hai</b>
      <div class="small">${S.lastBackupAt ? 'Last backup ' + fmtDateTime(S.lastBackupAt) : 'Abhi tak koi backup nahi liya'}</div></div>
      <button type="button" class="btn small-btn" data-act="share-backup">Backup now</button></div>` : '';

  app.innerHTML = `${bar('Commetty Book', { actions: `<a class="icon-btn" href="#/backup" aria-label="Backup & restore">${ICON.backup}</a>` })}
    <main>
      ${banner}
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
          ${d.screenshots?.length ? `<div class="shots">${d.screenshots.map((s, i) => `<img src="${s}" alt="Screenshot ${i + 1}" data-view>`).join('')}</div>` : ''}
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
      <label>Commetty name *<input name="name" required value="${esc(v.name)}" placeholder="e.g. Santosh uncle January 2026"></label>
      <label>Commetty total amount (₹) *<input name="totalAmount" type="number" inputmode="decimal" min="0" step="any" required value="${esc(v.totalAmount)}" placeholder="105000"></label>
      <label>Commetty started date *<input name="startDate" type="date" required value="${esc(v.startDate)}"></label>
      <div class="grid2">
        <label>Monthly installment (₹)<input name="monthly" type="number" inputmode="decimal" min="0" step="any" value="${esc(v.monthly)}" placeholder="7000"></label>
        <label>Total installments<input name="months" type="number" inputmode="numeric" min="0" step="1" value="${esc(v.months)}" placeholder="15"></label>
      </div>
      <label>Organizer / head<input name="organizer" value="${esc(v.organizer)}" placeholder="Santosh uncle"></label>
      <label>Notes<textarea name="notes" rows="2" placeholder="Members, rules, bid details…">${esc(v.notes)}</textarea></label>
      <details ${v.receivedAmount ? 'open' : ''}><summary>Commetty uthayi? (payout received)</summary>
        <div class="grid2">
          <label>Amount received (₹)<input name="receivedAmount" type="number" inputmode="decimal" min="0" step="any" value="${esc(v.receivedAmount)}"></label>
          <label>Received on<input name="receivedDate" type="date" value="${esc(v.receivedDate)}"></label>
        </div></details>
      <p class="small muted">Har installment ki due date start date ke hisaab se nikalti hai (start 5 Jan → #2 due 5 Feb, #3 due 5 Mar…).</p>
      <button class="btn block" type="submit">${c ? 'Save changes' : 'Create commetty'}</button>
      ${c ? '<button class="btn danger block" type="button" data-act="del-committee">Delete commetty</button>' : ''}
    </form></main>`;

  $('#cform').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const num = (x) => (x === '' ? null : Number(x));
    const rec = {
      ...(c || { id: uid(), createdAt: new Date().toISOString() }),
      name: f.name.trim(), totalAmount: num(f.totalAmount), startDate: f.startDate, monthly: num(f.monthly), months: num(f.months),
      organizer: f.organizer.trim(), notes: f.notes.trim(), receivedAmount: num(f.receivedAmount), receivedDate: f.receivedDate || null,
      updatedAt: new Date().toISOString(),
    };
    await DB.put('committees', rec);
    await afterChange('committee');
    go(`#/c/${rec.id}`);
  };
}

// ------------------------------------------------------------------ deposit form
async function compressImage(file, max = 1600, quality = 0.8) {
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * s); cv.height = Math.round(bmp.height * s);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', quality);
  } catch {
    return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
  }
}

function viewDepositForm(c, d) {
  const st = stats(c);
  const prev = st.deps[st.deps.length - 1];
  const v = d || { installmentNo: st.nextNo, amount: c.monthly || prev?.amount || '', date: todayISO(), mode: prev?.mode || 'PhonePe', paidTo: prev?.paidTo || c.organizer || '' };
  let shots = [...(v.screenshots || [])];

  app.innerHTML = `${bar(d ? 'Edit deposit' : 'Add deposit', { back: `#/c/${c.id}` })}
    <main><div class="muted small pad">${esc(c.name)}${d ? '' : ` · next due ${fmtDate(st.nextDue)}`}</div>
    <form class="card form" id="dform" autocomplete="off">
      <div class="grid2">
        <label>Installment no. *<input name="installmentNo" type="number" inputmode="numeric" min="1" step="1" required value="${esc(v.installmentNo)}"></label>
        <label>Amount (₹) *<input name="amount" type="number" inputmode="decimal" min="0" step="any" required value="${esc(v.amount)}"></label>
      </div>
      <label>Paid on *<input name="date" type="date" required value="${esc(v.date)}"></label>
      <fieldset><legend>Paid via</legend><div class="chips">${MODES.map((m) =>
        `<label class="chip"><input type="radio" name="mode" value="${esc(m)}" ${v.mode === m ? 'checked' : ''}><span>${esc(m)}</span></label>`).join('')}</div></fieldset>
      <label>Transaction ID / UTR<input name="txnId" value="${esc(v.txnId)}" placeholder="e.g. T2601051234…"></label>
      <label>Paid to<input name="paidTo" value="${esc(v.paidTo)}" placeholder="Name / UPI ID"></label>
      <label>Note<textarea name="note" rows="2" placeholder="Bid, late fee, kisne liya…">${esc(v.note)}</textarea></label>
      <fieldset><legend>Payment screenshot</legend>
        <div class="shots edit" id="shots"></div>
        <label class="btn ghost block">📷 Screenshot / photo add karein<input id="shotInput" type="file" accept="image/*" multiple hidden></label>
      </fieldset>
      <button class="btn block" type="submit">${d ? 'Save changes' : 'Save deposit'}</button>
      ${d ? '<button class="btn danger block" type="button" data-act="del-deposit">Delete deposit</button>' : ''}
    </form></main>`;

  const drawShots = () => {
    $('#shots').innerHTML = shots.map((s, i) => `<div class="shot"><img src="${s}" alt="" data-view><button type="button" data-rm="${i}" aria-label="Remove">✕</button></div>`).join('');
  };
  drawShots();
  $('#shots').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { shots.splice(Number(b.dataset.rm), 1); drawShots(); } };
  $('#shotInput').onchange = async (e) => {
    for (const f of e.target.files) shots.push(await compressImage(f));
    e.target.value = '';
    drawShots();
  };

  $('#dform').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const rec = {
      ...(d || { id: uid(), committeeId: c.id, createdAt: new Date().toISOString() }),
      installmentNo: Number(f.installmentNo), amount: Number(f.amount), date: f.date, mode: f.mode || '',
      txnId: f.txnId.trim(), paidTo: f.paidTo.trim(), note: f.note.trim(), screenshots: shots, updatedAt: new Date().toISOString(),
    };
    const dup = !d && S.deposits.some((x) => x.committeeId === c.id && x.installmentNo === rec.installmentNo);
    if (dup && !(await ask(`<p>Installment <b>#${rec.installmentNo}</b> ka deposit pehle se hai. Phir bhi ek aur add karein? (e.g. part payment)</p>`,
      [{ label: 'Cancel', cls: 'ghost', value: false }, { label: 'Add anyway', value: true }]))) return;
    await DB.put('deposits', rec);
    await afterChange('deposit');
    go(`#/c/${c.id}/history`);
  };
  app.dataset.deposit = d ? d.id : '';
  app.dataset.committee = c.id;
}

// ------------------------------------------------------------------ backup & restore
async function buildBackup() {
  const [committees, deposits] = await Promise.all([DB.all('committees'), DB.all('deposits')]);
  return { app: APP_ID, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), committees, deposits };
}
function backupName(ext) {
  const d = new Date();
  return `CommettyBackup_${toISO(d)}_${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
}
async function markBackedUp() {
  S.lastBackupAt = new Date().toISOString(); S.changes = 0;
  await Promise.all([DB.put('meta', S.lastBackupAt, 'lastBackupAt'), DB.put('meta', 0, 'changes')]);
}
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function downloadBackup(silent) {
  downloadBlob(new Blob([JSON.stringify(await buildBackup())], { type: 'application/json' }), backupName('json'));
  await markBackedUp();
  if (!silent) { toast('Backup file Downloads me save ho gayi ✔'); route(); }
}

// Android's share sheet (WhatsApp, Drive, Gmail, Telegram…). Chrome only allows sharing certain
// file types, so the JSON backup is shared as a .txt file — restore accepts both .txt and .json.
async function shareBackup() {
  const file = new File([JSON.stringify(await buildBackup())], backupName('txt'), { type: 'text/plain' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Commetty Book backup' });
      await markBackedUp();
      toast('Backup shared ✔');
      route();
    } catch (err) {
      if (err.name !== 'AbortError') { toast('Share nahi hua, file download kar rahe hain'); await downloadBackup(true); route(); }
    }
  } else {
    await downloadBackup();
  }
}

async function shareCsv() {
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = [['Commetty', 'Total amount', 'Started', 'Installment', 'Amount', 'Date', 'Paid via', 'Txn/UTR', 'Paid to', 'Note', 'Screenshots']];
  for (const c of S.committees) for (const d of depositsOf(c.id)) {
    rows.push([c.name, c.totalAmount, c.startDate, d.installmentNo, d.amount, d.date, d.mode, d.txnId, d.paidTo, d.note, d.screenshots?.length || 0]);
  }
  const csv = '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n');
  const file = new File([csv], backupName('csv').replace('Backup', 'Deposits'), { type: 'text/csv' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Commetty deposits' }); } catch (err) { if (err.name !== 'AbortError') downloadBlob(file, file.name); }
  } else downloadBlob(file, file.name);
}

function validBackup(data) {
  return data && data.app === APP_ID && Array.isArray(data.committees) && Array.isArray(data.deposits)
    && data.committees.every((c) => c && typeof c.id === 'string' && c.name)
    && data.deposits.every((d) => d && typeof d.id === 'string' && typeof d.committeeId === 'string');
}

async function restoreFromFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { data = null; }
  if (!validBackup(data)) {
    await ask('<p>Ye Commetty Book ki backup file nahi lag rahi. Sahi file (<b>CommettyBackup_….txt / .json</b>) choose karein.</p>', [{ label: 'OK', value: true }]);
    return;
  }
  const choice = await ask(`<h3>Restore backup?</h3>
    <p>Backup date: <b>${data.exportedAt ? fmtDateTime(data.exportedAt) : 'unknown'}</b><br>
    ${data.committees.length} commetty · ${data.deposits.length} deposits</p>
    <p class="small"><b>Replace</b>: phone ka abhi ka data hata kar backup wala data aa jayega.<br>
    <b>Merge</b>: dono mila diye jayenge (same entry backup se update hogi).</p>`,
  [{ label: 'Cancel', cls: 'ghost', value: null }, { label: 'Merge', cls: 'ghost', value: 'merge' }, { label: 'Replace', value: 'replace' }]);
  if (!choice) return;
  // Keep what was on the phone so a wrong restore can be undone.
  await DB.put('meta', await buildBackup(), 'preRestore');
  await DB.load(data.committees, data.deposits, choice === 'replace');
  await markBackedUp();
  await loadState();
  toast('Restore ho gaya ✔');
  go('#/');
}

async function undoRestore() {
  const prev = await DB.get('meta', 'preRestore');
  if (!prev) return;
  if (!(await ask('<p>Restore se pehle wala data wapas laayein?</p>', [{ label: 'Cancel', cls: 'ghost', value: false }, { label: 'Undo restore', value: true }]))) return;
  await DB.load(prev.committees, prev.deposits, true);
  await DB.del('meta', 'preRestore');
  await afterChange('restore');
  route();
}

async function viewBackup() {
  const persisted = await navigator.storage?.persisted?.();
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const hasUndo = !!(await DB.get('meta', 'preRestore'));
  const s = S.settings;
  app.innerHTML = `${bar('Backup & restore', { back: '#/' })}
    <main>
      <div class="card">
        <h3>Backup</h3>
        <p class="small muted">${S.lastBackupAt ? `Last backup: <b>${fmtDateTime(S.lastBackupAt)}</b>` : 'Abhi tak koi backup nahi liya.'}
        ${S.changes ? `<br><b>${S.changes}</b> change${S.changes === 1 ? '' : 's'} backup ke baad.` : ''}</p>
        <button type="button" class="btn block" data-act="share-backup">${ICON.share} WhatsApp / Drive par backup bhejo</button>
        <button type="button" class="btn ghost block" data-act="download-backup">⬇ Backup file phone me save karo</button>
        <p class="small muted">Tip: WhatsApp par apne aap ko (“Message yourself”) ya family group me bhejein. Puri details + screenshots ek hi file me hoti hain.</p>
      </div>
      <div class="card">
        <h3>Restore (one tap)</h3>
        <p class="small muted">WhatsApp se backup file download karke yahan choose karein.</p>
        <label class="btn block">📂 Backup file choose karo<input id="restoreInput" type="file" accept=".txt,.json,text/plain,application/json" hidden></label>
        ${hasUndo ? '<button type="button" class="btn ghost block" data-act="undo-restore">↩ Undo last restore</button>' : ''}
      </div>
      <div class="card form">
        <h3>Auto backup settings</h3>
        <label class="switch"><input type="checkbox" data-set="autoPrompt" ${s.autoPrompt ? 'checked' : ''}><span>Har deposit ke baad “Backup bhejo” button dikhao</span></label>
        <label class="switch"><input type="checkbox" data-set="autoDownload" ${s.autoDownload ? 'checked' : ''}><span>Har change par backup file apne aap Downloads me save karo</span></label>
        <label>Backup reminder (home screen par)
          <select data-set="remindDays">${[1, 3, 7, 15, 30].map((n) => `<option value="${n}" ${s.remindDays === n ? 'selected' : ''}>Har ${n} din</option>`).join('')}</select></label>
      </div>
      <div class="card">
        <h3>Export</h3>
        <button type="button" class="btn ghost block" data-act="share-csv">📊 Excel / Sheets (CSV) export</button>
      </div>
      <div class="card small muted">
        <b>Phone storage:</b> ${persisted ? '✔ Protected (browser khud data delete nahi karega)' : '⚠ Not protected — app ko Home screen par install karein'}
        ${est ? `<br>Used: ${(est.usage / 1048576).toFixed(1)} MB` : ''}
        <br>Data sirf is phone ke browser me hai. “Clear data” / app uninstall karne se pehle backup zaroor lein.
      </div>
    </main>`;

  $('#restoreInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) restoreFromFile(f); };
  app.querySelectorAll('[data-set]').forEach((el) => {
    el.onchange = async () => {
      S.settings[el.dataset.set] = el.type === 'checkbox' ? el.checked : Number(el.value);
      await DB.put('meta', S.settings, 'settings');
      toast('Setting saved');
    };
  });
}

// ------------------------------------------------------------------ global actions
app.addEventListener('click', async (e) => {
  const img = e.target.closest('img[data-view]');
  if (img) return viewImage(img.src);
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'share-backup') return shareBackup();
  if (act === 'download-backup') return downloadBackup();
  if (act === 'share-csv') return shareCsv();
  if (act === 'undo-restore') return undoRestore();
  if (act === 'share-summary') {
    const text = summaryText(committee(app.dataset.committee));
    if (navigator.share) navigator.share({ text }).catch(() => {});
    else window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
    return;
  }
  if (act === 'del-committee') {
    const c = committee(app.dataset.committee);
    const n = depositsOf(c.id).length;
    if (!(await ask(`<p><b>${esc(c.name)}</b> aur uske ${n} deposit${n === 1 ? '' : 's'} delete karein? Ye wapas nahi aayega (backup ho to restore kar sakte hain).</p>`,
      [{ label: 'Cancel', cls: 'ghost', value: false }, { label: 'Delete', cls: 'danger', value: true }]))) return;
    await DB.deleteCommittee(c.id);
    await afterChange('delete');
    go('#/');
  }
  if (act === 'del-deposit') {
    if (!(await ask('<p>Ye deposit delete karein?</p>', [{ label: 'Cancel', cls: 'ghost', value: false }, { label: 'Delete', cls: 'danger', value: true }]))) return;
    await DB.del('deposits', app.dataset.deposit);
    await afterChange('delete');
    go(`#/c/${app.dataset.committee}/history`);
  }
});

// ------------------------------------------------------------------ start
(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // Ask the browser not to evict our data when the phone is low on space.
  navigator.storage?.persist?.().catch(() => {});
  await loadState();
  route();
})();
