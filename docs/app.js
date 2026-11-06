// 일정 & 할일 — 휴대폰 앱(PWA)
// 데이터는 Google 캘린더(일정)와 Google Tasks "내 할 일"(할 일)에 직접 읽고 쓴다. PC 프로그램과 같은 데이터를 공유.
import { CLIENT_ID as DEFAULT_CLIENT_ID, VERSION } from './config.js';
import * as D from './lib/dates.js';
import { solarToLunar, lunarToSolar, LUNAR_MAX_YEAR } from './lib/lunar.js';
import { getHolidays } from './lib/holidays.js';
import { parseQuickAdd } from './lib/recur.js';
import { solarPayload, lunarTargets, lunarPayload, fromGoogle, timeRange, composeDescription } from './lib/gsync.js';

/* ───────────── 공통 ───────────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const h = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const store = {
  get(k, d = null) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* 무시 */
    }
  },
};
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.tm);
  toast.tm = setTimeout(() => t.classList.remove('show'), 2800);
}

const SCOPES = 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/tasks';
const CAL = 'https://www.googleapis.com/calendar/v3';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
const TASK_LIST = '@default';
const PUSH_LIST_TITLE = '일정&할일 알림 연결 (지우지 마세요)';
const LUNAR_YEARS = 10;

const S = {
  tab: location.hash === '#todo' ? 'todo' : 'cal',
  cursor: D.today(),
  sel: D.today(),
  calendars: store.get('st.calendars', []),
  events: [],
  range: null,
  tasks: store.get('st.tasks', []),
  todoFilter: 'all',
  showDone: false,
  loading: false,
  hist: store.get('st.hist', {}),
};

/* ───────────── 로그인 (Google Identity Services) ───────────── */
const clientId = () => store.get('st.clientId') || DEFAULT_CLIENT_ID;
let token = store.get('st.token');
const tokenOk = () => token && token.exp > Date.now() + 60000;
let tokenClient = null;
let pendingAuth = null;

function gisReady() {
  return new Promise((resolve) => {
    const tick = () => (window.google?.accounts?.oauth2 ? resolve() : setTimeout(tick, 100));
    tick();
  });
}

async function signIn(prompt = '') {
  await gisReady();
  if (!tokenClient) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: SCOPES,
      callback: (r) => {
        const p = pendingAuth;
        pendingAuth = null;
        if (r.error) return p?.reject(new Error(r.error_description || r.error));
        if (!google.accounts.oauth2.hasGrantedAllScopes(r, ...SCOPES.split(' '))) {
          return p?.reject(new Error('캘린더와 할 일 권한을 모두 허용해야 합니다.'));
        }
        token = { v: r.access_token, exp: Date.now() + (r.expires_in - 30) * 1000 };
        store.set('st.token', token);
        p?.resolve();
      },
      error_callback: (e) => {
        const p = pendingAuth;
        pendingAuth = null;
        p?.reject(new Error(e?.type === 'popup_closed' ? '로그인 창이 닫혔습니다.' : e?.message || '로그인에 실패했습니다.'));
      },
    });
  }
  return new Promise((resolve, reject) => {
    pendingAuth = { resolve, reject };
    tokenClient.requestAccessToken({ prompt, hint: store.get('st.email') || undefined });
  });
}

function signOut() {
  if (token?.v && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token.v, () => {});
  token = null;
  store.set('st.token', null);
  showGate();
}

async function api(base, path, { method = 'GET', body } = {}) {
  if (!tokenOk()) {
    showGate('expired');
    throw Object.assign(new Error('로그인이 필요합니다.'), { code: 'auth' });
  }
  const r = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token.v}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) {
    token = null;
    store.set('st.token', null);
    showGate('expired');
    throw Object.assign(new Error('로그인이 만료되었습니다.'), { code: 'auth' });
  }
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if ((r.status === 404 || r.status === 410) && method === 'DELETE') return null;
    throw Object.assign(new Error(j.error?.message || `오류 (${r.status})`), { status: r.status });
  }
  return j;
}
const cal = (p, o) => api(CAL, p, o);
const tasks = (p, o) => api(TASKS, p, o);

/* 시작 화면: 처음 로그인 / 로그인 만료 */
function showGate(reason) {
  const g = $('#gate');
  g.hidden = false;
  const needId = !clientId();
  g.innerHTML = `
    <img src="icons/icon-192.png" alt="">
    <h1>일정 &amp; 할일</h1>
    ${
      needId
        ? `<p>Google 로그인에 사용할 <b>웹 클라이언트 ID</b>를 입력하세요.</p>
           <input class="inp" id="gCid" placeholder="xxxx.apps.googleusercontent.com" autocomplete="off">
           <button type="button" class="btn primary" id="gSaveId">저장</button>`
        : `<p>${reason === 'expired' ? '보안을 위해 한 시간마다 Google 확인이 필요합니다.<br>아래 버튼을 눌러 계속하세요.' : 'PC 프로그램과 같은 Google 계정으로 로그인하세요.<br>일정은 구글 캘린더, 할 일은 Google Tasks에 저장됩니다.'}</p>
           <button type="button" class="btn primary" id="gLogin">Google 계정으로 ${reason === 'expired' ? '계속' : '시작'}</button>
           <span class="note" id="gMsg"></span>`
    }`;
  $('#gSaveId', g)?.addEventListener('click', () => {
    const v = $('#gCid', g).value.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(v)) return toast('클라이언트 ID 형식이 아닙니다.');
    store.set('st.clientId', v);
    tokenClient = null;
    showGate();
  });
  $('#gLogin', g)?.addEventListener('click', async () => {
    const msg = $('#gMsg', g);
    msg.textContent = '';
    try {
      await signIn(store.get('st.signedOnce') ? '' : 'consent');
      store.set('st.signedOnce', true);
      g.hidden = true;
      await afterLogin();
    } catch (e) {
      msg.textContent = e.message;
      msg.classList.add('warn');
    }
  });
}

async function afterLogin() {
  try {
    const me = await cal('/calendars/primary');
    store.set('st.email', me.id);
  } catch {
    /* 무시 */
  }
  await refreshAll();
}

/* ───────────── 데이터 불러오기 ───────────── */
function monthRange() {
  const { y, m } = D.parts(S.cursor);
  const first = D.make(y, m, 1);
  const start = D.startOfWeek(first);
  const weeks = Math.ceil((D.dow(first) + D.daysInMonth(y, m)) / 7);
  return { from: start, to: D.addDays(start, weeks * 7 - 1), weeks };
}
const calVisible = (c) => {
  const v = store.get('st.calVis', {})[c.id];
  return v === undefined ? c.selected : v;
};

async function loadCalendars() {
  const j = await cal('/users/me/calendarList?maxResults=250');
  S.calendars = (j.items || []).map((c) => ({
    id: c.id,
    summary: c.summaryOverride || c.summary,
    primary: !!c.primary,
    selected: !!c.selected,
    color: c.backgroundColor,
    writable: c.accessRole === 'owner' || c.accessRole === 'writer',
  }));
  store.set('st.calendars', S.calendars);
}

async function loadEvents() {
  const { from, to } = monthRange();
  const a = D.addDays(from, -7);
  const b = D.addDays(to, 7);
  const tMin = new Date(`${a}T00:00:00`).toISOString();
  const tMax = new Date(`${D.addDays(b, 1)}T00:00:00`).toISOString();
  const res = await Promise.all(
    S.calendars.filter(calVisible).map(async (c) => {
      const items = [];
      let pageToken;
      do {
        const q = new URLSearchParams({ timeMin: tMin, timeMax: tMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '2500' });
        if (pageToken) q.set('pageToken', pageToken);
        try {
          const j = await cal(`/calendars/${encodeURIComponent(c.id)}/events?${q}`);
          items.push(...(j.items || []));
          pageToken = j.nextPageToken;
        } catch (e) {
          if (e.code === 'auth') throw e;
          pageToken = null;
        }
      } while (pageToken);
      return items.filter((i) => i.status !== 'cancelled').map((i) => ({ ...fromGoogle(i, c), raw: i }));
    })
  );
  S.events = res.flat();
  S.range = { from: a, to: b };
  learn();
}

async function loadTasks() {
  const items = [];
  let pageToken;
  do {
    const q = new URLSearchParams({ maxResults: '100', showCompleted: 'true', showHidden: 'true' });
    if (pageToken) q.set('pageToken', pageToken);
    const j = await tasks(`/lists/${TASK_LIST}/tasks?${q}`);
    items.push(...(j.items || []));
    pageToken = j.nextPageToken;
  } while (pageToken);
  // 오래된 완료 항목은 최근 30일만
  const cut = Date.now() - 30 * 86400000;
  S.tasks = items.filter((t) => t.status !== 'completed' || !t.completed || new Date(t.completed).getTime() > cut);
  store.set('st.tasks', S.tasks);
}

async function refreshAll() {
  if (!tokenOk()) return showGate(store.get('st.signedOnce') ? 'expired' : undefined);
  S.loading = true;
  $('#btnRefresh').classList.add('spin');
  try {
    await loadCalendars();
    await Promise.all([loadEvents(), loadTasks()]);
  } catch (e) {
    if (e.code !== 'auth') toast(`불러오기 실패: ${e.message}`);
  } finally {
    S.loading = false;
    $('#btnRefresh').classList.remove('spin');
    render();
  }
}

async function ensureMonthLoaded() {
  const { from, to } = monthRange();
  if (!S.range || from < S.range.from || to > S.range.to) {
    try {
      await loadEvents();
    } catch (e) {
      if (e.code !== 'auth') toast(e.message);
    }
    render();
  }
}

/* ───────────── 장소·참여 인원 자동 채우기 (회사 이름·업무 기준) ───────────── */
const normTitle = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const stripCorp = (t) => normTitle(t).replace(/^(\(주\)|㈜|주식회사|\(유\)|유한회사)\s*/, '').replace(/\s*(\(주\)|㈜|주식회사)(?=\s|$)/, '');
const firstToken = (t) => stripCorp(t).split(' ')[0] || '';
function learn() {
  for (const e of S.events) {
    if (e.holidayCal || (!e.place && !(e.people && e.people.length))) continue;
    const k = normTitle(e.title);
    const at = new Date(`${e.date}T12:00:00`).getTime();
    if (!S.hist[k] || S.hist[k].at <= at) S.hist[k] = { place: e.place || '', people: e.people || [], at };
  }
  const keys = Object.keys(S.hist);
  if (keys.length > 400) keys.sort((a, b) => S.hist[a].at - S.hist[b].at).slice(0, keys.length - 400).forEach((k) => delete S.hist[k]);
  store.set('st.hist', S.hist);
}
function findSimilar(title) {
  const key = normTitle(title);
  if (key.length < 2) return null;
  if (S.hist[key]) return { title: key, ...S.hist[key] };
  const tok = firstToken(key);
  const flat = stripCorp(key).replace(/\s/g, '');
  let best = null;
  let bestScore = -1;
  for (const [t, v] of Object.entries(S.hist)) {
    const c = firstToken(t);
    const tflat = stripCorp(t).replace(/\s/g, '');
    let company = null;
    if (c.length >= 2 && (c === tok || flat.startsWith(c))) company = c;
    else if (tok.length >= 2 && tflat.startsWith(tok)) company = tok;
    if (!company) continue;
    const work = flat.slice(company.length);
    const pastWork = tflat.slice(company.length);
    let score = 1;
    if (work.length >= 2 && pastWork.length >= 2) {
      if (work === pastWork) score = 3;
      else if (work.includes(pastWork) || pastWork.includes(work)) score = 2;
    }
    if (score > bestScore || (score === bestScore && v.at > best.at)) {
      best = { title: t, ...v };
      bestScore = score;
    }
  }
  return best;
}

/* ───────────── 화면: 일정 ───────────── */
function itemsOn(date) {
  const evs = S.events.filter((e) => !e.holidayCal && e.date <= date && e.endDate >= date);
  evs.sort((a, b) => (a.allDay === b.allDay ? (a.startTime || '').localeCompare(b.startTime || '') : a.allDay ? -1 : 1));
  const tds = S.tasks.filter((t) => !t.parent && !t.deleted && t.due && t.due.slice(0, 10) === date);
  return { evs, tds };
}
function holidayMap(from, to) {
  const m = new Map();
  const gh = S.events.filter((e) => e.holidayCal);
  const useGoogle = gh.length > 0;
  if (useGoogle) {
    for (const e of gh) {
      for (let d = e.date; d <= e.endDate; d = D.addDays(d, 1)) {
        const isPublic = !/기념일/.test(e.rawDesc || '');
        const prev = m.get(d);
        m.set(d, { name: prev ? `${prev.name}, ${e.title}` : e.title, red: (prev?.red || false) || isPublic });
      }
    }
  } else {
    for (let y = D.parts(from).y; y <= D.parts(to).y; y++) for (const [d, n] of getHolidays(y)) m.set(d, { name: n, red: true });
  }
  return m;
}

function renderCal() {
  const v = $('#viewCal');
  const { y, m } = D.parts(S.cursor);
  const { from, to } = monthRange();
  const today = D.today();
  const hol = holidayMap(from, to);
  const l1 = solarToLunar(D.make(y, m, 1));
  let html = `<div class="cal-nav">
      <button type="button" class="nav-btn" data-nav="-1" aria-label="이전 달">‹</button>
      <div class="ym">${y}년 ${m}월${l1 ? `<small>음력 ${l1.month}월 ${l1.day}일~</small>` : ''}</div>
      <button type="button" class="nav-btn text" data-nav="0">오늘</button>
      <button type="button" class="nav-btn" data-nav="1" aria-label="다음 달">›</button>
    </div>
    <div class="cal-grid" id="calGrid">
      ${D.DOW_KO.map((d, i) => `<div class="dow ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${d}</div>`).join('')}`;
  let i = 0;
  for (let d = from; d <= to; d = D.addDays(d, 1), i++) {
    const p = D.parts(d);
    const cls = ['dcell'];
    if (p.m !== m) cls.push('out');
    if (i % 7 === 0) cls.push('sun');
    if (i % 7 === 6) cls.push('sat');
    const ho = hol.get(d);
    if (ho?.red) cls.push('hol');
    if (d === today) cls.push('today');
    if (d === S.sel) cls.push('sel');
    const l = solarToLunar(d);
    const lt = l ? (l.day === 1 ? `${l.leap ? '윤' : ''}${l.month}.1` : String(l.day)) : '';
    const { evs, tds } = itemsOn(d);
    const dots = [
      ...evs.slice(0, 3).map((e) => `<i class="${e.lunarSeries ? 'l' : ''}"></i>`),
      ...(evs.length < 3 && tds.length ? ['<i class="t"></i>'] : []),
    ].join('');
    html += `<button type="button" class="${cls.join(' ')}" data-day="${d}" aria-label="${D.label(d)}">
        <span class="n">${p.d}</span>
        ${ho ? `<span class="h" style="${ho.red ? '' : 'color:var(--muted)'}">${h(ho.name)}</span>` : `<span class="l${l && l.day === 1 ? ' first' : ''}">${lt}</span>`}
        <span class="dots">${dots}</span>
      </button>`;
  }
  html += '</div>';

  const { evs, tds } = itemsOn(S.sel);
  const sl = solarToLunar(S.sel);
  const ho = hol.get(S.sel);
  html += `<div class="day-head"><b>${D.parts(S.sel).m}월 ${D.parts(S.sel).d}일 (${D.DOW_KO[D.dow(S.sel)]})</b>
      <span class="small muted">${sl ? `음력 ${sl.leap ? '윤' : ''}${sl.month}.${sl.day}` : ''}${ho ? ` · <span style="color:${ho.red ? 'var(--sun)' : 'inherit'}">${h(ho.name)}</span>` : ''}</span></div>
    <div class="list">`;
  if (!evs.length && !tds.length) html += '<div class="empty">일정이 없습니다. + 버튼으로 추가하세요.</div>';
  for (const e of evs) {
    const tm = e.allDay ? (e.date !== e.endDate ? `${D.parts(e.date).m}/${D.parts(e.date).d}~` : '종일') : e.startTime;
    const meta = [];
    if (e.date !== e.endDate) meta.push(`${D.shortLabel(e.date)} ~ ${D.shortLabel(e.endDate)}`);
    if (e.lunarSeries) meta.push('음력 반복');
    else if (e.recurringEventId) meta.push('반복');
    if (e.place) meta.push(`장소: ${e.place}`);
    if (e.people?.length) meta.push(`참여: ${e.people.join(', ')}`);
    if (S.calendars.filter(calVisible).length > 1) meta.push(e.calendarName);
    html += `<button type="button" class="item" data-ev="${h(e.key)}">
        <span class="tm">${h(tm)}</span><span class="bar ${e.lunarSeries ? 'l' : ''}"></span>
        <span class="body"><div class="ttl">${h(e.title)}</div>${meta.length ? `<div class="meta">${meta.map((x) => `<span>${h(x)}</span>`).join('')}</div>` : ''}</span>
      </button>`;
  }
  for (const t of tds) {
    html += `<button type="button" class="item" data-task="${h(t.id)}">
        <span class="tm">할 일</span><span class="bar t"></span>
        <span class="body"><div class="ttl" style="${t.status === 'completed' ? 'text-decoration:line-through;color:var(--faint)' : ''}">${h(t.title)}</div></span>
      </button>`;
  }
  html += '</div>';
  v.innerHTML = html;
}

/* ───────────── 화면: 할 일 ───────────── */
function taskMeta(t) {
  const today = D.today();
  const kids = S.tasks.filter((k) => k.parent === t.id && !k.deleted);
  const parts = [];
  let over = false;
  if (t.due) {
    const d = t.due.slice(0, 10);
    if (t.status !== 'completed' && d < today) over = true;
    parts.push(d === today ? '오늘' : D.shortLabel(d));
  }
  if (kids.length) parts.push(`하위 ${kids.filter((k) => k.status === 'completed').length}/${kids.length}`);
  if (t.notes) parts.push('메모');
  return parts.length ? `<div class="tm${over ? ' over' : ''}">${h(parts.join(' · '))}</div>` : '';
}
function taskRow(t) {
  const done = t.status === 'completed';
  const kids = S.tasks.filter((k) => k.parent === t.id && !k.deleted).sort((a, b) => String(a.position).localeCompare(String(b.position)));
  return `<div class="tcard">
      <div class="trow${done ? ' done' : ''}">
        <button type="button" class="chk" data-toggle="${h(t.id)}" aria-label="${h(t.title)} ${done ? '완료 취소' : '완료'}"><span></span></button>
        <button type="button" class="tb" data-task="${h(t.id)}"><div class="tt">${h(t.title)}</div>${taskMeta(t)}</button>
      </div>
      ${
        kids.length && !done
          ? `<div class="subl">${kids
              .map(
                (k) => `<div class="srow${k.status === 'completed' ? ' done' : ''}">
                  <button type="button" class="chk" data-toggle="${h(k.id)}" aria-label="${h(k.title)} 완료"><span></span></button>${h(k.title)}</div>`
              )
              .join('')}</div>`
          : ''
      }
    </div>`;
}

function renderTodo() {
  const v = $('#viewTodo');
  const today = D.today();
  const top = S.tasks.filter((t) => !t.parent && !t.deleted && (t.title || '').trim());
  const pending = top.filter((t) => t.status !== 'completed');
  const due = (t) => (t.due ? t.due.slice(0, 10) : null);
  const filters = [
    ['all', '전체'],
    ['today', `오늘 ${pending.filter((t) => due(t) && due(t) <= today).length || ''}`.trim()],
    ['dated', '기한 있음'],
    ['undated', `기한 없음 ${pending.filter((t) => !due(t)).length || ''}`.trim()],
  ];
  const f = { all: () => true, today: (t) => due(t) && due(t) <= today, dated: (t) => !!due(t), undated: (t) => !due(t) }[S.todoFilter];
  const list = pending.filter(f);
  const byDue = (a, b) => due(a).localeCompare(due(b)) || String(a.position).localeCompare(String(b.position));
  const groups = [
    ['over', '기한 지남', list.filter((t) => due(t) && due(t) < today).sort(byDue)],
    ['today', '오늘', list.filter((t) => due(t) === today).sort(byDue)],
    ['', '예정', list.filter((t) => due(t) && due(t) > today).sort(byDue)],
    ['', '기한 없음', list.filter((t) => !due(t)).sort((a, b) => String(a.position).localeCompare(String(b.position)))],
  ];
  let html = `<form class="quick" id="quickForm"><label for="quick" class="sr">새 할 일</label>
      <input id="quick" enterkeyhint="done" autocomplete="off" placeholder="할 일 입력 (예: 내일 자료 정리)"></form>
    <div class="chips" role="tablist">${filters
      .map(([k, n]) => `<button type="button" class="${S.todoFilter === k ? 'on' : ''}" data-filter="${k}">${h(n)}</button>`)
      .join('')}</div>`;
  let any = false;
  for (const [cls, title, arr] of groups) {
    if (!arr.length) continue;
    any = true;
    html += `<div class="grp ${cls}">${title}</div><div class="list">${arr.map(taskRow).join('')}</div>`;
  }
  if (!any) html += '<div class="empty">할 일이 없습니다.</div>';
  const done = top.filter((t) => t.status === 'completed' && f(t)).sort((a, b) => String(b.completed).localeCompare(String(a.completed)));
  if (done.length) {
    html += `<div style="padding:10px 12px"><button type="button" class="linkbtn" id="btnDone">${S.showDone ? '완료한 항목 숨기기' : `완료한 항목 보기 (${done.length})`}</button></div>`;
    if (S.showDone) html += `<div class="list">${done.slice(0, 50).map(taskRow).join('')}</div>`;
  }
  v.innerHTML = html;
}

function render() {
  $('#viewCal').hidden = S.tab !== 'cal';
  $('#viewTodo').hidden = S.tab !== 'todo';
  $$('.tabbar button').forEach((b) => {
    const on = b.dataset.tab === S.tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on);
  });
  $('#topTitle').textContent = S.tab === 'cal' ? '일정' : '할 일';
  if (S.tab === 'cal') renderCal();
  else renderTodo();
}

/* ───────────── 시트(아래에서 올라오는 창) ───────────── */
function openSheet(title, bodyHtml, footHtml) {
  const root = $('#sheetRoot');
  const bd = document.createElement('div');
  bd.className = 'backdrop';
  bd.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${h(title)}">
      <div class="sh-head"><h2>${h(title)}</h2><button type="button" class="icon-btn" data-close aria-label="닫기">✕</button></div>
      <div class="sh-body">${bodyHtml}</div>
      ${footHtml ? `<div class="sh-foot">${footHtml}</div>` : ''}
    </div>`;
  root.appendChild(bd);
  const close = () => {
    if (!bd.isConnected) return;
    bd.remove();
    if (history.state?.sheet) {
      skipPop++;
      history.back();
    }
  };
  bd.addEventListener('click', (e) => {
    if (e.target === bd || e.target.closest('[data-close]')) close();
  });
  history.pushState({ sheet: true }, ''); // 휴대폰 뒤로 가기 = 닫기
  bd._close = () => bd.remove();
  return { el: bd, body: $('.sh-body', bd), close };
}
let skipPop = 0;
window.addEventListener('popstate', () => {
  if (skipPop > 0) {
    skipPop--;
    return;
  }
  const last = $('#sheetRoot').lastElementChild;
  if (last) last._close();
});

function choose(title, message, options) {
  return new Promise((resolve) => {
    const { el, close } = openSheet(
      title,
      `<div style="white-space:pre-line;font-size:15px">${h(message)}</div>
       ${options.map((o, i) => `<button type="button" class="btn block ${o.cls || ''}" data-i="${i}">${h(o.label)}</button>`).join('')}`
    );
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (b) {
        resolve(options[+b.dataset.i].value);
        close();
      } else if (e.target === el || e.target.closest('[data-close]')) resolve(null);
    });
  });
}

/* ───────────── 일정 추가·수정 ───────────── */
const ALARMS_ALLDAY = [['', '알림 없음'], ['360', '전날 오후 6시'], ['900', '1일 전 오전 9시'], ['3780', '3일 전 오전 9시'], ['9540', '7일 전 오전 9시']];
const ALARMS_TIMED = [['', '알림 없음'], ['0', '시작 시각'], ['10', '10분 전'], ['30', '30분 전'], ['60', '1시간 전'], ['1440', '1일 전']];

function openEvent(e = null, date = S.sel) {
  const writable = S.calendars.filter((c) => c.writable);
  const defCal = store.get('st.defCal');
  const l0 = solarToLunar(e?.date || date) || { month: 1, day: 1, leap: false };
  const f = {
    title: e?.title || '',
    date: e?.date || date,
    endDate: e?.endDate || e?.date || date,
    allDay: e ? e.allDay : true,
    startTime: e?.startTime || '09:00',
    endTime: e?.endTime || '10:00',
    place: e?.place || '',
    people: [...(e?.people || [])],
    memo: e?.memo || '',
    repeat: 'none',
    calType: 'solar',
    lMonth: l0.month,
    lDay: l0.day,
    leap: l0.leap,
    alarm: e ? (e.alarm === null || e.alarm === undefined ? '' : String(e.alarm)) : '',
    calendarId: e?.calendarId || (writable.some((c) => c.id === defCal) ? defCal : writable.find((c) => c.primary)?.id || writable[0]?.id),
  };
  const auto = { on: !e, placeTouched: false, peopleTouched: false, filledPlace: false, filledPeople: false, from: null };
  const readonly = e && !e.writable;
  const recurring = e && (e.recurringEventId || e.lunarSeries);
  const sel = (opts, v) => opts.map(([k, t]) => `<option value="${k}" ${String(v) === k ? 'selected' : ''}>${h(t)}</option>`).join('');
  const { el, body, close } = openSheet(
    e ? '일정' : '새 일정',
    '',
    `${e && !readonly ? '<button type="button" class="btn danger" data-del>삭제</button>' : ''}<button type="button" class="btn primary" data-save>${readonly ? '닫기' : '저장'}</button>`
  );

  const lunarPreview = () => {
    const y0 = D.parts(D.today()).y;
    const out = [];
    for (let y = y0; y < y0 + 4 && y <= LUNAR_MAX_YEAR; y++) {
      const r = lunarToSolar(y, f.lMonth, f.lDay, f.leap);
      if (r) out.push(`${D.label(r.date)}${r.adjusted ? ' *' : ''}`);
    }
    return `<b>양력 환산 (앞으로 ${LUNAR_YEARS}년치 등록)</b>${out.map((x) => `<span>${x}</span>`).join('')}`;
  };

  const draw = () => {
    const isL = f.calType === 'lunar';
    body.innerHTML = `
      ${readonly ? '<div class="note">읽기 전용 캘린더의 일정입니다.</div>' : ''}
      <div class="fld"><label class="lbl" for="e-title">제목</label><input class="inp" id="e-title" value="${h(f.title)}" ${readonly ? 'disabled' : ''} enterkeyhint="next"></div>
      ${
        isL
          ? `<div class="row3">
              <div class="fld"><label class="lbl" for="e-lm">음력 월</label><select class="inp" id="e-lm">${sel(Array.from({ length: 12 }, (_, i) => [String(i + 1), `${i + 1}월`]), f.lMonth)}</select></div>
              <div class="fld"><label class="lbl" for="e-ld">음력 일</label><select class="inp" id="e-ld">${sel(Array.from({ length: 30 }, (_, i) => [String(i + 1), `${i + 1}일`]), f.lDay)}</select></div>
              <label class="switch" style="align-self:end">윤달 <input type="checkbox" id="e-leap" ${f.leap ? 'checked' : ''}></label>
            </div>
            <div class="preview" id="e-prev">${lunarPreview()}</div>`
          : `<div class="row2">
              <div class="fld"><label class="lbl" for="e-date">시작일</label><input type="date" class="inp" id="e-date" value="${f.date}" ${readonly || recurring ? 'disabled' : ''}></div>
              <div class="fld"><label class="lbl" for="e-end">종료일</label><input type="date" class="inp" id="e-end" value="${f.endDate}" min="${f.date}" ${readonly || recurring ? 'disabled' : ''}></div>
            </div>`
      }
      ${
        auto.from
          ? `<div class="note">이전 일정 "${h(auto.from)}"을(를) 참고해 채웠습니다. <button type="button" class="linkbtn" data-autoclear style="padding:0">지우기</button></div>`
          : ''
      }
      <div class="fld"><label class="lbl" for="e-place">장소</label><input class="inp" id="e-place" value="${h(f.place)}" placeholder="장소 또는 주소" ${readonly ? 'disabled' : ''}></div>
      <div class="fld"><label class="lbl" for="e-people">참여 인원</label>
        <div class="chipsbox">${f.people
          .map((p, i) => `<span class="person">${h(p)}${readonly ? '' : `<button type="button" data-rmp="${i}" aria-label="${h(p)} 삭제">×</button>`}</span>`)
          .join('')}${readonly ? '' : '<input id="e-people" placeholder="이름 입력 후 완료" enterkeyhint="enter">'}</div></div>
      ${
        e
          ? recurring
            ? `<div class="note">${e.lunarSeries ? '음력 반복 일정' : '반복 일정'}입니다. 이 날짜의 일정만 바뀝니다.</div>`
            : ''
          : `<div class="row2">
              <div class="fld"><label class="lbl" for="e-rep">반복</label><select class="inp" id="e-rep">${sel(
                isL ? [['lunarYearly', '매년 (음력)'], ['none', '반복 안 함']] : [['none', '반복 안 함'], ['daily', '매일'], ['weekly', '매주'], ['monthly', '매월'], ['yearly', '매년']],
                f.repeat
              )}</select></div>
              <div class="fld"><label class="lbl" for="e-alarm">알림</label><select class="inp" id="e-alarm">${sel(f.allDay ? ALARMS_ALLDAY : ALARMS_TIMED, f.alarm)}</select></div>
            </div>`
      }
      <label class="switch">종일 <input type="checkbox" id="e-allday" ${f.allDay ? 'checked' : ''} ${readonly || recurring ? 'disabled' : ''}></label>
      ${
        f.allDay
          ? ''
          : `<div class="row2">
              <div class="fld"><label class="lbl" for="e-st">시작</label><input type="time" class="inp" id="e-st" value="${f.startTime}" ${readonly || recurring ? 'disabled' : ''}></div>
              <div class="fld"><label class="lbl" for="e-et">종료</label><input type="time" class="inp" id="e-et" value="${f.endTime}" ${readonly || recurring ? 'disabled' : ''}></div>
            </div>`
      }
      ${
        e
          ? ''
          : `<div class="fld"><span class="lbl">날짜 기준</span><div class="seg lunar">
              <button type="button" class="${!isL ? 'on' : ''}" data-ct="solar">양력</button>
              <button type="button" class="${isL ? 'on l' : ''}" data-ct="lunar">음력</button></div></div>`
      }
      <div class="fld"><label class="lbl" for="e-memo">메모</label><textarea class="inp" id="e-memo" ${readonly ? 'disabled' : ''}>${h(f.memo)}</textarea></div>
      ${
        e
          ? `<div class="note">캘린더: ${h(e.calendarName)}</div>`
          : `<div class="fld"><label class="lbl" for="e-cal">캘린더</label><select class="inp" id="e-cal">${writable
              .map((c) => `<option value="${h(c.id)}" ${c.id === f.calendarId ? 'selected' : ''}>${h(c.summary)}${c.primary ? ' (기본)' : ''}</option>`)
              .join('')}</select></div>`
      }`;
  };
  draw();
  if (!e) setTimeout(() => $('#e-title', body)?.focus(), 250);

  let autoTimer;
  const applyAuto = () => {
    if (!auto.on) return;
    const m = findSimilar(f.title);
    if (auto.filledPlace && !auto.placeTouched) (f.place = ''), (auto.filledPlace = false);
    if (auto.filledPeople && !auto.peopleTouched) (f.people = []), (auto.filledPeople = false);
    auto.from = null;
    if (m) {
      if (!auto.placeTouched && !f.place && m.place) (f.place = m.place), (auto.filledPlace = true);
      if (!auto.peopleTouched && !f.people.length && m.people?.length) (f.people = [...m.people]), (auto.filledPeople = true);
      if (auto.filledPlace || auto.filledPeople) auto.from = m.title;
    }
    const t = $('#e-title', body);
    const pos = t?.selectionStart;
    const focused = document.activeElement === t;
    draw();
    if (focused) {
      const nt = $('#e-title', body);
      nt.focus();
      nt.setSelectionRange(pos, pos);
    }
  };
  const addPerson = () => {
    const inp = $('#e-people', body);
    const names = (inp?.value || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);
    if (!names.length) return;
    f.people.push(...names.filter((n) => !f.people.includes(n)));
    auto.peopleTouched = true;
    auto.filledPeople = false;
    draw();
    $('#e-people', body)?.focus();
  };

  body.addEventListener('input', (ev) => {
    const id = ev.target.id;
    if (id === 'e-title') {
      f.title = ev.target.value;
      clearTimeout(autoTimer);
      autoTimer = setTimeout(applyAuto, 400);
    } else if (id === 'e-place') {
      f.place = ev.target.value;
      auto.placeTouched = true;
      auto.filledPlace = false;
    } else if (id === 'e-memo') f.memo = ev.target.value;
    else if (id === 'e-st') f.startTime = ev.target.value;
    else if (id === 'e-et') f.endTime = ev.target.value;
  });
  body.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'e-date') {
      const dur = D.diffDays(f.date, f.endDate);
      f.date = t.value || f.date;
      f.endDate = D.addDays(f.date, Math.max(0, dur));
      draw();
    } else if (t.id === 'e-end') {
      f.endDate = t.value && t.value >= f.date ? t.value : f.date;
      draw();
    } else if (t.id === 'e-allday') {
      f.allDay = t.checked;
      if (!(f.allDay ? ALARMS_ALLDAY : ALARMS_TIMED).some((o) => o[0] === f.alarm)) f.alarm = '';
      draw();
    } else if (t.id === 'e-rep') f.repeat = t.value;
    else if (t.id === 'e-alarm') f.alarm = t.value;
    else if (t.id === 'e-cal') f.calendarId = t.value;
    else if (t.id === 'e-lm' || t.id === 'e-ld') {
      f[t.id === 'e-lm' ? 'lMonth' : 'lDay'] = +t.value;
      $('#e-prev', body).innerHTML = lunarPreview();
    } else if (t.id === 'e-leap') {
      f.leap = t.checked;
      $('#e-prev', body).innerHTML = lunarPreview();
    }
  });
  body.addEventListener('keydown', (ev) => {
    if (ev.target.id === 'e-people' && (ev.key === 'Enter' || ev.key === ',')) {
      ev.preventDefault();
      addPerson();
    }
  });
  body.addEventListener('focusout', (ev) => {
    if (ev.target.id === 'e-people' && ev.target.value.trim()) addPerson();
  });
  body.addEventListener('click', (ev) => {
    const rp = ev.target.closest('[data-rmp]');
    if (rp) {
      f.people.splice(+rp.dataset.rmp, 1);
      auto.peopleTouched = true;
      auto.filledPeople = false;
      draw();
    } else if (ev.target.closest('[data-autoclear]')) {
      if (auto.filledPlace) f.place = '';
      if (auto.filledPeople) f.people = [];
      auto.on = false;
      auto.from = null;
      draw();
    } else if (ev.target.closest('[data-ct]')) {
      f.calType = ev.target.closest('[data-ct]').dataset.ct;
      if (f.calType === 'lunar') {
        const l = solarToLunar(f.date);
        if (l) Object.assign(f, { lMonth: l.month, lDay: l.day, leap: l.leap });
        f.repeat = 'lunarYearly';
      } else f.repeat = 'none';
      draw();
    }
  });

  el.addEventListener('click', async (ev) => {
    if (ev.target.closest('[data-del]')) {
      let target = e.gid;
      if (e.recurringEventId) {
        const mode = await choose('반복 일정 삭제', `"${e.title}"`, [
          { label: '이 날짜만', value: 'one' },
          { label: '반복 전체', value: 'all', cls: 'danger' },
        ]);
        if (!mode) return;
        if (mode === 'all') target = e.recurringEventId;
      } else if (!(await choose('일정 삭제', `"${e.title}" 일정을 삭제할까요?${e.lunarSeries ? '\n(음력 반복 중 이 해의 일정만 삭제됩니다)' : ''}`, [{ label: '삭제', value: 1, cls: 'danger' }]))) return;
      try {
        await cal(`/calendars/${encodeURIComponent(e.calendarId)}/events/${encodeURIComponent(target)}?sendUpdates=none`, { method: 'DELETE' });
        close();
        toast('삭제했습니다.');
        await loadEvents();
        render();
      } catch (er) {
        toast(`삭제 실패: ${er.message}`);
      }
      return;
    }
    if (!ev.target.closest('[data-save]')) return;
    if (readonly) return close();
    if ($('#e-people', body)?.value.trim()) addPerson();
    if (!f.title.trim()) return toast('제목을 입력하세요.');
    const btn = ev.target.closest('[data-save]');
    btn.disabled = true;
    try {
      if (e) await updateEvent(e, f);
      else await createEvent(f);
      store.set('st.defCal', f.calendarId);
      const k = normTitle(f.title);
      if (f.place || f.people.length) {
        S.hist[k] = { place: f.place, people: f.people, at: Date.now() };
        store.set('st.hist', S.hist);
      }
      close();
      toast('저장했습니다.');
      await loadEvents();
      render();
    } catch (er) {
      btn.disabled = false;
      toast(`저장 실패: ${er.message}`);
    }
  });
}

async function createEvent(f) {
  const ev = {
    id: `m-${uid()}`,
    title: f.title.trim(),
    memo: f.memo,
    place: f.place.trim(),
    people: f.people,
    allDay: f.allDay,
    startTime: f.startTime,
    endTime: f.endTime,
    alarm: f.alarm === '' ? null : Number(f.alarm),
    exdates: [],
  };
  const path = `/calendars/${encodeURIComponent(f.calendarId)}/events?sendUpdates=none`;
  if (f.calType === 'lunar') {
    const y0 = D.parts(D.today()).y;
    const r0 = lunarToSolar(y0, f.lMonth, f.lDay, f.leap);
    Object.assign(ev, { calType: 'lunar', repeat: f.repeat, lunar: { month: f.lMonth, day: f.lDay, leap: f.leap, baseYear: y0 }, date: r0?.date, endDate: r0?.date });
    const targets = lunarTargets(ev, LUNAR_YEARS, y0 + 1).filter((t) => t.year >= y0);
    for (const t of targets) {
      const p = lunarPayload(ev, t.year, t.date);
      p.extendedProperties.private.stLunar = `${f.lMonth}/${f.lDay}/${f.leap ? 1 : 0}`;
      await cal(path, { method: 'POST', body: p });
    }
    return;
  }
  Object.assign(ev, { calType: 'solar', repeat: f.repeat, date: f.date, endDate: f.endDate });
  await cal(path, { method: 'POST', body: solarPayload(ev) });
}

async function updateEvent(e, f) {
  const payload = {
    summary: f.title.trim(),
    description: composeDescription(f.memo, f.place.trim(), f.people),
  };
  if (!e.recurringEventId && !e.lunarSeries) Object.assign(payload, timeRange(f.date, f.endDate, { allDay: f.allDay, startTime: f.startTime, endTime: f.endTime }));
  await cal(`/calendars/${encodeURIComponent(e.calendarId)}/events/${encodeURIComponent(e.gid)}?sendUpdates=none`, { method: 'PATCH', body: payload });
}

/* ───────────── 할 일 추가·수정 ───────────── */
async function addTask(title, due) {
  const body = { title, ...(due ? { due: `${due}T00:00:00.000Z` } : {}) };
  const r = await tasks(`/lists/${TASK_LIST}/tasks`, { method: 'POST', body });
  S.tasks.push(r);
  render();
}

async function toggleTask(id) {
  const t = S.tasks.find((x) => x.id === id);
  if (!t) return;
  const done = t.status !== 'completed';
  t.status = done ? 'completed' : 'needsAction';
  t.completed = done ? new Date().toISOString() : undefined;
  render();
  try {
    const r = await tasks(`/lists/${TASK_LIST}/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { status: t.status, ...(done ? {} : { completed: null }) },
    });
    Object.assign(t, r);
    store.set('st.tasks', S.tasks);
  } catch (er) {
    toast(`저장 실패: ${er.message}`);
  }
}

function openTask(t = null) {
  const kids = t ? S.tasks.filter((k) => k.parent === t.id && !k.deleted).sort((a, b) => String(a.position).localeCompare(String(b.position))) : [];
  const f = {
    title: t?.title || '',
    hasDue: !!t?.due,
    due: t?.due ? t.due.slice(0, 10) : D.today(),
    notes: t?.notes || '',
    subs: kids.map((k) => ({ id: k.id, title: k.title || '', done: k.status === 'completed' })),
  };
  const removed = [];
  const { el, body, close } = openSheet(
    t ? '할 일' : '새 할 일',
    '',
    `${t ? '<button type="button" class="btn danger" data-del>삭제</button>' : ''}<button type="button" class="btn primary" data-save>저장</button>`
  );
  const draw = () => {
    body.innerHTML = `
      <div class="fld"><label class="lbl" for="t-title">할 일</label><input class="inp" id="t-title" value="${h(f.title)}"></div>
      <label class="switch">기한 지정 <input type="checkbox" id="t-hasdue" ${f.hasDue ? 'checked' : ''}></label>
      ${f.hasDue ? `<div class="fld"><label class="lbl" for="t-due">기한일</label><input type="date" class="inp" id="t-due" value="${f.due}"></div>` : ''}
      <div class="fld"><span class="lbl">하위 할 일</span>
        <div class="sublist">${f.subs
          .map(
            (x, i) => `<div class="srow"><input type="checkbox" data-sdone="${i}" ${x.done ? 'checked' : ''} aria-label="완료">
              <input type="text" data-stitle="${i}" value="${h(x.title)}" aria-label="하위 할 일"><button type="button" data-sdel="${i}" aria-label="삭제">×</button></div>`
          )
          .join('')}<input id="t-subnew" placeholder="+ 하위 할 일 추가" enterkeyhint="enter"></div></div>
      <div class="fld"><label class="lbl" for="t-notes">메모</label><textarea class="inp" id="t-notes">${h(f.notes)}</textarea></div>
      ${t ? '<div class="note">시간·반복·알림은 PC 프로그램에서 설정합니다. 반복 할 일은 여기서 완료해도 PC가 다음 회차를 만들어 줍니다.</div>' : ''}`;
  };
  draw();
  if (!t) setTimeout(() => $('#t-title', body)?.focus(), 250);
  const addSub = () => {
    const v = $('#t-subnew', body).value.trim();
    if (!v) return;
    f.subs.push({ id: null, title: v, done: false });
    draw();
    $('#t-subnew', body).focus();
  };
  body.addEventListener('input', (ev) => {
    const x = ev.target;
    if (x.id === 't-title') f.title = x.value;
    else if (x.id === 't-notes') f.notes = x.value;
    else if (x.dataset.stitle !== undefined) f.subs[+x.dataset.stitle].title = x.value;
  });
  body.addEventListener('change', (ev) => {
    const x = ev.target;
    if (x.id === 't-hasdue') {
      f.hasDue = x.checked;
      draw();
    } else if (x.id === 't-due') f.due = x.value || D.today();
    else if (x.dataset.sdone !== undefined) f.subs[+x.dataset.sdone].done = x.checked;
  });
  body.addEventListener('keydown', (ev) => {
    if (ev.target.id === 't-subnew' && ev.key === 'Enter') {
      ev.preventDefault();
      addSub();
    }
  });
  body.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-sdel]');
    if (!b) return;
    const [x] = f.subs.splice(+b.dataset.sdel, 1);
    if (x.id) removed.push(x.id);
    draw();
  });
  el.addEventListener('click', async (ev) => {
    if (ev.target.closest('[data-del]')) {
      if (!(await choose('할 일 삭제', `"${t.title}"을(를) 삭제할까요?`, [{ label: '삭제', value: 1, cls: 'danger' }]))) return;
      try {
        await tasks(`/lists/${TASK_LIST}/tasks/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
        S.tasks = S.tasks.filter((x) => x.id !== t.id && x.parent !== t.id);
        close();
        render();
      } catch (er) {
        toast(`삭제 실패: ${er.message}`);
      }
      return;
    }
    if (!ev.target.closest('[data-save]')) return;
    if ($('#t-subnew', body).value.trim()) addSub();
    if (!f.title.trim()) return toast('할 일을 입력하세요.');
    const btn = ev.target.closest('[data-save]');
    btn.disabled = true;
    try {
      const L = `/lists/${TASK_LIST}/tasks`;
      const main = { title: f.title.trim(), notes: f.notes, due: f.hasDue ? `${f.due}T00:00:00.000Z` : null };
      const r = t ? await tasks(`${L}/${encodeURIComponent(t.id)}`, { method: 'PATCH', body: main }) : await tasks(L, { method: 'POST', body: main });
      let prev = null;
      for (const x of f.subs) {
        const sb = { title: x.title.trim(), status: x.done ? 'completed' : 'needsAction', ...(x.done ? {} : { completed: null }) };
        if (!sb.title) continue;
        if (x.id) await tasks(`${L}/${encodeURIComponent(x.id)}`, { method: 'PATCH', body: sb });
        else {
          const q = new URLSearchParams({ parent: r.id, ...(prev ? { previous: prev } : {}) });
          const c = await tasks(`${L}?${q}`, { method: 'POST', body: sb });
          x.id = c.id;
        }
        prev = x.id;
      }
      for (const id of removed) await tasks(`${L}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      close();
      await loadTasks();
      render();
    } catch (er) {
      btn.disabled = false;
      toast(`저장 실패: ${er.message}`);
    }
  });
}

/* ───────────── 휴대폰 알림 (PC 프로그램이 보내는 푸시) ─────────────
 * PC 프로그램이 Google Tasks의 "일정&할일 알림 연결" 목록에 알림 키를 올려 두고,
 * 이 휴대폰은 같은 목록에 구독 정보를 올린다. 알림 시각이 되면 PC가 휴대폰으로 보낸다.
 */
const b64uToBytes = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
async function pushList() {
  const j = await tasks('/users/@me/lists?maxResults=100');
  return (j.items || []).find((l) => l.title === PUSH_LIST_TITLE) || null;
}
function deviceName() {
  const ua = navigator.userAgent;
  const m = ua.match(/Android [\d.]+; ([^;)]+)/);
  if (m) return m[1].replace(/ Build.*/, '').trim();
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  return '휴대폰';
}
async function pushStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return { ok: false, msg: '이 브라우저는 알림을 지원하지 않습니다. 홈 화면에 앱을 설치한 뒤 다시 시도하세요.' };
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return { ok: true, on: !!sub && Notification.permission === 'granted' && !!store.get('st.pushDevice') };
}
async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('알림 권한이 허용되지 않았습니다. 휴대폰 설정에서 이 앱의 알림을 켜 주세요.');
  const list = await pushList();
  const items = list ? (await tasks(`/lists/${list.id}/tasks?showHidden=true&maxResults=100`)).items || [] : [];
  const keyTask = items.find((t) => t.title === 'PC 알림 키 (지우지 마세요)');
  if (!keyTask?.notes) throw new Error('PC 프로그램의 알림 키를 찾지 못했습니다. PC 프로그램을 최신 버전으로 켜 두고 잠시 후 다시 시도하세요.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const key = keyTask.notes.trim();
  if (sub && store.get('st.pushKey') !== key) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
  const dev = store.get('st.pushDevice') || { id: uid() };
  const notes = JSON.stringify({ id: dev.id, sub: sub.toJSON(), name: deviceName(), at: Date.now() });
  const title = `휴대폰 알림: ${deviceName()} (${dev.id.slice(0, 4)})`;
  const existing = items.find((t) => (t.notes || '').includes(dev.id));
  if (existing) await tasks(`/lists/${list.id}/tasks/${existing.id}`, { method: 'PATCH', body: { title, notes } });
  else await tasks(`/lists/${list.id}/tasks`, { method: 'POST', body: { title, notes } });
  store.set('st.pushDevice', dev);
  store.set('st.pushKey', key);
}
async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) await sub.unsubscribe();
  const dev = store.get('st.pushDevice');
  if (dev) {
    const list = await pushList();
    if (list) {
      const items = (await tasks(`/lists/${list.id}/tasks?showHidden=true&maxResults=100`)).items || [];
      for (const t of items.filter((x) => (x.notes || '').includes(dev.id))) await tasks(`/lists/${list.id}/tasks/${t.id}`, { method: 'DELETE' });
    }
  }
  store.set('st.pushDevice', null);
}

/* ───────────── 설정 ───────────── */
async function openSettings() {
  const { body } = openSheet('설정', '<div class="note">불러오는 중…</div>');
  const draw = async () => {
    let ps = { ok: false, msg: '' };
    try {
      ps = await pushStatus();
    } catch (e) {
      ps = { ok: false, msg: e.message };
    }
    body.innerHTML = `
      <div class="sect"><h3>계정</h3>
        <div class="small">${h(store.get('st.email') || '')}</div>
        <button type="button" class="btn" data-signout>로그아웃</button></div>
      <div class="sect"><h3>휴대폰 알림</h3>
        ${
          ps.ok
            ? ps.on
              ? `<div class="small">이 휴대폰으로 알림을 받고 있습니다.</div>
                 <div class="row2"><button type="button" class="btn" data-ptest>테스트 알림</button><button type="button" class="btn danger" data-poff>알림 끄기</button></div>`
              : '<button type="button" class="btn primary" data-pon>이 휴대폰으로 알림 받기</button>'
            : `<div class="note warn">${h(ps.msg)}</div>`
        }
        <div class="note">할 일 알림(그리고 PC에서 선택한 일정 알림)을 PC 프로그램이 이 휴대폰으로 보냅니다. PC가 켜져 있고 프로그램이 실행 중일 때 전달됩니다. 구글 캘린더 일정의 알림은 휴대폰의 구글 캘린더 앱에서도 받을 수 있습니다.</div>
        <span class="note" id="pMsg"></span></div>
      <div class="sect"><h3>표시할 캘린더</h3>
        ${S.calendars
          .map(
            (c) => `<label class="calrow"><input type="checkbox" data-calvis="${h(c.id)}" ${calVisible(c) ? 'checked' : ''}><i style="background:${h(c.color || '#999')}"></i>${h(c.summary)}</label>`
          )
          .join('')}</div>
      <div class="sect"><div class="note">버전 ${VERSION} · 앱은 열 때마다 자동으로 최신 버전으로 업데이트됩니다.</div></div>`;
  };
  await draw();
  body.addEventListener('change', async (ev) => {
    const c = ev.target.dataset.calvis;
    if (!c) return;
    const vis = store.get('st.calVis', {});
    vis[c] = ev.target.checked;
    store.set('st.calVis', vis);
    S.range = null;
    await ensureMonthLoaded();
  });
  body.addEventListener('click', async (ev) => {
    const msg = () => $('#pMsg', body);
    try {
      if (ev.target.closest('[data-signout]')) {
        $('#sheetRoot').lastElementChild?._close();
        signOut();
      } else if (ev.target.closest('[data-pon]')) {
        msg().textContent = '설정 중…';
        await enablePush();
        await draw();
        toast('이 휴대폰으로 알림을 받습니다.');
      } else if (ev.target.closest('[data-poff]')) {
        await disablePush();
        await draw();
      } else if (ev.target.closest('[data-ptest]')) {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification('일정 & 할일', { body: '알림이 정상적으로 표시됩니다.', icon: 'icons/icon-192.png', badge: 'icons/badge-96.png' });
      }
    } catch (e) {
      if (msg()) {
        msg().textContent = e.message;
        msg().classList.add('warn');
      }
    }
  });
}

/* ───────────── 이벤트 연결 ───────────── */
function bind() {
  $('.tabbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    S.tab = b.dataset.tab;
    history.replaceState(history.state, '', S.tab === 'todo' ? '#todo' : '#');
    render();
    window.scrollTo(0, 0);
  });
  $('#fab').addEventListener('click', () => (S.tab === 'cal' ? openEvent(null, S.sel) : openTask()));
  $('#btnRefresh').addEventListener('click', refreshAll);
  $('#btnSettings').addEventListener('click', openSettings);

  const move = async (n) => {
    if (n === 0) {
      S.cursor = S.sel = D.today();
    } else {
      const { y, m } = D.parts(S.cursor);
      const t = D.addMonths(y, m, n);
      S.cursor = D.make(t.y, t.m, 1);
      S.sel = S.cursor.slice(0, 7) === D.today().slice(0, 7) ? D.today() : S.cursor;
    }
    render();
    await ensureMonthLoaded();
  };
  $('#viewCal').addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) return move(+nav.dataset.nav);
    const day = e.target.closest('[data-day]');
    if (day) {
      const d = day.dataset.day;
      if (d === S.sel) return openEvent(null, d); // 같은 날 한 번 더 누르면 새 일정
      S.sel = d;
      if (d.slice(0, 7) !== S.cursor.slice(0, 7)) {
        S.cursor = D.make(D.parts(d).y, D.parts(d).m, 1);
        render();
        return ensureMonthLoaded();
      }
      return render();
    }
    const ev = e.target.closest('[data-ev]');
    if (ev) return openEvent(S.events.find((x) => x.key === ev.dataset.ev));
    const tk = e.target.closest('[data-task]');
    if (tk) return openTask(S.tasks.find((x) => x.id === tk.dataset.task));
  });
  // 달력 좌우로 밀어서 달 이동
  let sx = null;
  let sy = null;
  $('#viewCal').addEventListener('touchstart', (e) => {
    if (!e.target.closest('#calGrid')) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
  }, { passive: true });
  $('#viewCal').addEventListener('touchend', (e) => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) move(dx < 0 ? 1 : -1);
  }, { passive: true });

  $('#viewTodo').addEventListener('submit', async (e) => {
    if (e.target.id !== 'quickForm') return;
    e.preventDefault();
    const inp = $('#quick');
    const v = inp.value.trim();
    if (!v) return;
    inp.value = '';
    const p = parseQuickAdd(v);
    try {
      await addTask(p.title, p.due);
      if (p.repeat && p.repeat.type !== 'none') toast('반복 설정은 PC 프로그램에서 해 주세요. 할 일만 추가했습니다.');
      $('#quick')?.focus();
    } catch (er) {
      toast(`추가 실패: ${er.message}`);
    }
  });
  $('#viewTodo').addEventListener('click', (e) => {
    const tg = e.target.closest('[data-toggle]');
    if (tg) return toggleTask(tg.dataset.toggle);
    const tk = e.target.closest('[data-task]');
    if (tk) return openTask(S.tasks.find((x) => x.id === tk.dataset.task));
    const fl = e.target.closest('[data-filter]');
    if (fl) {
      S.todoFilter = fl.dataset.filter;
      return render();
    }
    if (e.target.id === 'btnDone') {
      S.showDone = !S.showDone;
      render();
    }
  });

  // 알림을 눌러 앱이 열리면 해당 탭으로
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'open-tab' && e.data.tab) {
      S.tab = e.data.tab;
      render();
    }
  });
  // 다시 앱으로 돌아오면 새로고침
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && tokenOk() && !S.loading && Date.now() - (S.lastRefresh || 0) > 60000) {
      S.lastRefresh = Date.now();
      refreshAll();
    }
  });
}

/* ───────────── 시작 ───────────── */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
bind();
render();
if (tokenOk()) {
  S.lastRefresh = Date.now();
  refreshAll();
} else showGate(store.get('st.signedOnce') ? 'expired' : undefined);
