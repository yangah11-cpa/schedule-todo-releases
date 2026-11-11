// 단축키를 누른 순간 앞에 있던 프로그램 확인 (+ 카카오톡이면 선택한 글 복사)
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
}
'@
$h = [StW]::GetForegroundWindow()
$procId = 0
[void][StW]::GetWindowThreadProcessId($h, [ref]$procId)
$name = (Get-Process -Id $procId).ProcessName
if (${copy ? '$true' : '$false'} -and $name -match 'KakaoTalk') {
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
  Start-Sleep -Milliseconds 200
}
Write-Output $name
`;

/** @returns {Promise<string>} 앞에 있던 프로그램의 프로세스 이름 (예: OUTLOOK, KakaoTalk) */
function foregroundApp({ copyIfKakao = true } = {}) {
  if (process.env.ST_FG_APP) return Promise.resolve(process.env.ST_FG_APP);
  if (process.platform !== 'win32') return Promise.resolve('');
  const enc = Buffer.from(PS(copyIfKakao), 'utf16le').toString('base64');
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', (d) => (out += d));
    const t = setTimeout(() => ps.kill(), 6000);
    ps.on('close', () => {
      clearTimeout(t);
      resolve(out.trim().split(/\r?\n/).pop() || '');
    });
    ps.on('error', () => {
      clearTimeout(t);
      resolve('');
    });
  });
}

module.exports = { foregroundApp };
