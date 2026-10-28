'use strict';
(() => {
  // ============ helpers ============
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const IST = 330 * 60000, DAY = 86400000;
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const pad = n => String(n).padStart(2, '0');
  const ist = ms => { const d = new Date(ms + IST); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay(),
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` }; };
  const istEpoch = (date, time) => { const [y, m, d] = date.split('-').map(Number); const [h, mi] = time.split(':').map(Number); return Date.UTC(y, m - 1, d, h, mi) - IST; };
  const todayKey = () => ist(Date.now()).date;
  const shortDate = ms => { const x = ist(ms); return `${DOW[x.dow]} ${x.d} ${MON[x.m]}`; };
  const relDay = ms => { const k = ist(ms).date; if (k === todayKey()) return 'Today'; if (k === ist(Date.now() + DAY).date) return 'Tomorrow'; if (k === ist(Date.now() - DAY).date) return 'Yesterday'; return null; };
  const whenLabel = ms => `${relDay(ms) || shortDate(ms)}, ${ist(ms).time}`;
  const plural = (n, w, p) => `${n} ${n === 1 ? w : (p || w + 's')}`;
  const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  const dur = s => s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
  const firstLine = t => (String(t || '').split('\n').find(l => l.trim()) || '').replace(/[*_~`]/g, '').trim();
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const jobName = j => j.title || firstLine(j.message) || `Message #${j.id}`;
  const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } } };
  const ICON = {
    warn: '<svg viewBox="0 0 24 24"><path d="M12 4 3 20h18z"/><path d="M12 10v4M12 17h.01"/></svg>',
    ok: '<svg viewBox="0 0 24 24"><path d="m5 12 4.5 4.5L19 7"/></svg>',
    users: '<svg viewBox="0 0 24 24"><circle cx="9" cy="9" r="3"/><path d="M3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5"/></svg>',
    repeat: '<svg viewBox="0 0 24 24"><path d="M17 3l3 3-3 3"/><path d="M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3"/><path d="M20 13v2a3 3 0 0 1-3 3H4"/></svg>',
    img: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="m5 18 5-5 3 3 2-2 4 4"/></svg>',
    user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1-3.6 3.8-5.5 7-5.5s6 1.9 7 5.5"/></svg>',
  };
  const STATUS = { scheduled: 'Scheduled', running: 'Sending', done: 'Done', done_with_errors: 'Done, with errors', cancelled: 'Cancelled',
    sent: 'Sent', dry_run: 'Practice', failed: 'Failed', skipped: 'Skipped', missed: 'Missed', retry: 'Retrying', pending: 'Waiting',
    sending: 'Sending', uncertain: 'Checking', unconfirmed: 'Unconfirmed', blocked_duplicate: 'Duplicate blocked' };
  const pill = s => `<span class="pill ${esc(s)}">${esc(STATUS[s] || s)}</span>`;

  // WhatsApp-style formatting for the preview: *bold* _italic_ ~strike~ ```mono``` `code`,
  // "- " / "* " bullets, "1. " numbered lists, "> " quotes, and links.
  function waInline(t) {
    const rule = (ch, tag) => { const c = ch.replace(/[*~]/g, '\\$&'); return [new RegExp(`(^|[\\s(\\[{"'])${c}(?!\\s)([^${c}\\n]*?[^\\s${c}])${c}(?=$|[\\s).,!?:;\\]}"'])`, 'g'), `$1<${tag}>$2</${tag}>`]; };
    t = t.replace(/`([^`\n]+)`/g, '<span class="ic">$1</span>');
    for (const [re, rep] of [rule('*', 'b'), rule('_', 'i'), rule('~', 's')]) t = t.replace(re, rep);
    return t.replace(/(https?:\/\/[^\s<]+[^\s<.,!?)])/g, '<a>$1</a>');
  }
  function waFormat(text) {
    const parts = esc(text).split(/```/);
    return parts.map((chunk, i) => i % 2 ? `<code>${chunk}</code>` : chunk.split('\n').map(line => {
      let m;
      if ((m = line.match(/^&gt; ?(.*)$/))) return `<span class="q">${waInline(m[1]) || '&nbsp;'}</span>`;
      if ((m = line.match(/^[*-] (.+)$/))) return `<span class="li">• ${waInline(m[1])}</span>`;
      if ((m = line.match(/^(\d{1,2})\. (.+)$/))) return `<span class="li">${m[1]}. ${waInline(m[2])}</span>`;
      return waInline(line);
    }).join('\n')).join('');
  }

  // Placeholders + date sense-check live in lib.js (shared with the test suite).
  const { renderMessage, hasPlaceholders, unknownPlaceholders, dateSense, nextDateWithDow, DAYS_FULL } = window.WABoxLib;

  // ============ state + API ============
  const S = { me: null, status: null, groups: [], sync: null, lists: [], templates: [], upcoming: [], past: [], sends: [],
    view: null, params: {}, compose: null, schedFilter: 'upcoming', sentFilter: 'all', qrTimer: null, drawerJob: null };

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: { 'X-Requested-With': 'wabox' }, credentials: 'same-origin' };
    if (opts.form) init.body = opts.form;
    else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
    let res;
    try { res = await fetch('api/' + path, init); }
    catch { throw new Error("Can't reach WA Box. Check your internet connection."); }
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401 && path !== 'login') {
      if (S.me) { S.me = null; $('#login-error').textContent = 'Your session ended. Sign in again.'; }
      showScreen('login'); throw new Error(data.error || 'Please sign in');
    }
    if (res.status === 403 && data.mustChange) { showScreen('password'); throw new Error(data.error); }
    if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status})`);
    return data;
  }
  function toast(msg, bad = false) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : '');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 3800);
  }
  function dialog({ title, html = '', ok = 'OK', cancel = 'Cancel', danger = false, onOpen }) {
    return new Promise(resolve => {
      const d = $('#dialog');
      $('#dialog-title').textContent = title;
      $('#dialog-content').innerHTML = html; $('#dialog-content').onclick = null;
      $('#dialog-actions').innerHTML = (cancel ? `<button class="btn btn-ghost" value="no">${esc(cancel)}</button>` : '') +
        (ok ? `<button class="btn ${danger ? 'btn-danger-ghost' : 'btn-primary'}" value="yes">${esc(ok)}</button>` : '');
      d.onclose = () => resolve(d.returnValue === 'yes');
      d.returnValue = ''; d.showModal();
      onOpen && onOpen(d);
    });
  }
  const isAdmin = () => S.me?.role === 'admin';

  // ============ screens & routing ============
  function showScreen(name) { for (const id of ['login', 'password', 'app']) $('#view-' + id).classList.toggle('hidden', id !== name); }
  const ADMIN_VIEWS = new Set(['whatsapp', 'team', 'settings', 'system']);
  function parseHash() {
    const [v, q] = location.hash.replace(/^#/, '').split('?');
    return { view: v || 'today', params: Object.fromEntries(new URLSearchParams(q || '')) };
  }
  async function route() {
    if (!S.me) return;
    let { view, params } = parseHash();
    if (!$(`.view[data-view="${view}"]`) || (ADMIN_VIEWS.has(view) && !isAdmin())) view = 'today';
    if (S.view === 'compose' && view !== 'compose' && S.compose?.dirty && S.compose.mode !== 'new') {
      if (!await dialog({ title: 'Leave without saving?', html: '<p>Your changes to this message will be lost.</p>', ok: 'Leave', cancel: 'Keep editing', danger: true })) {
        history.replaceState(null, '', '#' + 'compose' + (S.composeQuery || '')); return;
      }
    }
    S.view = view; S.params = params;
    $$('.view').forEach(v => v.classList.toggle('on', v.dataset.view === view));
    $$('.nav a').forEach(a => a.classList.toggle('on', a.dataset.view === view || (view === 'compose' && false)));
    closeMenu(); closeDrawer(); clearInterval(S.qrTimer);
    window.scrollTo(0, 0);
    const render = { today: renderToday, compose: openCompose, scheduled: renderScheduled, sent: renderSent, templates: renderTemplates,
      lists: renderLists, whatsapp: renderWhatsapp, team: renderTeam, settings: renderSettings, system: renderSystem }[view];
    render && render();
  }
  window.addEventListener('hashchange', route);

  function closeMenu() { $('#rail').classList.remove('open'); $('#scrim').classList.remove('open'); }
  $('#menu-open').addEventListener('click', () => { $('#rail').classList.add('open'); $('#scrim').classList.add('open'); });
  $('#scrim').addEventListener('click', closeMenu);

  // ============ boot / auth ============
  async function boot() {
    try { S.me = await api('me'); } catch { showScreen('login'); return; }
    if (S.me.mustChange) { showScreen('password'); return; }
    showScreen('app');
    const name = S.me.username.split('@')[0];
    $('#me-name').textContent = S.me.username;
    $('#me-role').textContent = S.me.role;
    $('#me-avatar').textContent = name.slice(0, 1).toUpperCase();
    $$('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin()));
    await Promise.all([refreshStatus(), loadGroups(), loadJobs(), loadLists()]);
    route();
    clearInterval(S.tick);
    S.tick = setInterval(async () => {
      await refreshStatus(); await loadJobs();
      if (document.activeElement && $('#main').contains(document.activeElement) && S.view !== 'today') return;
      if (S.view === 'today') renderToday();
      if (S.view === 'scheduled') renderScheduled();
      if (S.drawerJob) { const j = findJob(S.drawerJob); if (j) fillDrawer(j); }
    }, 15000);
  }
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target); $('#login-error').textContent = '';
    const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
    try { await api('login', { method: 'POST', body: { username: f.get('username').trim(), password: f.get('password') } }); e.target.reset(); boot(); }
    catch (err) { $('#login-error').textContent = err.message; }
    finally { btn.disabled = false; }
  });
  $('#password-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target); $('#password-error').textContent = '';
    if (f.get('next') !== f.get('again')) { $('#password-error').textContent = "The new passwords don't match."; return; }
    try { await api('password', { method: 'POST', body: { current: f.get('current'), next: f.get('next') } }); e.target.reset(); toast('Password saved'); boot(); }
    catch (err) { $('#password-error').textContent = err.message; }
  });
  $('#logout').addEventListener('click', async () => {
    if (S.compose?.dirty && S.compose.mode !== 'new' && !await dialog({ title: 'Sign out?', html: '<p>Unsaved changes to this message will be lost.</p>', ok: 'Sign out', danger: true })) return;
    try { await api('logout', { method: 'POST' }); } catch { /* ignore */ }
    location.hash = ''; location.reload();
  });

  // ============ data ============
  async function refreshStatus() {
    try { S.status = await api('status'); } catch { return; }
    const s = S.status, wa = s.wa.status;
    const conn = { ready: ['ok', 'WhatsApp connected'], qr_ready: ['warn', 'Waiting for QR scan'], authenticating: ['warn', 'Connecting…'],
      initializing: ['warn', 'Starting WhatsApp…'], created: ['warn', 'Not connected'], disconnected: ['bad', 'Disconnected'],
      failed: ['bad', 'Connection failed'], action_required: ['bad', 'Needs attention'], unreachable: ['bad', 'Gateway offline'], unknown: ['warn', 'Checking…'] }[wa] || ['warn', wa];
    $('#conn-dot').className = 'dot ' + conn[0];
    $('#conn-title').textContent = conn[1];
    $('#conn-sub').textContent = wa === 'ready' ? [s.wa.name, s.wa.phone ? '+' + s.wa.phone : ''].filter(Boolean).join(' · ') : (isAdmin() ? 'Open to connect' : 'Ask an admin to connect');
    $('#conn').setAttribute('href', isAdmin() ? '#whatsapp' : '#today');

    const a = [];
    if (wa !== 'ready' && wa !== 'unknown') a.push(['bad', "WhatsApp isn't connected. Scheduled messages will wait until it is.", isAdmin() ? ['Connect', '#whatsapp'] : null]);
    if (s.paused) a.push(['warn', 'Sending is paused. Scheduled messages are waiting.', isAdmin() ? ['Resume', 'resume'] : null]);
    if (s.dryRun) a.push(['warn', "Practice mode is on. Messages run on schedule but don't reach WhatsApp.", isAdmin() ? ['Go live', '#settings'] : null]);
    if (s.issues && isAdmin() && S.view !== 'system') a.push(['bad', `${plural(s.issues, 'issue')} ${s.issues === 1 ? 'needs' : 'need'} attention.`, ['Open System & logs', '#system']]);
    $('#count-issues').textContent = isAdmin() && s.issues ? s.issues : '';
    $('#alerts').innerHTML = a.map(([c, t, act], i) => `<div class="alert ${c}">${ICON.warn}<span>${esc(t)}</span><span class="spacer"></span>${act ? (act[1].startsWith('#') ? `<a class="btn btn-ghost" href="${act[1]}">${esc(act[0])}</a>` : `<button class="btn btn-ghost" data-alert="${esc(act[1])}">${esc(act[0])}</button>`) : ''}</div>`).join('');
  }
  $('#alerts').addEventListener('click', async e => {
    const b = e.target.closest('[data-alert]'); if (!b) return;
    if (b.dataset.alert === 'resume') { try { await api('settings', { method: 'PUT', body: { paused: false } }); toast('Sending resumed'); refreshStatus(); } catch (err) { toast(err.message, true); } }
  });

  async function loadGroups() {
    try { const r = await api('groups'); S.groups = r.groups; S.sync = r.sync; } catch { /* keep old */ }
    clearTimeout(S.syncPoll);
    if (S.sync?.running) S.syncPoll = setTimeout(async () => { await loadGroups(); if (S.view === 'compose') renderPicker(); if (S.view === 'whatsapp') renderSyncDetail(); }, 4000);
  }
  async function loadJobs() {
    try {
      const [u, p] = await Promise.all([api('jobs?view=upcoming'), api('jobs?view=history')]);
      S.upcoming = u.jobs; S.past = p.jobs;
    } catch { return; }
    $('#count-scheduled').textContent = S.upcoming.length || '';
    const failed = S.past.filter(j => j.status === 'done_with_errors' && Date.now() - j.updatedAt < 7 * DAY).length;
    $('#count-failed').textContent = failed || '';
  }
  async function loadLists() { try { S.lists = (await api('lists')).lists; } catch { /* keep */ } }
  async function loadTemplates() { try { S.templates = (await api('templates')).templates; } catch { /* keep */ } }
  const findJob = id => S.upcoming.find(j => j.id === id) || S.past.find(j => j.id === id);
  const pacingLabel = j => `${dur(j.gapMin)}–${dur(j.gapMax)} between groups`;
  const repeatLabel = days => days.length === 7 ? 'every day' : [1, 2, 3, 4, 5, 6, 0].filter(d => days.includes(d)).map(d => DOW[d]).join(', ');

  // ============ Today ============
  function renderToday() {
    const now = Date.now(), t = ist(now);
    const h = new Date(now + IST).getUTCHours();
    $('#today-title').textContent = `${h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'}`;
    $('#today-date').textContent = `${DOW_LONG[t.dow]}, ${t.d} ${MON_LONG[t.m]}. Times are India time.`;
    const s = S.status || { wa: {}, sentToday: 0, dailyCap: 30 };
    const live = s.paused ? ['warn', 'Paused'] : s.dryRun ? ['warn', 'Practice mode'] : ['ok', 'Live'];
    const waOk = s.wa.status === 'ready';
    $('#statusline').innerHTML = `
      <a class="stat" href="${isAdmin() ? '#whatsapp' : '#today'}"><small>WhatsApp</small><b><span class="dot ${waOk ? 'ok' : 'bad'}"></span>${waOk ? esc(s.wa.name || 'Connected') : 'Not connected'}</b></a>
      <a class="stat" href="${isAdmin() ? '#settings' : '#today'}"><small>Sending</small><b><span class="dot ${live[0]}"></span>${live[1]}</b></a>
      <a class="stat" href="#sent"><small>Sent today</small><b class="num">${s.sentToday} <span class="hint">of ${s.dailyCap}</span></b><span class="meter"><i data-w="${Math.min(100, Math.round(s.sentToday / s.dailyCap * 100))}"></i></span></a>`;

    renderAgainStrip();
    const week = S.upcoming.filter(j => j.startAt < now + 7 * DAY);
    $('#today-agenda').innerHTML = week.length ? agendaHtml(week) : `<div class="empty"><b>Nothing scheduled this week</b><p>Write a message once, pick your groups, and WA Box sends it at the right time with safe gaps.</p><a class="btn btn-primary" href="#compose">New message</a></div>`;

    const recentIssues = S.past.filter(j => j.status === 'done_with_errors' && now - j.updatedAt < 7 * DAY).slice(0, 5);
    $('#today-attention').innerHTML = recentIssues.map(j => {
      const bad = j.sends.filter(x => ['failed', 'missed', 'skipped'].includes(x.status)).length;
      return `<div class="pl-row clickable" data-job="${j.id}"><span><b>${esc(jobName(j))}</b><small>${plural(bad, 'group')} didn't get it · ${esc(whenLabel(j.runAt))}</small></span>${pill('failed')}</div>`;
    }).join('');
    loadSendsQuiet().then(() => {
      $('#today-recent').innerHTML = S.sends.filter(x => ['sent', 'dry_run'].includes(x.status)).slice(0, 6)
        .map(x => `<div class="pl-row clickable" data-job="${x.jobId}"><span><b>${esc(x.group)}</b><small>${esc(firstLine(x.preview))} · ${esc(ago(x.at))}</small></span>${pill(x.status)}</div>`).join('');
    });
  }
  function againCandidates() {
    const now = Date.now();
    return S.past.filter(j => ['done', 'done_with_errors'].includes(j.status) && !j.repeatDays.length && now - j.runAt < 8 * DAY)
      .filter(j => !S.upcoming.some(u => u.message.trim() === j.message.trim() && u.groups.some(g => j.groups.some(h => h.id === g.id))))
      .sort((a, b) => b.runAt - a.runAt).slice(0, 3);
  }
  function nextWeekOf(j) { let n = j.runAt + 7 * DAY; while (n < Date.now() + 5 * 60000) n += 7 * DAY; return n; }
  function renderAgainStrip() {
    const list = againCandidates();
    $('#again-strip').innerHTML = list.length ? `<section class="again"><h2>Send these again?</h2>${list.map(j => `<div class="again-row"><span><b>${esc(jobName(j))}</b><small>${plural(j.groups.length, 'group')} · last sent ${esc(shortDate(j.runAt))}, ${ist(j.runAt).time}</small></span><a class="btn btn-ghost btn-sm" href="#compose?again=${j.id}">Repeat ${esc(shortDate(nextWeekOf(j)))}</a></div>`).join('')}</section>` : '';
  }
  async function loadSendsQuiet() { try { S.sends = (await api('sends')).sends; } catch { /* keep */ } }
  ['#today-attention', '#today-recent', '#today-agenda', '#sched-list'].forEach(sel => $(sel).addEventListener('click', e => {
    const r = e.target.closest('[data-job]'); if (r) openDrawer(Number(r.dataset.job));
  }));

  function agendaHtml(jobs, dateOf = j => j.startAt) {
    const byDay = new Map();
    for (const j of jobs) { const k = ist(dateOf(j)).date; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(j); }
    return [...byDay.entries()].map(([k, js]) => {
      const ms = istEpoch(k, '12:00'); const rel = relDay(ms); const x = ist(ms);
      return `<div class="day"><h3>${rel ? `<span class="rel">${rel}</span>` : ''}<span>${DOW_LONG[x.dow]}, ${x.d} ${MON[x.m]}</span></h3><div class="day-rows">${js.map(jobRowHtml).join('')}</div></div>`;
    }).join('');
  }
  function jobRowHtml(j) {
    const done = j.sends.filter(s => ['sent', 'dry_run', 'failed', 'skipped', 'missed'].includes(s.status)).length;
    const pct = j.groups.length ? Math.round(done / j.groups.length * 100) : 0;
    return `<button class="job-row" type="button" data-job="${j.id}">
      <span class="job-time">${ist(j.runAt).time}</span>
      <span class="job-main"><span class="job-title">${esc(jobName(j))}</span>
        <span class="job-meta"><span>${ICON.users}${plural(j.groups.length, 'group')}</span>${j.repeatDays.length ? `<span>${ICON.repeat}${esc(repeatLabel(j.repeatDays))}</span>` : ''}${j.hasImage || j.imageUrl ? `<span>${ICON.img}Image</span>` : ''}<span>${ICON.user}${esc(j.createdBy.split('@')[0])}</span></span>
        ${j.status === 'running' ? `<span class="progress"><i data-w="${pct}"></i></span>` : ''}
        ${j.note && ['scheduled', 'running'].includes(j.status) ? `<span class="job-meta">${esc(j.note)}</span>` : ''}
      </span>${pill(j.status)}</button>`;
  }
  // progress widths without inline styles in markup
  new MutationObserver(() => $$('i[data-w]').forEach(i => { i.style.width = i.dataset.w + '%'; i.removeAttribute('data-w'); }))
    .observe(document.body, { childList: true, subtree: true });

  // ============ Drawer ============
  function openDrawer(id) {
    const j = findJob(id);
    if (!j) { toast('That message is no longer available', true); return; }
    S.drawerJob = id; fillDrawer(j);
    $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false');
  }
  function closeDrawer() { S.drawerJob = null; $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); }
  $('#drawer-close').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.drawerJob) closeDrawer(); });
  function fillDrawer(j) {
    $('#dr-title').textContent = jobName(j);
    $('#dr-sub').textContent = `${whenLabel(j.runAt)}${j.repeatDays.length ? ` · repeats ${repeatLabel(j.repeatDays)}` : ''}`;
    const byId = new Map(j.sends.map(s => [s.group_id, s]));
    const sent = j.sends.filter(s => ['sent', 'dry_run'].includes(s.status)).length;
    $('#dr-body').innerHTML = `
      ${j.note ? `<div class="alert warn">${ICON.warn}<span>${esc(j.note)}</span></div>` : ''}
      <dl class="facts">
        <dt>Status</dt><dd>${pill(j.status)}</dd>
        <dt>Groups</dt><dd>${plural(j.groups.length, 'group')}${j.sends.length ? `, ${sent} delivered` : ''}</dd>
        <dt>Pacing</dt><dd>${esc(pacingLabel(j))}</dd>
        <dt>Created by</dt><dd>${esc(j.createdBy)}</dd>
        ${j.updatedBy !== j.createdBy ? `<dt>Last edited by</dt><dd>${esc(j.updatedBy)}</dd>` : ''}
      </dl>
      <div class="mini-bubble"><div class="bubble">${j.hasImage ? `<img src="api/jobs/${j.id}/image" alt="">` : j.imageUrl ? `<img src="${esc(j.imageUrl)}" alt="">` : j.imagePurged ? '<p class="hint">Image deleted after sending.</p>' : ''}<div class="bubble-text">${waFormat(j.message)}</div><span class="bubble-time">${ist(j.runAt).time}</span></div></div>
      <div><h3 class="sec-title">Groups</h3><div class="gstatus">${j.groups.map(g => { const s = byId.get(g.id);
        const canDecide = s && ['unconfirmed', 'failed', 'blocked_duplicate', 'skipped', 'missed'].includes(s.status);
        const acts = canDecide ? `<span class="g-actions">${['unconfirmed', 'failed'].includes(s.status) ? `<button class="btn btn-ghost btn-sm" type="button" data-gact="mark" data-gid="${esc(g.id)}">It was sent</button>` : ''}${isAdmin() ? `<button class="btn btn-ghost btn-sm" type="button" data-gact="again" data-gid="${esc(g.id)}">Send again</button>` : ''}</span>` : '';
        return `<div><span class="gn">${esc(g.name)}</span>${s ? pill(s.status) : '<span class="pill scheduled">Waiting</span>'}${s?.error ? `<small>${esc(s.error)}</small>` : ''}${acts}</div>`; }).join('')}</div></div>`;
    const acts = [];
    if (j.status === 'scheduled') acts.push(['edit', 'Edit', 'btn-primary'], ['dup', 'Duplicate', 'btn-ghost'], ['now', 'Send now', 'btn-ghost'], ['grow'], ['cancel', 'Cancel', 'btn-danger-ghost']);
    else if (j.status === 'running') acts.push(['dup', 'Duplicate', 'btn-ghost'], ['grow'], ['cancel', 'Stop sending', 'btn-danger-ghost']);
    else acts.push(['again', `Repeat ${shortDate(nextWeekOf(j))}`, 'btn-primary'], ['dup', 'Duplicate', 'btn-ghost']);
    $('#dr-actions').innerHTML = acts.map(([k, l, c]) => k === 'grow' ? '<span class="grow"></span>' : `<button class="btn ${c}" data-act="${k}" type="button">${l}</button>`).join('');
  }
  $('#dr-body').addEventListener('click', async e => {
    const b = e.target.closest('[data-gact]'); if (!b) return;
    const j = findJob(S.drawerJob); if (!j) return;
    const g = j.groups.find(x => x.id === b.dataset.gid);
    try {
      if (b.dataset.gact === 'mark') {
        if (!await dialog({ title: 'Mark as sent?', html: `<p>Only do this after checking that “${esc(g.name)}” has the message in WhatsApp.</p>`, ok: 'Yes, it was sent' })) return;
        await api(`jobs/${j.id}/groups/${encodeURIComponent(g.id)}/mark-sent`, { method: 'POST' }); toast('Marked as sent');
      } else {
        if (!await dialog({ title: `Send again to “${g.name}”?`, html: '<p>Check the group first. If the message is already there, sending again will post it twice.</p>', ok: 'Send again' })) return;
        await api(`jobs/${j.id}/groups/${encodeURIComponent(g.id)}/send-again`, { method: 'POST' }); toast('Queued. It goes out within a minute.');
      }
      await loadJobs(); const fresh = findJob(j.id); if (fresh) fillDrawer(fresh);
    } catch (err) { toast(err.message, true); }
  });
  $('#dr-actions').addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const j = findJob(S.drawerJob); if (!j) return;
    try {
      if (b.dataset.act === 'edit') location.hash = `compose?edit=${j.id}`;
      if (b.dataset.act === 'dup') location.hash = `compose?dup=${j.id}`;
      if (b.dataset.act === 'again') location.hash = `compose?again=${j.id}`;
      if (b.dataset.act === 'now' && await dialog({ title: 'Send now?', html: `<p>Starts within a minute and goes to ${plural(j.groups.length, 'group')} with the same random gaps.${j.repeatDays.length ? ' This counts as its next weekly send; the repeat carries on after that.' : ''}</p>`, ok: 'Send now' })) {
        await api(`jobs/${j.id}/send-now`, { method: 'POST' }); toast('Sending starts within a minute'); await loadJobs(); fillDrawer(findJob(j.id));
      }
      if (b.dataset.act === 'cancel') {
        const running = j.status === 'running';
        if (await dialog({ title: running ? 'Stop sending?' : 'Cancel this message?', html: `<p>${running ? "Groups that already got it keep it. The rest won't get it." : "It won't be sent."}${j.repeatDays.length ? ' This also ends the weekly repeat.' : ''}</p>`, ok: running ? 'Stop sending' : 'Cancel message', cancel: 'Keep it', danger: true })) {
          await api(`jobs/${j.id}/cancel`, { method: 'POST' }); toast(running ? 'Stopped' : 'Cancelled'); await loadJobs(); closeDrawer(); route();
        }
      }
    } catch (err) { toast(err.message, true); }
  });

  // ============ Scheduled ============
  function renderScheduled() {
    const f = S.schedFilter;
    $$('#sched-tabs button').forEach(b => b.classList.toggle('on', b.dataset.filter === f));
    let jobs, dateOf = j => j.startAt;
    if (f === 'upcoming') jobs = S.upcoming;
    else if (f === 'repeat') jobs = S.upcoming.filter(j => j.repeatDays.length);
    else { jobs = S.past; dateOf = j => j.runAt; }
    $('#sched-list').innerHTML = jobs.length ? agendaHtml(jobs, dateOf) : `<div class="empty"><b>${f === 'past' ? 'Nothing finished yet' : f === 'repeat' ? 'No repeating messages' : 'Nothing scheduled'}</b><p>${f === 'repeat' ? 'Turn on "Repeat every week" when you write a message, for things like weekend class reminders.' : 'Messages you schedule show up here, grouped by day.'}</p>${f !== 'past' ? '<a class="btn btn-primary" href="#compose">New message</a>' : ''}</div>`;
  }
  $('#sched-tabs').addEventListener('click', e => { const b = e.target.closest('[data-filter]'); if (b) { S.schedFilter = b.dataset.filter; renderScheduled(); } });

  // ============ Sent ============
  async function renderSent() {
    await loadSendsQuiet();
    const groups = { all: ['All'], sent: ['Sent', ['sent']], problems: ['Problems', ['failed', 'missed', 'skipped', 'retry', 'unconfirmed', 'blocked_duplicate', 'uncertain']], practice: ['Practice', ['dry_run']] };
    const count = k => k === 'all' ? S.sends.length : S.sends.filter(s => groups[k][1].includes(s.status)).length;
    $('#sent-tabs').innerHTML = Object.entries(groups).map(([k, [l]]) => `<button role="tab" data-filter="${k}" class="${S.sentFilter === k ? 'on' : ''}">${l}<small>${count(k)}</small></button>`).join('');
    const q = $('#sent-search').value.trim().toLowerCase();
    const rows = S.sends.filter(s => (S.sentFilter === 'all' || groups[S.sentFilter][1].includes(s.status)) &&
      (!q || s.group.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q)));
    $('#sent-table tbody').innerHTML = rows.length ? rows.map(s => `<tr data-job="${s.jobId}">
      <td class="when">${esc(whenLabel(s.at))}</td><td>${esc(s.group)}</td><td class="msg">${esc(firstLine(s.preview))}</td>
      <td>${pill(s.status)}${s.error ? `<span class="err">${esc(s.error)}</span>` : ''}</td></tr>`).join('')
      : `<tr class="empty-row"><td colspan="4">${S.sends.length ? 'Nothing matches.' : 'Nothing has been sent yet.'}</td></tr>`;
  }
  $('#sent-tabs').addEventListener('click', e => { const b = e.target.closest('[data-filter]'); if (b) { S.sentFilter = b.dataset.filter; renderSent(); } });
  $('#sent-search').addEventListener('input', () => renderSent());
  $('#sent-table').addEventListener('click', e => { const r = e.target.closest('tr[data-job]'); if (r) openDrawer(Number(r.dataset.job)); });

  // ============ Templates ============
  async function renderTemplates() {
    await loadTemplates();
    $('#tpl-list').innerHTML = S.templates.length ? S.templates.map(t => `<article class="card"><h3>${esc(t.name)}</h3>
      <div class="body">${waFormat(t.message)}</div><span class="meta">Saved by ${esc(t.created_by)}</span>
      <div class="btn-row"><a class="btn btn-primary btn-sm" href="#compose?tpl=${t.id}">Use</a><button class="btn btn-danger-ghost btn-sm" data-del="${t.id}" type="button">Delete</button></div></article>`).join('')
      : `<div class="empty"><b>No templates yet</b><p>Save a message as a template while writing it, or create one here.</p><button class="btn btn-primary" type="button" data-new>New template</button></div>`;
  }
  async function newTemplate(message = '') {
    const ok = await dialog({ title: 'Save as template', ok: 'Save template',
      html: `<label class="fld"><span>Name</span><input id="tpl-name" maxlength="60" placeholder="e.g. Weekend class reminder"></label>
             <label class="fld"><span>Message</span><textarea id="tpl-msg" rows="7" maxlength="4000"></textarea></label>`,
      onOpen: () => { $('#tpl-msg').value = message; $('#tpl-name').focus(); } });
    if (!ok) return false;
    try { await api('templates', { method: 'POST', body: { name: $('#tpl-name').value, message: $('#tpl-msg').value } }); toast('Template saved'); return true; }
    catch (err) { toast(err.message, true); return false; }
  }
  $('#tpl-new').addEventListener('click', async () => { if (await newTemplate()) renderTemplates(); });
  $('#tpl-list').addEventListener('click', async e => {
    if (e.target.closest('[data-new]')) { if (await newTemplate()) renderTemplates(); return; }
    const d = e.target.closest('[data-del]'); if (!d) return;
    if (await dialog({ title: 'Delete this template?', html: '<p>Messages already scheduled from it are not affected.</p>', ok: 'Delete', danger: true })) {
      try { await api('templates/' + d.dataset.del, { method: 'DELETE' }); toast('Template deleted'); renderTemplates(); } catch (err) { toast(err.message, true); }
    }
  });

  // ============ Group lists ============
  async function renderLists() {
    await Promise.all([loadLists(), loadGroups()]);
    $('#lists-list').innerHTML = S.lists.length ? S.lists.map(l => `<article class="card"><h3>${esc(l.name)}</h3>
      <span class="meta">${plural(l.groups.length, 'group')}${l.missing ? ` · ${l.missing} no longer available` : ''}</span>
      <div class="tags">${l.groups.slice().sort(byName).slice(0, 8).map(g => `<span class="tag">${esc(g.name)}</span>`).join('')}${l.groups.length > 8 ? `<span class="tag">+${l.groups.length - 8} more</span>` : ''}</div>
      <div class="btn-row"><a class="btn btn-primary btn-sm" href="#compose?list=${l.id}">Write to this list</a><button class="btn btn-ghost btn-sm" data-edit="${l.id}" type="button">Edit</button><button class="btn btn-danger-ghost btn-sm" data-del="${l.id}" type="button">Delete</button></div></article>`).join('')
      : `<div class="empty"><b>No group lists yet</b><p>Make one for each set you message together, like the 15 weekend cohorts or the Thursday–Friday batch.</p><button class="btn btn-primary" type="button" data-new>New list</button></div>`;
  }
  async function editList(list) {
    const picked = new Set(list ? list.groups.map(g => g.id) : []);
    const draw = () => {
      const q = ($('#dl-search')?.value || '').toLowerCase();
      $('#dl-groups').innerHTML = S.groups.filter(g => !q || g.name.toLowerCase().includes(q)).sort(byName).map(g => `<label class="g-opt"><input type="checkbox" data-id="${esc(g.id)}" ${picked.has(g.id) ? 'checked' : ''}><span class="g-name">${esc(g.name)}</span></label>`).join('') || '<div class="g-empty">No saved groups match.</div>';
      $('#dl-count').textContent = plural(picked.size, 'group') + ' selected';
    };
    const ok = await dialog({ title: list ? 'Edit list' : 'New group list', ok: list ? 'Save list' : 'Create list',
      html: `<label class="fld"><span>List name</span><input id="dl-name" maxlength="60" placeholder="e.g. Weekend cohorts"></label>
        <input id="dl-search" type="search" placeholder="Search groups"><div class="dlg-picker" id="dl-groups"></div><p class="hint" id="dl-count"></p>`,
      onOpen: () => {
        $('#dl-name').value = list?.name || ''; draw();
        $('#dl-search').addEventListener('input', draw);
        $('#dl-groups').addEventListener('change', e => { const id = e.target.dataset.id; if (!id) return; e.target.checked ? picked.add(id) : picked.delete(id); $('#dl-count').textContent = plural(picked.size, 'group') + ' selected'; });
        $('#dl-name').focus();
      } });
    if (!ok) return;
    try {
      await api(list ? `lists/${list.id}` : 'lists', { method: list ? 'PUT' : 'POST', body: { name: $('#dl-name').value, groupIds: [...picked] } });
      toast(list ? 'List saved' : 'List created'); renderLists();
    } catch (err) { toast(err.message, true); }
  }
  $('#list-new').addEventListener('click', () => editList(null));
  $('#lists-list').addEventListener('click', async e => {
    if (e.target.closest('[data-new]')) return editList(null);
    const ed = e.target.closest('[data-edit]'); if (ed) return editList(S.lists.find(l => String(l.id) === ed.dataset.edit));
    const d = e.target.closest('[data-del]'); if (!d) return;
    if (await dialog({ title: 'Delete this list?', html: '<p>The groups themselves stay. Scheduled messages are not affected.</p>', ok: 'Delete', danger: true })) {
      try { await api('lists/' + d.dataset.del, { method: 'DELETE' }); toast('List deleted'); renderLists(); } catch (err) { toast(err.message, true); }
    }
  });

  // ============ Compose ============
  const form = $('#job-form');
  const C = () => S.compose;
  const DRAFT_KEY = 'wabox.draft.v1';
  function blankCompose() {
    const last = store.get('wabox.lastTime') || '10:00';
    return { mode: 'new', id: null, picked: new Map(), message: '', date: ist(Date.now() + DAY).date, time: last, repeat: [], pace: 'standard',
      gapMin: 40, gapMax: 120, image: null, imageUrl: null, keepImage: false, removeImage: false, imageLink: null, linkPreview: true, dirty: false, search: '' };
  }
  async function openCompose() {
    S.composeQuery = location.hash.includes('?') ? '?' + location.hash.split('?')[1] : '';
    await Promise.all([loadGroups(), loadLists()]);
    const p = S.params; let c = blankCompose(); let note = '';
    const fromJob = id => findJob(Number(id));
    if (p.edit || p.dup || p.again) {
      const j = fromJob(p.edit || p.dup || p.again);
      if (!j) { toast('That message is no longer available', true); location.hash = 'scheduled'; return; }
      if (p.edit && j.status !== 'scheduled') { toast("This message has started sending, so it can't be edited. You can duplicate it.", true); location.hash = `compose?dup=${j.id}`; return; }
      c.mode = p.edit ? 'edit' : 'dup'; c.id = p.edit ? j.id : null;
      if (p.again) c.mode = 'again';
      c.message = j.message; j.groups.forEach(g => c.picked.set(g.id, { id: g.id, name: g.name }));
      c.imageLink = j.imageUrl || null; c.linkPreview = j.linkPreview;
      if (p.edit) { c.date = j.date; c.time = j.time; c.repeat = [...j.repeatDays]; c.keepImage = j.hasImage; c.imageUrl = j.hasImage ? `api/jobs/${j.id}/image` : null; }
      else { c.time = j.time; c.repeat = [...j.repeatDays]; }
      if (p.again) { let next = j.runAt + 7 * DAY; while (next < Date.now() + 5 * 60000) next += 7 * DAY; c.date = ist(next).date; c.time = ist(next).time; }
      c.gapMin = j.gapMin; c.gapMax = j.gapMax;
      c.pace = j.gapMin === 60 && j.gapMax === 180 ? 'gentle' : j.gapMin === 40 && j.gapMax === 120 ? 'standard' : 'custom';
      if ((p.dup || p.again) && (j.hasImage || j.imagePurged)) note = "The uploaded image from the original isn't copied. Add it again if you need it.";
      else if (p.again) note = `Copied from ${shortDate(j.runAt)}. Moved to ${shortDate(istEpoch(c.date, c.time))}; check the date and the text.`;
      if (p.edit && j.imagePurged) note = 'The uploaded image was already deleted. Add it again if you need it.';
    } else {
      const d = store.get(DRAFT_KEY);
      if (d && (d.message || (d.picked || []).length)) {
        Object.assign(c, d, { picked: new Map((d.picked || []).map(g => [g.id, g])), image: null, imageUrl: null, keepImage: false, dirty: false, linkPreview: d.linkPreview !== false });
        if (istEpoch(c.date, c.time) < Date.now()) c.date = ist(Date.now() + DAY).date;
        note = 'Draft restored.';
      }
      if (p.tpl) { await loadTemplates(); const t = S.templates.find(x => String(x.id) === p.tpl); if (t) { c.message = t.message; note = `Started from template "${t.name}".`; } }
      if (p.list) { const l = S.lists.find(x => String(x.id) === p.list); if (l) { c.picked = new Map(l.groups.map(g => [g.id, g])); note = `Groups from "${l.name}".`; } }
    }
    S.compose = c;
    $('#compose-title').textContent = { new: 'New message', edit: 'Edit message', dup: 'Duplicate message', again: 'Repeat from last week' }[c.mode];
    $('#compose-lede').textContent = c.mode === 'edit' ? 'Changes apply to this message and, if it repeats, every future send.' : 'Pick groups, write it once, choose when. WA Box spaces the sends out for you.';
    $('#draft-note').innerHTML = note ? `${esc(note)}${note === 'Draft restored.' ? ' <button class="link" type="button" id="draft-clear">Start fresh</button>' : ''}` : '';
    $('#job-error').textContent = '';
    $('#group-search').value = '';
    $('#message').value = c.message;
    $('#date').value = c.date; $('#time').value = c.time;
    $('#image').value = '';
    $('#gapMin').value = c.gapMin; $('#gapMax').value = c.gapMax;
    $('#link-preview').checked = c.linkPreview; $('#image-url').value = c.imageLink || ''; $('#image-link-row').classList.add('hidden');
    $('#repeat-on').checked = c.repeat.length > 0;
    $$('#repeat-days input').forEach(i => { i.checked = c.repeat.includes(Number(i.value)); });
    $('#compose-discard').textContent = c.mode === 'new' ? 'Clear' : 'Cancel';
    c.pvIdx = 0;
    renderPicker(); renderDayChips(); renderPace(); renderImage(); updateCompose();
    if (c.mode === 'new' && !c.message) setTimeout(() => (c.picked.size ? $('#message') : $('#group-search')).focus({ preventScroll: true }), 50);
  }
  function markDirty() {
    const c = C(); if (!c) return; c.dirty = true;
    if (c.mode === 'new') store.set(DRAFT_KEY, { message: c.message, picked: [...c.picked.values()], date: c.date, time: c.time, repeat: c.repeat, pace: c.pace, gapMin: c.gapMin, gapMax: c.gapMax, imageLink: c.imageLink, linkPreview: c.linkPreview });
    updateCompose();
  }
  $('#draft-note').addEventListener('click', e => { if (e.target.id === 'draft-clear') { store.del(DRAFT_KEY); S.params = {}; openCompose(); } });

  // groups picker
  function renderPicker() {
    const c = C(); if (!c) return;
    const q = $('#group-search').value.trim().toLowerCase();
    const missing = [...c.picked.values()].filter(g => !S.groups.some(x => x.id === g.id));
    const all = [...S.groups, ...missing.map(g => ({ ...g, missing: true }))];
    const shown = all.filter(g => !q || g.name.toLowerCase().includes(q));
    // unavailable ones first (so they can be removed), then A to Z; order never changes while ticking
    shown.sort((a, b) => (!!b.missing - !!a.missing) || byName(a, b));
    $('#group-list').innerHTML = shown.length ? shown.map(g => `<label class="g-opt${g.missing ? ' missing' : ''}"><input type="checkbox" data-id="${esc(g.id)}" ${c.picked.has(g.id) ? 'checked' : ''}><span class="g-name">${esc(g.name)}</span>${g.missing ? '<span class="hint">No longer available</span>' : ''}</label>`).join('')
      : `<div class="g-empty">${S.groups.length ? 'No group matches that search.' : S.sync?.running ? 'Syncing groups from WhatsApp…' : 'No groups yet. Once WhatsApp is connected, press “Sync from WhatsApp”.'}</div>`;
    $('#picked-count').textContent = c.picked.size;
    $('#list-chips').innerHTML = S.lists.map(l => {
      const ids = l.groups.map(g => g.id); const n = ids.filter(id => c.picked.has(id)).length;
      const cls = ids.length && n === ids.length ? 'on' : n ? 'partial' : '';
      return `<button type="button" class="lchip ${cls}" data-list="${l.id}" aria-pressed="${cls === 'on'}">${esc(l.name)} <small>${ids.length}</small></button>`;
    }).join('');
    const s = S.sync;
    $('#groups-note').textContent = !s ? '' : s.running ? 'Syncing from WhatsApp…' : s.error ? `Last sync failed: ${s.error}` : s.finishedAt ? `${plural(S.groups.length, 'group')} · synced ${ago(s.finishedAt)}` : 'Not synced yet';
    $('#groups-sync').disabled = !!s?.running;
    $('#save-as-list').disabled = c.picked.size === 0;
  }
  $('#group-search').addEventListener('input', renderPicker);
  $('#group-list').addEventListener('change', e => {
    const id = e.target.dataset.id; if (!id) return;
    const c = C(); const g = S.groups.find(x => x.id === id) || c.picked.get(id);
    e.target.checked ? c.picked.set(id, { id, name: g.name }) : c.picked.delete(id);
    renderPicker(); markDirty();
  });
  $('#list-chips').addEventListener('click', e => {
    const b = e.target.closest('[data-list]'); if (!b) return;
    const c = C(); const l = S.lists.find(x => String(x.id) === b.dataset.list);
    if (b.classList.contains('on')) l.groups.forEach(g => c.picked.delete(g.id));
    else l.groups.forEach(g => c.picked.set(g.id, g));
    renderPicker(); markDirty();
  });
  $('#groups-all').addEventListener('click', () => {
    const q = $('#group-search').value.trim().toLowerCase(); const c = C();
    S.groups.filter(g => !q || g.name.toLowerCase().includes(q)).forEach(g => c.picked.set(g.id, g));
    renderPicker(); markDirty();
  });
  $('#groups-none').addEventListener('click', () => { C().picked.clear(); renderPicker(); markDirty(); });
  $('#groups-sync').addEventListener('click', syncGroups);
  async function syncGroups() {
    try { await api('groups/sync', { method: 'POST' }); toast('Syncing groups from WhatsApp. This can take a minute.'); }
    catch (err) { toast(err.message, true); }
    await loadGroups(); if (S.view === 'compose') renderPicker(); if (S.view === 'whatsapp') renderSyncDetail();
  }
  $('#save-as-list').addEventListener('click', async () => {
    const c = C();
    const ok = await dialog({ title: 'Save these groups as a list', ok: 'Save list',
      html: `<p>${plural(c.picked.size, 'group')} selected. Next time, pick them all with one click.</p><label class="fld"><span>List name</span><input id="sl-name" maxlength="60" placeholder="e.g. Weekend cohorts"></label>`,
      onOpen: () => $('#sl-name').focus() });
    if (!ok) return;
    try { await api('lists', { method: 'POST', body: { name: $('#sl-name').value, groupIds: [...c.picked.keys()] } }); toast('List saved'); await loadLists(); renderPicker(); }
    catch (err) { toast(err.message, true); }
  });

  // message
  $('#message').addEventListener('input', e => { C().message = e.target.value; markDirty(); });
  $('#message').addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'Enter') { e.preventDefault(); if (!$('#job-submit').disabled) form.requestSubmit(); return; }
    const wrap = mod && { b: '*', i: '_' }[e.key.toLowerCase()];
    if (wrap) { e.preventDefault(); $(`.toolbar [data-wrap="${wrap}"]`).click(); }
  });
  // Paste or drop an image straight into the editor
  function takeImageFile(f) {
    if (!f || !f.type.startsWith('image/')) return false;
    const input = $('#image'); const dt = new DataTransfer(); dt.items.add(f); input.files = dt.files;
    input.dispatchEvent(new Event('change')); return true;
  }
  $('#message').addEventListener('paste', e => {
    const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); if (takeImageFile(f)) toast('Image attached'); }
  });
  const editorEl = $('.editor');
  ['dragenter', 'dragover'].forEach(ev => editorEl.addEventListener(ev, e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); editorEl.classList.add('dragging'); } }));
  ['dragleave', 'drop'].forEach(ev => editorEl.addEventListener(ev, e => { if (ev === 'dragleave' && editorEl.contains(e.relatedTarget)) return; editorEl.classList.remove('dragging'); }));
  editorEl.addEventListener('drop', e => {
    const f = [...(e.dataTransfer?.files || [])].find(x => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); if (takeImageFile(f)) toast('Image attached'); }
  });
  function insertAtCursor(txt) {
    const ta = $('#message'); const { selectionStart: s0, selectionEnd: s1 } = ta;
    ta.setRangeText(txt, s0, s1, 'end'); ta.focus(); C().message = ta.value; markDirty();
  }
  $('.toolbar').addEventListener('click', e => {
    const ins = e.target.closest('[data-insert]'); if (ins) { insertAtCursor(ins.dataset.insert); return; }
    const b = e.target.closest('[data-wrap]'); if (!b) return;
    const ta = $('#message'), w = b.dataset.wrap, { selectionStart: s, selectionEnd: en, value: v } = ta;
    const sel = v.slice(s, en) || 'text';
    ta.setRangeText(w + sel + w, s, en, 'select');
    ta.setSelectionRange(s + w.length, s + w.length + sel.length); ta.focus();
    C().message = ta.value; markDirty();
  });
  $('#image').addEventListener('change', e => {
    const f = e.target.files[0]; const c = C();
    if (!f) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) { toast('Use a JPG, PNG or WebP image', true); e.target.value = ''; return; }
    if (f.size > 5 * 1024 * 1024) { toast('That image is over 5 MB. Use a smaller one.', true); e.target.value = ''; return; }
    if (c.imageUrl?.startsWith('blob:')) URL.revokeObjectURL(c.imageUrl);
    c.image = f; c.imageUrl = URL.createObjectURL(f); c.removeImage = false; c.keepImage = false; c.imageLink = null; $('#image-link-row').classList.add('hidden');
    renderImage(); markDirty();
  });
  $('#image-remove').addEventListener('click', () => {
    const c = C(); if (c.imageUrl?.startsWith('blob:')) URL.revokeObjectURL(c.imageUrl);
    c.removeImage = c.keepImage || (c.mode === 'edit' && !!c.imageLink); c.image = null; c.imageUrl = null; c.keepImage = false; c.imageLink = null; $('#image').value = ''; $('#image-url').value = '';
    renderImage(); markDirty();
  });
  function renderImage() {
    const c = C();
    const src = c.imageLink || c.imageUrl;
    $('#attach-label').textContent = c.imageUrl ? (c.image ? c.image.name : 'Image attached') : 'Upload image';
    $('#image-link-btn').textContent = c.imageLink ? 'Image from link ✓' : 'Use an image link';
    $('#image-remove').classList.toggle('hidden', !src);
    const img = $('#pv-image');
    if (src) { img.src = src; img.classList.remove('hidden'); img.onerror = () => { if (c.imageLink) toast("That image link didn't load. Check it's public and points to an image.", true); }; }
    else { img.removeAttribute('src'); img.classList.add('hidden'); }
  }
  $('#image-link-btn').addEventListener('click', () => { const row = $('#image-link-row'); row.classList.toggle('hidden'); if (!row.classList.contains('hidden')) $('#image-url').focus(); });
  const applyImageLink = () => {
    const v = $('#image-url').value.trim(); const c = C();
    if (!/^https:\/\/\S+$/i.test(v)) { toast('Paste a link that starts with https://', true); return; }
    if (c.imageUrl?.startsWith('blob:')) URL.revokeObjectURL(c.imageUrl);
    c.imageLink = v; c.image = null; c.imageUrl = null; c.removeImage = c.keepImage; c.keepImage = false; $('#image').value = '';
    $('#image-link-row').classList.add('hidden'); renderImage(); markDirty();
  };
  $('#image-url-apply').addEventListener('click', applyImageLink);
  $('#image-url').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyImageLink(); } });
  $('#link-preview').addEventListener('change', e => { C().linkPreview = e.target.checked; markDirty(); });
  $('#tpl-save').addEventListener('click', async () => {
    const m = $('#message').value.trim();
    if (!m) { toast('Write the message first', true); return; }
    await newTemplate(m);
  });
  $('#tpl-load').addEventListener('click', async () => {
    await loadTemplates();
    if (!S.templates.length) { toast('No templates yet. Write a message and press “Save as template”.'); return; }
    let chosen = null;
    await dialog({ title: 'Use a template', ok: null, cancel: 'Close',
      html: `<div class="dlg-picker">${S.templates.map(t => `<button type="button" class="tpl-opt" data-id="${t.id}"><b>${esc(t.name)}</b><span>${esc(firstLine(t.message))}</span></button>`).join('')}</div>`,
      onOpen: d => { $('#dialog-content').onclick = e => { const b = e.target.closest('.tpl-opt'); if (b) { chosen = S.templates.find(t => String(t.id) === b.dataset.id); d.close(); } }; } });
    if (!chosen) return;
    const c = C();
    if (c.message.trim() && c.message !== chosen.message && !await dialog({ title: 'Replace your message?', html: '<p>The text you wrote will be replaced by the template.</p>', ok: 'Replace' })) return;
    c.message = chosen.message; $('#message').value = c.message; markDirty();
  });

  // when
  function renderDayChips() {
    const c = C(); const chips = [];
    for (let i = 0; i < 8; i++) { const ms = Date.now() + i * DAY; const x = ist(ms); chips.push({ date: x.date, b: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : DOW[x.dow], s: `${x.d} ${MON[x.m]}` }); }
    $('#day-chips').innerHTML = chips.map(ch => `<button type="button" class="dchip ${ch.date === c.date ? 'on' : ''}" data-date="${ch.date}"><b>${ch.b}</b><small>${ch.s}</small></button>`).join('');
  }
  $('#day-chips').addEventListener('click', e => { const b = e.target.closest('[data-date]'); if (!b) return; C().date = b.dataset.date; $('#date').value = b.dataset.date; renderDayChips(); markDirty(); });
  $('#date').addEventListener('input', e => { C().date = e.target.value; renderDayChips(); markDirty(); });
  $('#time').addEventListener('input', e => { C().time = e.target.value; markDirty(); });
  $('#repeat-on').addEventListener('change', e => {
    const c = C();
    if (e.target.checked && !c.repeat.length && c.date) { c.repeat = [ist(istEpoch(c.date, '12:00')).dow]; $$('#repeat-days input').forEach(i => { i.checked = c.repeat.includes(Number(i.value)); }); }
    if (!e.target.checked) c.repeat = [];
    markDirty();
  });
  $('#repeat-days').addEventListener('change', () => { C().repeat = $$('#repeat-days input:checked').map(i => Number(i.value)); markDirty(); });

  // pacing
  function renderPace() {
    const c = C();
    $$('#pacing button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.pace === c.pace)));
    $('#pace-custom').classList.toggle('hidden', c.pace !== 'custom');
  }
  $('#pacing').addEventListener('click', e => {
    const b = e.target.closest('[data-pace]'); if (!b) return; const c = C();
    c.pace = b.dataset.pace;
    if (b.dataset.min) { c.gapMin = Number(b.dataset.min); c.gapMax = Number(b.dataset.max); $('#gapMin').value = c.gapMin; $('#gapMax').value = c.gapMax; }
    renderPace(); markDirty();
  });
  ['gapMin', 'gapMax'].forEach(k => $('#' + k).addEventListener('input', e => { C()[k] = Number(e.target.value) || 0; markDirty(); }));

  // preview, send plan and checks
  const avgGap = c => (Math.max(30, c.gapMin) + Math.max(Math.max(30, c.gapMin), c.gapMax)) / 2 + 5;
  const jobWindow = j => [j.startAt, j.startAt + Math.max(0, j.groups.length - 1) * ((j.gapMin + j.gapMax) / 2 + 5) * 1000 + 60000];
  function updateCompose() {
    const c = C(); if (!c) return;
    const picked = [...c.picked.values()].sort(byName);
    // counter
    const n = c.message.length; const counter = $('#msg-count');
    counter.textContent = `${n} / 4000`; counter.classList.toggle('near', n > 3600);
    // timing (needed by the preview's {day}/{date})
    const validTime = c.date && /^\d{2}:\d{2}$/.test(c.time || '');
    const runAt = validTime ? istEpoch(c.date, c.time) : null;
    // phone: preview as one specific group sees it
    const ph = hasPlaceholders(c.message);
    const pvGroup = picked.length ? picked[(c.pvIdx || 0) % picked.length] : null;
    $('#pv-group').textContent = pvGroup?.name || 'Your group';
    $('#pv-more').textContent = ph && picked.length > 1 ? `Group ${((c.pvIdx || 0) % picked.length) + 1} of ${picked.length}` : picked.length > 1 ? `and ${plural(picked.length - 1, 'other group')}` : picked.length ? 'WhatsApp group' : 'Pick groups to preview';
    $('#pv-next').classList.toggle('hidden', !(ph && picked.length > 1));
    const shown = renderMessage(c.message, pvGroup?.name, runAt || Date.now());
    $('#pv-text').innerHTML = c.message.trim() ? waFormat(shown) : '<span class="placeholder">Your message appears here as the group will see it.</span>';
    const links = c.message.match(/https?:\/\/[^\s<]+[^\s<.,!?)]/g) || [];
    const hasImg = !!(c.imageLink || c.imageUrl);
    $('#link-preview-row').classList.toggle('hidden', !links.length || hasImg);
    const showCard = links.length && c.linkPreview && !hasImg;
    $('#pv-link').classList.toggle('hidden', !showCard);
    if (showCard) { try { const u = new URL(links[0]); $('#pv-link-host').textContent = u.hostname.replace(/^www\./, ''); $('#pv-link-url').textContent = links[0]; } catch { $('#pv-link').classList.add('hidden'); } }
    renderUsual(picked);
    $('#pv-time').textContent = validTime ? c.time : '';
    const others = S.upcoming.filter(j => j.id !== c.id);
    let start = runAt, queuedAfter = null;
    if (runAt) {
      for (const j of others.slice().sort((a, b) => a.startAt - b.startAt)) {
        const [a, b] = jobWindow(j);
        if (start >= a - 60000 && start <= b) { start = b + 30000; queuedAfter = j; }
      }
    }
    const step = avgGap(c) * 1000;
    const steps = runAt ? picked.map((g, i) => ({ g, t: start + i * step })) : [];
    const shownSteps = steps.length > 9 ? [...steps.slice(0, 7), null, steps[steps.length - 1]] : steps;
    $('#plan-steps').innerHTML = shownSteps.map(s => s ? `<li><time>${i18nTime(s.t, runAt)}</time><span class="node"></span><span>${esc(s.g.name)}</span></li>` : `<li class="more"><time></time><span class="node"></span><span>${steps.length - 8} more groups</span></li>`).join('');
    $('#plan-summary').textContent = steps.length ? (steps.length === 1 ? `Around ${ist(start).time}` : `${dur((steps.length - 1) * step / 1000)}, ends ~${ist(steps[steps.length - 1].t).time}`) : '';

    // checks
    const checks = []; const s = S.status || { wa: {}, dailyCap: 30 };
    if (!picked.length) checks.push(['bad', 'Pick at least one group.']);
    if (!c.message.trim()) checks.push(['bad', 'Write the message.']);
    if (!validTime) checks.push(['bad', 'Choose a date and time.']);
    else if (runAt < Date.now() - 60000) checks.push(['bad', 'That time has already passed. Choose a later time.']);
    else if (runAt < Date.now() + 3 * 60000) checks.push(['warn', 'This starts within the next few minutes.']);
    if ($('#repeat-on').checked && !c.repeat.length) checks.push(['bad', 'Pick the days it should repeat on, or turn repeat off.']);
    const shorteners = /(^|\/\/)(bit\.ly|tinyurl\.com|t\.co|goo\.gl|cutt\.ly|rb\.gy|is\.gd|ow\.ly|shorturl\.at|tiny\.cc)\//i;
    if (links.some(l => shorteners.test(l))) checks.push(['warn', 'Short links (bit.ly and similar) are often treated as spam. Use the full link.']);
    if (links.length > 3) checks.push(['warn', `This has ${links.length} links. Messages with many links look like spam; keep it to one or two.`]);
    if (links.length && hasImg) checks.push(['ok', 'With an image attached, the link is sent in the caption without a preview card.']);
    for (const issue of dateSense(c.message, runAt, $('#repeat-on').checked ? c.repeat : [])) checks.push(['warn', issue.text, issue.fixDate ? { fix: issue.fixDate } : null]);
    const unk = unknownPlaceholders(c.message);
    if (unk.length) checks.push(['warn', `${unk.map(k => `{${k}}`).join(', ')} isn't a placeholder WA Box knows, so it will be sent exactly as typed. Use {group}, {day} or {date}.`]);
    if (runAt && s.quietStart) {
      const inQuiet = (a, b, x) => a <= b ? x >= a && x < b : x >= a || x < b;
      if (inQuiet(s.quietStart, s.quietEnd, c.time)) checks.push(['warn', `${c.time} is during quiet hours (${s.quietStart}–${s.quietEnd}). People will get it at night.`]);
    }
    const gone = picked.filter(g => !S.groups.some(x => x.id === g.id));
    if (gone.length) checks.push(['bad', `${plural(gone.length, 'group')} ${gone.length === 1 ? 'is' : 'are'} no longer available. Remove ${gone.length === 1 ? 'it' : 'them'} to continue.`]);
    if (c.pace === 'custom' && (c.gapMin < 30 || c.gapMax < c.gapMin)) checks.push(['warn', 'Waits under 30 seconds are raised to 30, and the longest wait must be at least the shortest.']);
    if (runAt && picked.length) {
      if (queuedAfter) checks.push(['warn', `“${jobName(queuedAfter)}” is sending around then, so this one starts after it, around ${ist(start).time}.`]);
      const day = ist(runAt).date;
      const sameDay = others.filter(j => ist(j.runAt).date === day);
      const planned = sameDay.reduce((n, j) => n + j.groups.length, 0) + (day === todayKey() ? s.sentToday || 0 : 0);
      if (planned + picked.length > s.dailyCap) {
        const over = planned + picked.length - s.dailyCap;
        checks.push(['warn', `That day already has ${planned} planned. ${plural(Math.min(over, picked.length), 'group')} will go past the daily limit of ${s.dailyCap} and get it the next morning.`]);
      }
      const msg = c.message.trim();
      const dupes = sameDay.filter(j => j.message.trim() === msg && j.groups.some(g => c.picked.has(g.id)));
      if (msg && dupes.length) { const k = new Set(dupes.flatMap(j => j.groups.map(g => g.id)).filter(id => c.picked.has(id))).size;
        checks.push(['warn', `The same message is already scheduled to ${plural(k, 'of these groups', 'of these groups')} that day.`]); }
    }
    if (s.wa.status && s.wa.status !== 'ready') checks.push(['warn', "WhatsApp isn't connected right now. This will wait until it is."]);
    if (s.dryRun) checks.push(['warn', "Practice mode is on, so this won't actually reach WhatsApp."]);
    if (!checks.some(x => x[0] === 'bad')) checks.push(['ok', `Each group gets it once, ${pacingLabel({ gapMin: Math.max(30, c.gapMin), gapMax: Math.max(30, c.gapMin, c.gapMax) })}, after a few seconds of "typing…".`]);
    $('#checks').innerHTML = checks.map(([k, t, act]) => `<li class="${k}">${k === 'ok' ? ICON.ok : ICON.warn}<span>${esc(t)}</span>${act?.fix ? `<button type="button" class="btn btn-ghost btn-sm fix" data-fix="${act.fix}">Move to ${esc(shortDate(istEpoch(act.fix, c.time)))}</button>` : ''}</li>`).join('');
    // submit
    const blocked = checks.some(x => x[0] === 'bad');
    const btn = $('#job-submit'); btn.disabled = blocked;
    btn.textContent = c.mode === 'edit' ? 'Save changes' : runAt && !blocked ? `Schedule for ${relDay(runAt) || shortDate(runAt)}, ${c.time}` : 'Schedule';
  }
  $('#checks').addEventListener('click', e => {
    const b = e.target.closest('[data-fix]'); if (!b) return;
    const c = C(); c.date = b.dataset.fix; $('#date').value = c.date; renderDayChips(); markDirty(); toast(`Moved to ${shortDate(istEpoch(c.date, c.time))}`);
  });
  $('#pv-next').addEventListener('click', () => { const c = C(); c.pvIdx = (c.pvIdx || 0) + 1; updateCompose(); });

  // "Weekend cohorts usually goes out Sat at 10:00 · Use that"
  function usualFor(picked) {
    const ids = new Set(picked.map(g => g.id));
    return S.lists.find(l => l.usual && l.groups.length && l.groups.every(g => ids.has(g.id)) && l.groups.length >= ids.size * 0.8);
  }
  function usualDate(u) {
    const nowIst = ist(Date.now());
    for (let i = 0; i < 8; i++) { const x = ist(Date.now() + i * DAY); if (x.dow === u.dow && (i > 0 || u.time > nowIst.time)) return x.date; }
    return null;
  }
  function renderUsual(picked) {
    const c = C(); const el = $('#usual');
    const l = c.mode === 'edit' ? null : usualFor(picked);
    const d = l && usualDate(l.usual);
    const same = l && c.date === d && c.time === l.usual.time && c.gapMin === l.usual.gapMin && c.gapMax === l.usual.gapMax;
    if (!l || !d || same) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML = `<span>“${esc(l.name)}” usually goes out ${DAYS_FULL[l.usual.dow]} at ${esc(l.usual.time)}${l.usual.repeat.length ? `, every ${esc(repeatLabel(l.usual.repeat))}` : ''}.</span><button type="button" class="btn btn-ghost" data-usual="${l.id}">Use that</button>`;
  }
  $('#usual').addEventListener('click', e => {
    const b = e.target.closest('[data-usual]'); if (!b) return;
    const c = C(); const l = S.lists.find(x => String(x.id) === b.dataset.usual); const u = l.usual;
    c.date = usualDate(u); c.time = u.time; c.gapMin = u.gapMin; c.gapMax = u.gapMax;
    c.pace = u.gapMin === 60 && u.gapMax === 180 ? 'gentle' : u.gapMin === 40 && u.gapMax === 120 ? 'standard' : 'custom';
    if (u.repeat.length) { c.repeat = [...u.repeat]; $('#repeat-on').checked = true; $$('#repeat-days input').forEach(i => { i.checked = c.repeat.includes(Number(i.value)); }); }
    $('#date').value = c.date; $('#time').value = c.time; $('#gapMin').value = c.gapMin; $('#gapMax').value = c.gapMax;
    renderDayChips(); renderPace(); markDirty();
  });
  function i18nTime(t, runAt) { return (t - runAt < 60000 ? '' : '~') + ist(t).time; }

  $('#test-send').addEventListener('click', async () => {
    const c = C();
    if (!c.message.trim() && !c.imageUrl && !c.imageLink) { toast('Write the message first', true); return; }
    const first = [...c.picked.values()].sort(byName)[(c.pvIdx || 0) % Math.max(1, c.picked.size)];
    const at = c.date && c.time ? istEpoch(c.date, c.time) : Date.now();
    const fd = new FormData(); fd.set('message', renderMessage(c.message, first?.name, at)); fd.set('linkPreview', c.linkPreview ? '1' : '0');
    if (c.image) fd.set('image', c.image); else if (c.imageLink) fd.set('imageUrl', c.imageLink); else if (c.keepImage && c.id) fd.set('jobImage', String(c.id));
    const b = $('#test-send'); b.disabled = true;
    try { const r = await api('test-send', { method: 'POST', form: fd }); toast(`Test sent to ${r.to}. Open "Message yourself" in WhatsApp.`); $('#test-hint').textContent = `Last test sent ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}. Check the "Message yourself" chat on the phone.`; }
    catch (err) { toast(err.message, true); }
    finally { setTimeout(() => { b.disabled = false; }, 3000); }
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const c = C(); $('#job-error').textContent = '';
    const fd = new FormData();
    fd.set('title', ''); fd.set('message', c.message);
    fd.set('groups', JSON.stringify([...c.picked.values()].sort(byName).map(g => g.id)));
    fd.set('date', c.date); fd.set('time', c.time);
    fd.set('gapMin', String(Math.max(30, c.gapMin))); fd.set('gapMax', String(Math.max(30, c.gapMin, c.gapMax)));
    fd.set('repeatDays', JSON.stringify($('#repeat-on').checked ? c.repeat : []));
    if (c.image) fd.set('image', c.image);
    if (c.imageLink) fd.set('imageUrl', c.imageLink);
    fd.set('linkPreview', c.linkPreview ? '1' : '0');
    if (c.removeImage) fd.set('removeImage', '1');
    const btn = $('#job-submit'); btn.disabled = true; const label = btn.textContent; btn.textContent = 'Saving…';
    try {
      if (c.mode === 'edit') await api('jobs/' + c.id, { method: 'PUT', form: fd });
      else await api('jobs', { method: 'POST', form: fd });
      store.set('wabox.lastTime', c.time);
      if (c.mode === 'new') store.del(DRAFT_KEY);
      c.dirty = false;
      toast(c.mode === 'edit' ? 'Changes saved' : `Scheduled for ${whenLabel(istEpoch(c.date, c.time))}`);
      await loadJobs(); location.hash = 'scheduled';
    } catch (err) { $('#job-error').textContent = err.message; btn.disabled = false; btn.textContent = label; }
  });
  $('#compose-discard').addEventListener('click', async () => {
    const c = C();
    if (c.mode === 'new') {
      if ((c.message || c.picked.size) && !await dialog({ title: 'Clear this message?', html: '<p>Your draft and selected groups will be cleared.</p>', ok: 'Clear', danger: true })) return;
      store.del(DRAFT_KEY); S.params = {}; openCompose();
    } else { c.dirty = false; history.length > 1 ? history.back() : (location.hash = 'scheduled'); }
  });
  window.addEventListener('beforeunload', e => { if (S.view === 'compose' && S.compose?.dirty && S.compose.mode !== 'new') { e.preventDefault(); e.returnValue = ''; } });

  // ============ WhatsApp (admin) ============
  async function renderWhatsapp() {
    await Promise.all([refreshStatus(), loadGroups()]);
    const s = S.status.wa;
    const ready = s.status === 'ready';
    $('#wa-detail').innerHTML = `<div class="wa-state"><span class="dot ${ready ? 'ok' : 'warn'}"></span><span><b>${ready ? `Connected as ${esc(s.name || 'WhatsApp')}` : s.status === 'qr_ready' ? 'Waiting for you to scan the QR code' : s.status === 'unreachable' ? 'The WhatsApp gateway is starting or offline' : 'Not connected'}</b><small>${ready && s.phone ? '+' + esc(s.phone) : ready ? '' : 'Press “Show QR code”, then scan it from the phone.'}</small></span></div>`;
    $('#wa-connect').classList.toggle('hidden', ready);
    $('#wa-logout').classList.toggle('hidden', !ready);
    $('#qr-wrap').classList.add('hidden');
    if (!ready && s.status === 'qr_ready') pollQr();
    $('#keywords-form').keywords.value = (S.sync?.keywords || []).join(', ');
    renderSyncDetail();
  }
  function renderSyncDetail() {
    const s = S.sync; if (!s) return;
    $('#sync-detail').textContent = s.running ? 'Syncing now. Large accounts can take a minute or two.' : s.error ? `Last sync failed: ${s.error}` :
      s.finishedAt ? `${plural(s.saved, 'group')} shown to your team. Last synced ${ago(s.finishedAt)}${s.total ? `, out of ${s.total} groups on this number` : ''}.` : 'Not synced yet. It runs once automatically after WhatsApp connects.';
    $('#wa-sync').disabled = !!s.running;
  }
  function pollQr() {
    clearInterval(S.qrTimer);
    const tick = async () => {
      if (S.view !== 'whatsapp') { clearInterval(S.qrTimer); return; }
      try {
        const r = await api('wa/qr');
        if (r.qrCode) { $('#qr-img').src = r.qrCode; $('#qr-wrap').classList.remove('hidden'); }
        await refreshStatus();
        if (S.status.wa.status === 'ready') { clearInterval(S.qrTimer); toast('WhatsApp connected. Groups sync in a minute or two.'); renderWhatsapp(); }
      } catch { /* keep polling */ }
    };
    tick(); S.qrTimer = setInterval(tick, 4000);
  }
  $('#wa-connect').addEventListener('click', async () => {
    try { await api('wa/start', { method: 'POST' }); toast('Starting WhatsApp. The QR code appears in a few seconds.'); pollQr(); } catch (err) { toast(err.message, true); }
  });
  $('#wa-logout').addEventListener('click', async () => {
    if (!await dialog({ title: 'Unlink this number?', html: "<p>WA Box is removed from the phone's linked devices. Nothing sends until someone scans the QR code again.</p>", ok: 'Unlink', danger: true })) return;
    try { await api('wa/logout', { method: 'POST' }); toast('Number unlinked'); renderWhatsapp(); } catch (err) { toast(err.message, true); }
  });
  $('#wa-sync').addEventListener('click', syncGroups);
  $('#keywords-form').addEventListener('submit', async e => {
    e.preventDefault(); $('#keywords-error').textContent = '';
    try { await api('groups/keywords', { method: 'PUT', body: { keywords: e.target.keywords.value } }); toast('Keywords saved'); await syncGroups(); }
    catch (err) { $('#keywords-error').textContent = err.message; }
  });

  // ============ Team (admin) ============
  async function renderTeam() {
    try {
      const { users } = await api('users');
      $('#users-table tbody').innerHTML = users.map(u => `<tr data-id="${u.id}"><td><b>${esc(u.username)}</b>${u.username === S.me.username ? ' <span class="hint">(you)</span>' : ''}</td><td>${u.role === 'admin' ? 'Admin' : 'Member'}</td>
        <td>${u.disabled ? '<span class="pill cancelled">Disabled</span>' : u.must_change ? '<span class="pill scheduled">Hasn\'t signed in yet</span>' : '<span class="pill done">Active</span>'}</td>
        <td class="actions"><button class="btn btn-ghost btn-sm" data-act="reset" type="button">Reset password</button>
        ${u.username === S.me.username ? '' : `<button class="btn ${u.disabled ? 'btn-ghost' : 'btn-danger-ghost'} btn-sm" data-act="${u.disabled ? 'enable' : 'disable'}" type="button">${u.disabled ? 'Enable' : 'Disable'}</button>`}</td></tr>`).join('');
    } catch (err) { toast(err.message, true); }
  }
  $('#users-table').addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const id = b.closest('tr').dataset.id;
    try {
      if (b.dataset.act === 'reset') {
        if (!await dialog({ title: 'Reset password', ok: 'Reset password', html: '<p>They\'ll be signed out and asked to choose a new password next time.</p><label class="fld"><span>Temporary password</span><input id="reset-pw" minlength="10" autocomplete="off"><small>At least 10 characters. Share it privately.</small></label>', onOpen: () => $('#reset-pw').focus() })) return;
        await api(`users/${id}/reset`, { method: 'POST', body: { password: $('#reset-pw').value } }); toast('Password reset');
      } else {
        const dis = b.dataset.act === 'disable';
        if (dis && !await dialog({ title: 'Disable this person?', html: "<p>They're signed out right away and can't sign in. Messages they scheduled still go out.</p>", ok: 'Disable', danger: true })) return;
        await api(`users/${id}/disable`, { method: 'POST', body: { disabled: dis } }); toast(dis ? 'Disabled' : 'Enabled');
      }
      renderTeam();
    } catch (err) { toast(err.message, true); }
  });
  $('#user-form').addEventListener('submit', async e => {
    e.preventDefault(); $('#user-error').textContent = '';
    try { await api('users', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); toast('Person added'); renderTeam(); }
    catch (err) { $('#user-error').textContent = err.message; }
  });

  // ============ Settings (admin) ============
  async function renderSettings() {
    await refreshStatus();
    const s = S.status, f = $('#settings-form');
    f.dryRun.checked = s.dryRun; f.paused.checked = s.paused; f.dailyCap.value = s.dailyCap; f.maxLateMin.value = s.maxLateMin;
    f.hourlyCap.value = s.hourlyCap; f.dedupeHours.value = s.dedupeHours;
    try {
      const sys = await api('system'); const af = $('#alerts-form');
      af.alertWebhook.value = ''; af.alertWebhook.placeholder = sys.alerts.webhookSet ? 'A link is saved. Paste a new one to replace it.' : 'https://hooks.slack.com/… or Google Chat / Discord webhook';
      $('#webhook-current').textContent = sys.alerts.webhookSet ? `Saved: ${sys.alerts.webhook}` : 'Slack, Google Chat and Discord all give you a link like this.';
      af.alertWaNumbers.value = sys.alerts.waNumbers.join(', '); af.alertDigest.checked = sys.alerts.digest;
    } catch { /* ignore */ }
    try {
      const { audit } = await api('audit');
      const words = { login: 'Signed in', login_failed: 'Failed sign-in', job_created: 'Scheduled a message', job_edited: 'Edited a message', job_cancelled: 'Cancelled a message',
        job_send_now: 'Started a message early', job_missed: 'A message was missed', daily_cap: 'Daily limit reached', wa_start: 'Started WhatsApp', wa_logout: 'Unlinked WhatsApp',
        dry_run: 'Changed practice mode', paused: 'Paused or resumed sending', user_created: 'Added a person', user_reset: 'Reset a password', user_disabled: 'Disabled a person',
        user_enabled: 'Enabled a person', groups_synced: 'Synced groups', group_keywords: 'Changed group keywords', list_saved: 'Saved a group list', list_deleted: 'Deleted a group list',
        password_changed: 'Changed their password', seed_admin: 'Created the first admin', admin_renamed: 'Renamed the admin account' };
      $('#audit-table tbody').innerHTML = audit.map(a => `<tr><td class="when">${esc(whenLabel(a.at))}</td><td>${esc(a.actor)}</td><td>${esc(words[a.action] || a.action.replace(/_/g, ' '))} <span class="hint">${esc(a.detail)}</span></td></tr>`).join('');
    } catch { /* ignore */ }
  }
  $('#settings-form').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target; $('#settings-error').textContent = '';
    if (!f.dryRun.checked && S.status.dryRun && !await dialog({ title: 'Go live?', html: '<p>Scheduled messages will really be sent to your WhatsApp groups from now on.</p>', ok: 'Go live' })) return;
    try {
      await api('settings', { method: 'PUT', body: { dryRun: f.dryRun.checked, paused: f.paused.checked, dailyCap: Number(f.dailyCap.value), maxLateMin: Number(f.maxLateMin.value), hourlyCap: Number(f.hourlyCap.value), dedupeHours: Number(f.dedupeHours.value) } });
      toast('Settings saved'); renderSettings();
    } catch (err) { $('#settings-error').textContent = err.message; }
  });

  $('#alerts-form').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target; $('#alerts-error').textContent = '';
    const body = { alertWaNumbers: f.alertWaNumbers.value, alertDigest: f.alertDigest.checked };
    if (f.alertWebhook.value.trim()) body.alertWebhook = f.alertWebhook.value.trim();
    try { await api('settings', { method: 'PUT', body }); toast('Alerts saved'); renderSettings(); }
    catch (err) { $('#alerts-error').textContent = err.message; }
  });
  $('#alert-test').addEventListener('click', async () => {
    try { const r = await api('alerts/test', { method: 'POST' }); toast('Test alert sent via ' + r.delivered.join(', ')); }
    catch (err) { toast(err.message, true); }
  });

  // ============ System (admin) ============
  S.logLevel = '';
  async function renderSystem() {
    let sys;
    try { sys = await api('system'); } catch (err) { toast(err.message, true); return; }
    const h = sys.health, now = Date.now();
    const waOk = h.whatsapp.status === 'ready';
    const cards = [
      [h.scheduler.ok ? 'ok' : 'bad', 'Scheduler', h.scheduler.ok ? 'Running' : 'Not responding', `Last check ${ago(h.scheduler.lastTickAt || now)}${h.scheduler.leader ? '' : ' · standby copy'}`],
      [waOk ? 'ok' : 'bad', 'WhatsApp', waOk ? 'Connected' : (h.whatsapp.status || 'Unknown'), `${waOk ? 'Since' : 'Changed'} ${ago(h.whatsapp.since)}${h.whatsapp.error ? ' · ' + h.whatsapp.error : ''}`],
      [h.settings.paused ? 'warn' : h.settings.dryRun ? 'warn' : 'ok', 'Sending', h.settings.paused ? 'Paused' : h.settings.dryRun ? 'Practice mode' : 'Live', `${h.queue} scheduled${h.nextJob ? ` · next ${whenLabel(h.nextJob.start_at)}` : ''}`],
      [h.fail24 ? 'warn' : 'ok', 'Last 24 hours', `${h.sent24} sent · ${h.fail24} problem${h.fail24 === 1 ? '' : 's'}`, h.lastSuccessAt ? `Last successful send ${ago(h.lastSuccessAt)}` : 'Nothing sent yet'],
    ];
    $('#health').innerHTML = cards.map(([k, t, v, sub]) => `<div class="hcard ${k === 'ok' ? '' : k}"><small>${t}</small><b><span class="dot ${k}"></span>${esc(v)}</b><span class="sub">${esc(sub)}</span></div>`).join('');
    $('#decisions').innerHTML = sys.unconfirmed.length ? `<h2 class="sec-title">Needs your decision</h2>` + sys.unconfirmed.map(u => `<div class="decision">
      <b>Did “${esc(u.group_name)}” get this message?</b><p>${esc(firstLine(u.message))}</p><p>${esc(u.error || (u.status === 'sending' ? 'In progress or interrupted. Being checked now.' : ''))}</p>
      ${u.status === 'unconfirmed' ? `<div class="btn-row"><button class="btn btn-ghost btn-sm" data-job="${u.job_id}" type="button">Open message</button></div>` : ''}</div>`).join('') : '';
    $('#issues').innerHTML = sys.issues.map(i => `<div class="issue-row"><span class="dot ${i.level === 'error' ? 'bad' : 'warn'}"></span><span><p>${esc(i.message)}</p><small>${i.last_at ? 'Announced ' + ago(i.last_at) : 'Not announced yet'}</small></span><button class="btn btn-ghost btn-sm" type="button" data-dismiss="${esc(i.key)}">Dismiss</button></div>`).join('');
    $('#sys-version').textContent = `Version ${String(sys.version).slice(0, 7)} · instance ${sys.instance}`;
    renderLog();
  }
  async function renderLog() {
    const q = $('#log-search').value.trim();
    try {
      const { events } = await api(`events?level=${S.logLevel}&q=${encodeURIComponent(q)}`);
      $('#log-table tbody').innerHTML = events.length ? events.map(e => `<tr><td class="when">${esc(whenLabel(e.at))}:${pad(new Date(e.at).getSeconds())}</td>
        <td class="lvl"><span class="lvl-dot ${e.level}"></span>${e.level === 'info' ? 'Info' : e.level === 'warn' ? 'Warning' : 'Error'}</td>
        <td>${esc(e.kind.replace(/_/g, ' '))}${e.job_id ? ` <a href="#scheduled" data-job="${e.job_id}">#${e.job_id}</a>` : ''}${e.group_name ? `<br><span class="hint">${esc(e.group_name)}</span>` : ''}</td>
        <td class="detail">${esc(e.message)}</td></tr>`).join('') : '<tr class="empty-row"><td colspan="4">No events match.</td></tr>';
    } catch (err) { toast(err.message, true); }
  }
  $('#log-tabs').addEventListener('click', e => { const b = e.target.closest('[data-level]'); if (!b) return; S.logLevel = b.dataset.level; $$('#log-tabs button').forEach(x => x.classList.toggle('on', x === b)); renderLog(); });
  $('#log-search').addEventListener('input', () => { clearTimeout(S.logT); S.logT = setTimeout(renderLog, 250); });
  $('#sys-refresh').addEventListener('click', renderSystem);
  $('#issues').addEventListener('click', async e => {
    const b = e.target.closest('[data-dismiss]'); if (!b) return;
    try { await api('issues/' + encodeURIComponent(b.dataset.dismiss) + '/dismiss', { method: 'POST' }); toast('Dismissed'); renderSystem(); refreshStatus(); } catch (err) { toast(err.message, true); }
  });
  ['#decisions', '#log-table'].forEach(sel => $(sel).addEventListener('click', async e => {
    const r = e.target.closest('[data-job]'); if (!r) return; e.preventDefault(); await loadJobs(); openDrawer(Number(r.dataset.job));
  }));

  // ============ Keyboard shortcuts ============
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  $('#mod-key').textContent = isMac ? '⌘' : 'Ctrl';
  function showShortcuts() {
    const m = isMac ? '⌘' : 'Ctrl';
    dialog({ title: 'Keyboard shortcuts', ok: null, cancel: 'Close', html: `<dl class="keys">
      <dt><kbd>N</kbd></dt><dd>New message</dd>
      <dt><kbd>/</kbd></dt><dd>Search groups (while writing)</dd>
      <dt><kbd>${m}</kbd> <kbd>↵</kbd></dt><dd>Schedule the message</dd>
      <dt><kbd>${m}</kbd> <kbd>B</kbd> / <kbd>${m}</kbd> <kbd>I</kbd></dt><dd>Bold / italic</dd>
      <dt><kbd>G</kbd> then <kbd>T</kbd> / <kbd>S</kbd> / <kbd>H</kbd></dt><dd>Go to Today / Scheduled / Sent</dd>
      <dt><kbd>Esc</kbd></dt><dd>Close a panel</dd>
      <dt><kbd>?</kbd></dt><dd>This list</dd></dl>` });
  }
  $('#shortcuts-open').addEventListener('click', showShortcuts);
  let gPending = 0;
  document.addEventListener('keydown', e => {
    if (!S.me || e.metaKey || e.ctrlKey || e.altKey || $('#dialog').open) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
    if (e.key === '?') { e.preventDefault(); showShortcuts(); return; }
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); location.hash = 'compose'; return; }
    if (e.key === '/' && S.view === 'compose') { e.preventDefault(); $('#group-search').focus(); return; }
    if (e.key === 'g') { gPending = Date.now(); return; }
    if (Date.now() - gPending < 1200) {
      const to = { t: 'today', s: 'scheduled', h: 'sent' }[e.key];
      if (to) { e.preventDefault(); location.hash = to; } gPending = 0;
    }
  });

  boot();
})();
