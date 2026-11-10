// PC에 설치된 (클래식) Outlook의 받은 편지함을 읽는다.
// PowerShell로 Outlook COM을 호출하고, 결과는 임시 파일(UTF-8 JSON)로 받는다.
// 메일 내용은 이 PC 안에서만 처리하며 외부로 보내지 않는다.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function script(outPath, { days, max, start }) {
  const esc = (s) => s.replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
$out = '${esc(outPath)}'
function Done($obj) { [IO.File]::WriteAllText($out, (ConvertTo-Json -InputObject $obj -Depth 4 -Compress), (New-Object Text.UTF8Encoding $false)) }
$ol = $null
try { $ol = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') } catch {}
if (-not $ol) {
  if (-not $${start ? 'true' : 'false'}) { Done @{ ok = $false; code = 'notRunning' }; exit }
  try { $ol = New-Object -ComObject Outlook.Application } catch { Done @{ ok = $false; code = 'noOutlook'; error = $_.Exception.Message }; exit }
}
try {
  $ns = $ol.GetNamespace('MAPI')
  $inbox = $ns.GetDefaultFolder(6)
  $since = (Get-Date).Date.AddDays(-${days})
  $items = $inbox.Items
  $items.Sort('[ReceivedTime]', $true)
  $list = New-Object System.Collections.ArrayList
  foreach ($m in $items) {
    if ($list.Count -ge ${max}) { break }
    try { if ($m.ReceivedTime -lt $since) { break } } catch {}
    try {
      $cls = [int]$m.Class
      if ($cls -ne 43 -and $cls -ne 53) { continue }
      $body = [string]$m.Body
      if ($body.Length -gt 6000) { $body = $body.Substring(0, 6000) }
      $o = [ordered]@{
        id = [string]$m.EntryID
        subject = [string]$m.Subject
        from = [string]$m.SenderName
        received = $m.ReceivedTime.ToString('yyyy-MM-ddTHH:mm:ss')
        unread = [bool]$m.UnRead
        body = $body
      }
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
    } catch {}
  }
  Done @{ ok = $true; mails = @($list) }
} catch {
  Done @{ ok = $false; code = 'error'; error = $_.Exception.Message }
}
`;
}

/**
 * 받은 편지함 최근 메일 읽기
 * @param {{days?:number, max?:number, start?:boolean}} opt start=true면 Outlook이 꺼져 있을 때 실행해서 읽는다
 */
function readInbox(opt = {}) {
  const o = { days: Math.max(1, Math.min(31, opt.days | 0 || 7)), max: Math.max(10, Math.min(500, opt.max | 0 || 200)), start: !!opt.start };
  if (process.env.ST_OUTLOOK_MOCK) return Promise.resolve(JSON.parse(fs.readFileSync(process.env.ST_OUTLOOK_MOCK, 'utf8')));
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, code: 'noOutlook', error: 'Windows에서만 사용할 수 있습니다.' });
  const outPath = path.join(os.tmpdir(), `st-outlook-${process.pid}-${Date.now()}.json`);
  const enc = Buffer.from(script(outPath, o), 'utf16le').toString('base64');
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], {
      windowsHide: true,
    });
    let err = '';
    ps.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => ps.kill(), 90000);
    ps.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 'error', error: e.message });
    });
    ps.on('close', () => {
      clearTimeout(timer);
      try {
        const txt = fs.readFileSync(outPath, 'utf8').replace(/^﻿/, '');
        fs.unlink(outPath, () => {});
        resolve(JSON.parse(txt));
      } catch {
        resolve({ ok: false, code: 'error', error: (err.trim().split('\n')[0] || 'Outlook 응답 없음(시간 초과)').slice(0, 300) });
      }
    });
  });
}

module.exports = { readInbox, script };
