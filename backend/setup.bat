@echo off
setlocal enabledelayedexpansion

rem ---------------------------------------------------------------------------
rem  TickVPN backend - one-command local setup for Windows.
rem
rem  Brings up Postgres in Docker, creates the least-privilege application role,
rem  applies migrations, seeds the catalogue, and starts the API.
rem
rem  The role step is the one people miss when doing this by hand. The app
rem  deliberately does NOT connect as a superuser: the ledger is append-only
rem  because the database refuses UPDATE and DELETE on it, not because the code
rem  promises not to. Connecting as postgres would quietly undo that.
rem ---------------------------------------------------------------------------

set DB_NAME=tickvpn
set DB_CONTAINER=tickvpn-db
set APP_PASSWORD=local-dev-password

echo ===================================
echo   TickVPN backend - local setup
echo ===================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install Node 20+ from https://nodejs.org
    pause & exit /b 1
)

where docker >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Docker not found.
    echo         Either install Docker Desktop, or run PostgreSQL 16 yourself
    echo         and follow the manual steps in README.md instead.
    pause & exit /b 1
)

echo [1/7] Starting PostgreSQL...
docker ps -a --format "{{.Names}}" | findstr /i /c:"%DB_CONTAINER%" >nul 2>nul
if %errorlevel% equ 0 (
    echo       Container exists, starting it.
    docker start %DB_CONTAINER% >nul
) else (
    echo       Creating container %DB_CONTAINER%.
    docker run --name %DB_CONTAINER% -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=%DB_NAME% -p 5432:5432 -d postgres:16 >nul
    if !errorlevel! neq 0 ( echo [ERROR] Could not start Postgres. & pause & exit /b 1 )
)

echo       Waiting for Postgres to accept connections...
set /a tries=0
:waitdb
set /a tries+=1
docker exec %DB_CONTAINER% pg_isready -U postgres >nul 2>nul
if %errorlevel% equ 0 goto dbready
if %tries% geq 30 ( echo [ERROR] Postgres did not become ready. & pause & exit /b 1 )
timeout /t 1 /nobreak >nul
goto waitdb
:dbready
echo       Postgres is ready.

echo [2/7] Installing dependencies...
call npm install
if %errorlevel% neq 0 ( echo [ERROR] npm install failed. & pause & exit /b 1 )

echo [3/7] Writing .env...
if not exist .env (
    copy .env.example .env >nul
    powershell -NoProfile -Command "(Get-Content .env) -replace 'postgresql://tickvpn_app:change-me@localhost:5432/tickvpn', 'postgresql://tickvpn_app:%APP_PASSWORD%@localhost:5432/%DB_NAME%' | Set-Content .env"
    echo       Created .env pointing at the tickvpn_app role.
) else (
    echo       .env already exists, leaving it alone.
)

echo [4/7] Creating the least-privilege application role...
docker cp prisma\sql\app_role.sql %DB_CONTAINER%:/tmp/app_role.sql >nul
docker exec -e PGPASSWORD=postgres %DB_CONTAINER% psql -U postgres -d %DB_NAME% -q -v ON_ERROR_STOP=1 -v app_password=%APP_PASSWORD% -v DBNAME=%DB_NAME% -f /tmp/app_role.sql
if %errorlevel% neq 0 ( echo [ERROR] Could not create the application role. & pause & exit /b 1 )

echo [5/7] Generating the Prisma client...
call npm run prisma:generate
if %errorlevel% neq 0 ( echo [ERROR] prisma generate failed. & pause & exit /b 1 )

echo [6/7] Applying migrations and re-granting...
call npm run prisma:migrate
if %errorlevel% neq 0 ( echo [ERROR] Migration failed. Check DATABASE_URL in .env. & pause & exit /b 1 )
rem Migrations create new tables, which the role has no rights on until granted.
docker exec -e PGPASSWORD=postgres %DB_CONTAINER% psql -U postgres -d %DB_NAME% -q -v ON_ERROR_STOP=1 -v app_password=%APP_PASSWORD% -v DBNAME=%DB_NAME% -f /tmp/app_role.sql

echo [7/7] Seeding products, regions and nodes...
call npm run seed
if %errorlevel% neq 0 ( echo [ERROR] Seed failed. & pause & exit /b 1 )

echo.
echo ===================================
echo   Ready. Starting the API on :3001
echo.
echo   In a second terminal, start the web app:
echo     cd ..\frontend ^&^& npm install ^&^& npm run dev
echo   then open http://localhost:3000
echo ===================================
echo.
call npm run dev

pause
