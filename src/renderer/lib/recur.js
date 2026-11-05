// 일정 반복 펼치기 + 할 일 반복 규칙 + 빠른 입력 해석
import { addDays, diffDays, dow, parts, make, daysInMonth, addMonths, today as todayStr, DOW_KO } from './dates.js';
import { lunarToSolar, LUNAR_MAX_YEAR } from './lunar.js';

/* ───────────── 일정 ───────────── */

export const EVENT_REPEAT_LABEL = {
  none: '반복 안 함',
  daily: '매일',
  weekly: '매주',
  monthly: '매월',
  yearly: '매년',
  lunarYearly: '매년 (음력 기준)',
};

function overlaps(start, end, from, to) {
  return start <= to && end >= from;
}

/**
 * 일정 하나를 [from, to] 구간의 발생 목록으로 펼친다.
 * 반환: [{ date, endDate, lunarAdjusted? }]
 */
export function expandEvent(ev, from, to) {
  const out = [];
  const dur = Math.max(0, diffDays(ev.date, ev.endDate || ev.date));
  const ex = new Set(ev.exdates || []);
  const push = (start, extra = {}) => {
    if (ex.has(start)) return;
    const end = addDays(start, dur);
    if (overlaps(start, end, from, to)) out.push({ date: start, endDate: end, ...extra });
  };

  if (ev.calType === 'lunar') {
    const { month, day, leap } = ev.lunar;
    const baseYear = ev.lunar.baseYear || parts(ev.date).y;
    if (ev.repeat !== 'lunarYearly') {
      push(ev.date);
      return out;
    }
    const y0 = Math.max(baseYear, parts(from).y - 1);
    const y1 = Math.min(LUNAR_MAX_YEAR, parts(to).y);
    for (let y = y0; y <= y1; y++) {
      const r = lunarToSolar(y, month, day, leap);
      if (r) push(r.date, { lunarYear: y, lunarAdjusted: r.adjusted });
    }
    return out;
  }

  const rep = ev.repeat || 'none';
  if (rep === 'none') {
    push(ev.date);
    return out;
  }
  if (ev.date > to) return out;
  const startFloor = addDays(from, -dur);

  if (rep === 'daily' || rep === 'weekly') {
    const step = rep === 'daily' ? 1 : 7;
    let cur = ev.date;
    if (cur < startFloor) {
      const k = Math.floor(diffDays(cur, startFloor) / step);
      cur = addDays(cur, k * step);
    }
    for (; cur <= to; cur = addDays(cur, step)) push(cur);
    return out;
  }

  const { y: by, m: bm, d: bd } = parts(ev.date);
  const step = rep === 'monthly' ? 1 : 12;
  const f = parts(startFloor);
  let k = Math.max(0, Math.floor(((f.y - by) * 12 + (f.m - bm)) / step) - 1);
  for (; ; k++) {
    const { y, m } = addMonths(by, bm, k * step);
    const first = make(y, m, 1);
    if (first > to) break;
    if (bd <= daysInMonth(y, m)) push(make(y, m, bd)); // 해당 날짜가 없는 달은 건너뜀(구글 캘린더와 동일)
  }
  return out;
}

/* ───────────── 할 일 반복 ───────────── */

export function ruleMatches(rule, date, anchor) {
  const n = Math.max(1, rule.interval || 1);
  const a = parts(anchor);
  const p = parts(date);
  switch (rule.type) {
    case 'daily':
      return diffDays(anchor, date) % n === 0;
    case 'weekdays': {
      const w = dow(date);
      return w >= 1 && w <= 5;
    }
    case 'weekly': {
      const days = rule.weekdays && rule.weekdays.length ? rule.weekdays : [dow(anchor)];
      if (!days.includes(dow(date))) return false;
      const weeks = Math.floor(diffDays(addDays(anchor, -dow(anchor)), addDays(date, -dow(date))) / 7);
      return weeks % n === 0;
    }
    case 'monthly': {
      const months = (p.y - a.y) * 12 + (p.m - a.m);
      if (months % n !== 0) return false;
      const dim = daysInMonth(p.y, p.m);
      if (rule.monthDay === 'last') return p.d === dim;
      const want = rule.monthDay || a.d;
      return p.d === Math.min(want, dim); // 31일 지정 시 짧은 달은 말일
    }
    case 'yearly': {
      if ((p.y - a.y) % n !== 0) return false;
      if (p.m !== a.m) return false;
      return p.d === Math.min(a.d, daysInMonth(p.y, p.m));
    }
    default:
      return false;
  }
}

/** after 다음(초과) 첫 발생일. 없으면 null */
export function nextOccurrence(rule, after, anchor) {
  if (!rule || rule.type === 'none') return null;
  if (rule.type === 'afterN') return addDays(todayStr(), Math.max(1, rule.interval || 1));
  let d = addDays(after, 1);
  for (let i = 0; i < 4000; i++, d = addDays(d, 1)) {
    if (d >= anchor && ruleMatches(rule, d, anchor)) return d;
  }
  return null;
}

/** after 이후(포함) 첫 발생일 */
export function firstOnOrAfter(rule, from, anchor) {
  return nextOccurrence(rule, addDays(from, -1), anchor);
}

export function describeRule(rule) {
  if (!rule || rule.type === 'none') return '';
  const n = Math.max(1, rule.interval || 1);
  switch (rule.type) {
    case 'daily':
      return n === 1 ? '매일' : `${n}일마다`;
    case 'weekdays':
      return '평일마다';
    case 'weekly': {
      const days = (rule.weekdays || []).slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
      const names = days.map((d) => DOW_KO[d]).join('·');
      return `${n === 1 ? '매주' : `${n}주마다`} ${names}`.trim();
    }
    case 'monthly': {
      const day = rule.monthDay === 'last' ? '말일' : rule.monthDay ? `${rule.monthDay}일` : '';
      return `${n === 1 ? '매월' : `${n}개월마다`} ${day}`.trim();
    }
    case 'yearly':
      return n === 1 ? '매년' : `${n}년마다`;
    case 'afterN':
      return `완료 후 ${n}일`;
    default:
      return '';
  }
}

/* ───────────── 빠른 입력 ───────────── */

const DOW_MAP = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };

/**
 * 예) "매주 월 주간보고", "매주 월,수 운동", "매월 말일 결산", "매월 15일 급여 확인",
 *     "평일 메일 정리", "매일 일기", "매년 자동차보험", "오늘 자료 인쇄", "내일 회의 준비",
 *     "11/30 보고서 제출", "3일후 회신"
 */
export function parseQuickAdd(text, today = todayStr()) {
  let t = text.trim();
  let due = null;
  let repeat = { type: 'none' };
  let m;

  if ((m = t.match(/^매일\s+(.+)$/))) {
    repeat = { type: 'daily', interval: 1 };
    due = today;
    t = m[1];
  } else if ((m = t.match(/^(?:평일|매일\(평일\))\s+(.+)$/))) {
    repeat = { type: 'weekdays', interval: 1 };
    t = m[1];
    due = firstOnOrAfter(repeat, today, today);
  } else if ((m = t.match(/^매주\s+([일월화수목금토](?:요일)?(?:\s*[,·]\s*[일월화수목금토](?:요일)?)*)\s+(.+)$/))) {
    const days = m[1].split(/[,·]/).map((s) => DOW_MAP[s.trim()[0]]);
    repeat = { type: 'weekly', interval: 1, weekdays: [...new Set(days)] };
    t = m[2];
    due = firstOnOrAfter(repeat, today, today);
  } else if ((m = t.match(/^매주\s+(.+)$/))) {
    repeat = { type: 'weekly', interval: 1, weekdays: [dow(today)] };
    due = today;
    t = m[1];
  } else if ((m = t.match(/^매월\s+(말일|\d{1,2}일)\s+(.+)$/))) {
    const md = m[1] === '말일' ? 'last' : Math.min(31, parseInt(m[1], 10));
    repeat = { type: 'monthly', interval: 1, monthDay: md };
    t = m[2];
    due = firstOnOrAfter(repeat, today, today);
  } else if ((m = t.match(/^매년\s+(.+)$/))) {
    repeat = { type: 'yearly', interval: 1 };
    due = today;
    t = m[1];
  } else if ((m = t.match(/^오늘\s+(.+)$/))) {
    due = today;
    t = m[1];
  } else if ((m = t.match(/^내일\s+(.+)$/))) {
    due = addDays(today, 1);
    t = m[1];
  } else if ((m = t.match(/^모레\s+(.+)$/))) {
    due = addDays(today, 2);
    t = m[1];
  } else if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\s+(.+)$/))) {
    const { y } = parts(today);
    const mo = +m[1];
    const da = +m[2];
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= daysInMonth(y, mo)) {
      due = make(y, mo, da);
      if (due < today) due = make(y + 1, mo, Math.min(da, daysInMonth(y + 1, mo)));
      t = m[3];
    }
  } else if ((m = t.match(/^(\d{1,3})일\s*(?:후|뒤)\s+(.+)$/))) {
    due = addDays(today, +m[1]);
    t = m[2];
  }
  return { title: t.trim(), due, repeat };
}
