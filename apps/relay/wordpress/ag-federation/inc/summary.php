<?php
/**
 * После турнира: черновик новости «Итоги» и анонсы в Telegram и ВКонтакте.
 *
 * Черновик создаётся один раз, когда тема впервые сохранила итоговые результаты турнира
 * (сама в течение часа или по кнопке). Редактор добавляет фото и нажимает «Опубликовать».
 *
 * Анонсы: «Турнир начался, табло здесь» — в день старта, «Итоги» — после сохранения результатов.
 * Включаются в «Внешний вид → Настроить → Сайт федерации → Анонсы в соцсетях».
 */

if (!defined('ABSPATH')) {
    exit;
}

/* ------------------------------------------------------------------ */
/* Черновик новости «Итоги»                                             */
/* ------------------------------------------------------------------ */

/** Рубрика «Результаты» для новостей об итогах. */
function ag_results_category()
{
    $term = term_exists('Результаты', 'category');
    if (!$term) {
        $term = wp_insert_term('Результаты', 'category');
    }
    return is_array($term) ? (int) $term['term_id'] : (int) $term;
}

/** Сколько спортсменов и клубов выступало: по сохранённым результатам многоборья. */
function ag_competition_counts($post_id)
{
    $rows = function_exists('ag_archive_rows_for') ? ag_archive_rows_for($post_id) : array();
    $athletes = array();
    $clubs = array();
    foreach ($rows as $r) {
        if ($r['kind'] === 'aa' && (int) $r['athlete']) {
            $athletes[(int) $r['athlete']] = true;
            if ($r['club'] !== '') {
                $clubs[ag_norm($r['club'])] = true;
            }
        }
    }
    return array(count($athletes), count($clubs));
}

/** Текст черновика: вступление, призёры каждого многоборья и команд, протоколы, ссылка на итоги. */
function ag_summary_content($post_id)
{
    $c = ag_competition($post_id);
    $place = implode(', ', array_filter(array($c['venue'], $c['city'])));
    list($athletes, $clubs) = ag_competition_counts($post_id);
    $intro = ag_date_range($c['start'], $c['end'], true) . ($place !== '' ? ' в ' . $place : '') . ' прошло соревнование «' . get_the_title($post_id) . '».';
    if ($athletes) {
        $intro .= ' Выступили ' . $athletes . ' ' . ag_plural($athletes, 'спортсмен', 'спортсмена', 'спортсменов');
        $intro .= $clubs > 1 ? ' из ' . $clubs . ' ' . ag_plural($clubs, 'клуба', 'клубов', 'клубов') . '.' : '.';
    }
    $html = '<!-- wp:paragraph --><p>' . esc_html($intro) . '</p><!-- /wp:paragraph -->';
    foreach (ag_competition_podiums($c) as $pod) {
        $html .= '<!-- wp:heading {"level":3} --><h3 class="wp-block-heading">' . esc_html($pod['title']) . '</h3><!-- /wp:heading -->';
        $items = '';
        foreach ($pod['rows'] as $row) {
            $who = esc_html($row[1]) . ($row[2] !== '' ? ' (' . esc_html($row[2]) . ')' : '');
            if (!empty($row[4])) {
                $who = '<a href="' . esc_url($row[4]) . '">' . esc_html($row[1]) . '</a>' . ($row[2] !== '' ? ' (' . esc_html($row[2]) . ')' : '');
            }
            $items .= '<li>' . (int) $row[0] . ' место: ' . $who . ' — ' . esc_html(ag_score($row[3])) . '</li>';
        }
        $html .= '<!-- wp:list --><ul class="wp-block-list">' . $items . '</ul><!-- /wp:list -->';
    }
    $files = ag_competition_protocols($c);
    if ($files) {
        $html .= '<!-- wp:heading {"level":3} --><h3 class="wp-block-heading">Протоколы</h3><!-- /wp:heading -->';
        $items = '';
        foreach (array_slice($files, 0, 12) as $f) {
            $items .= '<li><a href="' . esc_url($f['url']) . '">' . esc_html($f['title']) . '</a></li>';
        }
        $html .= '<!-- wp:list --><ul class="wp-block-list">' . $items . '</ul><!-- /wp:list -->';
    }
    $html .= '<!-- wp:paragraph --><p>Полные результаты и таблица многоборья — <a href="' . esc_url(get_permalink($post_id) . '#results') . '">на странице соревнования</a>.</p><!-- /wp:paragraph -->';
    $html .= '<!-- wp:paragraph --><p>Поздравляем победителей и призёров, их тренеров и родителей!</p><!-- /wp:paragraph -->';
    return $html;
}

/** Черновик новости об итогах. Возвращает ID записи или 0. Второй раз не создаётся, если $again не задан. */
function ag_summary_draft($post_id, $again = false)
{
    $existing = (int) get_post_meta($post_id, '_ag_summary_post', true);
    if ($existing && !$again) {
        return 0;
    }
    if ($existing && get_post_status($existing) && get_post_status($existing) !== 'trash') {
        return $existing;
    }
    if (!function_exists('ag_archive_has_results') || !ag_archive_has_results($post_id)) {
        return 0;
    }
    $news = wp_insert_post(array(
        'post_type' => 'post',
        'post_status' => 'draft',
        'post_title' => 'Итоги: ' . get_the_title($post_id),
        'post_content' => ag_summary_content($post_id),
        'post_category' => array(ag_results_category()),
        'post_author' => (int) get_post_field('post_author', $post_id),
    ), true);
    if (is_wp_error($news)) {
        return 0;
    }
    update_post_meta($news, '_ag_competition', $post_id);
    if (has_post_thumbnail($post_id)) {
        set_post_thumbnail($news, get_post_thumbnail_id($post_id));
    }
    update_post_meta($post_id, '_ag_summary_post', $news);
    return $news;
}

/** После сохранения результатов: черновик новости и анонс итогов. */
function ag_after_import($post_id)
{
    if (ag_stage(ag_competition($post_id)) !== 'done') {
        return;
    }
    ag_summary_draft($post_id);
    // Об итогах давних турниров (например, сразу после установки темы) в соцсети не пишем.
    if (ag_competition($post_id)['end'] >= wp_date('Y-m-d', time() - 3 * DAY_IN_SECONDS)) {
        ag_announce($post_id, 'done');
    }
}
add_action('ag_archive_imported', 'ag_after_import');

/** Ссылка на черновик в блоке «Результаты на сайте» карточки соревнования. */
function ag_summary_box_line($post)
{
    $news = (int) get_post_meta($post->ID, '_ag_summary_post', true);
    $status = $news ? get_post_status($news) : false;
    if ($status && $status !== 'trash') {
        echo '<p>' . ($status === 'publish' ? 'Новость об итогах опубликована: ' : 'Черновик новости об итогах готов: ') . '<a href="' . esc_url(get_edit_post_link($news)) . '">' . esc_html(get_the_title($news)) . '</a></p>';
    } elseif (function_exists('ag_archive_has_results') && ag_archive_has_results($post->ID)) {
        $url = wp_nonce_url(admin_url('admin-post.php?action=ag_summary_draft&post=' . $post->ID), 'ag_summary_draft_' . $post->ID);
        echo '<p><a class="button" href="' . esc_url($url) . '">Составить новость об итогах</a></p>';
    } else {
        echo '<p class="description">Когда результаты сохранятся, здесь появится черновик новости «Итоги» с призёрами и протоколами.</p>';
    }
}

function ag_summary_draft_action()
{
    $post_id = isset($_GET['post']) ? absint($_GET['post']) : 0;
    check_admin_referer('ag_summary_draft_' . $post_id);
    if (!current_user_can('edit_post', $post_id) || !current_user_can('edit_posts')) {
        wp_die('Недостаточно прав');
    }
    $news = ag_summary_draft($post_id, true);
    wp_safe_redirect($news ? get_edit_post_link($news, 'url') : get_edit_post_link($post_id, 'url'));
    exit;
}
add_action('admin_post_ag_summary_draft', 'ag_summary_draft_action');

/* ------------------------------------------------------------------ */
/* Анонсы в Telegram и ВКонтакте                                        */
/* ------------------------------------------------------------------ */

function ag_announce_enabled()
{
    return (ag_mod('ag_tg_token') !== '' && ag_mod('ag_tg_chat') !== '') || (ag_mod('ag_vk_token') !== '' && ag_mod('ag_vk_group') !== '');
}

/** Текст анонса: $what = 'live' (турнир начался) или 'done' (итоги). */
function ag_announce_text($post_id, $what)
{
    $c = ag_competition($post_id);
    $title = get_the_title($post_id);
    $place = implode(', ', array_filter(array($c['venue'], $c['city'])));
    // Русские буквы в адресе оставляем читаемыми: Telegram и ВКонтакте сами делают из него ссылку.
    $link = rawurldecode(get_permalink($post_id));
    if ($what === 'live') {
        $lines = array('Идёт сейчас: ' . $title, ag_date_range($c['start'], $c['end'], true) . ($place !== '' ? ', ' . $place : ''), '', 'Оценки приходят прямо с судейских планшетов. Табло онлайн: ' . $link . '#live');
        return implode("\n", $lines);
    }
    $lines = array('Итоги: ' . $title, ag_date_range($c['start'], $c['end'], true) . ($place !== '' ? ', ' . $place : ''), '');
    foreach (array_slice(ag_competition_podiums($c), 0, 4) as $pod) {
        $lines[] = $pod['title'];
        foreach ($pod['rows'] as $row) {
            $lines[] = $row[0] . '. ' . $row[1] . ($row[2] !== '' ? ' (' . $row[2] . ')' : '') . ' — ' . ag_score($row[3]);
        }
        $lines[] = '';
    }
    $lines[] = 'Протоколы и все результаты: ' . $link . '#results';
    return implode("\n", $lines);
}

/**
 * Отправить анонс один раз. $force — по кнопке в админке, повторно.
 * Возвращает массив ['telegram' => true|сообщение об ошибке, 'vk' => …] или пустой, если отправлять некуда.
 */
function ag_announce($post_id, $what, $force = false)
{
    if (!ag_announce_enabled() || get_post_status($post_id) !== 'publish') {
        return array();
    }
    $flag = '_ag_announced_' . $what;
    if (!$force && get_post_meta($post_id, $flag, true)) {
        return array();
    }
    // Флаг ставим до отправки: два запуска планировщика подряд не продублируют пост.
    update_post_meta($post_id, $flag, current_time('mysql'));
    $text = ag_announce_text($post_id, $what);
    $result = array();
    if (ag_mod('ag_tg_token') !== '' && ag_mod('ag_tg_chat') !== '') {
        $r = wp_remote_post('https://api.telegram.org/bot' . rawurlencode(ag_mod('ag_tg_token')) . '/sendMessage', array(
            'timeout' => 15,
            'body' => array('chat_id' => ag_mod('ag_tg_chat'), 'text' => $text, 'disable_web_page_preview' => 'false'),
        ));
        $body = is_wp_error($r) ? null : json_decode(wp_remote_retrieve_body($r), true);
        $result['telegram'] = !empty($body['ok']) ? true : (is_wp_error($r) ? $r->get_error_message() : (string) ($body['description'] ?? 'ошибка ' . wp_remote_retrieve_response_code($r)));
    }
    if (ag_mod('ag_vk_token') !== '' && ag_mod('ag_vk_group') !== '') {
        $group = ltrim(preg_replace('/^(club|public)/', '', trim(ag_mod('ag_vk_group'))), '-');
        $r = wp_remote_post('https://api.vk.com/method/wall.post', array(
            'timeout' => 15,
            'body' => array(
                'owner_id' => '-' . absint($group),
                'from_group' => 1,
                'message' => $text,
                'attachments' => get_permalink($post_id),
                'access_token' => ag_mod('ag_vk_token'),
                'v' => '5.199',
            ),
        ));
        $body = is_wp_error($r) ? null : json_decode(wp_remote_retrieve_body($r), true);
        $result['vk'] = isset($body['response']) ? true : (is_wp_error($r) ? $r->get_error_message() : (string) ($body['error']['error_msg'] ?? 'ошибка ' . wp_remote_retrieve_response_code($r)));
    }
    update_post_meta($post_id, '_ag_announce_log', array('what' => $what, 'at' => current_time('mysql'), 'result' => $result));
    return $result;
}

/** Каждые 15 минут: анонс «Идёт сейчас» для турниров, которые начались. */
function ag_announce_schedules($s)
{
    $s['ag_15min'] = array('interval' => 15 * MINUTE_IN_SECONDS, 'display' => 'Каждые 15 минут');
    return $s;
}
add_filter('cron_schedules', 'ag_announce_schedules');

function ag_announce_cron()
{
    if (!ag_announce_enabled()) {
        return;
    }
    $live = get_posts(array(
        'post_type' => 'ag_competition',
        'posts_per_page' => 5,
        'fields' => 'ids',
        'meta_query' => array(
            array('key' => '_ag_start', 'value' => ag_today(), 'compare' => '<='),
            array('key' => '_ag_end', 'value' => ag_today(), 'compare' => '>='),
        ),
    ));
    foreach ($live as $id) {
        if (ag_stage(ag_competition($id)) === 'live') {
            ag_announce($id, 'live');
        }
    }
}
add_action('ag_announce_cron', 'ag_announce_cron');

function ag_announce_schedule()
{
    if (!wp_next_scheduled('ag_announce_cron')) {
        wp_schedule_event(time() + 60, 'ag_15min', 'ag_announce_cron');
    }
}
add_action('init', 'ag_announce_schedule');

function ag_announce_unschedule()
{
    wp_clear_scheduled_hook('ag_announce_cron');
}
add_action('switch_theme', 'ag_announce_unschedule');

/** Блок «Анонсы в соцсетях» в карточке соревнования: что отправлено, кнопки «Отправить». */
function ag_announce_box($post)
{
    if (!ag_announce_enabled()) {
        echo '<p class="description">Чтобы тема сама писала в Telegram-канал и группу ВКонтакте «Турнир начался» и «Итоги», заполните «Внешний вид → Настроить → Сайт федерации → Анонсы в соцсетях».</p>';
        return;
    }
    foreach (array('live' => 'Турнир начался', 'done' => 'Итоги') as $what => $label) {
        $at = (string) get_post_meta($post->ID, '_ag_announced_' . $what, true);
        echo '<p><b>' . esc_html($label) . ':</b> ' . ($at !== '' ? 'отправлено ' . esc_html(mysql2date('d.m.Y H:i', $at)) : 'ещё не отправлялось') . '</p>';
    }
    $log = get_post_meta($post->ID, '_ag_announce_log', true);
    if (is_array($log) && !empty($log['result'])) {
        foreach ($log['result'] as $where => $res) {
            if ($res !== true) {
                echo '<p style="color:#b32d2e">' . esc_html(($where === 'vk' ? 'ВКонтакте' : 'Telegram') . ' не принял пост: ' . $res) . '</p>';
            }
        }
    }
    if ($post->post_status === 'publish') {
        foreach (array('live' => 'Отправить «Турнир начался»', 'done' => 'Отправить «Итоги»') as $what => $label) {
            $url = wp_nonce_url(admin_url('admin-post.php?action=ag_announce&what=' . $what . '&post=' . $post->ID), 'ag_announce_' . $post->ID);
            echo '<p><a class="button" href="' . esc_url($url) . '">' . esc_html($label) . '</a></p>';
        }
        echo '<p class="description">Обычно ничего нажимать не нужно: тема отправляет анонс сама в день старта и после сохранения итогов.</p>';
    }
}

function ag_announce_action()
{
    $post_id = isset($_GET['post']) ? absint($_GET['post']) : 0;
    $what = isset($_GET['what']) && $_GET['what'] === 'live' ? 'live' : 'done';
    check_admin_referer('ag_announce_' . $post_id);
    if (!current_user_can('edit_post', $post_id)) {
        wp_die('Недостаточно прав');
    }
    $result = ag_announce($post_id, $what, true);
    $ok = $result && !in_array(false, array_map(function ($r) {
        return $r === true;
    }, $result), true);
    set_transient('ag_archive_notice_' . get_current_user_id(), $ok ? 'msg:Анонс отправлен.' : 'err:Анонс не отправлен, причина — в блоке «Анонсы в соцсетях».', 60);
    wp_safe_redirect(get_edit_post_link($post_id, 'url'));
    exit;
}
add_action('admin_post_ag_announce', 'ag_announce_action');

function ag_summary_boxes()
{
    add_meta_box('ag_announce', 'Анонсы в соцсетях', 'ag_announce_box', 'ag_competition', 'side', 'low');
}
add_action('add_meta_boxes', 'ag_summary_boxes');

/** Настройки анонсов в «Внешний вид → Настроить». */
function ag_announce_customize($wp)
{
    $wp->add_section('ag_social', array(
        'title' => 'Анонсы в соцсетях',
        'panel' => 'ag',
        'description' => 'Тема сама пишет в канал «Турнир начался, табло здесь» в день старта и «Итоги» с призёрами после турнира. Telegram: создайте бота у @BotFather, добавьте его администратором канала, впишите токен бота и имя канала (@channel). ВКонтакте: ключ доступа сообщества («Управление → Работа с API», право «Стена») и номер группы.',
    ));
    $fields = array(
        'ag_tg_token' => 'Telegram: токен бота',
        'ag_tg_chat' => 'Telegram: канал или чат (@channel или -100…)',
        'ag_vk_token' => 'ВКонтакте: ключ доступа сообщества',
        'ag_vk_group' => 'ВКонтакте: номер группы (например, 123456)',
    );
    foreach ($fields as $key => $label) {
        $wp->add_setting($key, array('default' => '', 'sanitize_callback' => 'sanitize_text_field'));
        $wp->add_control($key, array('label' => $label, 'section' => 'ag_social', 'type' => strpos($key, 'token') ? 'password' : 'text'));
    }
}
add_action('customize_register', 'ag_announce_customize', 20);
