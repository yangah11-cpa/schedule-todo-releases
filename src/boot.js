// 시작 로더: 설치본(app.asar)보다 새 버전의 "즉시 적용 패치"가 있으면 그것을 실행한다.
// 패치 위치: %APPDATA%\일정할일\patch\  (package.json + src\...)
// 설치 파일 없이 이 폴더의 파일만 바꿔서 변경사항을 바로 적용하기 위한 구조.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const bundledVersion = app.getVersion();
const patchDir = path.join(app.getPath('userData'), 'patch');

function newer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

function readPatchVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(patchDir, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

try {
  fs.mkdirSync(patchDir, { recursive: true });
} catch {
  /* 무시 */
}

const info = { source: 'bundled', version: bundledVersion, bundledVersion, patchDir, patchError: null };
const pv = readPatchVersion();
let entry = path.join(__dirname, 'main.js');

if (pv && newer(pv, bundledVersion) && fs.existsSync(path.join(patchDir, 'src', 'main.js'))) {
  // 패치 코드가 설치본의 node_modules(electron-updater 등)를 찾을 수 있게
  const nm = path.join(app.getAppPath(), 'node_modules');
  process.env.NODE_PATH = [nm, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  Module._initPaths();
  entry = path.join(patchDir, 'src', 'main.js');
  Object.assign(info, { source: 'patch', version: pv });
} else if (pv && !newer(pv, bundledVersion)) {
  // 설치본이 패치보다 같거나 새 버전이면 오래된 패치 정리
  try {
    fs.rmSync(path.join(patchDir, 'src'), { recursive: true, force: true });
    fs.rmSync(path.join(patchDir, 'package.json'), { force: true });
  } catch {
    /* 무시 */
  }
}

global.__appInfo = info;
global.__patchNewer = newer;

try {
  require(entry);
} catch (e) {
  if (info.source !== 'patch') throw e;
  // 패치 실행 실패 → 설치본으로 실행
  console.error('patch load failed', e);
  global.__appInfo = { ...info, source: 'bundled', version: bundledVersion, patchError: String(e && e.message ? e.message : e) };
  require(path.join(__dirname, 'main.js'));
}
