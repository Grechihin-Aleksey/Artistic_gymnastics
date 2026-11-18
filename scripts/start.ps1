# Запуск сервера в зале одной командой (Windows). Нужен Docker Desktop.
# Запуск: двойной щелчок по «Запуск.bat» в папке программы
# или в PowerShell: powershell -ExecutionPolicy Bypass -File scripts\start.ps1
# Интернет нужен только при первом запуске и после обновления: тогда программа собирается.
# Если программа не менялась, запуск её не пересобирает и работает без интернета.
# -Rebuild — собрать заново, даже если программа не менялась.
param([switch]$Rebuild)
$ErrorActionPreference = "Stop"
# Любая ошибка остаётся на экране, а не закрывает окно молча.
trap { Write-Host ""; Write-Host "Ошибка: $_" -ForegroundColor Red; pause; exit 1 }
Set-Location (Join-Path $PSScriptRoot "..")

if (-not (Test-Path ".env")) {
  $chars = [char[]]"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  $token = -join (1..24 | ForEach-Object { $chars | Get-Random })
  $lines = (Get-Content ".env.example" -Encoding UTF8) -replace "^ADMIN_TOKEN=.*", "ADMIN_TOKEN=$token"
  # Без метки BOM: docker compose читает .env построчно и метку не ожидает.
  [System.IO.File]::WriteAllLines((Join-Path (Get-Location) ".env"), $lines, (New-Object System.Text.UTF8Encoding $false))
  Write-Host "Создан файл .env с новым токеном секретариата."
  Write-Host ""
  Write-Host "Результаты можно показывать на сайте (подробно в инструкции «Подключение результатов к сайту»)."
  $relayUrl = (Read-Host "Адрес ретранслятора на сайте, например https://ffk52.ru/results (Enter - без сайта)").Trim()
  if ($relayUrl) {
    $relayToken = (Read-Host "Токен ретранслятора (тот же, что в config.php на хостинге)").Trim()
    $lines = $lines -replace "^RELAY_URL=.*", "RELAY_URL=$relayUrl" -replace "^RELAY_TOKEN=.*", "RELAY_TOKEN=$relayToken"
    [System.IO.File]::WriteAllLines((Join-Path (Get-Location) ".env"), $lines, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "Сайт подключён. Поменять адрес и токен можно в файле .env."
  }
}
if ((Get-Content ".env") -contains "ADMIN_TOKEN=change-me-to-a-long-random-string") {
  Write-Host "В .env остался токен секретариата из образца. Замените его своим в строке ADMIN_TOKEN." -ForegroundColor Yellow
}
New-Item -ItemType Directory -Force -Path "backups" | Out-Null
New-Item -ItemType Directory -Force -Path "video" | Out-Null

# Команда docker без вывода на экран; возвращает код завершения.
# Ошибки docker не прерывают скрипт: Windows PowerShell иначе считает любой текст ошибки исключением.
function Invoke-Docker {
  $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & docker @args *> $null } finally { $ErrorActionPreference = $old }
  return $LASTEXITCODE
}
# Есть ли интернет: открывается ли хранилище Docker, откуда скачиваются компоненты программы.
function Test-Internet {
  try { [System.Net.Dns]::GetHostAddresses("registry-1.docker.io") | Out-Null; return $true } catch { return $false }
}
# Отпечаток исходников программы. Совпадает с тем, из которого собран образ, — пересобирать не нужно.
function Get-SourceStamp {
  $base = (Get-Location).Path
  $files = @("apps\server", "apps\judge", "apps\scoreboard", "packages") | Where-Object { Test-Path $_ } |
    ForEach-Object { Get-ChildItem $_ -Recurse -File } | Where-Object { $_.FullName -notmatch "\\(node_modules|dist)\\" }
  $files = @($files) + @("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "version.json", ".dockerignore" |
    Where-Object { Test-Path $_ } | ForEach-Object { Get-Item $_ })
  $lines = $files | Sort-Object FullName | ForEach-Object { $_.FullName.Substring($base.Length) + " " + (Get-FileHash $_.FullName -Algorithm SHA256).Hash }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($lines -join "`n")))).Replace("-", "")
}
function Write-NoInternetHelp {
  Write-Host ""
  Write-Host "Нет интернета, а программа на этом компьютере ещё не собрана." -ForegroundColor Red
  Write-Host "Первый запуск и запуск после обновления скачивают компоненты программы (около 1 ГБ), дальше интернет не нужен."
  Write-Host "Что сделать:"
  Write-Host "  - подключите компьютер к интернету (например, раздайте его с телефона) и снова запустите Запуск.bat;"
  Write-Host "  - или на компьютере, где программа уже работает, запустите «Подготовить офлайн.bat»"
  Write-Host "    и скопируйте папку offline оттуда в папку программы на этом компьютере."
}

# Docker Desktop закрыт: запускаем его сами и ждём, пока он поднимется.
if ((Invoke-Docker info) -ne 0) {
  $desktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
  if (-not (Test-Path $desktop)) { Write-Host "Docker Desktop не найден. Установите его с docker.com и повторите."; pause; exit 1 }
  Start-Process $desktop
  Write-Host -NoNewline "Запускаю Docker Desktop"
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 3
    if ((Invoke-Docker info) -eq 0) { break }
    Write-Host -NoNewline "."
  }
  Write-Host ""
  if ((Invoke-Docker info) -ne 0) { Write-Host "Docker Desktop не запустился за 3 минуты. Откройте его вручную, дождитесь «Engine running» и повторите."; pause; exit 1 }
}

# Собираем программу, только если её ещё нет или она изменилась (обновление). Иначе интернет не нужен.
$image = "gymnastics-server:latest"
$offlineTar = "offline\gymnastics-images.tar"
$offlineStamp = "offline\stamp.txt"
$stamp = Get-SourceStamp
$builtStamp = if (Test-Path ".build-stamp") { "$(Get-Content ".build-stamp" -Raw)".Trim() } else { "" }
$haveImage = (Invoke-Docker image inspect $image) -eq 0
function Import-Offline {
  Write-Host "Загружаю программу из папки offline (интернет не нужен)…"
  docker load -i $offlineTar
  if ($LASTEXITCODE -ne 0) { Write-Host "Файл $offlineTar повреждён. Скопируйте папку offline заново."; pause; exit 1 }
  Copy-Item $offlineStamp ".build-stamp" -Force
}
if ($Rebuild -or -not $haveImage -or $builtStamp -ne $stamp) {
  $packStamp = if (Test-Path $offlineStamp) { "$(Get-Content $offlineStamp -Raw)".Trim() } else { "" }
  if (-not $Rebuild -and (Test-Path $offlineTar) -and $packStamp -eq $stamp) {
    Import-Offline
  } else {
    Write-Host "Собираю программу. Первый раз это 5–15 минут и нужен интернет."
    docker compose build server
    if ($LASTEXITCODE -eq 0) {
      [System.IO.File]::WriteAllText((Join-Path (Get-Location) ".build-stamp"), $stamp)
    } elseif ($haveImage) {
      Write-Host ""
      if (Test-Internet) { Write-Host "Новую версию собрать не удалось (причина выше). Запускаю прежнюю версию программы." -ForegroundColor Yellow }
      else { Write-Host "Нет интернета, новую версию собрать нельзя. Запускаю прежнюю версию программы: турниры и оценки на месте." -ForegroundColor Yellow }
    } elseif (Test-Path $offlineTar) {
      Write-Host ""
      Write-Host "Собрать программу не удалось. Запускаю версию из папки offline." -ForegroundColor Yellow
      Import-Offline
    } elseif (-not (Test-Internet)) {
      Write-NoInternetHelp; pause; exit 1
    } else {
      Write-Host ""
      Write-Host "Сборка программы не удалась, причина в строках выше. Запустите Запуск.bat ещё раз; если ошибка повторится, сфотографируйте окно." -ForegroundColor Red
      pause; exit 1
    }
  }
}

docker compose up -d --no-build
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  if ((Invoke-Docker image inspect postgres:16-alpine) -ne 0 -and -not (Test-Internet)) { Write-NoInternetHelp }
  else { Write-Host "Программа не запустилась, причина в строках выше. Перезапустите Docker Desktop и запустите Запуск.bat ещё раз." -ForegroundColor Red }
  pause; exit 1
}
# После обновления старые сборки программы остаются на диске и занимают сотни мегабайт: убираем их.
Invoke-Docker image prune -f | Out-Null
Invoke-Docker builder prune -f --filter until=168h | Out-Null

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
# Роутер без интернета или с другими настройками может не выдать шлюз: тогда берём физический адаптер с обычным адресом.
$up = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq "Up" }
$physical = $up | Where-Object { $_.NetAdapter.HardwareInterface }
$ip = (@($physical) + @($up) | Select-Object -First 1).IPv4Address.IPAddress | Select-Object -First 1
if (-not $ip) {
  $ip = Get-NetIPConfiguration | Where-Object { $_.NetAdapter.Status -eq "Up" -and $_.NetAdapter.HardwareInterface } |
    ForEach-Object { $_.IPv4Address.IPAddress } | Where-Object { $_ -and $_ -notlike "169.254.*" } | Select-Object -First 1
}
if (-not $ip) { $ip = "localhost" }
# Адрес компьютера сменился (другой роутер или Wi-Fi): судьям нужны новые QR-коды, если планшеты не нашли сервер сами.
$lastIp = if (Test-Path ".last-ip") { "$(Get-Content ".last-ip" -Raw)".Trim() } else { "" }
$ipChanged = $lastIp -and $ip -ne "localhost" -and $lastIp -ne $ip
if ($ip -ne "localhost") { [System.IO.File]::WriteAllText((Join-Path (Get-Location) ".last-ip"), $ip) }
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
Write-Host "  (запасной ключ: им входят первый раз и если пароль забыт; пароль задайте в секретариате, «Пароль и вход»)"
if ($others.Count -gt 0) {
  Write-Host "  Другие адреса этого компьютера: $($others -join ', ')."
  Write-Host "  Планшеты должны открывать адрес той же сети Wi-Fi, к которой подключены. Если VPN включён, выключите его на время соревнований."
}
if ($ip -eq "localhost") {
  Write-Host "  Компьютер не подключён к сети Wi-Fi или к роутеру: планшеты его не увидят. Подключитесь к сети зала и запустите Запуск.bat снова." -ForegroundColor Yellow
}
if ($ipChanged) {
  Write-Host "  Адрес компьютера изменился: был $lastIp, стал $ip (другой роутер или сеть)." -ForegroundColor Yellow
  Write-Host "  Планшеты в той же сети найдут сервер сами примерно за минуту. Если планшет не подключился,"
  Write-Host "  раздайте судьям новые QR-коды (экран «Судьи») и откройте табло по новому адресу."
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
