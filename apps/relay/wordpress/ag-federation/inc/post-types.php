<?php
/**
 * Типы записей темы и их поля в админке.
 *   ag_competition — соревнования (календарь, страница турнира);
 *   ag_club        — клубы и спортивные школы;
 *   ag_document    — документы (положения, календарный план, правила) с разделами ag_doc_group.
 */

if (!defined('ABSPATH')) {
    exit;
}

function ag_register_types()
{
    register_post_type('ag_competition', array(
        'labels' => array(
            'name' => 'Соревнования',
            'singular_name' => 'Соревнование',
            'menu_name' => 'Соревнования',
            'add_new' => 'Добавить соревнование',
            'add_new_item' => 'Новое соревнование',
            'edit_item' => 'Изменить соревнование',
            'view_item' => 'Открыть страницу соревнования',
            'all_items' => 'Все соревнования',
            'search_items' => 'Найти соревнование',
            'not_found' => 'Соревнований пока нет',
        ),
        'public' => true,
        'has_archive' => 'competitions',
        'rewrite' => array('slug' => 'competitions', 'with_front' => false),
        'menu_icon' => 'dashicons-awards',
        'menu_position' => 5,
        'supports' => array('title', 'editor', 'thumbnail', 'excerpt'),
        'show_in_rest' => true,
    ));

    register_post_type('ag_club', array(
        'labels' => array(
            'name' => 'Клубы',
            'singular_name' => 'Клуб',
            'add_new' => 'Добавить клуб',
            'add_new_item' => 'Новый клуб',
            'edit_item' => 'Изменить клуб',
            'all_items' => 'Все клубы',
            'not_found' => 'Клубов пока нет',
        ),
        'public' => true,
        'has_archive' => 'clubs',
        'rewrite' => array('slug' => 'clubs', 'with_front' => false),
        'menu_icon' => 'dashicons-groups',
        'menu_position' => 6,
        'supports' => array('title', 'editor', 'thumbnail', 'page-attributes'),
        'show_in_rest' => true,
    ));

    register_post_type('ag_document', array(
        'labels' => array(
            'name' => 'Документы',
            'singular_name' => 'Документ',
            'add_new' => 'Добавить документ',
            'add_new_item' => 'Новый документ',
            'edit_item' => 'Изменить документ',
            'all_items' => 'Все документы',
            'not_found' => 'Документов пока нет',
        ),
        'public' => true,
        'has_archive' => 'documents',
        'rewrite' => array('slug' => 'documents', 'with_front' => false),
        'menu_icon' => 'dashicons-media-document',
        'menu_position' => 7,
        'supports' => array('title', 'excerpt'),
        'show_in_rest' => true,
    ));

    register_taxonomy('ag_doc_group', 'ag_document', array(
        'labels' => array(
            'name' => 'Разделы документов',
            'singular_name' => 'Раздел',
            'add_new_item' => 'Новый раздел',
            'menu_name' => 'Разделы',
        ),
        'hierarchical' => true,
        'public' => true,
        'show_admin_column' => true,
        'show_in_rest' => true,
        'rewrite' => array('slug' => 'documents/group', 'with_front' => false),
    ));
}
add_action('init', 'ag_register_types');

/* ------------------------------------------------------------------ */
/* Поля соревнования                                                    */
/* ------------------------------------------------------------------ */

function ag_meta_boxes()
{
    add_meta_box('ag_competition_main', 'Соревнование: даты, место, программа соревнований', 'ag_competition_box', 'ag_competition', 'normal', 'high');
    add_meta_box('ag_club_main', 'Клуб: контакты и тренеры', 'ag_club_box', 'ag_club', 'normal', 'high');
    add_meta_box('ag_document_main', 'Файл документа', 'ag_document_box', 'ag_document', 'normal', 'high');
    add_meta_box('ag_post_competition', 'К какому соревнованию новость', 'ag_post_competition_box', 'post', 'side');
}
add_action('add_meta_boxes', 'ag_meta_boxes');

function ag_field($label, $html, $help = '')
{
    echo '<div class="ag-field"><label>' . esc_html($label) . '</label>' . $html;
    if ($help !== '') {
        echo '<p class="description">' . wp_kses($help, array('b' => array(), 'code' => array())) . '</p>';
    }
    echo '</div>';
}

function ag_competition_box($post)
{
    wp_nonce_field('ag_save_meta', 'ag_meta_nonce');
    $c = ag_competition($post);
    $v = function ($k) use ($post) {
        return esc_attr((string) get_post_meta($post->ID, $k, true));
    };
    echo '<div class="ag-grid">';
    ag_field('Начало', '<input type="date" name="ag[_ag_start]" value="' . $v('_ag_start') . '" required>');
    ag_field('Окончание', '<input type="date" name="ag[_ag_end]" value="' . $v('_ag_end') . '">', 'Для однодневного старта можно не заполнять.');
    ag_field('Место проведения', '<input type="text" name="ag[_ag_venue]" value="' . $v('_ag_venue') . '" placeholder="Дворец гимнастики">');
    ag_field('Город', '<input type="text" name="ag[_ag_city]" value="' . $v('_ag_city') . '" placeholder="Нижний Новгород">');
    $gender = (string) get_post_meta($post->ID, '_ag_gender', true);
    $opts = '';
    foreach (array('girls' => 'Девушки', 'boys' => 'Юноши', 'both' => 'Девушки и юноши') as $k => $label) {
        $opts .= '<option value="' . esc_attr($k) . '"' . selected($gender, $k, false) . '>' . esc_html($label) . '</option>';
    }
    ag_field('Кто выступает', '<select name="ag[_ag_gender]">' . $opts . '</select>');
    ag_field('Разряды и возраст', '<input type="text" name="ag[_ag_levels]" value="' . $v('_ag_levels') . '" placeholder="КМС, 1 разряд · 2012–2014 г.р.">');
    echo '</div>';

    echo '<h3 class="ag-section">Связь с программой соревнований</h3><div class="ag-grid">';
    ag_field(
        'ID соревнования',
        '<input type="text" name="ag[_ag_ids]" value="' . $v('_ag_ids') . '" placeholder="7cc94d33-b89b-4df1-a56b-8430b6c077f9" class="code">',
        'Из секретариата, блок «Результаты на сайте»: можно вставить прямо скопированный шорткод, тема сама найдёт в нём ID. Если у турнира несколько частей (девушки и юноши), вставьте оба. По ID на странице появятся табло, призёры и протоколы.'
    );
    ag_field(
        'Ключ приёма заявок',
        '<input type="text" name="ag[_ag_entry_key]" value="' . $v('_ag_entry_key') . '" class="code">',
        'Из секретариата, блок «Онлайн-заявки клубов»: вставьте ссылку для клубов или шорткод кнопки, тема сама найдёт в них ключ. Пусто — кнопки «Подать заявку» не будет.'
    );
    ag_field('Заявки до', '<input type="date" name="ag[_ag_deadline]" value="' . $v('_ag_deadline') . '">', 'Если срок задан в секретариате, сайт возьмёт его оттуда.');
    $stage = (string) get_post_meta($post->ID, '_ag_stage', true);
    $opts = '';
    foreach (array('' => 'Сама по датам', 'before' => 'До старта', 'live' => 'Идёт сейчас', 'done' => 'Завершено') as $k => $label) {
        $opts .= '<option value="' . esc_attr($k) . '"' . selected($stage, $k, false) . '>' . esc_html($label) . '</option>';
    }
    ag_field('Стадия', '<select name="ag[_ag_stage]">' . $opts . '</select>', 'Обычно не трогайте: до начала страница показывает заявки, в дни турнира — табло, после — итоги.');
    $theme = (string) get_post_meta($post->ID, '_ag_board_theme', true);
    ag_field('Табло на странице', '<select name="ag[_ag_board_theme]"><option value="dark"' . selected($theme, 'dark', false) . '>Тёмное</option><option value="light"' . selected($theme, 'light', false) . '>Светлое</option></select>');
    echo '</div>';

    echo '<h3 class="ag-section">Программа по дням</h3>';
    ag_field('', '<textarea name="ag[_ag_program]" rows="4" placeholder="5 декабря | Приезд, мандатная комиссия&#10;6 декабря | Многоборье, 3 смены">' . esc_textarea((string) get_post_meta($post->ID, '_ag_program', true)) . '</textarea>', 'Каждый день с новой строки: дата, вертикальная черта, что происходит.');

    echo '<h3 class="ag-section">Документы соревнования</h3>';
    $docs = esc_attr((string) get_post_meta($post->ID, '_ag_docs', true));
    echo '<div class="ag-docs" data-ag-docs><input type="hidden" name="ag[_ag_docs]" value="' . $docs . '"><ul class="ag-docs__list">';
    foreach ($c['docs'] as $att) {
        $url = wp_get_attachment_url($att);
        if ($url) {
            echo '<li data-id="' . (int) $att . '"><a href="' . esc_url($url) . '" target="_blank">' . esc_html(get_the_title($att)) . '</a> <button type="button" class="button-link ag-docs__remove">убрать</button></li>';
        }
    }
    echo '</ul><button type="button" class="button ag-docs__add">Добавить файлы (положение, форма заявки…)</button></div>';
}

function ag_club_box($post)
{
    wp_nonce_field('ag_save_meta', 'ag_meta_nonce');
    $v = function ($k) use ($post) {
        return esc_attr((string) get_post_meta($post->ID, $k, true));
    };
    echo '<div class="ag-grid">';
    ag_field('Город', '<input type="text" name="ag[_ag_city]" value="' . $v('_ag_city') . '">');
    ag_field('Адрес', '<input type="text" name="ag[_ag_address]" value="' . $v('_ag_address') . '">');
    ag_field('Телефон', '<input type="text" name="ag[_ag_phone]" value="' . $v('_ag_phone') . '">');
    ag_field('Сайт или страница ВКонтакте', '<input type="url" name="ag[_ag_site]" value="' . $v('_ag_site') . '">');
    echo '</div>';
    ag_field('Тренеры', '<textarea name="ag[_ag_coaches]" rows="4" placeholder="Иванова Мария Петровна — ЗТР&#10;Петров Сергей Иванович">' . esc_textarea((string) get_post_meta($post->ID, '_ag_coaches', true)) . '</textarea>', 'Каждый тренер с новой строки.');
    ag_field('Как называется клуб в протоколах', '<input type="text" name="ag[_ag_aliases]" value="' . $v('_ag_aliases') . '" placeholder="СШОР Спартак, СШОР «Спартак» Н.Новгород">', 'Названия через запятую, как их пишут в заявках. По ним на странице клуба собираются его спортсмены и результаты.');
}

function ag_document_box($post)
{
    wp_nonce_field('ag_save_meta', 'ag_meta_nonce');
    $att = (int) get_post_meta($post->ID, '_ag_file', true);
    $url = $att ? wp_get_attachment_url($att) : '';
    echo '<div class="ag-file" data-ag-file><input type="hidden" name="ag[_ag_file]" value="' . ($att ?: '') . '">';
    echo '<p class="ag-file__name">' . ($url ? '<a href="' . esc_url($url) . '" target="_blank">' . esc_html(basename($url)) . '</a>' : 'Файл не выбран') . '</p>';
    echo '<button type="button" class="button ag-file__pick">Выбрать или загрузить файл</button></div>';
    ag_field('Или ссылка на файл', '<input type="url" name="ag[_ag_link]" value="' . esc_attr((string) get_post_meta($post->ID, '_ag_link', true)) . '" style="width:100%">', 'Например, на документ Минспорта. Используется, если файл не выбран.');
}

function ag_post_competition_box($post)
{
    wp_nonce_field('ag_save_meta', 'ag_meta_nonce');
    $current = (int) get_post_meta($post->ID, '_ag_competition', true);
    $list = get_posts(array('post_type' => 'ag_competition', 'posts_per_page' => 40, 'meta_key' => '_ag_start', 'orderby' => 'meta_value', 'order' => 'DESC'));
    echo '<select name="ag[_ag_competition]" style="width:100%"><option value="">— нет —</option>';
    foreach ($list as $p) {
        echo '<option value="' . (int) $p->ID . '"' . selected($current, $p->ID, false) . '>' . esc_html(get_the_title($p)) . '</option>';
    }
    echo '</select><p class="description">Новость появится на странице соревнования, во вкладке «Итоги».</p>';
}

/** Сохранение полей: только известные ключи, каждый своей проверкой. */
function ag_save_meta($post_id, $post)
{
    if (!isset($_POST['ag_meta_nonce']) || !wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['ag_meta_nonce'])), 'ag_save_meta')) {
        return;
    }
    if ((defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) || !current_user_can('edit_post', $post_id)) {
        return;
    }
    $in = isset($_POST['ag']) && is_array($_POST['ag']) ? wp_unslash($_POST['ag']) : array();
    $date = function ($s) {
        return preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) $s) ? (string) $s : '';
    };
    $fields = array(
        'ag_competition' => array(
            '_ag_start' => $date, '_ag_end' => $date, '_ag_deadline' => $date,
            '_ag_venue' => 'sanitize_text_field', '_ag_city' => 'sanitize_text_field', '_ag_levels' => 'sanitize_text_field',
            '_ag_gender' => function ($s) {
                return in_array($s, array('girls', 'boys', 'both'), true) ? $s : 'both';
            },
            '_ag_stage' => function ($s) {
                return in_array($s, array('before', 'live', 'done'), true) ? $s : '';
            },
            '_ag_board_theme' => function ($s) {
                return $s === 'light' ? 'light' : 'dark';
            },
            '_ag_ids' => function ($s) {
                preg_match_all('/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i', (string) $s, $m);
                return implode(', ', array_slice(array_unique(array_map('strtolower', $m[0])), 0, 4));
            },
            '_ag_entry_key' => function ($s) {
                $s = trim((string) $s);
                // Можно вставить ссылку на форму (…&k=ключ) или шорткод кнопки [ag_entry … key="ключ"].
                if (preg_match('/[#&?]k=([A-Za-z0-9_-]+)/', $s, $m) || preg_match('/key=["\']?([A-Za-z0-9_-]+)/', $s, $m)) {
                    $s = $m[1];
                }
                return preg_match('/^[A-Za-z0-9_-]{16,128}$/', $s) ? $s : '';
            },
            '_ag_program' => 'sanitize_textarea_field',
            '_ag_docs' => function ($s) {
                return implode(',', array_filter(array_map('absint', explode(',', (string) $s))));
            },
        ),
        'ag_club' => array(
            '_ag_city' => 'sanitize_text_field', '_ag_address' => 'sanitize_text_field', '_ag_phone' => 'sanitize_text_field',
            '_ag_site' => 'esc_url_raw', '_ag_coaches' => 'sanitize_textarea_field', '_ag_aliases' => 'sanitize_text_field',
        ),
        'ag_document' => array('_ag_file' => 'absint', '_ag_link' => 'esc_url_raw'),
        'post' => array('_ag_competition' => 'absint'),
    );
    if (!isset($fields[$post->post_type])) {
        return;
    }
    foreach ($fields[$post->post_type] as $key => $clean) {
        if (!array_key_exists($key, $in)) {
            continue;
        }
        $value = call_user_func($clean, is_string($in[$key]) ? $in[$key] : '');
        if ($value === '' || $value === 0) {
            delete_post_meta($post_id, $key);
        } else {
            update_post_meta($post_id, $key, $value);
        }
    }
    if ($post->post_type === 'ag_competition') {
        // Календарь сортирует и отбирает по окончанию: у однодневного старта оно равно началу.
        $start = (string) get_post_meta($post_id, '_ag_start', true);
        $end = (string) get_post_meta($post_id, '_ag_end', true);
        if ($start !== '' && ($end === '' || $end < $start)) {
            update_post_meta($post_id, '_ag_end', $start);
        }
    }
}
add_action('save_post', 'ag_save_meta', 10, 2);

/* ------------------------------------------------------------------ */
/* Колонки в списке соревнований                                        */
/* ------------------------------------------------------------------ */

function ag_competition_columns($cols)
{
    $out = array();
    foreach ($cols as $k => $v) {
        if ($k === 'date') {
            continue;
        }
        $out[$k] = $v;
        if ($k === 'title') {
            $out['ag_dates'] = 'Даты';
            $out['ag_stage'] = 'Стадия';
            $out['ag_link'] = 'Программа';
        }
    }
    return $out;
}
add_filter('manage_ag_competition_posts_columns', 'ag_competition_columns');

function ag_competition_column($col, $post_id)
{
    $c = ag_competition($post_id);
    if ($col === 'ag_dates') {
        echo esc_html(ag_date_range($c['start'], $c['end'], true));
    } elseif ($col === 'ag_stage') {
        $names = array('before' => 'До старта', 'live' => 'Идёт', 'done' => 'Завершено');
        echo esc_html($names[ag_stage($c)]);
    } elseif ($col === 'ag_link') {
        echo $c['ids'] ? 'ID указан' . ($c['entry_key'] !== '' ? ', заявки' : '') : '<span style="color:#b32d2e">нет ID</span>';
    }
}
add_action('manage_ag_competition_posts_custom_column', 'ag_competition_column', 10, 2);

function ag_competition_sortable($cols)
{
    $cols['ag_dates'] = 'ag_dates';
    return $cols;
}
add_filter('manage_edit-ag_competition_sortable_columns', 'ag_competition_sortable');

function ag_admin_order($query)
{
    if (!is_admin() || !$query->is_main_query() || $query->get('post_type') !== 'ag_competition') {
        return;
    }
    if ($query->get('orderby') === 'ag_dates' || $query->get('orderby') === '') {
        $query->set('meta_key', '_ag_start');
        $query->set('orderby', 'meta_value');
        if ($query->get('order') === '') {
            $query->set('order', 'DESC');
        }
    }
}
add_action('pre_get_posts', 'ag_admin_order');

/** Архивы на сайте: календарь сам решает, что показывать, клубы — по порядку и алфавиту. */
function ag_front_queries($query)
{
    if (is_admin() || !$query->is_main_query()) {
        return;
    }
    if ($query->is_post_type_archive('ag_competition')) {
        $f = ag_calendar_filters();
        $args = ag_competitions_args($f['period'], array('gender' => $f['gender'], 'entries' => $f['entries'], 'year' => $f['year'], 'per_page' => 20));
        foreach (array('posts_per_page', 'meta_key', 'orderby', 'order', 'meta_query') as $k) {
            $query->set($k, $args[$k]);
        }
    }
    if ($query->is_post_type_archive('ag_club')) {
        $query->set('posts_per_page', 60);
        $query->set('orderby', array('menu_order' => 'ASC', 'title' => 'ASC'));
    }
    if ($query->is_post_type_archive('ag_athlete')) {
        $query->set('posts_per_page', 120);
        $query->set('orderby', 'title');
        $query->set('order', 'ASC');
        $find = isset($_GET['q']) ? sanitize_text_field(wp_unslash($_GET['q'])) : '';
        if ($find !== '') {
            $query->set('s', $find);
        }
        $letter = isset($_GET['letter']) ? mb_substr(sanitize_text_field(wp_unslash($_GET['letter'])), 0, 1) : '';
        if ($letter !== '') {
            $query->set('ag_letter', $letter);
        }
        $gender = isset($_GET['gender']) ? sanitize_key(wp_unslash($_GET['gender'])) : '';
        if (in_array($gender, array('girls', 'boys'), true)) {
            $query->set('meta_key', '_ag_gender');
            $query->set('meta_value', $gender);
        }
    }
    if ($query->is_post_type_archive('ag_document') || $query->is_tax('ag_doc_group')) {
        $query->set('posts_per_page', 200);
    }
}
add_action('pre_get_posts', 'ag_front_queries');

/** Фильтр спортсменов по первой букве фамилии. */
function ag_letter_where($where, $query)
{
    $letter = $query->get('ag_letter');
    if ($letter !== '' && $letter !== null) {
        global $wpdb;
        $where .= $wpdb->prepare(" AND {$wpdb->posts}.post_title LIKE %s", $wpdb->esc_like($letter) . '%');
    }
    return $where;
}
add_filter('posts_where', 'ag_letter_where', 10, 2);

/** Фильтры календаря из адреса: period=past, gender=girls|boys, entries=1, year=2026. */
function ag_calendar_filters()
{
    $period = isset($_GET['period']) && $_GET['period'] === 'past' ? 'past' : 'upcoming';
    $gender = isset($_GET['gender']) ? sanitize_key(wp_unslash($_GET['gender'])) : '';
    return array(
        'period' => $period,
        'gender' => in_array($gender, array('girls', 'boys'), true) ? $gender : '',
        'entries' => !empty($_GET['entries']) && $period === 'upcoming',
        'year' => isset($_GET['year']) ? absint($_GET['year']) : 0,
    );
}

/** Ссылка на файл документа. */
function ag_document_url($post_id)
{
    $att = (int) get_post_meta($post_id, '_ag_file', true);
    if ($att && ($url = wp_get_attachment_url($att))) {
        return $url;
    }
    return (string) get_post_meta($post_id, '_ag_link', true);
}

/** Документ ведёт сразу на файл, а не на пустую страницу записи. */
function ag_document_redirect()
{
    if (is_singular('ag_document')) {
        $url = ag_document_url(get_queried_object_id());
        if ($url !== '') {
            wp_redirect($url);
            exit;
        }
    }
}
add_action('template_redirect', 'ag_document_redirect');
