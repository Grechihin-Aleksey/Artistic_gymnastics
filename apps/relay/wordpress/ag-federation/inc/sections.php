<?php
/**
 * Занятия и объявления: что администратор публикует сам, без программы соревнований.
 *   ag_group  — учебные группы: клуб, тренер, возраст, расписание по дням недели, состав;
 *               из расписаний всех групп собирается общая сетка «Расписание занятий»;
 *   ag_notice — объявления: важные идут первыми, по дате «Показывать до» сами уходят в архив.
 */

if (!defined('ABSPATH')) {
    exit;
}

const AG_DAYS = array(1 => 'Понедельник', 2 => 'Вторник', 3 => 'Среда', 4 => 'Четверг', 5 => 'Пятница', 6 => 'Суббота', 7 => 'Воскресенье');
const AG_DAYS_SHORT = array(1 => 'Пн', 2 => 'Вт', 3 => 'Ср', 4 => 'Чт', 5 => 'Пт', 6 => 'Сб', 7 => 'Вс');
const AG_GROUP_LEVELS = array(
    'so' => 'Спортивно-оздоровительная',
    'np' => 'Начальная подготовка',
    'ut' => 'Учебно-тренировочная',
    'ssm' => 'Спортивное совершенствование',
    'vsm' => 'Высшее спортивное мастерство',
);

function ag_register_sections()
{
    register_post_type('ag_group', array(
        'labels' => array(
            'name' => 'Учебные группы',
            'singular_name' => 'Группа',
            'menu_name' => 'Группы и расписание',
            'add_new' => 'Добавить группу',
            'add_new_item' => 'Новая группа',
            'edit_item' => 'Изменить группу',
            'view_item' => 'Открыть страницу группы',
            'all_items' => 'Все группы',
            'not_found' => 'Групп пока нет',
        ),
        'public' => true,
        'has_archive' => 'groups',
        'rewrite' => array('slug' => 'groups', 'with_front' => false),
        'menu_icon' => 'dashicons-clock',
        'menu_position' => 8,
        'supports' => array('title', 'editor', 'page-attributes'),
        'show_in_rest' => true,
    ));

    register_post_type('ag_notice', array(
        'labels' => array(
            'name' => 'Объявления',
            'singular_name' => 'Объявление',
            'add_new' => 'Добавить объявление',
            'add_new_item' => 'Новое объявление',
            'edit_item' => 'Изменить объявление',
            'view_item' => 'Открыть объявление',
            'all_items' => 'Все объявления',
            'not_found' => 'Объявлений пока нет',
        ),
        'public' => true,
        'has_archive' => 'notices',
        'rewrite' => array('slug' => 'notices', 'with_front' => false),
        'menu_icon' => 'dashicons-megaphone',
        'menu_position' => 9,
        'supports' => array('title', 'editor'),
        'show_in_rest' => true,
    ));
}
add_action('init', 'ag_register_sections');

/** Новые разделы появились после обновления темы: один раз обновляем адреса, чтобы /groups/ открывался. */
function ag_maybe_flush_rewrites()
{
    if (get_option('ag_rewrite_version') !== AG_THEME_VERSION) {
        flush_rewrite_rules();
        update_option('ag_rewrite_version', AG_THEME_VERSION);
    }
}
add_action('init', 'ag_maybe_flush_rewrites', 99);

/* ------------------------------------------------------------------ */
/* Данные                                                               */
/* ------------------------------------------------------------------ */

/** Расписание группы: [['day' => 1..7, 'from' => '17:00', 'to' => '18:30', 'place' => 'зал 2'], …] по дням и времени. */
function ag_group_schedule($post_id)
{
    $rows = json_decode((string) get_post_meta($post_id, '_ag_schedule', true), true);
    return is_array($rows) ? $rows : array();
}

function ag_group($post = null)
{
    $post = get_post($post);
    $id = $post->ID;
    $m = function ($k) use ($id) {
        return (string) get_post_meta($id, $k, true);
    };
    $club = (int) $m('_ag_club');
    if ($club && get_post_status($club) !== 'publish') {
        $club = 0;
    }
    return array(
        'post' => $post,
        'club' => $club,
        'coach' => $m('_ag_coach'),
        'level' => $m('_ag_level'),
        'gender' => $m('_ag_gender'),
        'ages' => $m('_ag_ages'),
        'place' => $m('_ag_place'),
        'recruit' => $m('_ag_recruit') === '1',
        'period' => $m('_ag_period'),
        'schedule' => ag_group_schedule($id),
        'roster' => array_values(array_filter(array_map('trim', preg_split('/\r?\n/', $m('_ag_roster'))))),
    );
}

/** «Начальная подготовка · девочки · 2017–2018 г.р.» */
function ag_group_meta_line($g, $with_club = false)
{
    $parts = array();
    if ($with_club && $g['club']) {
        $parts[] = get_the_title($g['club']);
    }
    if (isset(AG_GROUP_LEVELS[$g['level']])) {
        $parts[] = AG_GROUP_LEVELS[$g['level']];
    }
    if ($g['gender'] === 'girls') {
        $parts[] = 'девочки';
    } elseif ($g['gender'] === 'boys') {
        $parts[] = 'мальчики';
    }
    if ($g['ages'] !== '') {
        $parts[] = $g['ages'];
    }
    return implode(' · ', $parts);
}

/** Коротко: «Пн, Ср, Пт 17:00–18:30 · Вт 16:00–17:00». Дни с одинаковым временем склеиваются. */
function ag_schedule_summary($rows)
{
    return implode(' · ', array_map(function ($b) {
        return ag_days_label($b['days']) . ' ' . $b['time'];
    }, ag_schedule_blocks($rows)));
}

/** Занятия, сгруппированные по времени: [['days' => [1, 3, 5], 'time' => '17:00–18:30'], …] в порядке первого дня. */
function ag_schedule_blocks($rows)
{
    $by_time = array();
    foreach ($rows as $r) {
        $time = $r['from'] . ($r['to'] !== '' ? '–' . $r['to'] : '');
        $by_time[$time][] = (int) $r['day'];
    }
    $out = array();
    foreach ($by_time as $time => $days) {
        $days = array_values(array_unique($days));
        sort($days);
        $out[] = array('days' => $days, 'time' => $time);
    }
    usort($out, function ($a, $b) {
        return $a['days'][0] <=> $b['days'][0] ?: strcmp($a['time'], $b['time']);
    });
    return $out;
}

/** «Пн–Пт», «Пн, Ср, Пт», «Сб». */
function ag_days_label($days)
{
    $n = count($days);
    if ($n >= 3 && $days[$n - 1] - $days[0] === $n - 1) {
        return AG_DAYS_SHORT[$days[0]] . '–' . AG_DAYS_SHORT[$days[$n - 1]];
    }
    return implode(', ', array_map(function ($d) {
        return AG_DAYS_SHORT[$d];
    }, $days));
}

/** День недели сегодня: 1 — понедельник. */
function ag_weekday_today()
{
    return (int) wp_date('N');
}

/**
 * Объявления: сначала важные, затем свежие. $active — только те, у кого срок «Показывать до» не прошёл.
 * $club — объявления этого клуба и общие.
 */
function ag_notices($limit = 3, $club = 0, $active = true)
{
    $meta = array();
    if ($active) {
        $meta[] = array(
            'relation' => 'OR',
            array('key' => '_ag_until', 'compare' => 'NOT EXISTS'),
            array('key' => '_ag_until', 'value' => ag_today(), 'compare' => '>='),
        );
    }
    if ($club) {
        $meta[] = array(
            'relation' => 'OR',
            array('key' => '_ag_club', 'compare' => 'NOT EXISTS'),
            array('key' => '_ag_club', 'value' => (string) $club),
        );
    }
    $posts = get_posts(array(
        'post_type' => 'ag_notice',
        'posts_per_page' => $limit * 3 + 10,
        'meta_query' => $meta,
        'orderby' => 'date',
        'order' => 'DESC',
    ));
    usort($posts, function ($a, $b) {
        $ia = get_post_meta($a->ID, '_ag_important', true) === '1';
        $ib = get_post_meta($b->ID, '_ag_important', true) === '1';
        if ($ia !== $ib) {
            return $ia ? -1 : 1;
        }
        return strcmp($b->post_date, $a->post_date);
    });
    return array_slice($posts, 0, $limit);
}

function ag_notice_expired($post_id)
{
    $until = (string) get_post_meta($post_id, '_ag_until', true);
    return $until !== '' && $until < ag_today();
}

/* ------------------------------------------------------------------ */
/* Поля в админке                                                       */
/* ------------------------------------------------------------------ */

function ag_section_boxes()
{
    add_meta_box('ag_group_main', 'Группа: клуб, тренер, расписание', 'ag_group_box', 'ag_group', 'normal', 'high');
    add_meta_box('ag_group_roster', 'Состав группы', 'ag_group_roster_box', 'ag_group', 'normal', 'default');
    add_meta_box('ag_notice_main', 'Как показывать объявление', 'ag_notice_box', 'ag_notice', 'side', 'high');
}
add_action('add_meta_boxes', 'ag_section_boxes');

function ag_club_options($current)
{
    $clubs = get_posts(array('post_type' => 'ag_club', 'posts_per_page' => 200, 'orderby' => 'title', 'order' => 'ASC'));
    $html = '<option value="">— не указан —</option>';
    foreach ($clubs as $c) {
        $html .= '<option value="' . (int) $c->ID . '"' . selected($current, $c->ID, false) . '>' . esc_html(get_the_title($c)) . '</option>';
    }
    return $html;
}

function ag_schedule_row_html($r = null)
{
    $day = $r ? (int) $r['day'] : 0;
    $opts = '';
    foreach (AG_DAYS as $n => $name) {
        $opts .= '<option value="' . $n . '"' . selected($day, $n, false) . '>' . esc_html($name) . '</option>';
    }
    return '<tr class="ag-sched__row">'
        . '<td><select name="ag_sched[day][]">' . $opts . '</select></td>'
        . '<td><input type="time" name="ag_sched[from][]" value="' . esc_attr($r['from'] ?? '') . '"></td>'
        . '<td><input type="time" name="ag_sched[to][]" value="' . esc_attr($r['to'] ?? '') . '"></td>'
        . '<td><input type="text" name="ag_sched[place][]" value="' . esc_attr($r['place'] ?? '') . '" placeholder="как у группы"></td>'
        . '<td><button type="button" class="button-link ag-sched__remove" aria-label="Убрать занятие">убрать</button></td>'
        . '</tr>';
}

function ag_group_box($post)
{
    wp_nonce_field('ag_save_meta', 'ag_meta_nonce');
    $g = ag_group($post);
    $v = function ($k) use ($post) {
        return esc_attr((string) get_post_meta($post->ID, $k, true));
    };
    echo '<div class="ag-grid">';
    ag_field('Клуб или школа', '<select name="ag[_ag_club]">' . ag_club_options((int) get_post_meta($post->ID, '_ag_club', true)) . '</select>', 'Список берётся из раздела «Клубы».');
    ag_field('Тренер', '<input type="text" name="ag[_ag_coach]" value="' . $v('_ag_coach') . '" placeholder="Иванова Мария Петровна">');
    $opts = '<option value="">—</option>';
    foreach (AG_GROUP_LEVELS as $k => $label) {
        $opts .= '<option value="' . esc_attr($k) . '"' . selected($g['level'], $k, false) . '>' . esc_html($label) . '</option>';
    }
    ag_field('Этап подготовки', '<select name="ag[_ag_level]">' . $opts . '</select>');
    $opts = '';
    foreach (array('' => 'Все', 'girls' => 'Девочки', 'boys' => 'Мальчики') as $k => $label) {
        $opts .= '<option value="' . esc_attr($k) . '"' . selected($g['gender'], $k, false) . '>' . esc_html($label) . '</option>';
    }
    ag_field('Кто занимается', '<select name="ag[_ag_gender]">' . $opts . '</select>');
    ag_field('Возраст', '<input type="text" name="ag[_ag_ages]" value="' . $v('_ag_ages') . '" placeholder="2017–2018 г.р. или 5–7 лет">');
    ag_field('Где занимается', '<input type="text" name="ag[_ag_place]" value="' . $v('_ag_place') . '" placeholder="ФОК «Мещерский», зал 2">');
    ag_field('Период', '<input type="text" name="ag[_ag_period]" value="' . $v('_ag_period') . '" placeholder="с 1 сентября по 31 мая">', 'Необязательно: когда действует расписание.');
    ag_field('Набор', '<label style="font-weight:400"><input type="checkbox" name="ag[_ag_recruit]" value="1"' . checked($g['recruit'], true, false) . '> Идёт набор в группу</label>', 'На сайте у группы появится плашка «Идёт набор» и телефон клуба.');
    echo '</div>';

    echo '<h3 class="ag-section">Расписание занятий</h3>';
    echo '<input type="hidden" name="ag_sched_present" value="1">';
    echo '<table class="ag-sched widefat striped" data-ag-sched><thead><tr><th>День</th><th>Начало</th><th>Конец</th><th>Место (если не обычное)</th><th></th></tr></thead><tbody>';
    foreach ($g['schedule'] as $r) {
        echo ag_schedule_row_html($r); // phpcs:ignore WordPress.Security.EscapeOutput -- собрано с экранированием
    }
    echo '</tbody></table>';
    echo '<template data-ag-sched-template>' . ag_schedule_row_html() . '</template>'; // phpcs:ignore WordPress.Security.EscapeOutput
    echo '<p><button type="button" class="button ag-sched__add">+ Добавить занятие</button> <span class="description">Новое занятие копирует время предыдущего, меняйте только день.</span></p>';
}

function ag_group_roster_box($post)
{
    echo '<textarea name="ag[_ag_roster]" rows="8" style="width:100%" placeholder="Абрамова Анна, 2017&#10;Белова Вера, 2018">' . esc_textarea((string) get_post_meta($post->ID, '_ag_roster', true)) . '</textarea>';
    echo '<p class="description">Каждый спортсмен с новой строки, можно с годом рождения. Список виден на сайте всем: публикуйте его с согласия родителей. Пусто — состав на странице не показывается.</p>';
}

function ag_notice_box($post)
{
    wp_nonce_field('ag_save_meta', 'ag_meta_nonce');
    $important = get_post_meta($post->ID, '_ag_important', true) === '1';
    echo '<p><label><input type="checkbox" name="ag[_ag_important]" value="1"' . checked($important, true, false) . '> <b>Важное</b>: выделено цветом и стоит первым</label></p>';
    echo '<p><label for="ag-until"><b>Показывать до</b></label><br><input id="ag-until" type="date" name="ag[_ag_until]" value="' . esc_attr((string) get_post_meta($post->ID, '_ag_until', true)) . '" style="width:100%"></p>';
    echo '<p class="description">После этой даты объявление уходит с главной в архив. Пусто — висит, пока не снимете.</p>';
    echo '<p><label><b>Для клуба</b></label><br><select name="ag[_ag_club]" style="width:100%">' . str_replace('— не указан —', 'Для всех', ag_club_options((int) get_post_meta($post->ID, '_ag_club', true))) . '</select></p>';
    echo '<p class="description">Объявление клуба видно и на странице клуба, и в общем списке.</p>';
}

/** Сохранение полей групп и объявлений (поля соревнований, клубов и документов сохраняет ag_save_meta). */
function ag_save_section_meta($post_id, $post)
{
    if (!in_array($post->post_type, array('ag_group', 'ag_notice'), true)) {
        return;
    }
    if (!isset($_POST['ag_meta_nonce']) || !wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['ag_meta_nonce'])), 'ag_save_meta')) {
        return;
    }
    if ((defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) || !current_user_can('edit_post', $post_id)) {
        return;
    }
    $in = isset($_POST['ag']) && is_array($_POST['ag']) ? wp_unslash($_POST['ag']) : array();
    $str = function ($k) use ($in) {
        return isset($in[$k]) && is_string($in[$k]) ? $in[$k] : '';
    };
    $put = function ($k, $value) use ($post_id) {
        if ($value === '' || $value === 0 || $value === '0') {
            delete_post_meta($post_id, $k);
        } else {
            update_post_meta($post_id, $k, $value);
        }
    };
    $club = absint($str('_ag_club'));
    $put('_ag_club', $club && get_post_type($club) === 'ag_club' ? (string) $club : '');

    if ($post->post_type === 'ag_notice') {
        $put('_ag_important', $str('_ag_important') === '1' ? '1' : '');
        $until = $str('_ag_until');
        $put('_ag_until', preg_match('/^\d{4}-\d{2}-\d{2}$/', $until) ? $until : '');
        return;
    }

    $put('_ag_coach', sanitize_text_field($str('_ag_coach')));
    $put('_ag_level', array_key_exists($str('_ag_level'), AG_GROUP_LEVELS) ? $str('_ag_level') : '');
    $put('_ag_gender', in_array($str('_ag_gender'), array('girls', 'boys'), true) ? $str('_ag_gender') : '');
    $put('_ag_ages', sanitize_text_field($str('_ag_ages')));
    $put('_ag_place', sanitize_text_field($str('_ag_place')));
    $put('_ag_period', sanitize_text_field($str('_ag_period')));
    $put('_ag_recruit', $str('_ag_recruit') === '1' ? '1' : '');
    $put('_ag_roster', sanitize_textarea_field($str('_ag_roster')));

    if (!empty($_POST['ag_sched_present'])) {
        $s = isset($_POST['ag_sched']) && is_array($_POST['ag_sched']) ? wp_unslash($_POST['ag_sched']) : array();
        $rows = array();
        $time = function ($t) {
            return is_string($t) && preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', $t) ? $t : '';
        };
        foreach ((array) ($s['day'] ?? array()) as $i => $day) {
            $day = (int) $day;
            $from = $time($s['from'][$i] ?? '');
            $to = $time($s['to'][$i] ?? '');
            if ($day < 1 || $day > 7 || $from === '') {
                continue;
            }
            if ($to !== '' && $to <= $from) {
                $to = '';
            }
            $rows[] = array('day' => $day, 'from' => $from, 'to' => $to, 'place' => sanitize_text_field((string) ($s['place'][$i] ?? '')));
        }
        usort($rows, function ($a, $b) {
            return $a['day'] <=> $b['day'] ?: strcmp($a['from'], $b['from']);
        });
        $put('_ag_schedule', $rows ? wp_json_encode($rows, JSON_UNESCAPED_UNICODE) : '');
    }
}
add_action('save_post', 'ag_save_section_meta', 10, 2);

/* Колонки в списках админки */

function ag_group_columns($cols)
{
    return array(
        'cb' => $cols['cb'],
        'title' => 'Группа',
        'ag_club' => 'Клуб',
        'ag_coach' => 'Тренер',
        'ag_schedule' => 'Расписание',
        'ag_roster' => 'Состав',
    );
}
add_filter('manage_ag_group_posts_columns', 'ag_group_columns');

function ag_group_column($col, $post_id)
{
    $g = ag_group($post_id);
    if ($col === 'ag_club') {
        echo $g['club'] ? esc_html(get_the_title($g['club'])) : '—';
    } elseif ($col === 'ag_coach') {
        echo esc_html($g['coach'] !== '' ? $g['coach'] : '—');
    } elseif ($col === 'ag_schedule') {
        echo esc_html($g['schedule'] ? ag_schedule_summary($g['schedule']) : '—');
    } elseif ($col === 'ag_roster') {
        echo $g['roster'] ? (int) count($g['roster']) : '—';
    }
}
add_action('manage_ag_group_posts_custom_column', 'ag_group_column', 10, 2);

function ag_notice_columns($cols)
{
    $date = $cols['date'];
    unset($cols['date']);
    $cols['ag_until'] = 'Показывать до';
    $cols['date'] = $date;
    return $cols;
}
add_filter('manage_ag_notice_posts_columns', 'ag_notice_columns');

function ag_notice_column($col, $post_id)
{
    if ($col !== 'ag_until') {
        return;
    }
    $until = (string) get_post_meta($post_id, '_ag_until', true);
    $mark = get_post_meta($post_id, '_ag_important', true) === '1' ? '<b>Важное</b> · ' : '';
    echo $mark . ($until === '' ? 'пока не снимут' : esc_html(ag_date_range($until, $until)) . (ag_notice_expired($post_id) ? ' (уже в архиве)' : ''));
}
add_action('manage_ag_notice_posts_custom_column', 'ag_notice_column', 10, 2);

/* ------------------------------------------------------------------ */
/* Запросы на сайте                                                     */
/* ------------------------------------------------------------------ */

/** Фильтры страницы групп из адреса: club=ID, gender=girls|boys, view=week. */
function ag_group_filters()
{
    $gender = isset($_GET['gender']) ? sanitize_key(wp_unslash($_GET['gender'])) : '';
    return array(
        'club' => isset($_GET['club']) ? absint($_GET['club']) : 0,
        'gender' => in_array($gender, array('girls', 'boys'), true) ? $gender : '',
        'week' => isset($_GET['view']) && $_GET['view'] === 'week',
    );
}

function ag_section_queries($query)
{
    if (is_admin() || !$query->is_main_query()) {
        return;
    }
    if ($query->is_post_type_archive('ag_group')) {
        $f = ag_group_filters();
        $query->set('posts_per_page', 300);
        $query->set('orderby', array('menu_order' => 'ASC', 'title' => 'ASC'));
        $meta = array();
        if ($f['club']) {
            $meta[] = array('key' => '_ag_club', 'value' => (string) $f['club']);
        }
        if ($f['gender']) {
            // Группа «для всех» подходит и девочкам, и мальчикам.
            $meta[] = array('relation' => 'OR', array('key' => '_ag_gender', 'value' => $f['gender']), array('key' => '_ag_gender', 'compare' => 'NOT EXISTS'));
        }
        if ($meta) {
            $query->set('meta_query', $meta);
        }
    }
    if ($query->is_post_type_archive('ag_notice')) {
        $query->set('posts_per_page', 30);
    }
}
add_action('pre_get_posts', 'ag_section_queries');

/* ------------------------------------------------------------------ */
/* Блоки страниц                                                        */
/* ------------------------------------------------------------------ */

/** Карточка группы в списке. */
function ag_group_card($g, $with_club = true)
{
    $url = get_permalink($g['post']);
    $phone = $g['club'] ? (string) get_post_meta($g['club'], '_ag_phone', true) : '';
    ?>
    <article class="card group-card">
        <div class="group-card__head">
            <h3 class="group-card__title"><a href="<?php echo esc_url($url); ?>"><?php echo esc_html(get_the_title($g['post'])); ?></a></h3>
            <?php if ($g['recruit']) : ?><span class="chip chip--done">Идёт набор</span><?php endif; ?>
        </div>
        <?php $line = ag_group_meta_line($g, $with_club); if ($line !== '') : ?><p class="group-card__meta"><?php echo esc_html($line); ?></p><?php endif; ?>
        <?php if ($g['schedule']) : ?>
            <ul class="slots">
                <?php foreach (ag_schedule_blocks($g['schedule']) as $b) : ?>
                    <li class="slot<?php echo in_array(ag_weekday_today(), $b['days'], true) ? ' slot--today' : ''; ?>"><b><?php echo esc_html(ag_days_label($b['days'])); ?></b><?php echo esc_html($b['time']); ?></li>
                <?php endforeach; ?>
            </ul>
        <?php else : ?>
            <p class="muted small">Расписание уточняйте у тренера.</p>
        <?php endif; ?>
        <div class="group-card__foot">
            <?php if ($g['coach'] !== '') : ?><span><?php echo ag_icon('user', 16); ?> <?php echo esc_html($g['coach']); ?></span><?php endif; ?>
            <?php if ($g['place'] !== '') : ?><span><?php echo ag_icon('pin', 16); ?> <?php echo esc_html($g['place']); ?></span><?php endif; ?>
            <?php if ($g['recruit'] && $phone !== '') : ?><span><?php echo ag_icon('phone', 16); ?> <a href="tel:<?php echo esc_attr(preg_replace('/[^0-9+]/', '', $phone)); ?>"><?php echo esc_html($phone); ?></a></span><?php endif; ?>
        </div>
    </article>
    <?php
}

/**
 * Сетка «Расписание по дням недели» из расписаний групп.
 * $groups — массив ag_group(). На телефоне дни идут друг под другом, пустые дни скрыты.
 */
function ag_week_grid($groups, $with_club = true)
{
    $days = array_fill_keys(array_keys(AG_DAYS), array());
    foreach ($groups as $g) {
        foreach ($g['schedule'] as $r) {
            $days[(int) $r['day']][] = array('r' => $r, 'g' => $g);
        }
    }
    foreach ($days as &$list) {
        usort($list, function ($a, $b) {
            return strcmp($a['r']['from'], $b['r']['from']);
        });
    }
    unset($list);
    $weekend = $days[6] || $days[7];
    $today = ag_weekday_today();
    echo '<div class="week' . ($weekend ? '' : ' week--5') . '">';
    foreach ($days as $n => $list) {
        if (!$weekend && $n > 5) {
            continue;
        }
        echo '<section class="week__day' . ($n === $today ? ' is-today' : '') . ($list ? '' : ' is-empty') . '">';
        echo '<h3 class="week__name">' . esc_html(AG_DAYS[$n]) . ($n === $today ? ' <span>сегодня</span>' : '') . '</h3>';
        if (!$list) {
            echo '<p class="week__none">Занятий нет</p>';
        }
        foreach ($list as $item) {
            $r = $item['r'];
            $g = $item['g'];
            $place = $r['place'] !== '' ? $r['place'] : $g['place'];
            $sub = array_filter(array($with_club && $g['club'] ? get_the_title($g['club']) : '', $g['coach']));
            echo '<a class="week__slot" href="' . esc_url(get_permalink($g['post'])) . '">';
            echo '<span class="week__time">' . esc_html($r['from'] . ($r['to'] !== '' ? '–' . $r['to'] : '')) . '</span>';
            echo '<b>' . esc_html(get_the_title($g['post'])) . '</b>';
            if ($sub) {
                echo '<small>' . esc_html(implode(' · ', $sub)) . '</small>';
            }
            if ($place !== '') {
                echo '<small>' . esc_html($place) . '</small>';
            }
            echo '</a>';
        }
        echo '</section>';
    }
    echo '</div>';
}

/** Объявление в списке. $compact — для главной и боковых колонок. */
function ag_notice_card($post, $compact = false)
{
    $important = get_post_meta($post->ID, '_ag_important', true) === '1';
    $expired = ag_notice_expired($post->ID);
    $club = (int) get_post_meta($post->ID, '_ag_club', true);
    $text = has_excerpt($post) ? get_the_excerpt($post) : wp_trim_words(wp_strip_all_tags(strip_shortcodes($post->post_content)), $compact ? 22 : 40, '…');
    ?>
    <article class="notice<?php echo $important ? ' notice--important' : ''; ?><?php echo $expired ? ' notice--past' : ''; ?>">
        <p class="notice__meta">
            <?php if ($important && !$expired) : ?><span class="notice__flag">Важно</span><?php endif; ?>
            <span><?php echo esc_html(ag_post_date($post)); ?></span>
            <?php if ($club && get_post_status($club) === 'publish') : ?><span><?php echo esc_html(get_the_title($club)); ?></span><?php endif; ?>
        </p>
        <h3 class="notice__title"><a href="<?php echo esc_url(get_permalink($post)); ?>"><?php echo esc_html(get_the_title($post)); ?></a></h3>
        <?php if ($text !== '') : ?><p class="notice__text"><?php echo esc_html($text); ?></p><?php endif; ?>
    </article>
    <?php
}

/** Ссылки «Группы и расписание», «Объявления» для меню и подвала. */
function ag_groups_url($week = false)
{
    $url = get_post_type_archive_link('ag_group');
    return $week ? add_query_arg('view', 'week', $url) : $url;
}

function ag_has_groups()
{
    static $has = null;
    if ($has === null) {
        $has = (bool) get_posts(array('post_type' => 'ag_group', 'posts_per_page' => 1, 'fields' => 'ids'));
    }
    return $has;
}

function ag_has_notices()
{
    static $has = null;
    if ($has === null) {
        $has = (bool) get_posts(array('post_type' => 'ag_notice', 'posts_per_page' => 1, 'fields' => 'ids'));
    }
    return $has;
}

/** Группы клуба на его странице: карточки и недельная сетка. */
function ag_club_groups_section($club_id)
{
    $posts = get_posts(array(
        'post_type' => 'ag_group',
        'posts_per_page' => 100,
        'orderby' => array('menu_order' => 'ASC', 'title' => 'ASC'),
        'meta_query' => array(array('key' => '_ag_club', 'value' => (string) $club_id)),
    ));
    if (!$posts) {
        return;
    }
    $groups = array_map('ag_group', $posts);
    ?>
    <div class="card">
        <?php ag_section_head('Группы и расписание', add_query_arg('club', $club_id, ag_groups_url(true)), 'Сетка на неделю', 'h2'); ?>
        <div class="group-list">
            <?php foreach ($groups as $g) {
                ag_group_card($g, false);
            } ?>
        </div>
    </div>
    <?php
}
