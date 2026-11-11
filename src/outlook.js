// PC에 설치된 (클래식) Outlook의 받은 편지함을 읽는다.
// PowerShell로 Outlook COM을 호출하고, 결과는 임시 파일(UTF-8 JSON)로 받는다.
// 메일 내용은 이 PC 안에서만 처리하며 외부로 보내지 않는다.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function script(outPath, { days, max, start, skipPath, attDir, selected = false }) {
  const esc = (s) => s.replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
$out = '${esc(outPath)}'
function Done($obj) { [IO.File]::WriteAllText($out, (ConvertTo-Json -InputObject $obj -Depth 4 -Compress), (New-Object Text.UTF8Encoding $false)) }
$skip = @{}
try { foreach ($i in ((Get-Content -Raw -Encoding UTF8 '${esc(skipPath)}') | ConvertFrom-Json)) { $skip[[string]$i] = 1 } } catch {}
$attDir = '${esc(attDir)}'
$ol = $null
try { $ol = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') } catch {}
if (-not $ol) {
  if (-not $${start ? 'true' : 'false'}) { Done @{ ok = $false; code = 'notRunning' }; exit }
  try { $ol = New-Object -ComObject Outlook.Application } catch { Done @{ ok = $false; code = 'noOutlook'; error = $_.Exception.Message }; exit }
}
try {
  $sel = $${selected ? 'true' : 'false'}
  $since = (Get-Date).Date.AddDays(-${days})
  if ($sel) {
    # 지금 Outlook에서 열어 둔 메일, 없으면 목록에서 선택한 첫 메일
    $items = @()
    try { $w = $ol.ActiveWindow(); if ($w -and [int]$w.Class -eq 35) { $items = @($w.CurrentItem) } } catch {}
    if ($items.Count -eq 0) { try { $s = $ol.ActiveExplorer().Selection; if ($s.Count -ge 1) { $items = @($s.Item(1)) } } catch {} }
    if ($items.Count -eq 0) { Done @{ ok = $false; code = 'noSelection' }; exit }
  } else {
    $ns = $ol.GetNamespace('MAPI')
  }
  $list = New-Object System.Collections.ArrayList
  function Read-One($m) {
    try {
      $cls = [int]$m.Class
      if ($cls -ne 43 -and $cls -ne 53) { return }
      $body = [string]$m.Body
      if ($body.Length -gt 6000) { $body = $body.Substring(0, 6000) }
      $o = [ordered]@{
        id = [string]$m.EntryID
        subject = [string]$m.Subject
        from = [string]$m.SenderName
        fromAddr = $(try { if ([string]$m.SenderEmailType -eq 'EX') { [string]$m.Sender.GetExchangeUser().PrimarySmtpAddress } else { [string]$m.SenderEmailAddress } } catch { '' })
        internal = $(try { [string]$m.SenderEmailType -eq 'EX' } catch { $false })
        atts = @($(try { foreach ($a in $m.Attachments) { [string]$a.FileName } } catch {}) | Where-Object { $_ -and $_ -notmatch '^image\\d+\\.(png|jpe?g|gif)$' })
        received = $(try { $m.ReceivedTime.ToString('yyyy-MM-ddTHH:mm:ss') } catch { (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss') })
        unread = [bool]$m.UnRead
        body = $body
      }
      # 첨부 파일(PDF·Word·한글·텍스트)은 임시 폴더에 저장 → 글자만 뽑고 바로 지움. 이미 읽은 메일은 건너뜀
      $files = New-Object System.Collections.ArrayList
      if (-not $skip.ContainsKey($o.id)) {
        $k = 0
        foreach ($a in $m.Attachments) {
          try {
            $fn = [string]$a.FileName
            if ($fn -match '\\.(pdf|docx|hwpx|hwp|txt)$' -and $a.Size -lt 15MB -and $k -lt 5) {
              $k++
              $d = Join-Path $attDir ('{0}_{1}' -f $list.Count, $k)
              New-Item -ItemType Directory -Force -Path $d | Out-Null
              $fp = Join-Path $d $fn
              $a.SaveAsFile($fp)
              [void]$files.Add([ordered]@{ name = $fn; path = $fp })
            }
          } catch {}
        }
      }
      $o.attFiles = @($files)
      if ($cls -eq 53) {
        $a = $m.GetAssociatedAppointment($false)
        if ($a) {
          $o.meeting = [ordered]@{
            start = $a.Start.ToString('yyyy-MM-ddTHH:mm:ss')
            end = $a.End.ToString('yyyy-MM-ddTHH:mm:ss')
            allDay = [bool]$a.AllDayEvent
            location = [string]$a.Location
          }
        }
      }
      [void]$list.Add($o)
    } catch { $script:readErr = $_.Exception.Message }
  }
  $diag = New-Object System.Collections.ArrayList
  if ($sel) {
    foreach ($m in $items) { Read-One $m }
  } else {
    # 모든 계정(데이터 파일)의 받은 편지함 — 기본 데이터 파일이 비어 있고 회사 메일은 다른 계정에 있는 경우가 많음
    $inboxes = New-Object System.Collections.ArrayList
    foreach ($st in $ns.Stores) {
      try { $f = $st.GetDefaultFolder(6); if ($f) { [void]$inboxes.Add(@{ store = [string]$st.DisplayName; folder = $f }) } } catch {}
    }
    if ($inboxes.Count -eq 0) { try { [void]$inboxes.Add(@{ store = 'default'; folder = $ns.GetDefaultFolder(6) }) } catch {} }
    foreach ($ib in $inboxes) {
      $before = $list.Count
      $items = $ib.folder.Items
      $total = $(try { $items.Count } catch { -1 })
      # 기간 안의 메일만 골라서(Restrict) 최신순으로 GetFirst/GetNext — foreach는 정렬을 무시할 수 있음
      $r = $null
      $rerr = ''
      try { $r = $items.Restrict("@SQL=""urn:schemas:httpmail:datereceived"" >= '" + $since.ToUniversalTime().ToString('yyyy-MM-dd HH:mm') + "'") } catch { $rerr = $_.Exception.Message }
      if ($r) { $items = $r }
      try { $items.Sort('[ReceivedTime]', $true) } catch {}
      $m = $items.GetFirst()
      $n = 0
      $skipOld = 0
      while ($m -ne $null -and $list.Count -lt ${max} -and $n -lt 3000) {
        $n++
        $old = $false
        try { if ($m.ReceivedTime -lt $since) { $old = $true } } catch {}
        if ($old) { $skipOld++ } else { Read-One $m }
        $m = $items.GetNext()
      }
      [void]$diag.Add([ordered]@{ store = $ib.store; total = $total; restricted = $(if ($r) { $(try { $r.Count } catch { -1 }) } else { -1 }); restrictError = $rerr; scanned = $n; old = $skipOld; added = $list.Count - $before })
    }
  }
  if ($sel -and $list.Count -eq 0) { Done @{ ok = $false; code = 'notMail' }; exit }
  Done @{ ok = $true; mails = @($list); diag = @($diag); readErr = [string]$script:readErr }
} catch {
  Done @{ ok = $false; code = 'error'; error = $_.Exception.Message }
}
`;
}

/**
 * 받은 편지함 최근 메일 읽기
 * @param {{days?:number, max?:number, start?:boolean}} opt start=true면 Outlook이 꺼져 있을 때 실행해서 읽는다
 */
// 첨부 파일 글자는 프로그램이 켜져 있는 동안만 기억 (파일로 저장하지 않음)
const attCache = new Map();

async function readInbox(opt = {}) {
  const r = await readRaw(opt);
  if (!r?.ok) {
    try {
      const { app } = require('electron');
      fs.writeFileSync(path.join(app.getPath('userData'), 'outlook-diag.json'), JSON.stringify({ at: new Date().toISOString(), opt, error: r }, null, 1));
    } catch {
      /* 무시 */
    }
    return r;
  }
  const { extractText, SUPPORTED } = require('./attext');
  for (const m of r.mails || []) {
    if (attCache.has(m.id)) m.attText = attCache.get(m.id);
    else {
      const texts = [];
      for (const f of [].concat(m.attFiles || [])) {
        if (!f?.path || !SUPPORTED.test(f.path)) continue;
        try {
          const t = await extractText(f.path);
          if (t) texts.push({ name: f.name, text: t });
        } catch {
          /* 읽을 수 없는 파일(암호·손상·스캔본)은 건너뜀 */
        }
      }
      attCache.set(m.id, texts);
      m.attText = texts;
    }
    delete m.attFiles;
  }
  // 진단 기록 (메일 내용 없이 개수만)
  try {
    const { app } = require('electron');
    fs.writeFileSync(path.join(app.getPath('userData'), 'outlook-diag.json'), JSON.stringify({ at: new Date().toISOString(), opt, count: (r.mails || []).length, diag: r.diag || [], readErr: r.readErr || '' }, null, 1));
  } catch {
    /* 무시 */
  }
  if (r.attDir) fs.rm(r.attDir, { recursive: true, force: true }, () => {});
  delete r.attDir;
  while (attCache.size > 600) attCache.delete(attCache.keys().next().value);
  return r;
}

function readRaw(opt = {}) {
  const o = { days: Math.max(1, Math.min(31, opt.days | 0 || 7)), max: Math.max(10, Math.min(500, opt.max | 0 || 200)), start: !!opt.start, selected: !!opt.selected };
  if (o.selected) o.start = false;
  if (process.env.ST_OUTLOOK_MOCK) {
    const j = JSON.parse(fs.readFileSync(process.env.ST_OUTLOOK_MOCK, 'utf8'));
    return Promise.resolve(o.selected && j.ok ? { ok: true, mails: j.mails.slice(0, 1) } : j);
  }
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, code: 'noOutlook', error: 'Windows에서만 사용할 수 있습니다.' });
  const stamp = `${process.pid}-${Date.now()}`;
  const outPath = path.join(os.tmpdir(), `st-outlook-${stamp}.json`);
  o.skipPath = path.join(os.tmpdir(), `st-outlook-skip-${stamp}.json`);
  o.attDir = path.join(os.tmpdir(), `st-outlook-att-${stamp}`);
  fs.writeFileSync(o.skipPath, JSON.stringify([...attCache.keys()]));
  fs.mkdirSync(o.attDir, { recursive: true });
  const enc = Buffer.from(script(outPath, o), 'utf16le').toString('base64');
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], {
      windowsHide: true,
    });
    let err = '';
    ps.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => ps.kill(), 180000);
    ps.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 'error', error: e.message });
    });
    ps.on('close', () => {
      clearTimeout(timer);
      try {
        const txt = fs.readFileSync(outPath, 'utf8').replace(/^\uFEFF/, '');
        fs.unlink(outPath, () => {});
        fs.unlink(o.skipPath, () => {});
        resolve({ ...JSON.parse(txt), attDir: o.attDir });
      } catch {
        fs.unlink(o.skipPath, () => {});
        fs.rm(o.attDir, { recursive: true, force: true }, () => {});
        resolve({ ok: false, code: 'error', error: (err.trim().split('\n')[0] || 'Outlook 응답 없음(시간 초과)').slice(0, 300) });
      }
    });
  });
}

/** Outlook에서 메일 열기 */
function openItem(id) {
  if (process.platform !== 'win32' || process.env.ST_OUTLOOK_MOCK) return Promise.resolve({ ok: true });
  const esc = (x) => String(x).replace(/'/g, "''");
  const ps1 = `
$ErrorActionPreference = 'Stop'
try { $ol = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') } catch { $ol = New-Object -ComObject Outlook.Application }
$it = $ol.Session.GetItemFromID('${esc(id)}')
$it.Display()
try { $it.GetInspector.Activate() } catch {}
`;
  const enc = Buffer.from(ps1, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true });
    let err = '';
    ps.stderr.on('data', (d) => (err += d));
    ps.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: err.trim().split('\n')[0] || 'Outlook에서 열지 못했습니다.' }));
    ps.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

/** Outlook에서 지금 선택하거나 열어 둔 메일 1통 */
const readSelected = () => readInbox({ selected: true, max: 10 });

module.exports = { readInbox, readSelected, openItem, script };
