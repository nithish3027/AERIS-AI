@echo off
title AERIS Launcher

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js first.
    pause
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] Python virtual environment not found at .venv\
    pause
    exit /b 1
)

if not exist "backend\node_modules" (
    cd backend && call npm install && cd ..
)
if not exist "frontend\node_modules" (
    cd frontend && call npm install && cd ..
)

if exist "ai_service\app.py" (
    start "AERIS AI [8000]" cmd /k "title AERIS AI [8000] && .venv\Scripts\activate && python ai_service/app.py"
    timeout /t 2 /nobreak >nul
)

start "AERIS Backend [5000]" cmd /k "title AERIS Backend [5000] && cd backend && npm run dev"

timeout /t 3 /nobreak >nul

start "AERIS Frontend [5173]" cmd /k "title AERIS Frontend [5173] && cd frontend && npm run dev"

