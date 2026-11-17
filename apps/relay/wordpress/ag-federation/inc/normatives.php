<?php
/**
 * Нормативы по группам.
 *
 *   ag_norm_set  — набор нормативов федерации для этапа подготовки и пола: упражнения, единицы,
 *                  «больше — лучше» или «меньше — лучше», норма и сколько упражнений нужно выполнить;
 *   ag_norm_test — сдача нормативов группой: дата, девочки или мальчики, ведомость «спортсмен × упражнение».
 *                  Норматив подбирается сам по этапу группы и полу, зачёт считается сам.
 *
 * Пока ведомость — черновик, сдача идёт и на сайте её не видно. Когда сдача закончена, тренер нажимает
 * «Опубликовать»: итоги появляются на странице группы, клуба и в разделе /normatives/, а ведомость
 * открывается отдельной страницей, которую можно распечатать или сохранить в PDF.
 * Фамилии в опубликованной ведомости можно скрыть отметкой — тогда видно только «сдали 8 из 10».
 */

if (!defined('ABSPATH')) {
    exit;
}

function ag_register_normatives()
{
    register_post_type('ag_norm_set', array(
        'labels' => array(
            'name' => 'Нормативы',
            'singular_name' => 'Нормативы',
            'menu_name' => 'Нормативы',
            'all_items' => 'Нормативы по этапам',
            'add_new' => 'Добавить нормативы',
            'add_new_item' => 'Новые нормативы',
            'edit_item' => 'Изменить нормативы',
            'not_found' => 'Нормативов пока нет',
        ),
        'public' => false,
        'show_ui' => true,
        'menu_icon' => 'dashicons-yes-alt',
        'menu_position' => 9,
        'supports' => array('title'),
        'capability_type' => 'post',
    ));

    register_post_type('ag_norm_test', array(
        'labels' => array(
            'name' => 'Сдача нормативов',
            'singular_name' => 'Сдача нормативов',
            'all_items' => 'Сдача нормативов',
            'add_new' => 'Принять нормативы',
            'add_new_item' => 'Приём нормативов',
            'edit_item' => 'Ведомость сдачи нормативов',
            'not_found' => 'Ведомостей пока нет',
        ),
        'public' => true,
        'exclude_from_search' => true,
        'show_in_nav_menus' => false,
        'has_archive' => 'normatives',
        'rewrite' => array('slug' => 'normatives', 'with_front' => false),
        'show_in_menu' => 'edit.php?post_type=ag_norm_set',
        'supports' => array('title'),
        'capability_type' => array('ag_item', 'ag_items'),
        'map_meta_cap' => true,
    ));
}
add_action('init', 'ag_register_normatives');

/** Пункт «Принять нормативы» в меню: без него WordPress не пускает не-администраторов на создание ведомости. */
function ag_norm_menu()
{
    add_submenu_page('edit.php?post_type=ag_norm_set', 'Принять нормативы', 'Принять нормативы', 'edit_ag_items', 'post-new.php?post_type=ag_norm_test');
}
add_action('admin_menu', 'ag_norm_menu');

/** Ведомости и наборы правятся обычными полями, без блочного редактора. */
function ag_normatives_no_blocks($use, $post_type)
{
    return in_array($post_type, array('ag_norm_set', 'ag_norm_test'), true) ? false : $use;
}
add_filter('use_block_editor_for_post_type', 'ag_normatives_no_blocks', 10, 2);

/* ------------------------------------------------------------------ */
/* Данные и расчёт                                                      */
/* ------------------------------------------------------------------ */

/** Упражнения набора: [['name', 'unit', 'better' => 'more'|'less', 'pass' => число], …]. */
function ag_norm_items($set_id)
{
    $items = json_decode((string) get_post_meta($set_id, '_ag_items', true), true);
    return is_array($items) ? $items : array();
}

/** Сколько упражнений нужно выполнить для зачёта: по умолчанию все. */
function ag_norm_need($set_id)
{
    $need = (int) get_post_meta($set_id, '_ag_need', true);
    $count = count(ag_norm_items($set_id));
    return $need > 0 && $need <= $count ? $need : $count;
}

/** «8,5» → 8.5; «1:05,3» (мин:сек) → 65.3; пусто или не число — null. */
function ag_norm_number($s)
{
    $s = trim(str_replace(array(',', ' '), array('.', ''), (string) $s));
    if ($s === '') {
        return null;
    }
    if (preg_match('/^(\d+):(\d+(?:\.\d+)?)$/', $s, $m)) {
        return (float) $m[1] * 60 + (float) $m[2];
    }
    return is_numeric($s) ? (float) $s : null;
}

/** Выполнено ли упражнение: true, false или null (результата нет). */
function ag_norm_passed($item, $value)
{
    $v = ag_norm_number($value);
    $norm = ag_norm_number($item['pass'] ?? '');
    if ($v === null || $norm === null) {
        return null;
    }
    return ($item['better'] ?? 'more') === 'less' ? $v <= $norm + 1e-9 : $v >= $norm - 1e-9;
}

/**
 * Итог спортсмена: ['done' => выполнено упражнений, 'total' => упражнений, 'passed' => true|false|null].
 * null — не все результаты внесены и зачёт ещё не ясен.
 */
function ag_norm_row_result($items, $values, $need)
{
    $done = 0;
    $missing = 0;
    foreach ($items as $i => $item) {
        $p = ag_norm_passed($item, $values[$i] ?? '');
        if ($p === null) {
            $missing++;
        } elseif ($p) {
            $done++;
        }
    }
    $passed = $done >= $need ? true : ($done + $missing < $need ? false : null);
    if ($missing === count($items)) {
        $passed = null;
    }
    return array('done' => $done, 'total' => count($items), 'passed' => $passed);
}

/**
 * Нормативы для группы: сначала свои нормативы именно этой группы (для девочек или мальчиков),
 * иначе общие нормативы федерации для этапа и пола. Берётся самый свежий подходящий набор.
 */
function ag_norm_set_for($level, $gender, $group = 0)
{
    $base = array(
        'post_type' => 'ag_norm_set',
        'post_status' => 'publish',
        'posts_per_page' => 1,
        'fields' => 'ids',
        'orderby' => 'modified',
    );
    if ($group) {
        $found = get_posts($base + array('meta_query' => array(
            array('key' => '_ag_group', 'value' => (string) $group),
            array('key' => '_ag_gender', 'value' => (string) $gender),
        )));
        if ($found) {
            return (int) $found[0];
        }
    }
    $found = get_posts($base + array('meta_query' => array(
        array('key' => '_ag_level', 'value' => (string) $level),
        array('key' => '_ag_gender', 'value' => (string) $gender),
        array('key' => '_ag_group', 'compare' => 'NOT EXISTS'),
    )));
    return $found ? (int) $found[0] : 0;
}

/** Ведомость: данные сдачи. */
function ag_norm_test($post_id)
{
    $rows = json_decode((string) get_post_meta($post_id, '_ag_rows', true), true);
    $set = (int) get_post_meta($post_id, '_ag_set', true);
    return array(
        'id' => $post_id,
        'group' => (int) get_post_meta($post_id, '_ag_group', true),
        'club' => (int) get_post_meta($post_id, '_ag_club', true),
        'date' => (string) get_post_meta($post_id, '_ag_date', true),
        'gender' => (string) get_post_meta($post_id, '_ag_gender', true),
        'set' => $set,
        'public' => get_post_meta($post_id, '_ag_public', true) === '1',
        'rows' => is_array($rows) ? $rows : array(),
        'items' => $set ? ag_norm_items($set) : array(),
        'need' => $set ? ag_norm_need($set) : 0,
    );
}

/** Сводка ведомости: [сдали, не сдали, не ясно, всего]. */
function ag_norm_summary($t)
{
    $out = array(0, 0, 0, 0);
    foreach ($t['rows'] as $row) {
        $r = ag_norm_row_result($t['items'], $row['values'] ?? array(), $t['need']);
        $out[$r['passed'] === true ? 0 : ($r['passed'] === false ? 1 : 2)]++;
        $out[3]++;
    }
    return $out;
}

function ag_gender_short($g)
{
    return $g === 'boys' ? 'мальчики' : ($g === 'girls' ? 'девочки' : '');
}

/* ------------------------------------------------------------------ */
/* Набор нормативов: поля                                               */
/* ------------------------------------------------------------------ */

function ag_norm_boxes()
{
    add_meta_box('ag_norm_set_main', 'Для кого и какие упражнения', 'ag_norm_set_box', 'ag_norm_set', 'normal', 'high');
    add_meta_box('ag_norm_test_main', 'Группа и дата', 'ag_norm_test_box', 'ag_norm_test', 'normal', 'high');
    add_meta_box('ag_norm_test_sheet', 'Ведомость', 'ag_norm_sheet_box', 'ag_norm_test', 'normal', 'default');
}
add_action('add_meta_boxes', 'ag_norm_boxes');

function ag_norm_item_row($item = null)
{
    $better = $item['better'] ?? 'more';
    return '<tr>'
        . '<td><input type="text" name="ag_norm[name][]" value="' . esc_attr($item['name'] ?? '') . '" placeholder="Подтягивание в висе"></td>'
        . '<td><input type="text" name="ag_norm[unit][]" value="' . esc_attr($item['unit'] ?? '') . '" placeholder="раз" style="width:80px"></td>'
        . '<td><select name="ag_norm[better][]"><option value="more"' . selected($better, 'more', false) . '>больше — лучше</option><option value="less"' . selected($better, 'less', false) . '>меньше — лучше (время)</option></select></td>'
        . '<td><input type="text" name="ag_norm[pass][]" value="' . esc_attr($item['pass'] ?? '') . '" placeholder="5" style="width:90px"></td>'
        . '<td><button type="button" class="button-link ag-rows__remove">убрать</button></td>'
        . '</tr>';
}

function ag_norm_set_box($post)
{
    wp_nonce_field('ag_norms', 'ag_norms_nonce');
    $level = (string) get_post_meta($post->ID, '_ag_level', true);
    $gender = (string) get_post_meta($post->ID, '_ag_gender', true);
    echo '<div class="ag-grid">';
    $opts = '';
    foreach (AG_GROUP_LEVELS as $k => $label) {
        $opts .= '<option value="' . esc_attr($k) . '"' . selected($level, $k, false) . '>' . esc_html($label) . '</option>';
    }
    ag_field('Этап подготовки', '<select name="ag_norm_level">' . $opts . '</select>', 'Для своих нормативов группы этап берётся от группы.');
    $set_group = (int) get_post_meta($post->ID, '_ag_group', true);
    $gopts = ag_user_club() ? '' : '<option value="">все группы этого этапа (нормативы федерации)</option>';
    foreach (ag_groups_for_user() as $g) {
        $gclub = (int) get_post_meta($g->ID, '_ag_club', true);
        $gopts .= '<option value="' . (int) $g->ID . '"' . selected($set_group, $g->ID, false) . '>' . esc_html(get_the_title($g) . ($gclub && !ag_user_club() ? ' — ' . get_the_title($gclub) : '')) . '</option>';
    }
    ag_field('Для группы', '<select name="ag_norm_group">' . $gopts . '</select>', 'Свои нормативы группы важнее общих: при приёме сдачи у этой группы подставятся они.');
    ag_field('Пол', '<select name="ag_norm_gender"><option value="girls"' . selected($gender, 'girls', false) . '>Девочки</option><option value="boys"' . selected($gender, 'boys', false) . '>Мальчики</option></select>', 'Для девочек и мальчиков одного этапа заводятся отдельные нормативы.');
    ag_field('Для зачёта выполнить', '<input type="number" min="0" name="ag_norm_need" value="' . esc_attr((string) get_post_meta($post->ID, '_ag_need', true)) . '" placeholder="все" style="width:100px"> упражнений', 'Пусто — нужно выполнить все.');
    echo '</div>';
    echo '<table class="widefat striped ag-rows" data-ag-rows><thead><tr><th>Упражнение</th><th>Единицы</th><th>Как сравнивать</th><th>Норма</th><th></th></tr></thead><tbody>';
    foreach (ag_norm_items($post->ID) as $item) {
        echo ag_norm_item_row($item); // phpcs:ignore WordPress.Security.EscapeOutput
    }
    if (!ag_norm_items($post->ID)) {
        echo ag_norm_item_row(); // phpcs:ignore WordPress.Security.EscapeOutput
    }
    echo '</tbody></table><template data-ag-rows-template>' . ag_norm_item_row() . '</template>'; // phpcs:ignore WordPress.Security.EscapeOutput
    echo '<p><button type="button" class="button ag-rows__add">+ Добавить упражнение</button> <span class="description">Время можно писать в секундах (8,5) или «мин:сек» (1:05,3).</span></p>';
}

/* ------------------------------------------------------------------ */
/* Ведомость: поля                                                      */
/* ------------------------------------------------------------------ */

/** Группы, доступные пользователю: администратору клуба — только своего клуба. */
function ag_groups_for_user()
{
    $args = array('post_type' => 'ag_group', 'posts_per_page' => 300, 'orderby' => 'title', 'order' => 'ASC');
    $club = ag_user_club();
    if ($club) {
        $args['meta_query'] = array(array('key' => '_ag_club', 'value' => (string) $club));
    }
    return get_posts($args);
}

function ag_norm_test_box($post)
{
    wp_nonce_field('ag_norms', 'ag_norms_nonce');
    $t = ag_norm_test($post->ID);
    if (!$t['group'] && isset($_GET['group'])) {
        $t['group'] = absint($_GET['group']);
    }
    echo '<div class="ag-grid">';
    $opts = '<option value="">— выберите —</option>';
    foreach (ag_groups_for_user() as $g) {
        $club = (int) get_post_meta($g->ID, '_ag_club', true);
        $opts .= '<option value="' . (int) $g->ID . '"' . selected($t['group'], $g->ID, false) . '>' . esc_html(get_the_title($g) . ($club && !ag_user_club() ? ' — ' . get_the_title($club) : '')) . '</option>';
    }
    ag_field('Группа', '<select name="ag_test_group" required>' . $opts . '</select>');
    ag_field('Дата сдачи', '<input type="date" name="ag_test_date" value="' . esc_attr($t['date'] !== '' ? $t['date'] : wp_date('Y-m-d')) . '">');
    ag_field('Кто сдаёт', '<select name="ag_test_gender"><option value="">как в группе</option><option value="girls"' . selected($t['gender'], 'girls', false) . '>Девочки</option><option value="boys"' . selected($t['gender'], 'boys', false) . '>Мальчики</option></select>', 'В смешанной группе девочки и мальчики сдают разные нормативы: заведите две ведомости.');
    $sets = get_posts(array('post_type' => 'ag_norm_set', 'posts_per_page' => 100, 'orderby' => 'title', 'order' => 'ASC'));
    $opts = '<option value="">подобрать по этапу и полу</option>';
    foreach ($sets as $s) {
        $sclub = (int) get_post_meta($s->ID, '_ag_club', true);
        if ($sclub && ag_user_club() && $sclub !== ag_user_club()) {
            continue;
        }
        $opts .= '<option value="' . (int) $s->ID . '"' . selected($t['set'], $s->ID, false) . '>' . esc_html(get_the_title($s)) . '</option>';
    }
    ag_field('Нормативы', '<select name="ag_test_set">' . $opts . '</select>', 'Обычно не трогайте: берутся нормативы этапа группы для девочек или мальчиков.');
    $public = $post->post_status === 'auto-draft' ? true : $t['public'];
    ag_field('На сайте', '<label style="font-weight:400"><input type="checkbox" name="ag_test_public" value="1"' . checked($public, true, false) . '> Публиковать ведомость с фамилиями и результатами</label>', 'Без отметки на сайте видно только итог: «сдали 8 из 10».');
    echo '</div>';
    if ($post->post_status === 'publish') {
        echo '<p class="ag-norm-status"><b>Итоги опубликованы на сайте.</b> Они видны на странице группы, клуба и в разделе «Нормативы».</p>';
    } else {
        echo '<p class="ag-norm-status">Пока сдача идёт, сохраняйте ведомость как черновик — на сайте её не видно. Когда сдача закончена, нажмите <b>«Опубликовать»</b>: итоги и ведомость появятся на сайте.</p>';
    }
    if ($post->post_status !== 'auto-draft' && $t['rows']) {
        $url = wp_nonce_url(admin_url('admin-post.php?action=ag_norm_csv&post=' . $post->ID), 'ag_norm_csv_' . $post->ID);
        $print = $post->post_status === 'publish' ? get_permalink($post) : get_preview_post_link($post);
        echo '<p><a class="button" href="' . esc_url($print) . '" target="_blank">Ведомость для печати и PDF</a> <a class="button" href="' . esc_url($url) . '">Скачать для Excel</a></p>';
    }
}

function ag_norm_sheet_box($post)
{
    $t = ag_norm_test($post->ID);
    if (!$t['group']) {
        echo '<p>Выберите группу и нажмите «Сохранить»: появится ведомость со спортсменами из состава группы и упражнениями нормативов.</p>';
        return;
    }
    if (!$t['items']) {
        $g = ag_group($t['group']);
        echo '<p>Для этапа «' . esc_html(AG_GROUP_LEVELS[$g['level']] ?? 'не указан') . '» (' . esc_html(ag_gender_short($t['gender']) ?: 'пол не указан') . ') нормативов ещё нет. Их заводят в разделе <a href="' . esc_url(admin_url('edit.php?post_type=ag_norm_set')) . '">Нормативы</a>, или выберите нормативы выше вручную.</p>';
        return;
    }
    $rows = $t['rows'];
    if (!$rows) {
        foreach (ag_group($t['group'])['roster'] as $name) {
            $rows[] = array('name' => $name, 'values' => array());
        }
    }
    echo '<p class="description">Нормативы: <b>' . esc_html(get_the_title($t['set'])) . '</b>. Для зачёта выполнить ' . (int) $t['need'] . ' из ' . count($t['items']) . '. Время — в секундах (8,5) или «мин:сек». Зачёт считается сам после сохранения; зелёным отмечено выполненное.</p>';
    echo '<div class="ag-sheet-wrap"><table class="widefat ag-rows ag-sheet" data-ag-rows><thead><tr><th>Спортсмен</th>';
    foreach ($t['items'] as $item) {
        echo '<th>' . esc_html($item['name']) . '<small>' . esc_html(($item['better'] ?? 'more') === 'less' ? 'не больше ' : 'не меньше ') . esc_html($item['pass'] . ' ' . ($item['unit'] ?? '')) . '</small></th>';
    }
    echo '<th>Итог</th><th></th></tr></thead><tbody>';
    $row_html = function ($row) use ($t) {
        $values = $row['values'] ?? array();
        $html = '<tr><td><input type="text" name="ag_sheet[name][]" value="' . esc_attr($row['name'] ?? '') . '" placeholder="Фамилия Имя"></td>';
        foreach ($t['items'] as $i => $item) {
            $p = $row ? ag_norm_passed($item, $values[$i] ?? '') : null;
            $html .= '<td class="' . ($p === true ? 'is-pass' : ($p === false ? 'is-fail' : '')) . '"><input type="text" inputmode="decimal" name="ag_sheet[v' . (int) $i . '][]" value="' . esc_attr((string) ($values[$i] ?? '')) . '"></td>';
        }
        $r = ag_norm_row_result($t['items'], $values, $t['need']);
        $label = $r['passed'] === true ? '<b class="ag-pass">сдал</b>' : ($r['passed'] === false ? '<b class="ag-fail">не сдал</b>' : '—');
        $html .= '<td>' . ($row ? $label . ' <small>' . (int) $r['done'] . '/' . (int) $r['total'] . '</small>' : '') . '</td><td><button type="button" class="button-link ag-rows__remove">убрать</button></td></tr>';
        return $html;
    };
    foreach ($rows as $row) {
        echo $row_html($row); // phpcs:ignore WordPress.Security.EscapeOutput
    }
    if (!$rows) {
        echo $row_html(array()); // phpcs:ignore WordPress.Security.EscapeOutput
    }
    echo '</tbody></table></div><template data-ag-rows-template>' . $row_html(array()) . '</template>'; // phpcs:ignore WordPress.Security.EscapeOutput
    $sum = ag_norm_summary(array_merge($t, array('rows' => $rows)));
    echo '<p><button type="button" class="button ag-rows__add">+ Добавить спортсмена</button> <span class="description">Сдали: <b>' . (int) $sum[0] . '</b>, не сдали: <b>' . (int) $sum[1] . '</b>' . ($sum[2] ? ', результатов нет: ' . (int) $sum[2] : '') . '.</span></p>';
}

/** Сохранение набора нормативов и ведомости. */
function ag_norm_save($post_id, $post)
{
    if (!in_array($post->post_type, array('ag_norm_set', 'ag_norm_test'), true)) {
        return;
    }
    if (!isset($_POST['ag_norms_nonce']) || !wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['ag_norms_nonce'])), 'ag_norms')) {
        return;
    }
    if ((defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) || !current_user_can('edit_post', $post_id)) {
        return;
    }
    if ($post->post_type === 'ag_norm_set') {
        $level = sanitize_key(wp_unslash($_POST['ag_norm_level'] ?? ''));
        update_post_meta($post_id, '_ag_level', array_key_exists($level, AG_GROUP_LEVELS) ? $level : 'np');
        update_post_meta($post_id, '_ag_gender', ($_POST['ag_norm_gender'] ?? '') === 'boys' ? 'boys' : 'girls');
        $group = absint($_POST['ag_norm_group'] ?? 0);
        if ($group && !in_array($group, array_map('intval', wp_list_pluck(ag_groups_for_user(), 'ID')), true)) {
            $group = (int) get_post_meta($post_id, '_ag_group', true);
        }
        if ($group) {
            $g = ag_group($group);
            update_post_meta($post_id, '_ag_group', $group);
            update_post_meta($post_id, '_ag_club', (string) $g['club']);
            if (array_key_exists($g['level'], AG_GROUP_LEVELS)) {
                update_post_meta($post_id, '_ag_level', $g['level']);
            }
        } elseif (!ag_user_club()) {
            delete_post_meta($post_id, '_ag_group');
            delete_post_meta($post_id, '_ag_club');
        }
        $need = absint($_POST['ag_norm_need'] ?? 0);
        $need ? update_post_meta($post_id, '_ag_need', $need) : delete_post_meta($post_id, '_ag_need');
        $in = isset($_POST['ag_norm']) && is_array($_POST['ag_norm']) ? wp_unslash($_POST['ag_norm']) : array();
        $items = array();
        foreach ((array) ($in['name'] ?? array()) as $i => $name) {
            $name = sanitize_text_field((string) $name);
            $pass = sanitize_text_field((string) ($in['pass'][$i] ?? ''));
            if ($name === '' || ag_norm_number($pass) === null) {
                continue;
            }
            $items[] = array(
                'name' => $name,
                'unit' => sanitize_text_field((string) ($in['unit'][$i] ?? '')),
                'better' => ($in['better'][$i] ?? '') === 'less' ? 'less' : 'more',
                'pass' => $pass,
            );
        }
        update_post_meta($post_id, '_ag_items', wp_json_encode($items, JSON_UNESCAPED_UNICODE));
        return;
    }

    // Ведомость: группа только из доступных пользователю, клуб — от группы.
    $group = absint($_POST['ag_test_group'] ?? 0);
    $allowed = wp_list_pluck(ag_groups_for_user(), 'ID');
    if (!$group || !in_array($group, array_map('intval', $allowed), true)) {
        $group = (int) get_post_meta($post_id, '_ag_group', true);
    }
    if (!$group) {
        return;
    }
    $g = ag_group($group);
    update_post_meta($post_id, '_ag_group', $group);
    update_post_meta($post_id, '_ag_club', (string) $g['club']);
    $date = sanitize_text_field(wp_unslash($_POST['ag_test_date'] ?? ''));
    update_post_meta($post_id, '_ag_date', preg_match('/^\d{4}-\d{2}-\d{2}$/', $date) ? $date : wp_date('Y-m-d'));
    $gender = sanitize_key(wp_unslash($_POST['ag_test_gender'] ?? ''));
    if (!in_array($gender, array('girls', 'boys'), true)) {
        $gender = in_array($g['gender'], array('girls', 'boys'), true) ? $g['gender'] : 'girls';
    }
    update_post_meta($post_id, '_ag_gender', $gender);
    $set = absint($_POST['ag_test_set'] ?? 0);
    if (!$set || get_post_type($set) !== 'ag_norm_set') {
        $set = ag_norm_set_for($g['level'], $gender, $group);
    }
    $set ? update_post_meta($post_id, '_ag_set', $set) : delete_post_meta($post_id, '_ag_set');
    update_post_meta($post_id, '_ag_public', !empty($_POST['ag_test_public']) ? '1' : '');

    if (isset($_POST['ag_sheet']) && is_array($_POST['ag_sheet'])) {
        $in = wp_unslash($_POST['ag_sheet']);
        $count = $set ? count(ag_norm_items($set)) : 0;
        $rows = array();
        foreach ((array) ($in['name'] ?? array()) as $r => $name) {
            $name = sanitize_text_field((string) $name);
            if ($name === '') {
                continue;
            }
            $values = array();
            for ($i = 0; $i < $count; $i++) {
                $values[$i] = sanitize_text_field((string) ($in['v' . $i][$r] ?? ''));
            }
            $rows[] = array('name' => $name, 'values' => $values);
        }
        update_post_meta($post_id, '_ag_rows', wp_json_encode($rows, JSON_UNESCAPED_UNICODE));
    }

    // Заголовок в списке: «Начальная подготовка, 1-й год · девочки · 12 ноября 2026».
    $title = get_the_title($group) . ' · ' . ag_gender_short($gender) . ' · ' . ag_date_range(get_post_meta($post_id, '_ag_date', true), '', true);
    // Адрес ведомости латиницей: /normatives/2026-11-12-girls-80/.
    $slug = get_post_meta($post_id, '_ag_date', true) . '-' . $gender . '-' . $group;
    if ($post->post_title !== $title || ($post->post_name !== '' && strpos($post->post_name, $slug) !== 0)) {
        remove_action('save_post', 'ag_norm_save', 10);
        wp_update_post(array('ID' => $post_id, 'post_title' => $title, 'post_name' => in_array($post->post_status, array('draft', 'auto-draft', 'pending'), true) ? '' : $slug));
        add_action('save_post', 'ag_norm_save', 10, 2);
    }
}
add_action('save_post', 'ag_norm_save', 10, 2);

/** Ведомость в CSV для Excel (точка с запятой, UTF-8 с BOM). */
function ag_norm_csv_action()
{
    $post_id = isset($_GET['post']) ? absint($_GET['post']) : 0;
    check_admin_referer('ag_norm_csv_' . $post_id);
    if (get_post_type($post_id) !== 'ag_norm_test' || !current_user_can('edit_post', $post_id)) {
        wp_die('Недостаточно прав');
    }
    $t = ag_norm_test($post_id);
    nocache_headers();
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="normativy-' . $post_id . '.csv"');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF");
    fputcsv($out, array(get_the_title($post_id)), ';');
    $head = array('№', 'Спортсмен');
    foreach ($t['items'] as $item) {
        $head[] = $item['name'] . ' (' . (($item['better'] ?? 'more') === 'less' ? '≤ ' : '≥ ') . $item['pass'] . ' ' . ($item['unit'] ?? '') . ')';
    }
    $head[] = 'Выполнено';
    $head[] = 'Итог';
    fputcsv($out, $head, ';');
    foreach ($t['rows'] as $n => $row) {
        $r = ag_norm_row_result($t['items'], $row['values'] ?? array(), $t['need']);
        $line = array($n + 1, $row['name']);
        foreach ($t['items'] as $i => $item) {
            $line[] = $row['values'][$i] ?? '';
        }
        $line[] = $r['done'] . ' из ' . $r['total'];
        $line[] = $r['passed'] === true ? 'сдал' : ($r['passed'] === false ? 'не сдал' : '');
        fputcsv($out, $line, ';');
    }
    fclose($out);
    exit;
}
add_action('admin_post_ag_norm_csv', 'ag_norm_csv_action');

/* Колонки списков */

function ag_norm_set_columns($cols)
{
    return array('cb' => $cols['cb'], 'title' => 'Нормативы', 'ag_level' => 'Этап', 'ag_gender' => 'Пол', 'ag_group' => 'Для кого', 'ag_items' => 'Упражнений', 'date' => $cols['date']);
}
add_filter('manage_ag_norm_set_posts_columns', 'ag_norm_set_columns');

function ag_norm_set_column($col, $post_id)
{
    if ($col === 'ag_level') {
        echo esc_html(AG_GROUP_LEVELS[get_post_meta($post_id, '_ag_level', true)] ?? '—');
    } elseif ($col === 'ag_gender') {
        echo esc_html(ag_gender_short(get_post_meta($post_id, '_ag_gender', true)));
    } elseif ($col === 'ag_group') {
        $g = (int) get_post_meta($post_id, '_ag_group', true);
        echo $g ? esc_html(get_the_title($g)) : 'все группы этапа';
    } elseif ($col === 'ag_items') {
        echo (int) count(ag_norm_items($post_id));
    }
}
add_action('manage_ag_norm_set_posts_custom_column', 'ag_norm_set_column', 10, 2);

function ag_norm_test_columns($cols)
{
    return array('cb' => $cols['cb'], 'title' => 'Группа и дата', 'ag_club' => 'Клуб', 'ag_result' => 'Сдали', 'date' => $cols['date']);
}
add_filter('manage_ag_norm_test_posts_columns', 'ag_norm_test_columns');

function ag_norm_test_column($col, $post_id)
{
    $t = ag_norm_test($post_id);
    if ($col === 'ag_club') {
        echo $t['club'] ? esc_html(get_the_title($t['club'])) : '—';
    } elseif ($col === 'ag_result') {
        $s = ag_norm_summary($t);
        echo $s[3] ? (int) $s[0] . ' из ' . (int) $s[3] : '—';
    }
}
add_action('manage_ag_norm_test_posts_custom_column', 'ag_norm_test_column', 10, 2);

/** Кнопка «Принять нормативы» в строке группы. */
function ag_group_row_actions($actions, $post)
{
    if ($post->post_type === 'ag_group' && current_user_can('edit_ag_items')) {
        $actions['ag_norms'] = '<a href="' . esc_url(admin_url('post-new.php?post_type=ag_norm_test&group=' . $post->ID)) . '">Принять нормативы</a>';
    }
    return $actions;
}
add_filter('post_row_actions', 'ag_group_row_actions', 10, 2);

/* ------------------------------------------------------------------ */
/* На сайте: блок «Нормативы» на странице группы                        */
/* ------------------------------------------------------------------ */

/** Опубликованные ведомости: группы, клуба или все; новые сверху. */
function ag_norm_tests($args = array())
{
    $meta = array();
    if (!empty($args['group'])) {
        $meta[] = array('key' => '_ag_group', 'value' => (string) $args['group']);
    }
    if (!empty($args['club'])) {
        $meta[] = array('key' => '_ag_club', 'value' => (string) $args['club']);
    }
    $posts = get_posts(array(
        'post_type' => 'ag_norm_test',
        'post_status' => 'publish',
        'posts_per_page' => $args['limit'] ?? 6,
        'meta_key' => '_ag_date',
        'orderby' => 'meta_value',
        'order' => 'DESC',
        'meta_query' => $meta,
    ));
    $out = array();
    foreach ($posts as $p) {
        $t = ag_norm_test($p->ID);
        if ($t['items'] && $t['rows']) {
            $out[] = $t;
        }
    }
    return $out;
}

/** Строка списка: дата, группа, пол, итог и ссылка на ведомость. */
function ag_norm_test_line($t, $with_group = true)
{
    $s = ag_norm_summary($t);
    $parts = array(ag_gender_short($t['gender']));
    if ($with_group && $t['club']) {
        $parts[] = get_the_title($t['club']);
    }
    echo '<a class="norm-line" href="' . esc_url(get_permalink($t['id'])) . '">'
        . '<span class="norm-line__date">' . esc_html(ag_date_range($t['date'], '', true)) . '</span>'
        . '<span class="norm-line__main"><b>' . esc_html($with_group ? get_the_title($t['group']) : get_the_title($t['set'])) . '</b><small>' . esc_html(implode(' · ', array_filter($parts))) . '</small></span>'
        . '<span class="chip chip--done">сдали ' . (int) $s[0] . ' из ' . (int) $s[3] . '</span>'
        . '<span class="norm-line__more">Ведомость →</span></a>';
}

/** Таблица ведомости: спортсмены × упражнения, выполненное выделено. */
function ag_norm_table($t)
{
    echo '<div class="table-wrap"><table class="rtable norm-table"><thead><tr><th class="num">№</th><th>Спортсмен</th>';
    foreach ($t['items'] as $item) {
        echo '<th class="num">' . esc_html($item['name']) . '<small>' . (($item['better'] ?? 'more') === 'less' ? 'не больше ' : 'не меньше ') . esc_html($item['pass'] . ' ' . ($item['unit'] ?? '')) . '</small></th>';
    }
    echo '<th class="num">Выполнено</th><th>Итог</th></tr></thead><tbody>';
    foreach ($t['rows'] as $n => $row) {
        $r = ag_norm_row_result($t['items'], $row['values'] ?? array(), $t['need']);
        echo '<tr><td class="num muted">' . (int) ($n + 1) . '</td><td>' . esc_html($row['name']) . '</td>';
        foreach ($t['items'] as $i => $item) {
            $p = ag_norm_passed($item, $row['values'][$i] ?? '');
            echo '<td class="num' . ($p === true ? ' is-pass' : ($p === false ? ' is-fail' : '')) . '">' . esc_html((string) ($row['values'][$i] ?? '')) . '</td>';
        }
        echo '<td class="num">' . (int) $r['done'] . ' из ' . (int) $r['total'] . '</td>';
        echo '<td>' . ($r['passed'] === true ? '<b class="norm-pass">сдал</b>' : ($r['passed'] === false ? '<span class="norm-fail">не сдал</span>' : '—')) . '</td></tr>';
    }
    echo '</tbody></table></div>';
}

/** Блок «Сдача нормативов» на странице группы или клуба. */
function ag_group_normatives_section($group_id, $club_id = 0)
{
    $tests = $club_id ? ag_norm_tests(array('club' => $club_id, 'limit' => 8)) : ag_norm_tests(array('group' => $group_id));
    if (!$tests) {
        return;
    }
    echo '<div class="card"><h2 class="card__title">Сдача нормативов</h2><div class="norm-lines">';
    foreach ($tests as $t) {
        ag_norm_test_line($t, (bool) $club_id);
    }
    echo '</div><p class="norm-lines__all"><a href="' . esc_url(add_query_arg($club_id ? array('club' => $club_id) : array(), get_post_type_archive_link('ag_norm_test'))) . '">Все результаты сдачи нормативов</a></p></div>';
}
