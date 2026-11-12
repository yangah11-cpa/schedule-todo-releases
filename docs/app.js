// 일정 & 할일 — 휴대폰 앱(PWA)
// 데이터는 Google 캘린더(일정)와 Google Tasks "내 할 일"(할 일)에 직접 읽고 쓴다. PC 프로그램과 같은 데이터를 공유.
import { CLIENT_ID as DEFAULT_CLIENT_ID, VERSION } from './config.js';
import * as D from './lib/dates.js';
import { solarToLunar, lunarToSolar, LUNAR_MAX_YEAR } from './lib/lunar.js';
import { getHolidays } from './lib/holidays.js';
import { parseQuickAdd } from './lib/recur.js';
import { solarPayload, lunarTargets, lunarPayload, fromGoogle, timeRange, composeDescription } from './lib/gsync.js';
import { parseShared, mailCandidates, setKeywords, extractWords, scoreWords, mergeKeywords, keywordsOf, BASE_KEYS, highlightHtml, cleanSubject } from './lib/mailparse.js';
import { gmailClient, GMAIL_SCOPE, GMAIL } from './lib/gmail.js';

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
/** 클립보드 복사 (구형 브라우저는 임시 입력칸으로) */
async function copyText(text, done) {
  if (!text) return toast('복사할 장소가 없습니다.');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      /* 무시 */
    }
    ta.remove();
  }
  toast(done);
}

/** 시작 시간을 고르면 종료 시간을 1시간 뒤로 자동 입력하고, 바뀐 칸을 잠깐 강조해 확인할 수 있게 한다 */
function autoEndTime(f, root, start) {
  if (!/^\d{1,2}:\d{2}/.test(start || '')) return;
  const [hh, mm] = start.split(':').map(Number);
  const m = Math.min(hh * 60 + mm + 60, 23 * 60 + 59);
  f.endTime = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const et = root.querySelector('#e-et');
  if (!et) return;
  if (et.tagName === 'BUTTON') et.textContent = f.endTime;
  else et.value = f.endTime;
  et.classList.remove('autofilled');
  void et.offsetWidth;
  et.classList.add('autofilled');
}

/** 시·분을 위아래로 굴려 고르는 시간 선택기 (24시간) */
function openTimeWheel(title, value, onOk) {
  const ITEM = 48;
  const [h0, m0] = (/^\d{1,2}:\d{2}/.test(value || '') ? value : '09:00').split(':').map(Number);
  const col = (n, cls) =>
    `<div class="wcol ${cls}"><div class="wpad"></div>${Array.from({ length: n }, (_, i) => `<div class="witem" data-v="${i}">${String(i).padStart(2, '0')}</div>`).join('')}<div class="wpad"></div></div>`;
  const ov = document.createElement('div');
  ov.className = 'wheel-ov';
  ov.innerHTML = `<div class="wheel-box" role="dialog" aria-label="${title}">
      <div class="wheel-t">${title}</div>
      <div class="wheel">${col(24, 'wh')}<div class="wsep">:</div>${col(60, 'wm')}<div class="wband"></div></div>
      <div class="wheel-f"><button type="button" class="btn" data-wx>취소</button><button type="button" class="btn primary" data-wok>확인</button></div>
    </div>`;
  document.body.appendChild(ov);
  const ch = ov.querySelector('.wh');
  const cm = ov.querySelector('.wm');
  const pick = (c) => Math.max(0, Math.min(c.querySelectorAll('.witem').length - 1, Math.round(c.scrollTop / ITEM)));
  const mark = (c) => {
    const v = pick(c);
    c.querySelectorAll('.witem').forEach((x, i) => x.classList.toggle('on', i === v));
  };
  ch.scrollTop = h0 * ITEM;
  cm.scrollTop = m0 * ITEM;
  mark(ch);
  mark(cm);
  for (const c of [ch, cm]) {
    c.addEventListener('scroll', () => mark(c), { passive: true });
    c.addEventListener('click', (e) => {
      const it = e.target.closest('.witem');
      if (it) c.scrollTo({ top: +it.dataset.v * ITEM, behavior: 'smooth' });
    });
  }
  const close = () => ov.remove();
  ov.addEventListener('click', (e) => {
    if (e.target === ov || e.target.closest('[data-wx]')) return close();
    if (e.target.closest('[data-wok]')) {
      onOk(`${String(pick(ch)).padStart(2, '0')}:${String(pick(cm)).padStart(2, '0')}`);
      close();
    }
  });
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.tm);
  toast.tm = setTimeout(() => t.classList.remove('show'), 2800);
}

const SCOPES = 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/drive.appdata';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const CAL = 'https://www.googleapis.com/calendar/v3';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
const TASK_LIST = '@default';
const PUSH_LIST_TITLE = '일정&할일 알림 연결 (지우지 마세요)';
const LUNAR_YEARS = 10;

const S = {
  tab: { '#todo': 'todo', '#mail': 'mail', '#team': 'team' }[location.hash] || 'cal',
  mailSum: store.get('st.mailsum', null),
  mailDone: store.get('st.maildone', {}),
  cursor: D.today(),
  sel: D.today(),
  calendars: store.get('st.calendars', []),
  events: store.get('st.events', []), // 마지막으로 받은 일정 (로그인 만료 중에도 보이게)
  range: null,
  tasks: store.get('st.tasks', []),
  todoFilter: 'all',
  showDone: false,
  loading: false,
  hist: store.get('st.hist', {}),
  team: store.get('st.team', null),
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
          return p?.reject(new Error('캘린더·할 일·앱 데이터 권한을 모두 허용해야 합니다.'));
        }
        token = { v: r.access_token, exp: Date.now() + (r.expires_in - 30) * 1000 };
        if (store.get('st.gmail')) store.set('st.gmailOk', google.accounts.oauth2.hasGrantedAllScopes(r, GMAIL_SCOPE));
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
    tokenClient.requestAccessToken({ prompt, hint: store.get('st.email') || undefined, scope: store.get('st.gmail') ? `${SCOPES} ${GMAIL_SCOPE}` : SCOPES });
  });
}

function signOut() {
  if (token?.v && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token.v, () => {});
  token = null;
  store.set('st.token', null);
  showGate();
}

/* 로그인 만료: 전체 화면으로 막지 않고 저장된 내용을 보여 주며, 화면을 처음 누를 때 조용히 다시 확인 */
function needAuth() {
  if (!store.get('st.signedOnce') || !clientId()) return showGate();
  if (S.needAuth) return;
  S.needAuth = true;
  renderAuthBar();
  const once = () => {
    document.removeEventListener('pointerup', once, true);
    reauth();
  };
  document.addEventListener('pointerup', once, true);
}
async function reauth() {
  if (S.reauthing) return;
  S.reauthing = true;
  try {
    await signIn('');
    S.needAuth = false;
    renderAuthBar();
    S.lastRefresh = Date.now();
    await refreshAll();
  } catch {
    renderAuthBar(true);
  } finally {
    S.reauthing = false;
  }
}
function renderAuthBar(failed) {
  let b = $('#authBar');
  if (!b) {
    b = document.createElement('button');
    b.id = 'authBar';
    b.type = 'button';
    b.className = 'auth-bar';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      reauth();
    });
    document.body.appendChild(b);
  }
  b.hidden = !S.needAuth;
  b.classList.toggle('fail', !!failed);
  b.textContent = failed ? 'Google 연결이 끊겼습니다 · 눌러서 다시 연결' : '저장된 내용 보는 중 · 화면을 누르면 최신으로';
}

async function api(base, path, { method = 'GET', body } = {}) {
  if (!tokenOk()) {
    // 버튼을 누른 직후라면 바로 조용히 다시 확인 (이미 허용한 계정이면 창이 잠깐 떴다 닫힘)
    if (store.get('st.signedOnce') && navigator.userActivation?.isActive)
      try {
        await signIn('');
        S.needAuth = false;
        renderAuthBar();
      } catch {
        /* 아래에서 처리 */
      }
    if (!tokenOk()) {
      needAuth();
      throw Object.assign(new Error('Google 연결을 다시 확인해야 합니다.'), { code: 'auth' });
    }
  }
  const r = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token.v}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) {
    token = null;
    store.set('st.token', null);
    needAuth();
    throw Object.assign(new Error('로그인이 만료되었습니다.'), { code: 'auth' });
  }
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if ((r.status === 404 || r.status === 410) && method === 'DELETE') return null;
    const e = j.error || {};
    const why = (e.details || []).find((x) => x.reason)?.reason || e.errors?.[0]?.reason || e.status || null;
    throw Object.assign(new Error(e.message || `오류 (${r.status})`), { status: r.status, why });
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
  maybeOpenShare();
}

/* ───────────── 데이터 불러오기 ───────────── */
// 주간 보기: 월요일 시작
function monthRange() {
  const ws = D.addDays(S.cursor, -((D.dow(S.cursor) + 6) % 7));
  return { from: ws, to: D.addDays(ws, 6) };
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
  const a = D.addDays(from, -21);
  const b = D.addDays(to, 21);
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
  try {
    store.set('st.events', S.events);
  } catch {
    /* 저장 공간 부족 */
  }
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

/* 팀 일정표: PC가 구글 드라이브의 앱 전용 숨김 공간에 올린 데이터를 읽음 (캘린더·Tasks에는 없음) */
async function loadTeam() {
  try {
    const q = new URLSearchParams({ spaces: 'appDataFolder', q: "name='team-schedule.json'", fields: 'files(id,modifiedTime)' });
    let list;
    S.teamErr = null;
    try {
      list = await api(DRIVE, `/files?${q}`);
      S.teamNeedsAuth = false;
    } catch (e) {
      if (e.code === 'auth') return;
      if (e.why === 'SERVICE_DISABLED' || e.why === 'accessNotConfigured')
        S.teamErr = 'Google Drive API가 꺼져 있습니다. Google Cloud 콘솔에서 Google Drive API를 "사용"으로 켜 주세요.';
      else if (e.status === 403 || e.status === 401) S.teamNeedsAuth = true; // 드라이브 권한이 아직 없음
      else S.teamErr = `팀 일정을 불러오지 못했습니다: ${e.message}`;
      return;
    }
    const f = list.files?.[0];
    if (!f) {
      S.teamErr = 'PC에서 보낸 팀 일정이 아직 없습니다. PC 프로그램 설정 → 팀 일정표 → "다시 보내기"를 눌러 주세요.';
      return;
    }
    if (S.team && S.team.modified === f.modifiedTime) return; // 바뀌지 않았으면 다시 받지 않음
    const r = await fetch(`${DRIVE}/files/${encodeURIComponent(f.id)}?alt=media`, { headers: { Authorization: `Bearer ${token.v}` } });
    if (!r.ok) {
      S.teamErr = `팀 일정을 받지 못했습니다 (${r.status}).`;
      return;
    }
    const d = await r.json();
    const dt = (x) => `${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6, 8)}`;
    S.team = {
      modified: f.modifiedTime,
      me: d.me,
      file: d.file,
      asOf: d.asOf,
      from: d.from,
      to: d.to,
      names: d.names,
      entries: d.e.map(([ni, text, a, b, lead]) => ({ name: d.names[ni], text, start: dt(a), end: dt(b), lead: !!lead })),
    };
    store.set('st.team', S.team);
  } catch {
    /* 팀 일정 없음 */
  }
}

async function refreshAll() {
  if (!tokenOk()) return needAuth();
  S.loading = true;
  $('#btnRefresh').classList.add('spin');
  try {
    await loadCalendars();
    await Promise.all([loadEvents(), loadTasks(), loadTeam(), syncKw(), loadMailSum()]);
    scanGmail(); // 기다리지 않음 (끝나면 후보 표시)
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
  const { from, to } = monthRange();
  const today = D.today();
  const hol = holidayMap(from, to);
  const days = Array.from({ length: 7 }, (_, i) => D.addDays(from, i));
  const a = D.parts(from);
  const b = D.parts(to);
  const thu = D.parts(D.addDays(from, 3)); // 목요일이 속한 달 기준 주차
  const wk = Math.ceil(thu.d / 7);
  let html = `<div class="cal-nav">
      <button type="button" class="nav-btn" data-nav="-1" aria-label="이전 주">‹</button>
      <button type="button" class="ym" data-nav="0" title="눌러서 이번 주로">${thu.m}월 ${wk}주<small>${a.m}/${a.d} ~ ${b.m}/${b.d}</small></button>
      <button type="button" class="nav-btn" data-nav="1" aria-label="다음 주">›</button>
    </div>
    ${gmCands().length ? `<button type="button" class="gm-banner" data-gmc>✉ 메일에서 찾은 일정 후보 <b>${gmCands().length}</b>건 ›</button>` : ''}
    <div class="wbox"><div class="hweek" id="weekWrap">`;
  // 머리글: 요일·날짜·음력·휴일 (누르면 그날 새 일정)
  for (const [i, d] of days.entries()) {
    const w = D.dow(d);
    const ho = hol.get(d);
    const l = solarToLunar(d);
    const red = w === 0 || ho?.red;
    html += `<button type="button" class="hd${d === today ? ' today' : ''}${w === 0 || w === 6 ? ' weekend' : ''}" data-day="${d}" style="grid-column:${i + 1};grid-row:1" aria-label="${D.label(d)} 새 일정">
        <span class="dw" style="${red ? 'color:var(--sun)' : w === 6 ? 'color:var(--sat)' : ''}">${D.DOW_KO[w]}</span>
        <span class="dn" style="${red && d !== today ? 'color:var(--sun)' : ''}">${D.parts(d).d}</span>
        <span class="dl">${ho ? `<span style="color:${ho.red ? 'var(--sun)' : 'var(--muted)'}">${h(ho.name)}</span>` : l ? `${l.leap ? '윤' : ''}${l.month}.${l.day}` : ''}</span>
      </button>`;
  }
  // 일정·할 일을 줄(lane)에 배치: 여러 날 일정은 이어진 막대
  const segs = [];
  for (const e of S.events) {
    if (e.holidayCal || e.endDate < from || e.date > to) continue;
    const a = e.date < from ? from : e.date;
    const b = e.endDate > to ? to : e.endDate;
    segs.push({ kind: 'ev', e, i: D.diffDays(from, a), n: D.diffDays(a, b) + 1, cont: e.date < from, more: e.endDate > to });
  }
  for (const t of S.tasks) {
    if (t.parent || t.deleted || !t.due) continue;
    const d = t.due.slice(0, 10);
    if (d < from || d > to) continue;
    segs.push({ kind: 'task', t, i: D.diffDays(from, d), n: 1 });
  }
  const rank = (g) => (g.kind === 'task' ? 3 : g.n > 1 ? 0 : g.e.allDay ? 1 : 2);
  segs.sort((x, y) => rank(x) - rank(y) || y.n - x.n || x.i - y.i || (x.e?.startTime || '').localeCompare(y.e?.startTime || ''));
  const lanes = [];
  for (const g of segs) {
    let L = 0;
    for (; ; L++) {
      lanes[L] ||= Array(7).fill(false);
      let free = true;
      for (let c = g.i; c < g.i + g.n; c++) if (lanes[L][c]) free = false;
      if (free) break;
    }
    for (let c = g.i; c < g.i + g.n; c++) lanes[L][c] = true;
    g.lane = L;
  }
  // 일정 줄은 내용 높이만큼, 남는 세로 공간은 맨 아래 빈 줄이 차지 (일정 사이 간격이 벌어지지 않게)
  html = html.replace('id="weekWrap">', `id="weekWrap" style="grid-template-rows:auto repeat(${lanes.length}, auto) 1fr">`);
  // 요일별 배경 칸(빈 곳을 누르면 그날 새 일정)
  for (const [i, d] of days.entries()) {
    const w = D.dow(d);
    html += `<button type="button" class="hcol${d === today ? ' today' : ''}${w === 0 || w === 6 ? ' weekend' : ''}${i === 6 ? ' last' : ''}" data-day="${d}" style="grid-column:${i + 1};grid-row:2 / span ${lanes.length + 1}" aria-label="${D.label(d)} 새 일정"></button>`;
  }
  for (const g of segs) {
    const pos = `grid-column:${g.i + 1} / span ${g.n};grid-row:${g.lane + 2}`;
    if (g.kind === 'task') {
      html += `<button type="button" class="hev t${g.t.status === 'completed' ? ' done' : ''}" data-task="${h(g.t.id)}" style="${pos}">☐ ${h(g.t.title)}</button>`;
      continue;
    }
    const e = g.e;
    const tm = !e.allDay && e.startTime ? `<b>${h(e.startTime)}</b> ` : '';
    html += `<button type="button" class="hev${e.lunarSeries ? ' l' : ''}${g.n > 1 ? ' bar' : ''}${g.cont ? ' cont' : ''}${g.more ? ' more' : ''}" data-ev="${h(e.key)}" style="${pos}">${tm}${h(e.title)}</button>`;
  }
  html += '</div></div>';
  // 선택한 주의 일정 목록(자세히): 장소·참여 인원 — 높이 고정, 안에서 스크롤
  // 장소·참여 인원이 있는 일정 + 오늘 일정은 모두
  const isToday = (e) => e.date <= today && e.endDate >= today;
  const detail = segs
    .filter((g) => g.kind === 'ev' && (g.e.place || g.e.people?.length || isToday(g.e)))
    .sort((x, y) => x.e.date.localeCompare(y.e.date) || (x.e.allDay ? 0 : 1) - (y.e.allDay ? 0 : 1) || (x.e.startTime || '').localeCompare(y.e.startTime || ''));
  html += `<div class="wdetail"><div class="wdh"><b>일정 상세</b><span class="xs muted">${detail.length ? `${detail.length}건` : ''}</span></div>
    <div class="wdl">`;
  if (!detail.length) html += '<div class="empty small">이 주에는 오늘 일정이나 장소·참여 인원이 적힌 일정이 없습니다.</div>';
  else {
    html += `${detail
      .map((g) => {
        const e = g.e;
        const when = e.date === e.endDate ? `${D.parts(e.date).m}/${D.parts(e.date).d}` : `${D.parts(e.date).m}/${D.parts(e.date).d}~${D.parts(e.endDate).m}/${D.parts(e.endDate).d}`;
        const tm = !e.allDay && e.startTime ? `<small>${h(e.startTime)}${e.endTime ? `~${h(e.endTime)}` : ''}</small>` : '';
        return `<button type="button" class="wd${isToday(e) ? ' today' : ''}" data-ev="${h(e.key)}"><span class="wdw">${when}${tm}</span><span class="wdt">${h(e.title)}</span>${e.place ? `<span class="wdm">📍 ${h(e.place)}</span>` : ''}${e.people?.length ? `<span class="wdm">👥 ${h(e.people.join(', '))}</span>` : ''}</button>`;
      })
      .join('')}`;
  }
  html += '</div></div>';
  const sp = D.parts(S.sel || today);
  html += `<form class="quick" id="quickEvForm"><label for="quickEv" class="sr">새 일정</label>
      <input id="quickEv" enterkeyhint="done" autocomplete="off" placeholder="${sp.m}/${sp.d} 일정 입력 (예: 3시 세운철강 미팅)"></form>`;
  v.innerHTML = html;
}

/* ───────────── 화면: 팀 일정 (주 단위) ───────────── */
function renderTeam() {
  const { from, to } = monthRange();
  const days = Array.from({ length: 7 }, (_, i) => D.addDays(from, i));
  const a = D.parts(from);
  const b = D.parts(to);
  const thu = D.parts(D.addDays(from, 3));
  $('#viewTeam').innerHTML = `<div class="cal-nav">
      <button type="button" class="nav-btn" data-nav="-1" aria-label="이전 주">‹</button>
      <button type="button" class="ym" data-nav="0" title="눌러서 이번 주로">${thu.m}월 ${Math.ceil(thu.d / 7)}주<small>${a.m}/${a.d} ~ ${b.m}/${b.d}</small></button>
      <button type="button" class="nav-btn" data-nav="1" aria-label="다음 주">›</button>
    </div>${renderTeamWeek(days)}`;
}

/* 팀 일정 (같은 일정은 한 막대, 인차지 짙은 색, 엑셀 순서, 나는 강조) */
function renderTeamWeek(days) {
  const t = S.team;
  let html = '<div class="team"><div class="team-h"><b>팀 일정</b>';
  if (S.teamNeedsAuth && !t)
    return `${html}</div><div class="empty small">팀 일정을 보려면 권한을 한 번 더 허용해 주세요.<br><button type="button" class="btn primary" data-reauth style="margin-top:10px">권한 허용</button></div></div>`;
  if (!t) return `${html}</div><div class="empty small">${h(S.teamErr || 'PC 프로그램에서 팀 일정표를 가져오면 여기에 표시됩니다.')}</div></div>`;
  html += `<span class="xs muted">${t.asOf ? `${D.parts(t.asOf).m}/${D.parts(t.asOf).d} 현재` : ''}</span></div>`;
  if (S.teamErr) html += `<div class="note" style="color:var(--sun);padding:0 4px 6px">${h(S.teamErr)}</div>`;
  const wd = days.slice(0, 5);
  const ws = wd[0];
  const we = wd[4];
  if (we < t.from || ws > t.to) return `${html}<div class="empty small">이 주는 팀 일정표 기간 밖입니다.</div></div>`;
  const names = t.names; // 엑셀 팀 일정표 순서 그대로 (나는 강조 표시)
  html += `<table class="tw"><colgroup><col style="width:52px">${wd.map(() => '<col>').join('')}</colgroup>
    <thead><tr><th></th>${wd.map((d) => `<th class="${d === D.today() ? 'tod' : ''}">${D.DOW_KO[D.dow(d)]} ${D.parts(d).d}</th>`).join('')}</tr></thead><tbody>`;
  for (const n of names) {
    const segs = t.entries
      .filter((e) => e.name === n && e.end >= ws && e.start <= we)
      .map((e) => {
        const a = e.start < ws ? ws : e.start;
        const b = e.end > we ? we : e.end;
        return { e, i: D.diffDays(ws, a), n: D.diffDays(a, b) + 1 };
      })
      .sort((x, y) => x.i - y.i || y.n - x.n);
    let row = '';
    let i = 0;
    for (const g of segs) {
      if (g.i < i) continue;
      while (i < g.i) {
        row += '<td></td>';
        i++;
      }
      const stack = segs.filter((o) => o !== g && o.i >= g.i && o.i < g.i + g.n);
      const chip = (x) => `<span class="tc${x.e.lead ? ' lead' : ''}">${h(x.e.text)}</span>`;
      row += `<td colspan="${g.n}">${chip(g)}${stack.map(chip).join('')}</td>`;
      i = g.i + g.n;
    }
    while (i < 5) {
      row += '<td></td>';
      i++;
    }
    html += `<tr class="${n === t.me ? 'me' : ''}"><th>${h(n)}${n === t.me ? '<small>나</small>' : ''}</th>${row}</tr>`;
  }
  html += `</tbody></table></div>`;
  return html;
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

/* ───────────── 메일·문자·통화 요약 (PC가 드라이브 앱 전용 공간에 올린 것) ───────────── */
async function loadMailSum() {
  try {
    const d = await driveRead('mail-summary.json');
    if (d?.items) {
      S.mailSum = { asOf: d.asOf, items: d.items };
      store.set('st.mailsum', S.mailSum);
    }
  } catch {
    /* 오프라인·권한 없음 */
  }
}
const mailOpen = () => (S.mailSum?.items || []).filter((x) => !S.mailDone[x.id]);
function renderMailBadge() {
  const b = $('#mailBadge');
  if (!b) return;
  const n = mailOpen().filter((x) => x.cat === 'request' || x.cat === 'due').length;
  b.hidden = !n;
  b.textContent = n > 99 ? '99+' : n;
}
async function markMailDone(id) {
  S.mailDone[id] = Date.now();
  for (const [k, t] of Object.entries(S.mailDone)) if (t < Date.now() - 60 * 864e5) delete S.mailDone[k];
  store.set('st.maildone', S.mailDone);
  render();
  try {
    // PC가 읽어 가서 PC에서도 완료 처리
    const remote = (await driveRead('mail-done.json')) || {};
    await driveWrite('mail-done.json', { ...remote, ...S.mailDone });
  } catch {
    /* 다음에 다시 */
  }
}
const SRC_ICO = {
  mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 7l8 6 8-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  sms: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5z" fill="currentColor"/></svg>',
  call: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 3.5l2.6.4 1.4 4.1-1.9 1.6a12 12 0 0 0 5.7 5.7l1.6-1.9 4.1 1.4.4 2.6c-.2 1.5-1.6 2.6-3.1 2.5C10 19.4 4.6 14 4.1 6.6 4 5.1 5.1 3.7 6.6 3.5z" fill="currentColor"/></svg>',
};
const CAT_L = { request: '요청', due: '기한', info: '참고' };
function renderMail() {
  const v = $('#viewMail');
  const items = mailOpen();
  if (!S.mailSum) {
    v.innerHTML = '<div class="empty">PC 프로그램의 메일·문자 요약이 아직 없습니다.<br>PC에서 구글 연동(드라이브 권한)이 켜져 있으면 자동으로 보내집니다.</div>';
    return;
  }
  const day = (d) => {
    const t = D.today();
    if (d === t) return '오늘';
    if (d === D.addDays(t, -1)) return '어제';
    const [, m, dd] = d.split('-');
    return `${+m}월 ${+dd}일`;
  };
  let html = `<div class="ms-head small">완료하지 않은 것 ${items.length}건 · PC 기준 ${h((S.mailSum.asOf || '').slice(5, 16).replace('-', '/').replace('T', ' '))}</div>`;
  let last = '';
  for (const x of items) {
    const d = x.at.slice(0, 10);
    if (d !== last) {
      html += `<div class="grp">${day(d)}</div>`;
      last = d;
    }
    const dues = (x.dues || [])
      .map(
        (u, i) => `<div class="ms-due"><span class="dt">${h(`${+u.date.slice(5, 7)}/${+u.date.slice(8)}`)}${u.start ? ` ${h(u.start)}` : ''}</span><span class="tx">${h(u.text || u.place || '')}</span>
          <button type="button" class="btn sm" data-mtodo="${h(x.id)}" data-i="${i}">할 일로</button><button type="button" class="btn sm primary" data-mev="${h(x.id)}" data-i="${i}">일정으로</button></div>`
      )
      .join('');
    html += `<article class="ms-card" data-src="${x.src}">
      <div class="ms-r1"><i class="ms-ico">${SRC_ICO[x.src] || ''}</i><b>${h(x.from)}</b>${x.more ? `<span class="ms-more">+${x.more}</span>` : ''}${x.co ? `<span class="ms-co">${h(x.co)}</span>` : ''}<span class="ms-t">${h(x.at.slice(11, 16))}</span></div>
      <div class="ms-title"><span class="ms-cat c-${x.cat}">${CAT_L[x.cat] || '참고'}</span>${h(x.title)}${x.ai ? '<span class="ms-ai">AI</span>' : ''}</div>
      ${x.gist && x.gist !== x.title ? `<div class="ms-gist">${h(x.gist)}</div>` : ''}
      ${x.req?.length ? `<ul class="ms-req">${x.req.map((r) => `<li>${h(r)}</li>`).join('')}</ul>` : ''}
      ${dues}
      <div class="ms-foot"><button type="button" class="btn sm" data-mdone="${h(x.id)}">✓ 완료</button></div>
    </article>`;
  }
  if (!items.length) html += '<div class="empty">완료하지 않은 메일·문자·통화가 없습니다.</div>';
  v.innerHTML = html;
}

function render() {
  $('#viewCal').hidden = S.tab !== 'cal';
  $('#viewTodo').hidden = S.tab !== 'todo';
  $('#viewMail').hidden = S.tab !== 'mail';
  $('#viewTeam').hidden = S.tab !== 'team';
  renderMailBadge();
  $$('.tabbar button').forEach((b) => {
    const on = b.dataset.tab === S.tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on);
  });
  $('#topTitle').textContent = { cal: '일정', todo: '할 일', mail: '메일·문자·통화', team: '팀 일정' }[S.tab];
  if (S.tab === 'cal') renderCal();
  else if (S.tab === 'todo') renderTodo();
  else if (S.tab === 'team') renderTeam();
  else renderMail();
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

function openEvent(e = null, date = S.sel, preset = null, onSaved = null) {
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
  if (preset && !e) {
    Object.assign(f, preset);
    if (!f.startTime) f.startTime = '09:00';
    if (!f.endTime) f.endTime = autoEnd(f.startTime);
    if (preset.place) auto.placeTouched = true;
  }
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
      ${!e && !preset ? '<div class="paste-row"><button type="button" class="paste-btn" data-paste>📋 붙여넣어 채우기</button><button type="button" class="paste-btn" data-gmail>✉ Gmail에서 가져오기</button></div>' : ''}
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
      <div class="fld"><label class="lbl" for="e-place">장소</label><div class="inrow"><input class="inp" id="e-place" value="${h(f.place)}" placeholder="장소 또는 주소" ${readonly ? 'disabled' : ''}><button type="button" class="mini-btn copy" data-copyplace aria-label="장소 복사">복사</button></div></div>
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
              <div class="fld"><label class="lbl" for="e-st">시작</label><button type="button" class="inp timebtn" id="e-st" data-wheel="st" ${readonly || recurring ? 'disabled' : ''}>${f.startTime}</button></div>
              <div class="fld"><label class="lbl" for="e-et">종료</label><button type="button" class="inp timebtn" id="e-et" data-wheel="et" ${readonly || recurring ? 'disabled' : ''}>${f.endTime}</button></div>
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
    else if (id === 'e-st') {
      f.startTime = ev.target.value;
      autoEndTime(f, body, f.startTime);
    }
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
    if (ev.target.closest('[data-paste]')) {
      close();
      setTimeout(openPasteSheet, 300);
      return;
    }
    if (ev.target.closest('[data-gmail]')) {
      close();
      setTimeout(openGmailPicker, 300);
      return;
    }
    const wb = ev.target.closest('[data-wheel]');
    if (wb && !wb.disabled) {
      const isStart = wb.dataset.wheel === 'st';
      return openTimeWheel(isStart ? '시작 시간' : '종료 시간', isStart ? f.startTime : f.endTime, (v) => {
        if (isStart) {
          f.startTime = v;
          wb.textContent = v;
          autoEndTime(f, body, v);
        } else {
          f.endTime = v;
          wb.textContent = v;
        }
      });
    }
    if (ev.target.closest('[data-copyplace]')) {
      const v = ($('#e-place', body)?.value || f.place || '').trim();
      return copyText(v, '장소를 복사했습니다.');
    }
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
      else {
        await createEvent(f);
        learnWords(f.title); // 직접 추가한 일정의 핵심 단어 배우기
      }
      onSaved?.();
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

function openTask(t = null, preset = null, onSaved = null) {
  const kids = t ? S.tasks.filter((k) => k.parent === t.id && !k.deleted).sort((a, b) => String(a.position).localeCompare(String(b.position))) : [];
  const f = {
    title: t?.title || '',
    hasDue: !!t?.due,
    due: t?.due ? t.due.slice(0, 10) : D.today(),
    notes: t?.notes || '',
    subs: kids.map((k) => ({ id: k.id, title: k.title || '', done: k.status === 'completed' })),
  };
  if (preset && !t) Object.assign(f, preset);
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
      if (!t) learnWords(f.title);
      onSaved?.();
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
      <div class="sect"><h3>Gmail 일정 찾기</h3>
        ${
          store.get('st.gmailOk')
            ? `<div class="small">연결됨 · 앱을 열거나 새로고침할 때 최근 7일 받은 메일(첨부 포함)에서 일정 후보를 찾습니다.</div>
               <div class="row2"><button type="button" class="btn" data-gmpick2>메일에서 가져오기</button><button type="button" class="btn danger" data-gmoff>연결 끊기</button></div>`
            : '<button type="button" class="btn primary" data-gmcon>Gmail 연결</button><div class="note">메일은 이 휴대폰 안에서만 읽습니다 (읽기 전용).</div>'
        }</div>
      <div class="sect"><h3>내 일정 단어</h3>
        <div class="note">직접 저장한 일정·할 일 제목에서 배운 단어입니다. 이 단어가 들어간 메일은 일정 후보로 찾습니다. 후보를 [무시]하면 점수가 깎이고 0점이면 빠집니다. PC와 함께 씁니다.</div>
        <div class="kw-list">${
          Object.entries(KW.w || {})
            .filter(([, v]) => v.s > 0)
            .sort((a, b) => b[1].s - a[1].s)
            .map(([w, v]) => `<span class="kw">${h(w)} <small>${+v.s.toFixed(1)}</small><button type="button" data-kwdel="${h(w)}" aria-label="${h(w)} 지우기">×</button></span>`)
            .join('') || '<span class="xs muted">아직 배운 단어가 없습니다.</span>'
        }</div>
        <div class="gm-search"><input class="inp" id="kw-new" placeholder="단어 직접 추가 (예: 조서열람)"><button type="button" class="btn" data-kwadd>추가</button></div>
        <details class="kw-base"><summary class="small">기본 단어 켜기/끄기</summary><div class="kw-list">${BASE_KEYS.map(
          ([l]) => `<button type="button" class="kw b ${KW.off?.[l]?.v ? 'off' : ''}" data-kwoff="${h(l)}">${h(l)}</button>`
        ).join('')}</div></details></div>
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
      const kd = ev.target.closest('[data-kwdel]');
      const ko = ev.target.closest('[data-kwoff]');
      if (kd) {
        KW.w[kd.dataset.kwdel] = { s: 0, t: Date.now() };
        saveKw();
        await draw();
      } else if (ev.target.closest('[data-kwadd]')) {
        const w = $('#kw-new', body).value.trim().replace(/\s+/g, ' ');
        if (w.length < 2) return toast('두 글자 이상 입력하세요.');
        KW.w[w] = { s: Math.max(2, KW.w[w]?.s || 0), t: Date.now() };
        saveKw();
        await draw();
      } else if (ko) {
        KW.off ||= {};
        const l = ko.dataset.kwoff;
        KW.off[l] = { v: !KW.off[l]?.v, t: Date.now() };
        saveKw();
        await draw();
        $('.kw-base', body).open = true;
      } else if (ev.target.closest('[data-gmcon]')) {
        openGmailConnect(() => draw());
      } else if (ev.target.closest('[data-gmpick2]')) {
        openGmailPicker();
      } else if (ev.target.closest('[data-gmoff]')) {
        store.set('st.gmail', false);
        store.set('st.gmailOk', false);
        GM.cands = [];
        gmSave();
        await draw();
        render();
        toast('Gmail 연결을 끊었습니다. 다음 로그인부터 Gmail 권한을 요청하지 않습니다.');
      } else if (ev.target.closest('[data-signout]')) {
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

/** 아래 메뉴 이동 (밀어서 넘길 때 살짝 움직이는 효과) */
function goTab(t, dir) {
  if (!t || t === S.tab) return;
  S.tab = t;
  history.replaceState(history.state, '', t === 'cal' ? '#' : `#${t}`);
  render();
  window.scrollTo(0, 0);
  if (dir) {
    const v = $(`#view${t[0].toUpperCase()}${t.slice(1)}`);
    v.classList.remove('slide-left', 'slide-right');
    void v.offsetWidth;
    v.classList.add(`slide-${dir}`);
  }
}

/* ───────────── 이벤트 연결 ───────────── */
function bind() {
  $('.tabbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    goTab(b.dataset.tab);
  });
  // 좌우로 밀면 아래 메뉴 순서대로 이동 (달력의 주간 칸·가로로 스크롤되는 곳은 제외)
  let tx = null;
  let ty = null;
  let tt = 0;
  document.addEventListener('touchstart', (e) => {
    tx = null;
    if (e.touches.length !== 1 || e.target.closest('.tabbar, header.top, #sheetRoot, #gate, #weekWrap, .cal-nav, .chips, input, textarea, select')) return;
    let n = e.target;
    while (n && n !== document.body) {
      if (n.scrollWidth > n.clientWidth + 4 && /auto|scroll/.test(getComputedStyle(n).overflowX)) return;
      n = n.parentElement;
    }
    tx = e.touches[0].clientX;
    ty = e.touches[0].clientY;
    tt = Date.now();
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (tx === null || $('#sheetRoot').childElementCount) return;
    const dx = e.changedTouches[0].clientX - tx;
    const dy = e.changedTouches[0].clientY - ty;
    tx = null;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.8 || Date.now() - tt > 800) return;
    // 일정 → 할 일 → 메일·문자·통화 → 팀 일정 → (다시) 일정
    const order = ['cal', 'todo', 'mail', 'team'];
    const i = (order.indexOf(S.tab) + (dx < 0 ? 1 : -1) + order.length) % order.length;
    goTab(order[i], dx < 0 ? 'left' : 'right');
  }, { passive: true });
  $('#viewTeam').addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) return move(+nav.dataset.nav);
    if (e.target.closest('[data-reauth]'))
      return signIn('consent')
        .then(() => loadTeam())
        .then(render)
        .catch((er) => toast(er.message));
  });
  // 일정 빠른 입력: 글에서 날짜·시간·장소를 찾고, 날짜가 없으면 선택한 날
  $('#viewCal').addEventListener('submit', async (e) => {
    if (e.target.id !== 'quickEvForm') return;
    e.preventDefault();
    const inp = $('#quickEv');
    const t = inp.value.trim();
    if (!t) return;
    const r = parseShared(t, D.today(), nowStamp());
    const date = r.found ? r.date : S.sel || D.today();
    const writable = S.calendars.filter((c) => c.writable);
    const defCal = store.get('st.defCal');
    const calendarId = writable.some((c) => c.id === defCal) ? defCal : writable.find((c) => c.primary)?.id || writable[0]?.id;
    if (!calendarId) return toast('쓸 수 있는 캘린더가 없습니다.');
    const f = {
      title: r.title || t,
      date,
      endDate: r.found ? r.endDate || date : date,
      allDay: !r.startTime,
      startTime: r.startTime || '09:00',
      endTime: r.endTime || autoEnd(r.startTime || '09:00'),
      place: r.place || '',
      people: [],
      memo: '',
      repeat: 'none',
      calType: 'solar',
      alarm: '',
      calendarId,
    };
    inp.value = '';
    inp.disabled = true;
    try {
      await createEvent(f);
      learnWords(f.title);
      toast(`${D.parts(date).m}/${D.parts(date).d}${f.allDay ? '' : ` ${f.startTime}`} 「${f.title}」 추가했습니다.`);
      await loadEvents();
      render();
    } catch (er) {
      inp.value = t;
      toast(`추가 실패: ${er.message}`);
    } finally {
      const i2 = $('#quickEv');
      if (i2) i2.disabled = false;
    }
  });
  // 메일·문자 카드
  $('#viewMail').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mdone],[data-mev],[data-mtodo]');
    if (!b) return;
    const id = b.dataset.mdone || b.dataset.mev || b.dataset.mtodo;
    const x = (S.mailSum?.items || []).find((y) => y.id === id);
    if (!x) return;
    if (b.dataset.mdone) {
      markMailDone(id);
      return toast('완료했습니다. PC에도 반영됩니다.');
    }
    const u = x.dues?.[+b.dataset.i];
    if (!u) return;
    const memo = `${{ mail: '메일', sms: '문자', call: '통화' }[x.src]}: ${x.title}\n${x.src === 'call' ? '통화 상대' : '보낸 사람'}: ${x.from}${x.co ? ` (${x.co})` : ''}\n${x.gist || ''}`.slice(0, 1500);
    if (b.dataset.mev) openEvent(null, u.date, { title: x.title, date: u.date, endDate: u.endDate || u.date, allDay: !!u.allDay, startTime: u.start, endTime: u.end || (u.start ? autoEnd(u.start) : null), place: u.place || '', memo });
    else openTask(null, { title: x.title, hasDue: true, due: u.date, notes: memo });
  });
  $('#btnRefresh').addEventListener('click', refreshAll);
  $('#btnSettings').addEventListener('click', openSettings);

  const move = async (n) => {
    S.cursor = n === 0 ? D.today() : D.addDays(S.cursor, 7 * n);
    S.sel = S.cursor;
    render();
    await ensureMonthLoaded();
  };
  $('#viewCal').addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) return move(+nav.dataset.nav);
    if (e.target.closest('[data-reauth]')) {
      return signIn('consent')
        .then(() => loadTeam())
        .then(render)
        .catch((er) => toast(er.message));
    }
    if (e.target.closest('[data-gmc]')) return openGmailCands();
    const day = e.target.closest('[data-day]');
    if (day) {
      S.sel = day.dataset.day;
      return openEvent(null, S.sel); // 날짜를 누르면 그날 새 일정
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
    if (!e.target.closest('#weekWrap, .cal-nav')) return;
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
    // 빈 곳을 누르면 아래 입력란으로
    if (!e.target.closest('[data-task],[data-toggle],button,a,input,form,.chips')) return $('#quick')?.focus();
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

/* ───────────── 공유로 받은 글 → 새 일정 ───────────── */
function autoEnd(t) {
  const [hh, mm] = String(t || '09:00').split(':').map(Number);
  const v = Math.min(hh * 60 + mm + 60, 23 * 60 + 59);
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}
function nowStamp() {
  const d = new Date();
  return `${D.today()}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** 글에서 날짜·시간·장소를 찾아 새 일정 창을 연다 */
function openEventFromText(text) {
  const r = parseShared(text, D.today(), nowStamp());
  const { found, ...preset } = r;
  openEvent(null, preset.date, preset);
  toast(found ? '글에서 찾은 날짜·시간을 채웠습니다. 확인 후 저장하세요.' : '날짜를 찾지 못해 오늘로 채웠습니다. 날짜를 골라 주세요.');
}
(() => {
  const sp = new URLSearchParams(location.search);
  const shared = [sp.get('title'), sp.get('text'), sp.get('url')].filter(Boolean).join('\n').trim();
  if (shared) S.pendingShare = { text: shared, files: [] };
  if (sp.get('shared') === '1') S.pendingShare = { fromSw: true };
  if (sp.get('shared') === '0') S.shareFailed = true;
  if (shared || sp.has('shared')) history.replaceState(null, '', location.pathname);
})();
/** 서비스 워커가 보관한 공유 내용 꺼내기 */
async function readSwShare() {
  try {
    const c = await caches.open('st-share');
    const mr = await c.match('./__share__/meta');
    if (!mr) return null;
    const meta = await mr.json();
    const files = [];
    for (const f of meta.files || []) {
      const r = await c.match(f.key);
      if (r) files.push(new File([await r.blob()], f.name || 'image', { type: f.type }));
    }
    for (const k of await c.keys()) await c.delete(k);
    const text = [meta.title, meta.text, meta.url].filter(Boolean).join('\n').trim();
    return { text, files };
  } catch {
    return null;
  }
}
async function maybeOpenShare() {
  if (S.shareFailed) {
    S.shareFailed = false;
    toast('공유 받은 내용을 읽지 못했습니다. 다시 공유해 주세요.');
  }
  let p = S.pendingShare;
  S.pendingShare = null;
  if (!p) return;
  if (p.fromSw) p = await readSwShare();
  if (!p || (!p.text && !p.files?.length)) return;
  if (S.tab !== 'cal') {
    S.tab = 'cal';
    render();
  }
  openShareChooser(p.text || '', p.files || []);
}

/* 이미지 글자 읽기 (휴대폰 안에서 처리, 처음 한 번 약 8MB 내려받음) */
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('글자 인식 도구를 불러오지 못했습니다.'));
    document.head.appendChild(s);
  });
}
async function ocrImage(file, onProgress) {
  if (!window.Tesseract) await loadScript('./vendor/ocr/tesseract.min.js');
  const base = new URL('./vendor/ocr/', location.href).href;
  const worker = await window.Tesseract.createWorker(['kor', 'eng'], 1, {
    workerPath: `${base}worker.min.js`,
    corePath: base,
    langPath: base,
    logger: (m) => onProgress?.(m),
  });
  try {
    const { data } = await worker.recognize(file);
    return cleanOcr(data.text || '');
  } finally {
    worker.terminate();
  }
}
// 한글 글자 사이에 끼는 불필요한 띄어쓰기 정리
function cleanOcr(t) {
  return t
    .replace(/([가-힣])\s(?=[가-힣]\s[가-힣])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 공유 받은 내용 → 일정 또는 할 일 고르기 */
function openShareChooser(text, files, opts = {}) {
  const imgs = files.filter((f) => /^image\//.test(f.type));
  const { el, body, close } = openSheet(
    opts.heading || '공유 받은 내용',
    `${opts.title !== undefined ? `<div class="small muted" style="margin-bottom:8px">${h(opts.sub || '')}</div><div class="fld"><label class="lbl" for="sh-title">제목</label><input class="inp" id="sh-title" value="${h(opts.title)}"></div>` : ''}${imgs.length ? `<div class="sh-imgs">${imgs.map((_, i) => `<img data-i="${i}" alt="공유 받은 이미지">`).join('')}</div>` : ''}
     <div class="note" id="sh-ocr" ${imgs.length ? '' : 'hidden'}>이미지에서 글자를 읽는 중…</div>
     <div class="fld"><label class="lbl" for="sh-t">내용 (고칠 수 있어요)</label><textarea class="inp" id="sh-t" rows="6">${h(text)}</textarea></div>
     <div class="sh-found" id="sh-found"></div>`,
    `<button type="button" class="btn" data-mk="todo" style="flex:1">할 일로</button><button type="button" class="btn primary" data-mk="event" style="flex:1.4">일정으로</button>`
  );
  const ta = $('#sh-t', body);
  const found = $('#sh-found', body);
  const show = () => {
    const r = parseShared(ta.value, D.today(), nowStamp());
    const d = (x) => `${+x.slice(5, 7)}/${+x.slice(8, 10)}(${'일월화수목금토'[D.dow(x)]})`;
    found.innerHTML = ta.value.trim()
      ? r.found
        ? `<b>찾은 내용</b> ${h(d(r.date))}${r.endDate !== r.date ? ` ~ ${h(d(r.endDate))}` : ''}${r.startTime ? ` ${h(r.startTime)}${r.endTime ? `~${h(r.endTime)}` : ''}` : ' 종일'}${r.place ? ` · ${h(r.place)}` : ''}${opts.title === undefined ? `<br><span class="muted">제목: ${h(r.title)}</span>` : ''}`
        : '<span class="muted">날짜를 찾지 못했습니다. 다음 화면에서 직접 고르세요.</span>'
      : '';
  };
  ta.addEventListener('input', show);
  show();
  imgs.forEach((f, i) => {
    const im = $(`img[data-i="${i}"]`, body);
    if (im) im.src = URL.createObjectURL(f);
  });
  if (imgs.length) {
    const st = $('#sh-ocr', body);
    (async () => {
      const out = [];
      for (const [i, f] of imgs.entries()) {
        try {
          out.push(
            await ocrImage(f, (m) => {
              if (!st.isConnected) return;
              const pct = Math.round((m.progress || 0) * 100);
              st.textContent =
                m.status === 'recognizing text'
                  ? `이미지${imgs.length > 1 ? ` ${i + 1}` : ''}에서 글자를 읽는 중… ${pct}%`
                  : '글자 인식 준비 중… (처음 한 번은 1분 정도 걸릴 수 있어요)';
            })
          );
        } catch (e) {
          st.textContent = e.message || '이미지에서 글자를 읽지 못했습니다.';
          return;
        }
      }
      if (!ta.isConnected) return;
      const got = out.filter(Boolean).join('\n\n');
      ta.value = [ta.value.trim(), got].filter(Boolean).join('\n\n');
      st.textContent = got ? '이미지에서 읽은 글자를 넣었습니다. 틀린 글자는 고쳐 주세요.' : '이미지에서 글자를 찾지 못했습니다.';
      show();
    })();
  }
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mk]');
    if (!b) return;
    const t = ta.value.trim();
    if (!t) return toast('내용이 없습니다.');
    const r = parseShared(t, D.today(), nowStamp());
    if (opts.title !== undefined) r.title = $('#sh-title', body).value.trim() || r.title;
    if (opts.memoHead) r.memo = `${opts.memoHead}\n${r.memo}`.slice(0, 1500);
    close();
    setTimeout(() => {
      if (b.dataset.mk === 'event') {
        const { found: ok, ...preset } = r;
        openEvent(null, preset.date, preset, opts.onSaved);
      } else {
        S.tab = 'todo';
        render();
        openTask(null, { title: r.title, hasDue: r.found, due: r.date, notes: r.memo }, opts.onSaved);
      }
    }, 300);
  });
}

/** 붙여넣기로 일정 만들기 */
function openPasteSheet() {
  const { el, body, close } = openSheet(
    '붙여넣어 일정 만들기',
    `<div class="fld"><label class="lbl" for="paste-t">카톡·문자·통화 요약 등의 내용</label>
       <textarea class="inp" id="paste-t" rows="7" placeholder="여기에 길게 눌러 붙여넣기"></textarea></div>
     <div class="note" style="margin-top:8px">날짜·시간·장소를 찾아 새 일정 창에 채웁니다. 내용은 휴대폰 안에서만 처리합니다.</div>`,
    `<button type="button" class="btn primary" data-pgo style="flex:1">일정 만들기</button>`
  );
  setTimeout(() => $('#paste-t', body)?.focus(), 250);
  el.addEventListener('click', (e) => {
    if (!e.target.closest('[data-pgo]')) return;
    const t = $('#paste-t', body).value.trim();
    if (!t) return toast('붙여넣은 내용이 없습니다.');
    close();
    setTimeout(() => openShareChooser(t, []), 300);
  });
}

/* ───────────── 내 일정 단어 (배우기 · PC와 공유) ───────────── */
let KW = store.get('st.kw', { w: {}, off: {} });
setKeywords(keywordsOf(KW));
function saveKw() {
  store.set('st.kw', KW);
  setKeywords(keywordsOf(KW));
  clearTimeout(saveKw.t);
  saveKw.t = setTimeout(() => syncKw(true), 2500);
}
async function driveFile(name) {
  const q = new URLSearchParams({ spaces: 'appDataFolder', q: `name='${name}'`, fields: 'files(id,modifiedTime)' });
  return (await api(DRIVE, `/files?${q}`)).files?.[0] || null;
}
async function driveRead(name) {
  const f = await driveFile(name);
  if (!f) return null;
  const r = await fetch(`${DRIVE}/files/${encodeURIComponent(f.id)}?alt=media`, { headers: { Authorization: `Bearer ${token.v}` } });
  return r.ok ? r.json() : null;
}
async function driveWrite(name, obj) {
  const f = await driveFile(name);
  const body = JSON.stringify(obj);
  const UP = 'https://www.googleapis.com/upload/drive/v3/files';
  if (f) {
    await fetch(`${UP}/${encodeURIComponent(f.id)}?uploadType=media`, { method: 'PATCH', headers: { Authorization: `Bearer ${token.v}`, 'Content-Type': 'application/json' }, body });
    return;
  }
  const b = 'stb' + Date.now();
  const meta = JSON.stringify({ name, parents: ['appDataFolder'], mimeType: 'application/json' });
  await fetch(`${UP}?uploadType=multipart`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.v}`, 'Content-Type': `multipart/related; boundary=${b}` },
    body: `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`,
  });
}
/** 드라이브의 단어 목록과 합치기 (write=true면 합친 결과를 올림) */
async function syncKw(write = false) {
  if (!tokenOk()) return;
  try {
    const remote = await driveRead('keywords.json');
    const merged = mergeKeywords(KW, remote || {});
    const changed = JSON.stringify(merged) !== JSON.stringify(remote || {});
    KW = merged;
    store.set('st.kw', KW);
    setKeywords(keywordsOf(KW));
    if (write || changed) await driveWrite('keywords.json', KW);
  } catch {
    /* 드라이브 권한이 없거나 오프라인이면 이 휴대폰 안에서만 */
  }
}
/** 직접 저장한 일정·할 일 제목에서 핵심 단어 배우기 (회사 이름 제외) */
function learnWords(title) {
  // "세운철강 중간감사"처럼 '회사 + 업무' 형태의 첫 단어는 회사 이름으로 보고 배우지 않음
  const ex = new Set(
    [...Object.keys(S.hist), ...S.events.map((e) => e.title || '')]
      .map((k) => stripCorp(k).split(' '))
      .filter(([, ...rest]) => /감사|실사|검토|평가|자문|실무|결산|컨설팅|용역/.test(rest.join(' ')))
      .map(([w]) => w)
  );
  const ws = extractWords(title, ex);
  if (!ws.length) return;
  scoreWords(KW, ws, +1);
  saveKw();
}
function penalize(words) {
  if (!words?.length) return;
  scoreWords(KW, words, -1);
  saveKw();
}

/* ───────────── Gmail ───────────── */
const gm = gmailClient((p) => api(GMAIL, p));
const GM = { cands: store.get('st.gm.cands', []), seen: store.get('st.gm.seen', {}), done: store.get('st.gm.done', {}) };
const gmSave = () => {
  store.set('st.gm.cands', GM.cands);
  store.set('st.gm.seen', GM.seen);
  store.set('st.gm.done', GM.done);
};
function gmCands() {
  const today = D.today();
  return GM.cands.filter((c) => !GM.done[c.key] && (c.endDate || c.date) >= today);
}
const whenTxt = (c) => {
  const d = (x) => `${+x.slice(5, 7)}/${+x.slice(8, 10)}(${'일월화수목금토'[D.dow(x)]})`;
  return `${d(c.date)}${c.endDate && c.endDate !== c.date ? ` ~ ${d(c.endDate)}` : ''}${c.startTime ? ` ${c.startTime}${c.endTime ? `~${c.endTime}` : ''}` : ''}`;
};
/** Gmail 연결 (읽기 전용 권한 추가) */
async function connectGmail() {
  store.set('st.gmail', true);
  try {
    await signIn('consent');
  } catch (e) {
    store.set('st.gmail', !!store.get('st.gmailOk'));
    throw e;
  }
  if (!store.get('st.gmailOk')) {
    store.set('st.gmail', false);
    throw new Error('Gmail 읽기 권한이 허용되지 않았습니다. 다시 연결하고 Gmail 항목을 체크해 주세요.');
  }
}
let gmScanning = false;
/** 받은 메일(최근 7일)에서 일정 후보 찾기 — 앱을 열거나 새로고침할 때 */
async function scanGmail() {
  if (!store.get('st.gmailOk') || gmScanning || !tokenOk()) return;
  gmScanning = true;
  try {
    const today = D.today();
    const ids = await gm.list('in:inbox newer_than:7d -category:promotions -category:social', 40);
    const now = nowStamp();
    for (const id of ids) {
      if (GM.seen[id]) continue;
      const m = await gm.full(id);
      const cs = mailCandidates(m, today, now).map((c) => ({
        key: `g|${c.key}`,
        title: cleanSubject(m.subject) || '(제목 없음)',
        date: c.date,
        endDate: c.endDate,
        allDay: c.allDay,
        startTime: c.startTime,
        endTime: c.endTime,
        place: c.place,
        snippet: c.snippet,
        att: c.att,
        why: c.why,
        hits: c.hits,
        meeting: c.meeting,
        mailId: id,
        subject: m.subject,
        from: m.from,
        received: m.received,
      }));
      GM.seen[id] = Date.now();
      GM.cands.push(...cs.filter((c) => !GM.done[c.key] && !GM.cands.some((x) => x.key === c.key)));
    }
    // 정리: 지난 후보, 오래된 기록
    const cut = Date.now() - 30 * 864e5;
    for (const [k, t] of Object.entries(GM.seen)) if (t < cut) delete GM.seen[k];
    for (const [k, t] of Object.entries(GM.done)) if (t < Date.now() - 90 * 864e5) delete GM.done[k];
    GM.cands = GM.cands.filter((c) => (c.endDate || c.date) >= today && !GM.done[c.key]);
    gmSave();
    if (S.tab === 'cal') render();
  } catch (e) {
    if (e.status === 403 && !(e.why === 'SERVICE_DISABLED' || e.why === 'accessNotConfigured')) store.set('st.gmailOk', false);
    if (e.status === 403) toast(gmErr(e));
  } finally {
    gmScanning = false;
  }
}
const gmErr = (e) =>
  e.why === 'SERVICE_DISABLED' || e.why === 'accessNotConfigured'
    ? 'Gmail API가 꺼져 있습니다. Google Cloud 콘솔에서 Gmail API를 "사용"으로 켜 주세요. (켠 뒤 몇 분 걸릴 수 있음)'
    : e.status === 403
      ? 'Gmail 읽기 권한이 없습니다. 설정에서 Gmail을 다시 연결해 주세요.'
      : e.message;
/** 메일 본문 + 첨부 글자 */
const mailText = (m) => [m.body || '', ...(m.attText || []).map((a) => `[첨부: ${a.name}]\n${a.text}`)].join('\n\n').trim();
const mailMemo = (m) => `메일: ${m.subject || ''}\n보낸 사람: ${m.from || ''} (${(m.received || '').slice(0, 16).replace('T', ' ')})`;

/** 메일 하나 → 일정/할 일 고르기 */
async function openMailChooser(id, onSaved) {
  toast('메일을 불러오는 중…');
  try {
    const m = await gm.full(id);
    openShareChooser(mailText(m), [], {
      heading: '메일로 일정·할 일',
      title: cleanSubject(m.subject) || '(제목 없음)',
      sub: `${m.from} · ${(m.received || '').slice(5, 16).replace('T', ' ').replace('-', '/')}${m.attText?.length ? ` · 📎 ${m.attText.length}개 읽음` : ''}`,
      memoHead: mailMemo(m),
      onSaved,
    });
  } catch (e) {
    toast(`메일을 불러오지 못했습니다: ${gmErr(e)}`);
  }
}

/** Gmail 연결 안내 화면 */
function openGmailConnect(after) {
  const { el, close } = openSheet(
    'Gmail 연결',
    `<div class="note" style="font-size:14px;line-height:1.6">Gmail의 받은 메일에서 일정을 가져오려면 <b>Gmail 읽기 권한</b>이 필요합니다.<br><br>
      · 메일은 이 휴대폰 안에서만 읽고 어디로도 보내지 않습니다.<br>
      · 읽기 전용이라 메일을 지우거나 보내지 않습니다.<br>
      · 로그인 중 "Google에서 확인하지 않은 앱" 화면이 나오면 <b>고급 → 일정&할일(으)로 이동</b>을 누르고, Gmail 항목을 체크해 주세요.</div>`,
    `<button type="button" class="btn primary" data-gmgo style="flex:1">Gmail 연결</button>`
  );
  el.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-gmgo]')) return;
    try {
      await connectGmail();
      close();
      toast('Gmail을 연결했습니다.');
      scanGmail();
      setTimeout(() => after?.(), 300);
    } catch (er) {
      toast(er.message);
    }
  });
}

/** ✉ Gmail에서 가져오기: 최근 메일 목록·검색 → 고르기 */
function openGmailPicker() {
  if (!store.get('st.gmailOk')) return openGmailConnect(openGmailPicker);
  const { el, body } = openSheet(
    'Gmail에서 가져오기',
    `<div class="gm-search"><input class="inp" id="gm-q" type="search" placeholder="검색 (보낸 사람, 제목, 단어)" enterkeyhint="search"><button type="button" class="btn" data-gms>검색</button></div>
     <div id="gm-list"><div class="note">불러오는 중…</div></div>`,
    ''
  );
  const listEl = $('#gm-list', body);
  const load = async (q) => {
    listEl.innerHTML = '<div class="note">불러오는 중…</div>';
    try {
      const ids = await gm.list(q ? `${q}` : 'in:inbox', 25);
      if (!ids.length) {
        listEl.innerHTML = '<div class="empty small">메일이 없습니다.</div>';
        return;
      }
      const heads = [];
      for (let i = 0; i < ids.length; i += 8) heads.push(...(await Promise.all(ids.slice(i, i + 8).map((id) => gm.head(id).catch(() => null)))));
      const cset = new Set(gmCands().map((c) => c.mailId));
      listEl.innerHTML = heads
        .filter(Boolean)
        .map(
          (m) => `<button type="button" class="gm-row" data-gmid="${h(m.id)}">
            <span class="gm-top"><b class="${m.unread ? 'unread' : ''}">${h(m.from || '')}</b><span class="xs muted">${h((m.received || '').slice(5, 10).replace('-', '/'))}</span></span>
            <span class="gm-sub">${cset.has(m.id) ? '<i class="gm-dot">일정 후보</i>' : ''}${m.hasAtt ? '📎 ' : ''}${h(m.subject || '(제목 없음)')}</span>
            <span class="xs muted gm-snip">${h(m.snippet || '')}</span></button>`
        )
        .join('');
    } catch (e) {
      listEl.innerHTML = `<div class="note warn">${h(gmErr(e))}</div>`;
    }
  };
  load('');
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-gms]')) return load($('#gm-q', body).value.trim());
    const r = e.target.closest('[data-gmid]');
    if (r) openMailChooser(r.dataset.gmid);
  });
  $('#gm-q', body).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      load(e.target.value.trim());
    }
  });
}

/** 메일에서 찾은 일정 후보 목록 */
function openGmailCands() {
  const { el, body } = openSheet('메일 일정 후보', '', `<button type="button" class="btn" data-gmpick style="flex:1">✉ 다른 메일에서 가져오기</button>`);
  const draw = () => {
    const cs = gmCands();
    body.innerHTML = cs.length
      ? cs
          .map(
            (c) => `<div class="gmc">
              <div class="gmc-h"><b>${h(whenTxt(c))}</b>${c.allDay && !c.startTime ? ' <span class="xs muted">종일</span>' : ''}${c.place ? `<span class="xs muted"> · ${h(c.place)}</span>` : ''}</div>
              <div class="gmc-t">${h(c.title)}</div>
              <div class="xs muted">${h(c.from || '')} · ${h((c.received || '').slice(5, 10).replace('-', '/'))}${c.att ? ` · 📎 ${h(c.att)}` : ''}</div>
              ${c.snippet && !c.meeting ? `<div class="gmc-s">${highlightHtml(c.snippet, c.hits, h)}</div>` : ''}
              ${c.why?.length ? `<div class="xs muted">배운 단어로 찾음: ${h(c.why.join(', '))}</div>` : ''}
              <div class="gmc-b"><button type="button" class="btn" data-gmx="${h(c.key)}">무시</button><button type="button" class="btn" data-gmv="${h(c.key)}">메일 보기</button><button type="button" class="btn primary" data-gma="${h(c.key)}">일정 추가</button></div>
            </div>`
          )
          .join('')
      : '<div class="empty small">새 일정 후보가 없습니다.</div>';
  };
  draw();
  const done = (key) => {
    GM.done[key] = Date.now();
    GM.cands = GM.cands.filter((c) => c.key !== key);
    gmSave();
    draw();
    render();
  };
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-gmpick]')) return openGmailPicker();
    const x = e.target.closest('[data-gmx]');
    if (x) {
      const c = GM.cands.find((y) => y.key === x.dataset.gmx);
      penalize(c?.why); // 배운 단어 때문에 잡힌 후보면 그 단어 점수를 나눠 깎음
      return done(x.dataset.gmx);
    }
    const v = e.target.closest('[data-gmv]');
    if (v) {
      const c = GM.cands.find((y) => y.key === v.dataset.gmv);
      return c && openMailChooser(c.mailId, () => done(c.key));
    }
    const a = e.target.closest('[data-gma]');
    if (a) {
      const c = GM.cands.find((y) => y.key === a.dataset.gma);
      if (!c) return;
      openEvent(
        null,
        c.date,
        {
          title: c.title,
          date: c.date,
          endDate: c.endDate || c.date,
          allDay: c.allDay,
          startTime: c.startTime || '09:00',
          endTime: c.endTime || autoEnd(c.startTime || '09:00'),
          place: c.place || '',
          memo: `메일: ${c.subject || ''}\n보낸 사람: ${c.from || ''} (${(c.received || '').slice(0, 16).replace('T', ' ')})${c.snippet && !c.meeting ? `\n${c.snippet}` : ''}`,
        },
        () => done(c.key)
      );
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
  refreshAll().then(maybeOpenShare, maybeOpenShare);
} else needAuth(); // 처음이면 시작 화면, 전에 로그인했으면 저장된 내용 + 위쪽 안내
