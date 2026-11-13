// 목소리 구분 (별도 프로세스에서 실행: 계산이 오래 걸려도 창이 멈추지 않게)
// 사용: ELECTRON_RUN_AS_NODE=1 electron diarize.js <설정.json>
// 설정: { sherpa, vad, emb, wav, out }
//
// 방식 (v2): 쉬는 틈마다 짧은 말로 자르고(VAD) → 말마다 목소리 특징 → 통화 전체 평균을 빼서
// (전화 음질처럼 모든 목소리에 공통으로 섞인 성분 제거) → 두 무리로 나눔.
// 갤럭시 통화 녹음은 내 목소리와 상대 목소리가 한 채널(모노)에 섞여 있어, 이 방식이 훨씬 정확하다.
const fs = require('fs');
const path = require('path');

function readWav16(file) {
  const b = fs.readFileSync(file);
  // RIFF 안의 'data' 조각 찾기 (16-bit PCM mono)
  let p = 12;
  let rate = 16000;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') rate = b.readUInt32LE(p + 12);
    if (id === 'data') {
      const n = Math.floor(Math.min(size, b.length - p - 8) / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(p + 8 + i * 2) / 32768;
      return { samples: out, sampleRate: rate };
    }
    p += 8 + size + (size % 2);
  }
  throw new Error('wav data 없음');
}

const unit = (v) => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
};
const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
const meanOf = (vs, dim) => {
  const m = new Array(dim).fill(0);
  for (const v of vs) for (let i = 0; i < dim; i++) m[i] += v[i];
  return m.map((x) => x / (vs.length || 1));
};

/** 말 조각 자르기 */
function speechParts(sherpa, vadModel, samples, sampleRate) {
  const vad = new sherpa.Vad(
    { sileroVad: { model: vadModel, threshold: 0.5, minSilenceDuration: 0.25, minSpeechDuration: 0.2, maxSpeechDuration: 8, windowSize: 512 }, sampleRate, numThreads: 1, debug: false },
    Math.ceil(samples.length / sampleRate) + 30,
  );
  const parts = [];
  const take = () => {
    while (!vad.isEmpty()) {
      const f = vad.front(false);
      parts.push({ start: f.start / sampleRate, end: (f.start + f.samples.length) / sampleRate });
      vad.pop();
    }
  };
  for (let i = 0; i < samples.length; i += 512) {
    vad.acceptWaveform(samples.subarray(i, Math.min(i + 512, samples.length)));
    take();
  }
  vad.flush();
  take();
  return parts;
}

/** 두 무리로 나누기 (평균 뺀 특징으로 k-means, 여러 번 시작해서 가장 잘 뭉친 것) */
function twoGroups(X, w) {
  const n = X.length;
  if (n < 2) return new Array(n).fill(0);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let best = null;
  for (let t = 0; t < 40; t++) {
    const i0 = Math.floor(rnd() * n);
    let i1 = Math.floor(rnd() * n);
    if (i1 === i0) i1 = (i0 + 1) % n;
    let C = [X[i0], X[i1]];
    let lab = null;
    let ok = true;
    for (let it = 0; it < 30; it++) {
      const nl = X.map((x) => (dot(x, C[0]) >= dot(x, C[1]) ? 0 : 1));
      const c0 = nl.filter((l) => l === 0).length;
      if (c0 < 2 || n - c0 < 2) {
        ok = false;
        break;
      }
      const same = lab && nl.every((l, i) => l === lab[i]);
      lab = nl;
      C = [0, 1].map((k) => unit(meanOf(X.filter((_, i) => lab[i] === k), X[0].length)));
      if (same) break;
    }
    if (!ok || !lab) continue;
    let sc = 0;
    for (let i = 0; i < n; i++) sc += dot(X[i], C[lab[i]]) * w[i];
    if (!best || sc > best.sc) best = { sc, lab };
  }
  return best ? best.lab : new Array(n).fill(0);
}

function main() {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const sherpa = require(path.join(cfg.sherpa, 'node_modules', 'sherpa-onnx-node'));
  const { samples, sampleRate } = readWav16(cfg.wav);
  const parts = speechParts(sherpa, cfg.vad, samples, sampleRate);
  const ext = new sherpa.SpeakerEmbeddingExtractor({ model: cfg.emb, numThreads: 2 });
  const used = [];
  for (const p of parts) {
    if (p.end - p.start < 0.7) continue; // 아주 짧은 맞장구는 목소리 특징이 부정확 → 앞뒤 말에 붙음
    const st = ext.createStream();
    st.acceptWaveform({ samples: samples.subarray(Math.floor(p.start * sampleRate), Math.floor(p.end * sampleRate)), sampleRate });
    st.inputFinished();
    if (!ext.isReady(st)) continue;
    p.raw = unit(Array.from(ext.compute(st, false)));
    used.push(p);
  }
  const dim = used[0]?.raw.length || 0;
  const avg = meanOf(used.map((p) => p.raw), dim);
  const X = used.map((p) => unit(p.raw.map((x, i) => x - avg[i])));
  const lab = twoGroups(X, used.map((p) => p.end - p.start));
  used.forEach((p, i) => (p.speaker = lab[i]));
  const segments = used.map((p) => ({ start: +p.start.toFixed(2), end: +p.end.toFixed(2), speaker: p.speaker }));
  // 화자마다 목소리 특징(평균 빼기 전): 다른 통화와 비교해 '나'를 찾는 데 씀
  const emb = {};
  for (const k of [0, 1]) {
    const mine = used.filter((p) => p.speaker === k);
    const sec = mine.reduce((s, p) => s + p.end - p.start, 0);
    if (sec < 1) continue;
    emb[k] = unit(meanOf(mine.map((p) => p.raw), dim)).map((v) => +v.toFixed(5));
  }
  fs.writeFileSync(cfg.out, JSON.stringify({ v: 2, segments, emb }));
}

try {
  main();
} catch (e) {
  process.stderr.write(String(e?.stack || e));
  process.exit(2);
}
