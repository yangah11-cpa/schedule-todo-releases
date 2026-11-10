// 메일 본문에서 일정 후보(날짜·시간·장소)를 찾는다. 모든 처리는 PC 안에서만.
import { addDays, dow, make, parts, daysInMonth } from './dates.js';

const DOW = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const KEY = /회의|미팅|meeting|방문|실사|감사|일정|면담|인터뷰|교육|세미나|워크숍|설명회|마감|제출|기한|까지|약속|참석|일시|예정|진행|통화|콜|점심|저녁|식사|만찬|발표|보고|입회|킥오프|kick|착수|종료|평가|심사|강의|행사|모임|출장/i;

/** 제목 정리: RE:/FW:/회신:/전달:/[외부] 등 제거 */
export function cleanSubject(s) {
  let t = String(s || '').trim();
  for (let i = 0; i < 5; i++) {
    const n = t.replace(/^\s*(?:(?:re|fw|fwd)\s*:|회신\s*:|전달\s*:|답장\s*:|\[[^\]]{1,12}\]|\([^)]{1,6}\))\s*/i, '');
    if (n === t) break;
    t = n;
  }
  return t.trim();
}

/** 회신·전달 메일의 이전 메일 부분을 잘라낸다 */
export function stripQuoted(body) {
  const lines = String(body || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^\s*-{2,}\s*(original message|원본 메시지|원래 메시지|forwarded message|전달된 메시지)/i.test(l)) break;
    if (/^\s*(보낸 사람|from)\s*:/i.test(l) && out.length > 2) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n');
}

const pad = (n) => String(n).padStart(2, '0');
const valid = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);

/** 연도 없는 월·일: 기준일 근처(지난 2개월 이내면 올해, 그보다 이전이면 내년) */
function nearYear(m, d, base) {
  const { y } = parts(base);
  if (!valid(y, m, d) && !valid(y + 1, m, d)) return null;
  let s = valid(y, m, d) ? make(y, m, d) : null;
  if (!s || s < addDays(base, -60)) s = valid(y + 1, m, d) ? make(y + 1, m, d) : s;
  return s;
}

/** 날짜 표현 찾기 → [{date, endDate?, idx, len}] */
function findDates(text, base) {
  const found = [];
  const push = (date, idx, len, endDate = null) => {
    if (!date) return;
    if (found.some((f) => idx < f.idx + f.len && f.idx < idx + len)) return; // 겹치는 표현은 먼저 찾은 것만
    found.push({ date, endDate, idx, len });
  };
  let m;
  const wd = '(?:\\s*\\(?\\s*([일월화수목금토])(?:요일)?\\s*\\)?)?';

  // 2026년 11월 20일 / 2026.11.20 / 2026-11-20 / 2026/11/20 (+ ~ 21일 / ~ 11.21)
  const full = new RegExp(`(20\\d{2})\\s*[년.\\-/]\\s*(\\d{1,2})\\s*[월.\\-/]\\s*(\\d{1,2})\\s*일?\\.?${wd}(?:\\s*[~∼\\-–]\\s*(?:(\\d{1,2})\\s*[월./]\\s*)?(\\d{1,2})\\s*일?)?`, 'g');
  while ((m = full.exec(text))) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (!valid(y, mo, d)) continue;
    let end = null;
    if (m[6] && valid(y, +(m[5] || mo), +m[6])) end = make(y, +(m[5] || mo), +m[6]);
    push(make(y, mo, d), m.index, m[0].length, end && end > make(y, mo, d) ? end : null);
  }
  // 11월 20일(목) ~ 21일 / 11월 20일 ~ 11월 21일
  const kor = new RegExp(`(\\d{1,2})\\s*월\\s*(\\d{1,2})\\s*일${wd}(?:\\s*(?:[~∼\\-–]|부터)\\s*(?:(\\d{1,2})\\s*월\\s*)?(\\d{1,2})\\s*일)?`, 'g');
  while ((m = kor.exec(text))) {
    const s = nearYear(+m[1], +m[2], base);
    if (!s) continue;
    let end = null;
    if (m[5]) {
      const { y } = parts(s);
      const em = +(m[4] || m[1]);
      if (valid(y, em, +m[5])) end = make(y, em, +m[5]);
      if (end && end < s && valid(y + 1, em, +m[5])) end = make(y + 1, em, +m[5]);
    }
    push(s, m.index, m[0].length, end && end > s ? end : null);
  }
  // 11/20, 11/20(목), 11.20(목) — 점 표기는 요일이 붙을 때만(소수점과 구분)
  const slash = /(?<![\d/.])(\d{1,2})\s*\/\s*(\d{1,2})(?![\d/])(?:\s*\(?\s*([일월화수목금토])(?:요일)?\s*\)?)?(?:\s*[~∼\-–]\s*(?:(\d{1,2})\s*\/\s*)?(\d{1,2})(?![\d/]))?/g;
  while ((m = slash.exec(text))) {
    if (/분기|페이지|쪽/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 3))) continue;
    const s = nearYear(+m[1], +m[2], base);
    if (!s) continue;
    let end = null;
    if (m[5]) {
      const { y } = parts(s);
      const em = +(m[4] || m[1]);
      if (valid(y, em, +m[5])) end = make(y, em, +m[5]);
    }
    push(s, m.index, m[0].length, end && end > s ? end : null);
  }
  const dot = /(?<![\d.])(\d{1,2})\s*\.\s*(\d{1,2})\s*\.?\s*\(\s*([일월화수목금토])(?:요일)?\s*\)/g;
  while ((m = dot.exec(text))) push(nearYear(+m[1], +m[2], base), m.index, m[0].length);

  // 20일(목) — 요일과 맞는 가장 가까운 달
  const dayOnly = /(?<![\d월.\/])(\d{1,2})\s*일\s*\(\s*([일월화수목금토])(?:요일)?\s*\)/g;
  while ((m = dayOnly.exec(text))) {
    const d = +m[1];
    const w = DOW[m[2]];
    let { y, m: mo } = parts(base);
    let hit = null;
    for (let k = -1; k <= 2 && !hit; k++) {
      let yy = y, mm = mo + k;
      if (mm < 1) (mm += 12), yy--;
      if (mm > 12) (mm -= 12), yy++;
      if (valid(yy, mm, d) && dow(make(yy, mm, d)) === w && make(yy, mm, d) >= addDays(base, -7)) hit = make(yy, mm, d);
    }
    push(hit, m.index, m[0].length);
  }
  // 오늘 / 내일 / 모레 / 글피
  const rel = { 오늘: 0, 금일: 0, 내일: 1, 명일: 1, 모레: 2, 글피: 3 };
  const relRe = /(?<![가-힣])(오늘|금일|내일|명일|모레|글피)(?![가-힣]{0,0}[가-힣]*적)/g;
  while ((m = relRe.exec(text))) push(addDays(base, rel[m[1]]), m.index, m[0].length);
  // (이번 주|금주|다음 주|차주|다다음 주) X요일
  const wk = /(이번\s*주|이번주|금주|다음\s*주|담주|차주|다다음\s*주)\s*([일월화수목금토])요일?/g;
  while ((m = wk.exec(text))) {
    const off = /다다음/.test(m[1]) ? 14 : /다음|담주|차주/.test(m[1]) ? 7 : 0;
    const mon = addDays(base, -((dow(base) + 6) % 7)); // 기준 주 월요일
    push(addDays(mon, off + ((DOW[m[2]] + 6) % 7)), m.index, m[0].length);
  }
  return found.sort((a, b) => a.idx - b.idx);
}

/** 날짜 바로 뒤(또는 앞) 시간 표현 → {start, end} */
function findTime(seg) {
  const one = /(오전|오후|낮|저녁|밤|아침|AM|PM|am|pm)?\s*(\d{1,2})\s*(?:시\s*(?:(\d{1,2})\s*분|(반))?|:\s*(\d{2}))(?!\s*(?:간|까지\s*소요|개|명|%))/g;
  const times = [];
  let m;
  while ((m = one.exec(seg)) && times.length < 2) {
    let h = +m[2];
    const mi = m[3] ? +m[3] : m[4] ? 30 : m[5] ? +m[5] : 0;
    if (h > 24 || mi > 59) continue;
    const ap = m[1] || '';
    if (/오후|저녁|밤|pm/i.test(ap) && h < 12) h += 12;
    else if (/오전|아침|am/i.test(ap) && h === 12) h = 0;
    else if (!ap && !m[5] && h >= 1 && h <= 6) h += 12; // "2시" → 오후 2시 (업무 시간 기준)
    else if (!ap && m[5] && h >= 1 && h <= 6 && times.length && times[0].h >= 12) h += 12;
    if (h === 24) h = 23;
    times.push({ h, mi, idx: m.index, len: m[0].length });
  }
  if (!times.length) return null;
  const fmt = (t) => `${pad(t.h)}:${pad(t.mi)}`;
  const start = fmt(times[0]);
  let end = null;
  if (times[1]) {
    const between = seg.slice(times[0].idx + times[0].len, times[1].idx);
    if (/^\s*(?:[~∼\-–]|부터|에서)\s*$/.test(between) || /^\s*[~∼\-–]\s*$/.test(between)) {
      let t2 = times[1];
      if (t2.h < times[0].h && t2.h + 12 <= 23) t2 = { ...t2, h: t2.h + 12 };
      if (t2.h * 60 + t2.mi > times[0].h * 60 + times[0].mi) end = fmt(t2);
    }
  }
  return { start, end };
}

/** "장소: ..." 줄 */
function findPlace(text) {
  const m = text.match(/(?:^|\n)\s*[-*•·▶■□◎○●※]?\s*(?:장\s*소|위\s*치|place|location)\s*[:：]\s*([^\n]{2,80})/i);
  return m ? m[1].trim().replace(/\s{2,}/g, ' ') : '';
}

// 자동 발송 알림 메일(로그인·보안·결제·배송·광고 등)은 일정이 아니다
const AUTO_SENDER = /no-?reply|do-?not-?reply|donotreply|mailer-daemon|notification|notice|alert|news(letter)?@|계정\s*팀|account team|security/i;
const AUTO_SUBJECT = /로그인|로그 인|sign-?in|보안\s*(알림|경고|코드)|인증\s*(번호|코드)|비밀번호|password|verification|영수증|receipt|결제|청구서|invoice|주문|배송|구독|뉴스레터|newsletter|\(광고\)|\[광고\]|unsubscribe/i;
// 메일 머리글·발송 정보 줄 (일정 날짜가 아님)
const META_LINE = /^\s*(?:날짜|보낸\s*날짜|받은\s*날짜|발송\s*(?:일시|시간)|date|sent|received|timestamp|시간\s*\(UTC\)|time)\s*[:：]/i;

export function isAutoMail(mail) {
  return AUTO_SENDER.test(`${mail.from || ''} ${mail.fromAddr || ''}`) || AUTO_SUBJECT.test(mail.subject || '');
}

/**
 * 메일 하나 → 일정 후보 목록
 * @param {{id,subject,from,received,body,meeting?}} mail
 * @param {string} today YYYY-MM-DD
 */
export function mailCandidates(mail, today, now = null) {
  if (!mail.meeting?.start && isAutoMail(mail)) return [];
  const nowStr = now || `${today}T00:00`; // YYYY-MM-DDTHH:mm
  const recv = String(mail.received || '').slice(0, 16);
  const base = String(mail.received || '').slice(0, 10) || today;
  const subject = cleanSubject(mail.subject);
  const cands = [];
  const key = (c) => `${mail.id}|${c.date}|${c.startTime || ''}`;

  // Outlook 모임 요청은 정확한 시간이 있다
  if (mail.meeting?.start) {
    const s = mail.meeting.start;
    const e = mail.meeting.end || s;
    const allDay = !!mail.meeting.allDay;
    const c = {
      date: s.slice(0, 10),
      endDate: allDay ? addDays(e.slice(0, 10), -1) : e.slice(0, 10),
      allDay,
      startTime: allDay ? null : s.slice(11, 16),
      endTime: allDay ? null : e.slice(11, 16),
      place: mail.meeting.location || '',
      snippet: '모임 요청',
      meeting: true,
    };
    if (c.endDate < c.date) c.endDate = c.date;
    if (c.endDate >= today && (allDay || e.slice(0, 16) > nowStr)) cands.push({ ...c, key: key(c) }); // 끝난 모임은 제외
    return cands.map((x) => ({ ...x, title: subject, mailId: mail.id }));
  }

  const body = stripQuoted(mail.body);
  const text = `${subject}\n${body}`;
  const place = findPlace(body);
  for (const d of findDates(text, base)) {
    const last = d.endDate || d.date;
    if (last < today) continue; // 지난 날짜는 제외
    // 날짜가 들어 있는 줄
    const ls = text.lastIndexOf('\n', d.idx) + 1;
    let le = text.indexOf('\n', d.idx + d.len);
    if (le < 0) le = text.length;
    const line = text.slice(ls, le);
    if (META_LINE.test(line)) continue; // "날짜: …" 같은 발송 정보
    const after = text.slice(d.idx + d.len, Math.min(le, d.idx + d.len + 40));
    const before = text.slice(Math.max(ls, d.idx - 14), d.idx);
    const t = findTime(after) || (/(오전|오후|\d\s*시|:\d\d)/.test(before) ? findTime(before) : null);
    if (t && !d.endDate) {
      const at = `${d.date}T${t.start}`;
      if (at < nowStr) continue; // 이미 지난 시각
      if (recv && at <= recv) continue; // 메일 받기 전 시각 = 지난 일을 적은 것
    }
    // 시간도 없고 일정 관련 단어도 없으면 단순 언급으로 보고 건너뜀
    if (!t && !KEY.test(line) && !KEY.test(subject)) continue;
    const c = {
      date: d.date,
      endDate: d.endDate || d.date,
      allDay: !t,
      startTime: t?.start || null,
      endTime: t ? t.end || null : null,
      place,
      snippet: line.trim().replace(/\s{2,}/g, ' ').slice(0, 120),
    };
    const k = key(c);
    if (cands.some((x) => x.key === k)) continue;
    cands.push({ ...c, key: k });
    if (cands.length >= 5) break;
  }
  // 같은 날 시간 있는 후보가 있으면 종일 후보는 뺀다
  const timed = new Set(cands.filter((c) => !c.allDay).map((c) => c.date));
  return cands.filter((c) => !c.allDay || !timed.has(c.date)).map((x) => ({ ...x, title: subject, mailId: mail.id }));
}

export const _test = { findDates, findTime, findPlace };
