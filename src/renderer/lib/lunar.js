// 한국 음력 변환 (한국천문연구원 기준 데이터, 1000~2050년 지원)
import KoreanLunarCalendar from '../vendor/korean-lunar-calendar.mjs';
import { make, parts } from './dates.js';

export const LUNAR_MAX_YEAR = 2050;
const cache = new Map();

export function solarToLunar(s) {
  if (cache.has(s)) return cache.get(s);
  const { y, m, d } = parts(s);
  const c = new KoreanLunarCalendar();
  let out = null;
  if (c.setSolarDate(y, m, d)) {
    const l = c.getLunarCalendar();
    out = { year: l.year, month: l.month, day: l.day, leap: !!l.intercalation };
  }
  cache.set(s, out);
  return out;
}

function tryLunar(year, month, day, leap) {
  const c = new KoreanLunarCalendar();
  if (!c.setLunarDate(year, month, day, leap)) return null;
  const s = c.getSolarCalendar();
  return make(s.year, s.month, s.day);
}

/**
 * 음력 → 양력. 해당 연도에 윤달이 없으면 평달로, 30일이 없는 달(작은달)이면 29일로 대체한다.
 * 반환: { date, adjusted } 또는 null(지원 범위 밖)
 */
export function lunarToSolar(year, month, day, leap = false) {
  if (year < 1000 || year > LUNAR_MAX_YEAR) return null;
  let r = tryLunar(year, month, day, leap);
  if (r) return { date: r, adjusted: false };
  if (leap) {
    r = tryLunar(year, month, day, false);
    if (r) return { date: r, adjusted: true };
  }
  if (day === 30) {
    r = tryLunar(year, month, 29, leap) || tryLunar(year, month, 29, false);
    if (r) return { date: r, adjusted: true };
  }
  return null;
}

export function lunarLabel(l, withPrefix = true) {
  if (!l) return '';
  return `${withPrefix ? '음 ' : ''}${l.leap ? '윤' : ''}${l.month}.${l.day}`;
}
