// 회사 시스템에서 받은 "엑셀" 파일 읽기: xlsx / xlsm, csv, 웹 화면에서 내려받은 html 형식 .xls
// → [{ name, rows: [[셀 값...]] }]
const fs = require('fs');
const path = require('path');
const { readXlsx } = require('./xlsx');

const ent = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&');
const cellVal = (s) => {
  const t = s.trim();
  if (t === '') return null;
  const n = t.replace(/,/g, '');
  return /^-?\d+(\.\d+)?$/.test(n) && !/^0\d/.test(n) ? Number(n) : t;
};

function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  const u = buf.toString('utf8');
  if (!u.includes('�')) return u;
  try {
    return new TextDecoder('euc-kr').decode(buf); // 한글 윈도우에서 만든 csv
  } catch {
    return u;
  }
}

function readHtmlTables(text) {
  const out = [];
  let n = 0;
  text.replace(/<table\b[\s\S]*?<\/table>/gi, (tb) => {
    const rows = [];
    tb.replace(/<tr\b[\s\S]*?<\/tr>/gi, (tr) => {
      const row = [];
      tr.replace(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi, (_, a, inner) => {
        row.push(cellVal(ent(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))));
        const span = +((a.match(/colspan="?(\d+)/i) || [])[1] || 1);
        for (let i = 1; i < span; i++) row.push(null);
        return '';
      });
      rows.push(row);
      return '';
    });
    out.push({ name: `표${++n}`, rows });
    return '';
  });
  return out;
}

function readCsv(text) {
  const sep = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) row.push(cellVal(cur)), (cur = '');
    else if (ch === '\n') row.push(cellVal(cur.replace(/\r$/, ''))), rows.push(row), (row = []), (cur = '');
    else cur += ch;
  }
  if (cur || row.length) row.push(cellVal(cur)), rows.push(row);
  return [{ name: 'csv', rows }];
}

function readSheetFile(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0x50 && buf[1] === 0x4b) return readXlsx(buf);
  if (buf.readUInt32BE(0) === 0xd0cf11e0)
    throw new Error('옛 엑셀 형식(.xls)이라 읽을 수 없습니다. 엑셀에서 열어 "다른 이름으로 저장 → Excel 통합 문서(.xlsx)"로 저장한 뒤 올려 주세요.');
  const text = decodeText(buf);
  if (/<table\b/i.test(text)) return readHtmlTables(text);
  if (/\.(csv|txt)$/i.test(file) || /[,\t]/.test(text.slice(0, 2000))) return readCsv(text);
  throw new Error('엑셀 파일이 아닙니다.');
}

module.exports = { readSheetFile, readHtmlTables, readCsv, base: (f) => path.basename(f) };
