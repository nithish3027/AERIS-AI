# AERIS - All-in-One Startup Script (PowerShell)
$Host.UI.RawUI.WindowTitle = "AERIS Launcher"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "  ======================================================" -ForegroundColor Cyan
Write-Host "    AERIS - Accident Detection System" -ForegroundColor Cyan
Write-Host "    Starting all 3 services..." -ForegroundColor Cyan
Write-Host "  ======================================================" -ForegroundColor Cyan
Write-Host ""

# --- Pre-flight checks ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "  [ERROR] Node.js not found. Please install Node.js." -ForegroundColor Red
    Read-Host "Press Enter to exit"; exit 1
}
if (-not (Test-Path "$root\.venv\Scripts\python.exe")) {
    Write-Host "  [ERROR] Python venv not found at .venv\" -ForegroundColor Red
    Write-Host "  Run: python -m venv .venv" -ForegroundColor Yellow
    Write-Host "  Then: .venv\Scripts\pip install -r requirements.txt" -ForegroundColor Yellow
    Read-Host "Press Enter to exit"; exit 1
}
if (-not (Test-Path "$root\backend\node_modules")) {
    Write-Host "  [INFO] Installing backend dependencies..." -ForegroundColor Yellow
    Push-Location "$root\backend"; npm install; Pop-Location
}
if (-not (Test-Path "$root\frontend\node_modules")) {
    Write-Host "  [INFO] Installing frontend dependencies..." -ForegroundColor Yellow
    Push-Location "$root\frontend"; npm install; Pop-Location
}

if (Test-Path "$root\ai_service\app.py") {
    Write-Host "  [1/3] Starting AI Service  (port 8000)..." -ForegroundColor Green
    Start-Process powershell -ArgumentList "-NoExit -Command `$Host.UI.RawUI.WindowTitle='AERIS AI [8000]'; Set-Location '$root'; Write-Host 'AERIS AI Service - YOLOv8' -ForegroundColor Cyan; & '$root\.venv\Scripts\python.exe' '$root\ai_service\app.py'"
    Start-Sleep -Seconds 2
} else {
    Write-Host "  [INFO] AI service folder not present - running in standalone simulation mode." -ForegroundColor Cyan
}

Write-Host "  [2/3] Starting Backend     (port 5000)..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit -Command `$Host.UI.RawUI.WindowTitle='AERIS Backend [5000]'; Set-Location '$root\backend'; Write-Host 'AERIS Node.js Backend' -ForegroundColor Yellow; npm run dev"
Start-Sleep -Seconds 1

Write-Host "  [3/3] Starting Frontend    (port 5173)..." -ForegroundColor Magenta
Start-Process powershell -ArgumentList "-NoExit -Command `$Host.UI.RawUI.WindowTitle='AERIS Frontend [5173]'; Set-Location '$root\frontend'; Write-Host 'AERIS Vite Frontend' -ForegroundColor Magenta; npm run dev"

Write-Host ""
Write-Host "  ======================================================" -ForegroundColor Cyan
Write-Host "    All services launched in separate windows!" -ForegroundColor Green
Write-Host ""
Write-Host "    Frontend  -> http://localhost:5173" -ForegroundColor White
Write-Host "    Backend   -> http://localhost:5000" -ForegroundColor White
Write-Host "    AI Health -> http://localhost:8000/health" -ForegroundColor White
Write-Host "  ======================================================" -ForegroundColor Cyan
Write-Host ""
Read-Host "  Press Enter to close this launcher"