// 통화 녹음(OneDrive에 올라온 .m4a) → PC 안에서 글로 바꾸기 (whisper.cpp)
// 녹음·글은 PC 밖으로 보내지 않는다. 글은 프로그램 데이터 폴더(calls)에만 저장.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const MODELS = {
  small: { file: 'ggml-small-q8_0.bin', size: 264, label: '빠름 (small)' },
  turbo: { file: 'ggml-large-v3-turbo-q5_0.bin', size: 574, label: '정확 (large-v3-turbo)' },
};
const CLI_URLS = [
  'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.0/whisper-bin-x64.zip',
  'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-bin-x64.zip',
];
const MODEL_URL = (f) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${f}`;

let userData = '';
const init = (dir) => (userData = dir);
// whisper-cli가 한글 경로를 못 열 수 있어 영문 경로(LOCALAPPDATA\\ScheduleTodo)에 둔다
const whisperDir = () => (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ScheduleTodo', 'whisper') : path.join(userData, 'whisper'));
const textDir = () => path.join(userData, 'calls');
const defaultDir = () => process.env.ST_CALLS_DIR || path.join(os.homedir(), 'OneDrive', '통화녹음');

// "통화 녹음 01012345678_261111_101303.m4a" / "통화 홍길동_261111_101303.m4a"
const NAME_RE = /^(?:통화\s*녹음|통화|Call recording)\s+(.+?)_(\d{6})_(\d{6})\.(m4a|mp3|wav|amr|3gp|aac|ogg)$/i;
function parseName(name) {
  const m = name.match(NAME_RE);
  if (!m) return null;
  const [, who, d, t] = m;
  return { who: who.trim(), at: `20${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 6)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}` };
}
const textPath = (name) => path.join(textDir(), name.replace(/\.[^.]+$/, '.txt'));

/** 폴더의 통화 녹음 (최근 days일) + 이미 만든 글 */
function list({ dir, days = 3 } = {}) {
  const d = dir || defaultDir();
  if (!fs.existsSync(d)) return { ok: false, code: 'noDir', dir: d };
  const since = new Date(Date.now() - Math.max(1, days) * 864e5);
  const pad = (n) => String(n).padStart(2, '0');
  const sinceIso = `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())}`;
  const out = [];
  for (const name of fs.readdirSync(d)) {
    const p = parseName(name);
    if (!p || p.at.slice(0, 10) < sinceIso) continue;
    let text = null;
    try {
      text = fs.readFileSync(textPath(name), 'utf8');
    } catch {
      /* 아직 안 바꿈 */
    }
    out.push({ name, path: path.join(d, name), who: p.who, at: p.at, text });
  }
  out.sort((a, b) => b.at.localeCompare(a.at));
  return { ok: true, dir: d, files: out };
}

/** 음성 인식 프로그램·모델 준비 상태 */
function findCli(dir) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = findCli(p);
      if (r) return r;
    } else if (e.name.toLowerCase() === 'whisper-cli.exe') return p;
  }
  return null;
}
function status({ model = 'small' } = {}) {
  const mf = path.join(whisperDir(), 'models', (MODELS[model] || MODELS.small).file);
  const cli = process.env.ST_WHISPER_CLI || findCli(path.join(whisperDir(), 'bin'));
  return { cli: cli || null, model: fs.existsSync(mf) ? mf : null, ready: !!cli && fs.existsSync(mf), models: MODELS, textDir: textDir() };
}

// Electron의 net.fetch(크롬 네트워크, 회사 프록시 설정 따름), 없으면 Node fetch
const netFetch = (url) => {
  try {
    const { net } = require('electron');
    if (net?.fetch) return net.fetch(url, { redirect: 'follow' });
  } catch {
    /* Electron 밖 */
  }
  return fetch(url, { redirect: 'follow' });
};
async function download(url, dest, onProgress) {
  const res = await netFetch(url);
  if (!res.ok) throw new Error(`내려받기 실패 (${res.status})`);
  const total = +res.headers.get('content-length') || 0;
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const fh = await fs.promises.open(part, 'w');
  let got = 0;
  let last = 0;
  try {
    const rd = res.body.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      await fh.write(value);
      got += value.length;
      if (Date.now() - last > 400) {
        last = Date.now();
        onProgress?.(got, total);
      }
    }
  } finally {
    await fh.close();
  }
  if (total && got < total) throw new Error('내려받기가 중간에 끊겼습니다.');
  fs.renameSync(part, dest);
  onProgress?.(got, total || got);
}

let installing = null;
/** whisper-cli + 모델 내려받기 (한 번만) */
function install({ model = 'small' } = {}, onProgress) {
  if (installing) return installing;
  installing = (async () => {
    const st = status({ model });
    if (!st.cli) {
      const zip = path.join(os.tmpdir(), `st-whisper-${Date.now()}.zip`);
      let err = null;
      for (const u of CLI_URLS) {
        try {
          await download(u, zip, (g, t) => onProgress?.({ step: '음성 인식 프로그램', got: g, total: t }));
          err = null;
          break;
        } catch (e) {
          err = e;
        }
      }
      if (err) throw err;
      const bin = path.join(whisperDir(), 'bin');
      fs.rmSync(bin, { recursive: true, force: true });
      fs.mkdirSync(bin, { recursive: true });
      await new Promise((resolve, reject) =>
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${bin.replace(/'/g, "''")}' -Force`],
          { windowsHide: true },
          (e) => (e ? reject(new Error(`압축 풀기 실패: ${e.message}`)) : resolve())
        )
      );
      fs.rm(zip, { force: true }, () => {});
      if (!findCli(bin)) throw new Error('whisper-cli.exe를 찾지 못했습니다.');
    }
    const m = MODELS[model] || MODELS.small;
    const mf = path.join(whisperDir(), 'models', m.file);
    if (!fs.existsSync(mf)) await download(MODEL_URL(m.file), mf, (g, t) => onProgress?.({ step: `음성 모델 ${m.label}`, got: g, total: t || m.size * 1e6 }));
    return status({ model });
  })().finally(() => (installing = null));
  return installing;
}

/** 녹음 파일 읽기 (OneDrive 온라인 전용이면 이때 내려받아짐) */
const readAudio = (file) => fs.promises.readFile(file);

// 무음 구간에서 생기는 엉뚱한 문장 (whisper 환각)
const JUNK = /^(?:시청해\s*주셔서\s*감사합니다|구독과\s*좋아요|MBC\s*뉴스|자막|한글자막|\[.*?\]|\(.*?\)|♪+)[.!]*$/;
function cleanText(t) {
  const lines = [];
  for (let l of String(t).split(/\r?\n/)) {
    l = l.replace(/\s+/g, ' ').trim();
    if (!l || JUNK.test(l)) continue;
    if (lines.length && lines[lines.length - 1] === l) continue; // 반복
    lines.push(l);
  }
  return lines.join('\n');
}

/**
 * 글로 바꾸기: wav(16kHz mono, 렌더러에서 디코딩) → whisper-cli → calls/<이름>.txt
 * @param {{name:string, file:string, wav:Uint8Array, model?:string, threads?:number, free?:boolean}} o
 */
async function transcribe({ name, file, wav, model = 'small', seconds = 60, free = true }) {
  const st = status({ model });
  if (!st.ready) return { ok: false, code: 'notReady' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-call-'));
  try {
    const w = path.join(tmp, 'a.wav');
    fs.writeFileSync(w, Buffer.from(wav));
    const outBase = path.join(tmp, 'out');
    const threads = Math.max(2, Math.min(8, (os.cpus()?.length || 4) - 1));
    const args = ['-m', st.model, '-f', w, '-l', 'ko', '-t', String(threads), '-nt', '-otxt', '-of', outBase, '-np', '--prompt', '안녕하세요. 네, 회계사님. 다음 주 화요일 오후 2시에 뵙겠습니다.'];
    await new Promise((resolve, reject) => {
      const p = spawn(st.cli, args, { windowsHide: true, cwd: path.dirname(st.cli) });
      let err = '';
      p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
      const to = setTimeout(() => p.kill(), Math.max(180, seconds * 6) * 1000);
      p.on('error', (e) => {
        clearTimeout(to);
        reject(e);
      });
      p.on('close', (code) => {
        clearTimeout(to);
        if (code === 0) return resolve();
        // 0xC0000135: DLL 없음 → Visual C++ 재배포 패키지 필요
        if (code === 3221225781 || code === -1073741515) return reject(new Error('Microsoft Visual C++ 재배포 패키지(x64)가 필요합니다. https://aka.ms/vs/17/release/vc_redist.x64.exe'));
        reject(new Error(`음성 인식 실패 (${code}) ${err.split('\n').filter(Boolean).slice(-2).join(' ')}`));
      });
    });
    const text = cleanText(fs.readFileSync(`${outBase}.txt`, 'utf8'));
    fs.mkdirSync(textDir(), { recursive: true });
    fs.writeFileSync(textPath(name), text, 'utf8');
    // 다 쓴 녹음 파일은 다시 OneDrive 온라인 전용으로 (공간 확보)
    if (free && file) execFile('attrib', ['+U', '-P', file], { windowsHide: true }, () => {});
    return { ok: true, text };
  } catch (e) {
    return { ok: false, code: 'error', error: e.message };
  } finally {
    fs.rm(tmp, { recursive: true, force: true }, () => {});
  }
}

module.exports = { init, list, status, install, readAudio, transcribe, parseName, cleanText, defaultDir, MODELS };
