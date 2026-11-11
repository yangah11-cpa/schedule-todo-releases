// AI 요약 (Claude API) — 사용자가 켰을 때만. 키는 Windows 암호화(safeStorage)로 PC에만 저장.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODEL = 'claude-haiku-5-5';
const API = () => process.env.ST_AI_BASE || 'https://api.anthropic.com';
let userData = '';
const init = (d) => (userData = d);
const keyFile = () => path.join(userData, 'ai-key.bin');
const cacheFile = () => path.join(userData, 'ai-cache.json');
const usageFile = () => path.join(userData, 'ai-usage.json');

function safe() {
  try {
    const { safeStorage } = require('electron');
    return safeStorage?.isEncryptionAvailable() ? safeStorage : null;
  } catch {
    return null;
  }
}
function setKey(key) {
  key = String(key || '').trim();
  if (!key) {
    fs.rmSync(keyFile(), { force: true });
    return { ok: true, has: false };
  }
  if (!/^sk-ant-/.test(key)) return { ok: false, error: 'sk-ant- 로 시작하는 Claude API 키가 아닙니다.' };
  const s = safe();
  if (!s) return { ok: false, error: '이 PC에서 암호화 저장을 쓸 수 없습니다.' };
  fs.writeFileSync(keyFile(), s.encryptString(key));
  return { ok: true, has: true };
}
function getKey() {
  if (process.env.ST_AI_KEY) return process.env.ST_AI_KEY;
  try {
    return safe()?.decryptString(fs.readFileSync(keyFile())) || null;
  } catch {
    return null;
  }
}
const readJson = (p, d) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return d;
  }
};
const month = () => new Date().toISOString().slice(0, 7);
function status() {
  const u = readJson(usageFile(), {});
  const m = u[month()] || { n: 0, in: 0, out: 0 };
  // Haiku 5.5: 입력 $0.10 / 출력 $0.50 (100만 토큰당)
  return { has: !!getKey(), model: MODEL, month: m, cost: (m.in * 0.1 + m.out * 0.5) / 1e6 };
}

const SYSTEM = `너는 한국의 회계·세무 실무자(회계사)가 받은 메일·문자·통화 녹음 글을 요약하는 도우미다.
반드시 아래 JSON 하나만 출력한다. 다른 말은 쓰지 않는다.
{"title":"30자 이내 제목","gist":"무엇에 대한 내용인지 1~2문장","requests":["상대가 나에게 요청한 일(없으면 빈 배열)"],"dues":[{"date":"YYYY-MM-DD","start":"HH:MM 또는 null","end":"HH:MM 또는 null","place":"장소 또는 null","text":"근거가 된 짧은 문장"}],"company":"관련 회사 이름 또는 null"}
- 날짜는 기준 시각을 기준으로 "내일", "다음 주 화요일" 등을 실제 날짜로 바꾼다.
- 이미 지난 날짜, 인사말·서명·광고 문구는 넣지 않는다.
- 통화 녹음 글은 음성 인식 결과라 틀린 글자가 있을 수 있으니 문맥으로 바로잡아 이해한다.`;

/** 개인정보 가리기: 주민번호·카드·전화·계좌·이메일·긴 숫자 */
function mask(t) {
  return String(t || '')
    .replace(/\b\d{6}\s?-\s?[1-8]\d{6}\b/g, '[주민번호]')
    .replace(/\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{3,4}\b/g, '[카드번호]')
    .replace(/(?:\+82[- ]?|\b0)(?:1[016789]|2|[3-6][1-5]|70|50\d)[- .)]?\d{3,4}[- .]?\d{4}\b/g, '[전화번호]')
    .replace(/\b(?:1[5-8]\d{2})-\d{4}\b/g, '[전화번호]')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[이메일]')
    .replace(/\b\d{2,6}-\d{2,6}-\d{2,8}(?:-\d{1,4})?\b/g, (m) => (m.replace(/\D/g, '').length >= 10 ? '[계좌·번호]' : m))
    .replace(/\b\d{10,16}\b/g, '[번호]');
}

let cache = null;
function getCache() {
  if (!cache) cache = readJson(cacheFile(), {});
  return cache;
}
function saveCache() {
  const ks = Object.keys(cache);
  if (ks.length > 3000) for (const k of ks.slice(0, ks.length - 3000)) delete cache[k];
  fs.writeFileSync(cacheFile(), JSON.stringify(cache));
}
const netFetch = (url, opt) => {
  try {
    const { net } = require('electron');
    if (net?.fetch) return net.fetch(url, opt);
  } catch {
    /* Electron 밖 */
  }
  return fetch(url, opt);
};

/**
 * 요약 하나. 같은 내용이면 저장해 둔 결과를 씀(비용 0).
 * @param {{id:string, kind:'mail'|'sms'|'call', from:string, subject?:string, at:string, body:string, cachedOnly?:boolean}} o
 */
async function summarize(o) {
  const body = (o.mask ? mask : String)(String(o.body || '').slice(0, 12000));
  const hash = crypto.createHash('sha1').update(`${o.mask ? 'm' : ''}|${o.kind}|${o.at}|${o.subject || ''}|${body}`).digest('hex').slice(0, 16);
  const c = getCache();
  if (c[o.id]?.h === hash) return { ok: true, cached: true, sum: c[o.id].s };
  if (o.cachedOnly) return { ok: true, sum: null };
  const key = getKey();
  if (!key) return { ok: false, code: 'noKey', error: 'API 키가 없습니다.' };
  const kind = { mail: '메일', sms: '문자', call: '통화 녹음 글' }[o.kind] || '메일';
  const from = o.mask ? (/[\d@]/.test(o.from || '') ? '상대' : String(o.from || '').replace(/<[^>]*>/g, '').trim()) : o.from || '';
  const subject = o.mask ? mask(o.subject) : o.subject;
  const user = `종류: ${kind}\n기준 시각: ${o.at}\n${o.kind === 'call' ? '통화 상대' : '보낸 사람'}: ${from}\n${subject ? `제목: ${subject}\n` : ''}\n내용:\n${body}`;
  const res = await netFetch(`${API()}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 800, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = j?.error?.message || `HTTP ${res.status}`;
    const code = res.status === 401 ? 'auth' : /credit|balance|billing/i.test(msg) ? 'credit' : res.status === 429 ? 'rate' : 'error';
    const ko = { auth: 'API 키가 잘못되었거나 만료되었습니다.', credit: '크레딧이 부족합니다. Console → Billing에서 충전하세요.', rate: '요청이 많아 잠시 뒤 다시 시도합니다.' }[code];
    return { ok: false, code, error: ko || msg };
  }
  const text = (j.content || []).map((b) => b.text || '').join('');
  let sum = null;
  try {
    sum = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    return { ok: false, code: 'parse', error: 'AI 응답을 읽지 못했습니다.' };
  }
  // 사용량
  const u = readJson(usageFile(), {});
  const m = (u[month()] ||= { n: 0, in: 0, out: 0 });
  m.n++;
  m.in += j.usage?.input_tokens || 0;
  m.out += j.usage?.output_tokens || 0;
  fs.writeFileSync(usageFile(), JSON.stringify(u));
  c[o.id] = { h: hash, s: sum, t: Date.now() };
  saveCache();
  return { ok: true, sum };
}

module.exports = { init, setKey, status, summarize, mask, MODEL };
