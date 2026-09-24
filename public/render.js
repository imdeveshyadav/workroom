/*
 * Shared message renderer.
 * Used by the browser (live chat) AND by the server (chat export), so an
 * exported chat is rendered with exactly the same markup + CSS as the app.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WR = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmt(ts, opts, o) {
    try {
      return new Intl.DateTimeFormat(opts.locale || 'en-GB', Object.assign({ timeZone: opts.tz || undefined }, o)).format(new Date(ts));
    } catch (e) {
      return new Intl.DateTimeFormat('en-GB', o).format(new Date(ts));
    }
  }

  function fmtTime(ts, opts) {
    return fmt(ts, opts, { hour: '2-digit', minute: '2-digit' });
  }

  function fmtDay(ts, opts) {
    return fmt(ts, opts, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  }

  function fmtDateTime(ts, opts) {
    return fmtDay(ts, opts) + ', ' + fmtTime(ts, opts);
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  // Stable colour per user so every member is recognisable.
  function userHue(userId) {
    let h = 0;
    for (const c of String(userId)) h = (h * 31 + c.charCodeAt(0)) % 360;
    return h;
  }

  /**
   * @param m     message object (see server toClient())
   * @param prev  previous message or null (for day separators)
   * @param opts  { meId, tz, locale, imgAttr(uid, image, kind) -> attribute string }
   */
  function renderMessage(m, prev, opts) {
    let html = '';
    if (!prev || fmtDay(prev.createdAt, opts) !== fmtDay(m.createdAt, opts)) {
      html += '<div class="day-sep"><span>' + esc(fmtDay(m.createdAt, opts)) + '</span></div>';
    }
    const mine = opts.meId && m.userId === opts.meId;
    const hue = userHue(m.userId);
    // Live chat shows the light preview; the export swaps in the full-resolution original.
    const imgAttr = opts.imgAttr || function (uid, image) { return 'src="' + esc(image.previewUrl || image.url) + '"'; };

    html += '<div class="msg ' + (mine ? 'mine' : 'theirs') + (m.image ? ' has-image' : '') + '" id="m-' + esc(m.uid) + '" data-uid="' + esc(m.uid) + '" data-id="' + m.id + '">';
    html += '<div class="bubble">';
    html += '<div class="meta-top">' +
      '<span class="sender" style="--hue:' + hue + '">' + esc(m.userName) + '</span>' +
      '<span class="uid-badge' + (m.image ? ' img' : '') + '">' + esc(m.uid) + '</span>' +
      '</div>';

    if (m.ref) {
      html += '<a class="ref" href="#m-' + esc(m.ref.uid) + '" data-ref="' + esc(m.ref.uid) + '">' +
        (m.ref.image ? '<img class="ref-thumb" ' + imgAttr(m.ref.uid, m.ref.image, 'thumb') + ' alt="' + esc(m.ref.uid) + '" loading="lazy">' : '') +
        '<span class="ref-body"><span class="ref-label">Describing <b>' + esc(m.ref.uid) + '</b> · ' + esc(m.ref.userName) + '</span>' +
        (m.ref.text ? '<span class="ref-text">' + esc(m.ref.text) + '</span>' : '<span class="ref-text muted">Photo</span>') +
        '</span></a>';
    }

    if (m.image) {
      html += '<a class="photo" href="' + esc(m.image.url) + '" data-photo="' + esc(m.uid) + '" target="_blank" rel="noopener">' +
        '<img ' + imgAttr(m.uid, m.image, 'full') + ' alt="' + esc(m.uid) + '" loading="lazy">' +
        '<span class="photo-id">' + esc(m.uid) + '</span>' +
        '</a>';
    }

    if (m.text) html += '<div class="text">' + esc(m.text) + '</div>';

    html += '<div class="meta-bot">' +
      (m.image ? '<span class="size">' + esc(fmtSize(m.image.size)) + '</span>' : '') +
      '<time datetime="' + new Date(m.createdAt).toISOString() + '">' + esc(fmtTime(m.createdAt, opts)) + '</time>' +
      '</div>';
    html += '</div></div>';
    return html;
  }

  function renderMessages(list, opts) {
    let html = '';
    for (let i = 0; i < list.length; i++) html += renderMessage(list[i], i ? list[i - 1] : null, opts);
    return html;
  }

  return { esc, fmtTime, fmtDay, fmtDateTime, fmtSize, userHue, renderMessage, renderMessages };
});
