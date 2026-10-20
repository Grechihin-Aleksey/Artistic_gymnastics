<?php
/*
 * Ретранслятор для обычного PHP-хостинга (Beget и подобные).
 * Делает то же, что Node-версия (apps/relay/src/server.ts), но без постоянно
 * работающей программы: зрители не держат соединение, а переспрашивают
 * ретранслятор раз в несколько секунд (EventSource сам переподключается).
 * Работает на PHP 7.4 и новее, база данных не нужна: всё лежит в папке data.
 */

require __DIR__ . '/config.php';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_PROTOCOLS_BYTES = 40 * 1024 * 1024;
const MAX_ENTRY_BYTES = 200 * 1024;
const MAX_ENTRIES = 500;
/** Старые оценки после обрыва связи на сайте уже не всплывают. */
const FLASH_TTL = 60;
const UUID_RE = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';
const PROTOCOL_FILE_RE = '/^[a-z0-9][a-z0-9.-]{0,120}\.(pdf|xlsx)$/';
const DISCIPLINES = ['MAG', 'WAG'];
/** Первая строка каждого файла данных: если файл откроют по адресу, PHP ничего не покажет. */
const GUARD = "<?php exit; ?>\n";

$TOKEN = getenv('RELAY_TOKEN') ?: $RELAY_TOKEN;
$DATA_DIR = getenv('RELAY_DATA_DIR') ?: __DIR__ . '/data';
$POLL_MS = (int) (getenv('RELAY_POLL_MS') ?: $RELAY_POLL_SECONDS * 1000);

class HttpError extends Exception
{
    public $status;

    public function __construct(int $status, string $message)
    {
        parent::__construct($message);
        $this->status = $status;
    }
}

function send_json(int $status, $body): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-cache');
    header('Access-Control-Allow-Origin: *');
    echo encode($body);
}

function encode($value): string
{
    return json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
}

function now_iso(): string
{
    $t = microtime(true);
    return gmdate('Y-m-d\TH:i:s', (int) $t) . sprintf('.%03dZ', (int) (($t - floor($t)) * 1000));
}

function uuid4(): string
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}

/** Тело запроса как объекты (не массивы), чтобы пустые {} в снимке так и остались {}. */
function read_body(int $limit)
{
    $length = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($length > $limit) throw new HttpError(413, 'Слишком большой запрос');
    $raw = file_get_contents('php://input');
    if (strlen($raw) > $limit) throw new HttpError(413, 'Слишком большой запрос');
    $value = json_decode($raw);
    if (json_last_error() !== JSON_ERROR_NONE) throw new HttpError(400, 'Неверный JSON');
    return $value;
}

function authorized(): bool
{
    global $TOKEN;
    // Часть хостингов не передаёт заголовок Authorization в PHP, поэтому зал шлёт ещё и X-Relay-Token.
    $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if ($auth === '' && function_exists('getallheaders')) {
        foreach (getallheaders() as $name => $value) {
            if (strtolower($name) === 'authorization') $auth = $value;
        }
    }
    if ($auth !== '' && hash_equals("Bearer $TOKEN", $auth)) return true;
    $given = $_SERVER['HTTP_X_RELAY_TOKEN'] ?? '';
    return $given !== '' && hash_equals($TOKEN, $given);
}

function require_auth(): void
{
    if (!authorized()) throw new HttpError(401, 'Неверный токен');
}

// ---------- Хранение ----------

function data_file(string $name): string
{
    global $DATA_DIR;
    return "$DATA_DIR/$name.php";
}

function load_record(string $name)
{
    $raw = @file_get_contents(data_file($name));
    if ($raw === false || strncmp($raw, GUARD, strlen(GUARD)) !== 0) return null;
    return json_decode(substr($raw, strlen(GUARD)));
}

/** Сначала во временный файл, потом переименование: файл не останется недописанным. */
function save_record(string $name, $value): void
{
    $file = data_file($name);
    $tmp = "$file." . bin2hex(random_bytes(4)) . '.tmp.php';
    if (file_put_contents($tmp, GUARD . encode($value)) === false || !rename($tmp, $file)) {
        @unlink($tmp);
        throw new RuntimeException("Не удалось записать $file");
    }
}

/** Чтение-изменение-запись по одному соревнованию идёт строго по очереди. */
function with_lock(string $name, callable $fn)
{
    global $DATA_DIR;
    $lock = fopen("$DATA_DIR/$name.lock", 'c');
    flock($lock, LOCK_EX);
    try {
        return $fn();
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

function remove_dir(string $dir): void
{
    if (!is_dir($dir)) return;
    foreach (scandir($dir) as $item) {
        if ($item === '.' || $item === '..') continue;
        $path = "$dir/$item";
        is_dir($path) ? remove_dir($path) : unlink($path);
    }
    rmdir($dir);
}

// ---------- Результаты ----------

function ingest(string $id): void
{
    require_auth();
    $body = read_body(MAX_BODY_BYTES);
    $snapshot = $body->snapshot ?? null;
    if (
        !is_object($snapshot) || !is_object($snapshot->competition ?? null)
        || !is_string($snapshot->competition->id ?? null) || !is_string($snapshot->competition->name ?? null)
        || !is_string($snapshot->competition->discipline ?? null) || !is_array($snapshot->live ?? null)
        || !is_array($snapshot->categories ?? null) || !is_string($snapshot->generatedAt ?? null)
    ) {
        throw new HttpError(400, 'Неверный формат снимка');
    }
    $approved = $body->approved ?? [];
    if (!is_array($approved)) throw new HttpError(400, 'Неверный формат снимка');
    foreach ($approved as $view) {
        if (!is_object($view) || !is_string($view->id ?? null)) throw new HttpError(400, 'Неверный формат снимка');
    }
    if ($snapshot->competition->id !== $id) throw new HttpError(400, 'Снимок другого соревнования');

    $stale = with_lock("results-$id", function () use ($id, $snapshot, $approved) {
        $record = load_record("results-$id");
        // Запоздавший снимок (повтор после обрыва связи) не должен затирать более свежий.
        if ($record && strcmp($record->snapshot->generatedAt, $snapshot->generatedAt) > 0) return true;
        $seq = ($record->seq ?? 0) + 1;
        $now = time();
        // Утверждённые оценки держим минуту: зритель, заглянувший за это время, увидит их всплывающими.
        $flashes = array_values(array_filter($record->approved ?? [], function ($a) use ($now) {
            return $a->at >= $now - FLASH_TTL;
        }));
        foreach ($approved as $view) $flashes[] = (object) ['seq' => $seq, 'at' => $now, 'view' => $view];
        save_record("results-$id", (object) [
            'snapshot' => $snapshot,
            'updatedAt' => now_iso(),
            'seq' => $seq,
            'approved' => $flashes,
        ]);
        return false;
    });
    send_json(200, $stale ? ['ok' => true, 'stale' => true] : ['ok' => true]);
}

function list_competitions(): void
{
    global $DATA_DIR;
    $list = [];
    foreach (glob("$DATA_DIR/results-*.php") ?: [] as $file) {
        if (substr($file, -8) === '.tmp.php') continue;
        $record = load_record(basename($file, '.php'));
        if (!$record) continue;
        $c = $record->snapshot->competition;
        $list[] = ['id' => $c->id, 'name' => $c->name, 'discipline' => $c->discipline, 'updatedAt' => $record->updatedAt];
    }
    usort($list, function ($a, $b) {
        return strcmp($b['updatedAt'], $a['updatedAt']);
    });
    send_json(200, $list);
}

function competition(string $id): void
{
    $record = load_record("results-$id");
    if (!$record) throw new HttpError(404, 'Результатов этого соревнования пока нет');
    send_json(200, $record->snapshot);
}

/**
 * Поток событий в укороченном виде: отдаём, что изменилось с прошлого раза,
 * и закрываем ответ. Браузер переподключается через retry и присылает
 * Last-Event-ID — номер последнего полученного снимка.
 */
function events(string $id): void
{
    global $POLL_MS;
    http_response_code(200);
    header('Content-Type: text/event-stream; charset=utf-8');
    header('Cache-Control: no-cache, no-transform');
    header('X-Accel-Buffering: no');
    header('Access-Control-Allow-Origin: *');
    echo "retry: $POLL_MS\n\n";
    $record = load_record("results-$id");
    if (!$record) return;
    $header = $_SERVER['HTTP_LAST_EVENT_ID'] ?? '';
    $last = ctype_digit($header) ? (int) $header : -1;
    // Номер больше нашего — данные ретранслятора обнулили: отдаём всё заново.
    if ($last > $record->seq) $last = -1;
    if ($last >= $record->seq) return;
    echo "event: snapshot\nid: {$record->seq}\ndata: " . encode($record->snapshot) . "\n\n";
    if ($last < 0) return;
    $cutoff = time() - FLASH_TTL;
    foreach ($record->approved as $a) {
        if ($a->seq > $last && $a->at >= $cutoff) echo "event: approved\ndata: " . encode($a->view) . "\n\n";
    }
}

// ---------- Онлайн-заявки ----------

/** Строка: обрезает пробелы, проверяет длину. null — поля нет (для необязательных). */
function text($value, int $max, int $min = 0, ?string $missing = null, bool $optional = false): ?string
{
    if ($value === null && $optional) return null;
    if (!is_string($value)) throw new HttpError(400, $missing ?? 'Неверный формат заявки');
    $value = trim($value);
    if (mb_strlen($value) < $min) throw new HttpError(400, $missing ?? 'Неверный формат заявки');
    if (mb_strlen($value) > $max) throw new HttpError(400, "Слишком длинное значение: не больше $max символов");
    return $value;
}

/** Проверка заявки клуба; повторяет onlineEntrySchema из packages/shared. */
function parse_entry($body): array
{
    if (!is_object($body)) throw new HttpError(400, 'Неверный формат заявки');
    $entry = ['club' => text($body->club ?? null, 200, 1, 'Укажите клуб')];
    $city = text($body->city ?? null, 200, 0, null, true);
    if ($city !== null) $entry['city'] = $city;
    $entry['contact'] = text($body->contact ?? null, 300, 3, 'Укажите контакт: ФИО и телефон или почту');
    $comment = text($body->comment ?? null, 1000, 0, null, true);
    if ($comment !== null) $entry['comment'] = $comment;
    $rows = $body->rows ?? null;
    if (!is_array($rows) || count($rows) === 0) throw new HttpError(400, 'Добавьте хотя бы одного участника');
    if (count($rows) > 100) throw new HttpError(400, 'Не больше 100 участников в одной заявке');
    $entry['rows'] = [];
    foreach ($rows as $i => $row) {
        try {
            if (!is_object($row)) throw new HttpError(400, 'Неверный формат заявки');
            $parsed = [
                'lastName' => text($row->lastName ?? null, 100, 1, 'Укажите фамилию'),
                'firstName' => text($row->firstName ?? null, 100, 1, 'Укажите имя'),
            ];
            foreach (['category' => 100, 'team' => 200, 'middleName' => 100, 'birthDate' => 1000, 'city' => 200, 'coach' => 200] as $key => $max) {
                $value = text($row->$key ?? null, $max, 0, null, true);
                if ($value === null) continue;
                if ($key === 'birthDate' && !preg_match('/^(\d{4}|\d{2}\.\d{2}\.\d{4})$/', $value)) {
                    throw new HttpError(400, 'Дата рождения: год (2012) или дата (15.03.2012)');
                }
                $parsed[$key] = $value;
            }
            $entry['rows'][] = $parsed;
        } catch (HttpError $e) {
            throw new HttpError(400, 'Участник ' . ($i + 1) . ': ' . $e->getMessage());
        }
    }
    return $entry;
}

/** Зал публикует приём заявок (PUT) и забирает присланные (GET). */
function hall_entries(string $id): void
{
    require_auth();
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        $saved = load_record("entries-$id");
        send_json(200, ['entries' => $saved->entries ?? []]);
        return;
    }
    $body = read_body(MAX_BODY_BYTES);
    $call = $body->call ?? null;
    $invalid = new HttpError(400, 'Неверный формат приёма заявок');
    if (!is_object($body) || !is_string($body->key ?? null) || strlen($body->key) < 16 || strlen($body->key) > 200 || !is_object($call)) throw $invalid;
    if (!is_string($call->name ?? null) || mb_strlen($call->name) < 1 || mb_strlen($call->name) > 300) throw $invalid;
    if (!in_array($call->discipline ?? null, DISCIPLINES, true) || !is_bool($call->open ?? null)) throw $invalid;
    if (!property_exists($call, 'deadline') || !($call->deadline === null || is_string($call->deadline))) throw $invalid;
    if (!is_array($call->categories ?? null) || count($call->categories) > 100) throw $invalid;
    foreach ($call->categories as $c) if (!is_string($c) || mb_strlen($c) > 100) throw $invalid;
    $decisions = null;
    if (isset($body->decisions)) {
        if (!is_object($body->decisions)) throw $invalid;
        $decisions = new stdClass();
        foreach ($body->decisions as $entryId => $d) {
            if (!is_object($d) || !in_array($d->status ?? null, ['ACCEPTED', 'REJECTED'], true) || !is_string($d->decidedAt ?? null)) throw $invalid;
            if (!property_exists($d, 'note') || !($d->note === null || (is_string($d->note) && mb_strlen($d->note) <= 500))) throw $invalid;
            $decisions->$entryId = ['status' => $d->status, 'note' => $d->note, 'decidedAt' => $d->decidedAt];
        }
    }
    $clean = [
        'name' => $call->name,
        'discipline' => $call->discipline,
        'open' => $call->open,
        'deadline' => $call->deadline,
        'categories' => $call->categories,
    ];
    with_lock("entries-$id", function () use ($id, $body, $clean, $decisions) {
        $current = load_record("entries-$id");
        save_record("entries-$id", [
            'id' => $id,
            'call' => $clean,
            'key' => $body->key,
            'entries' => $current->entries ?? [],
            'decisions' => $decisions ?? $current->decisions ?? new stdClass(),
        ]);
    });
    send_json(200, ['ok' => true]);
}

/** Клуб открывает ссылку (GET), отправляет заявку (POST) и смотрит её статус. */
function club_entry(string $id, string $key, ?string $entryId): void
{
    $saved = load_record("entries-$id");
    if (!$saved || !hash_equals($saved->key, $key)) {
        throw new HttpError(404, 'Ссылка на заявку недействительна: уточните её у организаторов');
    }
    $call = $saved->call;
    if ($entryId !== null) {
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') throw new HttpError(405, 'Метод не поддерживается');
        $entryId = strtolower($entryId);
        foreach (preg_match(UUID_RE, $entryId) ? $saved->entries : [] as $entry) {
            if ($entry->id !== $entryId) continue;
            $decision = $saved->decisions->$entryId ?? null;
            send_json(200, [
                'id' => $entry->id,
                'club' => $entry->club,
                'count' => count($entry->rows),
                'receivedAt' => $entry->receivedAt,
                'status' => $decision->status ?? 'NEW',
                'note' => $decision->note ?? null,
                'decidedAt' => $decision->decidedAt ?? null,
            ]);
            return;
        }
        throw new HttpError(404, 'Заявка с таким номером не найдена');
    }
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        send_json(200, $call);
        return;
    }
    if (!$call->open || ($call->deadline && strtotime($call->deadline) < time())) {
        throw new HttpError(409, 'Приём заявок закрыт');
    }
    $entry = parse_entry(read_body(MAX_ENTRY_BYTES));
    foreach ($entry['rows'] as $row) {
        if (isset($row['category']) && count($call->categories) > 0 && !in_array($row['category'], $call->categories, true)) {
            throw new HttpError(400, "Разряда «{$row['category']}» нет в соревновании");
        }
    }
    $received = $entry + ['id' => uuid4(), 'receivedAt' => now_iso()];
    with_lock("entries-$id", function () use ($id, $received) {
        $saved = load_record("entries-$id");
        if (count($saved->entries) >= MAX_ENTRIES) throw new HttpError(409, 'Заявок слишком много: свяжитесь с организаторами');
        $saved->entries[] = $received;
        save_record("entries-$id", $saved);
    });
    send_json(201, ['id' => $received['id'], 'receivedAt' => $received['receivedAt']]);
}

// ---------- Протоколы ----------

function protocols_dir(string $id): string
{
    global $DATA_DIR;
    return "$DATA_DIR/protocols/$id";
}

function protocols_index(string $id)
{
    $raw = @file_get_contents(protocols_dir($id) . '/index.php');
    if ($raw === false) return null;
    return json_decode(substr($raw, strlen(GUARD)));
}

/** Зал выкладывает протоколы (PUT, заменяя прежние) или снимает их (DELETE). */
function hall_protocols(string $id): void
{
    require_auth();
    $target = protocols_dir($id);
    if ($_SERVER['REQUEST_METHOD'] === 'DELETE') {
        with_lock("protocols-$id", function () use ($target) {
            remove_dir($target);
        });
        send_json(200, ['ok' => true]);
        return;
    }
    @ini_set('memory_limit', '512M');
    $body = read_body(MAX_PROTOCOLS_BYTES);
    $invalid = new HttpError(400, 'Неверный формат протоколов');
    if (!is_object($body) || !is_array($body->files ?? null) || count($body->files) > 300) throw $invalid;
    $names = [];
    foreach ($body->files as $f) {
        if (
            !is_object($f) || !is_string($f->file ?? null) || !preg_match(PROTOCOL_FILE_RE, $f->file)
            || !is_string($f->title ?? null) || mb_strlen($f->title) < 1 || mb_strlen($f->title) > 300
            || !is_string($f->group ?? null) || mb_strlen($f->group) > 100
            || !is_string($f->data ?? null) || !preg_match('/^[A-Za-z0-9+\/]*=*$/', $f->data)
        ) {
            throw $invalid;
        }
        if (isset($names[$f->file])) throw new HttpError(400, 'Имена файлов повторяются');
        $names[$f->file] = true;
    }
    $index = with_lock("protocols-$id", function () use ($target, $body) {
        // Файлы пишутся в новую папку, затем она подменяет старую.
        $tmp = "$target.tmp";
        remove_dir($tmp);
        if (!is_dir(dirname($target))) mkdir(dirname($target), 0755, true);
        mkdir($tmp, 0755);
        $index = ['publishedAt' => now_iso(), 'files' => []];
        foreach ($body->files as $f) {
            $data = base64_decode($f->data);
            file_put_contents("$tmp/{$f->file}", $data);
            $index['files'][] = ['file' => $f->file, 'title' => $f->title, 'group' => $f->group, 'size' => strlen($data)];
        }
        file_put_contents("$tmp/index.php", GUARD . encode($index));
        remove_dir("$target.old");
        if (is_dir($target)) rename($target, "$target.old");
        rename($tmp, $target);
        remove_dir("$target.old");
        return $index;
    });
    send_json(200, $index);
}

function protocol_file(string $id, string $file): void
{
    $index = protocols_index($id);
    $known = false;
    foreach ($index->files ?? [] as $f) if ($f->file === $file) $known = true;
    $path = protocols_dir($id) . "/$file";
    if (!$known || !preg_match(PROTOCOL_FILE_RE, $file) || !is_file($path)) throw new HttpError(404, 'Протокол не найден');
    $pdf = substr($file, -4) === '.pdf';
    header('Content-Type: ' . ($pdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
    header('Content-Disposition: ' . ($pdf ? 'inline' : 'attachment') . "; filename=\"$file\"");
    header('Content-Length: ' . filesize($path));
    header('Cache-Control: no-cache');
    header('Access-Control-Allow-Origin: *');
    if ($_SERVER['REQUEST_METHOD'] !== 'HEAD') readfile($path);
}

// ---------- Маршруты ----------

function route(string $path, string $base)
{
    global $TOKEN, $DATA_DIR;
    $method = $_SERVER['REQUEST_METHOD'];
    $uuid = function (string $id): string {
        if (!preg_match(UUID_RE, $id)) throw new HttpError(404, 'Не найдено');
        return strtolower($id);
    };

    if ($method === 'OPTIONS') {
        http_response_code(204);
        header('Access-Control-Allow-Origin: *');
        header('Access-Control-Allow-Methods: GET');
        header('Access-Control-Max-Age: 86400');
        return;
    }
    if ($path === '/health') {
        send_json(200, ['ok' => true]);
        return;
    }
    if ($path === '' || $path === '/') {
        header("Location: $base/widget/", true, 302);
        return;
    }
    if (strlen($TOKEN) < 16 || strpos($TOKEN, 'ВСТАВЬТЕ') !== false) {
        throw new HttpError(503, 'Ретранслятор не настроен: впишите токен в config.php');
    }
    if (!is_dir($DATA_DIR) && !mkdir($DATA_DIR, 0755, true)) throw new RuntimeException("Нет папки $DATA_DIR");

    if ($method === 'POST' && preg_match('#^/ingest/([^/]+)$#', $path, $m)) return ingest($uuid($m[1]));
    if (preg_match('#^/entries/([^/]+)$#', $path, $m) && in_array($method, ['GET', 'PUT'], true)) return hall_entries($uuid($m[1]));
    if (preg_match('#^/protocols/([^/]+)$#', $path, $m) && in_array($method, ['PUT', 'DELETE'], true)) return hall_protocols($uuid($m[1]));
    if (preg_match('#^/api/entries/([^/]+)(?:/([^/]+))?$#', $path, $m) && in_array($method, ['GET', 'POST'], true)) {
        return club_entry($uuid($m[1]), (string) ($_GET['k'] ?? ''), isset($m[2]) ? $m[2] : null);
    }
    if ($method !== 'GET' && $method !== 'HEAD') throw new HttpError(405, 'Метод не поддерживается');
    if ($path === '/api/competitions') return list_competitions();
    if (preg_match('#^/api/competitions/([^/]+)/protocols(?:/([^/]+))?$#', $path, $m)) {
        $id = $uuid($m[1]);
        if (!isset($m[2])) {
            send_json(200, protocols_index($id) ?? ['publishedAt' => null, 'files' => []]);
            return;
        }
        return protocol_file($id, rawurldecode($m[2]));
    }
    if (preg_match('#^/api/competitions/([^/]+)(/events)?$#', $path, $m)) {
        $id = $uuid($m[1]);
        return isset($m[2]) ? events($id) : competition($id);
    }
    throw new HttpError(404, 'Не найдено');
}

// Адрес относительно папки ретранслятора: он может стоять не в корне сайта.
$base = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'])), '/');
$path = (string) parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($base !== '' && strpos($path, $base) === 0) $path = substr($path, strlen($base));
if ($path === '/index.php') $path = '/';

try {
    route($path, $base);
} catch (HttpError $e) {
    send_json($e->status, ['message' => $e->getMessage()]);
} catch (Throwable $e) {
    error_log((string) $e);
    send_json(500, ['message' => 'Внутренняя ошибка']);
}
