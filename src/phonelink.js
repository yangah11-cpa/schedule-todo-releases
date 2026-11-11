// Windows "휴대폰과 연결(Phone Link)" 앱에 동기화된 문자 읽기 (읽기 전용, PC 안에서만)
// 원본 DB는 앱이 쓰고 있으므로 임시 폴더에 복사해서 연다.
const fs = require('fs');
const os = require('os');
const path = require('path');

function dbDir() {
  if (process.env.ST_PHONELINK_DIR) return process.env.ST_PHONELINK_DIR;
  const base = path.join(process.env.LOCALAPPDATA || '', 'Packages', 'Microsoft.YourPhone_8wekyb3d8bbwe', 'LocalCache', 'Indexed');
  let best = null;
  try {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'System', 'Database', 'phone.db');
      try {
        const st = fs.statSync(path.join(base, d, 'System', 'Database', 'phone.db-wal'));
        const t = Math.max(st.mtimeMs, fs.statSync(p).mtimeMs);
        if (!best || t > best.t) best = { dir: path.dirname(p), t };
      } catch {
        if (fs.existsSync(p) && !best) best = { dir: path.dirname(p), t: 0 };
      }
    }
  } catch {
    return null;
  }
  return best?.dir || null;
}

function copyDb(src, name, tmp) {
  for (const ext of ['', '-wal', '-shm']) {
    const f = path.join(src, name + ext);
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(tmp, name + ext));
  }
  return path.join(tmp, name);
}

// 장문 문자 제목이 UTF-8 바이트를 Latin-1/CP1252로 잘못 읽은 상태(예: "ê³µì§€")로 저장된 경우 되돌리기
const CP1252 = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
function fixMojibake(str) {
  const t = String(str || '');
  if (!/[\u00c0-\u00ff][\u0080-\u00bf\u0152-\u2122]/.test(t)) return t; // 깨진 흔적이 없으면 그대로
  const bytes = [];
  for (const ch of t) {
    const c = ch.codePointAt(0);
    if (c < 0x100) bytes.push(c);
    else if (CP1252[c] !== undefined) bytes.push(CP1252[c]);
    else return t; // 바이트로 되돌릴 수 없는 글자가 섞여 있으면 원래대로
  }
  const out = Buffer.from(bytes).toString('utf8');
  return /[\uac00-\ud7a3]/.test(out) && !out.includes('\ufffd') ? out : t;
}

const digits = (s) => String(s || '').replace(/\D/g, '').replace(/^82/, '0');
const key = (s) => digits(s).slice(-8);

/**
 * 최근 받은 문자 (SMS + 장문/MMS)
 * @returns {{ok:boolean, code?:string, messages?:object[]}}
 */
function readMessages({ days = 3 } = {}) {
  const src = dbDir();
  if (!src || !fs.existsSync(path.join(src, 'phone.db'))) return { ok: false, code: 'noPhoneLink' };
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return { ok: false, code: 'noSqlite' };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-phone-'));
  try {
    const phone = new DatabaseSync(copyDb(src, 'phone.db', tmp));
    const sinceMs = Date.now() - Math.max(1, days) * 864e5;
    // 타임스탬프는 Windows FILETIME(1601년부터 100ns) → 밀리초로 바꿔서 비교
    const MS = '(timestamp / 10000 - 11644473600000)';
    const sms = phone
      .prepare(`SELECT message_id id, from_address addr, body, ${MS} ms FROM message WHERE type = 1 AND ${MS} >= ? ORDER BY timestamp DESC LIMIT 300`)
      .all(sinceMs);
    const mms = phone
      .prepare(
        `SELECT m.message_id id, m.from_address addr, m.subject subject, (m.timestamp / 10000 - 11644473600000) ms,
                (SELECT group_concat(p.text, char(10)) FROM mms_part p WHERE p.message_id = m.message_id AND p.content_type = 'text/plain') body
           FROM mms m WHERE m.type = 1 AND (m.timestamp / 10000 - 11644473600000) >= ? ORDER BY m.timestamp DESC LIMIT 300`
      )
      .all(sinceMs);
    phone.close();
    // 연락처: 번호 → 이름·회사
    const people = new Map();
    try {
      if (fs.existsSync(path.join(src, 'contacts.db'))) {
        const cdb = new DatabaseSync(copyDb(src, 'contacts.db', tmp));
        for (const r of cdb
          .prepare('SELECT p.phone_number num, c.display_name name, c.company company FROM phonenumber p JOIN contact c ON c.contact_id = p.contact_id')
          .all())
          if (key(r.num).length >= 7) people.set(key(r.num), { name: r.name || '', company: r.company || '' });
        cdb.close();
      }
    } catch {
      /* 연락처가 없어도 문자는 보여 줌 */
    }
    const pad = (n) => String(n).padStart(2, '0');
    const iso = (ms) => {
      const d = new Date(Number(ms));
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    const out = [];
    for (const [kind, rows] of [
      ['sms', sms],
      ['mms', mms],
    ]) {
      for (const r of rows) {
        const body = fixMojibake(r.body).replace(/^\s*\[Web발신\]\s*/i, '').trim();
        if (!body) continue;
        const who = people.get(key(r.addr)) || null;
        out.push({
          id: `${kind}:${r.id}`,
          source: 'sms',
          web: /\[Web발신\]/i.test(String(r.body || '')),
          from: who?.name || r.addr || '',
          fromAddr: r.addr || '',
          contact: !!who,
          company: who?.company || '',
          subject: fixMojibake(r.subject).trim(),
          received: iso(r.ms),
          body: body.slice(0, 6000),
        });
      }
    }
    out.sort((a, b) => b.received.localeCompare(a.received));
    return { ok: true, messages: out };
  } catch (e) {
    return { ok: false, code: 'error', error: e.message };
  } finally {
    fs.rm(tmp, { recursive: true, force: true }, () => {});
  }
}

/**
 * 한 대화방(같은 번호)의 문자 기록 — 받은 것과 보낸 것 모두, 최근 순 최대 limit개
 * @param {string} id 목록의 문자 id ("sms:123" / "mms:10")
 */
function readThread({ id, limit = 80 } = {}) {
  const src = dbDir();
  if (!src || !fs.existsSync(path.join(src, 'phone.db'))) return { ok: false, code: 'noPhoneLink' };
  const { DatabaseSync } = require('node:sqlite');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-phone-'));
  try {
    const db = new DatabaseSync(copyDb(src, 'phone.db', tmp));
    const [kind, num] = String(id).split(':');
    const row = db.prepare(`SELECT thread_id t FROM ${kind === 'mms' ? 'mms' : 'message'} WHERE message_id = ?`).get(Number(num));
    if (!row) return { ok: true, messages: [] };
    const MS = '(timestamp / 10000 - 11644473600000)';
    const sms = db.prepare(`SELECT message_id id, type, body, ${MS} ms FROM message WHERE thread_id = ? ORDER BY timestamp DESC LIMIT ?`).all(row.t, limit);
    const mms = db
      .prepare(
        `SELECT m.message_id id, m.type type, m.subject subject, (m.timestamp / 10000 - 11644473600000) ms,
                (SELECT group_concat(p.text, char(10)) FROM mms_part p WHERE p.message_id = m.message_id AND p.content_type = 'text/plain') body
           FROM mms m WHERE m.thread_id = ? ORDER BY m.timestamp DESC LIMIT ?`
      )
      .all(row.t, limit);
    db.close();
    const pad = (n) => String(n).padStart(2, '0');
    const iso = (ms) => {
      const d = new Date(Number(ms));
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    const out = [...sms.map((r) => ({ ...r, kind: 'sms' })), ...mms.map((r) => ({ ...r, kind: 'mms' }))]
      .map((r) => ({ id: `${r.kind}:${r.id}`, sent: Number(r.type) === 2, at: iso(r.ms), body: fixMojibake(r.body || r.subject || '').trim() }))
      .filter((r) => r.body)
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(-limit);
    return { ok: true, messages: out };
  } catch (e) {
    return { ok: false, code: 'error', error: e.message };
  } finally {
    fs.rm(tmp, { recursive: true, force: true }, () => {});
  }
}

module.exports = { readMessages, readThread, fixMojibake };
