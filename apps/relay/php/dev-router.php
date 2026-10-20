<?php
// Для проверки без Apache: php -S 127.0.0.1:8090 dev-router.php
// Повторяет .htaccess: готовые файлы отдаются как есть, остальное идёт в index.php.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/(data|config\.php)#', $path)) {
    http_response_code(403);
    return true;
}
$file = __DIR__ . $path;
if ($path !== '/' && (is_file($file) || is_file(rtrim($file, '/') . '/index.html'))) return false;
$_SERVER['SCRIPT_NAME'] = '/index.php';
require __DIR__ . '/index.php';
