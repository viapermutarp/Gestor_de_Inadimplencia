@echo off
echo Verificando se o Docker Desktop esta rodando...
tasklist /FI "IMAGENAME eq Docker Desktop.exe" 2>NUL | find /I "Docker Desktop.exe" >NUL
if "%ERRORLEVEL%"=="1" (
    echo Docker Desktop nao esta aberto. Iniciando...
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    echo Aguardando o Docker Desktop inicializar completamente...
    timeout /t 30 /nobreak
) else (
    echo Docker Desktop ja esta rodando.
)

echo Iniciando o backend...
start "Backend - Gestor Inadimplencia" cmd /k "cd /d C:\Users\rfjun\Projetos\Gestor_de_Inadimplencia\backend && docker compose up"

echo Aguardando o backend ficar pronto...
timeout /t 15 /nobreak

echo Iniciando o frontend...
start "Frontend - Gestor Inadimplencia" cmd /k "cd /d C:\Users\rfjun\Projetos\Gestor_de_Inadimplencia\frontend && npm run dev"

echo Aguardando o frontend ficar pronto...
timeout /t 8 /nobreak

start http://localhost:3001/login