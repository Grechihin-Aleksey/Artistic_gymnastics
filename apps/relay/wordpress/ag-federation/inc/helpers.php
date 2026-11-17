<?php
/**
 * Даты по-русски, стадия соревнования и обращения к ретранслятору результатов.
 */

if (!defined('ABSPATH')) {
    exit;
}

const AG_UUID_RE = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';

/** Месяцы в родительном падеже: «5 декабря». */
function ag_month_gen($n)
{
    $m = array(1 => 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря');
    return $m[(int) $n] ?? '';
}

function ag_month_short($n)
{
    $m = array(1 => 'янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек');
    return $m[(int) $n] ?? '';
}

/** Сегодня по часовому поясу сайта, Y-m-d. */
function ag_today()
{
    return wp_date('Y-m-d');
}

/** Дата Y-m-d → массив [год, месяц, день] или null. */
function ag_parse_date($date)
{
    if (!is_string($date) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $date, $m)) {
        return null;
    }
    return array((int) $m[1], (int) $m[2], (int) $m[3]);
}

/**
 * Даты соревнования одной строкой: «5–7 декабря», «30 ноября – 2 декабря»,
 * год добавляется, если он не текущий.
 */
function ag_date_range($start, $end, $with_year = null)
{
    $s = ag_parse_date($start);
    $e = ag_parse_date($end) ?: $s;
    if (!$s) {
        return '';
    }
    if ($with_year === null) {
        $with_year = $s[0] !== (int) wp_date('Y') || $e[0] !== $s[0];
    }
    $year = $with_year ? ' ' . $e[0] : '';
    if ($s === $e) {
        return $s[2] . ' ' . ag_month_gen($s[1]) . $year;
    }
    if ($s[0] === $e[0] && $s[1] === $e[1]) {
        return $s[2] . '–' . $e[2] . ' ' . ag_month_gen($s[1]) . $year;
    }
    $syear = $s[0] !== $e[0] ? ' ' . $s[0] : '';
    return $s[2] . ' ' . ag_month_gen($s[1]) . $syear . ' – ' . $e[2] . ' ' . ag_month_gen($e[1]) . $year;
}

/** Две строки для «плашки» даты в календаре: «5–7» и «дек». */
function ag_date_badge($start, $end)
{
    $s = ag_parse_date($start);
    $e = ag_parse_date($end) ?: $s;
    if (!$s) {
        return array('—', '');
    }
    if ($s === $e) {
        return array((string) $s[2], ag_month_gen($s[1]));
    }
    if ($s[1] === $e[1]) {
        return array($s[2] . '–' . $e[2], ag_month_gen($s[1]));
    }
    return array($s[2] . '–' . $e[2], ag_month_short($s[1]) . ' – ' . ag_month_short($e[1]));
}

/** «через 18 дней», «завтра», «сегодня». */
function ag_days_until($date)
{
    $d = ag_parse_date($date);
    if (!$d) {
        return '';
    }
    $days = (int) round((strtotime($date . ' 00:00:00 UTC') - strtotime(ag_today() . ' 00:00:00 UTC')) / DAY_IN_SECONDS);
    if ($days <= 0) {
        return 'сегодня';
    }
    if ($days === 1) {
        return 'завтра';
    }
    return 'через ' . $days . ' ' . ag_plural($days, 'день', 'дня', 'дней');
}

function ag_plural($n, $one, $few, $many)
{
    $n = abs((int) $n) % 100;
    $n1 = $n % 10;
    if ($n > 10 && $n < 20) {
        return $many;
    }
    if ($n1 > 1 && $n1 < 5) {
        return $few;
    }
    if ($n1 === 1) {
        return $one;
    }
    return $many;
}

/** Оценка с тремя знаками после запятой: 13,450. */
function ag_score($value)
{
    return number_format((float) $value, 3, ',', ' ');
}

/** Пол соревнования для подписи. */
function ag_gender_label($gender)
{
    $labels = array('girls' => 'Девушки', 'boys' => 'Юноши', 'both' => 'Девушки и юноши');
    return $labels[$gender] ?? '';
}

/** Названия снарядов: полные и короткие, как в зале. */
function ag_apparatus_name($code, $short = false)
{
    $full = array(
        'FX' => 'Вольные упражнения', 'PH' => 'Конь', 'SR' => 'Кольца', 'VT' => 'Опорный прыжок',
        'PB' => 'Брусья', 'HB' => 'Перекладина', 'UB' => 'Брусья разной высоты', 'BB' => 'Бревно',
    );
    $abbr = array('FX' => 'ВУ', 'PH' => 'КН', 'SR' => 'КЛ', 'VT' => 'ОП', 'PB' => 'БР', 'HB' => 'ПК', 'UB' => 'БР', 'BB' => 'БВ');
    return $short ? ($abbr[$code] ?? $code) : ($full[$code] ?? $code);
}

/* ------------------------------------------------------------------ */
/* Соревнование: поля и стадия                                          */
/* ------------------------------------------------------------------ */

/** Все поля соревнования одним массивом. */
function ag_competition($post = null)
{
    $post = get_post($post);
    if (!$post) {
        return null;
    }
    $id = $post->ID;
    $start = (string) get_post_meta($id, '_ag_start', true);
    $end = (string) get_post_meta($id, '_ag_end', true);
    if ($end === '' || $end < $start) {
        $end = $start;
    }
    return array(
        'post' => $post,
        'start' => $start,
        'end' => $end,
        'venue' => (string) get_post_meta($id, '_ag_venue', true),
        'city' => (string) get_post_meta($id, '_ag_city', true),
        'gender' => (string) get_post_meta($id, '_ag_gender', true),
        'levels' => (string) get_post_meta($id, '_ag_levels', true),
        'ids' => ag_competition_ids($id),
        'entry_key' => (string) get_post_meta($id, '_ag_entry_key', true),
        'deadline' => (string) get_post_meta($id, '_ag_deadline', true),
        'stage_override' => (string) get_post_meta($id, '_ag_stage', true),
        'program' => (string) get_post_meta($id, '_ag_program', true),
        'docs' => array_filter(array_map('intval', explode(',', (string) get_post_meta($id, '_ag_docs', true)))),
        'board_theme' => get_post_meta($id, '_ag_board_theme', true) === 'light' ? 'light' : 'dark',
    );
}

/** ID соревнований из программы (до четырёх частей турнира), только правильные UUID. */
function ag_competition_ids($post_id)
{
    $raw = (string) get_post_meta($post_id, '_ag_ids', true);
    $ids = array();
    foreach (preg_split('/[\s,;]+/', $raw) as $id) {
        $id = strtolower(trim($id));
        if ($id !== '' && preg_match(AG_UUID_RE, $id)) {
            $ids[] = $id;
        }
    }
    return array_slice(array_values(array_unique($ids)), 0, 4);
}

/**
 * Стадия: before — до старта, live — идёт, done — завершено.
 * Определяется по датам, редактор может задать вручную (например, перенос).
 */
function ag_stage($c)
{
    if (in_array($c['stage_override'], array('before', 'live', 'done'), true)) {
        return $c['stage_override'];
    }
    $today = ag_today();
    if ($c['start'] === '' || $today < $c['start']) {
        return 'before';
    }
    if ($today <= $c['end']) {
        return 'live';
    }
    return 'done';
}

/**
 * Приём заявок: ссылка на форму и открыт ли он. Сведения о сроке берутся с ретранслятора
 * (их задаёт секретариат), а если он недоступен — из поля «Заявки до».
 */
function ag_entry_info($c)
{
    if ($c['entry_key'] === '' || !$c['ids'] || !preg_match('/^[A-Za-z0-9_-]{16,128}$/', $c['entry_key'])) {
        return null;
    }
    $id = $c['ids'][0];
    $url = ag_relay_base() . '/entry/index.html#c=' . rawurlencode($id) . '&k=' . rawurlencode($c['entry_key']);
    $call = ag_relay_get('/api/entries/' . $id . '?k=' . rawurlencode($c['entry_key']), 5 * MINUTE_IN_SECONDS);
    $deadline = $c['deadline'];
    $open = null;
    if (is_array($call)) {
        $open = !empty($call['open']);
        if (!empty($call['deadline'])) {
            $deadline = wp_date('Y-m-d', strtotime($call['deadline']));
            if (strtotime($call['deadline']) < time()) {
                $open = false;
            }
        }
    }
    if ($open === null) {
        $open = ag_stage($c) === 'before' && ($deadline === '' || $deadline >= ag_today());
    }
    return array('url' => $url, 'open' => $open, 'deadline' => $deadline);
}

/* ------------------------------------------------------------------ */
/* Ретранслятор результатов                                            */
/* ------------------------------------------------------------------ */

/**
 * Адрес ретранслятора без «/» в конце. Порядок: настройка темы, настройка плагина
 * «Табло результатов», папка results этого сайта.
 */
function ag_relay_base()
{
    $base = trim((string) get_theme_mod('ag_relay_base', ''));
    if ($base === '') {
        $base = trim((string) get_option('ag_results_base', ''));
    }
    if ($base === '') {
        $base = home_url('/results/');
    }
    return rtrim($base, '/');
}

/**
 * GET к ретранслятору с кэшем. Ответ — разобранный JSON (массив) или null.
 * Неудачный ответ тоже запоминается ненадолго, чтобы недоступный ретранслятор
 * не замедлял каждую страницу.
 */
function ag_relay_get($path, $ttl = 60)
{
    $key = 'ag_relay_' . md5(ag_relay_base() . $path);
    $cached = get_transient($key);
    if (is_array($cached)) {
        return $cached['ok'] ? $cached['data'] : null;
    }
    $response = wp_remote_get(ag_relay_base() . $path, array('timeout' => 4, 'headers' => array('Accept' => 'application/json')));
    $data = null;
    if (!is_wp_error($response) && wp_remote_retrieve_response_code($response) === 200) {
        $decoded = json_decode(wp_remote_retrieve_body($response), true);
        if (is_array($decoded)) {
            $data = $decoded;
        }
    }
    set_transient($key, array('ok' => $data !== null, 'data' => $data), $data !== null ? $ttl : min($ttl, 60));
    return $data;
}

/** Последний снимок результатов соревнования из программы. */
function ag_relay_snapshot($id, $ttl = 60)
{
    return ag_relay_get('/api/competitions/' . $id, $ttl);
}

/** Выложенные секретариатом протоколы: [['title','group','url','ext','size'], …]. */
function ag_relay_protocols($id, $ttl = 300)
{
    $index = ag_relay_get('/api/competitions/' . $id . '/protocols', $ttl);
    if (!is_array($index) || empty($index['files']) || !is_array($index['files'])) {
        return array();
    }
    $out = array();
    foreach ($index['files'] as $f) {
        if (!is_array($f) || empty($f['file']) || !preg_match('/^[A-Za-z0-9._-]{1,120}$/', $f['file'])) {
            continue;
        }
        $out[] = array(
            'title' => (string) ($f['title'] ?? $f['file']),
            'group' => (string) ($f['group'] ?? ''),
            'url' => ag_relay_base() . '/api/competitions/' . $id . '/protocols/' . rawurlencode($f['file']),
            'ext' => strtoupper(pathinfo($f['file'], PATHINFO_EXTENSION)),
            'size' => (int) ($f['size'] ?? 0),
        );
    }
    return $out;
}

/** Размер файла по-русски: «640 КБ», «1,2 МБ». */
function ag_file_size($bytes)
{
    $bytes = (int) $bytes;
    if ($bytes <= 0) {
        return '';
    }
    if ($bytes < 1024 * 1024) {
        return max(1, (int) round($bytes / 1024)) . ' КБ';
    }
    return number_format($bytes / 1024 / 1024, 1, ',', '') . ' МБ';
}

/**
 * Призёры из снимка: многоборье по каждому разряду и командное первенство.
 * Возвращает [['title' => 'Многоборье · КМС', 'rows' => [[place, name, detail, total]]], …].
 */
function ag_podiums_from_snapshot($snapshot, $prefix = '')
{
    $out = array();
    if (!is_array($snapshot) || empty($snapshot['categories'])) {
        return $out;
    }
    $cats = $snapshot['categories'];
    foreach ($cats as $cat) {
        $label = trim($prefix . ' ' . (count($cats) > 1 || !empty($cat['name']) ? (string) ($cat['name'] ?? '') : ''));
        $rows = array();
        foreach ((array) ($cat['allAround'] ?? array()) as $row) {
            if ((int) ($row['rank'] ?? 0) < 1 || (int) $row['rank'] > 3) {
                continue;
            }
            $g = (array) ($row['gymnast'] ?? array());
            $rows[] = array((int) $row['rank'], trim(($g['lastName'] ?? '') . ' ' . ($g['firstName'] ?? '')), (string) ($g['club'] ?? ''), (float) ($row['total'] ?? 0));
        }
        if ($rows) {
            $out[] = array('title' => 'Многоборье' . ($label !== '' ? ' · ' . $label : ''), 'rows' => $rows);
        }
        $teams = array();
        foreach ((array) ($cat['teams'] ?? array()) as $row) {
            if ((int) ($row['rank'] ?? 0) < 1 || (int) $row['rank'] > 3) {
                continue;
            }
            $teams[] = array((int) $row['rank'], (string) ($row['team']['name'] ?? 'Команда'), '', (float) ($row['total'] ?? 0));
        }
        if ($teams) {
            $out[] = array('title' => 'Командное первенство' . ($label !== '' ? ' · ' . $label : ''), 'rows' => $teams);
        }
    }
    return $out;
}

/** Призёры соревнования: из сохранённых на сайте результатов, а если их нет — со свежего снимка. */
function ag_competition_podiums($c)
{
    if (function_exists('ag_archive_podiums')) {
        $saved = ag_archive_podiums($c['post']->ID);
        if ($saved) {
            return $saved;
        }
    }
    $out = array();
    $many = count($c['ids']) > 1;
    foreach ($c['ids'] as $id) {
        $snap = ag_relay_snapshot($id, ag_stage($c) === 'done' ? 6 * HOUR_IN_SECONDS : 60);
        $prefix = '';
        if ($many && is_array($snap)) {
            $prefix = (($snap['competition']['discipline'] ?? '') === 'MAG') ? 'юноши' : 'девушки';
        }
        $out = array_merge($out, ag_podiums_from_snapshot($snap, $prefix));
    }
    return $out;
}

/** Протоколы всех частей турнира. */
function ag_competition_protocols($c)
{
    $out = array();
    foreach ($c['ids'] as $id) {
        $out = array_merge($out, ag_relay_protocols($id, ag_stage($c) === 'done' ? HOUR_IN_SECONDS : 120));
    }
    return $out;
}

/* ------------------------------------------------------------------ */
/* Поиск соревнований                                                  */
/* ------------------------------------------------------------------ */

/** Соревнование, которое идёт сегодня (первое по дате начала), или null. */
function ag_live_competition()
{
    static $cache = false;
    if ($cache !== false) {
        return $cache;
    }
    $today = ag_today();
    $q = new WP_Query(array(
        'post_type' => 'ag_competition',
        'posts_per_page' => 10,
        'no_found_rows' => true,
        'meta_key' => '_ag_start',
        'orderby' => 'meta_value',
        'order' => 'ASC',
        'meta_query' => array(
            'relation' => 'OR',
            array('key' => '_ag_stage', 'value' => 'live'),
            array(
                'relation' => 'AND',
                array('key' => '_ag_start', 'value' => $today, 'compare' => '<='),
                array('key' => '_ag_end', 'value' => $today, 'compare' => '>='),
            ),
        ),
    ));
    $cache = null;
    foreach ($q->posts as $p) {
        $c = ag_competition($p);
        if (ag_stage($c) === 'live') {
            $cache = $c;
            break;
        }
    }
    return $cache;
}

/**
 * Соревнования для календаря.
 * $period: upcoming — идущие и будущие по возрастанию даты, past — завершённые, новые сверху.
 */
function ag_competitions_query($period = 'upcoming', $args = array())
{
    return new WP_Query(ag_competitions_args($period, $args));
}

/** Параметры WP_Query для календаря: ими же настраивается основной запрос архива /competitions/. */
function ag_competitions_args($period = 'upcoming', $args = array())
{
    $today = ag_today();
    $meta = array();
    if ($period === 'past') {
        $meta[] = array('key' => '_ag_end', 'value' => $today, 'compare' => '<');
    } else {
        $meta[] = array('key' => '_ag_end', 'value' => $today, 'compare' => '>=');
    }
    if (!empty($args['gender']) && in_array($args['gender'], array('girls', 'boys'), true)) {
        $meta[] = array('key' => '_ag_gender', 'value' => array($args['gender'], 'both'), 'compare' => 'IN');
    }
    if (!empty($args['entries'])) {
        $meta[] = array('key' => '_ag_entry_key', 'value' => '', 'compare' => '!=');
    }
    $query = array(
        'post_type' => 'ag_competition',
        'posts_per_page' => $args['per_page'] ?? 20,
        'paged' => $args['paged'] ?? 1,
        'meta_key' => '_ag_start',
        'orderby' => 'meta_value',
        'order' => $period === 'past' ? 'DESC' : 'ASC',
        'meta_query' => $meta,
    );
    if (!empty($args['year'])) {
        $y = (int) $args['year'];
        $query['meta_query'][] = array('key' => '_ag_start', 'value' => array($y . '-01-01', $y . '-12-31'), 'compare' => 'BETWEEN');
    }
    return $query;
}

/** Ссылка «Табло онлайн» в шапке: идущий турнир или календарь. */
function ag_live_url()
{
    $live = ag_live_competition();
    return $live ? get_permalink($live['post']) . '#live' : get_post_type_archive_link('ag_competition');
}
