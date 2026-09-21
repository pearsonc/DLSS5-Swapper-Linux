'use strict';
const path = require('path');

// install-guards.js's one-line delegate lands here: upstream's PowerShell
// process list through the injected runner, then the lock probe when the
// list is unavailable. log and processRoot are proton-install-core~12~3 to
// ~15~2's running-game check's own inputs, on Linux.
async function assertGameClosed(matchingProcesses, gameDir, exePath, runner, locked, log, processRoot) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  let data;
  try {
    const output = await runner(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath) | ConvertTo-Json -Compress"]);
    data = JSON.parse(output || '[]');
  } catch {
    // The process list is unavailable: PowerShell restricted by policy, a cold
    // WMI call past its timeout, or a machine where it simply fails. Refusing
    // outright turned a diagnostic into a wall, so ask the executable itself.
    if (exePath && locked(exePath)) {
      throw Object.assign(new Error('Close the game first: its executable is in use.'), { code: 'errGameRunning' });
    }
    return;
  }
  const matches = matchingProcesses(Array.isArray(data) ? data : [data], gameDir, exePath);
  if (matches.length) throw Object.assign(new Error(`Close the game and helper first: ${matches.map(p => p.Name).join(', ')}`), { code: 'errGameRunning' });
}

module.exports = { assertGameClosed };
