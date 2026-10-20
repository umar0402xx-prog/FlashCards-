/* A Level Recall — spaced-repetition flashcards.
   Cards come from decks/*.json (edited by Claude in the GitHub repo) plus cards added on the device.
   Progress, settings and device-made cards live in this browser's localStorage. */
'use strict';

const APP_VERSION = '1.0.1';
const IV = [0, 1, 3, 7, 16, 35, 75, 150]; // days for each box; box 0 = learning (due again today)
const MAX_BOX = IV.length - 1;
const COLORS = ['yellow', 'green', 'pink', 'blue', 'orange', 'lavender'];

/* ---------------- storage ---------------- */
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem('recall.' + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try {
      localStorage.setItem('recall.' + key, JSON.stringify(value));
      return true;
    } catch (e) {
      toast('Couldn’t save on this device. Storage may be full or blocked.');
      return false;
    }
  }
};

/* ---------------- dates ---------------- */
const pad = n => String(n).padStart(2, '0');
const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => fmtDate(new Date());
function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return fmtDate(d); }
function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}
function ivLabel(days) {
  if (days <= 0) return 'today';
  if (days < 14) return days + 'd';
  if (days < 60) return Math.round(days / 7) + 'w';
  return Math.round(days / 30) + 'mo';
}
function relDay(s) {
  const n = daysBetween(todayStr(), s);
  if (n <= 0) return 'today';
  if (n === 1) return 'tomorrow';
  return `in ${n} days`;
}

/* ---------------- state ---------------- */
const S = {
  decks: [],
  repoCards: [],
  loaded: false,
  loadError: '',
  lastSync: store.get('lastSync', ''),
  myCards: store.get('myCards', []),
  myDecks: store.get('myDecks', []),
  progress: store.get('progress', {}),
  suspended: new Set(store.get('suspended', [])),
  settings: Object.assign({ newPerDay: 10, theme: 'system' }, store.get('settings', {})),
  daily: store.get('daily', { date: '', seen: {} }),
  log: store.get('log', {}),
  view: 'today',
  session: null,
  browse: { q: '', deck: 'all' },
  editing: null,
  addDeck: null,
  pendingConfirm: null,
  installEvent: null,
  waitingWorker: null,
  byId: new Map()
};

function saveProgress() { store.set('progress', S.progress); }
function saveSuspended() { store.set('suspended', [...S.suspended]); }
function saveSettings() { store.set('settings', S.settings); }
function saveMine() { store.set('myCards', S.myCards); store.set('myDecks', S.myDecks); }

function allDecks() {
  const ids = new Set(S.decks.map(d => d.id));
  return S.decks.concat(S.myDecks.filter(d => !ids.has(d.id)));
}
function deckById(id) { return allDecks().find(d => d.id === id); }
function allCards() {
  const repoIds = new Set(S.repoCards.map(c => c.id));
  return S.repoCards.concat(S.myCards.filter(c => !repoIds.has(c.id)));
}
function rebuildIndex() {
  S.byId = new Map(allCards().map(c => [c.id, c]));
}
function isMine(card) { return card && card.mine === true; }

// The new-cards-per-day limit applies to each deck separately.
function newSeenToday(deckId) {
  if (S.daily.date !== todayStr() || !S.daily.seen) return 0;
  return S.daily.seen[deckId] || 0;
}
function newRemaining(deckId) { return Math.max(0, S.settings.newPerDay - newSeenToday(deckId)); }

function cardState(card) {
  if (S.suspended.has(card.id)) return 'off';
  const p = S.progress[card.id];
  if (!p) return 'new';
  return p.due <= todayStr() ? 'due' : 'later';
}

function deckStats(deckId) {
  if (!deckId) {
    const ids = [...new Set(allCards().map(c => c.deck))];
    const sum = { total: 0, active: 0, due: 0, fresh: 0, newToday: 0, learned: 0 };
    for (const id of ids) {
      const s = deckStats(id);
      for (const k in sum) sum[k] += s[k];
    }
    return sum;
  }
  const cards = allCards().filter(c => c.deck === deckId);
  let due = 0, fresh = 0, learned = 0, active = 0;
  for (const c of cards) {
    const st = cardState(c);
    if (st === 'off') continue;
    active++;
    if (st === 'due') due++;
    if (st === 'new') fresh++;
    const p = S.progress[c.id];
    if (p && p.box >= 1) learned++;
  }
  return { total: cards.length, active, due, fresh, newToday: Math.min(fresh, newRemaining(deckId)), learned };
}

function streak() {
  let day = todayStr();
  if (!S.log[day]) day = addDays(day, -1);
  let n = 0;
  while (S.log[day]) { n++; day = addDays(day, -1); }
  return n;
}

/* ---------------- scheduling ---------------- */
function nextBox(p, rating) {
  const b = p ? p.box : -1; // -1 = brand new
  const learning = b <= 0;
  switch (rating) {
    case 'again': return 0;
    case 'hard': return learning ? 1 : b;
    case 'good': return Math.min(MAX_BOX, learning ? 2 : b + 1);
    case 'easy': return Math.min(MAX_BOX, learning ? 3 : b + 2);
  }
  return b;
}
function ratingLabel(cardId, rating) {
  if (rating === 'again') return 'soon';
  return ivLabel(IV[nextBox(S.progress[cardId], rating)]);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildQueue(deckId, mode) {
  const t = todayStr();
  const cards = allCards().filter(c => (!deckId || c.deck === deckId) && !S.suspended.has(c.id));
  if (mode === 'cram') return shuffle(cards.map(c => c.id));
  const due = cards.filter(c => S.progress[c.id] && S.progress[c.id].due <= t);
  const taken = {};
  const fresh = cards.filter(c => {
    if (S.progress[c.id]) return false;
    taken[c.deck] = (taken[c.deck] || 0) + 1;
    return taken[c.deck] <= newRemaining(c.deck);
  });
  return shuffle(due.map(c => c.id)).concat(fresh.map(c => c.id));
}

function startSession(deckId, mode) {
  const queue = buildQueue(deckId, mode);
  if (!queue.length) {
    toast(mode === 'cram' ? 'No cards in this deck yet.' : 'Nothing due. Try "Practise all".');
    return;
  }
  S.session = { deckId, mode, queue, total: queue.length, done: 0, again: 0, flipped: false, history: [] };
  closeSheet();
  S.view = 'study';
  render();
  window.scrollTo(0, 0);
}

function rate(rating) {
  const sess = S.session;
  if (!sess || !sess.queue.length) return;
  const id = sess.queue[0];
  const t = todayStr();
  const snapshot = {
    id,
    queue: sess.queue.slice(),
    done: sess.done,
    again: sess.again,
    progress: S.progress[id] ? Object.assign({}, S.progress[id]) : null,
    daily: JSON.parse(JSON.stringify(S.daily)),
    logToday: S.log[t] || 0
  };
  sess.history.push(snapshot);
  if (sess.history.length > 30) sess.history.shift();
  sess.queue.shift();

  if (sess.mode !== 'cram') {
    const p = S.progress[id];
    const box = nextBox(p, rating);
    S.progress[id] = {
      box,
      due: box === 0 ? t : addDays(t, IV[box]),
      reps: ((p && p.reps) || 0) + 1,
      lapses: ((p && p.lapses) || 0) + (rating === 'again' && p && p.box >= 1 ? 1 : 0),
      last: t
    };
    if (!p) {
      if (S.daily.date !== t || !S.daily.seen) S.daily = { date: t, seen: {} };
      const deck = (S.byId.get(id) || {}).deck || '';
      S.daily.seen[deck] = (S.daily.seen[deck] || 0) + 1;
      store.set('daily', S.daily);
    }
    saveProgress();
  }
  S.log[t] = (S.log[t] || 0) + 1;
  trimLog();
  store.set('log', S.log);

  if (rating === 'again') {
    sess.queue.splice(Math.min(3, sess.queue.length), 0, id);
    sess.again++;
  } else {
    sess.done++;
  }
  sess.flipped = false;
  render();
}

function undo() {
  const sess = S.session;
  if (!sess || !sess.history.length) return;
  const h = sess.history.pop();
  const t = todayStr();
  sess.queue = h.queue;
  sess.done = h.done;
  sess.again = h.again;
  if (sess.mode !== 'cram') {
    if (h.progress) S.progress[h.id] = h.progress; else delete S.progress[h.id];
    S.daily = h.daily;
    saveProgress();
    store.set('daily', S.daily);
  }
  if (h.logToday) S.log[t] = h.logToday; else delete S.log[t];
  store.set('log', S.log);
  sess.flipped = true;
  render();
}

function trimLog() {
  const keys = Object.keys(S.log).sort();
  while (keys.length > 400) delete S.log[keys.shift()];
}

/* ---------------- rich text ---------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function rich(text) {
  return esc(text)
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}
function renderMath(root) {
  if (typeof window.renderMathInElement !== 'function') return;
  root.querySelectorAll('.rich').forEach(el => {
    if (el.dataset.math === '1') return;
    try {
      window.renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false }
        ],
        throwOnError: false,
        strict: 'ignore'
      });
    } catch (e) { /* leave the raw text visible */ }
    el.dataset.math = '1';
  });
}

/* ---------------- loading decks ---------------- */
async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

async function loadDecks(manual) {
  try {
    const index = await fetchJSON('decks/index.json');
    const decks = Array.isArray(index.decks) ? index.decks : [];
    const files = await Promise.all(decks.map(d => fetchJSON('decks/' + d.file).catch(() => ({ cards: [] }))));
    const cards = [];
    decks.forEach((d, i) => {
      for (const c of (files[i].cards || [])) {
        if (c && c.id && c.front != null) cards.push({ id: String(c.id), deck: d.id, topic: c.topic || '', front: c.front, back: c.back || '' });
      }
    });
    S.decks = decks.map(d => ({ id: d.id, name: d.name || d.id, code: d.code || '', color: COLORS.includes(d.color) ? d.color : 'lavender' }));
    S.repoCards = cards;
    S.loadError = '';
    S.lastSync = new Date().toISOString();
    store.set('lastSync', S.lastSync);
    store.set('deckCache', { decks: S.decks, cards: S.repoCards });
    cleanUpMerged();
    if (manual) toast(`Up to date: ${cards.length} cards from Claude`);
  } catch (e) {
    const cached = store.get('deckCache', null);
    if (cached && Array.isArray(cached.cards)) {
      S.decks = cached.decks || [];
      S.repoCards = cached.cards;
      S.loadError = '';
      if (manual) toast('You’re offline. Showing your saved cards.');
    } else {
      S.loadError = 'Couldn’t load your decks. Check your internet connection, then tap Try again.';
    }
  }
  S.loaded = true;
  rebuildIndex();
  if (S.view !== 'study') render();
}

// Once Claude has copied a device-made card into the repo (same id), drop the device copy.
function cleanUpMerged() {
  const repoIds = new Set(S.repoCards.map(c => c.id));
  const before = S.myCards.length;
  S.myCards = S.myCards.filter(c => !repoIds.has(c.id));
  const repoDeckIds = new Set(S.decks.map(d => d.id));
  const decksBefore = S.myDecks.length;
  S.myDecks = S.myDecks.filter(d => !repoDeckIds.has(d.id));
  if (S.myCards.length !== before || S.myDecks.length !== decksBefore) saveMine();
}

/* ---------------- UI helpers ---------------- */
const $main = document.getElementById('main');
const $sheet = document.getElementById('sheet');
const $panel = document.getElementById('sheet-panel');
const $toast = document.getElementById('toast');
const $nav = document.getElementById('nav');
let toastTimer = 0;

function toast(msg) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.hidden = true; }, 2600);
}

function openSheet(html) {
  $panel.innerHTML = '<div class="grabber" aria-hidden="true"></div>' + html;
  $sheet.hidden = false;
  renderMath($panel);
  const first = $panel.querySelector('h2');
  if (first) { first.setAttribute('tabindex', '-1'); first.focus({ preventScroll: true }); }
}
function closeSheet() {
  $sheet.hidden = true;
  $panel.innerHTML = '';
  S.pendingConfirm = null;
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(label || 'Copied');
  } catch (e) {
    openSheet(`
      <h2 id="sheet-title">Copy this text</h2>
      <p class="muted small">Your phone blocked automatic copying. Select all the text below and copy it.</p>
      <textarea class="input copybox" id="copy-fallback" readonly>${esc(text)}</textarea>
      <button type="button" class="btn ghost" data-action="close-sheet">Done</button>`);
    const ta = document.getElementById('copy-fallback');
    if (ta) { ta.focus(); ta.select(); }
  }
}

function deckChip(deck) {
  if (!deck) return '';
  return `<span class="hl c-${esc(deck.color)}">${esc(deck.code || deck.name)}</span>`;
}

const ICON = {
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>'
};

/* ---------------- views ---------------- */
function render() {
  const v = S.view;
  $nav.hidden = v === 'study';
  for (const id of ['today', 'cards', 'add', 'settings']) {
    const b = document.getElementById('nav-' + id);
    if (b) { if (id === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
  }
  $main.classList.toggle('studying', v === 'study');
  if (v === 'study') $main.innerHTML = viewStudy();
  else if (v === 'cards') { $main.innerHTML = viewCards(); renderList(); }
  else if (v === 'add') { $main.innerHTML = viewAdd(); updatePreview(); }
  else if (v === 'settings') $main.innerHTML = viewSettings();
  else $main.innerHTML = viewToday();
  renderMath($main);
}

function updateBanner() {
  if (!S.waitingWorker) return '';
  return `<div class="notice"><span class="small"><b>A new version is ready.</b></span>
    <button type="button" class="btn sm" data-action="apply-update">Update</button></div>`;
}

function viewToday() {
  const now = new Date();
  const dateLabel = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const head = `
    <header class="top">
      <div class="wordmark">A Level <span>Recall</span></div>
      <div class="today-date">${esc(dateLabel)}</div>
    </header>`;
  if (!S.loaded) return head + `<p class="muted">Loading your cards…</p>`;
  if (S.loadError) {
    return head + `<div class="summary"><h2>No cards yet</h2><p class="muted">${esc(S.loadError)}</p>
      <button type="button" class="btn" data-action="retry">Try again</button></div>`;
  }
  const all = deckStats(null);
  const toDo = all.due + all.newToday;
  const reviewedToday = S.log[todayStr()] || 0;
  const st = streak();
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = addDays(todayStr(), -i);
    const n = S.log[d] || 0;
    const lvl = n === 0 ? '' : n < 10 ? 'l1' : n < 30 ? 'l2' : 'l3';
    days.push(`<span class="day ${lvl} ${i === 0 ? 'today' : ''}" title="${esc(d)}: ${n} reviews"></span>`);
  }
  const summary = `
    <section class="summary" aria-label="Today">
      <div>
        <div class="big">${toDo}</div>
        <p class="big-label">${toDo === 1 ? 'card' : 'cards'} to review today</p>
      </div>
      <div class="facts">
        <span><b>${all.due}</b> due</span>
        <span><b>${all.newToday}</b> new</span>
        <span><b>${reviewedToday}</b> reviewed today</span>
        <span><b>${st}</b>-day streak</span>
      </div>
      <div class="stack" style="gap:6px">
        <div class="days" aria-label="Reviews over the last 14 days">${days.join('')}</div>
        <div class="spread"><span class="eyebrow">14 days ago</span><span class="eyebrow">Today</span></div>
      </div>
      ${all.total === 0
        ? `<p class="muted">No cards yet. Add your first one, or ask Claude to make cards for a topic.</p>
           <button type="button" class="btn" data-action="go" data-view="add">Add your first card</button>`
        : toDo > 0
        ? `<button type="button" class="btn" data-action="study" data-mode="review">Start review</button>`
        : `<p class="muted">All done for today. Nice work.</p>
           <button type="button" class="btn ghost" data-action="study" data-mode="cram">Practise all cards anyway</button>`}
    </section>`;

  const decks = allDecks();
  const rows = decks.map(d => {
    const s = deckStats(d.id);
    const n = s.due + s.newToday;
    return `
      <button type="button" class="deck" data-action="deck" data-id="${esc(d.id)}">
        <div style="min-width:0">
          <div class="deck-name">${esc(d.name)} ${d.code ? deckChip(d) : ''}</div>
          <div class="deck-sub">${s.total} cards · ${s.learned} learned</div>
        </div>
        <div class="deck-due"><div class="n ${n ? '' : 'zero'}">${n}</div><div class="l">TO DO</div></div>
      </button>`;
  }).join('');
  return head + updateBanner() + summary + `
    <section class="stack">
      <div class="spread"><h2>Decks</h2><span class="eyebrow">Cambridge A Level</span></div>
      <div class="decks">${rows || '<p class="muted" style="padding:16px 0">No decks yet.</p>'}</div>
    </section>`;
}

function openDeckSheet(deckId) {
  const d = deckById(deckId);
  if (!d) return;
  const s = deckStats(deckId);
  const toDo = s.due + s.newToday;
  openSheet(`
    <div class="spread"><h2 id="sheet-title">${esc(d.name)}</h2>${deckChip(d)}</div>
    <div class="stats">
      <div class="stat"><div class="n">${s.due}</div><div class="l">due</div></div>
      <div class="stat"><div class="n">${s.newToday}</div><div class="l">new today</div></div>
      <div class="stat"><div class="n">${s.learned}</div><div class="l">learned</div></div>
      <div class="stat"><div class="n">${s.total}</div><div class="l">total</div></div>
    </div>
    <button type="button" class="btn" data-action="study" data-mode="review" data-deck="${esc(d.id)}" ${toDo ? '' : 'disabled'}>
      ${toDo ? `Review ${toDo} ${toDo === 1 ? 'card' : 'cards'}` : 'Nothing due today'}</button>
    <button type="button" class="btn ghost" data-action="study" data-mode="cram" data-deck="${esc(d.id)}" ${s.active ? '' : 'disabled'}>Practise all cards</button>
    <p class="muted small">Practise mode shuffles every card in the deck and doesn't change your review schedule.</p>
    <button type="button" class="link" data-action="browse-deck" data-id="${esc(d.id)}">Browse these cards</button>`);
}

function viewStudy() {
  const sess = S.session;
  if (!sess) { S.view = 'today'; return viewToday(); }
  const deck = sess.deckId ? deckById(sess.deckId) : null;
  const title = deck ? deck.name : 'All decks';
  const pct = sess.total ? Math.round((sess.done / sess.total) * 100) : 100;
  const top = `
    <div class="study-top">
      <button type="button" class="icon-btn" data-action="end-study" aria-label="Stop studying">${ICON.close}</button>
      <div class="study-title">
        <div class="eyebrow">${sess.mode === 'cram' ? 'Practise' : 'Review'}</div>
        <h2>${esc(title)}</h2>
      </div>
      <span class="count">${sess.done} / ${sess.total}</span>
    </div>
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${sess.total}" aria-valuenow="${sess.done}"><i style="width:${pct}%"></i></div>`;

  if (!sess.queue.length) {
    const s = deckStats(sess.deckId);
    const tomorrow = allCards().filter(c => (!sess.deckId || c.deck === sess.deckId) && !S.suspended.has(c.id) && S.progress[c.id] && S.progress[c.id].due === addDays(todayStr(), 1)).length;
    return top + `
      <section class="summary done">
        <span class="eyebrow">Session complete</span>
        <div class="big">${sess.total}</div>
        <p class="big-label">${sess.total === 1 ? 'card' : 'cards'} done${sess.again ? `, with ${sess.again} ${sess.again === 1 ? 'retry' : 'retries'}` : ''}.</p>
        ${sess.mode === 'cram' ? '' : `<p class="muted">${tomorrow} ${tomorrow === 1 ? 'card comes' : 'cards come'} back tomorrow. ${s.fresh - s.newToday > 0 ? 'More new cards unlock tomorrow.' : ''}</p>`}
        <button type="button" class="btn" data-action="end-study">Back to Today</button>
        ${sess.history.length ? `<button type="button" class="link" data-action="undo">Undo last answer</button>` : ''}
      </section>`;
  }

  const card = S.byId.get(sess.queue[0]);
  if (!card) { sess.queue.shift(); return viewStudy(); }
  const cd = deckById(card.deck);
  const p = S.progress[card.id];
  const isNew = !p;
  const front = `
    <article class="index-card" data-action="flip" aria-label="Flashcard. Tap to show the answer.">
      <div class="card-head">${deckChip(cd)}<span class="card-topic">${esc(card.topic || (cd ? cd.name : ''))}</span>
        ${isNew && sess.mode !== 'cram' ? '<span class="pill new" style="margin-left:auto">NEW</span>' : ''}</div>
      <div class="card-rule" aria-hidden="true"></div>
      <div class="front rich">${rich(card.front)}</div>
      ${sess.flipped
        ? `<div class="answer rich">${rich(card.back)}</div>`
        : `<div class="tap-hint">Tap the card to show the answer</div>`}
    </article>`;

  let controls;
  if (!sess.flipped) {
    controls = `<button type="button" class="btn" data-action="flip">Show answer</button>`;
  } else if (sess.mode === 'cram') {
    controls = `<div class="rate two">
      <button type="button" class="again" data-action="rate" data-r="again"><b>Again</b><small>see it soon</small></button>
      <button type="button" class="good" data-action="rate" data-r="good"><b>Got it</b><small>next card</small></button>
    </div>`;
  } else {
    const r = k => `<button type="button" class="${k}" data-action="rate" data-r="${k}"><b>${k[0].toUpperCase() + k.slice(1)}</b><small>${ratingLabel(card.id, k)}</small></button>`;
    controls = `<div class="rate">${r('again')}${r('hard')}${r('good')}${r('easy')}</div>`;
  }
  const under = `<div class="under">
    ${sess.history.length ? `<button type="button" class="link" data-action="undo">Undo</button>` : '<span></span>'}
    <span class="eyebrow">${sess.queue.length} left</span></div>`;
  return top + front + controls + under;
}

/* ----- Cards (browse) ----- */
function viewCards() {
  const decks = allDecks();
  const chip = (id, label, color) => `<button type="button" class="chip" data-action="filter" data-id="${esc(id)}" aria-pressed="${S.browse.deck === id}">${color ? `<span class="dot c-${esc(color)}"></span>` : ''}${esc(label)}</button>`;
  return `
    <header class="spread"><h1>Cards</h1><button type="button" class="btn sm" data-action="go" data-view="add">Add card</button></header>
    <input class="search" id="q" type="search" placeholder="Search cards" value="${esc(S.browse.q)}" autocomplete="off" aria-label="Search cards">
    <div class="chips" role="group" aria-label="Filter by deck">
      ${chip('all', 'All')}
      ${decks.map(d => chip(d.id, d.name, d.color)).join('')}
      ${chip('mine', 'Made on phone')}
      ${chip('off', 'Suspended')}
    </div>
    <p class="muted small" id="list-count"></p>
    <div class="list" id="list"></div>`;
}

function filteredCards() {
  const q = S.browse.q.trim().toLowerCase();
  const f = S.browse.deck;
  return allCards().filter(c => {
    if (f === 'mine' && !isMine(c)) return false;
    if (f === 'off' && !S.suspended.has(c.id)) return false;
    if (f !== 'all' && f !== 'mine' && f !== 'off' && c.deck !== f) return false;
    if (!q) return true;
    return (c.front + ' ' + c.back + ' ' + (c.topic || '')).toLowerCase().includes(q);
  });
}

function statusPill(card) {
  const st = cardState(card);
  if (st === 'off') return '<span class="pill off">Suspended</span>';
  if (st === 'new') return '<span class="pill new">New</span>';
  if (st === 'due') return '<span class="pill due">Due</span>';
  return `<span class="pill">${esc(relDay(S.progress[card.id].due))}</span>`;
}

function renderList() {
  const list = document.getElementById('list');
  const count = document.getElementById('list-count');
  if (!list) return;
  if (!S.loaded) { list.innerHTML = '<p class="muted" style="padding:16px 0">Loading…</p>'; return; }
  const cards = filteredCards();
  count.textContent = `${cards.length} ${cards.length === 1 ? 'card' : 'cards'}`;
  if (!cards.length) {
    list.innerHTML = `<p class="muted" style="padding:16px 0">${S.browse.q ? 'No cards match your search.' : 'No cards here yet.'}</p>`;
    return;
  }
  list.innerHTML = cards.slice(0, 300).map(c => {
    const d = deckById(c.deck);
    return `<button type="button" class="item" data-action="card" data-id="${esc(c.id)}">
      <div class="item-meta">${d ? `<span class="dot c-${esc(d.color)}"></span>` : ''}<span class="t">${esc(c.topic || (d ? d.name : ''))}</span>
        ${isMine(c) ? '<span class="pill mine">Mine</span>' : ''}${statusPill(c)}</div>
      <div class="rich">${rich(c.front)}</div>
    </button>`;
  }).join('') + (cards.length > 300 ? '<p class="muted small" style="padding:12px 0">Showing the first 300. Search to narrow it down.</p>' : '');
  renderMath(list);
}

function openCardSheet(id) {
  const c = S.byId.get(id);
  if (!c) return;
  const d = deckById(c.deck);
  const p = S.progress[c.id];
  const off = S.suspended.has(c.id);
  let status = 'New, not studied yet';
  if (off) status = 'Suspended';
  else if (p) status = p.due <= todayStr() ? 'Due today' : `Next review ${relDay(p.due)} (${p.due})`;
  const confirming = S.pendingConfirm === 'delete:' + c.id;
  const confirmingReset = S.pendingConfirm === 'reset:' + c.id;
  openSheet(`
    <div class="spread"><h2 id="sheet-title">${esc(c.topic || (d ? d.name : 'Card'))}</h2>${deckChip(d)}</div>
    <article class="index-card static">
      <div class="front rich">${rich(c.front)}</div>
      <div class="answer rich">${rich(c.back)}</div>
    </article>
    <dl class="kv">
      <dt>Status</dt><dd>${esc(status)}</dd>
      ${p ? `<dt>Reviews</dt><dd>${p.reps || 0} total, forgot ${p.lapses || 0} ${p.lapses === 1 ? 'time' : 'times'}</dd>` : ''}
      <dt>Made by</dt><dd>${isMine(c) ? 'You, on this phone' : 'Claude'}</dd>
      <dt>Card ID</dt><dd class="mono small">${esc(c.id)}</dd>
    </dl>
    <div class="btn-row">
      <button type="button" class="btn ghost" data-action="toggle-suspend" data-id="${esc(c.id)}">${off ? 'Unsuspend' : 'Suspend'}</button>
      ${p ? `<button type="button" class="btn ghost" data-action="reset" data-id="${esc(c.id)}">${confirmingReset ? 'Tap again to reset' : 'Reset progress'}</button>` : `<span></span>`}
    </div>
    ${isMine(c) ? `<div class="btn-row">
      <button type="button" class="btn quiet" data-action="edit" data-id="${esc(c.id)}">Edit</button>
      <button type="button" class="btn danger" data-action="delete" data-id="${esc(c.id)}">${confirming ? 'Tap again to delete' : 'Delete'}</button>
    </div>` : `<p class="muted small">Want this card changed? Tell Claude the card ID and what to fix.</p>`}
    <button type="button" class="btn ghost" data-action="close-sheet">Close</button>`);
}

/* ----- Add / edit ----- */
function viewAdd() {
  const editing = S.editing ? S.byId.get(S.editing) : null;
  const decks = allDecks();
  const deckSel = editing ? editing.deck : (S.addDeck || (decks[0] && decks[0].id) || '__new');
  const topics = [...new Set(allCards().filter(c => c.deck === deckSel && c.topic).map(c => c.topic))].sort();
  return `
    <header class="spread"><h1>${editing ? 'Edit card' : 'Add a card'}</h1>
      ${editing ? `<button type="button" class="btn sm ghost" data-action="cancel-edit">Cancel</button>` : ''}</header>
    <form id="card-form" class="stack" style="gap:16px" novalidate>
      <div class="field">
        <label for="f-deck">Deck</label>
        <select class="input" id="f-deck">
          ${decks.map(d => `<option value="${esc(d.id)}" ${d.id === deckSel ? 'selected' : ''}>${esc(d.name)}${d.code ? ' (' + esc(d.code) + ')' : ''}</option>`).join('')}
          <option value="__new" ${deckSel === '__new' ? 'selected' : ''}>New deck…</option>
        </select>
      </div>
      <div class="field" id="newdeck-field" ${deckSel === '__new' ? '' : 'hidden'}>
        <label for="f-newdeck">New deck name</label>
        <input class="input" id="f-newdeck" type="text" placeholder="e.g. Maths 9709" autocomplete="off">
      </div>
      <div class="field">
        <label for="f-topic">Topic <span class="muted small">(optional)</span></label>
        <input class="input" id="f-topic" type="text" list="topic-list" value="${esc(editing ? editing.topic : '')}" placeholder="e.g. Kinematics" autocomplete="off">
        <datalist id="topic-list">${topics.map(t => `<option value="${esc(t)}"></option>`).join('')}</datalist>
      </div>
      <div class="field">
        <label for="f-front">Question (front)</label>
        <textarea class="input" id="f-front" placeholder="e.g. Define the newton.">${esc(editing ? editing.front : '')}</textarea>
      </div>
      <div class="field">
        <label for="f-back">Answer (back)</label>
        <textarea class="input" id="f-back" placeholder="e.g. The force that gives a mass of **1 kg** an acceleration of **1 m s$^{-2}$**.">${esc(editing ? editing.back : '')}</textarea>
      </div>
      <div class="preview">
        <span class="eyebrow">Preview</span>
        <article class="index-card static" id="preview"></article>
      </div>
      <button type="submit" class="btn">${editing ? 'Save changes' : 'Save card'}</button>
    </form>
    <details class="tips">
      <summary>How to write maths, chemistry and key words</summary>
      <div class="tips-body">
        <div class="tip-row"><code>**key word**</code><span class="rich">${rich('**key word**')}</span></div>
        <div class="tip-row"><code>$v^2 = u^2 + 2as$</code><span class="rich">${rich('$v^2 = u^2 + 2as$')}</span></div>
        <div class="tip-row"><code>$\\dfrac{W}{t}$</code><span class="rich">${rich('$\\dfrac{W}{t}$')}</span></div>
        <div class="tip-row"><code>$\\text{m s}^{-1}$</code><span class="rich">${rich('$\\text{m s}^{-1}$')}</span></div>
        <div class="tip-row"><code>$\\ce{H2SO4}$</code><span class="rich">${rich('$\\ce{H2SO4}$')}</span></div>
        <div class="tip-row"><code>$\\ce{N2 + 3H2 &lt;=&gt; 2NH3}$</code><span class="rich">${rich('$\\ce{N2 + 3H2 <=> 2NH3}$')}</span></div>
        <p class="muted small">Put maths between <code>$ $</code>. Use <code>$$ $$</code> to give an equation its own line. Or just ask Claude to make the cards for you.</p>
      </div>
    </details>`;
}

let previewTimer = 0;
function updatePreview() {
  const box = document.getElementById('preview');
  if (!box) return;
  const front = (document.getElementById('f-front') || {}).value || '';
  const back = (document.getElementById('f-back') || {}).value || '';
  const topic = (document.getElementById('f-topic') || {}).value || '';
  box.innerHTML = `
    <div class="card-head"><span class="card-topic">${esc(topic || 'Topic')}</span></div>
    <div class="card-rule" aria-hidden="true"></div>
    <div class="front rich">${front.trim() ? rich(front) : '<span class="muted">Your question appears here.</span>'}</div>
    <div class="answer rich">${back.trim() ? rich(back) : '<span class="muted">Your answer appears here.</span>'}</div>`;
  renderMath(box);
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'deck';
}

function saveCardForm() {
  const deckVal = document.getElementById('f-deck').value;
  const front = document.getElementById('f-front').value.trim();
  const back = document.getElementById('f-back').value.trim();
  const topic = document.getElementById('f-topic').value.trim();
  if (!front || !back) { toast('Add both a question and an answer.'); return; }
  let deckId = deckVal;
  if (deckVal === '__new') {
    const name = document.getElementById('f-newdeck').value.trim();
    if (!name) { toast('Give your new deck a name.'); return; }
    let id = 'my-' + slug(name);
    const existing = allDecks().find(d => d.id === id || d.name.toLowerCase() === name.toLowerCase());
    if (existing) id = existing.id;
    else {
      const used = new Set(allDecks().map(d => d.color));
      const color = COLORS.find(c => !used.has(c)) || COLORS[allDecks().length % COLORS.length];
      S.myDecks.push({ id, name, code: '', color });
    }
    deckId = id;
  }
  if (S.editing) {
    const c = S.myCards.find(x => x.id === S.editing);
    if (c) Object.assign(c, { deck: deckId, topic, front, back, updated: todayStr() });
    saveMine();
    rebuildIndex();
    S.editing = null;
    S.view = 'cards';
    toast('Changes saved');
    render();
    return;
  }
  const id = 'my-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  S.myCards.push({ id, deck: deckId, topic, front, back, mine: true, created: todayStr() });
  saveMine();
  rebuildIndex();
  S.addDeck = deckId;
  toast('Card saved');
  render();
  const f = document.getElementById('f-front');
  if (f) f.focus();
}

/* ----- Settings ----- */
function viewSettings() {
  const theme = S.settings.theme;
  const seg = (v, label) => `<button type="button" data-action="theme" data-v="${v}" aria-pressed="${theme === v}">${label}</button>`;
  const synced = S.lastSync ? new Date(S.lastSync).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never';
  const mineCount = S.myCards.length;
  const backupConfirm = S.pendingConfirm === 'restore';
  return `
    <header><h1>Settings</h1></header>
    ${updateBanner()}
    <section class="section" style="border-top:0;padding-top:0">
      <div class="spread">
        <div><h3>New cards per day</h3><p class="muted small">For each deck.</p></div>
        <div class="stepper">
          <button type="button" data-action="newper" data-d="-5" aria-label="Fewer new cards">−</button>
          <output id="newper-out">${S.settings.newPerDay}</output>
          <button type="button" data-action="newper" data-d="5" aria-label="More new cards">+</button>
        </div>
      </div>
    </section>
    <section class="section">
      <h3>Theme</h3>
      <div class="seg" role="group" aria-label="Theme">${seg('system', 'Auto')}${seg('light', 'Light')}${seg('dark', 'Dark')}</div>
    </section>
    <section class="section">
      <h3>Cards from Claude</h3>
      <p class="muted small">Last checked: ${esc(synced)}. New cards appear automatically when you're online.</p>
      <button type="button" class="btn ghost" data-action="sync">Check for new cards</button>
    </section>
    <section class="section">
      <h3>Cards you made on this phone</h3>
      <p class="muted small">You have <b>${mineCount}</b> ${mineCount === 1 ? 'card' : 'cards'} that only live on this phone. Copy them, paste them into a chat with Claude, and ask Claude to add them to your app so they're saved properly.</p>
      <button type="button" class="btn ghost" data-action="export-mine" ${mineCount ? '' : 'disabled'}>Copy my cards for Claude</button>
    </section>
    <section class="section">
      <h3>Back up your progress</h3>
      <p class="muted small">Your review history is saved on this phone only. Copy a backup now and then and keep it somewhere safe, like a note or a chat with Claude.</p>
      <button type="button" class="btn ghost" data-action="backup">Copy backup</button>
      <div class="field">
        <label for="restore-text">Restore from a backup</label>
        <textarea class="input" id="restore-text" placeholder="Paste a backup here"></textarea>
      </div>
      <button type="button" class="btn ${backupConfirm ? 'danger' : 'quiet'}" data-action="restore">${backupConfirm ? 'Tap again to replace your current progress' : 'Restore backup'}</button>
    </section>
    <section class="section">
      <h3>Install on your phone</h3>
      ${S.installEvent
        ? `<button type="button" class="btn" data-action="install">Install app</button>`
        : `<p class="muted small">In Chrome or Samsung Internet, open the browser menu and tap <b>Add to Home screen</b> or <b>Install app</b>. It then opens like a normal app and works offline.</p>`}
    </section>
    <p class="eyebrow">A Level Recall v${APP_VERSION}</p>`;
}

function exportMine() {
  const payload = {
    app: 'A Level Recall',
    type: 'my-cards',
    exported: todayStr(),
    decks: S.myDecks,
    cards: S.myCards.map(c => ({ id: c.id, deck: c.deck, topic: c.topic, front: c.front, back: c.back }))
  };
  copyText('Please add these cards to my A Level Recall app:\n\n' + JSON.stringify(payload, null, 2), 'Copied. Paste it into a chat with Claude.');
}

function backup() {
  const payload = {
    app: 'A Level Recall',
    type: 'backup',
    version: 1,
    exported: new Date().toISOString(),
    data: {
      progress: S.progress,
      suspended: [...S.suspended],
      myCards: S.myCards,
      myDecks: S.myDecks,
      settings: S.settings,
      log: S.log,
      daily: S.daily
    }
  };
  copyText(JSON.stringify(payload), 'Backup copied');
}

function restore() {
  const ta = document.getElementById('restore-text');
  const raw = ta ? ta.value.trim() : '';
  if (!raw) { toast('Paste a backup into the box first.'); return; }
  let data;
  try {
    const start = raw.indexOf('{');
    const parsed = JSON.parse(raw.slice(start));
    if (parsed.type !== 'backup' || !parsed.data) throw new Error('not a backup');
    data = parsed.data;
  } catch (e) {
    toast('That isn’t a valid backup. Copy the whole backup text and try again.');
    return;
  }
  if (S.pendingConfirm !== 'restore') {
    S.pendingConfirm = 'restore';
    const keep = ta.value;
    render();
    const t2 = document.getElementById('restore-text');
    if (t2) t2.value = keep;
    return;
  }
  S.pendingConfirm = null;
  S.progress = data.progress || {};
  S.suspended = new Set(data.suspended || []);
  S.myCards = data.myCards || [];
  S.myDecks = data.myDecks || [];
  S.settings = Object.assign({ newPerDay: 10, theme: 'system' }, data.settings || {});
  S.log = data.log || {};
  S.daily = data.daily || { date: '', seen: {} };
  saveProgress(); saveSuspended(); saveMine(); saveSettings();
  store.set('log', S.log); store.set('daily', S.daily);
  cleanUpMerged();
  rebuildIndex();
  applyTheme();
  toast('Progress restored');
  render();
}

function applyTheme() {
  const t = S.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
}

/* ---------------- events ---------------- */
const actions = {
  go(el) {
    S.view = el.dataset.view;
    if (S.view !== 'add') S.editing = null;
    S.pendingConfirm = null;
    closeSheet();
    render();
    window.scrollTo(0, 0);
  },
  retry() { S.loaded = false; render(); loadDecks(true); },
  study(el) { startSession(el.dataset.deck || null, el.dataset.mode); },
  deck(el) { openDeckSheet(el.dataset.id); },
  'browse-deck'(el) { S.browse.deck = el.dataset.id; S.browse.q = ''; S.view = 'cards'; closeSheet(); render(); },
  'close-sheet'() { closeSheet(); },
  flip() {
    if (!S.session || S.session.flipped) return;
    S.session.flipped = true;
    render();
  },
  rate(el) { rate(el.dataset.r); },
  undo() { undo(); },
  'end-study'() { S.session = null; S.view = 'today'; render(); window.scrollTo(0, 0); },
  filter(el) { S.browse.deck = el.dataset.id; document.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.id === S.browse.deck))); renderList(); },
  card(el) { S.pendingConfirm = null; openCardSheet(el.dataset.id); },
  'toggle-suspend'(el) {
    const id = el.dataset.id;
    if (S.suspended.has(id)) S.suspended.delete(id); else S.suspended.add(id);
    saveSuspended();
    openCardSheet(id);
    renderList();
  },
  reset(el) {
    const id = el.dataset.id;
    if (S.pendingConfirm !== 'reset:' + id) { S.pendingConfirm = 'reset:' + id; openCardSheet(id); return; }
    S.pendingConfirm = null;
    delete S.progress[id];
    saveProgress();
    toast('Progress reset. It’s a new card again.');
    openCardSheet(id);
    renderList();
  },
  edit(el) { S.editing = el.dataset.id; S.view = 'add'; closeSheet(); render(); window.scrollTo(0, 0); },
  'cancel-edit'() { S.editing = null; S.view = 'cards'; render(); },
  delete(el) {
    const id = el.dataset.id;
    if (S.pendingConfirm !== 'delete:' + id) { S.pendingConfirm = 'delete:' + id; openCardSheet(id); return; }
    S.myCards = S.myCards.filter(c => c.id !== id);
    delete S.progress[id];
    S.suspended.delete(id);
    saveMine(); saveProgress(); saveSuspended();
    rebuildIndex();
    closeSheet();
    toast('Card deleted');
    renderList();
  },
  newper(el) {
    const v = Math.max(0, Math.min(200, S.settings.newPerDay + Number(el.dataset.d)));
    S.settings.newPerDay = v;
    saveSettings();
    const out = document.getElementById('newper-out');
    if (out) out.textContent = v;
  },
  theme(el) {
    S.settings.theme = el.dataset.v;
    saveSettings();
    applyTheme();
    document.querySelectorAll('[data-action="theme"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === S.settings.theme)));
  },
  async sync() {
    toast('Checking…');
    try { const reg = await navigator.serviceWorker?.getRegistration(); reg && reg.update(); } catch (e) { /* ignore */ }
    await loadDecks(true);
  },
  'export-mine'() { exportMine(); },
  backup() { backup(); },
  restore() { restore(); },
  async install() {
    const ev = S.installEvent;
    if (!ev) return;
    ev.prompt();
    try { await ev.userChoice; } catch (e) { /* ignore */ }
    S.installEvent = null;
    render();
  },
  'apply-update'() {
    if (S.waitingWorker) S.waitingWorker.postMessage('skip-waiting');
  }
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  // let people select text on a flipped card without triggering anything
  if (el.dataset.action === 'flip' && S.session && S.session.flipped) return;
  e.preventDefault();
  fn(el, e);
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'q') {
    S.browse.q = t.value;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderList, 150);
  } else if (t.id === 'f-front' || t.id === 'f-back' || t.id === 'f-topic') {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 200);
  }
});

document.addEventListener('change', e => {
  if (e.target.id === 'f-deck') {
    const v = e.target.value;
    const nf = document.getElementById('newdeck-field');
    if (nf) nf.hidden = v !== '__new';
    if (v !== '__new') {
      S.addDeck = v;
      const list = document.getElementById('topic-list');
      if (list) {
        const topics = [...new Set(allCards().filter(c => c.deck === v && c.topic).map(c => c.topic))].sort();
        list.innerHTML = topics.map(t => `<option value="${esc(t)}"></option>`).join('');
      }
    }
  }
});

document.addEventListener('submit', e => {
  if (e.target.id === 'card-form') { e.preventDefault(); saveCardForm(); }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$sheet.hidden) { closeSheet(); return; }
  if (S.view !== 'study' || !S.session || !S.session.queue.length) return;
  if (e.target.closest('input, textarea, select')) return;
  if (!S.session.flipped && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); actions.flip(); return; }
  if (S.session.flipped) {
    const map = S.session.mode === 'cram' ? { '1': 'again', '2': 'good' } : { '1': 'again', '2': 'hard', '3': 'good', '4': 'easy' };
    if (map[e.key]) { e.preventDefault(); rate(map[e.key]); }
  }
  if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); }
});

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  S.installEvent = e;
  if (S.view === 'settings') render();
});

/* ---------------- service worker (offline + updates) ---------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      const watch = w => {
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            S.waitingWorker = w;
            if (S.view !== 'study') render();
          }
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) { S.waitingWorker = reg.waiting; if (S.view !== 'study') render(); }
      reg.addEventListener('updatefound', () => watch(reg.installing));
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded || !S.waitingWorker) return;
        reloaded = true;
        location.reload();
      });
    } catch (e) { /* offline support unavailable; the app still works online */ }
  });
}

/* ---------------- start ---------------- */
applyTheme();
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* ignore */ }
// show cached decks instantly, then refresh from the network
(function boot() {
  const cached = store.get('deckCache', null);
  if (cached && Array.isArray(cached.cards)) {
    S.decks = cached.decks || [];
    S.repoCards = cached.cards;
    S.loaded = true;
    rebuildIndex();
  }
  render();
  loadDecks(false);
})();
window.addEventListener('load', () => renderMath(document));
