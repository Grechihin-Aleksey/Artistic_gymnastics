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

# Адрес в сети зала: у физического адаптера Wi-Fi или Ethernet с основным шлюзом.
# Виртуальные адаптеры WSL, Docker и VPN (у VPN тоже бывает шлюз) планшетам не видны, их берём в последнюю очередь.
$up = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq "Up" }
$physical = $up | Where-Object { $_.NetAdapter.HardwareInterface }
$ip = (@($physical) + @($up) | Select-Object -First 1).IPv4Address.IPAddress | Select-Object -First 1
if (-not $ip) { $ip = "localhost" }
$others = @($up | ForEach-Object { $_.IPv4Address.IPAddress } | Where-Object { $_ -and $_ -ne $ip })
# Планшетам нужен входящий доступ к порту 3000. Правило брандмауэра создаётся, только если скрипт запущен от администратора.
$firewallHint = $false
if (-not (Get-NetFirewallRule -DisplayName "Gymnastics 3000" -ErrorAction SilentlyContinue)) {
  try {
    New-NetFirewallRule -DisplayName "Gymnastics 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -ErrorAction Stop | Out-Null
    Write-Host "Порт 3000 открыт для планшетов в брандмауэре Windows."
  } catch {
    $firewallHint = $true
  }
}
$token = ((Get-Content ".env") | Where-Object { $_ -like "ADMIN_TOKEN=*" }) -replace "^ADMIN_TOKEN=", ""

Write-Host ""
Write-Host "Сервер работает."
Write-Host "  Секретариат: http://${ip}:3000/judge/#/admin"
Write-Host "  Табло:       http://${ip}:3000/board/"
Write-Host "  Токен секретариата: $token"
if ($others.Count -gt 0) {
  Write-Host "  Другие адреса этого компьютера: $($others -join ', ')."
  Write-Host "  Планшеты должны открывать адрес той же сети Wi-Fi, к которой подключены. Если VPN включён, выключите его на время соревнований."
}
if ($firewallHint) {
  Write-Host "  Если планшеты не открывают адрес, запустите этот скрипт один раз от имени администратора:"
  Write-Host "  он разрешит в брандмауэре Windows подключения к порту 3000."
}
Write-Host "Резервные копии базы каждые 5 минут в папке backups."
Write-Host "Остановить: docker compose stop"
# Секретариат открывается по адресу в сети: этот адрес попадает в QR-коды судей.
Start-Process "http://${ip}:3000/judge/#/admin"
pause
