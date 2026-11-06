import * as D from './lib/dates.js';
import { solarToLunar, lunarToSolar, LUNAR_MAX_YEAR } from './lib/lunar.js';
import { expandEvent, nextOccurrence, firstOnOrAfter, describeRule, parseQuickAdd, EVENT_REPEAT_LABEL } from './lib/recur.js';
import { getHolidays } from './lib/holidays.js';
import { solarPayload, lunarTargets, lunarPayload, fromGoogle, timeRange, composeDescription } from './lib/gsync.js';

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
  return `<button type="button" class="${cls}" data-item="${it.idx}" title="${h(label)}">${dot}${h(label)}</button>`;
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
  return `<button type="button" class="${cls}" data-item="${it.idx}" title="${h(label)}" style="${h(style)}">${dot}${h(label)}</button>`;
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
    b.hidden = u.status !== 'ready';
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
    if (e.key === 'Escape' && root.lastElementChild === ov) close();
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

function maybeRefresh() {
  if (!S.g.connected) return;
  const { from, to } = viewRange();
  if (!S.gRange || from < S.gRange.from || to > S.gRange.to) refreshGoogle();
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

function openEventDialog({ ev = null, g = null, date = null, occ = null } = {}) {
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
  const readonly = ext && !g.writable;
  const recurringExt = ext && !!g.recurringEventId;

  const html = `
    <div class="mhead"><h1>${ev || g ? '일정 수정' : '새 일정'}</h1><button type="button" class="btn ghost icon" data-close aria-label="닫기">✕</button></div>
    <form class="mbody" id="evForm" autocomplete="off"></form>
    <div class="mfoot">
      ${ev || (g && !readonly) ? '<button type="button" class="btn danger" data-del>삭제</button>' : ''}
      ${g?.htmlLink ? '<button type="button" class="btn ghost" data-open-g>Google에서 열기</button>' : ''}
      <div class="spacer"></div>
      <button type="button" class="btn" data-close>취소</button>
      <button type="button" class="btn primary" data-save>${readonly ? '닫기' : '저장'}</button>
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
        ext
          ? ''
          : `<div class="fld"><span class="lbl">날짜 기준</span>
        <div class="radio2 lunar" role="radiogroup">
          <label class="${!isL ? 'on' : ''}"><input type="radio" name="caltype" value="solar" ${!isL ? 'checked' : ''}>양력</label>
          <label class="${isL ? 'on l' : ''}"><input type="radio" name="caltype" value="lunar" ${isL ? 'checked' : ''} style="accent-color:var(--lunar)">음력</label>
        </div></div>`
      }
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
          : `<div class="grid2">
              <div class="fld"><label class="lbl" for="e-rep">반복</label><select class="inp" id="e-rep">${sel(repOpts, f.repeat)}</select></div>
              <div class="fld"><label class="lbl" for="e-alarm">알림</label><select class="inp" id="e-alarm">${sel(f.allDay ? ALARMS_ALLDAY : ALARMS_TIMED, f.alarm)}</select></div>
            </div>
            ${isL ? `<div class="preview" id="e-prev">${lunarPreview()}</div>` : ''}`
      }
      ${ev && ev.repeat !== 'none' ? '<div class="note">반복 일정을 수정하면 반복 전체에 적용됩니다.</div>' : ''}
      ${ev?.syncError ? `<div class="warn">Google 동기화 대기 중: ${h(ev.syncError)}</div>` : ''}
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
    else if (id === 'e-st') f.startTime = e.target.value;
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
    if (n && !n.done && !n.touched && !(n.subtasks || []).some((s) => s.done)) S.data.todos.splice(i, 1);
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
      <button type="button" class="btn" data-close>취소</button>
      <button type="button" class="btn primary" data-save>저장</button>
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
            </div>`
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
      Object.assign(o, { title: t.title, repeat: { ...r }, genMode: t.genMode, showOnCalendar: t.showOnCalendar, anchor: t.anchor, time: t.time });
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
  S.data.todos = S.data.todos.filter((o) => !(o.deleted && !(o.seriesId && o.genMode === 'fixed' && !o.seriesEnded)));
  save();
  renderAll();
  return true;
}

/* ───────────── 설정 창 ───────────── */
async function openSettings() {
  const st = settings();
  const ver = await window.api.version();
  const info = await window.api.info();
  const { el, close } = openModal(
    `<div class="mhead"><h1>설정</h1><button type="button" class="btn ghost icon" data-close aria-label="닫기">✕</button></div>
     <div class="mbody" id="setBody"></div>
     <div class="mfoot"><span class="note">버전 ${h(ver)}</span><div class="spacer"></div><button type="button" class="btn primary" data-close>닫기</button></div>`,
    { cls: 'wide', onClose: () => renderAll() }
  );
  const body = $('#setBody', el);
  const draw = () => {
    const g = S.g;
    const cals = S.calendars;
    body.innerHTML = `
      <section class="sect" style="border-top:0;padding-top:0">
        <h2>Google 캘린더 연결</h2>
        ${
          g.connected
            ? `<div class="row gap8 wrap"><span class="small">연결된 계정: <b>${h(g.account || '알 수 없음')}</b></span><div class="spacer"></div><button type="button" class="btn danger" data-gdisconnect>연결 해제</button></div>`
            : `<ol class="steps">
                <li><button type="button" class="linkbtn" data-ext="https://console.cloud.google.com/projectcreate">Google Cloud 콘솔</button>에서 프로젝트를 하나 만듭니다.</li>
                <li><button type="button" class="linkbtn" data-ext="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com">Google Calendar API</button>를 "사용"으로 설정합니다.</li>
                <li><button type="button" class="linkbtn" data-ext="https://console.cloud.google.com/auth/overview">OAuth 동의 화면(Google 인증 플랫폼)</button>을 구성합니다. 대상은 "외부", 본인 Gmail을 테스트 사용자로 추가한 뒤 게시 상태를 <b>"프로덕션"</b>으로 바꾸세요. (테스트 상태로 두면 7일마다 다시 로그인해야 합니다.)</li>
                <li><button type="button" class="linkbtn" data-ext="https://console.cloud.google.com/auth/clients">클라이언트</button> 메뉴에서 "OAuth 클라이언트 ID 만들기" → 애플리케이션 유형 <b>"데스크톱 앱"</b>을 선택하고, 발급된 클라이언트 ID와 보안 비밀번호를 아래에 붙여넣습니다.</li>
                <li>"연결"을 누르면 브라우저에서 로그인 창이 열립니다. "확인되지 않은 앱" 경고가 나오면 고급 → 이동을 눌러 허용하세요 (본인이 만든 앱).</li>
              </ol>
              <div class="fld"><label class="lbl" for="s-cid">클라이언트 ID</label><input class="inp" id="s-cid" value="${h(g.clientId || '')}" placeholder="xxxxxxxx.apps.googleusercontent.com"></div>
              <div class="fld"><label class="lbl" for="s-sec">클라이언트 보안 비밀번호</label><input class="inp" id="s-sec" type="password" placeholder="${g.configured ? '저장됨 (변경할 때만 입력)' : 'GOCSPX-…'}"></div>
              <div class="row gap8"><button type="button" class="btn primary" data-gconnect>연결</button><span class="small muted" id="s-gmsg"></span></div>`
        }
      </section>
      ${
        g.connected && cals.length
          ? `<section class="sect"><h2>표시할 Google 캘린더</h2>
              <div class="callist">${cals
                .map(
                  (c) => `<label class="checkline small"><input type="checkbox" data-calvis="${h(c.id)}" ${isCalVisible(c) ? 'checked' : ''}><span class="cdot" style="display:inline-block;width:10px;height:10px;border-radius:99px;background:${h(c.color || '#999')}"></span>${h(c.summary)}${c.primary ? ' (기본)' : ''}${c.writable ? '' : ' · 읽기 전용'}</label>`
                )
                .join('')}</div>
              <span class="note">"대한민국의 휴일" 같은 휴일 캘린더는 일정이 아니라 날짜 옆에 휴일 이름으로 표시되며, 켜 두면 프로그램 내장 공휴일 대신 사용됩니다.</span>
            </section>`
          : ''
      }
      <section class="sect"><h2>일정</h2>
        <div class="grid2">
          <div class="fld"><label class="lbl" for="s-ly">음력 반복 일정을 Google에 등록할 기간</label>
            <select class="inp" id="s-ly">${[5, 10, 20, 30].map((n) => `<option value="${n}" ${st.lunarYears === n ? 'selected' : ''}>앞으로 ${n}년</option>`).join('')}</select></div>
          <div></div>
        </div>
        <label class="checkline small"><input type="checkbox" id="s-hol" ${st.showHolidays ? 'checked' : ''}>공휴일 표시 (대체공휴일 포함, 선거일·임시공휴일 제외)</label>
        <label class="checkline small"><input type="checkbox" id="s-lun" ${st.showLunar ? 'checked' : ''}>음력 날짜 표시</label>
      </section>
      <section class="sect"><h2>업데이트</h2>
        <div class="row gap8 wrap"><span class="small">현재 버전 ${h(ver)}${info?.source === 'patch' ? ` <span class="muted">(즉시 적용 · 설치본 ${h(info.bundledVersion)})</span>` : ''}</span><button type="button" class="btn" data-updcheck>업데이트 확인</button><span class="small muted" id="updMsg"></span></div>
        <span class="note">새 버전은 자동으로 내려받아 두었다가 프로그램을 닫을 때 설치됩니다.</span>
      </section>
      <section class="sect"><h2>데이터</h2>
        <div class="row gap8 wrap"><button type="button" class="btn" data-export>내보내기 (백업)</button><button type="button" class="btn" data-import>가져오기 (복원)</button></div>
        <span class="note">할 일과 "이 PC에만" 일정은 이 컴퓨터에 저장됩니다. 다른 PC로 옮길 때 내보내기/가져오기를 사용하세요.</span>
      </section>`;

    renderUpdate();
  };
  draw();

  body.addEventListener('change', async (e) => {
    const t = e.target;
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
    if (e.target.closest('[data-close]')) close();
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
  const notify = (title, body) => {
    try {
      new Notification(title, { body });
    } catch {
      /* 무시 */
    }
  };
  for (const ev of S.data.events) {
    if (ev.calendarId !== 'local' || ev.alarm === null || ev.alarm === undefined) continue;
    for (const o of expandEvent(ev, from, to)) {
      const start = D.toDateTime(o.date, ev.allDay ? '00:00' : ev.startTime).getTime();
      const at = start - ev.alarm * 60000;
      if (at > since && at <= now) notify(ev.title, `${D.label(o.date)}${ev.allDay ? '' : ` ${ev.startTime}`}${ev.place ? ` · ${ev.place}` : ''}`);
    }
  }
  for (const t of S.data.todos) {
    if (t.done || t.deleted || !t.due || !t.time) continue;
    const at = D.toDateTime(t.due, t.time).getTime();
    if (at > since && at <= now) notify(`할 일: ${t.title}`, `${D.label(t.due)} ${t.time}`);
  }
  st.lastAlarmCheck = now;
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
