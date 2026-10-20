# Обновление программы до последней версии одной командой (Windows).
# Запуск: двойной щелчок по «Обновить.bat» в папке программы.
# Турниры, файл .env и резервные копии сохраняются.
$ErrorActionPreference = "Stop"
trap { Write-Host ""; Write-Host "Ошибка: $_" -ForegroundColor Red; pause; exit 1 }
Set-Location (Join-Path $PSScriptRoot "..")
$root = Get-Location

Write-Host "Обновляю программу в папке $root"
if ((Test-Path ".git") -and (Get-Command git -ErrorAction SilentlyContinue)) {
  # Программа установлена через git: забираем изменения.
  git pull --ff-only
  if ($LASTEXITCODE -ne 0) { throw "git pull не удался. Если вы правили файлы программы вручную, верните их (git checkout .) и повторите." }
} else {
  # Программа скачана архивом: скачиваем свежий архив и кладём файлы поверх.
  # .env, резервные копии и выгрузки турниров архив не содержит, они остаются как есть.
  $zip = Join-Path $env:TEMP "gymnastics-update.zip"
  $unpacked = Join-Path $env:TEMP "gymnastics-update"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Write-Host "Скачиваю последнюю версию…"
  Invoke-WebRequest "https://github.com/Grechihin-Aleksey/Artistic_gymnastics/archive/refs/heads/main.zip" -OutFile $zip -UseBasicParsing
  if (Test-Path $unpacked) { Remove-Item $unpacked -Recurse -Force }
  Expand-Archive $zip -DestinationPath $unpacked
  $source = Get-ChildItem $unpacked -Directory | Select-Object -First 1
  Copy-Item (Join-Path $source.FullName "*") $root -Recurse -Force
  Remove-Item $zip, $unpacked -Recurse -Force
}
Write-Host "Программа обновлена. Перезапускаю…"
Write-Host ""
& (Join-Path $PSScriptRoot "start.ps1")
