// 첨부 파일에서 글자만 뽑는다 (PDF · Word · 한글 HWP/HWPX · 텍스트). 모두 PC 안에서 처리.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');

const MAX = 12000; // 파일당 글자 수 상한

/* ───────── zip (docx, hwpx) ───────── */
function unzipEntries(buf) {
  // 중앙 디렉터리에서 파일 목록
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip 아님');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let k = 0; k < n; k++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28);
    const xl = buf.readUInt16LE(p + 30);
    const cl = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const lnl = buf.readUInt16LE(off + 26);
    const lxl = buf.readUInt16LE(off + 28);
    const ds = off + 30 + lnl + lxl;
    const raw = buf.subarray(ds, ds + csize);
    out[name] = () => (method === 8 ? zlib.inflateRawSync(raw) : raw);
    p += 46 + nl + xl + cl;
  }
  return out;
}
const xmlText = (xml, paraTag) =>
  xml
    .replace(new RegExp(`</(?:${paraTag})>`, 'g'), '\n')
    .replace(/<(?:w:tab|hp:tab)\b[^>]*\/?>/g, '\t')
    .replace(/<(?:w:br|hp:lineBreak)\b[^>]*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');

function docx(buf) {
  const z = unzipEntries(buf);
  const doc = z['word/document.xml'];
  return doc ? xmlText(doc().toString('utf8'), 'w:p') : '';
}
function hwpx(buf) {
  const z = unzipEntries(buf);
  return Object.keys(z)
    .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10))
    .map((n) => xmlText(z[n]().toString('utf8'), 'hp:p'))
    .join('\n');
}

/* ───────── 한글 HWP 5 (OLE 복합 문서) ───────── */
function cfb(buf) {
  if (buf.readUInt32LE(0) !== 0xe011cfd0) throw new Error('HWP 형식 아님');
  const ss = 1 << buf.readUInt16LE(30);
  const mss = 1 << buf.readUInt16LE(32);
  const nFat = buf.readUInt32LE(44);
  const dirStart = buf.readUInt32LE(48);
  const miniCut = buf.readUInt32LE(56);
  const mfatStart = buf.readUInt32LE(60);
  let difStart = buf.readUInt32LE(68);
  const sec = (i) => 512 + i * ss;
  const difat = [];
  for (let i = 0; i < 109; i++) difat.push(buf.readUInt32LE(76 + i * 4));
  while (difStart < 0xfffffffa && difat.length < nFat + 200) {
    const o = sec(difStart);
    for (let i = 0; i < ss / 4 - 1; i++) difat.push(buf.readUInt32LE(o + i * 4));
    difStart = buf.readUInt32LE(o + ss - 4);
  }
  const fat = [];
  for (let i = 0; i < nFat; i++) {
    const o = sec(difat[i]);
    for (let j = 0; j < ss / 4; j++) fat.push(buf.readUInt32LE(o + j * 4));
  }
  const chain = (start, table) => {
    const out = [];
    for (let s = start, g = 0; s < 0xfffffffa && g < 1e6; s = table[s], g++) out.push(s);
    return out;
  };
  const readBig = (start, size) => Buffer.concat(chain(start, fat).map((s) => buf.subarray(sec(s), sec(s) + ss))).subarray(0, size);
  const dirBuf = readBig(dirStart, Infinity);
  const ents = [];
  for (let o = 0; o + 128 <= dirBuf.length; o += 128) {
    const nl = dirBuf.readUInt16LE(o + 64);
    ents.push({
      name: dirBuf.toString('utf16le', o, o + Math.max(0, nl - 2)),
      type: dirBuf[o + 66],
      left: dirBuf.readUInt32LE(o + 68),
      right: dirBuf.readUInt32LE(o + 72),
      child: dirBuf.readUInt32LE(o + 76),
      start: dirBuf.readUInt32LE(o + 116),
      size: dirBuf.readUInt32LE(o + 120),
    });
  }
  const root = ents[0];
  const ministream = readBig(root.start, root.size);
  const mfat = [];
  if (mfatStart < 0xfffffffa) {
    for (const s of chain(mfatStart, fat)) for (let j = 0; j < ss / 4; j++) mfat.push(buf.readUInt32LE(sec(s) + j * 4));
  }
  const readEnt = (e) =>
    e.size < miniCut
      ? Buffer.concat(chain(e.start, mfat).map((s) => ministream.subarray(s * mss, s * mss + mss))).subarray(0, e.size)
      : readBig(e.start, e.size);
  // 저장소 안의 자식 목록 (빨강-검정 트리)
  const children = (idx) => {
    const out = [];
    const walk = (i) => {
      if (i >= ents.length || i === 0xffffffff) return;
      walk(ents[i].left);
      out.push(ents[i]);
      walk(ents[i].right);
    };
    walk(ents[idx].child);
    return out;
  };
  const find = (p) => {
    let idx = 0;
    for (const part of p.split('/')) {
      const c = children(idx).find((x) => x.name === part);
      if (!c) return null;
      idx = ents.indexOf(c);
    }
    return ents[idx];
  };
  return { find, children: (p) => children(ents.indexOf(find(p))), readEnt };
}
function hwp(buf) {
  const f = cfb(buf);
  const fh = f.find('FileHeader');
  if (!fh) throw new Error('HWP 머리글 없음');
  const props = f.readEnt(fh).readUInt32LE(36);
  if (props & 2) return ''; // 암호가 걸린 문서
  const compressed = !!(props & 1);
  const sections = f
    .children('BodyText')
    .filter((e) => /^Section\d+$/.test(e.name))
    .sort((a, b) => parseInt(a.name.slice(7), 10) - parseInt(b.name.slice(7), 10));
  const parts = [];
  for (const s of sections) {
    let data = f.readEnt(s);
    if (compressed) data = zlib.inflateRawSync(data);
    for (let o = 0; o + 4 <= data.length; ) {
      const hdr = data.readUInt32LE(o);
      const tag = hdr & 0x3ff;
      let size = hdr >>> 20;
      o += 4;
      if (size === 0xfff) {
        size = data.readUInt32LE(o);
        o += 4;
      }
      if (tag === 67) parts.push(paraText(data.subarray(o, o + size)));
      o += size;
    }
  }
  return parts.join('\n');
}
// HWPTAG_PARA_TEXT: UTF-16, 제어 문자 0~31 중 일부는 8글자(16바이트) 차지
function paraText(b) {
  let s = '';
  for (let i = 0; i + 1 < b.length; ) {
    const c = b.readUInt16LE(i);
    if (c < 32) {
      if (c === 10 || c === 13) s += '\n';
      else if (c === 9) s += '\t';
      const ext = (c >= 1 && c <= 9) || c === 11 || c === 12 || (c >= 14 && c <= 23);
      i += ext ? 16 : 2;
      continue;
    }
    s += String.fromCharCode(c);
    i += 2;
  }
  return s.replace(/\n+$/, '');
}

/* ───────── PDF (pdf.js) ───────── */
let pdfjs = null;
async function pdf(buf) {
  if (!pdfjs) {
    const dir = path.join(__dirname, 'vendor', 'pdfjs');
    pdfjs = await import(pathToFileURL(path.join(dir, 'pdf.min.mjs')).href);
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(dir, 'pdf.worker.min.mjs')).href;
    pdfjs.__cmaps = pathToFileURL(path.join(dir, 'cmaps')).href + '/';
  }
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    cMapUrl: pdfjs.__cmaps,
    cMapPacked: true,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const out = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, 15); p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      let line = '';
      let lastY = null;
      for (const it of tc.items) {
        if (!('str' in it)) continue;
        const y = Math.round(it.transform[5]);
        if (lastY !== null && Math.abs(y - lastY) > 2) {
          out.push(line);
          line = '';
        }
        line += it.str + (it.hasEOL ? '\n' : '');
        lastY = y;
      }
      if (line) out.push(line);
      out.push('');
      if (out.join('\n').length > MAX) break;
    }
  } finally {
    doc.destroy();
  }
  return out.join('\n');
}

const tidy = (t) =>
  String(t || '')
    .replace(/\r/g, '')
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX);

/** 파일 → 글자 (지원 안 하면 '') */
async function extractText(file) {
  const ext = path.extname(file).toLowerCase();
  const buf = fs.readFileSync(file);
  if (ext === '.pdf') return tidy(await pdf(buf));
  if (ext === '.docx') return tidy(docx(buf));
  if (ext === '.hwpx') return tidy(hwpx(buf));
  if (ext === '.hwp') return tidy(hwp(buf));
  if (ext === '.txt') return tidy(buf.toString('utf8'));
  return '';
}
const SUPPORTED = /\.(pdf|docx|hwpx|hwp|txt)$/i;

module.exports = { extractText, SUPPORTED };
