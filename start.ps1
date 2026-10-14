$Host.UI.RawUI.WindowTitle = "AERIS Launcher"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Node.js not found. Please install Node.js." -ForegroundColor Red
    Read-Host "Press Enter to exit"; exit 1
}
if (-not (Test-Path "$root\.venv\Scripts\python.exe")) {
    Write-Host "[ERROR] Python venv not found at .venv\" -ForegroundColor Red
    Read-Host "Press Enter to exit"; exit 1
}
if (-not (Test-Path "$root\backend\node_modules")) {
    Push-Location "$root\backend"; npm install; Pop-Location
}
if (-not (Test-Path "$root\frontend\node_modules")) {
    Push-Location "$root\frontend"; npm install; Pop-Location
}

if (Test-Path "$root\ai_service\app.py") {
    Start-Process powershell -ArgumentList "-NoExit -Command `$Host.UI.RawUI.WindowTitle='AERIS AI [8000]'; Set-Location '$root'; & '$root\.venv\Scripts\python.exe' '$root\ai_service\app.py'"
    Start-Sleep -Seconds 2
}

Start-Process powershell -ArgumentList "-NoExit -Command `$Host.UI.RawUI.WindowTitle='AERIS Backend [5000]'; Set-Location '$root\backend'; npm run dev"
Start-Sleep -Seconds 3

Start-Process powershell -ArgumentList "-NoExit -Command `$Host.UI.RawUI.WindowTitle='AERIS Frontend [5173]'; Set-Location '$root\frontend'; npm run dev"