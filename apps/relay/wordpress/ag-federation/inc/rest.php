<?php
/**
 * Карточка соревнования от программы в зале: кнопка «Подключить к сайту» в секретариате.
 *
 *   GET  /wp-json/ag/v1/competition?id=<uuid>  — карточка, в которой уже записан этот ID, или 404;
 *   POST /wp-json/ag/v1/competition            — создать или обновить карточку.
 *
 * Программа входит под пользователем WordPress с паролем приложения («Пользователи → Профиль →
 * Пароли приложений»). Нужны права публиковать записи: редактор или администратор.
 * Если на сайте нет красивых ссылок, тот же адрес работает как /?rest_route=/ag/v1/competition.
 */

if (!defined('ABSPATH')) {
    exit;
}

function ag_rest_routes()
{
    register_rest_route('ag/v1', '/competition', array(
        array(
            'methods' => 'GET',
            'callback' => 'ag_rest_get_card',
            'permission_callback' => 'ag_rest_can',
            'args' => array('id' => array('required' => true, 'type' => 'string')),
        ),
        array(
            'methods' => 'POST',
            'callback' => 'ag_rest_save_card',
            'permission_callback' => 'ag_rest_can',
        ),
    ));
}
add_action('rest_api_init', 'ag_rest_routes');

function ag_rest_can()
{
    if (!is_user_logged_in()) {
        return new WP_Error('ag_auth', 'Нужен вход: пользователь WordPress и пароль приложения.', array('status' => 401));
    }
    if (!current_user_can('publish_posts') || !current_user_can('edit_others_posts')) {
        return new WP_Error('ag_forbidden', 'У этого пользователя WordPress нет прав публиковать записи: нужен редактор или администратор.', array('status' => 403));
    }
    return true;
}

/** Карточка, в поле «ID соревнования» которой есть любой из этих ID (опубликованная, черновик или запланированная). */
function ag_find_card($ids)
{
    foreach ($ids as $id) {
        $found = get_posts(array(
            'post_type' => 'ag_competition',
            'post_status' => array('publish', 'draft', 'pending', 'future', 'private'),
            'posts_per_page' => 1,
            'fields' => 'ids',
            'meta_query' => array(array('key' => '_ag_ids', 'value' => $id, 'compare' => 'LIKE')),
        ));
        if ($found) {
            return (int) $found[0];
        }
    }
    return 0;
}

function ag_card_view($post_id, $created = false)
{
    $c = ag_competition($post_id);
    return array(
        'id' => $post_id,
        'created' => $created,
        'title' => get_the_title($post_id),
        'status' => get_post_status($post_id),
        'link' => get_permalink($post_id),
        'edit' => admin_url('post.php?post=' . $post_id . '&action=edit'),
        'start' => $c['start'],
        'end' => $c['end'],
        'venue' => $c['venue'],
        'city' => $c['city'],
        'ids' => $c['ids'],
        'entries' => $c['entry_key'] !== '',
    );
}

function ag_rest_get_card(WP_REST_Request $request)
{
    $id = strtolower((string) $request->get_param('id'));
    if (!preg_match(AG_UUID_RE, $id)) {
        return new WP_Error('ag_bad_id', 'Неверный ID соревнования.', array('status' => 400));
    }
    $post_id = ag_find_card(array($id));
    if (!$post_id) {
        return new WP_Error('ag_not_found', 'Карточки этого соревнования на сайте ещё нет.', array('status' => 404));
    }
    return ag_card_view($post_id);
}

/**
 * Тело: ids (1–4 UUID, первым — основная часть), name, gender (girls|boys|both), levels,
 * start, end (Y-m-d), venue, city, entryKey, deadline (Y-m-d или пусто).
 * Название записывается только при создании: потом его правит редактор сайта. Пустые даты и место
 * не стирают заполненные на сайте.
 */
function ag_rest_save_card(WP_REST_Request $request)
{
    $p = $request->get_json_params();
    if (!is_array($p)) {
        return new WP_Error('ag_bad_body', 'Пустой запрос.', array('status' => 400));
    }
    $ids = array();
    foreach ((array) ($p['ids'] ?? array()) as $id) {
        $id = strtolower(trim((string) $id));
        if (preg_match(AG_UUID_RE, $id)) {
            $ids[] = $id;
        }
    }
    $ids = array_slice(array_values(array_unique($ids)), 0, 4);
    if (!$ids) {
        return new WP_Error('ag_bad_id', 'Нет ID соревнования.', array('status' => 400));
    }
    $date = function ($s) {
        return is_string($s) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $s) ? $s : '';
    };
    $start = $date($p['start'] ?? '');
    $end = $date($p['end'] ?? '');
    if ($end !== '' && $start !== '' && $end < $start) {
        return new WP_Error('ag_bad_dates', 'Окончание раньше начала.', array('status' => 400));
    }
    $name = sanitize_text_field((string) ($p['name'] ?? ''));
    $post_id = ag_find_card($ids);
    $created = false;
    if (!$post_id) {
        if ($start === '') {
            return new WP_Error('ag_no_start', 'Укажите дату начала: без неё соревнование не встанет в календарь.', array('status' => 400));
        }
        $post_id = wp_insert_post(array(
            'post_type' => 'ag_competition',
            'post_status' => 'publish',
            'post_title' => $name !== '' ? $name : 'Соревнование',
        ), true);
        if (is_wp_error($post_id)) {
            return $post_id;
        }
        $created = true;
    }
    $set = function ($key, $value) use ($post_id) {
        if ($value === '' || $value === null) {
            return;
        }
        update_post_meta($post_id, $key, $value);
    };
    // Если у карточки уже были ID (например, вписанные руками), новые добавляются к ним.
    $old = ag_competition_ids($post_id);
    update_post_meta($post_id, '_ag_ids', implode(', ', array_slice(array_values(array_unique(array_merge($ids, $old))), 0, 4)));
    $set('_ag_start', $start);
    $set('_ag_end', $end);
    $set('_ag_venue', sanitize_text_field((string) ($p['venue'] ?? '')));
    $set('_ag_city', sanitize_text_field((string) ($p['city'] ?? '')));
    $set('_ag_levels', sanitize_text_field((string) ($p['levels'] ?? '')));
    $gender = (string) ($p['gender'] ?? '');
    $set('_ag_gender', in_array($gender, array('girls', 'boys', 'both'), true) ? $gender : '');
    $key = (string) ($p['entryKey'] ?? '');
    if (preg_match('/^[A-Za-z0-9_-]{16,128}$/', $key)) {
        update_post_meta($post_id, '_ag_entry_key', $key);
    }
    if (array_key_exists('deadline', $p)) {
        $deadline = $date($p['deadline']);
        if ($deadline === '') {
            delete_post_meta($post_id, '_ag_deadline');
        } else {
            update_post_meta($post_id, '_ag_deadline', $deadline);
        }
    }
    $s = (string) get_post_meta($post_id, '_ag_start', true);
    $e = (string) get_post_meta($post_id, '_ag_end', true);
    if ($s !== '' && ($e === '' || $e < $s)) {
        update_post_meta($post_id, '_ag_end', $s);
    }
    // Табло и заявки на страницах показываются из кэша: после подключения — сразу свежие.
    foreach ($ids as $id) {
        delete_transient('ag_relay_' . md5(ag_relay_base() . '/api/competitions/' . $id));
    }
    return ag_card_view($post_id, $created);
}
