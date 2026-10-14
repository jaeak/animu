# Starts animu's server if it isn't already running, then opens animu in its own Chrome app window.
$url = "http://127.0.0.1:8000/"
$chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"

function Test-Server {
  try { Invoke-WebRequest -UseBasicParsing -Method Head $url -TimeoutSec 2 | Out-Null; $true } catch { $false }
}

if (-not (Test-Server)) {
  Start-Process node -ArgumentList "server.js" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
  for ($i = 0; $i -lt 50 -and -not (Test-Server); $i++) { Start-Sleep -Milliseconds 200 }
}

# Prefer the installed Chrome app: it gets a sharp taskbar icon from manifest.json,
# while a plain --app window only gets a stretched 16px favicon.
$installed = Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Chrome Apps\Animu*.lnk" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($installed) {
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($installed.FullName)
  Start-Process $shortcut.TargetPath $shortcut.Arguments
} else {
  Start-Process $chrome "--app=$url"
}
