// 최소 기능 xlsx 읽기 (외부 라이브러리 없이): 시트별 셀 값을 2차원 배열로 돌려준다.
const zlib = require('zlib');

function unzip(buf) {
  // 중앙 디렉터리(End of central directory)에서 파일 목록 읽기
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('엑셀(xlsx) 파일이 아닙니다.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + csize);
    files[name] = { method, data };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return (name) => {
    const f = files[name];
    if (!f) return null;
    return (f.method === 8 ? zlib.inflateRawSync(f.data) : f.data).toString('utf8');
  };
}

const decode = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, d) => String.fromCodePoint(parseInt(d, 16)))
    .replace(/&amp;/g, '&');

function textOf(xml) {
  // <t> 여러 개(서식 있는 문자열)를 이어 붙임. 윗첨자 발음(rPh)은 제외
  const noPh = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  noPh.replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (_, t) => {
    out += decode(t);
    return '';
  });
  return out;
}

function colIndex(ref) {
  const m = ref.match(/^([A-Z]+)(\d+)$/);
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { c: c - 1, r: +m[2] - 1 };
}

function readXlsx(buf) {
  const get = unzip(buf);
  const wb = get('xl/workbook.xml');
  if (!wb) throw new Error('엑셀(xlsx) 파일이 아닙니다.');
  const rels = get('xl/_rels/workbook.xml.rels') || '';
  const relMap = {};
  rels.replace(/<Relationship\b([^>]*)\/?>/g, (_, a) => {
    const id = (a.match(/\bId="([^"]+)"/) || [])[1];
    const target = (a.match(/\bTarget="([^"]+)"/) || [])[1];
    if (id && target) relMap[id] = target.replace(/^\/?xl\//, '').replace(/^\//, '');
    return '';
  });
  const ss = [];
  const sst = get('xl/sharedStrings.xml');
  if (sst) sst.replace(/<si>([\s\S]*?)<\/si>/g, (_, x) => ss.push(textOf(x)));

  const sheets = [];
  wb.replace(/<sheet\b([^>]*)\/?>/g, (_, a) => {
    const name = decode((a.match(/\bname="([^"]*)"/) || [])[1] || '');
    const rid = (a.match(/\br:id="([^"]+)"/) || [])[1];
    const state = (a.match(/\bstate="([^"]+)"/) || [])[1];
    sheets.push({ name, path: `xl/${relMap[rid] || ''}`, hidden: !!state && state !== 'visible' });
    return '';
  });

  return sheets.map((s) => {
    const xml = get(s.path) || '';
    const rows = [];
    xml.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (_, attrs, inner = '') => {
      const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
      if (!ref) return '';
      const t = (attrs.match(/\bt="([^"]+)"/) || [])[1];
      let v = null;
      if (t === 'inlineStr') v = textOf(inner);
      else {
        const raw = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (raw !== undefined) {
          if (t === 's') v = ss[+raw] ?? '';
          else if (t === 'str' || t === 'e') v = decode(raw);
          else if (t === 'b') v = raw === '1';
          else v = Number(raw);
        }
      }
      if (v === null) return '';
      const { c, r } = colIndex(ref);
      (rows[r] ||= [])[c] = v;
      return '';
    });
    return { name: s.name, hidden: s.hidden, rows };
  });
}

module.exports = { readXlsx };
