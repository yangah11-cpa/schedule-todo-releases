// Gmail 읽기 (읽기 전용). 메일 본문·첨부 글자는 휴대폰 안에서만 처리한다.
import { extractText, SUPPORTED } from './attext.js';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

const b64u = (s) => {
  const bin = atob(String(s || '').replace(/-/g, '+').replace(/_/g, '/'));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};
const dec = (u8, charset = 'utf-8') => {
  try {
    return new TextDecoder(charset).decode(u8);
  } catch {
    return new TextDecoder('utf-8').decode(u8);
  }
};
const htmlToText = (html) =>
  String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

const header = (msg, name) => (msg.payload?.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase())?.value || '';
const charsetOf = (p) => (header({ payload: p }, 'Content-Type').match(/charset="?([^";]+)/i) || [])[1] || 'utf-8';

/** Gmail 메시지(full) → { id, subject, from, received, body, atts } */
export function parseMessage(msg) {
  let plain = '';
  let html = '';
  const atts = [];
  const walk = (p) => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) atts.push({ name: p.filename, attachmentId: p.body.attachmentId, size: p.body.size || 0, mimeType: p.mimeType });
    else if (p.mimeType === 'text/plain' && p.body?.data && !plain) plain = dec(b64u(p.body.data), charsetOf(p));
    else if (p.mimeType === 'text/html' && p.body?.data && !html) html = dec(b64u(p.body.data), charsetOf(p));
    (p.parts || []).forEach(walk);
  };
  walk(msg.payload);
  const fromH = header(msg, 'From');
  const d = new Date(+msg.internalDate || Date.parse(header(msg, 'Date')) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return {
    id: msg.id,
    subject: header(msg, 'Subject'),
    from: (fromH.match(/^\s*"?([^"<]+?)"?\s*</) || [, fromH])[1].trim(),
    fromAddr: (fromH.match(/<([^>]+)>/) || [, fromH])[1],
    received: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`,
    unread: (msg.labelIds || []).includes('UNREAD'),
    body: (plain || htmlToText(html)).slice(0, 8000),
    atts,
    snippet: msg.snippet || '',
  };
}

/**
 * @param {(path:string)=>Promise<any>} get  Gmail API GET (토큰 포함)
 */
export function gmailClient(get) {
  const attCache = new Map();
  return {
    /** 메일 목록 (id만) */
    async list(q, max = 30) {
      const r = await get(`/messages?maxResults=${max}&q=${encodeURIComponent(q)}`);
      return (r.messages || []).map((m) => m.id);
    },
    /** 제목·보낸 사람만 빠르게 (목록 표시용) */
    async head(id) {
      const m = await get(`/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
      const x = parseMessage(m);
      x.hasAtt = (m.payload?.parts || []).some((p) => p.filename);
      return x;
    },
    /** 본문 + 첨부 글자까지 */
    async full(id, withAtts = true) {
      const m = parseMessage(await get(`/messages/${id}?format=full`));
      if (!withAtts) return m;
      if (attCache.has(id)) m.attText = attCache.get(id);
      else {
        const texts = [];
        for (const a of m.atts.filter((x) => SUPPORTED.test(x.name) && x.size < 15e6).slice(0, 5)) {
          try {
            const r = await get(`/messages/${id}/attachments/${a.attachmentId}`);
            const t = await extractText(a.name, b64u(r.data));
            if (t) texts.push({ name: a.name, text: t });
          } catch {
            /* 읽을 수 없는 첨부는 건너뜀 */
          }
        }
        attCache.set(id, texts);
        m.attText = texts;
      }
      m.atts = m.atts.map((a) => a.name);
      return m;
    },
  };
}
