<?php
/**
 * Этап 2: результаты копятся на сайте.
 *
 * Когда соревнование завершено, тема забирает с ретранслятора итоговый снимок результатов
 * и раскладывает его в таблицу {prefix}ag_results: многоборье, оценки на снарядах, финалы,
 * командный зачёт. Для каждого участника заводится запись «Спортсмен» (ag_athlete) — у неё
 * своя страница с историей выступлений и лучшими оценками. Клуб на своей странице видит
 * своих спортсменов и их медали.
 *
 * Сохранение запускается само (раз в час для недавно завершённых турниров) и кнопкой
 * «Сохранить результаты на сайте» в карточке соревнования.
 */

if (!defined('ABSPATH')) {
    exit;
}

const AG_ARCHIVE_DB_VERSION = '1';

function ag_results_table()
{
    global $wpdb;
    return $wpdb->prefix . 'ag_results';
}

/** Таблица результатов: создаётся при включении темы и при обновлении её схемы. */
function ag_archive_install()
{
    global $wpdb;
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    $table = ag_results_table();
    $charset = $wpdb->get_charset_collate();
    dbDelta("CREATE TABLE $table (
        id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
        competition bigint(20) unsigned NOT NULL,
        source char(36) NOT NULL,
        athlete bigint(20) unsigned NOT NULL DEFAULT 0,
        club varchar(190) NOT NULL DEFAULT '',
        category varchar(190) NOT NULL DEFAULT '',
        kind varchar(8) NOT NULL,
        apparatus varchar(4) NOT NULL DEFAULT '',
        stage varchar(8) NOT NULL DEFAULT '',
        place smallint(5) unsigned DEFAULT NULL,
        d decimal(7,3) DEFAULT NULL,
        e decimal(7,3) DEFAULT NULL,
        total decimal(8,3) NOT NULL DEFAULT 0,
        earned varchar(60) NOT NULL DEFAULT '',
        PRIMARY KEY  (id),
        KEY competition (competition),
        KEY athlete (athlete)
    ) $charset;");
    update_option('ag_archive_db', AG_ARCHIVE_DB_VERSION);
}

function ag_archive_maybe_install()
{
    if (get_option('ag_archive_db') !== AG_ARCHIVE_DB_VERSION) {
        ag_archive_install();
    }
}
add_action('init', 'ag_archive_maybe_install', 5);
add_action('after_switch_theme', 'ag_archive_install');

function ag_register_athletes()
{
    register_post_type('ag_athlete', array(
        'labels' => array(
            'name' => 'Спортсмены',
            'singular_name' => 'Спортсмен',
            'add_new' => 'Добавить спортсмена',
            'add_new_item' => 'Новый спортсмен',
            'edit_item' => 'Изменить спортсмена',
            'all_items' => 'Все спортсмены',
            'search_items' => 'Найти спортсмена',
            'not_found' => 'Спортсменов пока нет: они появятся сами после первых сохранённых результатов',
        ),
        'public' => true,
        'has_archive' => 'athletes',
        'rewrite' => array('slug' => 'athletes', 'with_front' => false),
        'menu_icon' => 'dashicons-universal-access',
        'menu_position' => 6,
        'supports' => array('title', 'editor', 'thumbnail'),
        'show_in_rest' => true,
    ));
}
add_action('init', 'ag_register_athletes');

/* ------------------------------------------------------------------ */
/* Имена и клубы                                                        */
/* ------------------------------------------------------------------ */

/** Строка для сравнения: строчные буквы, ё → е, без кавычек и лишних пробелов. */
function ag_norm($s)
{
    $s = mb_strtolower(trim((string) $s), 'UTF-8');
    $s = str_replace(array('ё', '«', '»', '"', '“', '”', '„', "'", '.'), array('е', '', '', '', '', '', '', '', ' '), $s);
    return trim(preg_replace('/\s+/u', ' ', $s));
}

/** Клуб на сайте по названию из протокола: по заголовку записи клуба или по «Как называется в протоколах». */
function ag_club_by_name($name)
{
    static $map = null;
    if ($map === null) {
        $map = array();
        foreach (get_posts(array('post_type' => 'ag_club', 'posts_per_page' => 500, 'post_status' => 'publish')) as $club) {
            $map[ag_norm($club->post_title)] = $club->ID;
            foreach (explode(',', (string) get_post_meta($club->ID, '_ag_aliases', true)) as $alias) {
                if (ag_norm($alias) !== '') {
                    $map[ag_norm($alias)] = $club->ID;
                }
            }
        }
    }
    return $map[ag_norm($name)] ?? 0;
}

/** Все написания клуба: название и псевдонимы, в нормальной форме. */
function ag_club_names($club_id)
{
    $names = array(ag_norm(get_the_title($club_id)));
    foreach (explode(',', (string) get_post_meta($club_id, '_ag_aliases', true)) as $alias) {
        if (ag_norm($alias) !== '') {
            $names[] = ag_norm($alias);
        }
    }
    return array_values(array_unique($names));
}

/**
 * Спортсмен по фамилии, имени, полу и клубу. Однофамильцы-тёзки из разных клубов —
 * разные люди, пока редактор не объединит их вручную («Объединить с…» в карточке спортсмена).
 */
function ag_find_or_create_athlete($first, $last, $gender, $club)
{
    $name = trim($last . ' ' . $first);
    if ($name === '') {
        return 0;
    }
    $key = ag_norm($name) . '|' . $gender;
    $found = get_posts(array(
        'post_type' => 'ag_athlete',
        'post_status' => array('publish', 'draft', 'private'),
        'posts_per_page' => 20,
        'fields' => 'ids',
        'meta_key' => '_ag_key',
        'meta_value' => $key,
    ));
    $club_n = ag_norm($club);
    foreach ($found as $id) {
        $clubs = (array) get_post_meta($id, '_ag_clubs', false);
        if (in_array($club_n, array_map('ag_norm', $clubs), true)) {
            return (int) $id;
        }
    }
    $id = wp_insert_post(array(
        'post_type' => 'ag_athlete',
        'post_status' => 'publish',
        'post_title' => $name,
    ), true);
    if (is_wp_error($id)) {
        return 0;
    }
    update_post_meta($id, '_ag_key', $key);
    update_post_meta($id, '_ag_gender', $gender);
    if ($club !== '') {
        add_post_meta($id, '_ag_clubs', $club);
        update_post_meta($id, '_ag_club', $club);
    }
    return (int) $id;
}

/* ------------------------------------------------------------------ */
/* Сохранение результатов                                               */
/* ------------------------------------------------------------------ */

/**
 * Сохраняет итоговые результаты соревнования с ретранслятора. Прежние строки этого
 * соревнования заменяются, так что повторный запуск безопасен (например, после исправления оценки).
 * Возвращает число сохранённых строк или WP_Error.
 */
function ag_archive_import($post_id, $force = false)
{
    global $wpdb;
    $c = ag_competition($post_id);
    if (!$c || !$c['ids']) {
        return new WP_Error('ag_no_ids', 'У соревнования не указан ID из программы.');
    }
    $saved = 0;
    $got = false;
    foreach ($c['ids'] as $source) {
        // Свежий снимок, мимо кэша страниц.
        delete_transient('ag_relay_' . md5(ag_relay_base() . '/api/competitions/' . $source));
        $snap = ag_relay_snapshot($source, 60);
        if (!is_array($snap) || empty($snap['categories'])) {
            continue;
        }
        $got = true;
        $stamp = (string) ($snap['generatedAt'] ?? '');
        $meta_key = '_ag_imported_' . $source;
        if (!$force && $stamp !== '' && get_post_meta($post_id, $meta_key, true) === $stamp) {
            $saved += (int) $wpdb->get_var($wpdb->prepare('SELECT COUNT(*) FROM ' . ag_results_table() . ' WHERE competition = %d AND source = %s', $post_id, $source));
            continue;
        }
        $rows = ag_archive_rows($snap);
        $wpdb->delete(ag_results_table(), array('competition' => $post_id, 'source' => $source), array('%d', '%s'));
        foreach ($rows as $row) {
            $row['competition'] = $post_id;
            $row['source'] = $source;
            $wpdb->insert(ag_results_table(), $row);
            $saved++;
        }
        update_post_meta($post_id, $meta_key, $stamp);
    }
    if (!$got) {
        return new WP_Error('ag_no_snapshot', 'Ретранслятор не отдал результаты этого соревнования. Проверьте ID и адрес ретранслятора.');
    }
    update_post_meta($post_id, '_ag_archived', current_time('mysql'));
    wp_cache_delete('ag_archive_' . $post_id, 'ag');
    // Черновик новости «Итоги» и анонс в соцсетях (inc/summary.php).
    do_action('ag_archive_imported', $post_id);
    return $saved;
}

/** Строки таблицы из снимка результатов. */
function ag_archive_rows($snap)
{
    $gender = (($snap['competition']['discipline'] ?? '') === 'MAG') ? 'boys' : 'girls';
    $final = (($snap['competition']['phase'] ?? '') === 'FINAL');
    $num = function ($v) {
        return is_numeric($v) ? round((float) $v, 3) : null;
    };
    $rows = array();
    $people = array();
    $athlete = function ($g) use (&$people, $gender) {
        $gid = (string) ($g['id'] ?? '');
        if (!isset($people[$gid])) {
            $people[$gid] = ag_find_or_create_athlete((string) ($g['firstName'] ?? ''), (string) ($g['lastName'] ?? ''), $gender, (string) ($g['club'] ?? ''));
        }
        return $people[$gid];
    };
    foreach ((array) $snap['categories'] as $cat) {
        $category = (string) ($cat['name'] ?? '');
        foreach ((array) ($cat['allAround'] ?? array()) as $r) {
            $g = (array) ($r['gymnast'] ?? array());
            $id = $athlete($g);
            if (!$id) {
                continue;
            }
            $base = array('athlete' => $id, 'club' => mb_substr((string) ($g['club'] ?? ''), 0, 190), 'category' => mb_substr($category, 0, 190));
            $rows[] = $base + array(
                'kind' => 'aa', 'apparatus' => '', 'stage' => '',
                'place' => !empty($r['complete']) ? (int) $r['rank'] : null,
                'd' => null, 'e' => null, 'total' => (float) ($r['total'] ?? 0),
                'earned' => mb_substr((string) ($r['earned'] ?? ''), 0, 60),
            );
            // В финалах таблицы снарядов показывают финальные оценки, а оценки многоборья остаются здесь.
            if ($final) {
                foreach ((array) ($r['apparatus'] ?? array()) as $app => $s) {
                    $rows[] = $base + array('kind' => 'app', 'apparatus' => (string) $app, 'stage' => 'qual', 'place' => null, 'd' => $num($s['d'] ?? null), 'e' => $num($s['e'] ?? null), 'total' => (float) ($s['total'] ?? 0), 'earned' => '');
                }
            }
        }
        foreach ((array) ($cat['apparatus'] ?? array()) as $app => $list) {
            foreach ((array) $list as $r) {
                $g = (array) ($r['gymnast'] ?? array());
                $id = $athlete($g);
                if (!$id || empty($r['score'])) {
                    continue;
                }
                $rows[] = array(
                    'athlete' => $id, 'club' => mb_substr((string) ($g['club'] ?? ''), 0, 190), 'category' => mb_substr($category, 0, 190),
                    'kind' => 'app', 'apparatus' => (string) $app, 'stage' => $final ? 'final' : 'qual',
                    'place' => (int) ($r['rank'] ?? 0) ?: null,
                    'd' => $num($r['score']['d'] ?? null), 'e' => $num($r['score']['e'] ?? null), 'total' => (float) ($r['score']['total'] ?? 0), 'earned' => '',
                );
            }
        }
        foreach ((array) ($cat['teams'] ?? array()) as $r) {
            $rows[] = array(
                'athlete' => 0, 'club' => mb_substr((string) ($r['team']['name'] ?? 'Команда'), 0, 190), 'category' => mb_substr($category, 0, 190),
                'kind' => 'team', 'apparatus' => '', 'stage' => '', 'place' => (int) ($r['rank'] ?? 0) ?: null,
                'd' => null, 'e' => null, 'total' => (float) ($r['total'] ?? 0), 'earned' => '',
            );
        }
    }
    return $rows;
}

/** Раз в час: сохранить результаты турниров, завершённых за последние 30 дней (и ещё не сохранённых). */
function ag_archive_cron()
{
    $from = wp_date('Y-m-d', time() - 30 * DAY_IN_SECONDS);
    $q = get_posts(array(
        'post_type' => 'ag_competition',
        'posts_per_page' => 20,
        'fields' => 'ids',
        'meta_query' => array(
            array('key' => '_ag_end', 'value' => array($from, ag_today()), 'compare' => 'BETWEEN'),
            array('key' => '_ag_ids', 'compare' => 'EXISTS'),
        ),
    ));
    foreach ($q as $id) {
        if (ag_stage(ag_competition($id)) === 'done') {
            ag_archive_import($id);
        }
    }
}
add_action('ag_archive_cron', 'ag_archive_cron');

function ag_archive_schedule()
{
    if (!wp_next_scheduled('ag_archive_cron')) {
        wp_schedule_event(time() + 300, 'hourly', 'ag_archive_cron');
    }
}
add_action('init', 'ag_archive_schedule');

function ag_archive_unschedule()
{
    wp_clear_scheduled_hook('ag_archive_cron');
}
add_action('switch_theme', 'ag_archive_unschedule');

/* ------------------------------------------------------------------ */
/* Админка: кнопка сохранения, объединение спортсменов                  */
/* ------------------------------------------------------------------ */

function ag_archive_boxes()
{
    add_meta_box('ag_archive', 'Результаты на сайте', 'ag_archive_box', 'ag_competition', 'side');
    add_meta_box('ag_athlete_merge', 'Это один и тот же человек?', 'ag_athlete_merge_box', 'ag_athlete', 'side');
}
add_action('add_meta_boxes', 'ag_archive_boxes');

function ag_archive_box($post)
{
    global $wpdb;
    $count = (int) $wpdb->get_var($wpdb->prepare('SELECT COUNT(*) FROM ' . ag_results_table() . ' WHERE competition = %d', $post->ID));
    $when = (string) get_post_meta($post->ID, '_ag_archived', true);
    if ($count) {
        echo '<p>Сохранено строк: <b>' . (int) $count . '</b>' . ($when !== '' ? '<br>Обновлено: ' . esc_html(mysql2date('d.m.Y H:i', $when)) : '') . '</p>';
    } else {
        echo '<p>Результаты ещё не сохранены. После окончания турнира это произойдёт само в течение часа.</p>';
    }
    if ($post->post_status === 'publish' && ag_competition_ids($post->ID)) {
        $url = wp_nonce_url(admin_url('admin-post.php?action=ag_archive_import&post=' . $post->ID), 'ag_archive_import_' . $post->ID);
        echo '<p><a class="button" href="' . esc_url($url) . '">' . ($count ? 'Обновить результаты' : 'Сохранить результаты сейчас') . '</a></p>';
        echo '<p class="description">Берёт итоговые оценки с ретранслятора, заводит страницы спортсменов.</p>';
    }
    if (function_exists('ag_summary_box_line')) {
        ag_summary_box_line($post);
    }
}

function ag_archive_import_action()
{
    $post_id = isset($_GET['post']) ? absint($_GET['post']) : 0;
    check_admin_referer('ag_archive_import_' . $post_id);
    if (!current_user_can('edit_post', $post_id)) {
        wp_die('Недостаточно прав');
    }
    $result = ag_archive_import($post_id, true);
    $msg = is_wp_error($result) ? 'err:' . $result->get_error_message() : 'ok:' . $result;
    set_transient('ag_archive_notice_' . get_current_user_id(), $msg, 60);
    wp_safe_redirect(get_edit_post_link($post_id, 'url'));
    exit;
}
add_action('admin_post_ag_archive_import', 'ag_archive_import_action');

function ag_archive_notice()
{
    $key = 'ag_archive_notice_' . get_current_user_id();
    $msg = get_transient($key);
    if (!$msg) {
        return;
    }
    delete_transient($key);
    list($kind, $text) = explode(':', $msg, 2);
    if ($kind === 'msg') {
        echo '<div class="notice notice-success is-dismissible"><p>' . esc_html($text) . '</p></div>';
    } elseif ($kind === 'ok') {
        echo '<div class="notice notice-success is-dismissible"><p>Результаты сохранены на сайте: ' . (int) $text . ' ' . esc_html(ag_plural((int) $text, 'строка', 'строки', 'строк')) . '. Страницы спортсменов обновлены.</p></div>';
    } else {
        echo '<div class="notice notice-error"><p>' . esc_html($text) . '</p></div>';
    }
}
add_action('admin_notices', 'ag_archive_notice');

function ag_athlete_merge_box($post)
{
    wp_nonce_field('ag_merge_' . $post->ID, 'ag_merge_nonce');
    $key = (string) get_post_meta($post->ID, '_ag_key', true);
    $name = explode('|', $key)[0] ?? '';
    $same = $name === '' ? array() : get_posts(array(
        'post_type' => 'ag_athlete', 'posts_per_page' => 20, 'post__not_in' => array($post->ID),
        'meta_query' => array(array('key' => '_ag_key', 'value' => $name . '|', 'compare' => 'LIKE')),
    ));
    $clubs = implode(', ', array_unique((array) get_post_meta($post->ID, '_ag_clubs', false)));
    echo '<p>Клубы в протоколах: <b>' . esc_html($clubs !== '' ? $clubs : '—') . '</b></p>';
    if (!$same) {
        echo '<p class="description">Тёзок с другими клубами нет.</p>';
        return;
    }
    echo '<p><label for="ag_merge_into">Перенести результаты этой карточки в:</label><select id="ag_merge_into" name="ag_merge_into" style="width:100%"><option value="">— не объединять —</option>';
    foreach ($same as $p) {
        echo '<option value="' . (int) $p->ID . '">' . esc_html($p->post_title . ' (' . implode(', ', array_unique((array) get_post_meta($p->ID, '_ag_clubs', false))) . ')') . '</option>';
    }
    echo '</select></p><p class="description">Например, спортсменка перешла в другой клуб. После сохранения эта карточка уйдёт в корзину, все результаты будут у выбранной.</p>';
}

function ag_athlete_merge($post_id, $post)
{
    global $wpdb;
    if ($post->post_type !== 'ag_athlete' || empty($_POST['ag_merge_into']) || !isset($_POST['ag_merge_nonce'])) {
        return;
    }
    if (!wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['ag_merge_nonce'])), 'ag_merge_' . $post_id) || !current_user_can('edit_post', $post_id)) {
        return;
    }
    $into = absint($_POST['ag_merge_into']);
    if (!$into || $into === $post_id || get_post_type($into) !== 'ag_athlete') {
        return;
    }
    $wpdb->update(ag_results_table(), array('athlete' => $into), array('athlete' => $post_id), array('%d'), array('%d'));
    foreach ((array) get_post_meta($post_id, '_ag_clubs', false) as $club) {
        if (!in_array($club, (array) get_post_meta($into, '_ag_clubs', false), true)) {
            add_post_meta($into, '_ag_clubs', $club);
        }
    }
    remove_action('save_post', 'ag_athlete_merge', 20);
    wp_trash_post($post_id);
    wp_safe_redirect(get_edit_post_link($into, 'url'));
    exit;
}
add_action('save_post', 'ag_athlete_merge', 20, 2);

/** Удалили спортсмена насовсем — убираем и его строки результатов. */
function ag_athlete_deleted($post_id)
{
    global $wpdb;
    if (get_post_type($post_id) === 'ag_athlete') {
        $wpdb->delete(ag_results_table(), array('athlete' => $post_id), array('%d'));
    }
}
add_action('before_delete_post', 'ag_athlete_deleted');

/** Удалили соревнование насовсем — и его результаты. */
function ag_competition_deleted($post_id)
{
    global $wpdb;
    if (get_post_type($post_id) === 'ag_competition') {
        $wpdb->delete(ag_results_table(), array('competition' => $post_id), array('%d'));
    }
}
add_action('before_delete_post', 'ag_competition_deleted');

/* ------------------------------------------------------------------ */
/* Чтение для страниц                                                  */
/* ------------------------------------------------------------------ */

/** Все строки соревнования. */
function ag_archive_rows_for($post_id)
{
    global $wpdb;
    $cached = wp_cache_get('ag_archive_' . $post_id, 'ag');
    if (is_array($cached)) {
        return $cached;
    }
    $rows = $wpdb->get_results($wpdb->prepare('SELECT * FROM ' . ag_results_table() . ' WHERE competition = %d ORDER BY source, category, kind, apparatus, stage, place IS NULL, place, total DESC', $post_id), ARRAY_A);
    wp_cache_set('ag_archive_' . $post_id, $rows, 'ag');
    return $rows;
}

function ag_archive_has_results($post_id)
{
    return (bool) ag_archive_rows_for($post_id);
}

/**
 * Подписи частей турнира: «девушки» и «юноши», если частей несколько (пол берётся у спортсменов части).
 */
function ag_archive_source_labels($rows)
{
    $gender = array();
    foreach ($rows as $r) {
        if ((int) $r['athlete'] && !isset($gender[$r['source']])) {
            $gender[$r['source']] = get_post_meta((int) $r['athlete'], '_ag_gender', true) === 'boys' ? 'юноши' : 'девушки';
        }
    }
    $all = array_unique(array_column($rows, 'source'));
    if (count($all) < 2) {
        return array();
    }
    return $gender;
}

/** Призёры из сохранённых результатов, в том же виде, что ag_podiums_from_snapshot. */
function ag_archive_podiums($post_id)
{
    $rows = ag_archive_rows_for($post_id);
    if (!$rows) {
        return array();
    }
    $out = array();
    $groups = array();
    $labels = ag_archive_source_labels($rows);
    foreach ($rows as $r) {
        if (($r['kind'] !== 'aa' && $r['kind'] !== 'team') || (int) $r['place'] < 1 || (int) $r['place'] > 3) {
            continue;
        }
        $prefix = $labels[$r['source']] ?? '';
        $label = trim($prefix . ' ' . $r['category']);
        $title = ($r['kind'] === 'aa' ? 'Многоборье' : 'Командное первенство') . ($label !== '' ? ' · ' . $label : '');
        $name = $r['kind'] === 'aa' ? get_the_title((int) $r['athlete']) : $r['club'];
        $url = $r['kind'] === 'aa' ? get_permalink((int) $r['athlete']) : '';
        $groups[$r['source'] . '|' . $r['category'] . '|' . $r['kind']]['kind'] = $r['kind'];
        $groups[$r['source'] . '|' . $r['category'] . '|' . $r['kind']]['title'] = $title;
        $groups[$r['source'] . '|' . $r['category'] . '|' . $r['kind']]['rows'][] = array((int) $r['place'], $name, $r['kind'] === 'aa' ? $r['club'] : '', (float) $r['total'], $url);
    }
    foreach ($groups as $g) {
        usort($g['rows'], function ($a, $b) {
            return $a[0] <=> $b[0];
        });
        $out[] = $g;
    }
    // Сначала многоборье всех частей турнира, потом командный зачёт.
    $is_aa = function ($g) {
        return $g['kind'] === 'aa';
    };
    return array_merge(array_values(array_filter($out, $is_aa)), array_values(array_filter($out, function ($g) use ($is_aa) {
        return !$is_aa($g);
    })));
}

/** Полная таблица многоборья по разрядам на странице соревнования (во вкладке «Итоги»). */
function ag_archive_competition_table($post_id)
{
    $rows = ag_archive_rows_for($post_id);
    if (!$rows) {
        return;
    }
    $apps = array();
    $scores = array();
    $aa = array();
    foreach ($rows as $r) {
        if ($r['kind'] === 'aa') {
            $aa[$r['source'] . '|' . $r['category']][] = $r;
        } elseif ($r['kind'] === 'app' && $r['stage'] === 'qual') {
            $apps[$r['source']][$r['apparatus']] = true;
            $scores[$r['source'] . '|' . $r['athlete'] . '|' . $r['category']][$r['apparatus']] = (float) $r['total'];
        }
    }
    if (!$aa) {
        return;
    }
    $order = array('FX', 'PH', 'SR', 'VT', 'PB', 'HB', 'UB', 'BB');
    $labels = ag_archive_source_labels($rows);
    echo '<div class="card"><h2 class="card__title">Многоборье: полные результаты</h2>';
    foreach ($aa as $key => $list) {
        list($source, $category) = explode('|', $key, 2);
        $cols = array_values(array_filter($order, function ($a) use ($apps, $source) {
            return !empty($apps[$source][$a]);
        }));
        usort($list, function ($a, $b) {
            return ((int) ($a['place'] ?: 9999)) <=> ((int) ($b['place'] ?: 9999)) ?: ((float) $b['total'] <=> (float) $a['total']);
        });
        $open = $key === array_key_first($aa) ? ' open' : '';
        $label = trim(($labels[$source] ?? '') . ' ' . $category);
        echo '<details class="aa-table"' . $open . '><summary><b>' . esc_html($label !== '' ? mb_strtoupper(mb_substr($label, 0, 1)) . mb_substr($label, 1) : 'Все участники') . '</b> · ' . count($list) . ' ' . esc_html(ag_plural(count($list), 'участник', 'участника', 'участников')) . '</summary>';
        echo '<div class="table-wrap"><table class="rtable"><thead><tr><th>Место</th><th>Спортсмен</th>';
        foreach ($cols as $a) {
            echo '<th class="num" title="' . esc_attr(ag_apparatus_name($a)) . '">' . esc_html(ag_apparatus_name($a, true)) . '</th>';
        }
        echo '<th class="num">Сумма</th><th>Разряд</th></tr></thead><tbody>';
        foreach ($list as $r) {
            $s = $scores[$source . '|' . $r['athlete'] . '|' . $r['category']] ?? array();
            echo '<tr><td>' . ($r['place'] ? '<span class="place place--' . (int) $r['place'] . '">' . (int) $r['place'] . '</span>' : '—') . '</td>';
            echo '<td><a href="' . esc_url(get_permalink((int) $r['athlete'])) . '">' . esc_html(get_the_title((int) $r['athlete'])) . '</a><small>' . esc_html($r['club']) . '</small></td>';
            foreach ($cols as $a) {
                echo '<td class="num">' . (isset($s[$a]) ? esc_html(ag_score($s[$a])) : '—') . '</td>';
            }
            echo '<td class="num"><b>' . esc_html(ag_score($r['total'])) . '</b></td><td>' . esc_html($r['earned']) . '</td></tr>';
        }
        echo '</tbody></table></div></details>';
    }
    echo '</div>';
}

/** История спортсмена: [соревнование => [строки]], новые сверху. */
function ag_athlete_history($athlete_id)
{
    global $wpdb;
    $rows = $wpdb->get_results($wpdb->prepare('SELECT * FROM ' . ag_results_table() . ' WHERE athlete = %d', $athlete_id), ARRAY_A);
    $by = array();
    foreach ($rows as $r) {
        $by[(int) $r['competition']][] = $r;
    }
    uksort($by, function ($a, $b) {
        return strcmp((string) get_post_meta($b, '_ag_start', true), (string) get_post_meta($a, '_ag_start', true));
    });
    return $by;
}

/** Медали спортсмена или клуба: [золото, серебро, бронза] за многоборье и финалы. */
function ag_medals($rows)
{
    $m = array(0, 0, 0);
    foreach ($rows as $r) {
        $p = (int) $r['place'];
        $counts = $r['kind'] === 'aa' || ($r['kind'] === 'app' && $r['stage'] === 'final');
        if ($counts && $p >= 1 && $p <= 3) {
            $m[$p - 1]++;
        }
    }
    return $m;
}

function ag_medals_html($m)
{
    if (!array_sum($m)) {
        return '';
    }
    $out = '<span class="medals">';
    foreach (array(1, 2, 3) as $i) {
        if ($m[$i - 1]) {
            $out .= '<span class="medals__item"><span class="place place--' . $i . '">' . $i . '</span>×' . (int) $m[$i - 1] . '</span>';
        }
    }
    return $out . '</span>';
}

/** Спортсмены клуба и их последние результаты — на странице клуба. */
function ag_archive_club_section($club_id)
{
    global $wpdb;
    $names = ag_club_names($club_id);
    if (!$names) {
        return;
    }
    // Названия клубов в протоколах пишут по-разному: сравниваем в нормальной форме на стороне PHP.
    $clubs = $wpdb->get_col('SELECT DISTINCT club FROM ' . ag_results_table() . " WHERE club <> ''");
    $match = array_values(array_filter($clubs, function ($c) use ($names) {
        return in_array(ag_norm($c), $names, true);
    }));
    if (!$match) {
        return;
    }
    $in = implode(',', array_fill(0, count($match), '%s'));
    $rows = $wpdb->get_results($wpdb->prepare('SELECT * FROM ' . ag_results_table() . " WHERE club IN ($in)", $match), ARRAY_A);
    $athletes = array();
    foreach ($rows as $r) {
        if ((int) $r['athlete']) {
            $athletes[(int) $r['athlete']][] = $r;
        }
    }
    if (!$athletes) {
        return;
    }
    $medals = ag_medals($rows);
    uksort($athletes, function ($a, $b) {
        return strcmp(get_the_title($a), get_the_title($b));
    });
    echo '<div class="card"><div class="section-head"><h2 class="section-head__title">Спортсмены клуба</h2>' . ag_medals_html($medals) . '</div><div class="athlete-list">';
    foreach ($athletes as $id => $list) {
        if (get_post_status($id) !== 'publish') {
            continue;
        }
        ag_athlete_item($id, ag_medals($list));
    }
    echo '</div></div>';

    $comps = array_unique(array_map('intval', array_column($rows, 'competition')));
    usort($comps, function ($a, $b) {
        return strcmp((string) get_post_meta($b, '_ag_start', true), (string) get_post_meta($a, '_ag_start', true));
    });
    echo '<div class="card"><h2 class="card__title">Последние старты клуба</h2><div class="table-wrap"><table class="rtable"><thead><tr><th>Соревнование</th><th class="num">Участников</th><th>Лучший результат в многоборье</th></tr></thead><tbody>';
    foreach (array_slice($comps, 0, 10) as $cid) {
        $in_comp = array_filter($rows, function ($r) use ($cid) {
            return (int) $r['competition'] === $cid && $r['kind'] === 'aa';
        });
        $best = null;
        foreach ($in_comp as $r) {
            if ($r['place'] && (!$best || (int) $r['place'] < (int) $best['place'])) {
                $best = $r;
            }
        }
        $c = ag_competition($cid);
        echo '<tr><td><a href="' . esc_url(get_permalink($cid) . '#results') . '">' . esc_html(get_the_title($cid)) . '</a><small>' . esc_html(ag_date_range($c['start'], $c['end'], true)) . '</small></td>';
        echo '<td class="num">' . count(array_unique(array_column($in_comp, 'athlete'))) . '</td>';
        echo '<td>' . ($best ? '<span class="place place--' . (int) $best['place'] . '">' . (int) $best['place'] . '</span> ' . esc_html(get_the_title((int) $best['athlete'])) . ' <small>' . esc_html($best['category']) . '</small>' : '—') . '</td></tr>';
    }
    echo '</tbody></table></div></div>';
}

/** Строка спортсмена в списках. */
function ag_athlete_item($id, $medals = null)
{
    $title = get_the_title($id);
    $club = (string) get_post_meta($id, '_ag_club', true);
    $init = mb_substr($title, 0, 1);
    echo '<a class="athlete-item" href="' . esc_url(get_permalink($id)) . '"><span class="athlete-item__init" aria-hidden="true">' . esc_html($init) . '</span><span><b>' . esc_html($title) . '</b><small>' . esc_html($club) . '</small></span>' . ($medals ? ag_medals_html($medals) : '') . '</a>';
}
