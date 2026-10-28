'use strict';
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const IST = 330 * 60000;
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const state = { me: null, status: null, groups: [], picked: new Map(), editingId: null, tab: 'schedule', qrTimer: null };

  // ---------- helpers ----------
  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: { 'X-Requested-With': 'wabox' }, credentials: 'same-origin' };
    if (opts.form) init.body = opts.form;
    else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
    const res = await fetch('api/' + path, init);
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && path !== 'login') { showView('login'); throw new Error(data.error || 'Please log in'); }
    if (res.status === 403 && data.mustChange) { showView('password'); throw new Error(data.error); }
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }
  function toast(msg, bad = false) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : '');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 3500);
  }
  const ist = ms => { const d = new Date(ms + IST); const p = n => String(n).padStart(2, '0');
    return { date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`, dow: d.getUTCDay() }; };
  const fmt = ms => { if (!ms) return ''; const x = ist(ms); return `${DAY_NAMES[x.dow]} ${x.date.slice(8)}/${x.date.slice(5, 7)} ${x.time}`; };
  const fmtTime = ms => ist(ms).time;
  const istEpoch = (date, time) => { const [y, m, d] = date.split('-').map(Number); const [h, mi] = time.split(':').map(Number); return Date.UTC(y, m - 1, d, h, mi) - IST; };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const STATUS_LABEL = { scheduled: 'Scheduled', running: 'Sending', done: 'Done', done_with_errors: 'Done with errors', cancelled: 'Cancelled',
    sent: 'Sent', dry_run: 'Dry run', failed: 'Failed', skipped: 'Skipped', missed: 'Missed', retry: 'Retrying', pending: 'Pending' };

  function confirmDialog(title, html, okLabel = 'OK', danger = false) {
    return new Promise(resolve => {
      const d = $('#dialog');
      $('#dialog-title').textContent = title;
      $('#dialog-content').innerHTML = html;
      $('#dialog-actions').innerHTML = `<button class="btn ghost" value="no">Back</button><button class="btn ${danger ? 'danger' : 'primary'}" value="yes">${esc(okLabel)}</button>`;
      d.onclose = () => resolve(d.returnValue === 'yes');
      d.returnValue = ''; d.showModal();
    });
  }

  // ---------- views ----------
  function showView(v) {
    for (const id of ['login', 'password', 'app']) $('#view-' + id).classList.toggle('hidden', id !== v);
  }
  function showTab(tab) {
    state.tab = tab;
    $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.tab').forEach(s => s.classList.toggle('hidden', s.id !== 'tab-' + tab));
    clearInterval(state.qrTimer);
    ({ upcoming: loadUpcoming, history: loadHistory, templates: loadTemplates, whatsapp: loadWhatsapp, team: loadUsers, settings: loadSettings }[tab] || (() => {}))();
  }

  async function boot() {
    try {
      state.me = await api('me');
    } catch { showView('login'); return; }
    if (state.me.mustChange) { showView('password'); return; }
    showView('app');
    $('#me').textContent = `${state.me.username} · ${state.me.role}`;
    $$('.admin-only').forEach(el => el.classList.toggle('hidden', state.me.role !== 'admin'));
    resetForm();
    await refreshStatus();
    loadGroups();
    setInterval(refreshStatus, 10000);
  }

  // ---------- status ----------
  async function refreshStatus() {
    try { state.status = await api('status'); } catch { return; }
    const s = state.status;
    const pill = $('#wa-pill');
    const map = { ready: ['ok', 'WhatsApp connected'], qr_ready: ['warn', 'Scan QR to connect'], authenticating: ['warn', 'Connecting…'],
      initializing: ['warn', 'Starting…'], created: ['warn', 'Not connected'], disconnected: ['bad', 'Disconnected'],
      failed: ['bad', 'Connection failed'], action_required: ['bad', 'Action needed'], unreachable: ['bad', 'Gateway offline'] };
    const [cls, label] = map[s.wa.status] || ['warn', s.wa.status];
    pill.className = 'pill ' + cls;
    pill.textContent = label + (s.wa.status === 'ready' && s.wa.name ? ` · ${s.wa.name}` : '');

    const b = [];
    if (s.dryRun) b.push(['warn', 'Dry run is ON — jobs run on schedule but nothing is actually sent to WhatsApp.' + (state.me.role === 'admin' ? ' Turn it off in Settings when you\'re ready.' : '')]);
    if (s.paused) b.push(['warn', 'Sending is paused by an admin. Scheduled jobs will wait.']);
    if (s.wa.status !== 'ready') b.push(['bad', 'WhatsApp is not connected, so nothing can be sent right now.' + (state.me.role === 'admin' ? ' Open the WhatsApp tab to connect.' : ' Ask an admin to reconnect.')]);
    if (s.running) b.push(['info', `Sending “${s.running.title || 'job #' + s.running.id}” now` + (s.running.group ? ` → ${s.running.group}` : '') +
      (s.running.nextSendAt ? ` · next group at ${fmtTime(s.running.nextSendAt)}` : '')]);
    b.push(['ok', `${s.sentToday}/${s.dailyCap} messages sent today`]);
    $('#banners').innerHTML = b.map(([c, t]) => `<div class="banner ${c}">${esc(t)}</div>`).join('');
    if (state.tab === 'upcoming') loadUpcoming(true);
  }
  $('#wa-pill').addEventListener('click', () => { if (state.me?.role === 'admin') showTab('whatsapp'); });

  // ---------- auth ----------
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    $('#login-error').textContent = '';
    try {
      await api('login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
      e.target.reset(); boot();
    } catch (err) { $('#login-error').textContent = err.message; }
  });
  $('#password-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    $('#password-error').textContent = '';
    if (f.get('next') !== f.get('again')) { $('#password-error').textContent = 'New passwords do not match'; return; }
    try {
      await api('password', { method: 'POST', body: { current: f.get('current'), next: f.get('next') } });
      e.target.reset(); toast('Password saved'); boot();
    } catch (err) { $('#password-error').textContent = err.message; }
  });
  $('#logout').addEventListener('click', async () => { try { await api('logout', { method: 'POST' }); } catch { } location.reload(); });
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });

  // ---------- groups picker ----------
  async function loadGroups(refresh = false) {
    $('#groups-note').textContent = 'Loading groups…';
    try {
      const r = await api('groups' + (refresh ? '?refresh=1' : ''));
      state.groups = r.groups;
      $('#groups-note').textContent = r.stale ? 'WhatsApp not connected — list may be out of date.' : `${r.groups.length} groups`;
    } catch (err) { $('#groups-note').textContent = err.message; }
    renderGroups();
  }
  function renderGroups() {
    const q = $('#group-search').value.trim().toLowerCase();
    const shown = state.groups.filter(g => !q || g.name.toLowerCase().includes(q));
    $('#group-list').innerHTML = shown.length
      ? shown.map(g => `<label><input type="checkbox" data-id="${esc(g.id)}" ${state.picked.has(g.id) ? 'checked' : ''}> ${esc(g.name)}</label>`).join('')
      : `<div class="empty">${state.groups.length ? 'No group matches that search.' : 'No groups yet. Connect WhatsApp, then press “Refresh list”.'}</div>`;
    $('#group-chips').innerHTML = [...state.picked.values()].map(g => `<span class="chip">${esc(g.name)}<button type="button" data-remove="${esc(g.id)}" aria-label="Remove ${esc(g.name)}">×</button></span>`).join('');
    $('#group-picked').textContent = state.picked.size;
    updatePreview();
  }
  $('#group-search').addEventListener('input', renderGroups);
  $('#group-list').addEventListener('change', e => {
    const id = e.target.dataset.id; if (!id) return;
    const g = state.groups.find(x => x.id === id);
    if (e.target.checked) state.picked.set(id, g); else state.picked.delete(id);
    renderGroups();
  });
  $('#group-chips').addEventListener('click', e => { const id = e.target.dataset.remove; if (id) { state.picked.delete(id); renderGroups(); } });
  $('#groups-all').addEventListener('click', () => {
    const q = $('#group-search').value.trim().toLowerCase();
    state.groups.filter(g => !q || g.name.toLowerCase().includes(q)).forEach(g => state.picked.set(g.id, g));
    renderGroups();
  });
  $('#groups-none').addEventListener('click', () => { state.picked.clear(); renderGroups(); });
  $('#groups-refresh').addEventListener('click', () => loadGroups(true));

  // ---------- job form ----------
  const form = $('#job-form');
  function tomorrow() { return ist(Date.now() + 86400000).date; }
  function nextDow(dow) { for (let i = 1; i <= 7; i++) { const x = ist(Date.now() + i * 86400000); if (x.dow === dow) return x.date; } }

  function resetForm() {
    form.reset();
    state.editingId = null; state.picked.clear();
    form.date.value = tomorrow(); form.time.value = '10:00';
    $('#job-form-title').textContent = 'New scheduled message';
    $('#job-submit').textContent = 'Schedule message';
    $('#cancel-edit').classList.add('hidden');
    $('#remove-image-wrap').classList.add('hidden');
    $('#job-error').textContent = '';
    $('#msg-count').textContent = '0';
    renderGroups();
  }
  $('#cancel-edit').addEventListener('click', resetForm);
  form.message.addEventListener('input', () => { $('#msg-count').textContent = form.message.value.length; });
  ['date', 'time', 'gapMin', 'gapMax'].forEach(n => form[n].addEventListener('input', updatePreview));
  $('.quick').addEventListener('click', e => {
    const q = e.target.dataset.quick; if (!q) return;
    form.date.value = q === 'tomorrow' ? tomorrow() : nextDow({ thu: 4, fri: 5, sat: 6, sun: 0 }[q]);
    updatePreview();
  });
  $('#repeat-days').addEventListener('change', updatePreview);

  function repeatDays() { return $$('#repeat-days input:checked').map(i => Number(i.value)); }

  function updatePreview() {
    const n = state.picked.size;
    const el = $('#job-preview');
    if (!n || !form.date.value || !form.time.value) { el.textContent = 'Pick groups and a time to see the send window.'; return; }
    const start = istEpoch(form.date.value, form.time.value);
    const gMin = Math.max(30, Number(form.gapMin.value) || 30), gMax = Math.max(gMin, Number(form.gapMax.value) || gMin);
    const avg = (gMin + gMax) / 2 + 5;
    const end = start + (n - 1) * avg * 1000 + 60000;
    const past = start < Date.now() - 60000;
    const days = repeatDays();
    el.innerHTML = `<b>${plural(n, 'group')}</b> · starts ${esc(fmt(start))} IST (± up to 1 min)` +
      (n > 1 ? ` · finishes around <b>${esc(fmtTime(end))}</b>` : '') +
      (days.length ? ` · repeats every ${esc(days.map(d => DAY_NAMES[d]).join(', '))}` : '') +
      (past ? `<br><span class="form-error">That time is already past.</span>` : '') +
      (state.status && n > state.status.dailyCap ? `<br>More than the daily limit (${state.status.dailyCap}); the rest will go out tomorrow.` : '');
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    $('#job-error').textContent = '';
    if (!state.picked.size) { $('#job-error').textContent = 'Pick at least one group'; return; }
    const fd = new FormData();
    fd.set('title', form.title.value);
    fd.set('message', form.message.value);
    fd.set('groups', JSON.stringify([...state.picked.keys()]));
    fd.set('date', form.date.value); fd.set('time', form.time.value);
    fd.set('gapMin', form.gapMin.value); fd.set('gapMax', form.gapMax.value);
    fd.set('repeatDays', JSON.stringify(repeatDays()));
    if (form.image.files[0]) fd.set('image', form.image.files[0]);
    if (form.removeImage.checked) fd.set('removeImage', '1');
    const btn = $('#job-submit'); btn.disabled = true;
    try {
      if (state.editingId) await api('jobs/' + state.editingId, { method: 'PUT', form: fd });
      else await api('jobs', { method: 'POST', form: fd });
      toast(state.editingId ? 'Changes saved' : 'Scheduled ✓');
      resetForm(); showTab('upcoming');
    } catch (err) { $('#job-error').textContent = err.message; }
    finally { btn.disabled = false; }
  });

  function editJob(job) {
    showTab('schedule');
    resetForm();
    state.editingId = job.id;
    form.title.value = job.title; form.message.value = job.message;
    $('#msg-count').textContent = job.message.length;
    form.date.value = job.date; form.time.value = job.time;
    form.gapMin.value = job.gapMin; form.gapMax.value = job.gapMax;
    $$('#repeat-days input').forEach(i => { i.checked = job.repeatDays.includes(Number(i.value)); });
    job.groups.forEach(g => state.picked.set(g.id, g));
    $('#remove-image-wrap').classList.toggle('hidden', !job.hasImage);
    $('#job-form-title').textContent = `Edit job #${job.id}`;
    $('#job-submit').textContent = 'Save changes';
    $('#cancel-edit').classList.remove('hidden');
    renderGroups();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- templates ----------
  $('#tpl-save').addEventListener('click', async () => {
    const message = form.message.value.trim();
    if (!message) { toast('Write a message first', true); return; }
    const ok = await confirmDialog('Save as template', '<label>Template name<input id="tpl-name" maxlength="60" autofocus></label>', 'Save');
    if (!ok) return;
    const name = $('#tpl-name').value.trim();
    if (!name) { toast('Give it a name', true); return; }
    try { await api('templates', { method: 'POST', body: { name, message } }); toast('Template saved'); } catch (err) { toast(err.message, true); }
  });
  $('#tpl-load').addEventListener('click', async () => {
    let list = [];
    try { list = (await api('templates')).templates; } catch (err) { toast(err.message, true); return; }
    if (!list.length) { toast('No templates yet. Use “Save as template” first.'); return; }
    const d = $('#dialog');
    $('#dialog-title').textContent = 'Use a template';
    $('#dialog-content').innerHTML = `<div class="stack">${list.map(t => `<button type="button" class="tpl" data-id="${t.id}"><b>${esc(t.name)}</b><span>${esc(t.message)}</span></button>`).join('')}</div>`;
    $('#dialog-actions').innerHTML = '<button class="btn ghost" value="no">Close</button>';
    $('#dialog-content').onclick = e => {
      const b = e.target.closest('.tpl'); if (!b) return;
      const t = list.find(x => String(x.id) === b.dataset.id);
      form.message.value = t.message; $('#msg-count').textContent = t.message.length; d.close();
    };
    d.onclose = null; d.showModal();
  });
  async function loadTemplates() {
    const el = $('#templates-list');
    try {
      const { templates } = await api('templates');
      el.innerHTML = templates.length ? templates.map(t => `<div class="tpl-row"><button type="button" class="tpl" data-use="${t.id}"><b>${esc(t.name)}</b><span>${esc(t.message)}</span></button>
        <button type="button" class="btn ghost small danger" data-del="${t.id}">Delete</button></div>`).join('') : '<div class="empty-state">No templates yet.</div>';
      el.onclick = async e => {
        const use = e.target.closest('[data-use]'), del = e.target.closest('[data-del]');
        if (use) { const t = templates.find(x => String(x.id) === use.dataset.use); showTab('schedule'); resetForm(); form.message.value = t.message; $('#msg-count').textContent = t.message.length; }
        if (del && await confirmDialog('Delete template?', '', 'Delete', true)) { await api('templates/' + del.dataset.del, { method: 'DELETE' }); loadTemplates(); }
      };
    } catch (err) { el.innerHTML = `<p class="form-error">${esc(err.message)}</p>`; }
  }

  // ---------- upcoming ----------
  function jobCard(j, actions) {
    const sendsById = new Map(j.sends.map(s => [s.group_id, s]));
    const repeat = j.repeatDays.length ? ` · every ${j.repeatDays.map(d => DAY_NAMES[d]).join(', ')}` : '';
    const done = j.sends.filter(s => ['sent', 'dry_run'].includes(s.status)).length;
    return `<article class="job" data-id="${j.id}">
      <div class="job-top">
        <div><div class="job-when">${esc(fmt(j.runAt))} IST</div>
          <div class="muted small">${esc(j.title || 'Job #' + j.id)} · ${plural(j.groups.length, 'group')} · gaps ${j.gapMin}–${j.gapMax}s${esc(repeat)} · by ${esc(j.createdBy)}${j.updatedBy !== j.createdBy ? ', edited by ' + esc(j.updatedBy) : ''}</div></div>
        <span class="badge ${j.status}">${esc(STATUS_LABEL[j.status] || j.status)}${j.status === 'running' ? ` ${done}/${j.groups.length}` : ''}</span>
      </div>
      ${j.note ? `<div class="job-note">${esc(j.note)}</div>` : ''}
      <div class="row">${j.hasImage ? `<img class="job-thumb" src="api/jobs/${j.id}/image" alt="Attached image">` : ''}<div class="job-msg grow">${esc(j.message)}</div></div>
      <div class="job-groups">${j.groups.map(g => { const s = sendsById.get(g.id); return `<span class="g ${s ? s.status : ''}" title="${esc(s?.error || (s ? STATUS_LABEL[s.status] : 'Waiting'))}">${esc(g.name)}${s ? ' · ' + esc(STATUS_LABEL[s.status]) : ''}</span>`; }).join('')}</div>
      ${actions ? `<div class="row end">${actions}</div>` : ''}
    </article>`;
  }
  let upcomingCache = [];
  async function loadUpcoming(quiet = false) {
    const el = $('#upcoming-list');
    try {
      const { jobs } = await api('jobs?view=upcoming');
      upcomingCache = jobs;
      $('#upcoming-count').textContent = jobs.length || '';
      if (quiet && document.activeElement && el.contains(document.activeElement)) return;
      el.innerHTML = jobs.length ? jobs.map(j => jobCard(j, j.status === 'scheduled'
        ? `<button class="btn ghost small" data-act="edit">Edit</button><button class="btn ghost small" data-act="now">Send now</button><button class="btn ghost small danger" data-act="cancel">Cancel</button>`
        : `<button class="btn ghost small danger" data-act="cancel">Stop</button>`)).join('')
        : `<div class="empty-state">Nothing scheduled. <button class="link" data-act="new">Schedule a message</button></div>`;
    } catch (err) { if (!quiet) el.innerHTML = `<p class="form-error">${esc(err.message)}</p>`; }
  }
  $('#upcoming-list').addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'new') { showTab('schedule'); return; }
    const id = Number(b.closest('.job').dataset.id);
    const job = upcomingCache.find(j => j.id === id);
    try {
      if (b.dataset.act === 'edit') editJob(job);
      if (b.dataset.act === 'now' && await confirmDialog('Send now?', `<p>Start sending to ${plural(job.groups.length, 'group')} now, with the same random gaps.${job.repeatDays.length ? ' This counts as its next weekly send; the repeat continues after that.' : ''}</p>`, 'Send now')) {
        await api(`jobs/${id}/send-now`, { method: 'POST' }); toast('Starting within a minute'); loadUpcoming();
      }
      if (b.dataset.act === 'cancel' && await confirmDialog('Cancel this job?', `<p>Groups already sent to stay sent; the rest won't be sent.${job.repeatDays.length ? ' This also stops the weekly repeat.' : ''}</p>`, 'Cancel job', true)) {
        await api(`jobs/${id}/cancel`, { method: 'POST' }); toast('Cancelled'); loadUpcoming();
      }
    } catch (err) { toast(err.message, true); }
  });

  // ---------- history ----------
  async function loadHistory() {
    try {
      const [{ sends }, { jobs }] = await Promise.all([api('sends'), api('jobs?view=history')]);
      $('#history-table tbody').innerHTML = sends.length ? sends.map(s => `<tr><td>${esc(fmt(s.at))}</td><td>${esc(s.group)}</td>
        <td>${esc(s.title ? s.title + ': ' : '')}${esc(s.preview)}</td><td><span class="badge ${s.status}">${esc(STATUS_LABEL[s.status] || s.status)}</span>${s.error ? `<span class="err">${esc(s.error)}</span>` : ''}</td></tr>`).join('')
        : '<tr><td colspan="4" class="muted">Nothing sent yet.</td></tr>';
      $('#past-jobs').innerHTML = jobs.length ? jobs.map(j => jobCard(j)).join('') : '<p class="muted">None yet.</p>';
    } catch (err) { toast(err.message, true); }
  }
  $('#history-reload').addEventListener('click', loadHistory);

  // ---------- WhatsApp (admin) ----------
  async function loadWhatsapp() {
    await refreshStatus();
    const s = state.status?.wa || {};
    $('#wa-detail').innerHTML = s.status === 'ready'
      ? `<div class="banner ok">Connected as ${esc(s.name || '')} ${s.phone ? '(+' + esc(s.phone) + ')' : ''}. You're all set.</div>`
      : `<div class="banner warn">Status: ${esc(s.status)}${s.error ? ' — ' + esc(s.error) : ''}</div>`;
    $('#qr-wrap').classList.add('hidden');
    if (s.status !== 'ready') pollQr();
  }
  async function pollQr() {
    clearInterval(state.qrTimer);
    const tick = async () => {
      if (state.tab !== 'whatsapp') { clearInterval(state.qrTimer); return; }
      try {
        const r = await api('wa/qr');
        if (r.qrCode) { $('#qr-img').src = r.qrCode; $('#qr-wrap').classList.remove('hidden'); }
        else $('#qr-wrap').classList.add('hidden');
        await refreshStatus();
        if (state.status.wa.status === 'ready') { clearInterval(state.qrTimer); toast('WhatsApp connected ✓'); loadWhatsapp(); loadGroups(true); }
      } catch { /* keep polling */ }
    };
    tick(); state.qrTimer = setInterval(tick, 4000);
  }
  $('#wa-connect').addEventListener('click', async () => {
    try { await api('wa/start', { method: 'POST' }); toast('Starting WhatsApp… the QR appears in a few seconds'); pollQr(); } catch (err) { toast(err.message, true); }
  });
  $('#wa-logout').addEventListener('click', async () => {
    if (!await confirmDialog('Unlink WhatsApp?', '<p>The server is removed from this phone\'s Linked devices. Nothing sends until someone scans the QR again.</p>', 'Unlink', true)) return;
    try { await api('wa/logout', { method: 'POST' }); toast('Unlinked'); loadWhatsapp(); } catch (err) { toast(err.message, true); }
  });

  // ---------- team (admin) ----------
  async function loadUsers() {
    try {
      const { users } = await api('users');
      $('#users-table tbody').innerHTML = users.map(u => `<tr data-id="${u.id}"><td><b>${esc(u.username)}</b></td><td>${esc(u.role)}</td>
        <td>${u.disabled ? '<span class="badge cancelled">Disabled</span>' : u.must_change ? '<span class="badge">Must set password</span>' : '<span class="badge done">Active</span>'}</td>
        <td class="row end"><button class="btn ghost small" data-act="reset">Reset password</button>
        <button class="btn ghost small ${u.disabled ? '' : 'danger'}" data-act="${u.disabled ? 'enable' : 'disable'}">${u.disabled ? 'Enable' : 'Disable'}</button></td></tr>`).join('');
    } catch (err) { toast(err.message, true); }
  }
  $('#users-table').addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const id = b.closest('tr').dataset.id;
    try {
      if (b.dataset.act === 'reset') {
        if (!await confirmDialog('Reset password', '<label>New temporary password (10+ characters)<input id="reset-pw" minlength="10" autocomplete="off"></label>', 'Reset')) return;
        await api(`users/${id}/reset`, { method: 'POST', body: { password: $('#reset-pw').value } }); toast('Password reset; they must change it at next login');
      } else {
        await api(`users/${id}/disable`, { method: 'POST', body: { disabled: b.dataset.act === 'disable' } }); toast('Updated');
      }
      loadUsers();
    } catch (err) { toast(err.message, true); }
  });
  $('#user-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    $('#user-error').textContent = '';
    try { await api('users', { method: 'POST', body: Object.fromEntries(f) }); e.target.reset(); toast('Person added'); loadUsers(); }
    catch (err) { $('#user-error').textContent = err.message; }
  });

  // ---------- settings (admin) ----------
  async function loadSettings() {
    await refreshStatus();
    const s = state.status, f = $('#settings-form');
    f.dryRun.checked = s.dryRun; f.paused.checked = s.paused; f.dailyCap.value = s.dailyCap; f.maxLateMin.value = s.maxLateMin;
    try {
      const { audit } = await api('audit');
      $('#audit-table tbody').innerHTML = audit.map(a => `<tr><td>${esc(fmt(a.at))}</td><td>${esc(a.actor)}</td><td>${esc(a.action.replace(/_/g, ' '))} <span class="muted">${esc(a.detail)}</span></td></tr>`).join('');
    } catch { /* ignore */ }
  }
  $('#settings-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    $('#settings-error').textContent = '';
    if (!f.dryRun.checked && state.status.dryRun &&
        !await confirmDialog('Go live?', '<p>Turning dry run off means scheduled jobs will <b>really send</b> to WhatsApp groups.</p>', 'Go live')) return;
    try {
      await api('settings', { method: 'PUT', body: { dryRun: f.dryRun.checked, paused: f.paused.checked, dailyCap: Number(f.dailyCap.value), maxLateMin: Number(f.maxLateMin.value) } });
      toast('Settings saved'); loadSettings();
    } catch (err) { $('#settings-error').textContent = err.message; }
  });

  boot();
})();
