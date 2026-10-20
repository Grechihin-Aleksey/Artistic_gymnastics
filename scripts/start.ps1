# Запуск сервера в зале одной командой (Windows). Нужен Docker Desktop.
# Запуск: правой кнопкой по файлу -> «Выполнить с помощью PowerShell»
# или в PowerShell: powershell -ExecutionPolicy Bypass -File scripts\start.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not (Test-Path ".env")) {
  $chars = [char[]]"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  $token = -join (1..24 | ForEach-Object { $chars | Get-Random })
  $lines = (Get-Content ".env.example" -Encoding UTF8) -replace "^ADMIN_TOKEN=.*", "ADMIN_TOKEN=$token"
  # Без метки BOM: docker compose читает .env построчно и метку не ожидает.
  [System.IO.File]::WriteAllLines((Join-Path (Get-Location) ".env"), $lines, (New-Object System.Text.UTF8Encoding $false))
  Write-Host "Создан файл .env с новым токеном секретариата."
}
New-Item -ItemType Directory -Force -Path "backups" | Out-Null

docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Write-Host "Docker не запустился. Откройте Docker Desktop и повторите."; pause; exit 1 }

Write-Host -NoNewline "Жду, пока сервер запустится"
$ready = $false
for ($i = 0; $i -lt 90; $i++) {
  try { Invoke-WebRequest "http://localhost:3000/competitions" -UseBasicParsing -TimeoutSec 2 | Out-Null; $ready = $true; break }
  catch { Write-Host -NoNewline "."; Start-Sleep -Seconds 2 }
}
Write-Host ""
if (-not $ready) { Write-Host "Сервер не ответил за 3 минуты. Журнал: docker compose logs server"; pause; exit 1 }

$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -in "Dhcp", "Manual" -and $_.IPAddress -notlike "169.254*" } | Select-Object -First 1).IPAddress
if (-not $ip) { $ip = "localhost" }
$token = ((Get-Content ".env") | Where-Object { $_ -like "ADMIN_TOKEN=*" }) -replace "^ADMIN_TOKEN=", ""

Write-Host ""
Write-Host "Сервер работает."
Write-Host "  Секретариат: http://${ip}:3000/judge/#/admin"
Write-Host "  Табло:       http://${ip}:3000/board/"
Write-Host "  Токен секретариата: $token"
Write-Host "Резервные копии базы каждые 5 минут в папке backups."
Write-Host "Остановить: docker compose stop"
Start-Process "http://localhost:3000/judge/#/admin"
pause
