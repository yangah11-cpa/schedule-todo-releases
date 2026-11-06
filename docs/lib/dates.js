// 날짜 문자열('YYYY-MM-DD') 기반 유틸리티. 시간대 문제를 피하려고 모두 로컬 날짜로 다룬다.

export const pad = (n) => String(n).padStart(2, '0');

export function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parse(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function make(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function parts(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

export function today() {
  return ymd(new Date());
}

export function addDays(s, n) {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export function diffDays(a, b) {
  // b - a (일수)
  return Math.round((parse(b) - parse(a)) / 86400000);
}

export function dow(s) {
  return parse(s).getDay();
}

export function daysInMonth(y, m) {
  return new Date(y, m, 0).getDate();
}

export function addMonths(y, m, n) {
  const idx = y * 12 + (m - 1) + n;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

export const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];

export function label(s, withDow = true) {
  const { y, m, d } = parts(s);
  const base = `${y}년 ${m}월 ${d}일`;
  return withDow ? `${base} (${DOW_KO[dow(s)]})` : base;
}

export function shortLabel(s, ref = today()) {
  const { y, m, d } = parts(s);
  const r = parts(ref);
  const base = y === r.y ? `${m}월 ${d}일` : `${y}년 ${m}월 ${d}일`;
  return `${base} (${DOW_KO[dow(s)]})`;
}

export function startOfWeek(s) {
  return addDays(s, -dow(s));
}

export function minutesOf(hhmm) {
  if (!hhmm) return 0;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function toDateTime(s, hhmm) {
  const d = parse(s);
  const mins = minutesOf(hhmm);
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return d;
}
