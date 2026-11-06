// 이 프로그램의 일정 ↔ Google 캘린더 일정 변환
import { addDays, ymd, pad, minutesOf } from './dates.js';
import { lunarToSolar, LUNAR_MAX_YEAR } from './lunar.js';

export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul';
const FREQ = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' };

export function timeRange(date, endDate, ev) {
  if (ev.allDay) {
    return { start: { date }, end: { date: addDays(endDate, 1) } };
  }
  let st = ev.startTime || '09:00';
  let et = ev.endTime || st;
  let ed = endDate;
  if (ed === date && minutesOf(et) <= minutesOf(st)) {
    const m = Math.min(minutesOf(st) + 60, 23 * 60 + 59);
    et = `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  }
  return {
    start: { dateTime: `${date}T${st}:00`, timeZone: TZ },
    end: { dateTime: `${ed}T${et}:00`, timeZone: TZ },
  };
}

function reminders(ev) {
  if (ev.alarm === null || ev.alarm === undefined || ev.alarm === '') return { useDefault: false, overrides: [] };
  return { useDefault: false, overrides: [{ method: 'popup', minutes: Number(ev.alarm) }] };
}

// 장소·참여 인원은 Google 일정의 '설명'란 끝에 아래 형식으로 함께 기록한다.
// (Google의 위치 필드·참석자 초대는 사용하지 않음)
const TAG = '[일정 & 할일]';

export function composeDescription(memo, place, people) {
  const lines = [];
  if (place) lines.push(`장소: ${place}`);
  if (people && people.length) lines.push(`참여 인원: ${people.join(', ')}`);
  const m = (memo || '').trim();
  if (!lines.length) return m;
  return `${m ? `${m}\n\n` : ''}${TAG}\n${lines.join('\n')}`;
}

export function parseDescription(desc) {
  const text = (desc || '').replace(/\r\n/g, '\n');
  const i = text.lastIndexOf(TAG);
  if (i < 0) return { memo: text.trim(), place: '', people: [] };
  let place = '';
  let people = [];
  for (const line of text.slice(i + TAG.length).split('\n')) {
    const t = line.trim();
    if (t.startsWith('장소:')) place = t.slice(3).trim();
    else if (t.startsWith('참여 인원:')) people = t.slice(6).split(',').map((s) => s.trim()).filter(Boolean);
  }
  return { memo: text.slice(0, i).trim(), place, people };
}

function base(ev, extra = {}) {
  return {
    summary: ev.title,
    description: composeDescription(ev.memo, ev.place, ev.people),
    reminders: reminders(ev),
    extendedProperties: { private: { stApp: ev.id, ...extra } },
  };
}

export function solarPayload(ev) {
  const p = { ...base(ev), ...timeRange(ev.date, ev.endDate || ev.date, ev) };
  const freq = FREQ[ev.repeat];
  if (freq) {
    const rec = [`RRULE:FREQ=${freq}`];
    if (ev.exdates && ev.exdates.length) {
      const ds = ev.exdates.map((d) => d.replace(/-/g, ''));
      if (ev.allDay) rec.push(`EXDATE;VALUE=DATE:${ds.join(',')}`);
      else rec.push(`EXDATE;TZID=${TZ}:${ds.map((d) => `${d}T${(ev.startTime || '09:00').replace(':', '')}00`).join(',')}`);
    }
    p.recurrence = rec;
  } else {
    p.recurrence = [];
  }
  return p;
}

/** 음력 일정을 Google에 올릴 연도별 날짜 목록 */
export function lunarTargets(ev, years, thisYear) {
  const out = [];
  const baseYear = ev.lunar.baseYear;
  const ex = new Set(ev.exdates || []);
  if (ev.repeat !== 'lunarYearly') {
    if (!ex.has(ev.date)) out.push({ year: baseYear, date: ev.date });
    return out;
  }
  const from = Math.max(baseYear, thisYear - 1);
  const to = Math.min(LUNAR_MAX_YEAR, thisYear + years - 1);
  for (let y = from; y <= to; y++) {
    const r = lunarToSolar(y, ev.lunar.month, ev.lunar.day, ev.lunar.leap);
    if (r && !ex.has(r.date)) out.push({ year: y, date: r.date });
  }
  return out;
}

export function lunarPayload(ev, year, date) {
  return { ...base(ev, { stYear: String(year) }), ...timeRange(date, date, ev), recurrence: [] };
}

/** Google 일정 → 화면 표시용 객체 */
export function fromGoogle(item, cal) {
  const allDay = !!item.start?.date;
  let date, endDate, startTime = null, endTime = null;
  if (allDay) {
    date = item.start.date;
    endDate = addDays(item.end?.date || addDays(date, 1), -1);
    if (endDate < date) endDate = date;
  } else {
    const s = new Date(item.start.dateTime);
    const e = new Date(item.end?.dateTime || item.start.dateTime);
    date = ymd(s);
    endDate = ymd(e);
    startTime = `${pad(s.getHours())}:${pad(s.getMinutes())}`;
    endTime = `${pad(e.getHours())}:${pad(e.getMinutes())}`;
    if (endDate > date && endTime === '00:00') endDate = addDays(endDate, -1);
  }
  const priv = item.extendedProperties?.private || {};
  const desc = parseDescription(item.description);
  return {
    place: desc.place || (item.location || ''), // 설명란 기록이 없으면 Google 위치 필드 참고(읽기만)
    people: desc.people,
    source: 'google',
    key: `${cal.id}|${item.id}`,
    calendarId: cal.id,
    holidayCal: /#holiday@group\.v\.calendar\.google\.com$/.test(cal.id),
    rawDesc: item.description || '',
    calendarName: cal.summary,
    color: cal.color,
    writable: cal.writable,
    gid: item.id,
    recurringEventId: item.recurringEventId || null,
    title: item.summary || '(제목 없음)',
    memo: desc.memo,
    date,
    endDate,
    allDay,
    startTime,
    endTime,
    alarm: item.reminders?.overrides?.[0]?.minutes ?? null,
    appId: priv.stApp || null,
    htmlLink: item.htmlLink,
    updated: item.updated || null,
    lunarSeries: (item.extendedProperties?.private || {}).stYear ? true : false,
  };
}
