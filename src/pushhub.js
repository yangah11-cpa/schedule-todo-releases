// 휴대폰 앱(PWA)으로 알림 보내기 — Web Push (RFC 8291 aes128gcm + VAPID), 외부 라이브러리 없이 구현
// 휴대폰 구독 정보와 이 PC의 공개키는 Google Tasks의 "일정&할일 알림 연결" 목록으로 주고받는다.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LIST_TITLE = '일정&할일 알림 연결 (지우지 마세요)';
const KEY_TITLE = 'PC 알림 키 (지우지 마세요)';
const SUBJECT = 'https://yangah11-cpa.github.io/schedule-todo-releases/';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');

class PushHub {
  constructor(google, dir) {
    this.google = google;
    this.file = path.join(dir, 'push-vapid.json');
    this.keys = this._loadKeys();
    this.listId = null;
    this.devicesCache = null; // { at, list }
  }

  _loadKeys() {
    try {
      const k = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (k.publicKey && k.privateJwk) return k;
    } catch {
      /* 새로 만듦 */
    }
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const raw = Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
    const k = { publicKey: b64u(raw), privateJwk: privateKey.export({ format: 'jwk' }) };
    fs.writeFileSync(this.file, JSON.stringify(k));
    return k;
  }

  async _list(create) {
    if (this.listId) return this.listId;
    const j = await this.google.tasks('GET', '/users/@me/lists?maxResults=100');
    let l = (j.items || []).find((x) => x.title === LIST_TITLE);
    if (!l && create) l = await this.google.tasks('POST', '/users/@me/lists', { title: LIST_TITLE });
    this.listId = l ? l.id : null;
    return this.listId;
  }

  async _items(listId) {
    const j = await this.google.tasks('GET', `/lists/${encodeURIComponent(listId)}/tasks?showHidden=true&maxResults=100`);
    return j.items || [];
  }

  /** 이 PC의 공개키를 목록에 올려 두고 연결된 휴대폰 수를 돌려준다 */
  async init() {
    const listId = await this._list(true);
    const items = await this._items(listId);
    const keyTask = items.find((t) => t.title === KEY_TITLE);
    if (!keyTask) await this.google.tasks('POST', `/lists/${encodeURIComponent(listId)}/tasks`, { title: KEY_TITLE, notes: this.keys.publicKey });
    else if ((keyTask.notes || '').trim() !== this.keys.publicKey)
      await this.google.tasks('PATCH', `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(keyTask.id)}`, { notes: this.keys.publicKey });
    this.devicesCache = null;
    const devs = await this.devices();
    return { devices: devs.map((d) => d.name) };
  }

  async devices() {
    if (this.devicesCache && Date.now() - this.devicesCache.at < 3 * 60 * 1000) return this.devicesCache.list;
    const listId = await this._list(false);
    if (!listId) return [];
    const list = [];
    for (const t of await this._items(listId)) {
      if (t.title === KEY_TITLE || t.deleted) continue;
      try {
        const d = JSON.parse(t.notes || '');
        if (d.sub?.endpoint && d.sub?.keys?.p256dh && d.sub?.keys?.auth) list.push({ taskId: t.id, name: d.name || '휴대폰', sub: d.sub });
      } catch {
        /* 다른 항목 */
      }
    }
    this.devicesCache = { at: Date.now(), list };
    return list;
  }

  _vapidHeader(endpoint) {
    const aud = new URL(endpoint).origin;
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT }));
    const key = crypto.createPrivateKey({ key: this.keys.privateJwk, format: 'jwk' });
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${head}.${body}.${b64u(sig)}, k=${this.keys.publicKey}`;
  }

  /** RFC 8291 메시지 암호화 (aes128gcm) */
  static encrypt(sub, payload) {
    const uaPublic = fromB64u(sub.keys.p256dh);
    const authSecret = fromB64u(sub.keys.auth);
    const ecdh = crypto.createECDH('prime256v1');
    const asPublic = ecdh.generateKeys();
    const shared = ecdh.computeSecret(uaPublic);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
    const salt = crypto.randomBytes(16);
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const plain = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])]);
    const enc = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    const rs = Buffer.alloc(4);
    rs.writeUInt32BE(4096);
    const header = Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic]);
    return Buffer.concat([header, enc]);
  }

  async _send(sub, payload) {
    const body = PushHub.encrypt(sub, payload);
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: 'high',
        Authorization: this._vapidHeader(sub.endpoint),
      },
      body,
    });
    return r.status;
  }

  /** 휴대폰 앱에서 볼 데이터(팀 일정표 등)를 연결 목록에 나눠서 저장. 캘린더에는 올리지 않음 */
  async saveBlob(name, text) {
    const listId = await this._list(true);
    const prefix = `${name} 데이터 (`;
    const items = await this._items(listId);
    for (const t of items.filter((x) => (x.title || '').startsWith(prefix) && !x.deleted)) {
      await this.google.tasks('DELETE', `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(t.id)}`).catch(() => {});
    }
    const size = 7000; // Google Tasks 메모 한도(8,192자) 안에서 나눔
    const parts = [];
    for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
    for (let i = 0; i < parts.length; i++) {
      await this.google.tasks('POST', `/lists/${encodeURIComponent(listId)}/tasks`, {
        title: `${prefix}${i + 1}/${parts.length}) — 지우지 마세요`,
        notes: parts[i],
      });
    }
    return parts.length;
  }

  /** 연결된 모든 휴대폰으로 알림 보내기 */
  async notify(msg) {
    const devs = await this.devices();
    const payload = JSON.stringify(msg);
    let sent = 0;
    for (const d of devs) {
      try {
        const st = await this._send(d.sub, payload);
        if (st === 404 || st === 410) {
          // 앱을 지웠거나 알림을 끈 휴대폰 → 목록에서 제거
          await this.google.tasks('DELETE', `/lists/${encodeURIComponent(this.listId)}/tasks/${encodeURIComponent(d.taskId)}`).catch(() => {});
          this.devicesCache = null;
        } else if (st >= 200 && st < 300) sent++;
      } catch {
        /* 다음 기기 */
      }
    }
    return { sent, devices: devs.length };
  }
}

module.exports = { PushHub };
