// 감사시간(AuditHour) 계산
// 회사 시스템에서 받은 표 3가지(투입시간 / 담당이사 / 계약목록)를 머리글 이름으로 알아보고,
// 내가 고른 프로젝트 코드에 대해서만 엑셀 'AuditHour' 시트의 11~34행과 같은 계산을 한다.

const key = (v) => String(v ?? '').replace(/\s+/g, '');
const code = (v) => String(v ?? '').trim();
/** 숫자로 (".", 빈칸, 글자는 0) */
export const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
};

/** 머리글 행 찾기: 앞 15행 안에서 원하는 머리글이 모두 있는 행 */
function findHeader(rows, must) {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const ks = (rows[r] || []).map(key);
    if (must.every((m) => ks.includes(m))) return { r, ks };
  }
  return null;
}
const col = (ks, ...names) => {
  for (const n of names) {
    const i = ks.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
};

/** 시트 하나가 어떤 자료인지 알아보고 필요한 값만 뽑음 */
export function detectSheet(sheet) {
  const rows = sheet.rows || [];
  // 담당이사 투입 내역: 이름, 계약번호, 감사절차, 합계
  let h = findHeader(rows, ['이름', '계약번호', '감사절차']);
  if (h) {
    const ci = { name: col(h.ks, '이름'), code: col(h.ks, '계약번호'), proc: col(h.ks, '감사절차'), hrs: col(h.ks, '합계', '결재시간') };
    const sums = {}; // 계약번호 → 이름 → 감사절차 → 시간
    let n = 0;
    for (const row of rows.slice(h.r + 1)) {
      const c = code(row?.[ci.code]);
      if (!c) continue;
      const nm = String(row[ci.name] ?? '').trim();
      const pr = String(row[ci.proc] ?? '').trim();
      ((sums[c] ||= {})[nm] ||= {})[pr] = ((sums[c][nm] || {})[pr] || 0) + num(row[ci.hrs]);
      n++;
    }
    return { kind: 'partner', count: n, data: sums };
  }
  // 계약목록: 계약번호, 회사명, 계약종류, 감사보수, 담당이사
  h = findHeader(rows, ['계약번호', '회사명', '감사보수', '담당이사']);
  if (h) {
    const ci = { code: col(h.ks, '계약번호'), co: col(h.ks, '회사명'), kind: col(h.ks, '계약종류'), fee: col(h.ks, '감사보수'), partner: col(h.ks, '담당이사') };
    const map = {};
    for (const row of rows.slice(h.r + 1)) {
      const c = code(row?.[ci.code]);
      if (!c || map[c]) continue;
      map[c] = { co: String(row[ci.co] ?? '').trim(), kind: ci.kind >= 0 ? String(row[ci.kind] ?? '').trim() : '', fee: num(row[ci.fee]), partner: String(row[ci.partner] ?? '').trim() };
    }
    return { kind: 'contracts', count: Object.keys(map).length, data: map };
  }
  // 투입시간: 계약번호, 투입시간 (+ 회사명, 최소표준감사시간)
  h = findHeader(rows, ['계약번호', '투입시간']);
  if (h) {
    const ci = { code: col(h.ks, '계약번호'), co: col(h.ks, '회사명'), std: col(h.ks, '최소표준감사시간', '표준감사시간'), hrs: col(h.ks, '투입시간') };
    const map = {};
    for (const row of rows.slice(h.r + 1)) {
      const c = code(row?.[ci.code]);
      if (!c || map[c]) continue;
      map[c] = { hrs: num(row[ci.hrs]), std: ci.std >= 0 ? num(row[ci.std]) : 0, co: ci.co >= 0 ? String(row[ci.co] ?? '').trim() : '' };
    }
    return { kind: 'hours', count: Object.keys(map).length, data: map };
  }
  // 예전에 쓰던 AuditHour 시트: 프로젝트 코드·표준감사시간·투입 계획을 한 번에 가져오기
  h = findHeader(rows, ['프로젝트코드', '표준감사시간']);
  if (h) {
    const ci = { code: col(h.ks, '프로젝트코드'), std: col(h.ks, '표준감사시간') };
    const list = [];
    let r = h.r + 1;
    for (; r < rows.length; r++) {
      const row = rows[r] || [];
      if (row.every((v) => v === null || v === undefined || v === '')) break;
      const c = code(row[ci.code]);
      if (c) list.push({ code: c, std: num(row[ci.std]) });
    }
    // 아래 투입 계획 표 (회사명, 투입일수, 투입인원, 투입시간) — 위 표와 같은 순서
    const p = rows.findIndex((row, i) => i > h.r && (row || []).map(key).includes('투입일수'));
    if (p > 0) {
      const ks = rows[p].map(key);
      const pi = { d: col(ks, '투입일수'), n: col(ks, '투입인원'), t: col(ks, '투입시간') };
      let j = 0;
      const all = [];
      for (let q = h.r + 1; q < rows.length && q < p; q++) {
        const row = rows[q] || [];
        if (row.every((v) => v === null || v === undefined || v === '')) break;
        all.push(code(row[ci.code]));
      }
      for (let q = p + 1; q < rows.length && j < all.length; q++, j++) {
        const row = rows[q] || [];
        const it = list.find((x) => x.code === all[j]);
        if (it) Object.assign(it, { days: num(row[pi.d]), people: num(row[pi.n]), hpd: num(row[pi.t]) || 13 });
      }
    }
    return { kind: 'projects', count: list.length, data: list };
  }
  return null;
}

export const DEFAULT_PROCS = ['감사업무(감사계획과 중간감사) 담당이사 검토', '감사업무(기말감사) 담당이사 검토', '분반기 담당이사 검토'];

/** 프로젝트 하나의 계산 (엑셀 AuditHour 11~34행과 같은 식) */
export function computeRow(p, A) {
  const ct = A.contracts?.[p.code] || null;
  const hr = A.hours?.[p.code] || null;
  const std = p.std ?? hr?.std ?? 0; // 표준감사시간: 직접 넣은 값 > 투입시간 자료의 최소표준감사시간
  const used = hr ? hr.hrs : 0; // 입력시간
  const need = Math.max(std - used, 0); // 필요시간
  const fee = ct?.fee || 0;
  const partner = ct?.partner || '';
  const procs = (A.procs?.length ? A.procs : DEFAULT_PROCS).map(key);
  let partnerHrs = 0;
  const byName = A.partner?.[p.code]?.[partner] || {};
  for (const [pr, v] of Object.entries(byName)) if (procs.includes(key(pr))) partnerHrs += v;
  const days = p.days ?? 0;
  const people = p.people ?? 0;
  const hpd = p.hpd ?? 13;
  const total = days * people * hpd; // 총 투입시간
  const inCharge = Math.max(need - total, 3); // 인차지 투입시간
  return {
    code: p.code,
    co: ct?.co || hr?.co || '',
    kind: ct?.kind || '',
    partner,
    std,
    stdFromData: p.std == null && !!hr?.std,
    used,
    need,
    fee,
    perHour: Math.max(std, used) ? fee / Math.max(std, used) : 0,
    ratio: std ? used / std : 0,
    partnerHrs,
    partnerRatio: used ? partnerHrs / used : 0,
    days,
    people,
    hpd,
    total,
    inCharge,
    inChargeDays: hpd ? inCharge / hpd : 0,
    perPerson: people ? total / people : 0,
    missing: [!ct && A.contracts ? '계약목록' : null, !hr && A.hours ? '투입시간' : null].filter(Boolean),
  };
}

/** 계약번호·회사명으로 찾기 (추가할 때 자동 완성) */
export function searchContracts(A, q, limit = 12) {
  const s = key(q).toLowerCase();
  if (!s) return [];
  const seen = new Set();
  const out = [];
  const add = (c, co) => {
    if (seen.has(c) || out.length >= limit) return;
    seen.add(c);
    out.push({ code: c, co });
  };
  for (const [c, v] of Object.entries(A.contracts || {})) if (key(c).toLowerCase().includes(s) || key(v.co).toLowerCase().includes(s)) add(c, v.co);
  for (const [c, v] of Object.entries(A.hours || {})) if (key(c).toLowerCase().includes(s) || key(v.co).toLowerCase().includes(s)) add(c, v.co);
  return out;
}

/** 엑셀·시스템 화면에서 복사한 글(탭으로 칸 구분) → 표. 칸 안 줄바꿈("최소표준\n감사시간")은 따옴표로 감싸져 옴 */
export function parseClipboardTable(text) {
  const t = String(text || '').replace(/\r\n?/g, '\n');
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  const cell = (s) => {
    const v = s.trim();
    if (v === '') return null;
    const n = v.replace(/,/g, '');
    return /^-?\d+(\.\d+)?$/.test(n) && !/^0\d/.test(n) ? Number(n) : v;
  };
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"' && cur === '') q = true;
    else if (ch === '\t') row.push(cell(cur)), (cur = '');
    else if (ch === '\n') row.push(cell(cur)), rows.push(row), (row = []), (cur = '');
    else cur += ch;
  }
  if (cur || row.length) row.push(cell(cur)), rows.push(row);
  return { name: '붙여넣기', rows };
}
