# Восстановление базы из резервной копии (Windows).
#   powershell -ExecutionPolicy Bypass -File scripts\restore.ps1                 — из самой свежей копии
#   powershell -ExecutionPolicy Bypass -File scripts\restore.ps1 backups\имя.dump — из выбранной
# Текущие данные в базе заменяются данными из копии.
param([string]$File)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not $File) {
  $latest = Get-ChildItem "backups\gymnastics-*.dump" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($latest) { $File = $latest.FullName }
}
if (-not $File -or -not (Test-Path $File)) { Write-Host "Не найдена резервная копия."; pause; exit 1 }

Write-Host "Восстанавливаю базу из $File"
$answer = Read-Host "Текущие данные будут заменены. Продолжить? [y/N]"
if ($answer -ne "y") { exit 1 }

docker compose up -d db
docker compose stop server backup
# Файл передаётся в контейнер копированием: перенаправление ввода в PowerShell портит двоичные данные.
docker compose cp $File db:/tmp/restore.dump
docker compose exec -T db pg_restore --clean --if-exists --no-owner -U gymnastics -d gymnastics /tmp/restore.dump
docker compose up -d server backup
Write-Host "Готово: база восстановлена, сервер запущен."
pause
