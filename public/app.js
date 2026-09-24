/* Workroom client */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('wr.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('wr.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  const me = { id: LS.get('userId') || uuid(), name: LS.get('userName', '') };
  LS.set('userId', me.id);

  const renderOpts = {
    meId: me.id,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: navigator.language || 'en-GB',
  };

  const state = {
    room: null,
    messages: [],        // sorted by id
    byId: new Map(),
    hasOlder: false,
    es: null,
    attach: null,        // { file, url, preview: Blob|null }
    ref: null,           // message being described
    sending: false,
  };

  // ------------------------------------------------------------ utils
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')');
    return data;
  }

  const roomUrl = (p) => '/api/rooms/' + state.room.code + p + (p.includes('?') ? '&' : '?') + 'userId=' + encodeURIComponent(me.id);

  function openSheet(id) { $(id).hidden = false; }
  function closeSheets() { document.querySelectorAll('.sheet-backdrop').forEach((s) => { s.hidden = true; }); }
  document.querySelectorAll('.sheet-backdrop').forEach((bd) => {
    bd.addEventListener('click', (e) => { if (e.target === bd || e.target.dataset.act === 'cancel') closeSheets(); });
  });

  // ------------------------------------------------------------ recent rooms
  function rememberRoom(room) {
    const list = LS.get('rooms', []).filter((r) => r.code !== room.code);
    list.unshift({ code: room.code, name: room.name });
    LS.set('rooms', list.slice(0, 20));
  }

  function renderRecent() {
    const list = LS.get('rooms', []);
    $('#recent-wrap').hidden = !list.length;
    $('#recent').innerHTML = list.map((r) =>
      '<li data-code="' + WR.esc(r.code) + '"><b>' + WR.esc(r.name) + '</b><span class="code">' + WR.esc(r.code) + '</span></li>').join('');
  }

  // ------------------------------------------------------------ navigation
  function showHome(prefillCode) {
    disconnect();
    state.room = null;
    $('#room').hidden = true;
    $('#home').hidden = false;
    $('#my-name').value = me.name;
    if (prefillCode) $('#join-code').value = prefillCode;
    renderRecent();
    document.title = 'Workroom';
    if (location.pathname !== '/') history.replaceState(null, '', '/');
  }

  function requireName() {
    const name = $('#my-name').value.replace(/\s+/g, ' ').trim();
    if (!name) { toast('Please enter your name first'); $('#my-name').focus(); return null; }
    me.name = name; LS.set('userName', name);
    return name;
  }

  async function enterRoom(code) {
    const room = await api('/api/rooms/' + encodeURIComponent(code) + '/join', { method: 'POST', body: { userId: me.id, userName: me.name } });
    openRoom(room);
  }

  function openRoom(room) {
    state.room = room;
    rememberRoom(room);
    state.messages = []; state.byId.clear();
    $('#messages').innerHTML = '';
    clearAttach(); clearRef();
    $('#home').hidden = true;
    $('#room').hidden = false;
    $('#room-name').textContent = room.name;
    updateMembers(room.members);
    document.title = room.name + ' · Workroom';
    if (location.pathname !== '/r/' + room.code) history.pushState(null, '', '/r/' + room.code);
    loadLatest().then(connect);
  }

  function updateMembers(members) {
    state.room.members = members;
    $('#room-sub').textContent = members.length + ' member' + (members.length === 1 ? '' : 's') + ' · ' + members.map((m) => m.name).join(', ');
  }

  // ------------------------------------------------------------ messages
  const chat = $('#chat');
  const nearBottom = () => chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
  const scrollBottom = () => { chat.scrollTop = chat.scrollHeight; };

  function renderAll() {
    $('#messages').innerHTML = state.messages.length
      ? WR.renderMessages(state.messages, renderOpts)
      : '<div class="empty">No messages yet. Say hello or share a photo 📷</div>';
    $('#load-older').hidden = !state.hasOlder;
  }

  function addMessages(list) {
    const stick = nearBottom();
    let appendOnly = true;
    for (const m of list) {
      if (state.byId.has(m.id)) continue;
      const last = state.messages[state.messages.length - 1];
      if (last && m.id < last.id) appendOnly = false;
      state.byId.set(m.id, m);
      state.messages.push(m);
      if (appendOnly) {
        const box = $('#messages');
        const empty = box.querySelector('.empty');
        if (empty) empty.remove();
        box.insertAdjacentHTML('beforeend', WR.renderMessage(m, last || null, renderOpts));
      }
    }
    if (!appendOnly) { state.messages.sort((a, b) => a.id - b.id); renderAll(); }
    if (stick) scrollBottom();
  }

  async function loadLatest() {
    const list = await api(roomUrl('/messages?limit=100'));
    state.messages = list; state.byId = new Map(list.map((m) => [m.id, m]));
    state.hasOlder = list.length === 100;
    renderAll();
    scrollBottom();
  }

  async function loadOlder() {
    if (!state.messages.length) return;
    const h = chat.scrollHeight;
    const list = await api(roomUrl('/messages?limit=100&before=' + state.messages[0].id));
    state.hasOlder = list.length === 100;
    for (const m of list) state.byId.set(m.id, m);
    state.messages = list.concat(state.messages);
    renderAll();
    chat.scrollTop = chat.scrollHeight - h;
  }

  async function catchUp() {
    const last = state.messages[state.messages.length - 1];
    const list = await api(roomUrl('/messages?limit=500&after=' + (last ? last.id : 0)));
    addMessages(list);
  }

  // Keep the chat pinned to the bottom while images load.
  chat.addEventListener('load', (e) => {
    if (e.target.tagName === 'IMG' && nearBottom()) scrollBottom();
  }, true);

  // ------------------------------------------------------------ realtime
  function connect() {
    disconnect();
    if (!state.room) return;
    const es = new EventSource(roomUrl('/stream'));
    state.es = es;
    let everOpen = false;
    es.onopen = () => {
      $('#conn').hidden = true;
      if (everOpen) catchUp().catch(() => {});
      everOpen = true;
    };
    es.onerror = () => { $('#conn').hidden = false; };
    es.addEventListener('message', (e) => addMessages([JSON.parse(e.data)]));
    es.addEventListener('members', (e) => updateMembers(JSON.parse(e.data)));
  }
  function disconnect() { if (state.es) { state.es.close(); state.es = null; } }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.room) {
      if (!state.es || state.es.readyState === EventSource.CLOSED) connect();
      catchUp().catch(() => {});
    }
  });

  // ------------------------------------------------------------ composer
  const textEl = $('#text');
  function autoGrow() { textEl.style.height = 'auto'; textEl.style.height = Math.min(textEl.scrollHeight, 140) + 'px'; }
  textEl.addEventListener('input', autoGrow);
  textEl.addEventListener('keydown', (e) => {
    const touch = matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.isComposing) { e.preventDefault(); send(); }
  });

  function setPlaceholder() {
    textEl.placeholder = state.attach ? 'Describe this photo (optional)…'
      : state.ref ? 'Describe ' + state.ref.uid + '…' : 'Message';
  }

  function clearAttach() {
    if (state.attach) URL.revokeObjectURL(state.attach.url);
    state.attach = null;
    $('#attach-preview').hidden = !state.ref;
    setPlaceholder();
  }
  function clearRef() { state.ref = null; if (!state.attach) $('#attach-preview').hidden = true; setPlaceholder(); }

  function showPreviewCard(imgUrl, title, meta) {
    $('#attach-img').src = imgUrl;
    $('#attach-title').textContent = title;
    $('#attach-meta').textContent = meta;
    $('#attach-preview').hidden = false;
  }

  // Downscaled copy for fast chat display. The original is always uploaded untouched.
  async function makePreview(file) {
    try {
      const bmp = await createImageBitmap(file);
      const max = 1280;
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 400 * 1024) { bmp.close && bmp.close(); return null; }
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close && bmp.close();
      return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
    } catch { return null; }
  }

  function pickFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('Please choose an image'); return; }
    clearAttach(); clearRef();
    const url = URL.createObjectURL(file);
    state.attach = { file, url, preview: null, previewReady: makePreview(file).then((b) => { if (state.attach && state.attach.file === file) state.attach.preview = b; }) };
    showPreviewCard(url, 'New photo · full resolution', (file.name || 'photo') + ' · ' + WR.fmtSize(file.size));
    setPlaceholder();
    textEl.focus();
  }

  function setRef(msg) {
    clearAttach();
    state.ref = msg;
    showPreviewCard(msg.image.previewUrl || msg.image.url, 'Describing ' + msg.uid, 'Sent by ' + msg.userName + (msg.text ? ' · ' + msg.text : ''));
    setPlaceholder();
    textEl.focus();
  }

  $('#attach-clear').addEventListener('click', () => { clearAttach(); clearRef(); });
  $('#file-camera').addEventListener('change', (e) => { pickFile(e.target.files[0]); e.target.value = ''; });
  $('#file-gallery').addEventListener('change', (e) => { pickFile(e.target.files[0]); e.target.value = ''; });
  $('#camera-btn').addEventListener('click', () => $('#file-camera').click());
  $('#plus-btn').addEventListener('click', () => openSheet('#attach-sheet'));
  $('#attach-sheet').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]') && e.target.closest('[data-act]').dataset.act;
    if (!act || act === 'cancel') return;
    closeSheets();
    if (act === 'camera') $('#file-camera').click();
    if (act === 'gallery') $('#file-gallery').click();
    if (act === 'describe') openPicker();
  });

  async function openPicker() {
    const grid = $('#picker-grid');
    grid.innerHTML = '<div class="empty">Loading…</div>';
    openSheet('#picker-sheet');
    try {
      const imgs = await api(roomUrl('/images'));
      grid.innerHTML = imgs.length ? imgs.map((m) =>
        '<button data-uid="' + WR.esc(m.uid) + '"><img src="' + WR.esc(m.image.previewUrl) + '" loading="lazy" alt=""><span>' + WR.esc(m.uid) + '</span></button>').join('')
        : '<div class="empty" style="grid-column:1/-1">No photos shared yet.</div>';
      grid.onclick = (e) => {
        const b = e.target.closest('button[data-uid]'); if (!b) return;
        const m = imgs.find((x) => x.uid === b.dataset.uid);
        closeSheets(); setRef(m);
      };
    } catch (err) { grid.innerHTML = '<div class="empty">' + WR.esc(err.message) + '</div>'; }
  }

  function send() {
    if (state.sending || !state.room) return;
    const text = textEl.value.trim();
    if (!text && !state.attach) { if (state.ref) toast('Type a description for ' + state.ref.uid); return; }
    if (state.ref && !text) return;

    const attach = state.attach;
    const ref = state.ref;
    state.sending = true;
    $('#send-btn').disabled = true;

    const go = async () => {
      if (attach) await attach.previewReady;
      const fd = new FormData();
      fd.append('userId', me.id);
      fd.append('text', text);
      if (ref) fd.append('refUid', ref.uid);
      if (attach) {
        fd.append('image', attach.file, attach.file.name || 'photo.jpg');
        if (attach.preview) fd.append('preview', attach.preview, 'preview.jpg');
      }
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/rooms/' + state.room.code + '/messages');
      const bar = $('#upload-bar'); const fill = $('#upload-fill');
      if (attach) { bar.hidden = false; fill.style.width = '0'; }
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) fill.style.width = (e.loaded / e.total * 100).toFixed(1) + '%'; };
      const msg = await new Promise((resolve, reject) => {
        xhr.onload = () => {
          let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
          xhr.status < 300 ? resolve(data) : reject(new Error(data.error || 'Upload failed (' + xhr.status + ')'));
        };
        xhr.onerror = () => reject(new Error('Network error — message not sent'));
        xhr.send(fd);
      });
      bar.hidden = true;
      return msg;
    };

    go().then((msg) => {
      textEl.value = ''; autoGrow();
      clearAttach(); clearRef();
      addMessages([msg]);
      scrollBottom();
    }).catch((err) => {
      $('#upload-bar').hidden = true;
      toast(err.message);
    }).finally(() => {
      state.sending = false;
      $('#send-btn').disabled = false;
    });
  }
  $('#send-btn').addEventListener('click', send);

  // ------------------------------------------------------------ chat interactions
  function findByUid(uid) { return state.messages.find((m) => m.uid === uid); }

  chat.addEventListener('click', (e) => {
    const photo = e.target.closest('a.photo');
    if (photo) { e.preventDefault(); openLightbox(photo.dataset.photo); return; }
    const ref = e.target.closest('a.ref');
    if (ref) {
      e.preventDefault();
      const el = document.getElementById('m-' + ref.dataset.ref);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
      } else openLightbox(ref.dataset.ref);
    }
  });
  $('#load-older').addEventListener('click', () => loadOlder().catch((e) => toast(e.message)));

  // ------------------------------------------------------------ lightbox
  let lbMsg = null;
  async function openLightbox(uid) {
    const lb = $('#lightbox');
    const local = findByUid(uid);
    lbMsg = local || null;
    $('#lb-uid').textContent = uid;
    $('#lb-by').textContent = local ? local.userName + ' · ' + WR.fmtDateTime(local.createdAt, renderOpts) : '';
    $('#lb-img').src = local ? local.image.url : '';
    $('#lb-download').href = local ? local.image.url : '#';
    $('#lb-desc').innerHTML = '';
    lb.hidden = false;
    history.pushState({ lb: true }, '');
    try {
      const data = await api(roomUrl('/images/' + encodeURIComponent(uid)));
      const m = data.message; lbMsg = m;
      $('#lb-by').textContent = m.userName + ' · ' + WR.fmtDateTime(m.createdAt, renderOpts);
      if (!local) { $('#lb-img').src = m.image.url; }
      $('#lb-download').href = m.image.url;
      $('#lb-download').setAttribute('download', m.uid + (m.image.name && m.image.name.includes('.') ? m.image.name.slice(m.image.name.lastIndexOf('.')) : '.jpg'));
      const items = [];
      if (m.text) items.push({ who: m.userName, when: m.createdAt, text: m.text, uid: m.uid });
      for (const d of data.descriptions) items.push({ who: d.userName, when: d.createdAt, text: d.text, uid: d.uid });
      $('#lb-desc').innerHTML = items.length
        ? items.map((d) => '<div class="d"><small>' + WR.esc(d.who) + ' · ' + WR.esc(WR.fmtDateTime(d.when, renderOpts)) + ' · ' + WR.esc(d.uid) + '</small>' + WR.esc(d.text) + '</div>').join('')
        : '<div class="d"><small>No description yet.</small></div>';
    } catch (err) { $('#lb-desc').textContent = err.message; }
  }
  function closeLightbox(fromPop) {
    if ($('#lightbox').hidden) return;
    $('#lightbox').hidden = true; $('#lb-img').src = '';
    if (!fromPop && history.state && history.state.lb) history.back();
  }
  $('#lb-close').addEventListener('click', () => closeLightbox());
  $('#lb-describe').addEventListener('click', () => { const m = lbMsg; closeLightbox(); if (m) setRef(m); });

  // ------------------------------------------------------------ export
  $('#export-btn').addEventListener('click', () => openSheet('#export-sheet'));
  $('#export-sheet').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-min]'); if (!chip) return;
    const url = roomUrl('/export?minutes=' + chip.dataset.min +
      '&tz=' + encodeURIComponent(renderOpts.tz || '') + '&locale=' + encodeURIComponent(renderOpts.locale || ''));
    const a = document.createElement('a');
    a.href = url; a.download = ''; document.body.appendChild(a); a.click(); a.remove();
    chip.classList.add('busy'); setTimeout(() => chip.classList.remove('busy'), 800);
    toast('Exporting ' + chip.textContent.toLowerCase() + '…');
    closeSheets();
  });

  // ------------------------------------------------------------ room info / invite
  $('#room-info-btn').addEventListener('click', () => {
    const r = state.room;
    $('#info-title').textContent = r.name;
    $('#info-code').textContent = r.code;
    $('#members').innerHTML = r.members.map((m) =>
      '<li><span class="avatar" style="--hue:' + WR.userHue(m.userId) + '">' + WR.esc(m.name.charAt(0).toUpperCase()) + '</span>' +
      WR.esc(m.name) + (m.userId === me.id ? ' <span class="muted">(you)</span>' : '') + '</li>').join('');
    openSheet('#info-sheet');
  });
  $('#share-btn').addEventListener('click', async () => {
    const r = state.room;
    const link = location.origin + '/r/' + r.code;
    const text = 'Join "' + r.name + '" on Workroom — code ' + r.code;
    try {
      if (navigator.share) await navigator.share({ title: 'Workroom', text, url: link });
      else { await navigator.clipboard.writeText(text + '\n' + link); toast('Invite link copied'); }
    } catch { /* cancelled */ }
  });

  // ------------------------------------------------------------ home actions
  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!requireName()) return;
    const code = $('#join-code').value.trim().toUpperCase();
    enterRoom(code).catch((err) => toast(err.message));
  });
  $('#create-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!requireName()) return;
    api('/api/rooms', { method: 'POST', body: { name: $('#create-name').value, userId: me.id, userName: me.name } })
      .then((room) => { $('#create-name').value = ''; openRoom(room); })
      .catch((err) => toast(err.message));
  });
  $('#recent').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-code]'); if (!li) return;
    if (!requireName()) return;
    enterRoom(li.dataset.code).catch((err) => toast(err.message));
  });
  $('#back-btn').addEventListener('click', () => showHome());

  // ------------------------------------------------------------ routing
  function route() {
    const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{4,10})$/);
    const code = m && m[1].toUpperCase();
    if (code && me.name) enterRoom(code).catch((err) => { toast(err.message); showHome(code); });
    else showHome(code);
  }
  window.addEventListener('popstate', () => {
    if (!$('#lightbox').hidden) { closeLightbox(true); return; }
    if (!document.querySelector('.sheet-backdrop:not([hidden])')) route();
    else closeSheets();
  });

  // ------------------------------------------------------------ PWA
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#install-btn').hidden = false; });
  $('#install-btn').addEventListener('click', async () => {
    if (!installEvt) return;
    installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('#install-btn').hidden = true;
  });

  route();
})();
