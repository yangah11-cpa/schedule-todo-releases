// 팀 일정표(엑셀) 해석
// 구조: 블록마다 [월 표시 행] [날짜 행] [요일 행] [사람별 행...]. 사람 행에서 회사명이 있는 칸이 시작일,
// 다음에 값이 있는 칸(다른 회사명 또는 공백 " ") 직전까지가 기간. "*"는 인차지 표시.
import { make, daysInMonth, dow, addDays } from './dates.js';

const isHeaderLabel = (v) => typeof v === 'string' && /CPA|월일/.test(v);
const DOW = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const str = (v) => (v === null || v === undefined ? null : String(v));

export function parseTeamSheet(sheet) {
  const rows = sheet.rows || [];
  let title = '';
  let asOf = null;
  let yearHint = null;
  for (const r of rows.slice(0, 6)) {
    for (const v of r || []) {
      const s = str(v);
      if (!s) continue;
      if (!title && /일정표/.test(s)) title = s.trim();
      const a = s.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*현재/);
      if (a) asOf = make(+a[1], +a[2], +a[3]);
      const y = s.match(/(\d{4})\s*(?:회계연도|년)/);
      if (y && !yearHint) yearHint = +y[1];
    }
  }
  const workType = (title.match(/회계연도\s*(.+?)\s*일정표/) || title.match(/^(.+?)\s*일정표/) || [])[1] || '';

  // 블록 찾기
  const heads = [];
  rows.forEach((r, i) => {
    if (r && isHeaderLabel(r[0])) heads.push(i);
  });
  const people = new Map(); // name → entries
  const order = [];
  let rangeFrom = null;
  let rangeTo = null;
  const open = new Map(); // 블록을 넘어 이어지는 일정

  heads.forEach((h, bi) => {
    const labelRow = rows[h] || [];
    const dayRow = rows[h + 1] || [];
    const dowRow = rows[h + 2] || [];
    const end = bi + 1 < heads.length ? heads[bi + 1] : rows.length;
    // 열별 날짜
    const labels = [];
    for (let c = 1; c < Math.max(labelRow.length, dayRow.length); c++) {
      const m = str(labelRow[c])?.match(/(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월/);
      if (m) labels.push({ c, y: m[1] ? +m[1] : null, m: +m[2] });
    }
    if (!labels.length) return;
    // 연도 없는 첫 표시는 다음 표시의 연도로 추정
    for (let i = 0; i < labels.length; i++) {
      if (labels[i].y) continue;
      const next = labels.slice(i + 1).find((x) => x.y);
      const prev = labels.slice(0, i).reverse().find((x) => x.y);
      if (prev) labels[i].y = prev.y + (labels[i].m < prev.m ? 1 : 0);
      else if (next) labels[i].y = next.y - (labels[i].m > next.m ? 1 : 0);
      else labels[i].y = yearHint || new Date().getFullYear();
    }
    const dates = [];
    let y = labels[0].y;
    let m = labels[0].m;
    let prevDay = null;
    for (let c = 1; c < dayRow.length; c++) {
      const d = typeof dayRow[c] === 'number' ? dayRow[c] : parseInt(str(dayRow[c]) || '', 10);
      if (!Number.isFinite(d) || d < 1 || d > 31) {
        dates[c] = null;
        continue;
      }
      const lab = labels.find((x) => x.c === c);
      if (lab) {
        y = lab.y;
        m = lab.m;
      } else if (prevDay !== null && d < prevDay) {
        m += 1;
        if (m > 12) {
          m = 1;
          y += 1;
        }
      }
      prevDay = d;
      let dt = d <= daysInMonth(y, m) ? make(y, m, d) : null;
      // 요일 행과 날짜가 어긋나면(날짜 오타) 요일을 기준으로 가장 가까운 날짜로 맞춤
      const want = DOW[str(dowRow[c])?.trim()];
      if (dt && want !== undefined && dow(dt) !== want) {
        for (const k of [-1, 1, -2, 2, -3, 3]) {
          if (dow(addDays(dt, k)) === want) {
            dt = addDays(dt, k);
            break;
          }
        }
      }
      dates[c] = dt;
    }
    const cols = dates.map((d, c) => (d ? c : null)).filter((c) => c !== null);
    if (!cols.length) return;
    const bFrom = dates[cols[0]];
    const bTo = dates[cols[cols.length - 1]];
    if (!rangeFrom || bFrom < rangeFrom) rangeFrom = bFrom;
    if (!rangeTo || bTo > rangeTo) rangeTo = bTo;

    for (let r = h + 3; r < end; r++) {
      const row = rows[r] || [];
      const name = str(row[0])?.trim();
      if (!name || isHeaderLabel(name)) continue;
      if (!people.has(name)) {
        people.set(name, []);
        order.push(name);
      }
      const list = people.get(name);
      let cur = open.get(name) || null; // 이전 블록에서 이어지는 일정
      const close = () => {
        if (cur) {
          // 끝의 주말은 제외
          while (cur.end > cur.start && (dow(cur.end) === 0 || dow(cur.end) === 6)) cur.end = addDays(cur.end, -1);
          list.push(cur);
        }
        cur = null;
      };
      for (const c of cols) {
        const v = row[c];
        if (v === undefined || v === null) {
          if (cur) cur.end = dates[c];
          continue;
        }
        const s = String(v).trim();
        close();
        if (!s) continue;
        cur = { raw: s, text: s.replace(/\*/g, '').trim(), lead: s.includes('*'), start: dates[c], end: dates[c] };
      }
      // 블록 끝까지 이어진 일정은 다음 블록 첫 칸이 비어 있으면 계속
      open.set(name, cur);
      if (cur && bi === heads.length - 1) close();
    }
    // 다음 블록에서 첫 칸에 값이 있으면 위 루프의 close()에서 닫힘. 마지막 처리:
    if (bi === heads.length - 1) {
      for (const [name, c] of open) {
        if (c && !people.get(name).includes(c)) people.get(name).push(c);
      }
    }
  });
  const result = order.map((name) => ({ name, entries: (people.get(name) || []).filter((e) => e.text) }));
  return { title, workType, asOf, from: rangeFrom, to: rangeTo, sheet: sheet.name, people: result };
}

export function parseTeamWorkbook(sheets) {
  const parsed = sheets
    .filter((s) => !s.hidden)
    .map(parseTeamSheet)
    .filter((p) => p.people.length && p.from);
  if (!parsed.length) throw new Error('팀 일정표 형식을 찾지 못했습니다. (A열에 "월일 CPA" 머리글, 날짜 행, 이름 행이 있는 시트)');
  return parsed;
}

/* ───── 같은 회사 일정 찾기 ───── */
const norm = (s) => String(s || '').replace(/\*/g, '').replace(/\s+/g, '').toLowerCase();
const tokens = (s) => norm(s).split(/[/,·&]+/).filter((t) => t.length >= 2);
export function sameClient(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) return true;
  const ta = tokens(a);
  const tb = tokens(b);
  return ta.some((p) => tb.some((q) => p.startsWith(q) || q.startsWith(p)));
}
const overlap = (a, b) => a.start <= b.end && b.start <= a.end;

// 회사 일정이 아닌 항목(제목에 업무명을 붙이지 않음)
const NON_CLIENT = /^(연수|교육|휴가|연차|반차|워크숍|워크샵|세미나|출장|회의|휴무|공휴일|대기|사무실|내근)$/;

/** 내 일정 목록(참여 인원·인차지 포함) */
export function myEngagements(parsed, me) {
  const out = [];
  for (const p of parsed) {
    const mine = p.people.find((x) => x.name === me);
    if (!mine) continue;
    for (const e of mine.entries) {
      const mates = [];
      let leader = e.lead ? me : null;
      for (const o of p.people) {
        if (o.name === me) continue;
        for (const oe of o.entries) {
          if (overlap(e, oe) && (sameClient(e.text, oe.text) || sameClient(e.orig || e.text, oe.orig || oe.text))) {
            if (!mates.includes(o.name)) mates.push(o.name);
            if (oe.lead && !leader) leader = o.name;
          }
        }
      }
      const isClient = !NON_CLIENT.test(e.orig || e.text);
      out.push({
        key: `${norm(e.orig || e.text)}|${e.start}`, // 이름을 고쳐도 같은 일정으로 인식
        client: e.text,
        title: e.work ? `${e.text} ${e.work}` : isClient && p.workType ? `${e.text} ${p.workType}` : e.text,
        start: e.start,
        end: e.end,
        people: mates,
        leader,
        lead: e.lead,
        workType: e.work || p.workType,
        asOf: p.asOf,
      });
    }
  }
  return out;
}

/** 날짜별 팀원 일정 */
export function teamOn(team, date) {
  const res = [];
  for (const p of team || []) {
    if (date < p.from || date > p.to) continue;
    for (const person of p.people) {
      const hits = person.entries.filter((e) => e.start <= date && e.end >= date);
      if (!res.some((r) => r.name === person.name)) res.push({ name: person.name, items: [] });
      res.find((r) => r.name === person.name).items.push(...hits);
    }
  }
  return res;
}
export { norm as normClient };
