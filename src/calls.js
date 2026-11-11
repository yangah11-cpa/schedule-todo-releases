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
// 목소리 구분 (sherpa-onnx, PC 안에서)
const SHERPA_VER = '2.0.1';
const SHERPA_PLAT = `sherpa-onnx-${os.platform() === 'win32' ? 'win' : os.platform()}-${os.arch()}`;
const NPM = (n) => `https://registry.npmjs.org/${n}/-/${n}-${SHERPA_VER}.tgz`;
const SK = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const SEG_URL = `${SK}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`;
const EMB_FILE = '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx';
const EMB_URL = `${SK}/speaker-recongition-models/${EMB_FILE}`;

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
const jsonPath = (name) => path.join(textDir(), name.replace(/\.[^.]+$/, '.json'));
const sherpaDir = () => process.env.ST_SHERPA_DIR || path.join(path.dirname(whisperDir()), 'sherpa');
const diarModels = () => ({ seg: path.join(sherpaDir(), 'models', 'sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx'), emb: path.join(sherpaDir(), 'models', EMB_FILE) });
const diarReady = () => {
  const m = diarModels();
  return fs.existsSync(path.join(sherpaDir(), 'node_modules', 'sherpa-onnx-node', 'package.json')) && fs.existsSync(path.join(sherpaDir(), 'node_modules', SHERPA_PLAT, 'package.json')) && fs.existsSync(m.seg) && fs.existsSync(m.emb);
};

/* ── '나' 찾기: 모든 통화에 공통으로 나오는 목소리 = 나 ── */
const voicePath = () => path.join(textDir(), 'voice.json');
const norm = (v) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};
const cos = (a, b) => {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s / ((Math.hypot(...a) || 1) * (Math.hypot(...b) || 1));
};
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const readVoice = () => readJson(voicePath()) || {};
const writeVoice = (v) => {
  fs.mkdirSync(textDir(), { recursive: true });
  fs.writeFileSync(voicePath(), JSON.stringify(v));
};
/** 통화 하나의 '나' 화자 번호 (사용자가 고친 것 > 목소리 비교) */
function meOf(rec, voice = readVoice()) {
  if (!rec?.emb) return null;
  if (rec.meBy === 'user' && rec.me != null) return rec.me;
  if (!voice.me) return null;
  const ks = Object.keys(rec.emb);
  let best = null;
  let bs = -2;
  for (const k of ks) {
    const s = cos(rec.emb[k], voice.me);
    if (s > bs) [bs, best] = [s, k];
  }
  if (ks.length === 1 && bs < 0.4) return null; // 혼자 말한 녹음인데 내 목소리가 아니면 상대
  return best == null ? null : +best;
}
const digitsOf = (w) => String(w || '').replace(/\D/g, '').slice(-8);
/** 아직 내 목소리를 모를 때: 서로 다른 상대와의 통화들에서 가장 닮은 목소리 한 쌍 = 나 */
function learnVoice() {
  const v = readVoice();
  if (v.me) return v;
  const recs = [];
  for (const f of fs.existsSync(textDir()) ? fs.readdirSync(textDir()) : []) {
    if (!f.endsWith('.json') || f === 'voice.json') continue;
    const r = readJson(path.join(textDir(), f));
    const p = parseName(f.replace(/\.json$/, '.m4a'));
    if (r?.emb && p) recs.push({ r, who: digitsOf(p.who) || p.who });
  }
  // 사용자가 직접 정한 통화가 있으면 그것으로
  const u = recs.find((x) => x.r.meBy === 'user' && x.r.emb[x.r.me]);
  if (u) {
    v.me = norm(u.r.emb[u.r.me]);
    v.n = 1;
    writeVoice(v);
    return v;
  }
  let best = null;
  for (let i = 0; i < recs.length; i++)
    for (let j = i + 1; j < recs.length; j++) {
      if (recs[i].who === recs[j].who) continue;
      for (const [ka, a] of Object.entries(recs[i].r.emb))
        for (const [kb, b] of Object.entries(recs[j].r.emb)) {
          const s = cos(a, b);
          if (!best || s > best.s) best = { s, a, b };
        }
    }
  if (best && best.s > 0.45) {
    v.me = norm(best.a.map((x, i) => x + best.b[i]));
    v.n = 2;
    writeVoice(v);
  }
  return v;
}
/** 사용자가 "이쪽이 나"로 고침 */
function setMe({ name, spk }) {
  const p = jsonPath(name);
  const r = readJson(p);
  if (!r) return { ok: false };
  r.me = +spk;
  r.meBy = 'user';
  fs.writeFileSync(p, JSON.stringify(r));
  const e = r.emb?.[spk];
  if (e) {
    const v = readVoice();
    v.me = v.me ? norm(v.me.map((x, i) => x + norm(e)[i])) : norm(e);
    v.n = (v.n || 0) + 1;
    writeVoice(v);
  }
  return { ok: true };
}

/** 폴더의 통화 녹음 (최근 days일) + 이미 만든 글 */
function list({ dir, days = 3 } = {}) {
  const d = dir || defaultDir();
  if (!fs.existsSync(d)) return { ok: false, code: 'noDir', dir: d };
  const since = new Date(Date.now() - Math.max(1, days) * 864e5);
  const pad = (n) => String(n).padStart(2, '0');
  const sinceIso = `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())}`;
  const out = [];
  const voice = readVoice();
  for (const name of fs.readdirSync(d)) {
    const p = parseName(name);
    if (!p || p.at.slice(0, 10) < sinceIso) continue;
    let text = null;
    let lines = null;
    let me = null;
    const r = readJson(jsonPath(name));
    if (r?.lines) {
      lines = r.lines;
      text = r.lines.map((l) => l.text).join('\n');
      me = meOf(r, voice);
    } else
      try {
        text = fs.readFileSync(textPath(name), 'utf8');
      } catch {
        /* 아직 안 바꿈 */
      }
    out.push({ name, path: path.join(d, name), who: p.who, at: p.at, text, lines, me, meBy: r?.meBy || null });
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
  return { cli: cli || null, model: fs.existsSync(mf) ? mf : null, ready: !!cli && fs.existsSync(mf), diar: diarReady(), models: MODELS, textDir: textDir() };
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
function install({ model = 'small', diar = false } = {}, onProgress) {
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
    if (diar && !diarReady()) await installDiar(onProgress);
    return status({ model });
  })().finally(() => (installing = null));
  return installing;
}

// tar.exe (Windows 10 이상 기본 포함): tgz·tar.bz2 풀기
const untar = (file, dest, strip = 0) =>
  new Promise((resolve, reject) => {
    fs.mkdirSync(dest, { recursive: true });
    const tarExe = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFile(tarExe, ['-xf', file, '-C', dest, ...(strip ? [`--strip-components=${strip}`] : [])], { windowsHide: true }, (e) => (e ? reject(new Error(`압축 풀기 실패: ${e.message}`)) : resolve()));
  });
async function installDiar(onProgress) {
  const base = sherpaDir();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sherpa-'));
  try {
    for (const pkg of ['sherpa-onnx-node', SHERPA_PLAT]) {
      const dest = path.join(base, 'node_modules', pkg);
      if (fs.existsSync(path.join(dest, 'package.json'))) continue;
      const f = path.join(tmp, `${pkg}.tgz`);
      await download(NPM(pkg), f, (g, t) => onProgress?.({ step: '목소리 구분 프로그램', got: g, total: t }));
      fs.rmSync(dest, { recursive: true, force: true });
      await untar(f, dest, 1);
    }
    const m = diarModels();
    if (!fs.existsSync(m.seg)) {
      const f = path.join(tmp, 'seg.tar.bz2');
      await download(SEG_URL, f, (g, t) => onProgress?.({ step: '목소리 구분 모델 1/2', got: g, total: t }));
      await untar(f, path.join(base, 'models'));
    }
    if (!fs.existsSync(m.emb)) await download(EMB_URL, m.emb, (g, t) => onProgress?.({ step: '목소리 구분 모델 2/2', got: g, total: t }));
  } finally {
    fs.rm(tmp, { recursive: true, force: true }, () => {});
  }
}

/** 목소리 구분 실행 (별도 프로세스) → { segments:[{start,end,speaker}], emb:{spk:[...]} } */
function diarize(wavPath, tmp) {
  return new Promise((resolve, reject) => {
    const m = diarModels();
    const cfg = path.join(tmp, 'diar.json');
    const out = path.join(tmp, 'diar-out.json');
    fs.writeFileSync(cfg, JSON.stringify({ sherpa: sherpaDir(), seg: m.seg, emb: m.emb, wav: wavPath, out, speakers: 2 }));
    const plat = path.join(sherpaDir(), 'node_modules', SHERPA_PLAT);
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: `${plat}${path.delimiter}${process.env.PATH || ''}`, LD_LIBRARY_PATH: `${plat}${path.delimiter}${process.env.LD_LIBRARY_PATH || ''}` };
    const p = spawn(process.execPath, [path.join(__dirname, 'diarize.js'), cfg], { env, windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d).slice(-1500)));
    const to = setTimeout(() => p.kill(), 10 * 60 * 1000);
    p.on('error', (e) => {
      clearTimeout(to);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(to);
      if (code !== 0) return reject(new Error(`목소리 구분 실패 (${code}) ${err.split('\n').filter(Boolean)[0] || ''}`));
      resolve(JSON.parse(fs.readFileSync(out, 'utf8')));
    });
  });
}

/** whisper 문장(시간 포함)에 화자 붙이기 → 같은 화자가 이어 말한 건 한 말풍선으로 */
function mergeSpeakers(segs, diar) {
  const lines = [];
  for (const s of segs) {
    const a = s.from / 1000;
    const b = Math.max(s.to / 1000, a + 0.05);
    const ov = {};
    for (const d of diar?.segments || []) {
      const o = Math.min(b, d.end) - Math.max(a, d.start);
      if (o > 0) ov[d.speaker] = (ov[d.speaker] || 0) + o;
    }
    let spk = Object.keys(ov).sort((x, y) => ov[y] - ov[x])[0];
    if (spk == null && diar?.segments?.length) {
      // 겹치는 구간이 없으면 가장 가까운 구간
      const mid = (a + b) / 2;
      spk = [...diar.segments].sort((x, y) => Math.abs((x.start + x.end) / 2 - mid) - Math.abs((y.start + y.end) / 2 - mid))[0].speaker;
    }
    spk = spk == null ? null : +spk;
    const prev = lines[lines.length - 1];
    if (prev && prev.spk === spk && a - prev.end < (spk == null ? 1.0 : 1.2) && prev.text.length < (spk == null ? 220 : 160)) {
      prev.text = `${prev.text} ${s.text}`;
      prev.end = b;
    } else lines.push({ t: Math.round(a * 10) / 10, end: b, spk, text: s.text });
  }
  return lines.map(({ end, ...l }) => l);
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
async function transcribe({ name, file, wav, model = 'small', seconds = 60, free = true, diar: useDiar = false }) {
  const st = status({ model });
  if (!st.ready) return { ok: false, code: 'notReady' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-call-'));
  try {
    const w = path.join(tmp, 'a.wav');
    fs.writeFileSync(w, Buffer.from(wav));
    const outBase = path.join(tmp, 'out');
    const threads = Math.max(2, Math.min(8, (os.cpus()?.length || 4) - 1));
    const args = ['-m', st.model, '-f', w, '-l', 'ko', '-t', String(threads), '-oj', '-ml', '60', '-sow', '-of', outBase, '-np', '--prompt', '안녕하세요. 네, 회계사님. 다음 주 화요일 오후 2시에 뵙겠습니다.'];
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
    const j = JSON.parse(fs.readFileSync(`${outBase}.json`, 'utf8'));
    const segs = [];
    for (const x of j.transcription || []) {
      const t = cleanText(x.text || '');
      if (!t) continue;
      if (segs.length && segs[segs.length - 1].text === t) continue;
      segs.push({ from: x.offsets?.from || 0, to: x.offsets?.to || 0, text: t });
    }
    // 목소리 구분 (설치돼 있을 때만, 실패해도 글은 저장)
    let diar = null;
    let diarErr = null;
    if (useDiar && diarReady())
      try {
        diar = await diarize(w, tmp);
      } catch (e) {
        diarErr = e.message;
      }
    const lines = mergeSpeakers(segs, diar);
    const text = lines.map((l) => l.text).join('\n\n');
    fs.mkdirSync(textDir(), { recursive: true });
    fs.writeFileSync(textPath(name), text, 'utf8');
    const rec = { v: 2, lines, emb: diar?.emb || null, me: null, meBy: null, diarErr };
    fs.writeFileSync(jsonPath(name), JSON.stringify(rec));
    if (rec.emb) learnVoice();
    // 다 쓴 녹음 파일은 다시 OneDrive 온라인 전용으로 (공간 확보)
    if (free && file) execFile('attrib', ['+U', '-P', file], { windowsHide: true }, () => {});
    return { ok: true, text, lines, me: meOf(rec), diarErr };
  } catch (e) {
    return { ok: false, code: 'error', error: e.message };
  } finally {
    fs.rm(tmp, { recursive: true, force: true }, () => {});
  }
}

module.exports = { init, list, status, install, readAudio, transcribe, setMe, mergeSpeakers, learnVoice, meOf, parseName, cleanText, defaultDir, MODELS };
