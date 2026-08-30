@echo off
setlocal enabledelayedexpansion

echo ===================================
echo   TickVPN - Windows Setup
echo ===================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install it from https://nodejs.org first.
    pause
    exit /b 1
)

where docker >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARN] Docker not found. Skipping auto-start of Postgres.
    echo        Make sure DATABASE_URL in .env points to a running Postgres instance.
    goto :skip_docker
)

echo [1/6] Checking for Postgres container...
docker ps -a --format "{{.Names}}" | findstr /i "vpndays-db" >nul 2>nul
if %errorlevel% equ 0 (
    echo       Container exists. Starting it...
    docker start vpndays-db >nul
) else (
    echo       Creating new Postgres container...
    docker run --name vpndays-db -e POSTGRES_PASSWORD=password -e POSTGRES_DB=vpndays -p 5432:5432 -d postgres >nul
    echo       Waiting for Postgres to be ready...
    timeout /t 5 /nobreak >nul
)

:skip_docker

echo [2/6] Installing npm dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)

echo [3/6] Setting up .env...
if not exist .env (
    copy .env.example .env >nul
    echo       Created .env from template. Edit it now if your DB credentials differ.
) else (
    echo       .env already exists, leaving it as-is.
)

echo [4/6] Generating Prisma client...
call npm run prisma:generate
if %errorlevel% neq 0 (
    echo [ERROR] Prisma generate failed.
    pause
    exit /b 1
)

echo [5/6] Running database migrations...
call npm run prisma:migrate
if %errorlevel% neq 0 (
    echo [ERROR] Migration failed. Check DATABASE_URL in .env.
    pause
    exit /b 1
)

echo [6/6] Seeding products, regions, and mock nodes...
call npm run seed

echo.
echo ===================================
echo   Setup complete. Starting server...
echo ===================================
echo.
call npm run dev

pause
