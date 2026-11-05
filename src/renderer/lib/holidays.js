// 대한민국 법정 공휴일 (대체공휴일 포함, 선거일·임시공휴일 제외)
import { make, addDays, dow } from './dates.js';
import { lunarToSolar } from './lunar.js';

const cache = new Map();

export function getHolidays(year) {
  if (cache.has(year)) return cache.get(year);
  const map = new Map(); // date -> name
  const add = (d, name) => {
    if (!d) return;
    map.set(d, map.has(d) ? `${map.get(d)}·${name}` : name);
  };

  add(make(year, 1, 1), '신정');
  const seol = lunarToSolar(year, 1, 1)?.date;
  const seolDays = seol ? [addDays(seol, -1), seol, addDays(seol, 1)] : [];
  seolDays.forEach((d, i) => add(d, i === 1 ? '설날' : '설날 연휴'));
  add(make(year, 3, 1), '삼일절');
  add(make(year, 5, 5), '어린이날');
  const buddha = lunarToSolar(year, 4, 8)?.date;
  add(buddha, '부처님오신날');
  add(make(year, 6, 6), '현충일');
  add(make(year, 8, 15), '광복절');
  const chuseok = lunarToSolar(year, 8, 15)?.date;
  const chuseokDays = chuseok ? [addDays(chuseok, -1), chuseok, addDays(chuseok, 1)] : [];
  chuseokDays.forEach((d, i) => add(d, i === 1 ? '추석' : '추석 연휴'));
  add(make(year, 10, 3), '개천절');
  add(make(year, 10, 9), '한글날');
  add(make(year, 12, 25), '성탄절');

  // 대체공휴일 (2023년 이후 기준)
  const base = new Map(map);
  const taken = new Set(base.keys());
  const nextFree = (d, skipSat) => {
    let c = addDays(d, 1);
    while (taken.has(c) || dow(c) === 0 || (skipSat && dow(c) === 6)) c = addDays(c, 1);
    taken.add(c);
    return c;
  };
  const countOthers = (d, own) => (base.get(d) || '').split('·').filter((n) => !own.some((o) => n.startsWith(o))).length;

  for (const group of [seolDays, chuseokDays]) {
    if (!group.length) continue;
    const own = group === seolDays ? ['설날'] : ['추석'];
    const last = group[2];
    for (const d of group) {
      if (dow(d) === 0 || countOthers(d, own) > 0) map.set(nextFree(last, false), '대체공휴일');
    }
  }
  if (year >= 2021) {
    const singles = [
      [make(year, 3, 1), '삼일절'],
      [make(year, 5, 5), '어린이날'],
      [buddha, '부처님오신날'],
      [make(year, 8, 15), '광복절'],
      [make(year, 10, 3), '개천절'],
      [make(year, 10, 9), '한글날'],
      [make(year, 12, 25), '성탄절'],
    ];
    const done = new Set();
    for (const [d, name] of singles) {
      if (!d || done.has(d)) continue;
      if (year < 2023 && (name === '부처님오신날' || name === '성탄절')) continue;
      const weekend = dow(d) === 0 || dow(d) === 6;
      if (weekend || countOthers(d, [name]) > 0) {
        done.add(d); // 같은 날 공휴일이 겹쳐도 대체공휴일은 하루
        map.set(nextFree(d, true), '대체공휴일');
      }
    }
  }
  cache.set(year, map);
  return map;
}
