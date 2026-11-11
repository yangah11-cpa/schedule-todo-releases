// 목소리 구분 (별도 프로세스에서 실행: 계산이 오래 걸려도 창이 멈추지 않게)
// 사용: ELECTRON_RUN_AS_NODE=1 electron diarize.js <설정.json>
// 설정: { sherpa, seg, emb, wav, out, speakers }
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

function main() {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const sherpa = require(path.join(cfg.sherpa, 'node_modules', 'sherpa-onnx-node'));
  const { samples, sampleRate } = readWav16(cfg.wav);
  const sd = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: cfg.seg }, numThreads: 2 },
    embedding: { model: cfg.emb, numThreads: 2 },
    clustering: { numClusters: cfg.speakers || 2 },
    minDurationOn: 0.2,
    minDurationOff: 0.4,
  });
  const segments = sd.process(samples).map((s) => ({ start: +s.start.toFixed(2), end: +s.end.toFixed(2), speaker: s.speaker }));
  // 화자마다 목소리 특징(임베딩): 다른 통화와 비교해 '나'를 찾는 데 씀
  const ext = new sherpa.SpeakerEmbeddingExtractor({ model: cfg.emb, numThreads: 2 });
  const emb = {};
  for (const spk of [...new Set(segments.map((s) => s.speaker))]) {
    const parts = [];
    let total = 0;
    for (const s of segments.filter((x) => x.speaker === spk).sort((a, b) => b.end - b.start - (a.end - a.start))) {
      if (total > 60 * sampleRate) break;
      const a = samples.subarray(Math.floor(s.start * sampleRate), Math.floor(s.end * sampleRate));
      parts.push(a);
      total += a.length;
    }
    if (total < sampleRate * 0.5) continue;
    const all = new Float32Array(total);
    let o = 0;
    for (const a of parts) {
      all.set(a, o);
      o += a.length;
    }
    const st = ext.createStream();
    st.acceptWaveform({ samples: all, sampleRate });
    st.inputFinished();
    if (ext.isReady(st)) emb[spk] = Array.from(ext.compute(st, false), (v) => +v.toFixed(5));
  }
  fs.writeFileSync(cfg.out, JSON.stringify({ segments, emb }));
}

try {
  main();
} catch (e) {
  process.stderr.write(String(e?.stack || e));
  process.exit(2);
}
