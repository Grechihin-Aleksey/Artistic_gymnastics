# Готовит программу к запуску на компьютере без интернета (Windows).
# Запуск: двойной щелчок по «Подготовить офлайн.bat» на компьютере, где программа уже работает.
# Сохраняет собранную программу и базу данных в файл offline\gymnastics-images.tar (несколько сотен мегабайт).
# Дальше папку программы целиком (вместе с папкой offline) копируют на другой компьютер:
# там «Запуск.bat» загрузит программу из файла и интернет не понадобится.
$ErrorActionPreference = "Stop"
trap { Write-Host ""; Write-Host "Ошибка: $_" -ForegroundColor Red; pause; exit 1 }
Set-Location (Join-Path $PSScriptRoot "..")

$old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
docker image inspect gymnastics-server:latest *> $null; $haveImage = $LASTEXITCODE -eq 0
$ErrorActionPreference = $old
if (-not (Test-Path ".build-stamp") -or -not $haveImage) {
  Write-Host "Программа на этом компьютере ещё не собрана. Сначала запустите Запуск.bat (с интернетом), потом этот файл снова."
  pause; exit 1
}
New-Item -ItemType Directory -Force -Path "offline" | Out-Null
Write-Host "Сохраняю программу в папку offline. Это пара минут…"
docker save -o "offline\gymnastics-images.tar" gymnastics-server:latest postgres:16-alpine
if ($LASTEXITCODE -ne 0) { Write-Host "Не удалось сохранить. Проверьте, что Docker Desktop запущен, и повторите."; pause; exit 1 }
Copy-Item ".build-stamp" "offline\stamp.txt" -Force
$size = [math]::Round((Get-Item "offline\gymnastics-images.tar").Length / 1MB)
Write-Host ""
Write-Host "Готово: offline\gymnastics-images.tar ($size МБ)." -ForegroundColor Green
Write-Host "Скопируйте папку программы целиком (с папкой offline) на флешку и на другой компьютер."
Write-Host "Там нужен установленный Docker Desktop; его установщик тоже сохраните на флешку."
Write-Host "На новом компьютере запустите Запуск.bat: программа загрузится из файла без интернета."
Write-Host "Файл .env с паролем и подключением к сайту копируется вместе с папкой; если копировать не нужно, удалите его на новом компьютере."
pause
