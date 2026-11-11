// 단축키를 누른 순간 앞에 있던 프로그램 확인 (+ 선택한 글을 자동으로 복사: Outlook·명령창 제외)
const { spawn } = require('child_process');

const PS = (copy) => `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class StW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint fl, UIntPtr ex);
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
}
'@
$h = [StW]::GetForegroundWindow()
$procId = 0
[void][StW]::GetWindowThreadProcessId($h, [ref]$procId)
$name = (Get-Process -Id $procId).ProcessName
# Outlook(선택한 메일을 따로 읽음)·명령창(Ctrl+C = 중지)·이 프로그램은 빼고, 선택한 글을 복사
$copied = 0
if (${copy ? '$true' : '$false'} -and $name -notmatch '^(OUTLOOK|WindowsTerminal|cmd|powershell|pwsh|conhost|wt|mintty|putty|일정할일|electron)$') {
  $seq = [StW]::GetClipboardSequenceNumber()
  # 사용자가 누른 Ctrl·Shift·E를 뗄 때까지 잠깐 기다린 뒤 Ctrl+C
  for ($i = 0; $i -lt 40; $i++) {
    $down = 0
    foreach ($k in 0x10, 0x11, 0x45) { if (([StW]::GetAsyncKeyState($k) -band 0x8000) -ne 0) { $down++ } }
    if ($down -eq 0) { break }
    Start-Sleep -Milliseconds 25
  }
  [StW]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
  [StW]::keybd_event(0x43, 0, 0, [UIntPtr]::Zero)
  [StW]::keybd_event(0x43, 0, 2, [UIntPtr]::Zero)
  [StW]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
  # 복사가 끝날 때까지 최대 0.8초 기다림 (선택한 글이 없으면 그대로)
  for ($i = 0; $i -lt 16; $i++) {
    Start-Sleep -Milliseconds 50
    if ([StW]::GetClipboardSequenceNumber() -ne $seq) { $copied = 1; Start-Sleep -Milliseconds 60; break }
  }
}
Write-Output "$copied|$name"
`;

/** @returns {Promise<{name:string, copied:boolean}>} 앞에 있던 프로그램 이름(예: OUTLOOK, KakaoTalk)과 자동 복사 여부 */
function foregroundApp({ copy = true } = {}) {
  if (process.env.ST_FG_APP) return Promise.resolve({ name: process.env.ST_FG_APP, copied: false });
  if (process.platform !== 'win32') return Promise.resolve({ name: '', copied: false });
  const enc = Buffer.from(PS(copy), 'utf16le').toString('base64');
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', (d) => (out += d));
    const t = setTimeout(() => ps.kill(), 6000);
    ps.on('close', () => {
      clearTimeout(t);
      const last = out.trim().split(/\r?\n/).pop() || '';
      const m = last.match(/^([01])\|(.*)$/);
      resolve(m ? { name: m[2], copied: m[1] === '1' } : { name: last, copied: false });
    });
    ps.on('error', () => {
      clearTimeout(t);
      resolve({ name: '', copied: false });
    });
  });
}

module.exports = { foregroundApp };
