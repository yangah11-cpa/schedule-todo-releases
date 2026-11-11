import * as D from './lib/dates.js';
import { solarToLunar, lunarToSolar, LUNAR_MAX_YEAR } from './lib/lunar.js';
import { expandEvent, nextOccurrence, firstOnOrAfter, describeRule, parseQuickAdd, EVENT_REPEAT_LABEL } from './lib/recur.js';
import { getHolidays } from './lib/holidays.js';
import { solarPayload, lunarTargets, lunarPayload, fromGoogle, timeRange, composeDescription } from './lib/gsync.js';
import { parseTeamWorkbook, myEngagements, teamOn, sameClient } from './lib/team.js';
import { summarize, companyOf, domainOf, CAT_LABEL } from './lib/mailsum.js';
import { mailCandidates, stripQuoted, highlightHtml, parseShared, cleanSubject, setKeywords, extractWords, scoreWords, mergeKeywords, keywordsOf, BASE_KEYS } from './lib/mailparse.js';

/* ───────────── 공통 ───────────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const h = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uid = () => crypto.randomUUID();
const REPEAT_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"/></svg>';

const DEFAULT_SETTINGS = {
  showLunar: true,
  showHolidays: true,
  lunarYears: 10,
  calendarVisibility: {},
  defaultCalendar: null,
  pendingDeletes: [],
  pendingTaskDeletes: [],
  teamMe: '양하승',
  tasksSync: true,
  phoneEvents: false,
  lastAlarmCheck: null,
};

const ALARMS_ALLDAY = [
  ['', '알림 없음'],
  ['360', '전날 오후 6시'],
  ['900', '1일 전 오전 9시'],
  ['3780', '3일 전 오전 9시'],
  ['9540', '7일 전 오전 9시'],
];
const ALARMS_TIMED = [
  ['', '알림 없음'],
  ['0', '시작 시각'],
  ['10', '10분 전'],
  ['30', '30분 전'],
  ['60', '1시간 전'],
  ['1440', '1일 전'],
];

// 할 일 알림 (이 컴퓨터에서만 알림)
const TODO_ALARMS_TIMED = [
  ['', '알림 없음'],
  ['0', '정시'],
  ['10', '10분 전'],
  ['30', '30분 전'],
  ['60', '1시간 전'],
  ['1440', '1일 전'],
];
const TODO_ALARMS_DATE = [
  ['', '알림 없음'],
  ['-540', '당일 오전 9시'],
  ['360', '전날 오후 6시'],
  ['900', '전날 오전 9시'],
];
/** 기존 할 일(알림 항목 이전)은 시간이 있으면 정시 알림 */
const todoAlarm = (t) => (t.alarm === undefined ? (t.time ? 0 : null) : t.alarm);

const S = {
  data: null,
  view: 'month',
  cursor: D.today(),
  tab: 'all',
  showDone: false,
  g: { configured: false, connected: false, account: null },
  calendars: [],
  gEvents: [],
  gRange: null,
  syncing: false,
  lastSync: null,
  syncError: null,
  items: new Map(),
  openSubAdd: null,
};
const settings = () => S.data.settings;

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.api.save(S.data), 250);
  scheduleTaskSync();
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.tm);
  toast.tm = setTimeout(() => t.classList.remove('show'), 3200);
}

async function gcall(name, ...args) {
  const r = await window.api.google[name](...args);
  if (!r.ok) {
    if (r.code === 'not_connected') S.g.connected = false;
    const e = new Error(r.error);
    e.status = r.status;
    e.code = r.code;
    throw e;
  }
  return r.data;
}

/* ───────────── 보기 범위 ───────────── */
function viewRange() {
  const c = S.cursor;
  if (S.view === 'day') return { from: c, to: c };
  if (S.view === 'week') {
    const s = D.startOfWeek(c);
    return { from: s, to: D.addDays(s, 6) };
  }
  const { y, m } = D.parts(c);
  const first = D.make(y, m, 1);
  const start = D.startOfWeek(first);
  const weeks = Math.ceil((D.dow(first) + D.daysInMonth(y, m)) / 7);
  return { from: start, to: D.addDays(start, weeks * 7 - 1) };
}

function fetchRange() {
  const { from, to } = viewRange();
  return { from: D.addDays(from, -7), to: D.addDays(to, 7) };
}

/* ───────────── 캘린더 항목 수집 ───────────── */
function calendarColor(id) {
  return S.calendars.find((c) => c.id === id)?.color || null;
}
function isCalVisible(c) {
  const v = settings().calendarVisibility[c.id];
  return v === undefined ? c.selected : v;
}

function collectItems(from, to) {
  const items = [];
  S.items = new Map();
  let n = 0;
  const add = (it) => {
    it.idx = `i${n++}`;
    S.items.set(it.idx, it);
    items.push(it);
  };
  const localIds = new Set();

  for (const ev of S.data.events) {
    localIds.add(ev.id);
    for (const o of expandEvent(ev, from, to)) {
      add({
        kind: 'event',
        ev,
        date: o.date,
        endDate: o.endDate,
        title: ev.title,
        allDay: ev.allDay,
        startTime: ev.startTime,
        cls: ev.calType === 'lunar' ? 'l' : ev.calendarId === 'local' ? 'c' : 'g',
        color: null, // Google 일정은 캘린더 고유색 대신 파란색 계열로 통일
        lunar: ev.calType === 'lunar',
        lunarRepeat: ev.repeat === 'lunarYearly',
        pending: ev.calendarId !== 'local' && ev.sync === 'pending',
      });
    }
  }
  let googleHolidays = false;
  if (S.g.connected) {
    for (const g of S.gEvents) {
      if (g.appId && localIds.has(g.appId)) continue; // 이 프로그램이 만든 일정은 원본으로 표시
      if (g.endDate < from || g.date > to) continue;
      if (g.holidayCal) {
        // 구글 휴일 캘린더: 일정이 아니라 날짜 옆 휴일 이름으로 표시
        googleHolidays = true;
        add({ kind: 'holiday', date: g.date, endDate: g.endDate, title: g.title, allDay: true, cls: 'h', isPublic: !/기념일/.test(g.rawDesc || '') });
        continue;
      }
      add({ kind: 'gevent', g, date: g.date, endDate: g.endDate, title: g.title, allDay: g.allDay, startTime: g.startTime, cls: 'g', color: null });
    }
  }
  if (settings().showHolidays && !googleHolidays) {
    for (let y = D.parts(from).y; y <= D.parts(to).y; y++) {
      for (const [d, name] of getHolidays(y)) {
        if (d >= from && d <= to) add({ kind: 'holiday', date: d, endDate: d, title: name, allDay: true, cls: 'h', isPublic: true });
      }
    }
  }
  for (const t of S.data.todos) {
    if (t.deleted || !t.due || !t.showOnCalendar) continue;
    if (t.due < from || t.due > to) continue;
    add({ kind: 'todo', t, date: t.due, endDate: t.due, title: t.title, allDay: !t.time, startTime: t.time, cls: 't', done: t.done });
  }
  return items;
}

function byDay(items, from, to) {
  const map = new Map();
  for (let d = from; d <= to; d = D.addDays(d, 1)) map.set(d, []);
  for (const it of items) {
    let d = it.date < from ? from : it.date;
    const end = it.endDate > to ? to : it.endDate;
    for (; d <= end; d = D.addDays(d, 1)) map.get(d)?.push(it);
  }
  const rank = (it) => (it.kind === 'holiday' ? 0 : it.kind === 'todo' ? 3 : it.allDay ? 1 : 2);
  for (const list of map.values()) {
    list.sort((a, b) => rank(a) - rank(b) || (a.startTime || '').localeCompare(b.startTime || '') || a.title.localeCompare(b.title));
  }
  return map;
}

/** 드래그로 옮길 수 있는 항목인지 */
function movable(it) {
  if (it.kind === 'event' || it.kind === 'todo') return true;
  if (it.kind === 'gevent') return !!it.g.writable && !it.g.holidayCal;
  return false;
}

function chipHtml(it, day) {
  let label = it.title;
  if (it.kind === 'event' || it.kind === 'gevent') {
    if (!it.allDay && it.startTime && it.date === day) label = `${it.startTime} ${label}`;
    if (it.lunar) label = `${it.lunarRepeat ? '음 ↻' : '음'} ${label}`;
  }
  if (it.kind === 'todo') label = `${it.done ? '☑' : '☐'} ${label}`;
  const dot = it.color ? `<span class="cdot" style="background:${h(it.color)}"></span>` : '';
  const cls = `chip ${it.cls}${it.done ? ' done' : ''}${it.pending ? ' pending' : ''}`;
  if (it.kind === 'holiday') return `<span class="${cls}" title="${h(it.title)}">${h(label)}</span>`;
  return `<button type="button" class="${cls}" data-item="${it.idx}" title="${h(label)}"${movable(it) ? ' draggable="true"' : ''}>${dot}${h(label)}</button>`;
}

const isSpan = (it) => it.endDate > it.date;

/** 한 주(7일) 안에서 항목을 줄(lane)에 배치한다. 여러 날 일정은 이어진 막대 하나로. */
function layoutWeek(items, ws) {
  const we = D.addDays(ws, 6);
  const rank = (it) => (it.kind === 'todo' ? 3 : isSpan(it) ? 0 : it.allDay ? 1 : 2);
  const segs = items
    .filter((it) => it.kind !== 'holiday' && it.endDate >= ws && it.date <= we)
    .map((it) => {
      const s = it.date < ws ? ws : it.date;
      const e = it.endDate > we ? we : it.endDate;
      return { it, s, col: D.diffDays(ws, s), span: D.diffDays(s, e) + 1, contPrev: it.date < ws, contNext: it.endDate > we };
    });
  segs.sort(
    (a, b) =>
      rank(a.it) - rank(b.it) ||
      b.span - a.span ||
      a.col - b.col ||
      (a.it.startTime || '').localeCompare(b.it.startTime || '') ||
      a.it.title.localeCompare(b.it.title)
  );
  const lanes = [];
  for (const sg of segs) {
    for (let L = 0; ; L++) {
      if (!lanes[L]) lanes[L] = new Array(7).fill(false);
      let free = true;
      for (let c = sg.col; c < sg.col + sg.span; c++) if (lanes[L][c]) free = false;
      if (free) {
        for (let c = sg.col; c < sg.col + sg.span; c++) lanes[L][c] = true;
        sg.lane = L;
        break;
      }
    }
  }
  return { segs, laneCount: lanes.length };
}

function segHtml(sg, row) {
  const it = sg.it;
  let label = it.title;
  if (it.kind === 'event' || it.kind === 'gevent') {
    if (!it.allDay && it.startTime && sg.s === it.date) label = `${it.startTime} ${label}`;
    if (it.lunar) label = `${it.lunarRepeat ? '음 ↻' : '음'} ${label}`;
  }
  if (it.kind === 'todo') label = `${it.done ? '☑' : '☐'} ${label}`;
  const bar = sg.span > 1 || sg.contPrev || sg.contNext;
  const cls = `chip ${it.cls}${bar ? ' bar' : ''}${sg.contPrev ? ' cprev' : ''}${sg.contNext ? ' cnext' : ''}${it.done ? ' done' : ''}${it.pending ? ' pending' : ''}`;
  let style = `grid-column:${sg.col + 1} / span ${sg.span};grid-row:${row}`;
  if (bar && it.color) style += `;background:${it.color};color:#fff`;
  const dot = !bar && it.color ? `<span class="cdot" style="background:${h(it.color)}"></span>` : '';
  return `<button type="button" class="${cls}" data-item="${it.idx}" title="${h(label)}" style="${h(style)}"${movable(it) ? ' draggable="true"' : ''}>${dot}${h(label)}</button>`;
}

/* ───────────── 렌더링: 상단 상태 ───────────── */
function renderStatus() {
  const el = $('#syncStatus');
  let dot = '';
  let txt = '';
  if (!S.g.connected) {
    txt = S.g.configured ? 'Google 캘린더 연결 안 됨 · 설정에서 연결하세요' : 'Google 캘린더 미연결 · 이 PC에만 저장';
  } else if (S.syncing) {
    dot = 'on';
    txt = '동기화 중…';
  } else if (S.syncError) {
    dot = 'err';
    txt = `동기화 오류: ${S.syncError}`;
  } else {
    dot = 'on';
    const mins = S.lastSync ? Math.floor((Date.now() - S.lastSync) / 60000) : null;
    const when = mins === null ? '' : mins < 1 ? ' · 방금 동기화' : ` · ${mins}분 전 동기화`;
    txt = `Google 캘린더 연동됨${S.g.account ? ` (${S.g.account})` : ''}${when}`;
  }
  el.innerHTML = `<span class="dot ${dot}"></span><span class="txt" title="${h(txt)}">${h(txt)}</span>`;
  $('#btnSync').disabled = !S.g.connected || S.syncing;
}

/* ───────────── 렌더링: 캘린더 ───────────── */
function lunarText(d, force) {
  const l = solarToLunar(d);
  if (!l) return { text: '', first: false };
  const first = l.day === 1;
  const text = first || force ? `${l.leap ? '윤' : ''}${l.month}.${l.day}` : String(l.day);
  return { text, first };
}

function renderCalendar() {
  const { from, to } = viewRange();
  const today = D.today();
  const { y, m } = D.parts(S.cursor);
  const showLunar = settings().showLunar;
  $('#chkLunar').checked = showLunar;
  $$('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));

  const items = collectItems(from, to);
  // 날짜별 휴일 이름(holi)과 빨간 날짜로 칠할 공휴일(red)
  const holi = new Map();
  const red = new Set();
  for (const it of items) {
    if (it.kind !== 'holiday') continue;
    for (let d = it.date; d <= it.endDate; d = D.addDays(d, 1)) {
      const prev = holi.get(d);
      if (!prev || !prev.split(', ').includes(it.title)) holi.set(d, prev ? `${prev}, ${it.title}` : it.title);
      if (it.isPublic) red.add(d);
    }
  }
  const days = byDay(items, from, to);
  const body = $('#calBody');

  if (S.view === 'month') {
    $('#calTitle').textContent = `${y}년 ${m}월`;
    const l1 = solarToLunar(D.make(y, m, 1));
    const l2 = solarToLunar(D.make(y, m, D.daysInMonth(y, m)));
    $('#calLunarRange').textContent =
      showLunar && l1 && l2 ? `음력 ${l1.leap ? '윤' : ''}${l1.month}월 ${l1.day}일 – ${l2.leap ? '윤' : ''}${l2.month}월 ${l2.day}일` : '';
    const weeks = (D.diffDays(from, to) + 1) / 7;
    const MAXL = 4; // 하루 칸에 보이는 최대 줄 수
    let html = `<div class="dow-row">${D.DOW_KO.map((d, i) => `<div class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${d}</div>`).join('')}</div>`;
    html += '<div class="month2">';
    for (let w = 0; w < weeks; w++) {
      const ws = D.addDays(from, w * 7);
      const { segs } = layoutWeek(items, ws);
      const hidden = new Array(7).fill(0);
      const visible = [];
      for (const sg of segs) {
        if (sg.lane < MAXL) visible.push(sg);
        else for (let c = sg.col; c < sg.col + sg.span; c++) hidden[c]++;
      }
      const anyHidden = hidden.some(Boolean);
      html += `<div class="wk" style="grid-template-rows: 26px repeat(${MAXL}, 22px)${anyHidden ? ' 20px' : ''} minmax(4px, 1fr)">`;
      for (let c = 0; c < 7; c++) {
        const d = D.addDays(ws, c);
        const p = D.parts(d);
        const cls = [];
        if (p.m !== m) cls.push('out');
        if (c === 0) cls.push('sun');
        if (c === 6) cls.push('sat');
        if (red.has(d)) cls.push('hol');
        if (d === today) cls.push('today');
        const lt = showLunar ? lunarText(d, w === 0 && c === 0) : { text: '' };
        const hol = holi.get(d) || '';
        html += `<div class="dbg ${cls.join(' ')}" data-date="${d}" style="grid-column:${c + 1};grid-row:1 / -1"></div>
          <div class="dhead ${cls.join(' ')}" data-date="${d}" style="grid-column:${c + 1};grid-row:1">
            <button type="button" class="num" data-goday="${d}" title="${D.label(d)}">${p.d}</button>
            <span class="hname${red.has(d) ? '' : ' obs'}" title="${h(hol)}">${h(hol)}</span>
            <span class="lun${lt.first ? ' first' : ''}">${h(lt.text)}</span>
          </div>`;
      }
      for (const sg of visible) html += segHtml(sg, sg.lane + 2);
      hidden.forEach((n, c) => {
        if (n) html += `<button type="button" class="more" data-goday="${D.addDays(ws, c)}" style="grid-column:${c + 1};grid-row:${MAXL + 2}">+${n}개 더보기</button>`;
      });
      html += '</div>';
    }
    body.innerHTML = html + '</div>';
  } else if (S.view === 'week') {
    const a = D.parts(from);
    const b = D.parts(to);
    $('#calTitle').textContent =
      a.m === b.m ? `${a.y}년 ${a.m}월 ${a.d}일 – ${b.d}일` : `${a.y}년 ${a.m}월 ${a.d}일 – ${b.y !== a.y ? `${b.y}년 ` : ''}${b.m}월 ${b.d}일`;
    $('#calLunarRange').textContent = '';
    // 여러 날 일정은 위쪽에 이어진 막대로, 하루 일정은 각 요일 칸에 목록으로
    const spans = items.filter((it) => it.kind !== 'holiday' && isSpan(it));
    const { segs, laneCount } = layoutWeek(spans, from);
    let html = `<div class="week2" style="grid-template-rows: auto${laneCount ? ` repeat(${laneCount}, 24px)` : ''} 1fr">`;
    let i = 0;
    for (const [d, list] of days) {
      const cls = ['wcol'];
      if (i === 0) cls.push('sun');
      if (i === 6) cls.push('sat');
      if (red.has(d)) cls.push('hol');
      if (d === today) cls.push('today');
      const lt = showLunar ? solarToLunar(d) : null;
      const evs = list.filter((it) => it.kind !== 'holiday' && !isSpan(it));
      const hol = list.filter((it) => it.kind === 'holiday').map((it) => it.title).join(', ');
      html += `<div class="wbg ${cls.join(' ')}" data-date="${d}" style="grid-column:${i + 1};grid-row:1 / -1"></div>
        <div class="whead ${cls.join(' ')}" data-goday="${d}" style="grid-column:${i + 1};grid-row:1">
          <span class="n">${D.parts(d).d}</span><span class="xs muted">${D.DOW_KO[i]}${lt ? ` · 음 ${lt.leap ? '윤' : ''}${lt.month}.${lt.day}` : ''}</span>
          ${hol ? `<span class="hname xs${red.has(d) ? '' : ' obs'}">${h(hol)}</span>` : ''}
        </div>
        <div class="wlist" data-date="${d}" style="grid-column:${i + 1};grid-row:${laneCount + 2}">
          ${evs.map((it) => chipHtml(it, d)).join('')}
        </div>`;
      i++;
    }
    for (const sg of segs) html += segHtml(sg, sg.lane + 2);
    body.innerHTML = html + '</div>';
  } else {
    const d = S.cursor;
    $('#calTitle').textContent = D.label(d);
    const l = solarToLunar(d);
    $('#calLunarRange').textContent = showLunar && l ? `음력 ${l.leap ? '윤' : ''}${l.month}월 ${l.day}일` : '';
    const list = days.get(d) || [];
    const hol = list.filter((it) => it.kind === 'holiday');
    const evs = list.filter((it) => it.kind === 'event' || it.kind === 'gevent');
    const tds = list.filter((it) => it.kind === 'todo');
    const color = (it) =>
      it.cls === 'l' ? 'var(--lunar)' : it.cls === 'c' ? 'var(--local-ink)' : 'var(--accent)';
    const meta = (it) => {
      const src = it.kind === 'event' ? it.ev : it.g;
      const parts = [];
      if (it.kind === 'event') {
        if (it.lunar) parts.push(`음력 ${src.lunar.leap ? '윤' : ''}${src.lunar.month}.${src.lunar.day}`);
        if (src.repeat && src.repeat !== 'none') parts.push(EVENT_REPEAT_LABEL[src.repeat]);
        parts.push(src.calendarId === 'local' ? '이 PC에만' : S.calendars.find((c) => c.id === src.calendarId)?.summary || 'Google');
      } else {
        parts.push(src.calendarName);
        if (src.recurringEventId) parts.push('반복');
      }
      if (src.place) parts.push(`장소: ${src.place}`);
      if (src.people?.length) parts.push(`참여: ${src.people.join(', ')}`);
      return parts.map((p) => `<span>${h(p)}</span>`).join('');
    };
    let html = '<div class="dayview">';
    if (hol.length) html += `<div class="warn" style="font-size:13px">${h(hol.map((x) => x.title).join(', '))}</div>`;
    html += '<h3>일정</h3>';
    if (!evs.length) html += '<div class="empty">일정이 없습니다. 아래 빈 곳을 클릭하거나 "+ 일정"으로 추가하세요.</div>';
    for (const it of evs) {
      const tm = it.allDay ? '종일' : `${it.startTime || ''}${it.kind === 'event' ? ` – ${it.ev.endTime || ''}` : it.g.endTime ? ` – ${it.g.endTime}` : ''}`;
      html += `<button type="button" class="ditem" data-item="${it.idx}"><span class="tm">${h(tm)}</span><span class="bar" style="background:${color(it)}"></span><span><div class="ttl">${h(it.title)}</div><div class="meta">${meta(it)}</div></span></button>`;
    }
    html += '<h3>이 날 기한인 할 일</h3>';
    if (!tds.length) html += '<div class="empty">없음</div>';
    for (const it of tds) {
      html += `<button type="button" class="ditem" data-item="${it.idx}"><span class="tm">${it.t.time || '시간 없음'}</span><span class="bar" style="background:var(--line2)"></span><span><div class="ttl" style="${it.done ? 'text-decoration:line-through;color:var(--faint)' : ''}">${h(it.title)}</div><div class="meta">${it.t.repeat?.type !== 'none' ? `<span>${h(describeRule(it.t.repeat))}</span>` : ''}</div></span></button>`;
    }
    html += `<div class="addzone" data-date="${d}" style="min-height:120px"></div></div>`;
    body.innerHTML = html;
  }
}

/* ───────────── 렌더링: 할 일 ───────────── */
function todoMeta(t) {
  const today = D.today();
  const parts = [];
  let over = false;
  if (t.due) {
    if (!t.done && t.due < today) over = true;
    if (t.due === today) parts.push(t.time ? `오늘 ${t.time}` : '오늘');
    else parts.push(`${D.shortLabel(t.due)}${t.time ? ` ${t.time}` : ''}`);
  }
  let html = '';
  if (t.repeat && t.repeat.type !== 'none') html += `${REPEAT_ICON}<span>${h(describeRule(t.repeat))}</span>`;
  if (parts.length) html += `${html ? '<span>·</span>' : ''}<span>${h(parts.join(' '))}</span>`;
  const subs = t.subtasks || [];
  if (subs.length) html += `${html ? '<span>·</span>' : ''}<span>하위 ${subs.filter((s) => s.done).length}/${subs.length}</span>`;
  if (t.memo) html += `${html ? '<span>·</span>' : ''}<span>메모</span>`;
  if (t.done && t.doneAt) html += `${html ? '<span>·</span>' : ''}<span>완료 ${h(D.shortLabel(D.ymd(new Date(t.doneAt))))}</span>`;
  return html ? `<span class="tm${over ? ' over' : ''}">${html}</span>` : '';
}

function todoRow(t) {
  const subs = t.subtasks || [];
  const open = !t.collapsed;
  let html = `<div class="trow${t.done ? ' done' : ''}">
    <input type="checkbox" data-check="${t.id}" ${t.done ? 'checked' : ''} aria-label="${h(t.title)} 완료">
    <button type="button" class="tb" data-todo="${t.id}"><span class="tt">${h(t.title)}</span>${todoMeta(t)}</button>
    ${
      subs.length
        ? `<button type="button" class="btn ghost icon" data-collapse="${t.id}" aria-label="하위 할 일 ${open ? '접기' : '펼치기'}" title="하위 할 일 ${open ? '접기' : '펼치기'}" style="width:28px;height:28px">${open ? '⌃' : '⌄'}</button>`
        : `<button type="button" class="btn ghost icon" data-subadd="${t.id}" aria-label="하위 할 일 추가" title="하위 할 일 추가" style="width:28px;height:28px;font-size:16px">+</button>`
    }
  </div>`;
  if ((subs.length && open) || S.openSubAdd === t.id) {
    html += `<div class="subs" style="padding:2px 0 8px 30px;display:flex;flex-direction:column;gap:2px;border-bottom:1px solid #EEECE7">`;
    for (const s of subs) {
      html += `<div class="row gap8" style="min-height:30px">
        <input type="checkbox" data-subcheck="${t.id}|${s.id}" ${s.done ? 'checked' : ''} style="width:16px;height:16px;margin:0;accent-color:var(--accent)" aria-label="${h(s.title)} 완료">
        <span class="grow small" style="${s.done ? 'text-decoration:line-through;color:var(--faint)' : ''};word-break:break-all">${h(s.title)}</span>
        <button type="button" class="btn ghost icon" data-subdel="${t.id}|${s.id}" aria-label="${h(s.title)} 삭제" title="삭제" style="width:26px;height:26px">×</button>
      </div>`;
    }
    html +=
      S.openSubAdd === t.id
        ? `<input class="inp subinp" data-subnew="${t.id}" placeholder="하위 할 일 입력 후 Enter (Esc: 닫기)" style="height:32px;font-size:13px;border-style:dashed">`
        : `<button type="button" class="btn ghost" data-subadd="${t.id}" style="align-self:flex-start;height:28px;padding:0 4px;font-size:13px;color:var(--muted)">+ 하위 할 일 추가</button>`;
    html += '</div>';
  }
  return html;
}

function renderTodos() {
  const today = D.today();
  const all = S.data.todos.filter((t) => !t.deleted);
  const pending = all.filter((t) => !t.done);
  const isRep = (t) => t.repeat && t.repeat.type !== 'none';
  const tabs = [
    ['all', '전체', null],
    ['today', '오늘', pending.filter((t) => t.due && t.due <= today).length],
    ['dated', '기한 있음', null],
    ['undated', '기한 없음', pending.filter((t) => !t.due).length],
    ['repeat', '반복', null],
  ];
  $('#todoTabs').innerHTML = tabs
    .map(([k, n, c]) => `<button type="button" role="tab" aria-selected="${S.tab === k}" class="${S.tab === k ? 'on' : ''}" data-tab="${k}">${n}${c ? ` ${c}` : ''}</button>`)
    .join('');
  $('#todoCount').textContent = `남은 항목 ${pending.length}`;

  const filt = {
    all: () => true,
    today: (t) => t.due && t.due <= today,
    dated: (t) => !!t.due,
    undated: (t) => !t.due,
    repeat: isRep,
  }[S.tab];
  const list = pending.filter(filt);
  const sortDue = (a, b) => a.due.localeCompare(b.due) || (a.time || '99').localeCompare(b.time || '99') || a.createdAt - b.createdAt;
  const groups = [
    ['over', '기한 지남', list.filter((t) => t.due && t.due < today).sort(sortDue)],
    ['today', `오늘 · ${D.parts(today).m}월 ${D.parts(today).d}일`, list.filter((t) => t.due === today).sort(sortDue)],
    ['', '예정', list.filter((t) => t.due && t.due > today).sort(sortDue)],
    ['', '기한 없음', list.filter((t) => !t.due).sort((a, b) => a.createdAt - b.createdAt)],
  ];
  let html = '';
  for (const [cls, title, arr] of groups) {
    if (!arr.length) continue;
    html += `<h3 class="${cls}">${h(title)}</h3>${arr.map(todoRow).join('')}`;
  }
  if (!html) html = '<div class="empty">할 일이 없습니다. 위 입력칸에 적고 Enter를 누르세요.</div>';
  const done = all.filter((t) => t.done && filt(t)).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  if (done.length) {
    html += `<button type="button" class="btn ghost showdone" id="btnShowDone">${S.showDone ? '완료한 항목 숨기기' : `완료한 항목 보기 (${done.length})`}</button>`;
    if (S.showDone) html += done.slice(0, 100).map(todoRow).join('');
  }
  html += '<div class="todo-fill" title="클릭해서 새 할 일 추가"><span>+ 빈 곳을 클릭해 할 일 추가</span></div>';
  const el = $('#todoList');
  const st = el.scrollTop;
  el.innerHTML = html;
  el.scrollTop = st;
  if (S.openSubAdd) $(`[data-subnew="${S.openSubAdd}"]`)?.focus();
}

const UPDATE_TEXT = {
  dev: '개발 모드에서는 업데이트를 확인하지 않습니다.',
  idle: '',
  checking: '업데이트 확인 중…',
  latest: '최신 버전입니다.',
  downloading: '새 버전을 내려받는 중…',
  ready: '새 버전이 준비되었습니다.',
  error: '업데이트 확인 실패',
};
function renderUpdate() {
  const u = S.update || { status: 'idle' };
  const b = $('#btnUpdate');
  if (S.patchReady) {
    b.hidden = false;
    b.textContent = `변경사항 적용 (${S.patchReady})`;
    b.title = '프로그램을 다시 시작해 새 변경사항을 적용합니다.';
  } else {
    // 이미 같은 버전이 적용되어 있으면 설치 버튼 숨김
    const cur = S.appVersion || '0';
    const vnum = (v) => String(v || '0').split('.').map((n) => parseInt(n, 10) || 0);
    const gt = (a, b) => {
      const x = vnum(a);
      const y = vnum(b);
      for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
      return false;
    };
    b.hidden = u.status !== 'ready' || !gt(u.version, cur);
    b.textContent = `새 버전 ${u.version || ''} 설치`;
    b.title = '프로그램을 다시 시작하면서 업데이트합니다. 지금 누르지 않아도 프로그램을 닫을 때 자동으로 설치됩니다.';
  }
  const el = $('#updMsg');
  if (el) el.textContent = `${UPDATE_TEXT[u.status] || ''}${u.status === 'error' && u.error ? `: ${u.error}` : ''}${['downloading', 'ready'].includes(u.status) && u.version ? ` (${u.version})` : ''}`;
}

function renderAll() {
  renderStatus();
  renderCalendar();
  renderTodos();
}

/* ───────────── 모달 ───────────── */
function openModal(html, { cls = '', onClose } = {}) {
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div>`;
  root.appendChild(ov);
  const close = () => {
    ov.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => {
    if (root.lastElementChild !== ov) return;
    if (e.key === 'Escape') close();
    // 저장 단축키: Ctrl+Enter 또는 Ctrl+S
    else if ((e.ctrlKey || e.metaKey) && !e.isComposing && (e.key === 'Enter' || e.key === 's' || e.key === 'S' || e.code === 'KeyS')) {
      const btn = ov.querySelector('[data-save]');
      if (btn) {
        e.preventDefault();
        // 한글 입력 중인 글자가 반영되도록 포커스를 잠시 해제한 뒤 저장
        document.activeElement?.blur?.();
        setTimeout(() => btn.click(), 0);
      }
    }
  };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('mousedown', (e) => {
    if (e.target === ov) ov.dataset.down = '1';
  });
  ov.addEventListener('click', (e) => {
    if (e.target === ov && ov.dataset.down === '1') close();
    ov.dataset.down = '';
  });
  return { el: ov.firstElementChild, close };
}

function choose(title, message, buttons) {
  return new Promise((resolve) => {
    const { el, close } = openModal(
      `<div class="mhead"><h1>${h(title)}</h1></div>
       <div class="mbody"><div style="white-space:pre-line">${h(message)}</div></div>
       <div class="mfoot"><div class="spacer"></div>${buttons
         .map((b, i) => `<button type="button" class="btn ${b.cls || ''}" data-i="${i}">${h(b.label)}</button>`)
         .join('')}<button type="button" class="btn" data-i="-1">취소</button></div>`,
      { cls: 'narrow', onClose: () => resolve(null) }
    );
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const i = +b.dataset.i;
      resolve(i < 0 ? null : buttons[i].value);
      close();
    });
  });
}

/* ───────────── Google 동기화 ───────────── */
async function deleteRemote(calendarId, ids) {
  for (const id of ids) {
    try {
      await gcall('remove', calendarId, id);
    } catch {
      settings().pendingDeletes.push({ calendarId, id });
    }
  }
}

function remoteIds(ev) {
  if (!ev.google) return [];
  if (ev.google.instances) return Object.values(ev.google.instances);
  return ev.google.id ? [ev.google.id] : [];
}

async function upsertRemote(calId, id, payload) {
  if (id) {
    try {
      return await gcall('patch', calId, id, payload);
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e;
    }
  }
  return gcall('insert', calId, payload);
}

async function pushEvent(ev) {
  if (ev.calendarId === 'local') return;
  if (!S.g.connected) {
    ev.sync = 'pending';
    return;
  }
  try {
    if (ev.calType === 'lunar') {
      const targets = lunarTargets(ev, settings().lunarYears, D.parts(D.today()).y);
      const inst = { ...(ev.google?.instances || {}) };
      const want = new Set(targets.map((t) => String(t.year)));
      for (const [yr, id] of Object.entries(inst)) {
        if (!want.has(yr)) {
          await deleteRemote(ev.calendarId, [id]);
          delete inst[yr];
        }
      }
      for (const t of targets) {
        const r = await upsertRemote(ev.calendarId, inst[t.year], lunarPayload(ev, t.year, t.date));
        inst[t.year] = r.id;
      }
      ev.google = { calendarId: ev.calendarId, instances: inst };
    } else {
      const r = await upsertRemote(ev.calendarId, ev.google?.id, solarPayload(ev));
      ev.google = { calendarId: ev.calendarId, id: r.id };
      ev.syncedAt = Date.parse(r.updated || '') || Date.now();
    }
    ev.sync = 'ok';
    ev.syncError = null;
  } catch (e) {
    ev.sync = 'pending';
    ev.syncError = e.message;
  }
  save();
}

async function processPending() {
  const pd = settings().pendingDeletes.splice(0);
  for (const p of pd) await deleteRemote(p.calendarId, [p.id]);
  const thisYear = D.parts(D.today()).y;
  for (const ev of S.data.events) {
    if (ev.calendarId === 'local') continue;
    let need = ev.sync === 'pending';
    if (!need && ev.calType === 'lunar' && ev.repeat === 'lunarYearly') {
      const years = Object.keys(ev.google?.instances || {}).map(Number);
      const target = Math.min(LUNAR_MAX_YEAR, thisYear + settings().lunarYears - 1);
      if (!years.length || Math.max(...years) < target) need = true;
    }
    if (need) await pushEvent(ev);
  }
}

let refreshing = null;
async function refreshGoogle() {
  if (!S.g.connected) {
    S.gEvents = [];
    renderAll();
    return;
  }
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const { from, to } = fetchRange();
    S.syncing = true;
    renderStatus();
    const errors = [];
    try {
      await processPending();
      S.calendars = await gcall('calendars');
      const cals = S.calendars.filter(isCalVisible);
      const tMin = new Date(`${from}T00:00:00`).toISOString();
      const tMax = new Date(`${D.addDays(to, 1)}T00:00:00`).toISOString();
      const res = await Promise.all(
        cals.map((c) =>
          gcall('events', c.id, tMin, tMax)
            .then((items) => items.filter((i) => i.status !== 'cancelled').map((i) => fromGoogle(i, c)))
            .catch((e) => {
              errors.push(`${c.summary}: ${e.message}`);
              return [];
            })
        )
      );
      S.gEvents = res.flat();
      learnFromGoogle();
      await pullOwnEvents();
      syncTasks();
      S.gRange = { from, to };
      S.lastSync = Date.now();
      S.syncError = errors.length ? errors.join(' / ') : null;
    } catch (e) {
      S.syncError = e.message;
      if (e.code === 'not_connected') toast(e.message);
    } finally {
      S.syncing = false;
      refreshing = null;
      save();
      renderAll();
    }
  })();
  return refreshing;
}

/** 이 프로그램이 Google에 올린 일정을 휴대폰 등 다른 곳에서 고치거나 지운 경우 PC에도 반영
 *  (반복이 없는 양력 일정만. 반복·음력 일정은 PC 쪽 설정이 기준) */
async function pullOwnEvents() {
  if (!S.gRange) return;
  const byGid = new Map(S.gEvents.map((g) => [g.gid, g]));
  const visible = new Set(S.calendars.filter(isCalVisible).map((c) => c.id));
  let changed = false;
  for (const ev of S.data.events.slice()) {
    if (ev.calendarId === 'local' || ev.calType === 'lunar' || (ev.repeat && ev.repeat !== 'none')) continue;
    if (ev.sync !== 'ok' || !ev.google?.id || !visible.has(ev.calendarId)) continue;
    if (ev.endDate < S.gRange.from || ev.date > S.gRange.to) continue;
    let g = byGid.get(ev.google.id);
    if (!g) {
      // 보이는 범위에 없으면 다른 날짜로 옮겨졌거나 지워진 것 → 직접 확인
      const r = await window.api.google.get(ev.calendarId, ev.google.id);
      if (!r.ok) {
        if (r.status === 404 || r.status === 410) {
          S.data.events = S.data.events.filter((x) => x !== ev);
          changed = true;
        }
        continue;
      }
      if (r.data.status === 'cancelled') {
        S.data.events = S.data.events.filter((x) => x !== ev);
        changed = true;
        continue;
      }
      g = fromGoogle(r.data, S.calendars.find((c) => c.id === ev.calendarId) || { id: ev.calendarId });
    }
    const remoteT = Date.parse(g.updated || '') || 0;
    if (remoteT > (ev.syncedAt || 0) + 3000) {
      Object.assign(ev, {
        title: g.title,
        memo: g.memo,
        place: g.place || '',
        people: g.people || [],
        date: g.date,
        endDate: g.endDate,
        allDay: g.allDay,
        startTime: g.allDay ? null : g.startTime,
        endTime: g.allDay ? null : g.endTime,
        syncedAt: remoteT,
        updatedAt: Date.now(),
      });
      changed = true;
    }
  }
  if (changed) save();
}

function maybeRefresh() {
  if (!S.g.connected) return;
  const { from, to } = viewRange();
  if (!S.gRange || from < S.gRange.from || to > S.gRange.to) refreshGoogle();
}

/* ───────────── 할 일 ↔ Google Tasks 동기화 ─────────────
 * 기본 목록("내 할 일")과 양방향 동기화. 제목·메모·기한 날짜·완료·하위 할 일만 주고받고,
 * 시간·반복 규칙·알림은 이 PC에만 보관한다. 반복 할 일은 완료 시 이 프로그램이 다음 회차를 만들어 올린다.
 * 마지막 동기화 시점의 내용(sig)과 비교해 바뀐 쪽을 반영(양쪽 다 바뀌면 PC 쪽 우선).
 */
const TASK_LIST = '@default';
const tasksOn = () => S.g.connected && S.g.tasks && settings().tasksSync !== false;

function localView(t) {
  return {
    title: (t.title || '').trim(),
    memo: (t.memo || '').trim(),
    due: t.due || null,
    done: !!t.done,
    subs: (t.subtasks || []).map((x) => `${x.done ? 1 : 0}${(x.title || '').trim()}`).sort(),
  };
}
function remoteView(r, kids) {
  return {
    title: (r.title || '').trim(),
    memo: (r.notes || '').trim(),
    due: r.due ? r.due.slice(0, 10) : null,
    done: r.status === 'completed',
    subs: kids.map((c) => `${c.status === 'completed' ? 1 : 0}${(c.title || '').trim()}`).sort(),
  };
}
const sigOf = (v) => JSON.stringify(v);
const taskBody = (t) => ({
  title: t.title,
  notes: t.memo || '',
  due: t.due ? `${t.due}T00:00:00.000Z` : null,
  status: t.done ? 'completed' : 'needsAction',
  ...(t.done ? {} : { completed: null }),
});
const subBody = (x) => ({ title: x.title, status: x.done ? 'completed' : 'needsAction', ...(x.done ? {} : { completed: null }) });

/** PC에서 지워지는 할 일의 Google 쪽 항목도 지우도록 기록 */
function forgetTask(t) {
  if (!t || !t.gtask?.id) return;
  settings().pendingTaskDeletes.push(t.gtask.id);
  t.gtask = null;
}

function needTaskSync() {
  if (!tasksOn()) return false;
  if (settings().pendingTaskDeletes.length) return true;
  return S.data.todos.some((t) => (t.gtask ? t.deleted || sigOf(localView(t)) !== t.gtask.sig : !t.deleted && !t.done));
}
let taskSyncTimer = null;
function scheduleTaskSync() {
  clearTimeout(taskSyncTimer);
  taskSyncTimer = setTimeout(() => {
    if (needTaskSync()) syncTasks();
  }, 3000);
}

const isGone = (e) => e && (e.status === 404 || e.status === 410);

async function insertTaskFor(t) {
  const r = await gcall('taskInsert', TASK_LIST, taskBody(t));
  t.gtask = { id: r.id, sig: null };
  let prev = null;
  for (const x of t.subtasks || []) {
    const c = await gcall('taskInsert', TASK_LIST, subBody(x), r.id, prev);
    x.gid = c.id;
    prev = c.id;
  }
  t.gtask.sig = sigOf(localView(t));
}

async function pushTask(t, kids) {
  await gcall('taskPatch', TASK_LIST, t.gtask.id, taskBody(t));
  const byId = new Map(kids.map((c) => [c.id, c]));
  const keep = new Set();
  let prev = null;
  for (const x of t.subtasks || []) {
    const c = x.gid && byId.get(x.gid);
    if (c) {
      keep.add(c.id);
      if ((c.title || '') !== x.title || (c.status === 'completed') !== !!x.done) await gcall('taskPatch', TASK_LIST, c.id, subBody(x));
      prev = c.id;
    } else {
      const n = await gcall('taskInsert', TASK_LIST, subBody(x), t.gtask.id, prev);
      x.gid = n.id;
      prev = n.id;
    }
  }
  for (const c of kids) {
    if (!keep.has(c.id)) {
      try {
        await gcall('taskDelete', TASK_LIST, c.id);
      } catch (e) {
        if (!isGone(e)) throw e;
      }
    }
  }
  t.gtask.sig = sigOf(localView(t));
}

function pullTask(t, r, kids) {
  const v = remoteView(r, kids);
  t.title = v.title || t.title;
  t.memo = r.notes || '';
  if (v.due !== (t.due || null)) {
    t.due = v.due;
    if (!t.due) t.time = null;
  }
  const local = new Map((t.subtasks || []).filter((x) => x.gid).map((x) => [x.gid, x]));
  t.subtasks = kids.map((c) => {
    const x = local.get(c.id) || { id: uid() };
    return { ...x, title: c.title || '', done: c.status === 'completed', gid: c.id };
  });
  if (v.done !== !!t.done) {
    // 휴대폰에서 완료/완료 취소 → 반복 할 일이면 다음 회차 생성 등 PC 규칙 적용
    t.done = v.done;
    t.doneAt = v.done ? Date.now() : null;
    if (v.done && t.repeat && t.repeat.type !== 'none' && !t.nextId && (t.genMode !== 'fixed' || t.repeat.type === 'afterN')) {
      const nx = t.repeat.type === 'afterN' ? D.addDays(D.today(), Math.max(1, t.repeat.interval || 1)) : nextOccurrence(t.repeat, t.due || D.today(), t.anchor || t.due);
      if (nx) {
        const n = makeInstance(t, nx);
        S.data.todos.push(n);
        t.nextId = n.id;
      }
    }
  }
  t.gtask.sig = sigOf(localView(t));
}

let taskSyncing = null;
let taskSyncAgain = false;
async function syncTasks() {
  if (!tasksOn()) return;
  if (taskSyncing) {
    taskSyncAgain = true;
    return taskSyncing;
  }
  taskSyncing = (async () => {
    try {
      await doTaskSync();
      S.taskError = null;
    } catch (e) {
      S.taskError = e.message;
      if (e.status === 403) S.taskError = 'Google Tasks 권한이 없거나 Tasks API가 꺼져 있습니다. 설정에서 확인하세요.';
    } finally {
      taskSyncing = null;
      window.api.save(S.data);
      renderAll();
      if (taskSyncAgain) {
        taskSyncAgain = false;
        setTimeout(syncTasks, 500);
      }
    }
  })();
  return taskSyncing;
}

async function doTaskSync() {
  const st = settings();
  for (const id of st.pendingTaskDeletes.splice(0)) {
    try {
      await gcall('taskDelete', TASK_LIST, id);
    } catch (e) {
      if (!isGone(e)) st.pendingTaskDeletes.push(id);
    }
  }
  const all = await gcall('taskList', TASK_LIST);
  const byId = new Map(all.map((x) => [x.id, x]));
  const kidsOf = new Map();
  for (const x of all) {
    if (!x.parent || x.deleted) continue;
    if (!kidsOf.has(x.parent)) kidsOf.set(x.parent, []);
    kidsOf.get(x.parent).push(x);
  }
  for (const k of kidsOf.values()) k.sort((a, b) => String(a.position).localeCompare(String(b.position)));
  const mapped = new Set();

  for (const t of S.data.todos.slice()) {
    if (!t.gtask?.id) continue;
    mapped.add(t.gtask.id);
    const r = byId.get(t.gtask.id);
    if (t.deleted) {
      if (r && !r.deleted) {
        try {
          await gcall('taskDelete', TASK_LIST, t.gtask.id);
        } catch (e) {
          if (!isGone(e)) throw e;
        }
      }
      t.gtask = null;
      continue;
    }
    const lv = sigOf(localView(t));
    if (!r || r.deleted) {
      if (lv === t.gtask.sig) {
        // 휴대폰에서 지움 → PC에서도 지움
        S.data.todos = S.data.todos.filter((o) => o !== t);
      } else {
        t.gtask = null; // PC에서 고친 내용이 있으면 다시 올림
      }
      continue;
    }
    const kids = kidsOf.get(r.id) || [];
    kids.forEach((c) => mapped.add(c.id));
    const rv = sigOf(remoteView(r, kids));
    if (lv !== t.gtask.sig) await pushTask(t, kids);
    else if (rv !== t.gtask.sig) {
      pullTask(t, r, kids);
      if ((t.subtasks || []).some((x) => !x.gid)) await pushTask(t, kids);
    }
  }

  // 휴대폰에서 새로 만든 할 일 가져오기 (완료된 옛 항목은 제외)
  for (const r of all) {
    if (r.parent || r.deleted || r.status === 'completed' || mapped.has(r.id) || !(r.title || '').trim()) continue;
    const kids = kidsOf.get(r.id) || [];
    const t = {
      id: uid(),
      title: r.title.trim(),
      due: r.due ? r.due.slice(0, 10) : null,
      time: null,
      repeat: { type: 'none' },
      genMode: 'onComplete',
      showOnCalendar: true,
      alarm: null,
      memo: r.notes || '',
      subtasks: kids.map((c) => ({ id: uid(), title: c.title || '', done: c.status === 'completed', gid: c.id })),
      createdAt: Date.now(),
      done: false,
      gtask: { id: r.id, sig: null },
    };
    t.gtask.sig = sigOf(localView(t));
    S.data.todos.push(t);
  }

  // PC의 새 할 일 올리기 (미완료만)
  for (const t of S.data.todos.slice()) {
    if (t.gtask || t.deleted || t.done) continue;
    await insertTaskFor(t);
  }
  S.taskSyncedAt = Date.now();
}

/* ───────────── 일정 창 ───────────── */
function writableCalendars() {
  return S.g.connected ? S.calendars.filter((c) => c.writable) : [];
}

function defaultCalendarId() {
  const d = settings().defaultCalendar;
  if (d === 'local') return 'local';
  const ws = writableCalendars();
  if (d && ws.some((c) => c.id === d)) return d;
  return ws.find((c) => c.primary)?.id || 'local';
}

/* ───────────── 장소·참여 인원 자동 채우기 (이전 일정 참고) ───────────── */
const normTitle = (t) => String(t || '').replace(/\s+/g, ' ').trim();
// 회사 이름 = 제목의 첫 단어 ((주)·㈜·주식회사 표기는 무시)
const stripCorp = (t) => normTitle(t).replace(/^(\(주\)|㈜|주식회사|\(유\)|유한회사)\s*/, '').replace(/\s*(\(주\)|㈜|주식회사)(?=\s|$)/, '');
const firstToken = (t) => stripCorp(t).split(' ')[0] || '';

/** 이전 일정의 장소·참여 인원을 제목별로 기록 (최근 400개) */
function remember(title, place, people, at = Date.now()) {
  const key = normTitle(title);
  if (!key || (!place && !(people && people.length))) return;
  const hist = (S.data.history ||= {});
  const prev = hist[key];
  if (prev && prev.at > at) return;
  hist[key] = { place: place || '', people: [...(people || [])], at };
  const keys = Object.keys(hist);
  if (keys.length > 400) {
    keys.sort((a, b) => hist[a].at - hist[b].at).slice(0, keys.length - 400).forEach((k) => delete hist[k]);
  }
}

function learnFromGoogle() {
  let changed = false;
  for (const g of S.gEvents) {
    if (g.holidayCal || (!g.place && !(g.people && g.people.length))) continue;
    const at = new Date(`${g.date}T12:00:00`).getTime();
    const before = JSON.stringify(S.data.history?.[normTitle(g.title)]);
    remember(g.title, g.place, g.people, at);
    if (before !== JSON.stringify(S.data.history?.[normTitle(g.title)])) changed = true;
  }
  if (changed) save();
}

/** 제목으로 가장 비슷한 이전 일정 찾기: ① 같은 제목 ② 첫 단어(회사명 등)가 같은 일정 중 가장 최근 */
function findSimilar(title) {
  const key = normTitle(title);
  if (key.length < 2) return null;
  const hist = S.data.history || {};
  if (hist[key]) return { title: key, ...hist[key] };
  const tok = firstToken(key);
  const flat = stripCorp(key).replace(/\s/g, '');
  let best = null;
  let bestScore = -1;
  for (const [t, v] of Object.entries(hist)) {
    const c = firstToken(t);
    const tflat = stripCorp(t).replace(/\s/g, '');
    // 같은 회사: 첫 단어가 같거나, 띄어쓰기 없이 회사 이름으로 시작하는 제목
    let company = null;
    if (c.length >= 2 && (c === tok || flat.startsWith(c))) company = c;
    else if (tok.length >= 2 && tflat.startsWith(tok)) company = tok;
    if (!company) continue;
    // 업무(중간감사·기말감사·재고실사 등) = 회사 이름 뒤의 나머지
    const work = flat.slice(company.length);
    const pastWork = tflat.slice(company.length);
    let score = 1; // 같은 회사
    if (work.length >= 2 && pastWork.length >= 2) {
      if (work === pastWork) score = 3; // 같은 회사 + 같은 업무
      else if (work.includes(pastWork) || pastWork.includes(work)) score = 2; // 비슷한 업무 (예: 중간감사 2차)
    }
    if (score > bestScore || (score === bestScore && v.at > best.at)) {
      best = { title: t, ...v };
      bestScore = score;
    }
  }
  return best;
}

function knownPlaces() {
  const set = new Map();
  for (const v of Object.values(S.data.history || {})) if (v.place) set.set(v.place, Math.max(set.get(v.place) || 0, v.at));
  return [...set.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]).slice(0, 50);
}
function knownPeople() {
  const set = new Map();
  for (const v of Object.values(S.data.history || {})) for (const p of v.people || []) set.set(p, Math.max(set.get(p) || 0, v.at));
  return [...set.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]).slice(0, 100);
}

function openEventDialog({ ev = null, g = null, date = null, occ = null, preset = null, onSaved = null } = {}) {
  const today = D.today();
  const base = date || today;
  const ext = !!g; // 다른 곳에서 만든 Google 일정
  const src = ev || g;
  const l0 = solarToLunar(src?.date || base) || { month: 1, day: 1, leap: false };
  const f = {
    title: src?.title || '',
    calType: ev?.calType || 'solar',
    date: src?.date || base,
    endDate: src?.endDate || src?.date || base,
    lYear: ev?.lunar?.baseYear || D.parts(src?.date || base).y,
    lMonth: ev?.lunar?.month || l0.month,
    lDay: ev?.lunar?.day || l0.day,
    leap: ev?.lunar?.leap || false,
    allDay: src ? src.allDay : true,
    startTime: src?.startTime || '09:00',
    endTime: src?.endTime || '10:00',
    repeat: ev?.repeat || 'none',
    alarm: src?.alarm === null || src?.alarm === undefined ? '' : String(src.alarm),
    calendarId: ev ? ev.calendarId : g ? g.calendarId : defaultCalendarId(),
    place: src?.place || '',
    people: [...(src?.people || [])],
    memo: src?.memo || '',
  };
  // 새 일정일 때만 자동 채우기. 사용자가 직접 고친 칸은 건드리지 않음
  const auto = { on: !src, placeTouched: false, peopleTouched: false, from: null, filledPlace: false, filledPeople: false };
  if (preset && !src) {
    Object.assign(f, preset);
    if (preset.place) auto.placeTouched = true;
  }
  const readonly = ext && !g.writable;
  const recurringExt = ext && !!g.recurringEventId;

  const html = `
    <div class="mhead"><h1>${ev || g ? '일정 수정' : '새 일정'}</h1><button type="button" class="btn ghost icon" data-close aria-label="닫기">✕</button></div>
    <form class="mbody" id="evForm" autocomplete="off"></form>
    <div class="mfoot">
      ${ev || (g && !readonly) ? '<button type="button" class="btn danger" data-del>삭제</button>' : ''}
      ${g?.htmlLink ? '<button type="button" class="btn ghost" data-open-g>Google에서 열기</button>' : ''}
      <div class="spacer"></div>
      <span class="note">Ctrl+Enter 저장</span>
      <button type="button" class="btn" data-close>취소</button>
      <button type="button" class="btn primary" data-save title="Ctrl+Enter 또는 Ctrl+S">${readonly ? '닫기' : '저장'}</button>
    </div>`;
  const { el, close } = openModal(html);
  const form = $('#evForm', el);

  const calOptions = () => {
    const opts = [['local', '이 PC에만 저장']];
    for (const c of writableCalendars()) opts.push([c.id, `Google · ${c.summary}${c.primary ? ' (기본)' : ''}`]);
    if (f.calendarId !== 'local' && !opts.some((o) => o[0] === f.calendarId)) opts.push([f.calendarId, 'Google · (연결 안 됨)']);
    return opts.map(([v, t]) => `<option value="${h(v)}" ${v === f.calendarId ? 'selected' : ''}>${h(t)}</option>`).join('');
  };
  const sel = (opts, v) => opts.map(([k, t]) => `<option value="${k}" ${String(v) === k ? 'selected' : ''}>${h(t)}</option>`).join('');

  const lunarPreview = () => {
    const r = lunarToSolar(f.lYear, f.lMonth, f.lDay, f.leap);
    if (!r) return `<div class="warn">${f.lYear}년 음력 ${f.leap ? '윤' : ''}${f.lMonth}월 ${f.lDay}일은 변환할 수 없습니다 (지원 범위 1000~2050년).</div>`;
    const dates = [];
    if (f.repeat === 'lunarYearly') {
      const y0 = Math.max(f.lYear, D.parts(today).y);
      for (let y = y0; y < y0 + 6 && y <= LUNAR_MAX_YEAR; y++) {
        const x = lunarToSolar(y, f.lMonth, f.lDay, f.leap);
        if (x) dates.push(`${D.label(x.date)}${x.adjusted ? ' *' : ''}`);
      }
    } else dates.push(`${D.label(r.date)}${r.adjusted ? ' *' : ''}`);
    const adj = /\*/.test(dates.join('')) ? '<span class="note">* 해당 연도에 윤달이나 30일이 없어 평달·29일로 맞춘 날짜</span>' : '';
    const g =
      f.calendarId !== 'local'
        ? `<span class="note">Google 캘린더에는 ${f.repeat === 'lunarYearly' ? `앞으로 ${settings().lunarYears}년치를 연도별 양력 날짜로 각각 등록합니다.` : '위 양력 날짜로 등록합니다.'}</span>`
        : '';
    return `<b>양력 환산${f.repeat === 'lunarYearly' ? ' 미리보기' : ''}</b><div class="dates">${dates.map((d) => `<span>${d}</span>`).join('')}</div>${adj}${g}`;
  };

  const draw = () => {
    const isL = f.calType === 'lunar';
    const repOpts = isL
      ? [['none', '반복 안 함'], ['lunarYearly', '매년 (음력 기준)']]
      : [['none', '반복 안 함'], ['daily', '매일'], ['weekly', '매주'], ['monthly', '매월'], ['yearly', '매년']];
    const yearOpts = [];
    for (let y = D.parts(today).y - 5; y <= Math.min(LUNAR_MAX_YEAR, D.parts(today).y + 10); y++) yearOpts.push([String(y), `${y}년`]);
    if (!yearOpts.some((o) => +o[0] === f.lYear)) yearOpts.unshift([String(f.lYear), `${f.lYear}년`]);
    form.innerHTML = `
      ${readonly ? '<div class="note">읽기 전용 캘린더의 일정입니다.</div>' : ''}
      <div class="fld"><label class="lbl" for="e-title">제목</label><input class="inp" id="e-title" value="${h(f.title)}" ${readonly ? 'disabled' : ''}></div>
      ${
        isL
          ? `<div class="grid3" style="grid-template-columns: 1.1fr 1fr 1fr auto">
              <div class="fld"><label class="lbl" for="e-ly">${f.repeat === 'lunarYearly' ? '시작 연도' : '연도'}</label><select class="inp" id="e-ly">${sel(yearOpts, f.lYear)}</select></div>
              <div class="fld"><label class="lbl" for="e-lm">음력 월</label><select class="inp" id="e-lm">${sel(Array.from({ length: 12 }, (_, i) => [String(i + 1), `${i + 1}월`]), f.lMonth)}</select></div>
              <div class="fld"><label class="lbl" for="e-ld">음력 일</label><select class="inp" id="e-ld">${sel(Array.from({ length: 30 }, (_, i) => [String(i + 1), `${i + 1}일`]), f.lDay)}</select></div>
              <label class="checkline" style="height:40px"><input type="checkbox" id="e-leap" ${f.leap ? 'checked' : ''} style="accent-color:var(--lunar)">윤달</label>
            </div>`
          : `<div class="grid2">
              <div class="fld"><label class="lbl" for="e-date">시작일</label><input type="date" class="inp" id="e-date" value="${f.date}" ${readonly || recurringExt ? 'disabled' : ''}></div>
              <div class="fld"><label class="lbl" for="e-end">종료일</label><input type="date" class="inp" id="e-end" value="${f.endDate}" min="${f.date}" ${readonly || recurringExt ? 'disabled' : ''}></div>
            </div>`
      }
      ${
        auto.from
          ? `<div class="note" id="e-autonote">이전 일정 "${h(auto.from)}"을(를) 참고해 ${[auto.filledPlace && '장소', auto.filledPeople && '참여 인원'].filter(Boolean).join('·')}을(를) 채웠습니다. <button type="button" class="linkbtn" data-autoclear>지우기</button></div>`
          : ''
      }
      <div class="fld"><label class="lbl" for="e-place">장소</label><input class="inp" id="e-place" list="dl-places" value="${h(f.place)}" placeholder="장소 또는 주소" ${readonly ? 'disabled' : ''}>
        <datalist id="dl-places">${knownPlaces().map((p) => `<option value="${h(p)}"></option>`).join('')}</datalist></div>
      <div class="fld"><label class="lbl" for="e-people">참여 인원</label>
        <div class="chipsbox" id="e-chips">${f.people
          .map((p, i) => `<span class="person">${h(p)}${readonly ? '' : `<button type="button" data-rmp="${i}" aria-label="${h(p)} 삭제">×</button>`}</span>`)
          .join('')}${readonly ? '' : '<input id="e-people" list="dl-people" placeholder="이름 입력 후 Enter">'}</div>
        <datalist id="dl-people">${knownPeople().filter((p) => !f.people.includes(p)).map((p) => `<option value="${h(p)}"></option>`).join('')}</datalist>
        ${f.calendarId !== 'local' ? '<span class="note">장소와 참여 인원은 Google 일정의 설명란에 함께 기록됩니다 (초대는 보내지 않음).</span>' : ''}
      </div>
      ${
        ext
          ? ''
          : `<div class="grid2">
              <div class="fld"><label class="lbl" for="e-rep">반복</label><select class="inp" id="e-rep">${sel(repOpts, f.repeat)}</select></div>
              <div class="fld"><label class="lbl" for="e-alarm">알림</label><select class="inp" id="e-alarm">${sel(f.allDay ? ALARMS_ALLDAY : ALARMS_TIMED, f.alarm)}</select></div>
            </div>
            ${isL ? `<div class="preview" id="e-prev">${lunarPreview()}</div>` : ''}`
      }
      ${ev && ev.repeat !== 'none' ? '<div class="note">반복 일정을 수정하면 반복 전체에 적용됩니다.</div>' : ''}
      <div class="grid2" style="align-items:end">
        <div class="fld"><span class="lbl">시간</span>
          <label class="checkline boxed"><input type="checkbox" id="e-allday" ${f.allDay ? 'checked' : ''} ${readonly || recurringExt ? 'disabled' : ''}>종일</label>
        </div>
        ${
          f.allDay
            ? '<div></div>'
            : `<div class="row gap8">
                <div class="fld grow"><label class="lbl" for="e-st">시작</label><input type="time" class="inp" id="e-st" value="${f.startTime}" ${readonly || recurringExt ? 'disabled' : ''}></div>
                <div class="fld grow"><label class="lbl" for="e-et">종료</label><input type="time" class="inp" id="e-et" value="${f.endTime}" ${readonly || recurringExt ? 'disabled' : ''}></div>
              </div>`
        }
      </div>
      ${recurringExt ? '<div class="note">Google 반복 일정입니다. 제목·메모·장소·참여 인원 변경은 반복 전체에 적용되며, 날짜와 시간은 Google 캘린더에서 바꾸세요.</div>' : ''}
      ${
        ext
          ? ''
          : `<div class="fld"><span class="lbl">날짜 기준</span>
        <div class="radio2 lunar" role="radiogroup">
          <label class="${!isL ? 'on' : ''}"><input type="radio" name="caltype" value="solar" ${!isL ? 'checked' : ''}>양력</label>
          <label class="${isL ? 'on l' : ''}"><input type="radio" name="caltype" value="lunar" ${isL ? 'checked' : ''} style="accent-color:var(--lunar)">음력</label>
        </div></div>`
      }
      ${ev?.syncError ? `<div class="warn">Google 동기화 대기 중: ${h(ev.syncError)}</div>` : ''}
      <div class="fld"><label class="lbl" for="e-memo">메모</label><textarea class="inp" id="e-memo" rows="3" ${readonly ? 'disabled' : ''}>${h(f.memo)}</textarea></div>
      ${
        ext
          ? `<div class="note">캘린더: Google · ${h(g.calendarName)}</div>`
          : `<div class="fld"><label class="lbl" for="e-cal">캘린더</label><select class="inp" id="e-cal">${calOptions()}</select>
              ${!S.g.connected ? '<span class="note">Google 캘린더를 연결하면 Google에 저장할 수 있습니다 (설정).</span>' : ''}
            </div>`
      }
      <div class="err" id="e-err"></div>`;
  };
  draw();
  $('#e-title', form)?.focus();

  const addPerson = () => {
    const inp = $('#e-people', form);
    if (!inp) return;
    const names = inp.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (!names.length) return;
    f.people.push(...names.filter((n) => !f.people.includes(n)));
    auto.peopleTouched = true;
    auto.filledPeople = false;
    draw();
    $('#e-people', form)?.focus();
  };

  let autoTimer = null;
  const applyAuto = () => {
    if (!auto.on) return;
    const m = findSimilar(f.title);
    let changed = false;
    // 이전에 자동으로 채운 값은, 더 이상 맞는 일정이 없거나 다른 일정과 맞으면 다시 계산
    if (auto.filledPlace && !auto.placeTouched) {
      f.place = '';
      auto.filledPlace = false;
      changed = true;
    }
    if (auto.filledPeople && !auto.peopleTouched) {
      f.people = [];
      auto.filledPeople = false;
      changed = true;
    }
    auto.from = null;
    if (m) {
      if (!auto.placeTouched && !f.place && m.place) {
        f.place = m.place;
        auto.filledPlace = true;
      }
      if (!auto.peopleTouched && !f.people.length && m.people?.length) {
        f.people = [...m.people];
        auto.filledPeople = true;
      }
      if (auto.filledPlace || auto.filledPeople) {
        auto.from = m.title;
        changed = true;
      }
    }
    if (!changed) return;
    const t = $('#e-title', form);
    const focused = document.activeElement === t;
    const pos = t ? t.selectionStart : null;
    draw();
    if (focused) {
      const nt = $('#e-title', form);
      nt.focus();
      if (pos !== null) nt.setSelectionRange(pos, pos);
    }
  };

  form.addEventListener('input', (e) => {
    const id = e.target.id;
    if (id === 'e-title') {
      f.title = e.target.value;
      clearTimeout(autoTimer);
      autoTimer = setTimeout(applyAuto, 350);
    } else if (id === 'e-place') {
      f.place = e.target.value;
      auto.placeTouched = true;
      auto.filledPlace = false;
    }
    else if (id === 'e-people' && e.inputType === 'insertReplacementText') addPerson();
    else if (id === 'e-memo') f.memo = e.target.value;
    else if (id === 'e-st') {
      f.startTime = e.target.value;
      autoEndTime(f, form, f.startTime);
    }
    else if (id === 'e-et') f.endTime = e.target.value;
  });
  form.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'caltype') {
      f.calType = t.value;
      if (f.calType === 'lunar') {
        const l = solarToLunar(f.date);
        if (l) Object.assign(f, { lYear: D.parts(f.date).y, lMonth: l.month, lDay: l.day, leap: l.leap });
        f.repeat = 'lunarYearly';
      } else {
        const r = lunarToSolar(f.lYear, f.lMonth, f.lDay, f.leap);
        if (r) f.date = f.endDate = r.date;
        f.repeat = 'none';
      }
      draw();
    } else if (t.id === 'e-date') {
      const dur = D.diffDays(f.date, f.endDate);
      f.date = t.value || f.date;
      f.endDate = D.addDays(f.date, Math.max(0, dur));
      draw();
    } else if (t.id === 'e-end') {
      f.endDate = t.value && t.value >= f.date ? t.value : f.date;
      draw();
    } else if (t.id === 'e-allday') {
      f.allDay = t.checked;
      const opts = (f.allDay ? ALARMS_ALLDAY : ALARMS_TIMED).map((o) => o[0]);
      if (!opts.includes(f.alarm)) f.alarm = '';
      draw();
    } else if (t.id === 'e-rep') {
      f.repeat = t.value;
      draw();
    } else if (t.id === 'e-alarm') f.alarm = t.value;
    else if (t.id === 'e-cal') {
      f.calendarId = t.value;
      draw();
    } else if (['e-ly', 'e-lm', 'e-ld'].includes(t.id)) {
      f[{ 'e-ly': 'lYear', 'e-lm': 'lMonth', 'e-ld': 'lDay' }[t.id]] = +t.value;
      $('#e-prev', form).innerHTML = lunarPreview();
    } else if (t.id === 'e-leap') {
      f.leap = t.checked;
      $('#e-prev', form).innerHTML = lunarPreview();
    }
  });
  form.addEventListener('keydown', (e) => {
    if (e.target.id === 'e-people') {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addPerson();
      } else if (e.key === 'Backspace' && !e.target.value && f.people.length) {
        f.people.pop();
        auto.peopleTouched = true;
        auto.filledPeople = false;
        draw();
        $('#e-people', form)?.focus();
      }
    } else if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
      e.preventDefault();
    }
  });
  form.addEventListener('focusout', (e) => {
    if (e.target.id === 'e-people' && e.target.value.trim()) addPerson();
  });
  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rmp]');
    if (b) {
      f.people.splice(+b.dataset.rmp, 1);
      auto.peopleTouched = true;
      auto.filledPeople = false;
      draw();
      return;
    }
    if (e.target.closest('[data-autoclear]')) {
      if (auto.filledPlace) f.place = '';
      if (auto.filledPeople) f.people = [];
      auto.on = false;
      auto.from = null;
      draw();
    }
  });

  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return close();
    if (e.target.closest('[data-open-g]')) return window.api.openExternal(g.htmlLink);
    if (e.target.closest('[data-del]')) {
      const ok = ev ? await deleteLocalEvent(ev, occ) : await deleteExternal(g);
      if (ok) close();
      return;
    }
    if (e.target.closest('[data-save]')) {
      if (readonly) return close();
      const pi = $('#e-people', form);
      if (pi && pi.value.trim()) addPerson();
      const err = ext ? await saveExternal(g, f) : saveLocalEvent(ev, f);
      if (err) {
        $('#e-err', form).textContent = err;
        return;
      }
      close();
      if (!ev && !g) learnWords(f.title); // 새로 직접 추가한 일정 → 핵심 단어 배우기
      onSaved?.();
    }
  });
}

function saveLocalEvent(existing, f) {
  if (!f.title.trim()) return '제목을 입력하세요.';
  const ev = existing ? { ...existing } : { id: uid(), createdAt: Date.now(), exdates: [] };
  ev.title = f.title.trim();
  ev.calType = f.calType;
  if (f.calType === 'lunar') {
    const r = lunarToSolar(f.lYear, f.lMonth, f.lDay, f.leap);
    if (!r) return '음력 날짜를 양력으로 바꿀 수 없습니다. 날짜를 확인하세요.';
    ev.date = ev.endDate = r.date;
    ev.lunar = { month: f.lMonth, day: f.lDay, leap: f.leap, baseYear: f.lYear };
    ev.repeat = f.repeat === 'lunarYearly' ? 'lunarYearly' : 'none';
  } else {
    ev.date = f.date;
    ev.endDate = f.endDate >= f.date ? f.endDate : f.date;
    ev.repeat = f.repeat;
    delete ev.lunar;
  }
  ev.allDay = f.allDay;
  if (!f.allDay) {
    if (!f.startTime) return '시작 시각을 입력하세요.';
    ev.startTime = f.startTime;
    ev.endTime = f.endTime && (ev.endDate > ev.date || f.endTime > f.startTime) ? f.endTime : f.startTime;
  } else {
    ev.startTime = ev.endTime = null;
  }
  ev.alarm = f.alarm === '' ? null : Number(f.alarm);
  ev.place = f.place.trim();
  ev.people = f.people;
  ev.memo = f.memo;
  ev.updatedAt = Date.now();
  if (existing && (existing.calendarId !== f.calendarId || existing.calType !== ev.calType)) {
    const ids = remoteIds(existing);
    if (ids.length && existing.calendarId !== 'local') {
      for (const id of ids) settings().pendingDeletes.push({ calendarId: existing.calendarId, id });
    }
    ev.google = null;
  }
  if (existing && existing.date !== ev.date && ev.repeat === 'none') ev.exdates = [];
  ev.calendarId = f.calendarId;
  ev.sync = ev.calendarId === 'local' ? 'ok' : 'pending';
  settings().defaultCalendar = f.calendarId;

  remember(ev.title, ev.place, ev.people);
  const i = S.data.events.findIndex((x) => x.id === ev.id);
  if (i >= 0) S.data.events[i] = ev;
  else S.data.events.push(ev);
  save();
  renderAll();
  if (ev.calendarId !== 'local' || settings().pendingDeletes.length) {
    (async () => {
      const pd = settings().pendingDeletes.splice(0);
      for (const p of pd) await deleteRemote(p.calendarId, [p.id]);
      await pushEvent(ev);
      renderAll();
      if (ev.sync === 'pending' && S.g.connected) toast(`Google에 저장하지 못했습니다: ${ev.syncError}. 다음 동기화 때 다시 시도합니다.`);
    })();
  }
  return null;
}

async function deleteLocalEvent(ev, occ) {
  const repeating = ev.repeat && ev.repeat !== 'none';
  let mode = 'all';
  if (repeating && occ) {
    mode = await choose('반복 일정 삭제', `"${ev.title}"\n${D.label(occ)} 일정을 삭제합니다.`, [
      { label: '이 날짜만', value: 'one' },
      { label: '반복 전체', value: 'all', cls: 'danger' },
    ]);
  } else {
    mode = (await choose('일정 삭제', `"${ev.title}" 일정을 삭제할까요?`, [{ label: '삭제', value: 'all', cls: 'danger' }])) && 'all';
  }
  if (!mode) return false;
  if (mode === 'one') {
    ev.exdates = [...new Set([...(ev.exdates || []), occ])];
    ev.sync = ev.calendarId === 'local' ? 'ok' : 'pending';
    save();
    renderAll();
    if (ev.calendarId !== 'local') pushEvent(ev).then(renderAll);
    return true;
  }
  S.data.events = S.data.events.filter((x) => x.id !== ev.id);
  save();
  renderAll();
  if (ev.calendarId !== 'local') {
    const ids = remoteIds(ev);
    if (S.g.connected) deleteRemote(ev.calendarId, ids).then(save);
    else ids.forEach((id) => settings().pendingDeletes.push({ calendarId: ev.calendarId, id }));
  }
  return true;
}

async function saveExternal(g, f) {
  if (!f.title.trim()) return '제목을 입력하세요.';
  remember(f.title, f.place.trim(), f.people);
  const payload = { summary: f.title.trim(), description: composeDescription(f.memo, f.place.trim(), f.people) };
  let target = g.gid;
  if (g.recurringEventId) target = g.recurringEventId;
  else Object.assign(payload, timeRange(f.date, f.endDate, { allDay: f.allDay, startTime: f.startTime, endTime: f.endTime }));
  try {
    await gcall('patch', g.calendarId, target, payload);
  } catch (e) {
    return `Google 저장 실패: ${e.message}`;
  }
  await refreshGoogle();
  return null;
}

async function deleteExternal(g) {
  let target = g.gid;
  if (g.recurringEventId) {
    const mode = await choose('반복 일정 삭제', `"${g.title}"\n${D.label(g.date)} 일정을 삭제합니다.`, [
      { label: '이 날짜만', value: 'one' },
      { label: '반복 전체', value: 'all', cls: 'danger' },
    ]);
    if (!mode) return false;
    if (mode === 'all') target = g.recurringEventId;
  } else if (!(await choose('일정 삭제', `"${g.title}" 일정을 Google 캘린더에서 삭제할까요?`, [{ label: '삭제', value: 1, cls: 'danger' }]))) {
    return false;
  }
  try {
    await gcall('remove', g.calendarId, target);
  } catch (e) {
    toast(`삭제 실패: ${e.message}`);
    return false;
  }
  await refreshGoogle();
  return true;
}

/* ───────────── 할 일 로직 ───────────── */
const cloneSubs = (subs) => (subs || []).map((s) => ({ id: uid(), title: s.title, done: false }));

function makeInstance(t, due) {
  return {
    id: uid(),
    title: t.title,
    due,
    time: t.time || null,
    repeat: { ...t.repeat },
    genMode: t.genMode,
    showOnCalendar: t.showOnCalendar,
    alarm: todoAlarm(t),
    memo: t.memo || '',
    subtasks: cloneSubs(t.subtasks),
    seriesId: t.seriesId,
    anchor: t.anchor,
    createdAt: Date.now(),
    done: false,
  };
}

function ensureFixed() {
  const today = D.today();
  const groups = new Map();
  for (const t of S.data.todos) {
    if (!t.seriesId || !t.repeat || t.repeat.type === 'none' || t.genMode !== 'fixed') continue;
    if (!groups.has(t.seriesId)) groups.set(t.seriesId, []);
    groups.get(t.seriesId).push(t);
  }
  let changed = false;
  for (const g of groups.values()) {
    if (g.some((t) => t.seriesEnded)) continue;
    const dated = g.filter((t) => t.due).sort((a, b) => a.due.localeCompare(b.due));
    if (!dated.length) continue;
    const latest = dated[dated.length - 1];
    const tpl = [...dated].reverse().find((t) => !t.deleted) || latest;
    let cur = latest.due;
    for (let n = 0; n < 60; n++) {
      const nx = nextOccurrence(tpl.repeat, cur, tpl.anchor || dated[0].due);
      if (!nx || nx > today) break;
      S.data.todos.push(makeInstance(tpl, nx));
      cur = nx;
      changed = true;
    }
    const live = S.data.todos.filter((t) => t.seriesId === tpl.seriesId && !t.deleted);
    if (live.length && live.every((t) => t.done)) {
      const nx = nextOccurrence(tpl.repeat, cur, tpl.anchor || dated[0].due);
      if (nx) {
        S.data.todos.push(makeInstance(tpl, nx));
        changed = true;
      }
    }
  }
  return changed;
}

function toggleTodo(id, checked) {
  const t = S.data.todos.find((x) => x.id === id);
  if (!t) return;
  t.done = checked;
  t.doneAt = checked ? Date.now() : null;
  const rep = t.repeat && t.repeat.type !== 'none';
  if (checked && rep && (t.genMode !== 'fixed' || t.repeat.type === 'afterN') && !t.nextId) {
    const nx = t.repeat.type === 'afterN' ? D.addDays(D.today(), Math.max(1, t.repeat.interval || 1)) : nextOccurrence(t.repeat, t.due || D.today(), t.anchor || t.due);
    if (nx) {
      const n = makeInstance(t, nx);
      S.data.todos.push(n);
      t.nextId = n.id;
    }
  } else if (!checked && t.nextId) {
    const i = S.data.todos.findIndex((x) => x.id === t.nextId);
    const n = S.data.todos[i];
    if (n && !n.done && !n.touched && !(n.subtasks || []).some((s) => s.done)) {
      forgetTask(n);
      S.data.todos.splice(i, 1);
    }
    t.nextId = null;
  }
  if (rep && t.genMode === 'fixed') ensureFixed();
  save();
  renderAll();
}

function addQuickTodo(text) {
  const p = parseQuickAdd(text);
  if (!p.title) return;
  const t = {
    id: uid(),
    title: p.title,
    due: p.due,
    time: null,
    repeat: p.repeat,
    genMode: 'onComplete',
    showOnCalendar: true,
    memo: '',
    subtasks: [],
    createdAt: Date.now(),
    done: false,
  };
  if (p.repeat.type !== 'none') {
    t.seriesId = t.id;
    t.anchor = t.due || D.today();
  }
  S.data.todos.push(t);
  save();
  learnWords(t.title);
  renderAll();
}

/* ───────────── 할 일 창 ───────────── */
function openTodoDialog(existing = null, preset = null) {
  const today = D.today();
  const src = existing || preset || {};
  const f = {
    title: src.title || '',
    hasDue: !!src.due,
    due: src.due || today,
    time: src.time || '',
    repeat: { type: 'none', interval: 1, weekdays: [], monthDay: null, ...(src.repeat || {}) },
    genMode: src.genMode || 'onComplete',
    showOnCalendar: src.showOnCalendar ?? true,
    alarm: (() => {
      const a = existing ? todoAlarm(existing) : null;
      return a === null || a === undefined ? '' : String(a);
    })(),
    memo: src.memo || '',
    subtasks: (src.subtasks || []).map((s) => ({ ...s })),
  };
  if (!f.repeat.weekdays || !f.repeat.weekdays.length) f.repeat.weekdays = [D.dow(f.due)];
  if (!f.repeat.monthDay) f.repeat.monthDay = D.parts(f.due).d;

  const html = `
    <div class="mhead"><h1>${existing ? '할 일 수정' : '새 할 일'}</h1><button type="button" class="btn ghost icon" data-close aria-label="닫기">✕</button></div>
    <form class="mbody" id="tdForm" autocomplete="off"></form>
    <div class="mfoot">
      ${existing ? '<button type="button" class="btn danger" data-del>삭제</button>' : ''}
      <div class="spacer"></div>
      <span class="note">Ctrl+Enter 저장</span>
      <button type="button" class="btn" data-close>취소</button>
      <button type="button" class="btn primary" data-save title="Ctrl+Enter 또는 Ctrl+S">저장</button>
    </div>`;
  const { el, close } = openModal(html, { cls: '' });
  const form = $('#tdForm', el);
  const REP = [
    ['none', '안 함'],
    ['daily', '매일'],
    ['weekdays', '평일'],
    ['weekly', '매주'],
    ['monthly', '매월'],
    ['yearly', '매년'],
    ['afterN', '완료 후 N일'],
  ];
  const preview = () => {
    const r = f.repeat;
    if (r.type === 'none' || r.type === 'afterN' || !f.hasDue) return '';
    const anchor = existing?.anchor && existing.repeat?.type === r.type ? existing.anchor : f.due;
    const out = [];
    let cur = f.due;
    for (let i = 0; i < 3; i++) {
      cur = nextOccurrence(r, cur, anchor);
      if (!cur) break;
      out.push(D.shortLabel(cur));
    }
    return out.length ? `<span class="note">다음 회차: ${out.join(' · ')}</span>` : '';
  };
  const draw = () => {
    const r = f.repeat;
    const n = r.interval || 1;
    let detail = '';
    if (r.type === 'daily') detail = `<div class="row gap8 wrap"><input class="inp" id="t-int" type="number" min="1" max="365" value="${n}" style="width:70px;text-align:center" aria-label="간격"><span>일마다</span></div>`;
    else if (r.type === 'weekly')
      detail = `<div class="row gap8 wrap"><input class="inp" id="t-int" type="number" min="1" max="52" value="${n}" style="width:70px;text-align:center" aria-label="간격"><span>주마다</span>
        <div class="pills">${[1, 2, 3, 4, 5, 6, 0]
          .map((d) => `<button type="button" class="pill sm ${r.weekdays.includes(d) ? 'on' : ''}" data-wd="${d}" aria-pressed="${r.weekdays.includes(d)}">${D.DOW_KO[d]}</button>`)
          .join('')}</div></div>`;
    else if (r.type === 'monthly')
      detail = `<div class="row gap8 wrap"><span>매</span><input class="inp" id="t-int" type="number" min="1" max="24" value="${n}" style="width:70px;text-align:center" aria-label="간격"><span>개월마다</span>
        <select class="inp" id="t-md" aria-label="반복 기준일">${[...Array.from({ length: 31 }, (_, i) => [String(i + 1), `${i + 1}일`]), ['last', '말일']]
          .map(([v, t]) => `<option value="${v}" ${String(r.monthDay) === v ? 'selected' : ''}>${t}</option>`)
          .join('')}</select></div>${r.monthDay !== 'last' && r.monthDay > 28 ? '<span class="note">해당 날짜가 없는 달은 말일로 잡힙니다.</span>' : ''}`;
    else if (r.type === 'yearly') detail = `<div class="row gap8 wrap"><input class="inp" id="t-int" type="number" min="1" max="10" value="${n}" style="width:70px;text-align:center" aria-label="간격"><span>년마다 (기한일 기준)</span></div>`;
    else if (r.type === 'afterN') detail = `<div class="row gap8 wrap"><span>완료한 날로부터</span><input class="inp" id="t-int" type="number" min="1" max="365" value="${n}" style="width:70px;text-align:center" aria-label="일수"><span>일 뒤에 다시</span></div>`;
    const gen =
      r.type !== 'none' && r.type !== 'afterN'
        ? `<div class="col" style="display:flex;flex-direction:column;gap:6px;font-size:13px">
            <label class="checkline"><input type="radio" name="gen" value="onComplete" ${f.genMode === 'onComplete' ? 'checked' : ''}>완료하면 다음 회차 생성</label>
            <label class="checkline"><input type="radio" name="gen" value="fixed" ${f.genMode === 'fixed' ? 'checked' : ''}>완료 여부와 관계없이 날짜마다 생성</label>
          </div>`
        : '';
    form.innerHTML = `
      <div class="fld"><label class="lbl" for="t-title">할 일</label><input class="inp" id="t-title" value="${h(f.title)}"></div>
      <div class="fld"><span class="lbl">기한</span>
        <div class="radio2" role="radiogroup">
          <label class="${!f.hasDue ? 'on' : ''}"><input type="radio" name="due" value="0" ${!f.hasDue ? 'checked' : ''}>기한 없음</label>
          <label class="${f.hasDue ? 'on' : ''}"><input type="radio" name="due" value="1" ${f.hasDue ? 'checked' : ''}>날짜 지정</label>
        </div></div>
      ${
        f.hasDue
          ? `<div class="grid2">
              <div class="fld"><label class="lbl" for="t-due">기한일</label><input type="date" class="inp" id="t-due" value="${f.due}"></div>
              <div class="fld"><label class="lbl" for="t-time">시간 (선택)</label><input type="time" class="inp" id="t-time" value="${f.time}"></div>
            </div>
            <div class="fld"><label class="lbl" for="t-alarm">알림 <span class="muted" style="font-weight:400">(이 컴퓨터에서만)</span></label>
              <select class="inp" id="t-alarm">${(f.time ? TODO_ALARMS_TIMED : TODO_ALARMS_DATE)
                .map(([v, t]) => `<option value="${v}" ${f.alarm === v ? 'selected' : ''}>${t}</option>`)
                .join('')}</select></div>`
          : ''
      }
      <div class="fld"><span class="lbl">반복</span>
        <div class="pills">${REP.map(([k, t]) => `<button type="button" class="pill ${r.type === k ? 'on' : ''}" data-rep="${k}" aria-pressed="${r.type === k}">${t}</button>`).join('')}</div>
      </div>
      ${r.type !== 'none' ? `<div class="bluebox">${detail}${gen}${preview()}</div>` : ''}
      <div class="fld"><span class="lbl">하위 할 일</span>
        <div style="display:flex;flex-direction:column;border:1px solid var(--line2);border-radius:6px">
          ${f.subtasks
            .map(
              (s, i) => `<div class="row gap8" style="height:38px;padding:0 6px 0 12px;border-bottom:1px solid #EEECE7">
                <input type="checkbox" data-sdone="${i}" ${s.done ? 'checked' : ''} aria-label="완료" style="width:16px;height:16px;margin:0;accent-color:var(--accent)">
                <input class="grow" data-stitle="${i}" value="${h(s.title)}" aria-label="하위 할 일" style="border:0;height:30px;outline-offset:0;${s.done ? 'text-decoration:line-through;color:var(--faint)' : ''}">
                <button type="button" class="btn ghost icon" data-sdel="${i}" aria-label="삭제" style="width:28px;height:28px">×</button>
              </div>`
            )
            .join('')}
          <input id="t-subnew" placeholder="+ 하위 할 일 입력 후 Enter" style="height:38px;border:0;padding:0 12px;border-radius:0 0 6px 6px">
        </div>
        ${f.repeat.type !== 'none' ? '<span class="note">반복 할 일은 다음 회차에 하위 항목이 미완료 상태로 함께 생성됩니다.</span>' : ''}
      </div>
      <label class="checkline" style="justify-content:space-between">
        <span style="display:flex;flex-direction:column;gap:2px"><span>왼쪽 캘린더에 표시</span><span class="note">기한이 있는 할 일만 해당</span></span>
        <input type="checkbox" id="t-cal" ${f.showOnCalendar ? 'checked' : ''}>
      </label>
      <div class="fld"><label class="lbl" for="t-memo">메모</label><textarea class="inp" id="t-memo" rows="3">${h(f.memo)}</textarea></div>
      <div class="err" id="t-err"></div>`;
  };
  draw();
  $('#t-title', form).focus();

  const addSub = () => {
    const inp = $('#t-subnew', form);
    const v = inp.value.trim();
    if (!v) return;
    f.subtasks.push({ id: uid(), title: v, done: false });
    draw();
    $('#t-subnew', form).focus();
  };

  form.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 't-title') f.title = t.value;
    else if (t.id === 't-memo') f.memo = t.value;
    else if (t.id === 't-time') f.time = t.value;
    else if (t.dataset.stitle !== undefined) f.subtasks[+t.dataset.stitle].title = t.value;
  });
  form.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'due') {
      f.hasDue = t.value === '1';
      if (!f.hasDue && !['none', 'afterN'].includes(f.repeat.type)) f.repeat.type = 'none';
      draw();
    } else if (t.id === 't-due') {
      f.due = t.value || today;
      draw();
    } else if (t.id === 't-time') {
      // 시간을 넣거나 지우면 알림 선택지가 바뀜
      const had = !!form.querySelector('#t-alarm option[value="0"]'); // 지금 보이는 알림 목록이 '시간 있음' 목록인지
      f.time = t.value;
      if (had !== !!f.time) {
        const opts = (f.time ? TODO_ALARMS_TIMED : TODO_ALARMS_DATE).map((o) => o[0]);
        if (!opts.includes(f.alarm)) f.alarm = f.time && f.alarm === '' ? '' : f.time ? '0' : '';
        draw();
      }
    } else if (t.id === 't-alarm') {
      f.alarm = t.value;
    } else if (t.id === 't-int') {
      f.repeat.interval = Math.max(1, parseInt(t.value, 10) || 1);
      draw();
    } else if (t.id === 't-md') {
      f.repeat.monthDay = t.value === 'last' ? 'last' : +t.value;
      draw();
    } else if (t.name === 'gen') f.genMode = t.value;
    else if (t.id === 't-cal') f.showOnCalendar = t.checked;
    else if (t.dataset.sdone !== undefined) {
      f.subtasks[+t.dataset.sdone].done = t.checked;
      draw();
    }
  });
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    e.preventDefault();
    if (e.target.id === 't-subnew') addSub();
  });
  form.addEventListener('click', (e) => {
    const rp = e.target.closest('[data-rep]');
    if (rp) {
      f.repeat.type = rp.dataset.rep;
      if (!['none', 'afterN'].includes(f.repeat.type) && !f.hasDue) {
        f.hasDue = true;
        f.due = today;
      }
      if (f.repeat.type === 'weekly' && !f.repeat.weekdays.length) f.repeat.weekdays = [D.dow(f.due)];
      draw();
      return;
    }
    const wd = e.target.closest('[data-wd]');
    if (wd) {
      const d = +wd.dataset.wd;
      const set = new Set(f.repeat.weekdays);
      set.has(d) ? set.delete(d) : set.add(d);
      if (!set.size) set.add(D.dow(f.due));
      f.repeat.weekdays = [...set];
      draw();
      return;
    }
    const sd = e.target.closest('[data-sdel]');
    if (sd) {
      f.subtasks.splice(+sd.dataset.sdel, 1);
      draw();
    }
  });

  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return close();
    if (e.target.closest('[data-del]')) {
      if (await deleteTodo(existing)) close();
      return;
    }
    if (e.target.closest('[data-save]')) {
      if ($('#t-subnew', form).value.trim()) addSub();
      if (!f.title.trim()) {
        $('#t-err', form).textContent = '할 일을 입력하세요.';
        return;
      }
      saveTodo(existing, f);
      if (!existing) learnWords(f.title);
      close();
    }
  });
}

function saveTodo(existing, f) {
  const t = existing || { id: uid(), createdAt: Date.now(), done: false };
  const prevRule = existing ? JSON.stringify(existing.repeat) : null;
  t.title = f.title.trim();
  t.due = f.hasDue ? f.due : null;
  t.time = f.hasDue && f.time ? f.time : null;
  const r = { type: f.repeat.type, interval: Math.max(1, f.repeat.interval || 1) };
  if (r.type === 'weekly') r.weekdays = f.repeat.weekdays;
  if (r.type === 'monthly') r.monthDay = f.repeat.monthDay;
  t.repeat = r;
  t.genMode = r.type === 'afterN' ? 'onComplete' : f.genMode;
  t.showOnCalendar = f.showOnCalendar;
  t.alarm = t.due && f.alarm !== '' ? Number(f.alarm) : null;
  t.memo = f.memo;
  t.subtasks = f.subtasks.filter((s) => s.title.trim()).map((s) => ({ ...s, title: s.title.trim() }));
  t.touched = true;
  if (r.type !== 'none') {
    if (!t.seriesId) t.seriesId = t.id;
    if (!existing || prevRule !== JSON.stringify(r) || !t.anchor) t.anchor = t.due || D.today();
  } else {
    t.seriesId = null;
    t.anchor = null;
  }
  if (!existing) S.data.todos.push(t);
  if (t.seriesId) {
    for (const o of S.data.todos) {
      if (o === t || o.seriesId !== t.seriesId || o.done || o.deleted) continue;
      Object.assign(o, { title: t.title, repeat: { ...r }, genMode: t.genMode, showOnCalendar: t.showOnCalendar, anchor: t.anchor, time: t.time, alarm: t.alarm });
    }
  }
  ensureFixed();
  save();
  renderAll();
}

async function deleteTodo(t) {
  const rep = t.repeat && t.repeat.type !== 'none';
  let mode;
  if (rep) {
    const fixed = t.genMode === 'fixed' && t.repeat.type !== 'afterN';
    mode = await choose('반복 할 일 삭제', `"${t.title}"`, [
      fixed ? { label: '이 항목만 삭제', value: 'one' } : { label: '이번 회차 건너뛰기', value: 'skip' },
      { label: '반복 전체 삭제', value: 'all', cls: 'danger' },
    ]);
  } else {
    mode = await choose('할 일 삭제', `"${t.title}"을(를) 삭제할까요?`, [{ label: '삭제', value: 'one', cls: 'danger' }]);
  }
  if (!mode) return false;
  if (mode === 'skip' && !t.done) {
    const nx = t.repeat.type === 'afterN' ? D.addDays(D.today(), Math.max(1, t.repeat.interval || 1)) : nextOccurrence(t.repeat, t.due || D.today(), t.anchor || t.due);
    if (nx) S.data.todos.push(makeInstance(t, nx));
  }
  if (mode === 'all') {
    for (const o of S.data.todos) {
      if (o.seriesId !== t.seriesId) continue;
      o.seriesEnded = true;
      if (!o.done) o.deleted = true;
    }
    t.deleted = true;
  } else t.deleted = true;
  // 반복이 아닌 삭제 항목은 실제로 제거 (고정 생성 반복만 날짜 기록용으로 남김)
  S.data.todos = S.data.todos.filter((o) => {
    const purge = o.deleted && !(o.seriesId && o.genMode === 'fixed' && !o.seriesEnded);
    if (purge) forgetTask(o);
    return !purge;
  });
  save();
  renderAll();
  return true;
}

/* ───────────── 설정 창 ───────────── */
async function openSettings() {
  const st = settings();
  const ver = await window.api.version();
  const info = await window.api.info();
  let prefs = await window.api.prefs.get();
  if (S.g.connected && S.g.tasks) {
    window.api.push.init().then((r) => {
      if (r.ok) {
        S.pushDevices = r.data.devices;
        const el = $('#s-phone');
        if (el) el.textContent = S.pushDevices.length ? `연결된 휴대폰: ${S.pushDevices.join(', ')}` : '연결된 휴대폰 없음 — 휴대폰 앱의 설정에서 "이 휴대폰으로 알림 받기"를 누르세요.';
      } else {
        const el = $('#s-phone');
        if (el) el.textContent = `휴대폰 알림 준비 실패: ${r.error}`;
      }
    });
  }
  const { el, close } = openModal(
    `<div class="mhead"><h1>설정</h1><button type="button" class="btn ghost icon" data-close aria-label="닫기">✕</button></div>
     <div class="mbody" id="setBody"></div>
     <div class="mfoot"><span class="note">버전 ${h(ver)}</span><div class="spacer"></div><button type="button" class="btn primary" data-close>닫기</button></div>`,
    { cls: 'wide', onClose: () => renderAll() }
  );
  const body = $('#setBody', el);
  let page = null; // null = 첫 화면(메뉴)
  const ext = (url, label) => `<button type="button" class="linkbtn" data-ext="${url}">${label}</button>`;
  const pages = () => {
    const g = S.g;
    const m = mailState();
    const kw = kwStore();
    const learned = Object.entries(kw.w || {}).filter(([, v]) => v.s > 0);
    return [
      {
        id: 'google',
        icon: '🔗',
        title: 'Google 계정',
        sum: g.connected ? `연결됨 · ${g.account || ''}` : '연결 안 됨',
        html: () =>
          g.connected
            ? `<div class="row gap8 wrap"><span class="small">계정 <b>${h(g.account || '알 수 없음')}</b></span><div class="spacer"></div><button type="button" class="btn danger" data-gdisconnect>연결 해제</button></div>
               <div class="kv"><span>캘린더</span><b class="ok">사용 중</b></div>
               <div class="kv"><span>할 일(Tasks)</span>${g.tasks ? '<b class="ok">사용 중</b>' : `<b class="err">권한 없음</b> ${ext('https://console.cloud.google.com/apis/library/tasks.googleapis.com', 'API 켜기')}`}</div>
               <div class="kv"><span>드라이브(휴대폰 공유)</span>${g.drive ? '<b class="ok">사용 중</b>' : `<b class="err">권한 없음</b> ${ext('https://console.cloud.google.com/apis/library/drive.googleapis.com', 'API 켜기')}`}</div>
               ${!g.tasks || !g.drive ? '<div class="row gap8"><button type="button" class="btn primary" data-greconnect>권한 추가 (다시 연결)</button><span class="small muted" id="s-gmsg2"></span></div>' : ''}`
            : `<ol class="steps">
                <li>${ext('https://console.cloud.google.com/projectcreate', 'Google Cloud')}에서 프로젝트 만들기</li>
                <li>${ext('https://console.cloud.google.com/apis/library/calendar-json.googleapis.com', 'Calendar API')} 켜기</li>
                <li>${ext('https://console.cloud.google.com/auth/overview', 'OAuth 동의 화면')}: 외부 · <b>프로덕션</b>으로 게시</li>
                <li>${ext('https://console.cloud.google.com/auth/clients', '클라이언트')} → <b>데스크톱 앱</b> ID 발급 후 아래에 붙여넣기</li>
              </ol>
              <div class="fld"><label class="lbl" for="s-cid">클라이언트 ID</label><input class="inp" id="s-cid" value="${h(g.clientId || '')}" placeholder="xxxxxxxx.apps.googleusercontent.com"></div>
              <div class="fld"><label class="lbl" for="s-sec">보안 비밀번호</label><input class="inp" id="s-sec" type="password" placeholder="${g.configured ? '저장됨 (바꿀 때만 입력)' : 'GOCSPX-…'}"></div>
              <div class="row gap8"><button type="button" class="btn primary" data-gconnect>연결</button><span class="small muted" id="s-gmsg"></span></div>`,
      },
      {
        id: 'cal',
        icon: '📅',
        title: '캘린더 · 표시',
        sum: `${st.showHolidays ? '공휴일' : ''}${st.showHolidays && st.showLunar ? ' · ' : ''}${st.showLunar ? '음력' : ''}${g.connected ? ` · 캘린더 ${cals().filter(isCalVisible).length}개` : ''}`,
        html: () => `
          ${
            g.connected && cals().length
              ? `<div class="lbl">표시할 캘린더</div><div class="callist">${cals()
                  .map(
                    (c) => `<label class="checkline small"><input type="checkbox" data-calvis="${h(c.id)}" ${isCalVisible(c) ? 'checked' : ''}><span class="cdot" style="display:inline-block;width:10px;height:10px;border-radius:99px;background:${h(c.color || '#999')}"></span>${h(c.summary)}${c.primary ? ' (기본)' : ''}${c.writable ? '' : ' · 읽기 전용'}</label>`
                  )
                  .join('')}</div>`
              : ''
          }
          <label class="checkline small"><input type="checkbox" id="s-hol" ${st.showHolidays ? 'checked' : ''}>공휴일 표시</label>
          <label class="checkline small"><input type="checkbox" id="s-lun" ${st.showLunar ? 'checked' : ''}>음력 날짜 표시</label>
          <div class="row gap8"><label class="small" for="s-ly">음력 반복 일정 등록 기간</label>
            <select class="inp" id="s-ly" style="width:auto;height:34px">${[5, 10, 20, 30].map((n) => `<option value="${n}" ${st.lunarYears === n ? 'selected' : ''}>${n}년</option>`).join('')}</select></div>`,
      },
      {
        id: 'phone',
        icon: '📱',
        title: '휴대폰 연동',
        sum: !g.connected || !g.tasks ? '사용 안 함' : `할 일 동기화 ${st.tasksSync !== false ? '켬' : '끔'}${S.pushDevices?.length ? ` · 알림 ${S.pushDevices.length}대` : ''}`,
        html: () =>
          g.connected && g.tasks
            ? `<label class="checkline small"><input type="checkbox" id="s-tasks" ${st.tasksSync !== false ? 'checked' : ''}>할 일을 Google Tasks와 동기화</label>
               <span class="note">시간·반복·알림은 이 PC에만 보관됩니다.</span>
               <span class="small ${S.taskError ? 'err' : 'muted'}" id="s-taskmsg">${S.taskError ? h(S.taskError) : S.taskSyncedAt ? `마지막 동기화 ${new Date(S.taskSyncedAt).toLocaleTimeString('ko-KR')}` : ''}</span>
               <div class="lbl" style="margin-top:6px">휴대폰 알림</div>
               <span class="small" id="s-phone">${S.pushDevices ? (S.pushDevices.length ? `연결된 휴대폰: ${h(S.pushDevices.join(', '))}` : '연결된 휴대폰 없음 (휴대폰 앱 설정에서 켜기)') : '확인 중…'}</span>
               <label class="checkline small"><input type="checkbox" id="s-phoneev" ${st.phoneEvents ? 'checked' : ''}>캘린더 일정 알림도 보내기</label>
               <span class="note">할 일 알림은 항상 보냅니다. PC 프로그램이 켜져 있을 때만 전달됩니다.</span>`
            : `<span class="note">Google 계정에서 할 일(Tasks) 권한을 먼저 추가하세요.</span><button type="button" class="btn" data-page="google">Google 계정 열기</button>`,
      },
      {
        id: 'team',
        icon: '👥',
        title: '팀 일정표',
        sum: S.data.team ? `${S.data.team.fileName}` : '가져온 일정표 없음',
        html: () => `
          <div class="row gap8 wrap"><label class="small" for="s-teamme">내 이름</label>
            <input class="inp" id="s-teamme" value="${h(st.teamMe || '')}" style="width:120px;height:34px">
            <button type="button" class="btn primary" data-teamimport>엑셀 가져오기</button></div>
          ${
            S.data.team
              ? `<div class="kv"><span>마지막 가져오기</span><b>${h(S.data.team.fileName)}</b></div>
                 <div class="kv"><span>휴대폰 앱</span><span id="s-teamphone" class="small ${phoneShareText().cls}">${h(phoneShareText().text)}</span><button type="button" class="btn" data-teamsend>다시 보내기</button></div>`
              : ''
          }
          <span class="note">내 일정만 캘린더에 등록하고, 팀원 일정은 날짜 오른쪽 클릭으로 봅니다.</span>`,
      },
      {
        id: 'mail',
        icon: '✉',
        title: '메일 일정 (Outlook)',
        sum: `자동 확인 ${m.enabled ? '켬' : '끔'} · 배운 단어 ${learned.length}개`,
        html: () => `
          <label class="checkline small"><input type="checkbox" id="s-mailauto" ${m.enabled ? 'checked' : ''}>30분마다 받은 편지함 확인</label>
          <div class="row gap8"><label class="small" for="s-maildays">확인 기간</label>
            <select class="inp" id="s-maildays" style="width:auto;height:34px">${[3, 7, 14, 30].map((d) => `<option value="${d}" ${m.days === d ? 'selected' : ''}>최근 ${d}일</option>`).join('')}</select></div>
          <span class="note">메일을 고르고 <b>Ctrl+Shift+E</b> → 일정·할 일로 바로 만들기</span>
          <div class="lbl" style="margin-top:6px">내 일정 단어 <span class="muted" style="font-weight:400">· 직접 저장한 제목에서 배움, 무시하면 점수 감소 (휴대폰과 공유)</span></div>
          <div class="kw-list">${
            learned
              .sort((a, b) => b[1].s - a[1].s)
              .map(([w, v]) => `<span class="kw">${h(w)} <small>${+v.s.toFixed(1)}</small><button type="button" data-kwdel="${h(w)}" aria-label="${h(w)} 지우기">×</button></span>`)
              .join('') || '<span class="small muted">아직 없음</span>'
          }</div>
          <div class="row gap8"><input class="inp" id="s-kwnew" placeholder="단어 추가" style="width:200px;height:34px"><button type="button" class="btn" data-kwadd>추가</button></div>
          <details class="kw-base"><summary class="small">기본 단어 켜기/끄기</summary><div class="kw-list">${BASE_KEYS.map(
            ([l]) => `<button type="button" class="kw b ${kw.off?.[l]?.v ? 'off' : ''}" data-kwoff="${h(l)}">${h(l)}</button>`
          ).join('')}</div></details>`,
      },
      {
        id: 'app',
        icon: '⚙',
        title: '프로그램',
        sum: `버전 ${ver}${prefs.autoStart ? ' · 자동 실행' : ''}`,
        html: () => `
          <label class="checkline small"><input type="checkbox" id="s-autostart" ${prefs.autoStart ? 'checked' : ''}>Windows 시작 시 자동 실행</label>
          <label class="checkline small"><input type="checkbox" id="s-tray" ${prefs.closeToTray ? 'checked' : ''}>창을 닫아도 트레이에서 실행 (알림 받기)</label>
          <div class="row gap8 wrap" style="margin-top:6px"><span class="small">버전 ${h(ver)}${info?.source === 'patch' ? ` <span class="muted">(설치본 ${h(info.bundledVersion)})</span>` : ''}</span><button type="button" class="btn" data-updcheck>업데이트 확인</button><span class="small muted" id="updMsg"></span></div>
          <div class="row gap8 wrap" style="margin-top:6px"><span class="small">데이터</span><button type="button" class="btn" data-export>백업</button><button type="button" class="btn" data-import>복원</button></div>
          <span class="note">할 일과 "이 PC에만" 일정은 이 컴퓨터에 저장됩니다.</span>`,
      },
    ];
  };
  const cals = () => S.calendars;
  const draw = () => {
    const ps = pages();
    const pg = ps.find((x) => x.id === page);
    $('.mhead h1', el).innerHTML = pg ? `<button type="button" class="btn ghost icon" data-page="" aria-label="뒤로">‹</button> ${h(pg.title)}` : '설정';
    body.innerHTML = pg
      ? `<div class="sect" style="border-top:0;padding-top:0">${pg.html()}</div>`
      : `<div class="setmenu">${ps
          .map((x) => `<button type="button" class="setrow" data-page="${x.id}"><span class="si">${x.icon}</span><span class="st"><b>${h(x.title)}</b><small>${h(x.sum)}</small></span><span class="sc">›</span></button>`)
          .join('')}</div>`;
    renderUpdate();
  };
  draw();

  body.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 's-mailauto') {
      mailState().enabled = t.checked;
      save();
      if (t.checked) scanMail();
      return;
    }
    if (t.id === 's-maildays') {
      mailState().days = +t.value;
      save();
      return;
    }
    if (t.id === 's-teamme') {
      st.teamMe = t.value.trim();
      save();
      return;
    }
    if (t.id === 's-phoneev') {
      st.phoneEvents = t.checked;
      save();
      return;
    }
    if (t.id === 's-tasks') {
      st.tasksSync = t.checked;
      save();
      if (t.checked) syncTasks();
      return;
    }
    if (t.id === 's-autostart' || t.id === 's-tray') {
      prefs = await window.api.prefs.set(t.id === 's-autostart' ? { autoStart: t.checked } : { closeToTray: t.checked });
      return;
    }
    if (t.dataset.calvis) {
      st.calendarVisibility[t.dataset.calvis] = t.checked;
      save();
      S.gRange = null;
      refreshGoogle();
    } else if (t.id === 's-ly') {
      st.lunarYears = +t.value;
      save();
      for (const ev of S.data.events) if (ev.calType === 'lunar' && ev.calendarId !== 'local') ev.sync = 'pending';
      refreshGoogle();
    } else if (t.id === 's-hol') {
      st.showHolidays = t.checked;
      save();
    } else if (t.id === 's-lun') {
      st.showLunar = t.checked;
      save();
    }
  });
  body.addEventListener('click', async (e) => {
    const ext = e.target.closest('[data-ext]');
    if (ext) return window.api.openExternal(ext.dataset.ext);
    if (e.target.closest('[data-page]')) return; // 페이지 이동은 아래(el)에서
    const kd = e.target.closest('[data-kwdel]');
    if (kd) {
      kwStore().w[kd.dataset.kwdel] = { s: 0, t: Date.now() };
      saveKw();
      return draw();
    }
    if (e.target.closest('[data-kwadd]')) {
      const w = $('#s-kwnew', body).value.trim().replace(/\s+/g, ' ');
      if (w.length < 2) return toast('두 글자 이상 입력하세요.');
      kwStore().w[w] = { s: Math.max(2, kwStore().w[w]?.s || 0), t: Date.now() };
      saveKw();
      return draw();
    }
    const ko = e.target.closest('[data-kwoff]');
    if (ko) {
      const kw = kwStore();
      kw.off ||= {};
      kw.off[ko.dataset.kwoff] = { v: !kw.off[ko.dataset.kwoff]?.v, t: Date.now() };
      saveKw();
      draw();
      $('.kw-base', body).open = true;
      return;
    }
    if (e.target.closest('[data-gconnect]')) {
      const msg = $('#s-gmsg', body);
      const id = $('#s-cid', body).value.trim();
      const sec = $('#s-sec', body).value.trim();
      if (!id || (!sec && !S.g.configured)) {
        msg.textContent = '클라이언트 ID와 보안 비밀번호를 입력하세요.';
        return;
      }
      let r = await window.api.google.setClient(id, sec);
      if (!r.ok) {
        msg.textContent = r.error;
        return;
      }
      msg.textContent = '브라우저에서 Google 로그인을 완료하세요…';
      r = await window.api.google.connect();
      if (!r.ok) {
        msg.textContent = `연결 실패: ${r.error}`;
        return;
      }
      S.g = r.data;
      for (const ev of S.data.events) if (ev.calendarId !== 'local' && ev.sync !== 'ok') ev.sync = 'pending';
      await refreshGoogle();
      draw();
      toast('Google 캘린더가 연결되었습니다.');
    }
    if (e.target.closest('[data-teamsend]')) {
      const el = $('#s-teamphone', body);
      if (el) el.textContent = '보내는 중…';
      await uploadTeamForPhone(true);
      return;
    }
    if (e.target.closest('[data-teamimport]')) {
      close();
      importTeam();
      return;
    }
    if (e.target.closest('[data-greconnect]')) {
      const msg = $('#s-gmsg2', body);
      msg.textContent = '브라우저에서 Google 로그인을 완료하세요…';
      const r = await window.api.google.connect();
      if (!r.ok) {
        msg.textContent = `연결 실패: ${r.error}`;
        return;
      }
      S.g = r.data;
      draw();
      if (S.data.team) uploadTeamForPhone(true);
      if (S.g.tasks) {
        toast('권한이 추가되었습니다.');
        await syncTasks();
        const pr = await window.api.push.init();
        if (pr.ok) S.pushDevices = pr.data.devices;
        draw();
      } else toast('할 일 권한이 승인되지 않았습니다. 로그인 화면에서 할 일 항목도 허용해 주세요.');
      return;
    }
    if (e.target.closest('[data-gdisconnect]')) {
      const ok = await choose('연결 해제', 'Google 캘린더 연결을 해제할까요?\n이미 Google에 등록된 일정은 그대로 남습니다.', [
        { label: '연결 해제', value: 1, cls: 'danger' },
      ]);
      if (!ok) return;
      const r = await window.api.google.disconnect();
      if (r.ok) S.g = r.data;
      S.gEvents = [];
      S.calendars = [];
      draw();
      renderAll();
    }
    if (e.target.closest('[data-updcheck]')) {
      S.update = { ...(S.update || {}), status: 'checking' };
      renderUpdate();
      S.update = await window.api.update.check();
      renderUpdate();
      return;
    }
    if (e.target.closest('[data-export]')) {
      if (await window.api.exportData(S.data)) toast('백업 파일을 저장했습니다.');
    }
    if (e.target.closest('[data-import]')) {
      try {
        const d = await window.api.importData();
        if (!d) return;
        const ok = await choose('가져오기', `일정 ${d.events.length}개, 할 일 ${d.todos.length}개를 불러옵니다.\n현재 데이터는 모두 바뀝니다.`, [
          { label: '불러오기', value: 1, cls: 'danger' },
        ]);
        if (!ok) return;
        d.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
        S.data = d;
        save();
        close();
        renderAll();
        refreshGoogle();
        toast('데이터를 불러왔습니다.');
      } catch (err) {
        toast(`가져오기 실패: ${err.message}`);
      }
    }
  });
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return close();
    const pgb = e.target.closest('[data-page]');
    if (pgb) {
      page = pgb.dataset.page || null;
      draw();
    }
  });
}

/* ───────────── 알림 ───────────── */
function checkAlarms() {
  const now = Date.now();
  const st = settings();
  const since = Math.max(st.lastAlarmCheck || now - 60000, now - 24 * 3600000);
  const today = D.today();
  const from = D.addDays(today, -1);
  const to = D.addDays(today, 8);
  const phone = (title, body, tab) => {
    if (!S.g.connected || !S.g.tasks) return;
    window.api.push.notify({ title, body, tag: `${title}|${body}`, tab }).catch(() => {});
  };
  const notify = (title, body) => {
    try {
      const n = new Notification(title, { body, requireInteraction: true });
      n.onclick = () => window.api.focus();
    } catch {
      /* 무시 */
    }
  };
  const fresh = (at) => now - at < 30 * 60000; // 휴대폰에는 30분 이내 알림만 (PC가 꺼져 있다 켜졌을 때 몰아서 보내지 않게)
  for (const ev of S.data.events) {
    if (ev.alarm === null || ev.alarm === undefined) continue;
    const local = ev.calendarId === 'local';
    if (!local && !st.phoneEvents) continue; // 구글 캘린더 일정은 구글 캘린더 앱 알림 사용(선택 시 휴대폰 앱으로도)
    for (const o of expandEvent(ev, from, to)) {
      const start = D.toDateTime(o.date, ev.allDay ? '00:00' : ev.startTime).getTime();
      const at = start - ev.alarm * 60000;
      if (!(at > since && at <= now)) continue;
      const body = `${D.label(o.date)}${ev.allDay ? '' : ` ${ev.startTime}`}${ev.place ? ` · ${ev.place}` : ''}`;
      if (local) notify(ev.title, body);
      if (fresh(at)) phone(ev.title, body, 'cal');
    }
  }
  for (const t of S.data.todos) {
    const alarm = todoAlarm(t);
    if (t.done || t.deleted || !t.due || alarm === null) continue;
    const at = D.toDateTime(t.due, t.time || '00:00').getTime() - alarm * 60000;
    if (!(at > since && at <= now)) continue;
    const body = `${t.due === D.today() ? '오늘' : D.label(t.due)}${t.time ? ` ${t.time}` : ''}까지`;
    notify(`할 일: ${t.title}`, body);
    if (fresh(at)) phone(`할 일: ${t.title}`, body, 'todo');
  }
  st.lastAlarmCheck = now;
}

/* ───────────── 드래그로 일정 옮기기 ───────────── */
function dateAtPoint(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    if (!el.closest('#calBody')) continue;
    const c = el.closest('.dbg, .dhead, .wbg, .wlist, .whead, .wcol');
    if (c) return c.dataset.date || c.dataset.goday || null;
  }
  return null;
}

const drag = { item: null, from: null, over: null };
function markDrop(date) {
  if (drag.over === date) return;
  drag.over = date;
  $$('#calBody .droptarget').forEach((x) => x.classList.remove('droptarget'));
  if (date) $$(`#calBody .dbg[data-date="${date}"], #calBody .wbg[data-date="${date}"]`).forEach((x) => x.classList.add('droptarget'));
}

async function moveItem(it, delta) {
  if (!delta) return;
  if (it.kind === 'todo') {
    it.t.due = D.addDays(it.t.due, delta);
    it.t.touched = true;
    save();
    renderAll();
    toast(`할 일을 ${D.shortLabel(it.t.due)}로 옮겼습니다.`);
    return;
  }
  if (it.kind === 'gevent') {
    const g = it.g;
    const payload = timeRange(D.addDays(g.date, delta), D.addDays(g.endDate, delta), { allDay: g.allDay, startTime: g.startTime, endTime: g.endTime });
    try {
      await gcall('patch', g.calendarId, g.gid, payload); // 반복 일정이면 이 날짜만 옮겨짐
    } catch (e) {
      toast(`옮기지 못했습니다: ${e.message}`);
      return;
    }
    await refreshGoogle();
    toast(`"${g.title}" 일정을 ${D.shortLabel(D.addDays(g.date, delta))}로 옮겼습니다.`);
    return;
  }
  // 이 프로그램의 일정
  const ev = it.ev;
  const occ = it.date;
  const newOcc = D.addDays(occ, delta);
  const repeating = ev.repeat && ev.repeat !== 'none';
  let mode = 'all';
  if (repeating) {
    mode = await choose('반복 일정 옮기기', `"${ev.title}"\n${D.label(occ)} → ${D.label(newOcc)}`, [
      { label: '이 날짜만', value: 'one' },
      { label: '반복 전체', value: 'all' },
    ]);
    if (!mode) return;
  }
  if (mode === 'one') {
    // 이 날짜는 반복에서 빼고, 옮긴 날짜에 단독 일정으로 새로 만듦
    ev.exdates = [...new Set([...(ev.exdates || []), occ])];
    ev.sync = ev.calendarId === 'local' ? 'ok' : 'pending';
    const dur = D.diffDays(it.date, it.endDate);
    const copy = {
      ...JSON.parse(JSON.stringify(ev)),
      id: uid(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      calType: 'solar',
      date: newOcc,
      endDate: D.addDays(newOcc, dur),
      repeat: 'none',
      exdates: [],
      google: null,
      sync: ev.calendarId === 'local' ? 'ok' : 'pending',
    };
    delete copy.lunar;
    S.data.events.push(copy);
    save();
    renderAll();
    if (ev.calendarId !== 'local') {
      await pushEvent(ev);
      await pushEvent(copy);
      renderAll();
    }
    return;
  }
  ev.date = D.addDays(ev.date, delta);
  ev.endDate = D.addDays(ev.endDate || ev.date, delta);
  if (ev.calType === 'lunar') {
    // 옮긴 날짜 기준으로 음력 월·일을 다시 계산
    const target = repeating ? newOcc : ev.date;
    const l = solarToLunar(target);
    if (l) ev.lunar = { ...ev.lunar, month: l.month, day: l.day, leap: l.leap, baseYear: repeating ? ev.lunar.baseYear : D.parts(target).y };
    if (repeating) {
      const r = lunarToSolar(ev.lunar.baseYear, ev.lunar.month, ev.lunar.day, ev.lunar.leap);
      if (r) ev.date = ev.endDate = r.date;
    }
  }
  ev.exdates = (ev.exdates || []).map((d) => D.addDays(d, delta));
  ev.updatedAt = Date.now();
  ev.sync = ev.calendarId === 'local' ? 'ok' : 'pending';
  save();
  renderAll();
  if (ev.calType === 'lunar' && ev.lunar) toast(`음력 ${ev.lunar.leap ? '윤' : ''}${ev.lunar.month}월 ${ev.lunar.day}일로 바뀌었습니다.`);
  if (ev.calendarId !== 'local') {
    await pushEvent(ev);
    renderAll();
  }
}

/* ───────────── 팀 일정표(엑셀) ───────────── */
async function importTeam() {
  const r = await window.api.team.open();
  if (!r.ok) return toast(`엑셀을 읽지 못했습니다: ${r.error}`);
  if (!r.data) return;
  let parsed;
  try {
    parsed = applyTeamEdits(parseTeamWorkbook(r.data.sheets));
  } catch (e) {
    return toast(e.message);
  }
  const names = [...new Set(parsed.flatMap((p) => p.people.map((x) => x.name)))];
  let me = settings().teamMe;
  if (!names.includes(me)) {
    me = await choose('내 이름 선택', '일정표에서 본인 이름을 골라 주세요.', names.map((n) => ({ label: n, value: n })));
    if (!me) return;
    settings().teamMe = me;
  }
  // 팀원 일정은 이 PC에만 보관 (오른쪽 클릭으로 보기)
  S.data.team = { fileName: r.data.fileName, importedAt: Date.now(), parsed };
  save();
  uploadTeamForPhone(true);
  previewTeamImport(parsed, me);
}

/** 팀 일정표를 휴대폰 앱에서 볼 수 있게 구글 드라이브의 앱 전용 숨김 공간에 올림 (캘린더·Tasks에는 올리지 않음) */
async function uploadTeamForPhone(manual = false, quiet = false) {
  const t = S.data.team;
  if (!t) return;
  const fail = (msg) => {
    t.phone = { ok: false, at: Date.now(), error: msg };
    t.uploadedAt = null;
    save();
    if (!quiet) toast(`팀 일정을 휴대폰으로 보내지 못했습니다: ${msg}`);
    renderPhoneShare();
  };
  if (!S.g.connected) return fail('Google에 연결되어 있지 않습니다. 설정에서 Google을 연결해 주세요.');
  if (!S.g.drive)
    return fail('드라이브 권한이 없습니다. 설정 → "드라이브 권한 추가 (다시 연결)"을 누르고 모든 항목을 허용해 주세요.');
  const names = [];
  const entries = [];
  const dd = (d) => d.replace(/-/g, '');
  for (const p of t.parsed) {
    for (const person of p.people) {
      let ni = names.indexOf(person.name);
      if (ni < 0) ni = names.push(person.name) - 1;
      for (const e of person.entries) entries.push([ni, e.work ? `${e.text} ${e.work}` : e.text, dd(e.start), dd(e.end), e.lead ? 1 : 0]);
    }
  }
  const blob = JSON.stringify({
    v: 1,
    me: settings().teamMe,
    file: t.fileName,
    asOf: t.parsed.map((p) => p.asOf).filter(Boolean)[0] || null,
    from: t.parsed.reduce((a, p) => (!a || p.from < a ? p.from : a), null),
    to: t.parsed.reduce((a, p) => (!a || p.to > a ? p.to : a), null),
    names,
    e: entries,
  });
  const r = await window.api.drive.save('team-schedule.json', blob);
  if (!r.ok) return fail(r.error);
  t.uploadedAt = Date.now();
  t.phone = { ok: true, at: t.uploadedAt };
  save();
  if (manual) toast('팀 일정을 휴대폰으로 보냈습니다. 휴대폰 앱에서 새로고침하세요.');
  renderPhoneShare();
}

/** 설정 화면의 "휴대폰으로 팀 일정 보내기" 상태 줄 */
function phoneShareText() {
  const t = S.data.team;
  if (!t) return { cls: 'muted', text: '가져온 팀 일정표가 없습니다.' };
  const p = t.phone;
  const when = (x) => new Date(x).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  if (p?.ok || (t.uploadedAt && !p)) return { cls: 'muted', text: `보냄: ${when(p?.at || t.uploadedAt)} (${t.fileName || '팀 일정표'})` };
  if (p && !p.ok) return { cls: 'err', text: `보내지 못함: ${p.error}` };
  return { cls: 'muted', text: '아직 보내지 않았습니다.' };
}
function renderPhoneShare() {
  const el = document.getElementById('s-teamphone');
  if (!el) return;
  const x = phoneShareText();
  el.className = `small ${x.cls}`;
  el.textContent = x.text;
}

function previewTeamImport(parsed, me) {
  const all = myEngagements(parsed, me);
  const from = parsed.reduce((a, p) => (!a || p.from < a ? p.from : a), null);
  const to = parsed.reduce((a, p) => (!a || p.to > a ? p.to : a), null);
  let cutoff = settings().teamCutoff && settings().teamCutoff >= from && settings().teamCutoff <= to ? settings().teamCutoff : to;
  const label = { new: '새 일정', changed: '변경', removed: '일정표에서 빠짐', same: '변경 없음' };
  const color = { new: 'var(--accent)', changed: '#B26B00', removed: 'var(--sun)', same: 'var(--faint)' };
  const fmt = (a, b) => (a === b ? D.shortLabel(a) : `${D.shortLabel(a)} ~ ${D.shortLabel(b)}`);
  let rows = [];

  // 반영 기한 이후는 제외 (기한을 넘는 일정은 기한까지만)
  const build = () => {
    const mine = all
      .filter((m) => m.start <= cutoff)
      .map((m) => (m.end > cutoff ? { ...m, end: cutoff, cut: true } : m));
    const existing = S.data.events.filter((e) => e.team);
    const used = new Set();
    rows = [];
    for (const m of mine) {
      const ex = existing.find((e) => !used.has(e) && sameClient(e.team.client, m.client) && e.date <= m.end && m.start <= e.endDate);
      if (ex) {
        used.add(ex);
        const same = ex.date === m.start && ex.endDate === m.end && JSON.stringify(ex.people || []) === JSON.stringify(m.people);
        rows.push({ kind: same ? 'same' : 'changed', m, ex });
      } else rows.push({ kind: 'new', m });
    }
    for (const e of existing) {
      if (!used.has(e) && e.date >= from && e.date <= cutoff) rows.push({ kind: 'removed', ex: e });
    }
    rows.sort((a, b) => (a.m?.start || a.ex.date).localeCompare(b.m?.start || b.ex.date));
    return mine.length;
  };

  const cals = [['local', '이 PC에만 저장'], ...writableCalendars().map((c) => [c.id, `Google · ${c.summary}${c.primary ? ' (기본)' : ''}`])];
  const calId = defaultCalendarId();
  const { el, close } = openModal(
    `<div class="mhead"><h1>팀 일정표 가져오기 — ${h(me)}</h1><button type="button" class="btn ghost icon" data-close aria-label="닫기">✕</button></div>
     <div class="mbody">
       <div class="small">${h(parsed.map((p) => `${p.title || p.sheet}${p.asOf ? ` (${D.shortLabel(p.asOf)} 현재)` : ''}`).join(', '))} · 일정표 기간 ${h(fmt(from, to))}</div>
       <div class="grid2">
         <div class="fld"><label class="lbl" for="ti-cut">반영 기한 (이 날짜까지만 반영)</label><input type="date" class="inp" id="ti-cut" value="${cutoff}" min="${from}" max="${to}"></div>
         <div class="fld"><label class="lbl" for="ti-cal">등록할 캘린더</label><select class="inp" id="ti-cal">${cals
           .map(([v, t]) => `<option value="${h(v)}" ${v === calId ? 'selected' : ''}>${h(t)}</option>`)
           .join('')}</select></div>
       </div>
       <div class="note">내가 참여하는 일정만 등록됩니다. 참여 인원은 같은 기간에 같은 회사 일정이 있는 팀원, 인차지(*)는 메모에 적습니다. 반영 기한 이후의 일정은 등록·변경·삭제하지 않습니다. 다른 팀원 일정은 캘린더에 등록하지 않고 이 PC에만 보관합니다.</div>
       <div class="small" id="ti-sum"></div>
       <div id="ti-list" style="display:flex;flex-direction:column;border:1px solid var(--line);border-radius:8px;max-height:42vh;overflow:auto"></div>
     </div>
     <div class="mfoot"><div class="spacer"></div><button type="button" class="btn" data-close>취소</button><button type="button" class="btn primary" data-apply>적용</button></div>`,
    { cls: 'wide' }
  );
  const drawList = () => {
    const n = build();
    const counts = { new: 0, changed: 0, removed: 0, same: 0 };
    rows.forEach((x) => counts[x.kind]++);
    $('#ti-sum', el).textContent = `${D.shortLabel(cutoff)}까지 내 일정 ${n}건 — 새 일정 ${counts.new} · 변경 ${counts.changed} · 빠짐 ${counts.removed} · 변경 없음 ${counts.same}`;
    $('#ti-list', el).innerHTML =
      rows
        .map(
          (x, i) => `<label class="row gap10" style="padding:8px 12px;border-bottom:1px solid #EEECE7;align-items:flex-start;${x.kind === 'same' ? 'opacity:.6' : ''}">
            <input type="checkbox" data-ti="${i}" ${x.kind === 'same' ? 'disabled' : 'checked'} style="margin-top:3px;width:16px;height:16px;accent-color:var(--accent)">
            <span class="grow" style="display:flex;flex-direction:column;gap:2px">
              <span><b style="color:${color[x.kind]};font-size:12px;margin-right:6px">${label[x.kind]}</b>${h(x.m ? x.m.title : x.ex.title)}</span>
              <span class="xs muted">${
                x.m
                  ? `${fmt(x.m.start, x.m.end)}${x.m.cut ? ' (반영 기한까지만)' : ''}${
                      x.kind === 'changed' && (x.ex.date !== x.m.start || x.ex.endDate !== x.m.end) ? ` (기존 ${fmt(x.ex.date, x.ex.endDate)})` : ''
                    } · 참여: ${h(x.m.people.join(', ') || '없음')}${x.m.leader ? ` · 인차지: ${h(x.m.leader)}` : ''}`
                  : `${fmt(x.ex.date, x.ex.endDate)} · 체크하면 캘린더에서 삭제`
              }</span>
            </span></label>`
        )
        .join('') || '<div class="empty">반영할 일정이 없습니다.</div>';
  };
  drawList();
  el.addEventListener('change', (e) => {
    if (e.target.id !== 'ti-cut') return;
    const v = e.target.value;
    cutoff = v && v >= from ? (v > to ? to : v) : from;
    drawList();
  });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return close();
    if (!e.target.closest('[data-apply]')) return;
    const cal = $('#ti-cal', el).value;
    const picked = $$('[data-ti]', el).filter((c) => c.checked).map((c) => rows[+c.dataset.ti]);
    settings().teamCutoff = cutoff;
    close();
    await applyTeamImport(picked, cal);
  });
}

function teamMemo(m) {
  return [m.leader ? `인차지: ${m.leader}` : '', `팀 일정표${m.asOf ? `(${D.shortLabel(m.asOf)} 현재)` : ''}에서 가져옴`].filter(Boolean).join('\n');
}

async function applyTeamImport(picked, calendarId) {
  const touched = [];
  for (const x of picked) {
    if (x.kind === 'removed') {
      S.data.events = S.data.events.filter((e) => e !== x.ex);
      if (x.ex.calendarId !== 'local') {
        const ids = remoteIds(x.ex);
        if (S.g.connected) await deleteRemote(x.ex.calendarId, ids);
        else ids.forEach((id) => settings().pendingDeletes.push({ calendarId: x.ex.calendarId, id }));
      }
      continue;
    }
    const m = x.m;
    if (x.kind === 'changed') {
      const ev = x.ex;
      ev.date = m.start;
      ev.endDate = m.end;
      ev.people = m.people;
      ev.memo = teamMemo(m);
      ev.team = { client: m.client, key: m.key, asOf: m.asOf };
      ev.updatedAt = Date.now();
      ev.sync = ev.calendarId === 'local' ? 'ok' : 'pending';
      touched.push(ev);
      continue;
    }
    const sim = findSimilar(m.title);
    const ev = {
      id: uid(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      title: m.title,
      calType: 'solar',
      date: m.start,
      endDate: m.end,
      allDay: true,
      startTime: null,
      endTime: null,
      repeat: 'none',
      alarm: null,
      place: sim?.place || '',
      people: m.people,
      memo: teamMemo(m),
      exdates: [],
      calendarId,
      sync: calendarId === 'local' ? 'ok' : 'pending',
      team: { client: m.client, key: m.key, asOf: m.asOf },
    };
    remember(ev.title, ev.place, ev.people);
    S.data.events.push(ev);
    touched.push(ev);
  }
  save();
  renderAll();
  for (const ev of touched) if (ev.calendarId !== 'local') await pushEvent(ev);
  renderAll();
  toast(`팀 일정표를 반영했습니다. (${picked.length}건)`);
}

/** 오른쪽 클릭 메뉴 */
function openContextMenu(x, y, date) {
  $('#ctxMenu')?.remove();
  const m = document.createElement('div');
  m.id = 'ctxMenu';
  m.className = 'ctxmenu';
  m.innerHTML = `
    ${date ? `<button type="button" data-cm="team">팀원 일정 보기 (${h(D.shortLabel(date))})</button>` : ''}
    ${date ? `<button type="button" data-cm="new">새 일정</button>` : ''}
    <div class="sep"></div>
    <button type="button" data-cm="import">팀 일정표 가져오기…</button>`;
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  m.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  const off = (e) => {
    if (e.type === 'keydown' && e.key !== 'Escape') return;
    if (e.type === 'mousedown' && m.contains(e.target)) return;
    m.remove();
    document.removeEventListener('mousedown', off, true);
    document.removeEventListener('keydown', off, true);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', off, true);
    document.addEventListener('keydown', off, true);
  });
  m.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cm]');
    if (!b) return;
    m.remove();
    if (b.dataset.cm === 'team') openTeamView(date);
    else if (b.dataset.cm === 'new') openEventDialog({ date });
    else importTeam();
  });
}

/** 팀원 일정 보기: 선택한 날짜가 있는 주 */
function openTeamView(date) {
  const team = S.data.team?.parsed;
  if (!team) {
    toast('먼저 상단의 "팀 일정 등록"으로 팀 일정표 엑셀을 가져오세요.');
    return;
  }
  let cur = date;
  const me = settings().teamMe;
  const { el, close } = openModal('<div id="tvBody"></div>', { cls: 'xwide' });
  const draw = () => {
    const ws = D.addDays(cur, -((D.dow(cur) + 6) % 7)); // 월요일 시작
    const days = Array.from({ length: 7 }, (_, i) => D.addDays(ws, i));
    // 나(본인)는 제외, 같은 일정은 기간만큼 한 막대로 이어서 표시
    const names = [...new Set(team.flatMap((p) => p.people.map((x) => x.name)))].filter((n) => n !== me);
    const we = days[6];
    const cls = (d) => `${d === date ? 'sel' : ''} ${D.dow(d) === 0 || D.dow(d) === 6 ? 'we' : ''}`;
    const rowHtml = (name) => {
      const segs = [];
      for (const [pi, p] of team.entries()) {
        const person = p.people.find((x) => x.name === name);
        if (!person) continue;
        for (const [ei, it] of person.entries.entries()) {
          if (it.end < ws || it.start > we) continue;
          const a = it.start < ws ? ws : it.start;
          const b = it.end > we ? we : it.end;
          segs.push({ it, pi, ei, a, b, i: D.diffDays(ws, a), n: D.diffDays(a, b) + 1, cont: it.start < ws, more: it.end > we });
        }
      }
      segs.sort((x, y) => x.i - y.i || y.n - x.n);
      let html = '';
      let i = 0;
      const chip = (g) =>
        `<button type="button" class="tchip${g.it.lead ? ' lead' : ''}${g.cont ? ' cont' : ''}${g.more ? ' more' : ''}${g.it.orig ? ' edited' : ''}" data-tedit="${g.pi}|${h(name)}|${g.ei}" title="${h(g.it.text)}${g.it.work ? ` · ${h(g.it.work)}` : ''} ${h(D.shortLabel(g.it.start))} ~ ${h(D.shortLabel(g.it.end))}${g.it.lead ? ' · 인차지' : ''} — 눌러서 회사 이름·업무 내용 수정">${h(g.it.text)}${g.it.orig ? '<i class="ed">✎</i>' : ''}${g.it.work ? `<small>${h(g.it.work)}</small>` : ''}</button>`;
      for (let k = 0; k < segs.length; k++) {
        const g = segs[k];
        if (g.i < i) continue; // 겹치는 일정은 앞 칸에 함께 표시됨
        while (i < g.i) html += `<td class="${cls(days[i++])}"></td>`;
        // 같은 기간에 겹치는 다른 일정은 같은 칸에 쌓기
        const stack = segs.filter((o) => o !== g && o.i >= g.i && o.i < g.i + g.n);
        html += `<td colspan="${g.n}" class="span ${g.n === 1 ? cls(days[g.i]) : ''}">${chip(g)}${stack.map(chip).join('')}</td>`;
        i = g.i + g.n;
      }
      while (i < 7) html += `<td class="${cls(days[i++])}"></td>`;
      return `<tr><th>${h(name)}</th>${html}</tr>`;
    };
    const inRange = team.some((p) => days.some((d) => d >= p.from && d <= p.to));
    $('#tvBody', el).innerHTML = `
      <div class="mhead"><h1>팀원 일정</h1>
        <div class="row gap4"><button type="button" class="btn sq" data-w="-7" aria-label="이전 주">‹</button><button type="button" class="btn" data-w="0">${h(D.shortLabel(date))}</button><button type="button" class="btn sq" data-w="7" aria-label="다음 주">›</button></div>
        <button type="button" class="btn ghost icon" data-close aria-label="닫기">✕</button></div>
      <div class="mbody" style="padding:12px 16px">
        ${inRange ? '' : '<div class="warn">이 주는 가져온 팀 일정표의 기간 밖입니다.</div>'}
        <div style="overflow:auto">
        <table class="tview">
          <colgroup><col style="width:72px">${days.map(() => '<col>').join('')}</colgroup>
          <thead><tr><th></th>${days.map((d) => `<th class="${cls(d)}">${D.parts(d).m}/${D.parts(d).d} (${D.DOW_KO[D.dow(d)]})</th>`).join('')}</tr></thead>
          <tbody>${names.map(rowHtml).join('')}</tbody>
        </table></div>
        <div class="note"><span class="tchip lead" style="display:inline-block">짙은 색</span> 인차지 · 일정을 누르면 회사 이름·업무 내용을 고칠 수 있습니다 · ${h(S.data.team.fileName)} 기준 · 이 정보는 이 PC(와 내 휴대폰 앱)에만 보관되며 캘린더에는 등록하지 않습니다.</div>
      </div>`;
  };
  draw();
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return close();
    const te = e.target.closest('[data-tedit]');
    if (te) {
      const [pi, name, ei] = te.dataset.tedit.split('|');
      return editTeamEntry(+pi, name, +ei, draw);
    }
    const w = e.target.closest('[data-w]');
    if (w) {
      cur = +w.dataset.w === 0 ? date : D.addDays(cur, +w.dataset.w);
      draw();
    }
  });
}

/* 팀 일정표 항목 수정 (회사 이름·업무 내용). 원문 기준으로 기억해 두었다가 다시 가져와도 그대로 적용 */
const teamEditKey = (name, orig, start) => `${name}|${orig}|${start}`;
function applyTeamEdits(parsed) {
  const ed = S.data.teamEdits || {};
  for (const p of parsed)
    for (const person of p.people)
      for (const e of person.entries) {
        const x = ed[teamEditKey(person.name, e.orig || e.text, e.start)];
        if (!x) continue;
        if (!e.orig) e.orig = e.text;
        e.text = x.text || e.orig;
        e.work = x.work || '';
      }
  return parsed;
}
function editTeamEntry(pi, name, ei, redraw) {
  const p = S.data.team.parsed[pi];
  const person = p?.people.find((x) => x.name === name);
  const it = person?.entries[ei];
  if (!it) return;
  const orig = it.orig || it.text;
  const norm = (x) => String(x || '').replace(/\s+/g, '');
  // 같은 회사(원문)·겹치는 기간의 다른 팀원 일정
  const mates = [];
  for (const o of p.people) {
    if (o === person) continue;
    o.entries.forEach((oe, k) => {
      if (norm(oe.orig || oe.text) === norm(orig) && oe.start <= it.end && it.start <= oe.end) mates.push({ o, oe, k });
    });
  }
  const { el, close } = openModal(
    `<div class="mhead"><h1>팀 일정 수정</h1><button type="button" class="btn ghost icon" data-x aria-label="닫기">✕</button></div>
     <div class="mbody">
       <div class="small muted" style="margin-bottom:10px">${h(name)} · ${h(D.shortLabel(it.start))}${it.end !== it.start ? ` ~ ${h(D.shortLabel(it.end))}` : ''}${it.lead ? ' · 인차지' : ''}${it.orig ? ` · 엑셀 원문: ${h(it.orig)}` : ''}</div>
       <div class="fld"><label class="lbl" for="te-c">회사 이름</label><input class="inp" id="te-c" value="${h(it.text)}"></div>
       <div class="fld" style="margin-top:10px"><label class="lbl" for="te-w">업무 내용</label><input class="inp" id="te-w" value="${h(it.work || '')}" placeholder="${h(p.workType ? `${p.workType} (일정표 기본값)` : '예: 중간감사, 재고실사')}"></div>
       ${mates.length ? `<label class="checkline small" style="margin-top:12px"><input type="checkbox" id="te-all" checked>같은 일정의 다른 팀원에게도 적용 (${h(mates.map((m) => m.o.name).join(', '))})</label>` : ''}
       <div class="note" style="margin-top:8px">수정 내용은 이 PC에 기억되어 팀 일정표를 다시 가져와도 그대로 적용됩니다. 내 일정은 다음에 "팀 일정 등록"을 할 때 캘린더 제목에 반영됩니다.</div>
     </div>
     <div class="mfoot">${it.orig ? '<button type="button" class="btn" data-reset>원래대로</button>' : ''}<div class="spacer"></div><button type="button" class="btn" data-x>취소</button><button type="button" class="btn primary" data-save>저장</button></div>`,
    { cls: 'narrow' }
  );
  setTimeout(() => $('#te-c', el)?.focus(), 0);
  const commit = (text, work) => {
    S.data.teamEdits ||= {};
    const targets = [{ o: person, oe: it }, ...($('#te-all', el)?.checked ? mates : [])];
    for (const { o, oe } of targets) {
      const og = oe.orig || oe.text;
      const k = teamEditKey(o.name, og, oe.start);
      if ((text === og || !text) && !work) {
        delete S.data.teamEdits[k];
        oe.text = og;
        delete oe.orig;
        delete oe.work;
      } else {
        S.data.teamEdits[k] = { text: text || og, work };
        oe.orig = og;
        oe.text = text || og;
        oe.work = work;
      }
    }
    save();
    S.data.team.uploadedAt = null;
    uploadTeamForPhone(false, false);
    close();
    redraw();
    toast('팀 일정을 수정했습니다.');
  };
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-x]')) return close();
    if (e.target.closest('[data-reset]')) return commit('', '');
    if (e.target.closest('[data-save]')) return commit($('#te-c', el).value.trim(), $('#te-w', el).value.trim());
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.target.matches('input.inp')) {
      e.preventDefault();
      $('[data-save]', el).click();
    }
  });
}

function bindDrag() {
  const body = $('#calBody');
  // 날짜에서 오른쪽 클릭 → 팀원 일정 보기
  body.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const d = dateAtPoint(e.clientX, e.clientY);
    if (d) openTeamView(d);
  });
  body.addEventListener('dragstart', (e) => {
    const chip = e.target.closest('[data-item][draggable="true"]');
    if (!chip) return;
    const it = S.items.get(chip.dataset.item);
    if (!it) return;
    drag.item = it;
    drag.from = dateAtPoint(e.clientX, e.clientY) || it.date;
    // 여러 날 막대에서 잡은 위치가 일정 범위를 벗어나면 시작일 기준
    if (drag.from < it.date || drag.from > it.endDate) drag.from = it.date;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', it.title);
    chip.classList.add('dragging');
  });
  body.addEventListener('dragover', (e) => {
    if (!drag.item) return;
    const d = dateAtPoint(e.clientX, e.clientY);
    if (!d) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    markDrop(d);
  });
  body.addEventListener('dragleave', (e) => {
    if (!body.contains(e.relatedTarget)) markDrop(null);
  });
  body.addEventListener('drop', (e) => {
    if (!drag.item) return;
    e.preventDefault();
    const d = dateAtPoint(e.clientX, e.clientY);
    const it = drag.item;
    const from = drag.from;
    drag.item = null;
    markDrop(null);
    if (d && from) moveItem(it, D.diffDays(from, d));
  });
  body.addEventListener('dragend', () => {
    drag.item = null;
    markDrop(null);
    $$('#calBody .dragging').forEach((x) => x.classList.remove('dragging'));
  });
}

/* ───────────── 이벤트 연결 ───────────── */
function bind() {
  $('#btnPrev').onclick = () => move(-1);
  $('#btnNext').onclick = () => move(1);
  $('#btnPrevYear').onclick = () => moveYear(-1);
  $('#btnNextYear').onclick = () => moveYear(1);
  $('#btnToday').onclick = () => {
    S.cursor = D.today();
    renderCalendar();
    maybeRefresh();
  };
  $$('.seg button').forEach((b) => {
    b.onclick = () => {
      S.view = b.dataset.view;
      renderCalendar();
      maybeRefresh();
    };
  });
  $('#btnTeamImport').onclick = () => importTeam();
  $('#btnMail').onclick = () => openMailDialog();
  $('#btnAddEvent').onclick = () => openEventDialog({ date: S.view === 'month' && S.cursor.slice(0, 7) !== D.today().slice(0, 7) ? S.cursor : S.view === 'month' ? D.today() : S.cursor });
  $('#btnSync').onclick = () => {
    S.gRange = null;
    refreshGoogle();
  };
  $('#btnSettings').onclick = openSettings;
  $('#chkLunar').onchange = (e) => {
    settings().showLunar = e.target.checked;
    save();
    renderCalendar();
  };

  bindDrag();
  $('#calBody').addEventListener('click', (e) => {
    const goday = e.target.closest('[data-goday]');
    if (goday) {
      S.cursor = goday.dataset.goday;
      S.view = 'day';
      renderCalendar();
      return;
    }
    const chip = e.target.closest('[data-item]');
    if (chip) {
      const it = S.items.get(chip.dataset.item);
      if (!it) return;
      if (it.kind === 'event') openEventDialog({ ev: it.ev, occ: it.date });
      else if (it.kind === 'gevent') openEventDialog({ g: it.g });
      else if (it.kind === 'todo') openTodoDialog(it.t);
      return;
    }
    const cell = e.target.closest('[data-date]');
    if (cell && !e.target.closest('.chip')) openEventDialog({ date: cell.dataset.date });
  });
  $('#calBody').addEventListener('wheel', (e) => {
    if (S.view !== 'month' || Math.abs(e.deltaY) < 30) return;
    const el = $('#calBody');
    if (el.scrollHeight > el.clientHeight + 4) return;
    move(e.deltaY > 0 ? 1 : -1);
  }, { passive: true });

  $('#quickForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('#quick');
    if (!inp.value.trim()) return;
    addQuickTodo(inp.value);
    inp.value = '';
  });
  $('#btnTodoDialog').onclick = () => {
    const v = $('#quick').value.trim();
    const p = v ? parseQuickAdd(v) : null;
    openTodoDialog(null, p ? { title: p.title, due: p.due, repeat: p.repeat } : null);
    $('#quick').value = '';
  };
  $('#todoTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    S.tab = b.dataset.tab;
    renderTodos();
  });
  const list = $('#todoList');
  list.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.check) toggleTodo(t.dataset.check, t.checked);
    else if (t.dataset.subcheck) {
      const [tid, sid] = t.dataset.subcheck.split('|');
      const td = S.data.todos.find((x) => x.id === tid);
      const s = td?.subtasks?.find((x) => x.id === sid);
      if (s) {
        s.done = t.checked;
        save();
        renderAll();
      }
    }
  });
  list.addEventListener('click', (e) => {
    const tb = e.target.closest('[data-todo]');
    if (tb) {
      const t = S.data.todos.find((x) => x.id === tb.dataset.todo);
      if (t) openTodoDialog(t);
      return;
    }
    const col = e.target.closest('[data-collapse]');
    if (col) {
      const t = S.data.todos.find((x) => x.id === col.dataset.collapse);
      t.collapsed = !t.collapsed;
      save();
      renderTodos();
      return;
    }
    const sa = e.target.closest('[data-subadd]');
    if (sa) {
      S.openSubAdd = S.openSubAdd === sa.dataset.subadd ? null : sa.dataset.subadd;
      renderTodos();
      return;
    }
    const sd = e.target.closest('[data-subdel]');
    if (sd) {
      const [tid, sid] = sd.dataset.subdel.split('|');
      const td = S.data.todos.find((x) => x.id === tid);
      td.subtasks = td.subtasks.filter((s) => s.id !== sid);
      save();
      renderAll();
      return;
    }
    if (e.target.id === 'btnShowDone') {
      S.showDone = !S.showDone;
      renderTodos();
      return;
    }
    // 빈 곳 클릭 → 새 할 일
    if (!e.target.closest('.trow, .subs, button, input, a, label')) openTodoDialog();
  });
  list.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!t.dataset.subnew) return;
    if (e.key === 'Escape') {
      S.openSubAdd = null;
      renderTodos();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = t.value.trim();
    if (!v) return;
    const td = S.data.todos.find((x) => x.id === t.dataset.subnew);
    td.subtasks = [...(td.subtasks || []), { id: uid(), title: v, done: false }];
    td.collapsed = false;
    S.openSubAdd = td.id;
    save();
    renderAll();
  });

  document.addEventListener('keydown', (e) => {
    if ($('#modalRoot').children.length) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'ArrowLeft') move(-1);
    else if (e.key === 'ArrowRight') move(1);
    else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      openEventDialog({ date: S.view === 'month' ? D.today() : S.cursor });
    } else if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      $('#quick').focus();
    }
  });
}

function moveYear(dir) {
  const { y, m, d } = D.parts(S.cursor);
  const ny = y + dir;
  S.cursor = D.make(ny, m, Math.min(d, D.daysInMonth(ny, m)));
  renderCalendar();
  maybeRefresh();
}

function move(dir) {
  if (S.view === 'month') {
    const { y, m } = D.parts(S.cursor);
    const n = D.addMonths(y, m, dir);
    S.cursor = D.make(n.y, n.m, 1);
  } else if (S.view === 'week') S.cursor = D.addDays(S.cursor, 7 * dir);
  else S.cursor = D.addDays(S.cursor, dir);
  renderCalendar();
  maybeRefresh();
}

/* ───────────── 시작 ───────────── */
async function init() {
  const d = await window.api.load();
  d.events ||= [];
  d.todos ||= [];
  if (!d.history) {
    d.history = {};
    S.data = d;
    for (const ev of d.events) remember(ev.title, ev.place, ev.people, ev.updatedAt || ev.createdAt || 0);
  }
  d.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
  for (const t of d.todos) t.subtasks ||= [];
  S.data = d;
  const st = await window.api.google.status();
  if (st.ok) S.g = st.data;
  if (ensureFixed()) save();
  bind();
  renderAll();
  S.appVersion = await window.api.version();
  S.update = await window.api.update.state();
  renderUpdate();
  window.api.update.onState((u) => {
    const was = S.update?.status;
    S.update = u;
    renderUpdate();
    if (u.status === 'ready' && was !== 'ready') toast(`새 버전 ${u.version}이 준비되었습니다. 프로그램을 닫으면 자동으로 설치됩니다.`);
  });
  $('#btnUpdate').onclick = () => (S.patchReady ? window.api.patch.apply() : window.api.update.install());
  S.patchReady = await window.api.patch.state();
  renderUpdate();
  window.api.patch.onReady((v) => {
    S.patchReady = v;
    renderUpdate();
    toast(`변경사항(${v})이 준비되었습니다. 상단의 "변경사항 적용"을 누르면 바로 반영됩니다.`);
  });
  if (S.g.connected) refreshGoogle();
  if (S.g.connected && S.g.tasks) {
    window.api.push.init().catch(() => {});
  }
  if (S.g.connected && S.data.team && !S.data.team.uploadedAt) {
    uploadTeamForPhone(false, true); // 아직 휴대폰으로 못 보냈으면 시작할 때 다시 시도
  }

  renderMailBadge();
  setKeywords(keywordsOf(kwStore()));
  setTimeout(() => syncKw(), 8000); // 휴대폰과 단어 목록 맞추기
  window.api.outlook.onPick?.(() => pickOutlookMail());
  bindMailView();
  setTimeout(() => mailState().enabled && scanMail(), 20000); // 시작 20초 뒤 첫 확인
  setInterval(() => mailState().enabled && scanMail(), 30 * 60 * 1000); // 30분마다

  let lastDay = D.today();
  setInterval(() => {
    checkAlarms();
    renderStatus();
    if (D.today() !== lastDay) {
      lastDay = D.today();
      if (ensureFixed()) save();
      renderAll();
    }
  }, 30000);
  setInterval(() => {
    if (S.g.connected && !S.syncing) refreshGoogle();
  }, 5 * 60000);
  window.addEventListener('focus', () => {
    if (S.g.connected && S.lastSync && Date.now() - S.lastSync > 60000) refreshGoogle();
  });
}

init();

/** 시작 시간을 고르면 종료 시간을 1시간 뒤로 자동 입력하고, 바뀐 칸을 잠깐 강조해 확인할 수 있게 한다 */
function autoEndTime(f, root, start) {
  if (!/^\d{1,2}:\d{2}/.test(start || '')) return;
  const [hh, mm] = start.split(':').map(Number);
  const m = Math.min(hh * 60 + mm + 60, 23 * 60 + 59);
  f.endTime = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const et = root.querySelector('#e-et');
  if (!et) return;
  et.value = f.endTime;
  et.classList.remove('autofilled');
  void et.offsetWidth;
  et.classList.add('autofilled');
}

/* ───────────── Outlook 메일 → 일정 후보 ───────────── */
function mailState() {
  S.data.mail ||= { enabled: false, days: 7, done: {}, cands: [], lastScan: null, lastError: null };
  return S.data.mail;
}
function renderMailBadge() {
  const b = $('#mailBadge');
  if (!b) return;
  const n = mailState().cands.length;
  b.hidden = !n;
  b.textContent = n;
}
const MAIL_ERR = {
  notRunning: 'Outlook이 실행 중이 아니어서 확인하지 못했습니다. Outlook을 켜 두거나 "지금 확인"을 누르세요.',
  noOutlook: 'PC에 설치된 Outlook을 찾지 못했습니다. 클래식 Outlook(Microsoft 365/Office)만 지원되며, "새 Outlook"은 지원되지 않습니다.',
};
let mailBusy = false;
const mailBodies = new Map();
async function scanMail(manual = false, quiet = false) {
  if (mailBusy) return;
  mailBusy = true;
  const m = mailState();
  S.mailLoading = true;
  if (mvVisible()) renderMailView();
  try {
    const r = await window.api.outlook.read({ days: Math.max(m.days, mvState().days), start: manual });
    const res = r.ok ? r.data : { ok: false, error: r.error };
    if (!res.ok) {
      m.lastError = MAIL_ERR[res.code] || `메일을 읽지 못했습니다: ${res.error || '알 수 없는 오류'}`;
      if (res.code === 'notRunning' && !manual) m.lastError = MAIL_ERR.notRunning;
      save();
      if (manual && !quiet) toast(m.lastError);
      return;
    }
    S.mailList = res.mails || [];
    S.mailListAt = Date.now();
    sumCache.clear();
    const today = D.today();
    const nd = new Date();
    const now = `${today}T${String(nd.getHours()).padStart(2, '0')}:${String(nd.getMinutes()).padStart(2, '0')}`;
    // 처리한 후보 기록은 90일 지나면 정리
    const cut = Date.now() - 90 * 864e5;
    for (const [k, t] of Object.entries(m.done)) if (t < cut) delete m.done[k];
    const prev = new Set(m.cands.map((c) => c.key));
    const cands = [];
    mailBodies.clear(); // 본문은 저장하지 않고 메모리에만 (미리보기용)
    for (const mail of res.mails || []) {
      mailBodies.set(mail.id, { body: stripQuoted(mail.body || '').trim(), atts: [].concat(mail.attText || []) });
      for (const c of mailCandidates(mail, today, now)) {
        if (m.done[c.key]) continue;
        cands.push({ ...c, subject: mail.subject, from: mail.from, received: mail.received });
      }
    }
    m.cands = cands;
    m.lastScan = Date.now();
    m.lastError = null;
    save();
    renderMailBadge();
    const fresh = cands.filter((c) => !prev.has(c.key));
    if (fresh.length && !manual && m.notified !== fresh.map((c) => c.key).join()) {
      m.notified = fresh.map((c) => c.key).join();
      try {
        const n = new Notification('메일에서 일정 후보를 찾았습니다', { body: fresh.slice(0, 3).map((c) => `${mailWhen(c)} ${c.title}`).join('\n') });
        n.onclick = () => {
          window.api.focus?.();
          openMailDialog();
        };
      } catch {
        /* 알림 실패는 무시 */
      }
    }
    if (manual && !quiet) toast(cands.length ? `일정 후보 ${cands.length}건을 찾았습니다.` : '새 일정 후보가 없습니다.');
    refreshMailDialog?.();
  } finally {
    mailBusy = false;
    S.mailLoading = false;
    renderMailSumBadge();
    if (mvVisible()) renderMailView();
  }
}
function mailWhen(c) {
  const d = (x) => `${+x.slice(5, 7)}/${+x.slice(8, 10)}(${'일월화수목금토'[D.dow(x)]})`;
  let s = d(c.date);
  if (c.endDate && c.endDate !== c.date) s += ` ~ ${d(c.endDate)}`;
  if (c.startTime) s += ` ${c.startTime}${c.endTime ? `~${c.endTime}` : ''}`;
  return s;
}
let refreshMailDialog = null;
function openMailDialog() {
  const m = mailState();
  const { el, close } = openModal(
    `<div class="mhead"><h1>메일 일정 후보</h1><button type="button" class="btn ghost icon" data-x aria-label="닫기">✕</button></div>
     <div class="mbody" id="mailBody"></div>
     <div class="mfoot">
       <label class="checkline small"><input type="checkbox" id="mail-auto" ${m.enabled ? 'checked' : ''}>30분마다 자동 확인</label>
       <select class="inp small" id="mail-days" style="width:auto;height:32px">${[3, 7, 14, 30].map((d) => `<option value="${d}" ${m.days === d ? 'selected' : ''}>최근 ${d}일</option>`).join('')}</select>
       <div class="spacer"></div>
       <button type="button" class="btn" data-pick title="Outlook에서 선택하거나 열어 둔 메일로 일정·할 일 만들기 (Ctrl+Shift+E)">선택한 메일로…</button>
       <button type="button" class="btn" data-scan>지금 확인</button>
       <button type="button" class="btn primary" data-x>닫기</button>
     </div>`,
    {
      cls: 'wide',
      onClose: () => {
        refreshMailDialog = null;
        hidePeek(true);
      },
    }
  );
  const body = $('#mailBody', el);
  const draw = () => {
    const st = m.lastError
      ? `<div class="warn">${h(m.lastError)}</div>`
      : `<div class="note">${m.lastScan ? `마지막 확인: ${new Date(m.lastScan).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ` : ''}PC의 Outlook 받은 편지함에서 날짜·시간이 적힌 메일(첨부 PDF·Word·한글 파일 포함)을 찾아 보여 줍니다. 메일 내용은 이 PC 안에서만 처리합니다.</div>`;
    const groups = new Map();
    for (const c of m.cands) {
      if (!groups.has(c.mailId)) groups.set(c.mailId, []);
      groups.get(c.mailId).push(c);
    }
    const list = [...groups.values()]
      .map(
        (cs) => `<div class="mailg" data-mid="${h(cs[0].mailId)}">
          <div class="mailh"><b>${h(cs[0].subject || '(제목 없음)')}</b><span class="small muted">${h(cs[0].from || '')} · ${h((cs[0].received || '').slice(5, 16).replace('T', ' ').replace('-', '/'))}</span></div>
          ${cs
            .map(
              (c) => `<div class="mailc">
                <div class="mailw"><span class="mwhen">${h(mailWhen(c))}</span>${c.meeting ? '<span class="tag">모임 요청</span>' : ''}${c.att ? `<span class="tag att" title="첨부 파일에서 찾음">📎 ${h(c.att)}</span>` : ''}${c.place ? `<span class="small muted">· ${h(c.place)}</span>` : ''}
                  ${c.why?.length ? `<div class="small muted">배운 단어로 찾음: ${h(c.why.join(', '))}</div>` : ''}
                  <div class="small muted msnip">${c.meeting ? h(c.snippet) : highlightHtml(c.snippet, c.hits, h)}</div></div>
                <button type="button" class="btn" data-mskip="${h(c.key)}">무시</button>
                <button type="button" class="btn primary" data-madd="${h(c.key)}">일정 추가</button>
              </div>`
            )
            .join('')}
        </div>`
      )
      .join('');
    body.innerHTML = st + (list || `<div class="empty">${m.lastScan ? '새 일정 후보가 없습니다.' : '"지금 확인"을 눌러 받은 편지함을 확인하세요.'}</div>`);
  };
  refreshMailDialog = draw;
  // 메일에 마우스를 올리면 본문 미리보기
  let peekTimer = null;
  body.addEventListener('mouseover', (e) => {
    const g = e.target.closest('.mailg');
    if (!g || e.target.closest('button')) return;
    if (peekEl && peekEl.dataset.mid === g.dataset.mid) return keepPeek();
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => showPeek(g), 350);
  });
  body.addEventListener('mouseout', (e) => {
    const g = e.target.closest('.mailg');
    if (g && !g.contains(e.relatedTarget)) {
      clearTimeout(peekTimer);
      hidePeek();
    }
  });
  draw();
  const markDone = (key) => {
    m.done[key] = Date.now();
    m.cands = m.cands.filter((c) => c.key !== key);
    save();
    renderMailBadge();
    draw();
  };
  el.addEventListener('change', (e) => {
    if (e.target.id === 'mail-auto') {
      m.enabled = e.target.checked;
      save();
      if (m.enabled) scanMail();
    } else if (e.target.id === 'mail-days') {
      m.days = +e.target.value;
      save();
    }
  });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-x]')) return close();
    if (e.target.closest('[data-pick]')) {
      close();
      return pickOutlookMail();
    }
    if (e.target.closest('[data-scan]')) {
      body.insertAdjacentHTML('afterbegin', '<div class="note" id="mail-wait">받은 편지함 확인 중… (Outlook이 꺼져 있으면 켜는 데 시간이 걸릴 수 있습니다)</div>');
      await scanMail(true);
      draw();
      return;
    }
    const sk = e.target.closest('[data-mskip]');
    if (sk) {
      penalizeWords(m.cands.find((c) => c.key === sk.dataset.mskip)?.why); // 배운 단어 때문에 잡힌 후보면 점수 나눠 깎기
      return markDone(sk.dataset.mskip);
    }
    const ad = e.target.closest('[data-madd]');
    if (ad) {
      const c = m.cands.find((x) => x.key === ad.dataset.madd);
      if (!c) return;
      const end1h = (t) => {
        const [hh, mm] = t.split(':').map(Number);
        const v = Math.min(hh * 60 + mm + 60, 23 * 60 + 59);
        return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
      };
      openEventDialog({
        date: c.date,
        preset: {
          title: c.title,
          date: c.date,
          endDate: c.endDate || c.date,
          allDay: c.allDay,
          startTime: c.startTime || '09:00',
          endTime: c.endTime || (c.startTime ? end1h(c.startTime) : '10:00'),
          place: c.place || '',
          memo: `메일: ${c.subject || ''}\n보낸 사람: ${c.from || ''} (${(c.received || '').slice(0, 16).replace('T', ' ')})${c.snippet && !c.meeting ? `\n${c.snippet}` : ''}`,
        },
        onSaved: () => markDone(c.key),
      });
    }
  });
}

/* 메일 본문 미리보기 (마우스 올림) */
let peekEl = null;
let peekHide = null;
function keepPeek() {
  clearTimeout(peekHide);
}
function hidePeek(now = false) {
  clearTimeout(peekHide);
  const go = () => {
    peekEl?.remove();
    peekEl = null;
  };
  if (now) go();
  else peekHide = setTimeout(go, 250); // 미리보기 창으로 옮겨 가 스크롤할 수 있게 잠깐 기다림
}
function showPeek(g) {
  hidePeek(true);
  const m = mailState();
  const cs = m.cands.filter((c) => c.mailId === g.dataset.mid);
  if (!cs.length) return;
  const mb = mailBodies.get(g.dataset.mid);
  const text = mb?.body;
  // 일정으로 잡은 근거(날짜·시간·일정 단어·장소)를 강조
  const hits = cs.flatMap((c) => c.hits || []);
  let html;
  if (text === undefined) html = '<div class="muted">본문은 [지금 확인] 후에 볼 수 있습니다. (메일 내용은 저장하지 않습니다)</div>';
  else if (!text) html = '<div class="muted">(본문 없음)</div>';
  else html = highlightHtml((text.length > 4000 ? `${text.slice(0, 4000)}…` : text).replace(/\n{3,}/g, '\n\n'), hits, h);
  // 첨부 파일 내용
  for (const a of mb?.atts || []) {
    const t = a.text.length > 3000 ? `${a.text.slice(0, 3000)}…` : a.text;
    html += `<div class="mp-att">📎 ${h(a.name)}</div>${highlightHtml(t.replace(/\n{3,}/g, '\n\n'), hits, h)}`;
  }
  const legend = '<div class="mp-lg"><mark class="hl-date">날짜</mark><mark class="hl-time">시간</mark><mark class="hl-key">일정 단어</mark><mark class="hl-place">장소</mark></div>';
  peekEl = document.createElement('div');
  peekEl.className = 'mailpeek';
  peekEl.dataset.mid = g.dataset.mid;
  peekEl.innerHTML = `<div class="mp-h"><b>${h(cs[0].subject || '(제목 없음)')}</b><span>${h(cs[0].from || '')} · ${h((cs[0].received || '').slice(0, 16).replace('T', ' '))}</span></div>${legend}<div class="mp-b">${html}</div>`;
  document.body.appendChild(peekEl);
  peekEl.addEventListener('mouseenter', keepPeek);
  peekEl.addEventListener('mouseleave', () => hidePeek());
  // 후보 창 옆(공간이 넓은 쪽)에 표시
  const r = g.getBoundingClientRect();
  const modal = g.closest('.modal')?.getBoundingClientRect() || r;
  const W = Math.min(440, Math.max(modal.left, innerWidth - modal.right) - 24);
  const pw = W >= 280 ? W : Math.min(440, innerWidth - 40);
  peekEl.style.width = `${pw}px`;
  const ph = Math.min(peekEl.offsetHeight, innerHeight - 40);
  let left;
  let top = Math.max(20, Math.min(r.top, innerHeight - ph - 20));
  if (W >= 280) left = modal.left > innerWidth - modal.right ? modal.left - pw - 12 : modal.right + 12;
  else {
    left = Math.max(20, Math.min(r.left, innerWidth - pw - 20));
    top = r.bottom + 6 + ph < innerHeight ? r.bottom + 6 : Math.max(20, r.top - ph - 6);
  }
  peekEl.style.left = `${left}px`;
  peekEl.style.top = `${top}px`;
}

/* ───────────── Outlook에서 고른 메일 → 일정 / 할 일 ───────────── */
let picking = false;
async function pickOutlookMail() {
  if (picking) return;
  picking = true;
  toast('Outlook에서 선택한 메일을 읽는 중…');
  try {
    const r = await window.api.outlook.selected();
    const res = r.ok ? r.data : { ok: false, error: r.error };
    if (!res.ok) {
      const msg = {
        notRunning: 'Outlook이 실행 중이 아닙니다. Outlook을 열고 메일을 선택한 뒤 다시 눌러 주세요.',
        noSelection: 'Outlook에서 메일을 하나 선택하거나 열어 두고 다시 눌러 주세요.',
        notMail: '선택한 항목이 메일이 아닙니다.',
        noOutlook: MAIL_ERR.noOutlook,
      }[res.code] || `메일을 읽지 못했습니다: ${res.error || '알 수 없는 오류'}`;
      toast(msg);
      return;
    }
    const mail = res.mails[0];
    mailBodies.set(mail.id, { body: stripQuoted(mail.body || '').trim(), atts: [].concat(mail.attText || []) });
    openPickedMail(mail);
  } finally {
    picking = false;
  }
}
function openPickedMail(mail) {
  const today = D.today();
  const nd = new Date();
  const now = `${today}T${String(nd.getHours()).padStart(2, '0')}:${String(nd.getMinutes()).padStart(2, '0')}`;
  const atts = [].concat(mail.attText || []);
  // 1) 자동 후보와 같은 기준 (모임 요청·본문·첨부) → 2) 없으면 날짜만 있어도 찾기
  let c = mailCandidates(mail, today, now)[0] || null;
  if (!c) {
    const full = [stripQuoted(mail.body || ''), ...atts.map((a) => a.text)].join('\n\n');
    const r = parseShared(full, today, now);
    if (r.found) c = { date: r.date, endDate: r.endDate, allDay: r.allDay, startTime: r.startTime, endTime: r.endTime, place: r.place, snippet: '' };
  }
  const subject = cleanSubject(mail.subject) || '(제목 없음)';
  const d = (x) => `${+x.slice(5, 7)}/${+x.slice(8, 10)}(${'일월화수목금토'[D.dow(x)]})`;
  const foundTxt = c
    ? `${d(c.date)}${c.endDate && c.endDate !== c.date ? ` ~ ${d(c.endDate)}` : ''}${c.startTime ? ` ${c.startTime}${c.endTime ? `~${c.endTime}` : ''}` : ' 종일'}${c.place ? ` · ${c.place}` : ''}${c.att ? ` (📎 ${c.att})` : ''}`
    : '날짜를 찾지 못했습니다. 다음 창에서 직접 고르세요.';
  const memo = `메일: ${mail.subject || ''}\n보낸 사람: ${mail.from || ''} (${(mail.received || '').slice(0, 16).replace('T', ' ')})${c?.snippet && !c.meeting ? `\n${c.snippet}` : ''}`;
  const { el, close } = openModal(
    `<div class="mhead"><h1>메일로 일정·할 일 만들기</h1><button type="button" class="btn ghost icon" data-x aria-label="닫기">✕</button></div>
     <div class="mbody">
       <div class="small muted">${h(mail.from || '')} · ${h((mail.received || '').slice(0, 16).replace('T', ' '))}${atts.length ? ` · 📎 ${atts.length}개 읽음` : ''}</div>
       <div class="fld" style="margin-top:10px"><label class="lbl" for="pk-t">제목</label><input class="inp" id="pk-t" value="${h(subject)}"></div>
       <div class="pk-found ${c ? '' : 'none'}"><b>찾은 날짜</b> ${h(foundTxt)}</div>
       <div class="pk-body">${c?.hits?.length ? highlightHtml(stripQuoted(mail.body || '').trim().slice(0, 2500), c.hits, h) : h(stripQuoted(mail.body || '').trim().slice(0, 2500))}</div>
     </div>
     <div class="mfoot"><span class="note">Ctrl+Shift+E로 언제든 열 수 있습니다</span><div class="spacer"></div>
       <button type="button" class="btn" data-x>취소</button>
       <button type="button" class="btn" data-mk="todo">할 일로</button>
       <button type="button" class="btn primary" data-mk="event">일정으로</button></div>`,
    { cls: 'wide' }
  );
  setTimeout(() => $('#pk-t', el)?.select(), 0);
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-x]')) return close();
    const b = e.target.closest('[data-mk]');
    if (!b) return;
    const title = $('#pk-t', el).value.trim() || subject;
    close();
    if (b.dataset.mk === 'event') {
      const st = c?.startTime || '09:00';
      const [hh, mm] = st.split(':').map(Number);
      const v = Math.min(hh * 60 + mm + 60, 23 * 60 + 59);
      const end1 = `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
      openEventDialog({
        date: c?.date || today,
        preset: {
          title,
          date: c?.date || today,
          endDate: c?.endDate || c?.date || today,
          allDay: c ? c.allDay : true,
          startTime: st,
          endTime: c?.endTime || end1,
          place: c?.place || '',
          memo,
        },
        onSaved: () => c?.key && (mailState().done[c.key] = Date.now()),
      });
    } else {
      openTodoDialog(null, { title, due: c?.date || null, time: c?.startTime || '', memo });
    }
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'pk-t' && !e.isComposing) {
      e.preventDefault();
      $('[data-mk="event"]', el).click();
    }
  });
}

/* ───────────── 내 일정 단어 (배우기 · 휴대폰과 공유) ───────────── */
function kwStore() {
  S.data.kw ||= { w: {}, off: {} };
  return S.data.kw;
}
let kwTimer = null;
function saveKw() {
  save();
  setKeywords(keywordsOf(kwStore()));
  clearTimeout(kwTimer);
  kwTimer = setTimeout(() => syncKw(true), 2500);
}
/** 드라이브(앱 전용 숨김 공간)의 목록과 합치기 */
async function syncKw(write = false) {
  if (!S.g?.connected || !S.g?.drive) return;
  try {
    const r = await window.api.drive.load('keywords.json');
    if (!r.ok) return;
    const remote = r.data ? JSON.parse(r.data) : {};
    const merged = mergeKeywords(kwStore(), remote);
    const changed = JSON.stringify(merged) !== JSON.stringify(remote);
    S.data.kw = merged;
    save();
    setKeywords(keywordsOf(merged));
    if (write || changed) await window.api.drive.save('keywords.json', JSON.stringify(merged));
  } catch {
    /* 오프라인 등: 이 PC 안에서만 */
  }
}
/** 회사 이름(일정 제목 첫 단어·팀 일정표 회사)은 배우지 않음 */
function companyNames() {
  const out = new Set();
  for (const e of S.data.events || []) {
    // "세운철강 중간감사"처럼 '회사 + 업무' 형태일 때만 첫 단어를 회사로 봄
    const [w, ...rest] = String(e.title || '').replace(/^(\(주\)|㈜|주식회사)\s*/, '').split(/\s+/);
    if (w && /감사|실사|검토|평가|자문|실무|결산|컨설팅|용역/.test(rest.join(' '))) out.add(w);
  }
  for (const p of S.data.team?.parsed || []) for (const person of p.people) for (const en of person.entries) out.add(en.text);
  return out;
}
function learnWords(title) {
  const ws = extractWords(title, companyNames());
  if (!ws.length) return;
  scoreWords(kwStore(), ws, +1);
  saveKw();
}
function penalizeWords(words) {
  if (!words?.length) return;
  scoreWords(kwStore(), words, -1);
  saveKw();
}


/* ───────────── 시간 선택 창 (스크롤 없이 한눈에: 오전/오후 · 1~12시 · 5분 단위) ───────────── */
let tpop = null;
function closeTimePop() {
  tpop?.remove();
  tpop = null;
}
function openTimePop(inp) {
  closeTimePop();
  const pad = (n) => String(n).padStart(2, '0');
  const cur = () => {
    const [H, M] = (inp.value || '09:00').split(':').map(Number);
    return { pm: H >= 12, h12: H % 12 || 12, m: M };
  };
  const set = (pm, h12, m) => {
    const H = (h12 % 12) + (pm ? 12 : 0);
    inp.value = `${pad(H)}:${pad(m)}`;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    draw();
  };
  tpop = document.createElement('div');
  tpop.className = 'tpop';
  const draw = () => {
    const c = cur();
    tpop.innerHTML = `
      <div class="tcol">${['오전', '오후'].map((x, i) => `<button type="button" data-ap="${i}" class="${+c.pm === i ? 'on' : ''}">${x}</button>`).join('')}</div>
      <div class="tcol">${Array.from({ length: 12 }, (_, i) => i + 1).map((x) => `<button type="button" data-hh="${x}" class="${c.h12 === x ? 'on' : ''}">${x}</button>`).join('')}</div>
      <div class="tcol">${Array.from({ length: 12 }, (_, i) => i * 5).map((x) => `<button type="button" data-mm="${x}" class="${c.m === x ? 'on' : ''}">${pad(x)}</button>`).join('')}</div>`;
  };
  draw();
  document.body.appendChild(tpop);
  const r = inp.getBoundingClientRect();
  const ph = tpop.offsetHeight;
  tpop.style.left = `${Math.min(r.left, innerWidth - tpop.offsetWidth - 8)}px`;
  tpop.style.top = `${r.bottom + 4 + ph < innerHeight ? r.bottom + 4 : Math.max(8, r.top - ph - 4)}px`;
  tpop.addEventListener('mousedown', (e) => e.preventDefault()); // 입력칸 포커스 유지
  tpop.addEventListener('click', (e) => {
    e.stopPropagation(); // 다시 그리면서 버튼이 바뀌어도 '바깥 클릭'으로 닫히지 않게
    const b = e.target.closest('button');
    if (!b) return;
    const c = cur();
    if (b.dataset.ap !== undefined) set(b.dataset.ap === '1', c.h12, c.m);
    else if (b.dataset.hh) set(c.pm, +b.dataset.hh, c.m);
    else if (b.dataset.mm !== undefined) {
      set(c.pm, c.h12, +b.dataset.mm);
      closeTimePop(); // 분을 고르면 닫힘
    }
  });
}
document.addEventListener('click', (e) => {
  const inp = e.target.closest?.('input[type="time"]');
  if (inp && !inp.disabled && inp.offsetParent) {
    if (!tpop) openTimePop(inp);
    return;
  }
  if (tpop && !tpop.contains(e.target)) closeTimePop();
});
document.addEventListener('keydown', (e) => {
  if (!tpop) return;
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeTimePop();
  } else if (e.key === 'Tab' || e.key === 'Enter') closeTimePop();
}, true);
window.addEventListener('resize', closeTimePop);
document.addEventListener('scroll', closeTimePop, true);

/* ───────────── 메일 요약 탭 (PC 안에서 핵심 문장 뽑기) ───────────── */
const sumCache = new Map();
function mvState() {
  S.data.mailSum ||= { days: 3, done: {}, domains: {}, over: {} };
  const v = S.data.mailSum;
  v.done ||= {};
  v.domains ||= {};
  v.over ||= {};
  return v;
}
const MV = { tab: 'main', cat: 'all', co: '', q: '', showDone: false, sel: null, src: 'all' };
const mvVisible = () => MV.tab === 'mail';
/** 휴대폰과 연결(Phone Link) 문자 읽기 */
let smsBusy = false;
async function loadSms() {
  if (smsBusy || mvState().sms === false) return;
  smsBusy = true;
  try {
    const r = await window.api.phone.messages({ days: Math.max(mvState().days, 3) });
    const res = r.ok ? r.data : { ok: false, error: r.error };
    if (res.ok) {
      S.smsList = res.messages.map((m) => {
        const first = m.body.split('\n').map((l) => l.trim()).find(Boolean) || '';
        return { ...m, subject: m.subject || first.slice(0, 60), atts: [], unread: false };
      });
      S.smsErr = null;
    } else {
      S.smsList = [];
      S.smsErr = res.code === 'noPhoneLink' ? '휴대폰과 연결 앱의 문자를 찾지 못했습니다.' : `문자를 읽지 못했습니다: ${res.error || res.code}`;
    }
    sumCache.clear();
  } finally {
    smsBusy = false;
    renderMailSumBadge();
    if (mvVisible()) renderMailView();
  }
}
function mvClients() {
  return [...companyNames(), ...Object.values(mvState().domains)];
}
function mvItems() {
  const v = mvState();
  const today = D.today();
  const nd = new Date();
  const now = `${today}T${String(nd.getHours()).padStart(2, '0')}:${String(nd.getMinutes()).padStart(2, '0')}`;
  const since = D.addDays(today, -(v.days - 1));
  const clients = mvClients();
  const src = [...(MV.src !== 'sms' ? S.mailList || [] : []), ...(MV.src !== 'mail' && v.sms !== false ? S.smsList || [] : [])];
  return src
    .filter((m) => (m.received || '').slice(0, 10) >= since)
    .map((m) => {
      let x = sumCache.get(m.id);
      if (!x) {
        const mail = { ...m, body: [m.body || '', ...[].concat(m.attText || []).map((a) => a.text)].join('\n\n') };
        // 요지·요청은 본문, 기한·일정은 본문 + 첨부(attText)에서
        x = { mail: m, sum: summarize(m, today, now), mailForCo: mail };
        if (m.source === 'sms') {
          // 문자: 첫 줄을 제목으로, 연락처에 없는 [Web발신]은 알림으로
          x.sum.title = (m.subject || '').replace(/^\[[^\]]{1,12}\]\s*/, '') || '(문자)';
          if (m.web && !m.contact && x.sum.cat === 'info') x.sum.cat = 'auto';
        }
        sumCache.set(m.id, x);
      }
      const ov = v.over[m.id];
      x.co = ov
        ? { name: ov, by: 'user' }
        : x.sum.cat === 'auto'
          ? { name: '', by: 'auto' }
          : m.company
            ? { name: m.company, by: 'contact' }
            : companyOf(x.mailForCo, clients, v.domains);
      x.done = !!v.done[m.id];
      return x;
    })
    .sort((a, b) => (b.mail.received || '').localeCompare(a.mail.received || ''));
}
function renderMailSumBadge() {
  const b = $('#mailSumBadge');
  if (!b) return;
  const n = S.mailList || S.smsList ? mvItems().filter((x) => !x.done && (x.sum.cat === 'request' || x.sum.cat === 'due')).length : 0;
  b.hidden = !n;
  b.textContent = n;
}
function setAppTab(t) {
  MV.tab = t;
  document.querySelectorAll('[data-apptab]').forEach((b) => b.classList.toggle('on', b.dataset.apptab === t));
  $('main.main').hidden = t !== 'main';
  $('#mailView').hidden = t !== 'mail';
  if (t === 'mail') {
    renderMailView();
    // 처음 열거나 10분 넘게 지났으면 새로 읽기
    if (!S.mailList || Date.now() - (S.mailListAt || 0) > 10 * 60000) scanMail(true, true);
    if (!S.smsList || Date.now() - (S.smsAt || 0) > 2 * 60000) {
      S.smsAt = Date.now();
      loadSms();
    }
  } else renderAll();
}
const fmtDay = (d) => {
  const t = D.today();
  const lab = `${+d.slice(5, 7)}월 ${+d.slice(8, 10)}일 (${'일월화수목금토'[D.dow(d)]})`;
  return d === t ? `오늘 · ${lab}` : d === D.addDays(t, -1) ? `어제 · ${lab}` : lab;
};
const dueTxt = (d) => {
  if (!d.date) return '';
  const f = (x) => `${+x.slice(5, 7)}/${+x.slice(8, 10)}(${'일월화수목금토'[D.dow(x)]})`;
  return `${f(d.date)}${d.endDate && d.endDate !== d.date ? `~${f(d.endDate)}` : ''}${d.startTime ? ` ${d.startTime}` : ''}${!d.startTime && /까지/.test(d.text || '') ? '까지' : ''}`;
};
function renderMailView() {
  const root = $('#mailView');
  if (!root || root.hidden) return;
  const v = mvState();
  const all = mvItems();
  const shown0 = all.filter((x) => MV.showDone || !x.done);
  // 회사 목록 (현재 기간)
  const coCount = new Map();
  for (const x of shown0) coCount.set(x.co.name || '', (coCount.get(x.co.name || '') || 0) + 1);
  const cos = [...coCount.entries()].filter(([n]) => n).sort((a, b) => b[1] - a[1]);
  if (MV.co && MV.co !== '__none' && !coCount.has(MV.co)) MV.co = '';
  const byCo = shown0.filter((x) => !MV.co || (MV.co === '__none' ? !x.co.name : x.co.name === MV.co));
  const q = MV.q.trim().toLowerCase();
  const byQ = q ? byCo.filter((x) => `${x.mail.from} ${x.mail.subject} ${x.sum.gist} ${x.co.name}`.toLowerCase().includes(q)) : byCo;
  const cnt = { all: byQ.length, request: 0, due: 0, info: 0, auto: 0 };
  for (const x of byQ) cnt[x.sum.cat]++;
  const list = byQ.filter((x) => MV.cat === 'all' || x.sum.cat === MV.cat);
  if (!list.some((x) => x.mail.id === MV.sel)) MV.sel = list[0]?.mail.id || null;
  const m = mailState();
  const status = S.mailLoading
    ? '받은 편지함 읽는 중…'
    : m.lastError && !S.mailList
      ? m.lastError
      : S.mailListAt
        ? `${new Date(S.mailListAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 확인`
        : '';
  let html = `<div class="mv-bar">
      <select class="inp mv-sel" id="mv-days">${[1, 3, 7, 14].map((d) => `<option value="${d}" ${v.days === d ? 'selected' : ''}>${d === 1 ? '오늘' : `최근 ${d}일`}</option>`).join('')}</select>
      <select class="inp mv-sel mv-co" id="mv-co"><option value="">🏢 회사: 전체 (${shown0.length})</option>${cos
        .map(([n, c]) => `<option value="${h(n)}" ${MV.co === n ? 'selected' : ''}>🏢 ${h(n)} (${c})</option>`)
        .join('')}${coCount.get('') ? `<option value="__none" ${MV.co === '__none' ? 'selected' : ''}>회사 미확인 (${coCount.get('')})</option>` : ''}</select>
      <select class="inp mv-sel" id="mv-src"><option value="all" ${MV.src === 'all' ? 'selected' : ''}>메일 + 문자</option><option value="mail" ${MV.src === 'mail' ? 'selected' : ''}>✉ 메일만</option><option value="sms" ${MV.src === 'sms' ? 'selected' : ''}>💬 문자만</option></select>
      ${['all', 'request', 'due', 'info', 'auto']
        .map((c) => `<button type="button" class="mv-chip ${MV.cat === c ? 'on' : ''}" data-mvcat="${c}">${c === 'all' ? '전체' : CAT_LABEL[c]}<em>${cnt[c]}</em></button>`)
        .join('')}
      <input class="inp mv-q" id="mv-q" placeholder="🔍 보낸 사람·제목 검색" value="${h(MV.q)}">
      <label class="checkline small"><input type="checkbox" id="mv-done" ${MV.showDone ? 'checked' : ''}>완료한 메일도 보기</label>
      <div class="spacer"></div>${S.smsErr && MV.src !== 'mail' ? `<span class="small muted" title="${h(S.smsErr)}">💬 문자 없음</span>` : ''}<span class="small muted">${h(status)}</span>
      <button type="button" class="btn" data-mvrefresh ${S.mailLoading ? 'disabled' : ''}>↻ 새로고침</button>
    </div>`;
  if (!S.mailList && !S.smsList) {
    html += `<div class="mv-empty">${S.mailLoading ? 'Outlook 받은 편지함을 읽는 중입니다…' : h(m.lastError || 'Outlook 받은 편지함을 읽어 옵니다.')}<br><br>${S.mailLoading ? '' : '<button type="button" class="btn primary" data-mvrefresh>불러오기</button>'}</div>`;
    root.innerHTML = html;
    return;
  }
  // 목록
  let lastDay = '';
  const items = list
    .map((x) => {
      const d = (x.mail.received || '').slice(0, 10);
      const head = d !== lastDay ? `<div class="mv-day">${h(fmtDay(d))}</div>` : '';
      lastDay = d;
      const due = x.sum.dues.find((y) => y.date);
      const ats = x.sum.atts.length;
      return `${head}<div class="mv-item ${MV.sel === x.mail.id ? 'cur' : ''} ${x.done ? 'done' : ''}" data-mvid="${h(x.mail.id)}">
        <span class="mv-cat c-${x.sum.cat}">${h(x.sum.cat === 'due' ? '기한' : CAT_LABEL[x.sum.cat])}</span>
        <div class="mv-it"><div class="mv-r1"><b>${x.mail.source === 'sms' ? '💬 ' : ''}${h(x.mail.from || '')}</b><span>${h((x.mail.received || '').slice(11, 16))}${x.done ? ' ✓완료' : ''}</span></div>
          <div class="mv-sub ${x.mail.unread ? '' : 'read'}">${h(x.sum.title)}</div>
          ${x.sum.gist ? `<div class="mv-g">${h(x.sum.gist)}</div>` : ''}
          <div class="mv-tags">${x.co.name ? `<span class="mv-co-t">${h(x.co.name)}</span>` : ''}${due ? `<span class="mv-tag d">📅 ${h(dueTxt(due))}</span>` : ''}${ats ? `<span class="mv-tag">📎 ${ats === 1 ? h(x.sum.atts[0]) : ats}</span>` : ''}${x.sum.requests.length ? `<span class="mv-tag">요청 ${x.sum.requests.length}</span>` : ''}</div>
        </div></div>`;
    })
    .join('');
  // 상세
  const x = list.find((y) => y.mail.id === MV.sel);
  let det = '<div class="mv-empty">메일이 없습니다.</div>';
  if (x) {
    const mb = mailBodies.get(x.mail.id);
    const hits = x.sum.dues.flatMap((d) => d.hits || []);
    const readAtts = new Set([].concat(x.mail.attText || []).map((a) => a.name));
    det = `<div class="mv-dh"><div style="flex:1;min-width:0"><h2>${h(x.sum.title)}</h2>
        <div class="mv-m">${x.co.name ? `<span class="mv-co-t">${h(x.co.name)}</span> ` : ''}${h(x.mail.from || '')}${x.mail.fromAddr && !/^\/o=/i.test(x.mail.fromAddr) && x.mail.fromAddr !== x.mail.from ? ` &lt;${h(x.mail.fromAddr)}&gt;` : ''} · ${h(fmtDay((x.mail.received || '').slice(0, 10)).replace(/^(오늘|어제) · /, ''))} ${h((x.mail.received || '').slice(11, 16))} · <button type="button" class="linkbtn" data-mvco>${x.co.name ? '회사 바꾸기' : '회사 지정'}</button></div></div>
        ${x.mail.source === 'sms' ? '<span class="mv-tag" style="align-self:center">💬 휴대폰 문자</span>' : '<button type="button" class="btn" data-mvopen>Outlook에서 열기</button>'}
        <button type="button" class="btn ${x.done ? '' : 'primary'}" data-mvdone>${x.done ? '완료 취소' : '✓ 완료'}</button></div>
      <div class="mv-scroll">
      <div class="mv-sum">
        <div><h4>요지</h4><div class="mv-gist">${h(x.sum.gist || '(본문 없음)')}</div></div>
        ${x.sum.requests.length ? `<div><h4>요청 사항</h4><ul>${x.sum.requests.map((r) => `<li>${h(r)}</li>`).join('')}</ul></div>` : ''}
        ${
          x.sum.dues.length
            ? `<div><h4>기한 · 일정</h4>${x.sum.dues
                .map(
                  (d, i) => `<div class="mv-due">${d.date ? `<span class="dt">${h(dueTxt(d))}</span>` : ''}<span class="tx">${h(d.text || '')}${d.att ? ` · 📎 ${h(d.att)}` : ''}</span>
                    <button type="button" class="btn" data-mvdue="todo" data-i="${i}">할 일로</button><button type="button" class="btn primary" data-mvdue="event" data-i="${i}">일정으로</button></div>`
                )
                .join('')}</div>`
            : ''
        }
        ${x.sum.atts.length ? `<div><h4>첨부</h4><div class="mv-att">${x.sum.atts.map((n) => `<span>📎 ${h(n)}${readAtts.has(n) ? ' · 읽음' : ''}</span>`).join('')}</div></div>` : ''}
      </div>
      <details class="mv-orig" open><summary>원문</summary><div>${highlightHtml((mb?.body || stripQuoted(x.mail.body || '')).slice(0, 6000), hits, h)}</div>${[].concat(x.mail.attText || [])
        .map((a) => `<div class="mv-attt">📎 ${h(a.name)}</div><div>${highlightHtml(a.text.slice(0, 3000), hits, h)}</div>`)
        .join('')}</details>
      </div>
      <div class="mv-foot"><button type="button" class="btn" data-mvmk="todo">할 일로</button><button type="button" class="btn primary" data-mvmk="event">일정으로</button></div>`;
  }
  html += `<div class="mv-body"><div class="mv-list">${items || '<div class="mv-empty small">해당하는 메일이 없습니다.</div>'}</div><div class="mv-detail">${det}</div></div>`;
  const keepScroll = root.querySelector('.mv-list')?.scrollTop || 0;
  const focusQ = document.activeElement?.id === 'mv-q';
  root.innerHTML = html;
  root.querySelector('.mv-list').scrollTop = keepScroll;
  if (focusQ) {
    const qi = $('#mv-q', root);
    qi.focus();
    qi.setSelectionRange(qi.value.length, qi.value.length);
  }
}
function mvCurrent() {
  return mvItems().find((x) => x.mail.id === MV.sel);
}
function mvMake(kind, x, due) {
  const d = due || x.sum.dues.find((y) => y.date) || null;
  const memo = `${x.mail.source === 'sms' ? '문자' : '메일'}: ${x.mail.subject || ''}\n보낸 사람: ${x.mail.from || ''} (${(x.mail.received || '').slice(0, 16).replace('T', ' ')})${x.sum.gist ? `\n${x.sum.gist}` : ''}`;
  const title = x.co.name && !x.sum.title.includes(x.co.name) ? `${x.co.name} ${x.sum.title}` : x.sum.title;
  if (kind === 'todo') return openTodoDialog(null, { title, due: d?.date || null, time: d?.startTime || '', memo });
  const st = d?.startTime || '09:00';
  const [hh, mm] = st.split(':').map(Number);
  const v = Math.min(hh * 60 + mm + 60, 23 * 60 + 59);
  openEventDialog({
    date: d?.date || D.today(),
    preset: {
      title,
      date: d?.date || D.today(),
      endDate: d?.endDate || d?.date || D.today(),
      allDay: d ? !d.startTime : true,
      startTime: st,
      endTime: d?.endTime || `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`,
      place: d?.place || '',
      memo,
    },
  });
}
async function mvSetCompany(x) {
  const v = mvState();
  const dom = domainOf(x.mail.fromAddr);
  const { el, close } = openModal(
    `<div class="mhead"><h1>회사 지정</h1><button type="button" class="btn ghost icon" data-x aria-label="닫기">✕</button></div>
     <div class="mbody">
       <div class="fld"><label class="lbl" for="co-n">회사 이름</label><input class="inp" id="co-n" value="${h(x.co.name || '')}" list="co-list"><datalist id="co-list">${[...new Set(mvClients())].map((c) => `<option value="${h(c)}">`).join('')}</datalist></div>
       ${dom && !x.mail.internal ? `<label class="checkline small" style="margin-top:10px"><input type="checkbox" id="co-dom" checked>${h(dom)}에서 오는 메일은 앞으로 이 회사로 표시</label>` : ''}
     </div>
     <div class="mfoot"><div class="spacer"></div><button type="button" class="btn" data-x>취소</button><button type="button" class="btn primary" data-ok>저장</button></div>`,
    { cls: 'narrow' }
  );
  setTimeout(() => $('#co-n', el)?.select(), 0);
  const ok = () => {
    const n = $('#co-n', el).value.trim();
    if (n) v.over[x.mail.id] = n;
    else delete v.over[x.mail.id];
    if (n && $('#co-dom', el)?.checked) v.domains[dom] = n;
    save();
    close();
    renderMailView();
  };
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-x]')) return close();
    if (e.target.closest('[data-ok]')) ok();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      ok();
    }
  });
}
function bindMailView() {
  document.querySelector('.apptabs')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-apptab]');
    if (b) setAppTab(b.dataset.apptab);
  });
  const root = $('#mailView');
  root.addEventListener('click', async (e) => {
    const v = mvState();
    const it = e.target.closest('[data-mvid]');
    if (it) {
      MV.sel = it.dataset.mvid;
      return renderMailView();
    }
    const c = e.target.closest('[data-mvcat]');
    if (c) {
      MV.cat = c.dataset.mvcat;
      return renderMailView();
    }
    if (e.target.closest('[data-mvrefresh]')) {
      S.smsAt = Date.now();
      loadSms();
      return scanMail(true, true);
    }
    const x = mvCurrent();
    if (!x) return;
    if (e.target.closest('[data-mvdone]')) {
      if (v.done[x.mail.id]) delete v.done[x.mail.id];
      else v.done[x.mail.id] = Date.now();
      // 오래된 완료 기록 정리
      for (const [k, t] of Object.entries(v.done)) if (t < Date.now() - 60 * 864e5) delete v.done[k];
      save();
      renderMailSumBadge();
      return renderMailView();
    }
    if (e.target.closest('[data-mvopen]')) {
      const r = await window.api.outlook.open(x.mail.id);
      if (!r.ok || (r.data && r.data.ok === false)) toast(`Outlook에서 열지 못했습니다: ${r.error || r.data?.error || ''}`);
      return;
    }
    if (e.target.closest('[data-mvco]')) return mvSetCompany(x);
    const du = e.target.closest('[data-mvdue]');
    if (du) return mvMake(du.dataset.mvdue, x, x.sum.dues[+du.dataset.i]);
    const mk = e.target.closest('[data-mvmk]');
    if (mk) return mvMake(mk.dataset.mvmk, x);
  });
  root.addEventListener('change', (e) => {
    const v = mvState();
    if (e.target.id === 'mv-days') {
      v.days = +e.target.value;
      save();
      if (v.days > mailState().days && Date.now() - (S.mailListAt || 0) > 0) scanMail(true, true);
      renderMailView();
    } else if (e.target.id === 'mv-src') {
      MV.src = e.target.value;
      renderMailView();
    } else if (e.target.id === 'mv-co') {
      MV.co = e.target.value;
      renderMailView();
    } else if (e.target.id === 'mv-done') {
      MV.showDone = e.target.checked;
      renderMailView();
    }
  });
  let qt = null;
  root.addEventListener('input', (e) => {
    if (e.target.id !== 'mv-q') return;
    MV.q = e.target.value;
    clearTimeout(qt);
    qt = setTimeout(renderMailView, 200);
  });
  // ↑↓ 로 메일 이동
  document.addEventListener('keydown', (e) => {
    if (!mvVisible() || document.querySelector('.modal-back, .modal') || /input|select|textarea/i.test(document.activeElement?.tagName || '')) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const ids = [...$('#mailView').querySelectorAll('[data-mvid]')].map((n) => n.dataset.mvid);
    const i = ids.indexOf(MV.sel);
    const n = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (n && n !== MV.sel) {
      e.preventDefault();
      MV.sel = n;
      renderMailView();
      $('#mailView .mv-item.cur')?.scrollIntoView({ block: 'nearest' });
    }
  });
}

