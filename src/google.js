// Google 캘린더 연동 (데스크톱 OAuth: 루프백 + PKCE)
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { shell, safeStorage } = require('electron');

const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar';
const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';
const SCOPE = `${CAL_SCOPE} ${TASKS_SCOPE}`;
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
// ST_GAPI_BASE: 개발용 모의 서버 주소 (일반 사용 시 비어 있음)
const DEV = process.env.ST_GAPI_BASE;
const TOKEN_URL = DEV ? `${DEV}/token` : 'https://oauth2.googleapis.com/token';
const API = DEV ? `${DEV}/calendar/v3` : 'https://www.googleapis.com/calendar/v3';
const TASKS_API = DEV ? `${DEV}/tasks/v1` : 'https://tasks.googleapis.com/tasks/v1';

class GoogleCalendar {
  constructor(dir) {
    this.file = path.join(dir, 'google-auth.dat');
    this.state = this._load(); // { clientId, clientSecret, refreshToken, account }
    this.access = null; // { token, exp }
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file);
      const txt = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
      return JSON.parse(txt);
    } catch {
      return {};
    }
  }

  _save() {
    const txt = JSON.stringify(this.state);
    const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(txt) : Buffer.from(txt, 'utf8');
    fs.writeFileSync(this.file, data);
  }

  status() {
    return {
      configured: !!(this.state.clientId && this.state.clientSecret),
      connected: !!this.state.refreshToken,
      account: this.state.account || null,
      clientId: this.state.clientId || '',
      // 할 일(Google Tasks) 권한: 예전에 캘린더만 승인한 경우 다시 연결 필요
      tasks: !!this.state.refreshToken && String(this.state.scopes || '').includes(TASKS_SCOPE),
    };
  }

  setClient(clientId, clientSecret) {
    const changed = clientId !== this.state.clientId;
    this.state.clientId = (clientId || '').trim();
    if (clientSecret) this.state.clientSecret = clientSecret.trim();
    if (changed) {
      delete this.state.refreshToken;
      delete this.state.account;
      this.access = null;
    }
    this._save();
    return this.status();
  }

  async connect() {
    const { clientId, clientSecret } = this.state;
    if (!clientId || !clientSecret) throw new Error('클라이언트 ID와 보안 비밀번호를 먼저 입력하세요.');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const stateParam = crypto.randomBytes(16).toString('hex');

    const { code, redirectUri } = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== '/') {
          res.writeHead(404).end();
          return;
        }
        const ok = url.searchParams.get('state') === stateParam && url.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<html><body style="font-family:sans-serif;padding:40px"><h2>${
            ok ? 'Google 캘린더 연결이 완료되었습니다.' : '연결이 취소되었거나 실패했습니다.'
          }</h2><p>이 창을 닫고 프로그램으로 돌아가세요.</p></body></html>`
        );
        clearTimeout(timer);
        server.close();
        if (ok) resolve({ code: url.searchParams.get('code'), redirectUri });
        else reject(new Error(url.searchParams.get('error') || '연결이 취소되었습니다.'));
      });
      let redirectUri;
      const timer = setTimeout(() => {
        server.close();
        reject(new Error('5분 안에 로그인이 완료되지 않았습니다. 다시 시도하세요.'));
      }, 5 * 60 * 1000);
      server.listen(0, '127.0.0.1', () => {
        redirectUri = `http://127.0.0.1:${server.address().port}`;
        const q = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPE,
          access_type: 'offline',
          prompt: 'consent',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state: stateParam,
        });
        shell.openExternal(`${AUTH_URL}?${q}`);
      });
    });

    const tok = await this._token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    if (!tok.refresh_token) throw new Error('갱신 토큰을 받지 못했습니다. 다시 연결해 주세요.');
    this.state.refreshToken = tok.refresh_token;
    this.state.scopes = tok.scope || SCOPE;
    this.access = { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
    try {
      const primary = await this.api('GET', '/calendars/primary');
      this.state.account = primary.id;
    } catch {
      this.state.account = null;
    }
    this._save();
    return this.status();
  }

  async disconnect() {
    const t = this.state.refreshToken;
    delete this.state.refreshToken;
    delete this.state.account;
    this.access = null;
    this._save();
    if (t) {
      try {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, { method: 'POST' });
      } catch {
        /* 무시 */
      }
    }
    return this.status();
  }

  async _token(params) {
    const body = new URLSearchParams({
      client_id: this.state.clientId,
      client_secret: this.state.clientSecret,
      ...params,
    });
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(j.error_description || j.error || `토큰 요청 실패 (${r.status})`);
      err.code = j.error;
      throw err;
    }
    return j;
  }

  async _accessToken(force = false) {
    if (!this.state.refreshToken) {
      const e = new Error('Google 캘린더가 연결되어 있지 않습니다.');
      e.code = 'not_connected';
      throw e;
    }
    if (!force && this.access && Date.now() < this.access.exp) return this.access.token;
    try {
      const tok = await this._token({ grant_type: 'refresh_token', refresh_token: this.state.refreshToken });
      this.access = { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
      if (tok.scope && tok.scope !== this.state.scopes) {
        this.state.scopes = tok.scope;
        this._save();
      }
      return this.access.token;
    } catch (e) {
      if (e.code === 'invalid_grant') {
        delete this.state.refreshToken;
        this._save();
        const err = new Error('Google 로그인이 만료되었습니다. 설정에서 다시 연결하세요.');
        err.code = 'not_connected';
        throw err;
      }
      throw e;
    }
  }

  async api(method, p, body, retry = true, base = API) {
    const token = await this._accessToken();
    const r = await fetch(base + p, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401 && retry) {
      await this._accessToken(true);
      return this.api(method, p, body, false, base);
    }
    if (r.status === 204) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if ((r.status === 404 || r.status === 410) && method === 'DELETE') return null; // 이미 삭제됨
      const err = new Error(j.error?.message || `Google API 오류 (${r.status})`);
      err.status = r.status;
      throw err;
    }
    return j;
  }

  /* ───── Google Tasks (할 일) ───── */
  tasks(method, p, body) {
    return this.api(method, p, body, true, TASKS_API);
  }

  async listTasks(listId = '@default') {
    const items = [];
    let pageToken;
    do {
      const q = new URLSearchParams({ maxResults: '100', showCompleted: 'true', showHidden: 'true', showDeleted: 'true' });
      if (pageToken) q.set('pageToken', pageToken);
      const j = await this.tasks('GET', `/lists/${encodeURIComponent(listId)}/tasks?${q}`);
      items.push(...(j.items || []));
      pageToken = j.nextPageToken;
    } while (pageToken);
    return items;
  }

  insertTask(listId, task, parent, previous) {
    const q = new URLSearchParams();
    if (parent) q.set('parent', parent);
    if (previous) q.set('previous', previous);
    return this.tasks('POST', `/lists/${encodeURIComponent(listId)}/tasks${q.toString() ? `?${q}` : ''}`, task);
  }

  patchTask(listId, id, task) {
    return this.tasks('PATCH', `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(id)}`, task);
  }

  deleteTask(listId, id) {
    return this.tasks('DELETE', `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(id)}`);
  }

  async listCalendars() {
    const j = await this.api('GET', '/users/me/calendarList?maxResults=250');
    return (j.items || []).map((c) => ({
      id: c.id,
      summary: c.summaryOverride || c.summary,
      primary: !!c.primary,
      selected: !!c.selected,
      color: c.backgroundColor,
      writable: c.accessRole === 'owner' || c.accessRole === 'writer',
    }));
  }

  async listEvents(calendarId, timeMin, timeMax) {
    const items = [];
    let pageToken;
    do {
      const q = new URLSearchParams({
        timeMin,
        timeMax,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '2500',
      });
      if (pageToken) q.set('pageToken', pageToken);
      const j = await this.api('GET', `/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
      items.push(...(j.items || []));
      pageToken = j.nextPageToken;
    } while (pageToken);
    return items;
  }

  getEvent(calendarId, eventId) {
    return this.api('GET', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  }

  insertEvent(calendarId, ev) {
    return this.api('POST', `/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`, ev);
  }

  patchEvent(calendarId, eventId, ev) {
    return this.api(
      'PATCH',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
      ev
    );
  }

  deleteEvent(calendarId, eventId) {
    return this.api(
      'DELETE',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`
    );
  }
}

module.exports = { GoogleCalendar };
