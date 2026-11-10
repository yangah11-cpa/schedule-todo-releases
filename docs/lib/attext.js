// 첨부 파일에서 글자만 뽑는다 (브라우저용: PDF · Word · 한글 HWP/HWPX · 텍스트). 모두 휴대폰 안에서 처리.
const MAX = 12000;

async function inflateRaw(u8) {
  const ds = new DecompressionStream('deflate-raw');
  const out = new Response(new Blob([u8]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}
const utf8 = (u8) => new TextDecoder('utf-8').decode(u8);

/* ───────── zip (docx, hwpx) ───────── */
function unzipEntries(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip 아님');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = {};
  for (let k = 0; k < n; k++) {
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true);
    const xl = dv.getUint16(p + 30, true);
    const cl = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = utf8(u8.subarray(p + 46, p + 46 + nl));
    const ds = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    const raw = u8.subarray(ds, ds + csize);
    out[name] = () => (method === 8 ? inflateRaw(raw) : Promise.resolve(raw));
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

async function docx(u8) {
  const z = unzipEntries(u8);
  const doc = z['word/document.xml'];
  return doc ? xmlText(utf8(await doc()), 'w:p') : '';
}
async function hwpx(u8) {
  const z = unzipEntries(u8);
  const names = Object.keys(z)
    .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  const parts = [];
  for (const n of names) parts.push(xmlText(utf8(await z[n]()), 'hp:p'));
  return parts.join('\n');
}

/* ───────── 한글 HWP 5 (OLE 복합 문서) ───────── */
const cat = (arrs) => {
  const len = arrs.reduce((a, b) => a + b.length, 0);
  const o = new Uint8Array(len);
  let p = 0;
  for (const a of arrs) {
    o.set(a, p);
    p += a.length;
  }
  return o;
};
function cfb(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const U32 = (o) => dv.getUint32(o, true);
  if (U32(0) !== 0xe011cfd0) throw new Error('HWP 형식 아님');
  const ss = 1 << dv.getUint16(30, true);
  const mss = 1 << dv.getUint16(32, true);
  const nFat = U32(44);
  const dirStart = U32(48);
  const miniCut = U32(56);
  const mfatStart = U32(60);
  let difStart = U32(68);
  const sec = (i) => 512 + i * ss;
  const difat = [];
  for (let i = 0; i < 109; i++) difat.push(U32(76 + i * 4));
  while (difStart < 0xfffffffa && difat.length < nFat + 200) {
    const o = sec(difStart);
    for (let i = 0; i < ss / 4 - 1; i++) difat.push(U32(o + i * 4));
    difStart = U32(o + ss - 4);
  }
  const fat = [];
  for (let i = 0; i < nFat; i++) {
    const o = sec(difat[i]);
    for (let j = 0; j < ss / 4; j++) fat.push(U32(o + j * 4));
  }
  const chain = (start, table) => {
    const out = [];
    for (let s = start, g = 0; s < 0xfffffffa && g < 1e6; s = table[s], g++) out.push(s);
    return out;
  };
  const readBig = (start, size) => cat(chain(start, fat).map((s) => u8.subarray(sec(s), sec(s) + ss))).subarray(0, size);
  const dirBuf = readBig(dirStart, Infinity);
  const dd = new DataView(dirBuf.buffer, dirBuf.byteOffset, dirBuf.byteLength);
  const ents = [];
  for (let o = 0; o + 128 <= dirBuf.length; o += 128) {
    const nl = dd.getUint16(o + 64, true);
    ents.push({
      name: new TextDecoder('utf-16le').decode(dirBuf.subarray(o, o + Math.max(0, nl - 2))),
      left: dd.getUint32(o + 68, true),
      right: dd.getUint32(o + 72, true),
      child: dd.getUint32(o + 76, true),
      start: dd.getUint32(o + 116, true),
      size: dd.getUint32(o + 120, true),
    });
  }
  const root = ents[0];
  const ministream = readBig(root.start, root.size);
  const mfat = [];
  if (mfatStart < 0xfffffffa) for (const s of chain(mfatStart, fat)) for (let j = 0; j < ss / 4; j++) mfat.push(U32(sec(s) + j * 4));
  const readEnt = (e) =>
    e.size < miniCut ? cat(chain(e.start, mfat).map((s) => ministream.subarray(s * mss, s * mss + mss))).subarray(0, e.size) : readBig(e.start, e.size);
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
function paraText(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let s = '';
  for (let i = 0; i + 1 < b.length; ) {
    const c = dv.getUint16(i, true);
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
async function hwp(u8) {
  const f = cfb(u8);
  const fh = f.find('FileHeader');
  if (!fh) throw new Error('HWP 머리글 없음');
  const fhb = f.readEnt(fh);
  const props = new DataView(fhb.buffer, fhb.byteOffset, fhb.byteLength).getUint32(36, true);
  if (props & 2) return '';
  const compressed = !!(props & 1);
  const sections = f
    .children('BodyText')
    .filter((e) => /^Section\d+$/.test(e.name))
    .sort((a, b) => parseInt(a.name.slice(7), 10) - parseInt(b.name.slice(7), 10));
  const parts = [];
  for (const s of sections) {
    let data = f.readEnt(s);
    if (compressed) data = await inflateRaw(data);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let o = 0; o + 4 <= data.length; ) {
      const hdr = dv.getUint32(o, true);
      const tag = hdr & 0x3ff;
      let size = hdr >>> 20;
      o += 4;
      if (size === 0xfff) {
        size = dv.getUint32(o, true);
        o += 4;
      }
      if (tag === 67) parts.push(paraText(data.subarray(o, o + size)));
      o += size;
    }
  }
  return parts.join('\n');
}

/* ───────── PDF (pdf.js) ───────── */
let pdfjs = null;
async function pdf(u8) {
  const base = new URL('../vendor/pdfjs/', import.meta.url).href;
  if (!pdfjs) {
    pdfjs = await import(`${base}pdf.min.mjs`);
    pdfjs.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
  }
  const doc = await pdfjs.getDocument({ data: u8, cMapUrl: `${base}cmaps/`, cMapPacked: true, isEvalSupported: false, verbosity: 0 }).promise;
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

export const SUPPORTED = /\.(pdf|docx|hwpx|hwp|txt)$/i;

/** 파일 이름 + 바이트 → 글자 (지원 안 하면 '') */
export async function extractText(name, u8) {
  const ext = (String(name).match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (ext === '.pdf') return tidy(await pdf(u8));
  if (ext === '.docx') return tidy(await docx(u8));
  if (ext === '.hwpx') return tidy(await hwpx(u8));
  if (ext === '.hwp') return tidy(await hwp(u8));
  if (ext === '.txt') return tidy(utf8(u8));
  return '';
}
