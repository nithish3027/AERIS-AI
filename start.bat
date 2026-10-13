@echo off
title AERIS - Startup
color 0A

echo.
echo  ======================================================
echo    AERIS - Accident Detection System
echo    Starting all services...
echo  ======================================================
echo.

:: Check if Node.js is available
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js not found. Please install Node.js first.
    pause
    exit /b 1
)

:: Check if Python venv exists
if not exist ".venv\Scripts\python.exe" (
    echo  [ERROR] Python virtual environment not found at .venv\
    echo  Please run: python -m venv .venv
    echo  Then:       .venv\Scripts\pip install -r requirements.txt
    pause
    exit /b 1
)

:: Check if node_modules exists in backend and frontend
if not exist "backend\node_modules" (
    echo  [INFO] backend\node_modules not found. Installing backend dependencies...
    cd backend && call npm install && cd ..
)
if not exist "frontend\node_modules" (
    echo  [INFO] frontend\node_modules not found. Installing frontend dependencies...
    cd frontend && call npm install && cd ..
)

if exist "ai_service\app.py" (
    echo  [1/3] Starting Python AI Service (port 8000)...
    start "AERIS - AI Service [Python:8000]" cmd /k "title AERIS - AI Service [Python:8000] && color 0B && echo  Starting AI Service... && .venv\Scripts\activate && python ai_service/app.py"
    timeout /t 2 /nobreak >nul
) else (
    echo  [INFO] AI Service folder not present - running in standalone simulation mode.
)

echo  [2/3] Starting Node.js Backend  (port 5000)...
start "AERIS - Backend [Node:5000]" cmd /k "title AERIS - Backend [Node:5000] && color 0E && echo  Starting Backend... && cd backend && npm run dev"

timeout /t 1 /nobreak >nul

echo  [3/3] Starting Vite Frontend    (port 5173)...
start "AERIS - Frontend [Vite:5173]" cmd /k "title AERIS - Frontend [Vite:5173] && color 0D && echo  Starting Frontend... && cd frontend && npm run dev"

echo.
echo  ======================================================
echo    All 3 services are starting in separate windows.
echo.
echo    Frontend  -^> http://localhost:5173
echo    Backend   -^> http://localhost:5000
echo    AI        -^> http://localhost:8000/health
echo  ======================================================
echo.
echo  Close this window or press any key to exit this launcher.
pause >nul
