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
  # Закрытый репозиторий скачивается только с ключом GitHub: строка GITHUB_TOKEN=… в .env.
  $token = ""
  if (Test-Path ".env") {
    $line = Get-Content ".env" | Where-Object { $_ -match "^\s*GITHUB_TOKEN\s*=" } | Select-Object -First 1
    if ($line) { $token = ($line -split "=", 2)[1].Trim() }
  }
  Write-Host "Скачиваю последнюю версию…"
  try {
    if ($token) {
      $headers = @{ Authorization = "Bearer $token"; "User-Agent" = "gymnastics-update" }
      Invoke-WebRequest "https://api.github.com/repos/Grechihin-Aleksey/Artistic_gymnastics/zipball/main" -Headers $headers -OutFile $zip -UseBasicParsing
    } else {
      Invoke-WebRequest "https://github.com/Grechihin-Aleksey/Artistic_gymnastics/archive/refs/heads/main.zip" -OutFile $zip -UseBasicParsing
    }
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -eq 404 -or $status -eq 401) {
      if ($token) { throw "GitHub не принял ключ из строки GITHUB_TOKEN в .env. Проверьте, что ключ скопирован целиком, не просрочен и даёт доступ к репозиторию Artistic_gymnastics." }
      throw "Репозиторий программы закрытый, скачать его без ключа нельзя. Добавьте в файл .env строку GITHUB_TOKEN=ваш-ключ (как получить ключ, написано в README) или скачайте архив вручную в браузере, где вы вошли в GitHub."
    }
    throw
  }
  if (Test-Path $unpacked) { Remove-Item $unpacked -Recurse -Force }
  Expand-Archive $zip -DestinationPath $unpacked
  $source = Get-ChildItem $unpacked -Directory | Select-Object -First 1
  Copy-Item (Join-Path $source.FullName "*") $root -Recurse -Force
  Remove-Item $zip, $unpacked -Recurse -Force
}
Write-Host "Программа обновлена. Перезапускаю…"
Write-Host ""
& (Join-Path $PSScriptRoot "start.ps1")
