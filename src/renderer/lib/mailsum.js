// 메일 요약 (AI 없이 PC 안에서): 인사·서명을 빼고 핵심 문장을 골라 분류한다.
import { mailCandidates, stripQuoted, cleanSubject, isAutoMail } from './mailparse.js';

// 요청·부탁 문장
const REQ =
  /요청|부탁|회신|답변|검토|확인\s*(?:해|하여|후|바랍|부탁|요망|주)|송부\s*(?:해|바랍|부탁|요망)|보내\s*(?:주|드려\s*주)|제출|작성|준비\s*(?:해|부탁|바랍)|주시기|주십시오|주세요|주시면|바랍니다|해\s*주셨으면|가능하실까요|가능할까요|가능하신지|please|kindly|could you|would you/i;
// 기한 표현
const DUE = /까지|기한|마감|내로|이내|due|deadline|until/i;
// 인사·자기소개·맺음말·서명
const GREET = /^(?:안녕하(?:세요|십니까)|수고\s*(?:많으십니다|하십니다|많으세요)|좋은\s*(?:아침|하루)|늘\s*감사|항상\s*감사|dear\b|hi\b|hello\b)/i;
const SELF = /^.{0,40}(?:회계법인|법인|팀|주식회사|㈜|본부|사무소|과장|대리|차장|부장|팀장|이사|매니저|회계사|세무사)\s*.{0,15}입니다[.!]?$/;
const CLOSE = /^(?:감사합니다|감사드립니다|고맙습니다|수고하세요|좋은\s*하루|이상입니다|thanks|thank you|best regards|regards|sincerely|드림|올림)/i;
const SIG = /^(?:tel|t\.|mobile|m\.|phone|fax|f\.|e-?mail|주소|address|www\.|https?:\/\/|\d{2,4}-\d{3,4}-\d{4}|[-_=]{3,})/i;

/** 본문 → 의미 있는 문장들 (인사·서명 제외) */
export function sentences(body) {
  const text = stripQuoted(body || '');
  const out = [];
  for (let line of text.split('\n')) {
    line = line.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (CLOSE.test(line)) break; // 맺음말 이후는 서명
    if (SIG.test(line)) continue;
    // 한 줄에 여러 문장이면 나눔
    for (let s of line.split(/(?<=[.!?。]|다\.|요\.|니다)\s+(?=\S)/)) {
      s = s.trim();
      if (s.length < 4) continue;
      if (GREET.test(s) || SELF.test(s)) continue;
      if (/^.{1,25}(?:님|귀하|께|님께|teams?)\s*[,.:]?$/i.test(s)) continue; // "양하승 회계사님," 같은 받는 사람 호칭
      if (s.length < 25 && /수고\s*(?:많으|하십|하세)|감사합니다|고맙습니다|잘\s*부탁/.test(s)) continue;
      out.push(s.length > 160 ? `${s.slice(0, 160)}…` : s);
    }
    if (out.length > 60) break;
  }
  return out;
}

/**
 * 메일 하나 요약
 * @returns {{cat:'request'|'due'|'info'|'auto', gist:string, requests:string[], dues:object[], atts:string[]}}
 */
export function summarize(mail, today, now) {
  const auto = isAutoMail(mail);
  const ss = sentences(mail.body);
  const FYI = /^(?:.{0,10})?(?:참고\s*(?:하시기\s*)?바랍니다|참고하세요|참고\s*부탁|양해\s*부탁|양지\s*바랍니다)[.!]?$/;
  const requests = ss.filter((s) => REQ.test(s) && !FYI.test(s)).slice(0, 4);
  const cands = auto ? [] : mailCandidates({ ...mail, meeting: mail.meeting }, today, now);
  // 기한·일정: 일정 후보 + "~까지" 문장
  const dues = cands.map((c) => ({ ...c, text: c.snippet === '모임 요청' ? '모임 요청' : c.snippet }));
  for (const s of ss) {
    if (DUE.test(s) && !dues.some((d) => d.text && s.includes(d.text.slice(0, 20))) && dues.length < 4 && /\d/.test(s)) dues.push({ text: s });
  }
  // 요지: 인사·소개를 뺀 첫 문장 (무엇에 대한 메일인지)
  const gist = (ss.find((x) => !FYI.test(x)) || mail.snippet || '').slice(0, 120);
  const atts = [].concat(mail.atts || []).filter((n) => n && !/^image\d+\.(png|jpe?g|gif)$/i.test(n));
  const cat = auto ? 'auto' : dues.some((d) => d.date) || dues.length ? 'due' : requests.length ? 'request' : 'info';
  return { cat, gist, requests, dues, atts, sentences: ss, title: cleanSubject(mail.subject) || '(제목 없음)' };
}

export const CAT_LABEL = { request: '요청', due: '기한·일정', info: '참고', auto: '알림' };

// 개인 메일 서비스 주소는 회사로 보지 않음
const PUBLIC = /^(gmail|naver|daum|hanmail|kakao|nate|hotmail|outlook|live|yahoo|icloud|me|msn)\./i;
export const domainOf = (addr) => (String(addr || '').toLowerCase().match(/@([a-z0-9.-]+)/) || [])[1] || '';
/**
 * 메일의 회사: ① 제목·첨부 이름의 고객사 ② 보낸 사람 이름의 (회사) ③ 본문의 고객사 ④ 주소 → 이름 ⑤ 주소
 * @param {string[]} clients 고객사 이름 (일정·팀 일정표)
 * @param {Record<string,string>} domains 주소 → 회사 이름 (사용자가 붙인 것)
 */
export function companyOf(mail, clients, domains = {}) {
  const list = [...new Set(clients.filter((c) => c && c.length >= 2))].sort((a, b) => b.length - a.length);
  const head = `${mail.subject || ''} ${[].concat(mail.atts || []).join(' ')}`;
  for (const c of list) if (head.includes(c)) return { name: c, by: 'client' };
  const paren = String(mail.from || '').match(/[(\[]\s*([^)\]]{2,20})\s*[)\]]/);
  if (paren) return { name: paren[1].trim(), by: 'from' };
  const body = String(mail.body || '').slice(0, 3000);
  for (const c of list) if (body.includes(c)) return { name: c, by: 'client' };
  const dom = domainOf(mail.fromAddr);
  if (dom && domains[dom]) return { name: domains[dom], by: 'domain', domain: dom };
  if (mail.internal) return { name: '사내', by: 'internal' };
  if (dom && !PUBLIC.test(dom)) return { name: dom, by: 'domain-raw', domain: dom };
  return { name: '', by: 'none', domain: dom };
}
