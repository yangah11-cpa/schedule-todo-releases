const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, globalShortcut, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { GoogleCalendar } = require('./google');
const { PushHub } = require('./pushhub');

app.setAppUserModelId('com.yangah.scheduletodo');
app.commandLine.appendSwitch('lang', 'ko-KR');

// 한 번에 하나만 실행. "변경사항 적용"으로 다시 시작할 때는 이전 창이 완전히 닫힐 때까지 잠깐 기다림
let gotLock = app.requestSingleInstanceLock();
if (!gotLock && process.argv.includes('--relaunch')) {
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 30 && !gotLock; i++) {
    Atomics.wait(sleep, 0, 0, 200);
    gotLock = app.requestSingleInstanceLock();
  }
}
if (!gotLock) app.quit();

const dataDir = app.getPath('userData');
const dataFile = path.join(dataDir, 'data.json');
const stateFile = path.join(dataDir, 'window.json');
const prefsFile = path.join(dataDir, 'app-prefs.json');
let win;
let google;
let pushHub;
let tray = null;
let quitting = false;
const startHidden = process.argv.includes('--hidden');

/* ───────────── 시작·트레이 설정 ───────────── */
const DEFAULT_PREFS = { autoStart: true, closeToTray: true, initialized: false };
function loadPrefs() {
  return { ...DEFAULT_PREFS, ...readJson(prefsFile, {}) };
}
function savePrefs(p) {
  try {
    fs.writeFileSync(prefsFile, JSON.stringify(p, null, 1));
  } catch {
    /* 무시 */
  }
}
function applyAutoStart(on) {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath, args: ['--hidden'] });
  } catch {
    /* 무시 */
  }
}
function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function createTray() {
  if (tray) return;
  const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('일정 & 할일');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '열기', click: showWindow },
      { type: 'separator' },
      {
        label: '종료',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, file.replace(/\.json$/, '.bak.json'));
    } catch {
      /* 백업 실패는 무시 */
    }
  }
  fs.renameSync(tmp, file);
}

function loadData() {
  let d = readJson(dataFile, null);
  if (!d) d = readJson(dataFile.replace(/\.json$/, '.bak.json'), null);
  return d || { version: 1, events: [], todos: [], settings: {} };
}

function createWindow() {
  const st = readJson(stateFile, { width: 1440, height: 900 });
  win = new BrowserWindow({
    width: st.width || 1440,
    height: st.height || 900,
    x: st.x,
    y: st.y,
    minWidth: 960,
    minHeight: 620,
    title: '일정 & 할일',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#F3F2EE',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // 창이 숨겨져 있어도 알림 확인이 늦어지지 않게
    },
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => {
    if (!startHidden) win.show(); // Windows 시작 시 자동 실행이면 트레이에서 조용히 시작
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });

  const saveState = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getNormalBounds();
    fs.writeFileSync(stateFile, JSON.stringify({ ...b, maximized: win.isMaximized() }));
  };
  win.on('close', (e) => {
    saveState();
    if (!quitting && loadPrefs().closeToTray) {
      e.preventDefault();
      win.hide();
      if (!global.__trayHinted && tray) {
        global.__trayHinted = true;
        try {
          tray.displayBalloon({ title: '일정 & 할일', content: '트레이에서 계속 실행 중입니다. 알림을 받을 수 있습니다.' });
        } catch {
          /* 무시 */
        }
      }
    }
  });
}

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('before-quit', () => {
  quitting = true;
});

app.on('second-instance', () => showWindow());

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const prefs = loadPrefs();
  if (!prefs.initialized) {
    // 처음 실행: Windows 시작 시 자동 실행 켜기
    applyAutoStart(prefs.autoStart);
    savePrefs({ ...prefs, initialized: true });
  }
  createTray();
  ipcMain.handle('app:focus', () => showWindow());
  ipcMain.handle('prefs:get', () => loadPrefs());
  ipcMain.handle('prefs:set', (_e, patch) => {
    const p = { ...loadPrefs(), ...(patch || {}) };
    savePrefs(p);
    if ('autoStart' in (patch || {})) applyAutoStart(p.autoStart);
    return p;
  });
  google = new GoogleCalendar(dataDir);
  pushHub = new PushHub(google, dataDir);

  ipcMain.handle('data:load', () => loadData());
  ipcMain.handle('data:save', (_e, d) => {
    writeJsonAtomic(dataFile, d);
    return true;
  });
  ipcMain.handle('data:export', async (_e, d) => {
    const r = await dialog.showSaveDialog(win, {
      title: '데이터 내보내기',
      defaultPath: `일정할일_백업_${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return false;
    fs.writeFileSync(r.filePath, JSON.stringify(d, null, 1), 'utf8');
    return true;
  });
  ipcMain.handle('data:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '데이터 가져오기',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const d = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    if (!Array.isArray(d.events) || !Array.isArray(d.todos)) throw new Error('이 프로그램의 백업 파일이 아닙니다.');
    return d;
  });
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('app:version', () => appInfo().version);
  ipcMain.handle('app:info', () => appInfo());

  const wrap = (fn) => async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code || null, status: err.status || null };
    }
  };
  ipcMain.handle('g:status', wrap(() => google.status()));
  ipcMain.handle('g:setClient', wrap((id, secret) => google.setClient(id, secret)));
  ipcMain.handle(
    'g:connect',
    wrap(async () => {
      const s = await google.connect();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
      return s;
    })
  );
  ipcMain.handle('g:disconnect', wrap(() => google.disconnect()));
  ipcMain.handle('g:calendars', wrap(() => google.listCalendars()));
  ipcMain.handle('g:events', wrap((cal, a, b) => google.listEvents(cal, a, b)));
  ipcMain.handle('g:get', wrap((cal, id) => google.getEvent(cal, id)));
  ipcMain.handle('g:insert', wrap((cal, ev) => google.insertEvent(cal, ev)));
  ipcMain.handle('g:patch', wrap((cal, id, ev) => google.patchEvent(cal, id, ev)));
  ipcMain.handle('g:delete', wrap((cal, id) => google.deleteEvent(cal, id)));
  ipcMain.handle('t:list', wrap((list) => google.listTasks(list)));
  ipcMain.handle('t:insert', wrap((list, task, parent, prev) => google.insertTask(list, task, parent, prev)));
  ipcMain.handle('t:patch', wrap((list, id, task) => google.patchTask(list, id, task)));
  ipcMain.handle('t:delete', wrap((list, id) => google.deleteTask(list, id)));
  ipcMain.handle('push:init', wrap(() => pushHub.init()));
  ipcMain.handle(
    'team:open',
    wrap(async () => {
      const r = process.env.ST_TEAM_FILE // 개발용 테스트 경로
        ? { canceled: false, filePaths: [process.env.ST_TEAM_FILE] }
        : await dialog.showOpenDialog(win, {
        title: '팀 일정표 엑셀 선택',
        filters: [{ name: '엑셀', extensions: ['xlsx', 'xlsm'] }],
        properties: ['openFile'],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      const { readXlsx } = require('./xlsx');
      return { fileName: path.basename(r.filePaths[0]), sheets: readXlsx(fs.readFileSync(r.filePaths[0])) };
    })
  );
  ipcMain.handle('push:notify', wrap((msg) => pushHub.notify(msg)));
  ipcMain.handle('drive:save', wrap((name, text) => google.saveAppFile(name, text)));
  ipcMain.handle('drive:load', wrap((name) => google.loadAppFile(name)));
  ipcMain.handle('outlook:read', wrap((opt) => require('./outlook').readInbox(opt || {})));
  ipcMain.handle('outlook:selected', wrap(() => require('./outlook').readSelected()));
  ipcMain.handle('outlook:open', wrap((id) => require('./outlook').openItem(id)));
  ipcMain.handle('phone:messages', wrap((opt) => require('./phonelink').readMessages(opt || {})));
  ipcMain.handle('phone:thread', wrap((opt) => require('./phonelink').readThread(opt || {})));
  ipcMain.handle('phone:contacts', wrap((nums) => require('./phonelink').lookupContacts(nums || [])));
  // 통화 녹음 → 글 (PC 안에서)
  const calls = require('./calls');
  calls.init(app.getPath('userData'));
  ipcMain.handle('calls:list', wrap((opt) => calls.list(opt || {})));
  ipcMain.handle('calls:status', wrap((opt) => calls.status(opt || {})));
  ipcMain.handle(
    'calls:install',
    wrap((opt) => calls.install(opt || {}, (p) => win && !win.isDestroyed() && win.webContents.send('calls:progress', p)))
  );
  ipcMain.handle('calls:audio', wrap((file) => calls.readAudio(file)));
  ipcMain.handle('calls:transcribe', wrap((opt) => calls.transcribe(opt || {})));
  ipcMain.handle('calls:setMe', wrap((opt) => calls.setMe(opt || {})));
  // AI 요약 (켰을 때만)
  const ai = require('./ai');
  ai.init(app.getPath('userData'));
  ipcMain.handle('ai:status', wrap(() => ai.status()));
  ipcMain.handle('ai:setKey', wrap((k) => ai.setKey(k)));
  ipcMain.handle('ai:summarize', wrap((o) => ai.summarize(o || {})));
  ipcMain.handle('calls:openFile', wrap((file) => shell.openPath(file)));
  ipcMain.handle(
    'calls:pickDir',
    wrap(async () => {
      const r = await dialog.showOpenDialog(win, { title: '통화 녹음 폴더 선택', defaultPath: calls.defaultDir(), properties: ['openDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    })
  );
  // Outlook에서 메일을 고른 채 Ctrl+Shift+E → 이 프로그램이 앞으로 나와 그 메일로 일정/할 일 만들기
  try {
    let hotBusy = false;
    const ok = globalShortcut.register('CommandOrControl+Shift+E', async () => {
      if (!win || win.isDestroyed() || hotBusy) return;
      hotBusy = true;
      try {
        // 누른 순간 앞에 있던 프로그램: Outlook → 선택한 메일, 그 밖 → 선택한 글(자동 복사), 선택이 없으면 복사해 둔 글
        const before = clipboard.readText();
        const r = await require('./foreground').foregroundApp({ copy: true });
        const fg = r.name;
        const isOutlook = /^outlook$/i.test(fg);
        const text = isOutlook ? '' : clipboard.readText();
        // 자동 복사로 바뀐 클립보드는 원래대로 돌려놓음 (사용자가 복사해 둔 것 보존)
        if (r.copied && before && text !== before) setTimeout(() => clipboard.writeText(before), 300);
        win.setAlwaysOnTop(true); // 다른 창 위로 확실히 올리기
        showWindow();
        setTimeout(() => !win.isDestroyed() && win.setAlwaysOnTop(false), 400);
        if (isOutlook) win.webContents.send('outlook:pick');
        else win.webContents.send('clip:pick', { text, app: fg, copied: r.copied && text !== before });
      } finally {
        hotBusy = false;
      }
    });
    if (!ok) console.warn('단축키 Ctrl+Shift+E를 다른 프로그램이 쓰고 있습니다.');
  } catch {
    /* 무시 */
  }

  createWindow();
  setupAutoUpdate();
  watchPatch();
});

/* ───────────── 즉시 적용 패치 감시 ───────────── */
function appInfo() {
  const i = global.__appInfo || { source: 'bundled', version: app.getVersion(), bundledVersion: app.getVersion(), patchDir: null };
  return { ...i, relaunched: process.argv.includes('--relaunch') };
}
try {
  const pe = global.__appInfo?.patchError;
  if (pe) fs.appendFileSync(path.join(app.getPath('userData'), 'patch-error.log'), `${new Date().toISOString()} ${pe}\n`);
} catch {
  /* 무시 */
}
let patchReady = null;
function watchPatch() {
  const info = appInfo();
  ipcMain.handle('patch:state', () => patchReady);
  ipcMain.handle('patch:apply', () => {
    // 다시 시작할 때는 창이 보이도록 --hidden 제외, 새 프로세스가 잠금을 기다리도록 --relaunch 표시
    const args = process.argv.slice(1).filter((a) => a !== '--hidden' && a !== '--relaunch');
    app.relaunch({ args: [...args, '--relaunch'] });
    quitting = true;
    try {
      app.releaseSingleInstanceLock();
    } catch {
      /* 무시 */
    }
    try {
      tray?.destroy();
    } catch {
      /* 무시 */
    }
    app.exit(0);
  });
  if (!info.patchDir) return;
  const newer = global.__patchNewer || ((a, b) => a !== b);
  const pkg = path.join(info.patchDir, 'package.json');
  const check = () => {
    try {
      const v = JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
      // 필수 파일이 모두 있을 때만 "변경사항 적용"을 띄움 (파일을 넣는 중이거나 빠진 경우 대기)
      const core = ['main.js', 'google.js', 'preload.js', 'pushhub.js', 'renderer/index.html', 'renderer/app.js', 'renderer/styles.css'];
      const complete = core.every((f) => fs.existsSync(path.join(info.patchDir, 'src', f)));
      if (v && newer(v, info.version) && complete && patchReady !== v) {
        patchReady = v;
        if (win && !win.isDestroyed()) win.webContents.send('patch:ready', v);
      }
    } catch {
      /* 패치 없음 */
    }
  };
  setInterval(check, 5000);
  check();
}

/* ───────────── 자동 업데이트 (GitHub 릴리스) ───────────── */
let updateState = { status: 'idle', version: null, error: null };
function sendUpdate() {
  if (win && !win.isDestroyed()) win.webContents.send('update:state', updateState);
}
function setupAutoUpdate() {
  ipcMain.handle('update:state', () => updateState);
  if (!app.isPackaged) {
    updateState = { status: 'dev', version: null, error: null };
    ipcMain.handle('update:check', () => updateState);
    ipcMain.handle('update:install', () => false);
    return;
  }
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    updateState = { status: 'error', version: null, error: `업데이트 모듈 로드 실패: ${e.message}` };
    ipcMain.handle('update:check', () => updateState);
    ipcMain.handle('update:install', () => false);
    return;
  }
  autoUpdater.autoDownload = false; // 즉시 적용 패치보다 새 버전일 때만 내려받음
  autoUpdater.autoInstallOnAppQuit = true; // 받아 둔 업데이트는 프로그램을 닫을 때 자동 설치
  autoUpdater.on('checking-for-update', () => {
    updateState = { ...updateState, status: 'checking', error: null };
    sendUpdate();
  });
  autoUpdater.on('update-available', (i) => {
    const newer = global.__patchNewer || ((a, b) => a !== b);
    if (!newer(i.version, appInfo().version)) {
      updateState = { status: 'latest', version: appInfo().version, error: null };
      sendUpdate();
      return;
    }
    updateState = { status: 'downloading', version: i.version, error: null };
    sendUpdate();
    autoUpdater.downloadUpdate().catch(() => {});
  });
  autoUpdater.on('update-not-available', () => {
    updateState = { status: 'latest', version: appInfo().version, error: null };
    sendUpdate();
  });
  autoUpdater.on('update-downloaded', (i) => {
    const newer = global.__patchNewer || ((a, b) => a !== b);
    if (!newer(i.version, appInfo().version)) {
      // 이미 같은(또는 더 새) 버전이 즉시 적용으로 실행 중 → 설치하지 않음
      autoUpdater.autoInstallOnAppQuit = false;
      updateState = { status: 'latest', version: appInfo().version, error: null };
    } else {
      autoUpdater.autoInstallOnAppQuit = true;
      updateState = { status: 'ready', version: i.version, error: null };
    }
    sendUpdate();
  });
  autoUpdater.on('error', (e) => {
    updateState = { ...updateState, status: 'error', error: e?.message || String(e) };
    sendUpdate();
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  ipcMain.handle('update:check', async () => {
    await check();
    return updateState;
  });
  ipcMain.handle('update:install', () => {
    const newer = global.__patchNewer || ((a, b) => a !== b);
    if (updateState.status !== 'ready' || !newer(updateState.version, appInfo().version)) return false;
    quitting = true;
    setImmediate(() => autoUpdater.quitAndInstall(true, true)); // 조용히 설치 후 다시 실행
    return true;
  });
  setTimeout(check, 8000);
  setInterval(check, 4 * 3600 * 1000);
}

app.on('window-all-closed', () => {
  if (quitting || !loadPrefs().closeToTray) app.quit();
});
