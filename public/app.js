// Dispatch web app: plain JS, no build step. All user content goes through
// text nodes (never innerHTML), so post text can't inject markup.

const app = document.getElementById('app');
const state = { settings: null, channels: [], networks: [], counts: {} };

// ---------- helpers ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? el.style.setProperty(sk, sv) : (el.style[sk] = sv);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/me')) {
    boot();
    throw new Error('Please log in again');
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = bad ? 'bad' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), bad ? 6000 : 3000);
}

async function guard(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

const tz = () => state.settings?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
const NET_COLORS = { facebook: '#1877f2', instagram: '#d62976', bluesky: '#1185fe', mastodon: '#6364ff', threads: '#888', linkedin: '#0a66c2', x: '#666', webhook: '#c2410c', reminder: '#15803d', test: '#9ca3af' };

function parts(date, zone = tz()) {
  const out = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}
function zonedToUtc(y, mo, d, hh, mm, zone = tz()) {
  const off = (t) => {
    const p = parts(new Date(t), zone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
  };
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  const o1 = off(guess);
  const t1 = guess - o1;
  const o2 = off(t1);
  if (o2 === o1) return new Date(t1);
  const t2 = guess - o2;
  return new Date(off(t2) === o2 ? t2 : Math.max(t1, t2));
}
const fmt = (iso, opts) => new Intl.DateTimeFormat(undefined, { timeZone: tz(), ...opts }).format(new Date(iso));
const fmtTime = (iso) => fmt(iso, { hour: 'numeric', minute: '2-digit' });
const fmtDay = (iso) => fmt(iso, { weekday: 'long', month: 'long', day: 'numeric' });
const fmtFull = (iso) => fmt(iso, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dayKey = (iso) => {
  const p = parts(new Date(iso));
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};
function toLocalInput(iso) {
  const p = parts(new Date(iso));
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
function fromLocalInput(value) {
  const [date, time] = value.split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return zonedToUtc(y, mo, d, hh, mm).toISOString();
}

// Character counting that mirrors each network's rules (the server re-checks).
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const URL_RE = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;
function countFor(network, text) {
  if (network === 'bluesky') return [...segmenter.segment(text)].length;
  if (network === 'mastodon') return [...text.replace(/https?:\/\/\S+/g, 'x'.repeat(23))].length;
  if (network === 'x') {
    let n = 0;
    for (const ch of text.replace(URL_RE, '\u0000'.repeat(23))) {
      const cp = ch.codePointAt(0);
      n += cp === 0 || cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037) ? 1 : 2;
    }
    return n;
  }
  return [...text].length;
}

const channelById = (id) => state.channels.find((c) => c.id === id);
const isVideoUrl = (url) => /\.(mp4|mov)(\?|#|$)/i.test(url || '');

// Upload with progress (fetch can't report upload progress).
function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/uploads');
    xhr.setRequestHeader('X-Upload-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed: the connection dropped'));
    xhr.send(file);
  });
}
function netBadge(network, name) {
  return h('span', { class: 'badge', style: { '--net': NET_COLORS[network] || '#888' } }, h('span', { class: 'dot' }), name);
}
function statusBadge(status) {
  const map = { published: ['ok', 'Published'], failed: ['bad', 'Failed'], draft: ['', 'Draft'], scheduled: ['', 'Scheduled'], publishing: ['warn', 'Publishing…'] };
  const [cls, label] = map[status] || ['', status];
  return h('span', { class: `badge ${cls}` }, label);
}

// ---------- boot & auth ----------
async function boot() {
  const me = await api('/api/me');
  if (me.setup_required) return renderSetup();
  if (!me.authenticated) return renderLogin();
  await refresh();
  if (!location.hash) location.hash = state.channels.length ? '#/queue' : '#/channels';
  route();
}

async function refresh() {
  const [settings, channels, networks, summary] = await Promise.all([api('/api/settings'), api('/api/channels'), api('/api/networks'), api('/api/summary')]);
  Object.assign(state, { settings, channels, networks, counts: summary.counts });
}

function authCard(title, intro, fields, submitLabel, onSubmit) {
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    await guard(form.querySelector('button'), () => onSubmit(new FormData(form)));
  } }, fields, h('button', { class: 'btn primary', type: 'submit' }, submitLabel));
  app.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'card' },
    h('div', { class: 'brand' }, h('img', { src: '/icon.svg', alt: '' }), 'Dispatch'),
    h('h1', {}, title), h('p', { class: 'sub' }, intro), h('div', { style: { height: '16px' } }), form)));
  form.querySelector('input')?.focus();
}

function renderSetup() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  authCard('Welcome', 'Set a password to protect your scheduler. You will use it to log in from any browser.', [
    h('label', { class: 'field' }, 'Password', h('input', { type: 'password', name: 'password', id: 'setup-password', autocomplete: 'new-password', minlength: '10', required: true }), h('span', { class: 'help' }, 'At least 10 characters.')),
    h('label', { class: 'field' }, 'Time zone', h('input', { type: 'text', name: 'timezone', id: 'setup-tz', value: zone }), h('span', { class: 'help' }, 'Queue times use this zone. Detected from your browser.')),
  ], 'Set password and start', async (fd) => {
    await api('/api/setup', { method: 'POST', body: { password: fd.get('password'), timezone: fd.get('timezone') } });
    boot();
  });
}

function renderLogin() {
  authCard('Log in', 'Enter your Dispatch password.', [
    h('label', { class: 'field' }, 'Password', h('input', { type: 'password', name: 'password', id: 'login-password', autocomplete: 'current-password', required: true })),
  ], 'Log in', async (fd) => {
    await api('/api/login', { method: 'POST', body: { password: fd.get('password') } });
    boot();
  });
}

// ---------- shell & routing ----------
const VIEWS = {
  queue: { label: 'Queue', render: viewQueue, count: 'scheduled' },
  calendar: { label: 'Calendar', render: viewCalendar },
  drafts: { label: 'Drafts', render: () => viewList('draft', 'Drafts', 'Saved posts that are not scheduled yet.'), count: 'draft' },
  sent: { label: 'Sent', render: () => viewList('published', 'Sent', 'Posts Dispatch has published.') },
  failed: { label: 'Failed', render: () => viewList('failed', 'Failed', 'Posts that could not be published. Fix the problem, then retry.'), count: 'failed' },
  ideas: { label: 'Ideas', render: viewIdeas },
  channels: { label: 'Channels', render: viewChannels },
  settings: { label: 'Settings', render: viewSettings },
};

function route() {
  const name = location.hash.replace('#/', '') || 'queue';
  const view = VIEWS[name] || VIEWS.queue;
  const main = h('main', { id: 'main' });
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' },
    Object.entries(VIEWS).map(([key, v]) => h('a', { href: `#/${key}`, class: key === name ? 'on' : '', 'aria-current': key === name ? 'page' : false },
      v.label, v.count && state.counts[v.count] ? h('span', { class: 'count' }, state.counts[v.count]) : null)));
  const newBtn = () => h('button', { class: 'btn primary new', onclick: () => openComposer() }, '+ New post');
  app.replaceChildren(h('div', { class: 'shell' },
    h('aside', { class: 'side' }, h('div', { class: 'brand' }, h('img', { src: '/icon.svg', alt: '' }), 'Dispatch'), newBtn(), nav, h('div', { class: 'spacer' }),
      h('button', { class: 'btn ghost small', onclick: async () => { await api('/api/logout', { method: 'POST', body: {} }); boot(); } }, 'Log out')),
    main,
    h('button', { class: 'btn primary fab', onclick: () => openComposer() }, '+ New post')));
  Promise.resolve(view.render(main)).catch((err) => main.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Could not load this page'), h('p', {}, err.message))));
}
window.addEventListener('hashchange', route);

async function reload() {
  await refresh();
  route();
}

function pageHead(title, sub, ...actions) {
  return h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub ? h('p', { class: 'sub' }, sub) : null), h('div', { class: 'row' }, actions));
}

function noChannels() {
  return h('div', { class: 'empty' }, h('h2', {}, 'Connect your first channel'),
    h('p', {}, 'Add a social account so Dispatch has somewhere to post. Bluesky and Mastodon take about a minute; the test channel needs nothing at all.'),
    h('a', { class: 'btn primary', href: '#/channels' }, 'Add a channel'));
}

// ---------- post cards ----------
function postCard(p, { showDate = false } = {}) {
  const when = p.status === 'published' ? p.published_at : p.scheduled_at;
  const actions = [];
  if (['scheduled', 'draft', 'failed'].includes(p.status)) {
    actions.push(h('button', { class: 'btn small', onclick: () => openComposer({ post: p }) }, 'Edit'));
    actions.push(h('button', { class: 'btn small', onclick: (e) => guard(e.target, async () => {
      const r = await api(`/api/posts/${p.id}/publish`, { method: 'POST', body: {} });
      toast(r.status === 'published' ? 'Published' : `Not published: ${r.last_error || r.status}`, r.status !== 'published');
      reload();
    }) }, p.status === 'failed' ? 'Retry now' : 'Post now'));
  }
  if (p.remote_url) actions.push(h('a', { class: 'btn small', href: p.remote_url, target: '_blank', rel: 'noopener' }, 'View'));
  actions.push(h('button', { class: 'btn small danger', 'aria-label': 'Delete post', onclick: (e) => guard(e.target, async () => {
    await api(`/api/posts/${p.id}`, { method: 'DELETE' });
    toast('Deleted');
    reload();
  }) }, 'Delete'));
  return h('article', { class: 'post' },
    h('div', { class: 'time' }, when ? (showDate ? fmt(when, { month: 'short', day: 'numeric' }) : fmtTime(when)) : '—', when && showDate ? h('small', {}, fmtTime(when)) : p.queued ? h('small', {}, 'queue') : null),
    h('div', {},
      h('div', { class: 'meta' }, netBadge(p.network, p.channel_name), p.status !== 'scheduled' ? statusBadge(p.status) : null, p.source !== 'web' ? h('span', {}, `via ${p.source.toUpperCase()}`) : null),
      h('div', { class: 'text' }, p.text),
      p.image_url ? (isVideoUrl(p.image_url) ? h('video', { class: 'thumb', src: p.image_url, preload: 'metadata', muted: true, controls: true }) : h('img', { class: 'thumb', src: p.image_url, alt: 'Attached image', loading: 'lazy' })) : null,
      p.last_error && p.status !== 'published' ? h('div', { class: 'error' }, p.status === 'scheduled' ? `Retrying: ${p.last_error}` : p.last_error) : null),
    h('div', { class: 'actions' }, actions));
}

// ---------- views ----------
async function viewQueue(main) {
  if (!state.channels.length) return main.replaceChildren(pageHead('Queue'), noChannels());
  const filter = sessionStorage.getItem('queueChannel') || '';
  const posts = await api(`/api/posts?status=scheduled,publishing${filter ? `&channel_id=${filter}` : ''}`);
  const chips = h('div', { class: 'chips' },
    [{ id: '', name: 'All channels' }, ...state.channels].map((c) => h('button', { class: `chip ${filter === c.id ? 'on' : ''}`, onclick: () => { sessionStorage.setItem('queueChannel', c.id); route(); } }, c.name)));
  const list = [];
  let lastDay = null;
  for (const p of posts) {
    const k = dayKey(p.scheduled_at);
    if (k !== lastDay) {
      list.push(h('div', { class: 'day' }, k === dayKey(new Date().toISOString()) ? 'Today' : fmtDay(p.scheduled_at)));
      lastDay = k;
    }
    list.push(postCard(p));
  }
  main.replaceChildren(
    pageHead('Queue', `Upcoming posts, shown in ${tz()}.`, h('button', { class: 'btn primary', onclick: () => openComposer() }, '+ New post')),
    chips,
    posts.length ? h('div', {}, list) : h('div', { class: 'empty', style: { marginTop: '16px' } }, h('h2', {}, 'Your queue is empty'), h('p', {}, 'Write a post and add it to the queue. Dispatch puts it in the next free time slot for each channel.'), h('button', { class: 'btn primary', onclick: () => openComposer() }, 'Write a post')));
}

async function viewList(status, title, sub) {
  const main = document.getElementById('main');
  const posts = await api(`/api/posts?status=${status}&limit=200`);
  main.replaceChildren(pageHead(title, sub),
    posts.length ? h('div', {}, posts.map((p) => postCard(p, { showDate: true }))) : h('div', { class: 'empty' }, h('p', {}, 'Nothing here yet.')));
}

let weekOffset = 0;
async function viewCalendar(main) {
  const now = new Date();
  const p = parts(now);
  const todayUtc = Date.UTC(p.year, p.month - 1, p.day);
  const dow = (new Date(todayUtc).getUTCDay() + 6) % 7; // Monday = 0
  const startDay = new Date(todayUtc - dow * 86400_000 + weekOffset * 7 * 86400_000);
  const days = [...Array(7)].map((_, i) => new Date(startDay.getTime() + i * 86400_000));
  const from = zonedToUtc(days[0].getUTCFullYear(), days[0].getUTCMonth() + 1, days[0].getUTCDate(), 0, 0);
  const end = new Date(days[6].getTime() + 86400_000);
  const to = zonedToUtc(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate(), 0, 0);
  const posts = await api(`/api/posts?status=scheduled,published,failed,publishing&from=${from.toISOString()}&to=${to.toISOString()}&limit=1000`);
  const byDay = {};
  for (const post of posts) (byDay[dayKey(post.published_at || post.scheduled_at)] ||= []).push(post);
  const label = `${days[0].toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${days[6].toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
  main.replaceChildren(
    pageHead('Calendar', label,
      h('button', { class: 'btn', onclick: () => { weekOffset--; route(); } }, '← Previous'),
      h('button', { class: 'btn', onclick: () => { weekOffset = 0; route(); } }, 'This week'),
      h('button', { class: 'btn', onclick: () => { weekOffset++; route(); } }, 'Next →')),
    h('div', { class: 'cal-wrap' }, h('div', { class: 'cal' }, days.map((d) => {
      const key = d.toISOString().slice(0, 10);
      const items = (byDay[key] || []).sort((a, b) => (a.published_at || a.scheduled_at).localeCompare(b.published_at || b.scheduled_at));
      return h('div', { class: `col ${d.getTime() === todayUtc ? 'today' : ''}` },
        h('h3', {}, d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' })),
        items.map((post) => h('button', { class: 'item', style: { '--net': NET_COLORS[post.network] }, onclick: () => (['scheduled', 'failed'].includes(post.status) ? openComposer({ post }) : post.remote_url && window.open(post.remote_url, '_blank', 'noopener')) },
          h('b', {}, `${fmtTime(post.published_at || post.scheduled_at)} · ${post.channel_name}${post.status === 'published' ? ' ✓' : post.status === 'failed' ? ' ✕' : ''}`),
          h('span', {}, post.text))));
    }))));
}

async function viewIdeas(main) {
  const ideas = await api('/api/ideas');
  const text = h('textarea', { id: 'idea-text', placeholder: 'A post idea, a link to share, a topic to cover…', style: { minHeight: '80px' } });
  const tags = h('input', { type: 'text', id: 'idea-tags', placeholder: 'Tags, comma separated (optional)' });
  const form = h('form', { class: 'card stack', onsubmit: (e) => {
    e.preventDefault();
    guard(form.querySelector('button'), async () => {
      await api('/api/ideas', { method: 'POST', body: { text: text.value, tags: tags.value } });
      toast('Idea saved');
      route();
    });
  } }, text, h('div', { class: 'row' }, tags, h('button', { class: 'btn primary', type: 'submit' }, 'Save idea')));
  main.replaceChildren(pageHead('Ideas', 'Collect ideas now and turn them into posts later.'), form, h('div', { style: { height: '16px' } }),
    ideas.length ? h('div', { class: 'grid-2' }, ideas.map((i) => h('div', { class: 'card stack' },
      h('div', { class: 'text', style: { whiteSpace: 'pre-wrap' } }, i.text),
      i.tags.length ? h('div', { class: 'chips' }, i.tags.map((t) => h('span', { class: 'badge' }, t))) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn small primary', onclick: () => openComposer({ text: i.text, ideaId: i.id }) }, 'Turn into post'),
        h('button', { class: 'btn small danger', onclick: (e) => guard(e.target, async () => { await api(`/api/ideas/${i.id}`, { method: 'DELETE' }); route(); }) }, 'Delete'))))) : h('div', { class: 'empty' }, h('p', {}, 'No ideas saved yet.')));
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function scheduleEditor(ch) {
  const schedule = { days: [...ch.schedule.days], times: [...ch.schedule.times] };
  const save = () => guard(null, async () => {
    await api(`/api/channels/${ch.id}`, { method: 'PATCH', body: { schedule } });
    toast('Schedule saved');
    await refresh();
  });
  const wrap = h('div', { class: 'stack', style: { gap: '8px' } });
  const draw = () => {
    const timeInput = h('input', { type: 'time', id: `time-${ch.id}`, style: { width: '130px' } });
    wrap.replaceChildren(
      h('div', { class: 'days', role: 'group', 'aria-label': 'Posting days' }, DAY_NAMES.map((d, i) => h('button', {
        class: schedule.days.includes(i + 1) ? 'on' : '', 'aria-pressed': String(schedule.days.includes(i + 1)),
        onclick: () => { schedule.days = schedule.days.includes(i + 1) ? schedule.days.filter((x) => x !== i + 1) : [...schedule.days, i + 1].sort(); draw(); save(); },
      }, d))),
      h('div', { class: 'times' }, schedule.times.length ? schedule.times.map((t) => h('span', { class: 'time-pill' }, t,
        h('button', { 'aria-label': `Remove ${t}`, onclick: () => { schedule.times = schedule.times.filter((x) => x !== t); draw(); save(); } }, '×'))) : h('span', { class: 'help' }, 'No posting times yet.')),
      h('div', { class: 'row' }, timeInput, h('button', { class: 'btn small', onclick: () => {
        if (!timeInput.value) return;
        schedule.times = [...new Set([...schedule.times, timeInput.value])].sort();
        draw();
        save();
      } }, 'Add time')));
  };
  draw();
  return wrap;
}

async function viewChannels(main) {
  const cards = state.channels.map((ch) => h('div', { class: 'card channel' },
    h('div', { class: 'top' },
      h('div', {}, h('div', { class: 'name' }, ch.name), h('div', { class: 'help' }, ch.handle || ''), h('div', { style: { marginTop: '6px' } }, netBadge(ch.network, ch.label), ' ', ch.active ? null : h('span', { class: 'badge warn' }, 'Paused'))),
      h('span', { class: 'help mono' }, `${ch.limit} chars`)),
    h('div', {}, h('div', { class: 'help', style: { marginBottom: '6px' } }, `Queue slots (${tz()})`), scheduleEditor(ch)),
    h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: (e) => guard(e.target, async () => { const r = await api(`/api/channels/${ch.id}/test`, { method: 'POST', body: {} }); toast(r.message, !r.ok); }) }, 'Test connection'),
      h('button', { class: 'btn small', onclick: (e) => guard(e.target, async () => { await api(`/api/channels/${ch.id}`, { method: 'PATCH', body: { active: !ch.active } }); reload(); }) }, ch.active ? 'Pause' : 'Resume'),
      h('button', { class: 'btn small danger', onclick: (e) => {
        if (e.target.dataset.confirm !== '1') { e.target.dataset.confirm = '1'; e.target.textContent = 'Click again to remove'; return; }
        guard(e.target, async () => { await api(`/api/channels/${ch.id}`, { method: 'DELETE' }); toast('Channel removed, with its posts'); reload(); });
      } }, 'Remove'))));
  main.replaceChildren(pageHead('Channels', 'The accounts Dispatch posts to.', h('button', { class: 'btn primary', onclick: openAddChannel }, '+ Add channel')),
    state.channels.length ? h('div', { class: 'grid-2' }, cards) : noChannels());
  if (!state.channels.length) main.querySelector('.empty a').replaceWith(h('button', { class: 'btn primary', onclick: openAddChannel }, 'Add a channel'));
}

function modal(title, body, footer) {
  const close = () => overlay.remove();
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('header', {}, h('h2', {}, title), h('button', { class: 'btn ghost', 'aria-label': 'Close', onclick: close }, '✕')),
      h('div', { class: 'body' }, body), footer ? h('footer', {}, footer(close)) : null));
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  overlay.querySelector('input, textarea, select')?.focus();
  return close;
}

function openAddChannel() {
  let network = state.networks[0].network;
  const body = h('div', { class: 'stack' });
  const values = {};
  const draw = () => {
    const def = state.networks.find((n) => n.network === network);
    body.replaceChildren(...[
      h('label', { class: 'field' }, 'Network', h('select', { id: 'add-network', onchange: (e) => { network = e.target.value; draw(); } },
        state.networks.map((n) => h('option', { value: n.network, selected: n.network === network }, n.label)))),
      def.fields.map((f) => h('label', { class: 'field' }, f.label,
        h('input', { type: f.secret ? 'password' : 'text', id: `f-${f.key}`, placeholder: f.placeholder || '', autocomplete: 'off', value: values[f.key] || '', oninput: (e) => (values[f.key] = e.target.value) }),
        f.help ? h('span', { class: 'help' }, f.help) : null)),
      ['webhook', 'reminder'].includes(network) ? h('p', { class: 'help' }, 'Use this for TikTok, Pinterest or YouTube: their posting APIs need app review, so either let an automation tool post for you (webhook) or get a phone reminder and post by hand.') : null,
    ].flat().filter(Boolean));
  };
  draw();
  modal('Add a channel', body, (close) => [
    h('button', { class: 'btn', onclick: close }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: (e) => guard(e.target, async () => {
      const def = state.networks.find((n) => n.network === network);
      const credentials = Object.fromEntries(def.fields.map((f) => [f.key, values[f.key] || '']));
      const r = await api('/api/channels', { method: 'POST', body: { network, credentials } });
      close();
      toast(r.warning || `Connected ${r.channel.name}`);
      reload();
    }) }, 'Connect'),
  ]);
}

async function viewSettings(main) {
  const s = state.settings;
  const keys = await api('/api/keys');
  const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [s.timezone];
  const zoneSelect = h('select', { id: 'settings-tz' }, zones.map((z) => h('option', { value: z, selected: z === s.timezone }, z)));
  const base = s.public_url || location.origin;
  const keyName = h('input', { type: 'text', id: 'key-name', placeholder: 'Name, e.g. Claude Desktop' });
  const newKeyBox = h('div');
  const cur = h('input', { type: 'password', id: 'pw-current', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', id: 'pw-new', autocomplete: 'new-password', minlength: '10' });
  const copyBtn = (text) => h('button', { class: 'btn small', onclick: async (e) => {
    try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; } catch { toast('Select the text and copy it by hand', true); }
  } }, 'Copy');

  const claudeCode = `claude mcp add --transport http dispatch ${base}/mcp --header "Authorization: Bearer YOUR_API_KEY"`;
  const desktop = JSON.stringify({ mcpServers: { dispatch: { command: 'node', args: ['/path/to/dispatch/bin/dispatch-mcp.js'], env: { DISPATCH_URL: base, DISPATCH_API_KEY: 'YOUR_API_KEY' } } } }, null, 2);

  main.replaceChildren(pageHead('Settings'), h('div', { class: 'stack' },
    h('section', { class: 'card stack' }, h('h2', {}, 'Time zone'),
      h('p', { class: 'help' }, 'Queue slots and the calendar use this time zone.'),
      h('div', { class: 'row' }, h('div', { style: { flex: '1', minWidth: '220px' } }, zoneSelect), h('button', { class: 'btn primary', onclick: (e) => guard(e.target, async () => { await api('/api/settings', { method: 'PUT', body: { timezone: zoneSelect.value } }); toast('Time zone saved'); reload(); }) }, 'Save'))),

    h('section', { class: 'card stack' }, h('h2', {}, 'AI drafting'),
      s.ai_enabled ? h('p', {}, h('span', { class: 'badge ok' }, 'On'), ` Using ${s.ai_model}. Draft and rewrite buttons appear in the post editor.`) :
        h('p', {}, h('span', { class: 'badge' }, 'Off'), ' To turn it on, set ANTHROPIC_API_KEY in your environment (or .env file) and restart Dispatch.')),

    h('section', { class: 'card stack' }, h('h2', {}, 'API keys and AI agents'),
      h('p', { class: 'help' }, 'API keys let scripts and AI agents (Claude, Cursor, n8n…) read and schedule posts through the REST API or the MCP server. A key is shown once, so store it somewhere safe.'),
      h('div', { class: 'row' }, h('div', { style: { flex: '1', minWidth: '200px' } }, keyName), h('button', { class: 'btn primary', onclick: (e) => guard(e.target, async () => {
        const r = await api('/api/keys', { method: 'POST', body: { name: keyName.value } });
        newKeyBox.replaceChildren(h('div', { class: 'card stack', style: { background: 'var(--ok-soft)' } }, h('strong', {}, 'Your new key. Copy it now; it will not be shown again.'), h('div', { class: 'row' }, h('code', { class: 'mono', style: { overflowWrap: 'anywhere' } }, r.key), copyBtn(r.key))));
        keyName.value = '';
        const list = await api('/api/keys');
        keyList.replaceChildren(...renderKeys(list));
      }) }, 'Create key')),
      newKeyBox,
      h('div', { id: 'key-list' }),
      h('h2', { style: { marginTop: '8px' } }, 'Connect Claude Code'),
      h('div', { class: 'code' }, claudeCode), h('div', {}, copyBtn(claudeCode)),
      h('h2', { style: { marginTop: '8px' } }, 'Connect Claude Desktop'),
      h('p', { class: 'help' }, 'Add this to claude_desktop_config.json, with the real path to your Dispatch folder. Node 22 or newer must be installed.'),
      h('div', { class: 'code' }, desktop), h('div', {}, copyBtn(desktop)),
      h('p', { class: 'help' }, `MCP endpoint: ${base}/mcp · REST API: ${base}/api (send Authorization: Bearer YOUR_API_KEY)`)),

    h('section', { class: 'card stack' }, h('h2', {}, 'Change password'),
      h('label', { class: 'field' }, 'Current password', cur), h('label', { class: 'field' }, 'New password', next, h('span', { class: 'help' }, 'At least 10 characters. Other browsers will be logged out.')),
      h('div', {}, h('button', { class: 'btn', onclick: (e) => guard(e.target, async () => { await api('/api/password', { method: 'POST', body: { current: cur.value, password: next.value } }); toast('Password changed. Log in again.'); boot(); }) }, 'Change password')))));

  const keyList = main.querySelector('#key-list');
  function renderKeys(list) {
    return list.length ? list.map((k) => h('div', { class: 'keyline' },
      h('div', {}, h('strong', {}, k.name), h('div', { class: 'help mono' }, `${k.prefix}… · created ${fmtFull(k.created_at)}${k.last_used_at ? ` · last used ${fmtFull(k.last_used_at)}` : ' · never used'}`)),
      h('button', { class: 'btn small danger', onclick: (e) => guard(e.target, async () => { await api(`/api/keys/${k.id}`, { method: 'DELETE' }); toast('Key revoked'); route(); }) }, 'Revoke'))) : [h('p', { class: 'help' }, 'No API keys yet.')];
  }
  keyList.replaceChildren(...renderKeys(keys));
}

// ---------- composer ----------
function openComposer({ post, text = '', ideaId } = {}) {
  if (!state.channels.length) {
    toast('Add a channel first', true);
    location.hash = '#/channels';
    return;
  }
  const editing = Boolean(post);
  const active = state.channels.filter((c) => c.active);
  const selected = new Set(editing ? [post.channel_id] : JSON.parse(localStorage.getItem('lastChannels') || '[]').filter((id) => channelById(id)?.active));
  if (!selected.size && active.length === 1) selected.add(active[0].id);
  let mode = !editing ? 'queue' : post.status === 'draft' ? 'draft' : post.status === 'failed' ? 'queue' : post.queued ? 'keep' : 'schedule';

  const textarea = h('textarea', { id: 'compose-text', placeholder: 'What do you want to share?', value: editing ? post.text : text, oninput: update });
  const image = h('input', { type: 'url', id: 'compose-image', placeholder: 'Upload a file, or paste a public image or video link', value: editing ? post.image_url || '' : '', oninput: update });
  const preview = h('div', { class: 'preview' });
  const progress = h('span', { class: 'help upload-status', 'aria-live': 'polite' });
  const fileInput = h('input', { type: 'file', id: 'compose-file', accept: 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime', hidden: true, onchange: async () => {
    const file = fileInput.files[0];
    if (!file) return;
    uploadBtn.disabled = true;
    try {
      const r = await uploadFile(file, (f) => (progress.textContent = `Uploading ${file.name}… ${Math.round(f * 100)}%`));
      image.value = r.url;
      progress.textContent = `Uploaded ${file.name} (${r.size >= 1e6 ? `${(r.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(r.size / 1e3))} KB`})`;
      if (r.warning) toast(r.warning);
      update();
    } catch (err) {
      progress.textContent = '';
      toast(err.message, true);
    } finally {
      uploadBtn.disabled = false;
      fileInput.value = '';
    }
  } });
  const uploadBtn = h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, 'Upload file');
  const clearBtn = h('button', { class: 'btn ghost', type: 'button', 'aria-label': 'Remove media', onclick: () => { image.value = ''; progress.textContent = ''; update(); } }, 'Remove');
  const counters = h('div', { class: 'counters', 'aria-live': 'polite' });
  const when = h('input', { type: 'datetime-local', id: 'compose-when', value: editing && post.scheduled_at ? toLocalInput(post.scheduled_at) : toLocalInput(new Date(Date.now() + 3600_000).toISOString()) });
  const whenWrap = h('label', { class: 'field' }, `Date and time (${tz()})`, when);

  const chanChips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Channels' });
  function drawChannels() {
    chanChips.replaceChildren(...(editing ? [channelById(post.channel_id)] : active).map((c) => h('button', {
      class: `chip ${selected.has(c.id) ? 'on' : ''}`, 'aria-pressed': String(selected.has(c.id)), disabled: editing,
      onclick: () => { selected.has(c.id) ? selected.delete(c.id) : selected.add(c.id); drawChannels(); update(); },
    }, c.name.toLowerCase() === c.label.split(' ')[0].toLowerCase() ? c.name : `${c.name} · ${c.label.split(' ')[0]}`)));
  }

  const modes = editing
    ? [...(post.queued && post.status === 'scheduled' ? [['keep', 'Keep time']] : []), ['queue', 'Add to queue'], ['schedule', 'Pick a time'], ['now', 'Post now'], ['draft', 'Draft']]
    : [['queue', 'Add to queue'], ['schedule', 'Pick a time'], ['now', 'Post now'], ['draft', 'Save draft']];
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'When to post' });
  function drawModes() {
    seg.replaceChildren(...modes.map(([k, label]) => h('button', { class: mode === k ? 'on' : '', 'aria-pressed': String(mode === k), onclick: () => { mode = k; drawModes(); } }, label)));
    whenWrap.hidden = mode !== 'schedule';
  }

  function update() {
    const t = textarea.value;
    const chans = [...selected].map(channelById).filter(Boolean);
    counters.replaceChildren(...chans.map((c) => {
      const n = countFor(c.network, t);
      return h('span', { class: `counter ${n > c.limit ? 'over' : ''}` }, `${c.name}: ${n}/${c.limit}`);
    }), ...(!image.value && chans.some((c) => c.requiresImage) ? [h('span', { class: 'counter over' }, `${chans.filter((c) => c.requiresImage).map((c) => c.name).join(', ')} needs an image or video`)] : []));
    const url = image.value.trim();
    const video = isVideoUrl(url);
    const textOnly = url ? chans.filter((c) => !(video ? c.supportsVideo : c.supportsImage)) : [];
    if (textOnly.length) counters.append(h('span', { class: 'counter warn' }, `${textOnly.map((c) => c.name).join(', ')}: text only (no ${video ? 'video' : 'image'})`));
    clearBtn.hidden = !url;
    if (preview.dataset.src !== url) {
      preview.dataset.src = url;
      preview.replaceChildren(/^https?:\/\/.+/.test(url) ? (video ? h('video', { class: 'preview-img', src: url, controls: true, muted: true, preload: 'metadata' }) : h('img', { class: 'preview-img', src: url, alt: 'Image preview' })) : '');
    }
  }

  // AI helpers (only when the server has an API key).
  let aiBox = null;
  if (state.settings.ai_enabled) {
    const prompt = h('input', { type: 'text', id: 'ai-prompt', placeholder: 'e.g. Announce our spring sale: 20% off all plants this weekend' });
    const firstChannel = () => [...selected][0];
    aiBox = h('div', { class: 'ai-box' }, h('div', { class: 'row' },
      h('div', { style: { flex: '1', minWidth: '200px' } }, prompt),
      h('button', { class: 'btn small', onclick: (e) => guard(e.target, async () => {
        e.target.textContent = 'Writing…';
        try {
          const r = await api('/api/ai/draft', { method: 'POST', body: { prompt: prompt.value, channel_id: firstChannel() } });
          textarea.value = r.text;
          update();
        } finally { e.target.textContent = 'Draft with AI'; }
      }) }, 'Draft with AI'),
      h('button', { class: 'btn small', onclick: (e) => guard(e.target, async () => {
        e.target.textContent = 'Rewriting…';
        try {
          const r = await api('/api/ai/rewrite', { method: 'POST', body: { text: textarea.value, instruction: prompt.value || undefined, channel_id: firstChannel() } });
          textarea.value = r.text;
          update();
        } finally { e.target.textContent = 'Rewrite'; }
      }) }, 'Rewrite')),
      h('span', { class: 'help' }, 'Drafts fit the first selected channel. Rewrite uses the box as an instruction, e.g. "shorter and more playful".'));
  }

  drawChannels();
  drawModes();
  update();

  modal(editing ? 'Edit post' : 'New post', [
    h('div', { class: 'field' }, h('span', {}, 'Channels'), chanChips),
    aiBox,
    h('label', { class: 'field' }, 'Text', textarea, counters),
    h('div', { class: 'field' }, h('label', { for: 'compose-image' }, 'Image or video'),
      h('div', { class: 'media-row' }, image, uploadBtn, clearBtn, fileInput), progress,
      h('span', { class: 'help' }, 'JPEG, PNG, GIF, WebP, MP4 or MOV. Videos post to Facebook, Instagram (as Reels), Threads and Mastodon; images also to Bluesky. Instagram photos must be JPEG.'),
      preview),
    h('div', { class: 'field' }, h('span', {}, 'When'), seg, whenWrap),
  ], (close) => [
    h('button', { class: 'btn', onclick: close }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: (e) => guard(e.target, async () => {
      const body = { text: textarea.value, image_url: image.value.trim() || null };
      if (mode === 'schedule') {
        if (!when.value) throw new Error('Pick a date and time');
        body.scheduled_at = fromLocalInput(when.value);
      }
      if (mode !== 'keep') body.mode = mode;
      let result;
      if (editing) {
        result = mode === 'now'
          ? (await api(`/api/posts/${post.id}`, { method: 'PATCH', body: { ...body, mode: 'draft' } }), [await api(`/api/posts/${post.id}/publish`, { method: 'POST', body: {} })])
          : [await api(`/api/posts/${post.id}`, { method: 'PATCH', body })];
      } else {
        body.channel_ids = [...selected];
        if (!body.channel_ids.length) throw new Error('Pick at least one channel');
        result = await api('/api/posts', { method: 'POST', body });
        localStorage.setItem('lastChannels', JSON.stringify(body.channel_ids));
        if (ideaId) await api(`/api/ideas/${ideaId}`, { method: 'DELETE' }).catch(() => {});
      }
      close();
      const failed = result.filter((p) => p.status === 'failed' || (mode === 'now' && p.status !== 'published'));
      if (failed.length) toast(`Could not publish to ${failed.map((p) => p.channel_name).join(', ')}: ${failed[0].last_error}`, true);
      else if (mode === 'now') toast('Published');
      else if (mode === 'draft') toast('Draft saved');
      else toast(result.length === 1 ? `Scheduled for ${fmtFull(result[0].scheduled_at)}` : `Scheduled ${result.length} posts`);
      reload();
    }) }, editing ? 'Save' : 'Create'),
  ]);
}

boot().catch((err) => app.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'card' }, h('h1', {}, 'Dispatch is not reachable'), h('p', {}, err.message)))));
