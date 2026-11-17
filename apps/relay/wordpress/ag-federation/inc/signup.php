<?php
/**
 * Онлайн-запись в учебную группу. Родитель заполняет форму на странице группы с отметкой «Идёт набор»:
 * заявка сохраняется в админке («Группы и расписание → Записи в группы») и приходит письмом
 * на почту клуба, а если её нет — на почту федерации.
 */

if (!defined('ABSPATH')) {
    exit;
}

function ag_register_signups()
{
    register_post_type('ag_signup', array(
        'labels' => array(
            'name' => 'Записи в группы',
            'singular_name' => 'Запись в группу',
            'menu_name' => 'Записи в группы',
            'all_items' => 'Записи в группы',
            'edit_item' => 'Запись в группу',
            'not_found' => 'Записей пока нет',
            'search_items' => 'Найти запись',
        ),
        'public' => false,
        'show_ui' => true,
        'show_in_menu' => 'edit.php?post_type=ag_group',
        'supports' => array('title'),
        'capability_type' => 'post',
        'capabilities' => array('create_posts' => 'do_not_allow'),
        'map_meta_cap' => true,
    ));
}
add_action('init', 'ag_register_signups');

const AG_SIGNUP_FIELDS = array(
    'child' => 'Фамилия и имя ребёнка',
    'year' => 'Год рождения',
    'parent' => 'Имя родителя',
    'phone' => 'Телефон',
    'comment' => 'Комментарий',
);

/** Куда писать о новой записи: почта клуба, иначе почта федерации из настроек, иначе администратора. */
function ag_signup_email($club)
{
    $mail = $club ? sanitize_email((string) get_post_meta($club, '_ag_email', true)) : '';
    if ($mail === '') {
        $mail = sanitize_email(ag_mod('ag_email'));
    }
    return $mail !== '' ? $mail : get_option('admin_email');
}

/** Форма на странице группы. */
function ag_signup_form($g)
{
    $state = isset($_GET['signup']) ? sanitize_key(wp_unslash($_GET['signup'])) : '';
    ?>
    <div class="card signup" id="signup">
        <h2 class="card__title card__title--small">Записаться в группу</h2>
        <?php if ($state === 'ok') : ?>
            <p class="signup__done">Заявка отправлена. Тренер или администратор клуба перезвонит вам, чтобы договориться о первом занятии.</p>
        <?php else : ?>
            <?php if ($state === 'error') : ?><p class="signup__error">Не получилось отправить заявку: заполните имя ребёнка и телефон и отметьте согласие. Если ошибка повторяется, позвоните в клуб.</p><?php endif; ?>
            <?php if ($state === 'wait') : ?><p class="signup__error">С этого устройства уже отправлено несколько заявок. Попробуйте через час или позвоните в клуб.</p><?php endif; ?>
            <form class="signup__form" method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                <input type="hidden" name="action" value="ag_signup">
                <input type="hidden" name="group" value="<?php echo (int) $g['post']->ID; ?>">
                <input type="hidden" name="t" value="<?php echo (int) time(); ?>">
                <p class="signup__trap" aria-hidden="true"><label>Сайт <input type="text" name="website" tabindex="-1" autocomplete="off"></label></p>
                <label>Фамилия и имя ребёнка<input type="text" name="child" required maxlength="120" autocomplete="off"></label>
                <label>Год рождения<input type="number" name="year" min="2000" max="<?php echo (int) wp_date('Y'); ?>" inputmode="numeric"></label>
                <label>Ваше имя<input type="text" name="parent" maxlength="120" autocomplete="name"></label>
                <label>Телефон<input type="tel" name="phone" required maxlength="40" autocomplete="tel" placeholder="+7"></label>
                <label>Комментарий<textarea name="comment" rows="2" maxlength="1000" placeholder="Удобное время для звонка, опыт занятий"></textarea></label>
                <label class="signup__consent"><input type="checkbox" name="consent" value="1" required> Согласен на обработку персональных данных для записи в группу</label>
                <button class="btn btn--accent btn--block" type="submit">Отправить заявку</button>
            </form>
        <?php endif; ?>
    </div>
    <?php
}

/** Приём формы. Без входа на сайт: защита — скрытое поле, время заполнения и не больше 5 заявок в час с адреса. */
function ag_signup_submit()
{
    $group = isset($_POST['group']) ? absint($_POST['group']) : 0;
    if (!$group || get_post_type($group) !== 'ag_group' || get_post_status($group) !== 'publish') {
        wp_safe_redirect(home_url('/'));
        exit;
    }
    $back = function ($state) use ($group) {
        wp_safe_redirect(add_query_arg('signup', $state, get_permalink($group)) . '#signup');
        exit;
    };
    $in = array();
    foreach (array_keys(AG_SIGNUP_FIELDS) as $k) {
        $raw = isset($_POST[$k]) ? wp_unslash((string) $_POST[$k]) : '';
        $in[$k] = $k === 'comment' ? sanitize_textarea_field($raw) : sanitize_text_field($raw);
    }
    $in['year'] = preg_match('/^(19|20)\d\d$/', $in['year']) ? $in['year'] : '';
    // Робот заполняет скрытое поле или отправляет форму быстрее, чем за 3 секунды: делаем вид, что всё хорошо.
    $t = isset($_POST['t']) ? (int) $_POST['t'] : 0;
    if (!empty($_POST['website']) || ($t && time() - $t < 3)) {
        $back('ok');
    }
    if ($in['child'] === '' || strlen(preg_replace('/\D/', '', $in['phone'])) < 6 || empty($_POST['consent'])) {
        $back('error');
    }
    $ip = isset($_SERVER['REMOTE_ADDR']) ? sanitize_text_field(wp_unslash($_SERVER['REMOTE_ADDR'])) : '';
    $key = 'ag_signup_' . md5($ip);
    $count = (int) get_transient($key);
    if ($count >= 5) {
        $back('wait');
    }
    set_transient($key, $count + 1, HOUR_IN_SECONDS);

    $g = ag_group($group);
    $id = wp_insert_post(array(
        'post_type' => 'ag_signup',
        'post_status' => 'publish',
        'post_title' => $in['child'] . ' — ' . get_the_title($group),
    ));
    if (!$id || is_wp_error($id)) {
        $back('error');
    }
    foreach ($in as $k => $v) {
        if ($v !== '') {
            update_post_meta($id, '_ag_' . $k, $v);
        }
    }
    update_post_meta($id, '_ag_group', $group);
    if ($g['club']) {
        update_post_meta($id, '_ag_club', $g['club']);
    }

    $lines = array('Новая запись в группу «' . get_the_title($group) . '»' . ($g['club'] ? ' (' . get_the_title($g['club']) . ')' : '') . '.', '');
    foreach (AG_SIGNUP_FIELDS as $k => $label) {
        if ($in[$k] !== '') {
            $lines[] = $label . ': ' . $in[$k];
        }
    }
    $lines[] = '';
    $lines[] = 'Все записи: ' . admin_url('edit.php?post_type=ag_signup');
    wp_mail(ag_signup_email($g['club']), 'Запись в группу: ' . $in['child'], implode("\n", $lines));
    $back('ok');
}
add_action('admin_post_nopriv_ag_signup', 'ag_signup_submit');
add_action('admin_post_ag_signup', 'ag_signup_submit');

/* Админка: список записей, отметка «Обработана», счётчик новых в меню. */

function ag_signup_columns($cols)
{
    return array(
        'cb' => $cols['cb'],
        'title' => 'Ребёнок и группа',
        'ag_phone' => 'Телефон',
        'ag_parent' => 'Родитель',
        'ag_year' => 'Год рождения',
        'ag_done' => 'Статус',
        'date' => 'Получена',
    );
}
add_filter('manage_ag_signup_posts_columns', 'ag_signup_columns');

function ag_signup_column($col, $post_id)
{
    if ($col === 'ag_done') {
        echo get_post_meta($post_id, '_ag_done', true) ? 'обработана' : '<b>новая</b>';
        return;
    }
    $value = (string) get_post_meta($post_id, '_' . $col, true);
    if ($col === 'ag_phone' && $value !== '') {
        echo '<a href="tel:' . esc_attr(preg_replace('/[^0-9+]/', '', $value)) . '">' . esc_html($value) . '</a>';
        return;
    }
    echo esc_html($value !== '' ? $value : '—');
}
add_action('manage_ag_signup_posts_custom_column', 'ag_signup_column', 10, 2);

function ag_signup_row_actions($actions, $post)
{
    if ($post->post_type !== 'ag_signup') {
        return $actions;
    }
    unset($actions['inline hide-if-no-js']);
    if (!get_post_meta($post->ID, '_ag_done', true) && current_user_can('edit_post', $post->ID)) {
        $url = wp_nonce_url(admin_url('admin-post.php?action=ag_signup_done&post=' . $post->ID), 'ag_signup_done_' . $post->ID);
        $actions = array('ag_done' => '<a href="' . esc_url($url) . '">Обработана</a>') + $actions;
    }
    return $actions;
}
add_filter('post_row_actions', 'ag_signup_row_actions', 10, 2);

function ag_signup_done_action()
{
    $post_id = isset($_GET['post']) ? absint($_GET['post']) : 0;
    check_admin_referer('ag_signup_done_' . $post_id);
    if (get_post_type($post_id) !== 'ag_signup' || !current_user_can('edit_post', $post_id)) {
        wp_die('Недостаточно прав');
    }
    update_post_meta($post_id, '_ag_done', current_time('mysql'));
    wp_safe_redirect(admin_url('edit.php?post_type=ag_signup'));
    exit;
}
add_action('admin_post_ag_signup_done', 'ag_signup_done_action');

function ag_signup_box($post)
{
    wp_nonce_field('ag_signup_box', 'ag_signup_nonce');
    echo '<table class="form-table"><tbody>';
    $group = (int) get_post_meta($post->ID, '_ag_group', true);
    echo '<tr><th>Группа</th><td>' . ($group ? '<a href="' . esc_url(get_edit_post_link($group)) . '">' . esc_html(get_the_title($group)) . '</a>' : '—') . '</td></tr>';
    foreach (AG_SIGNUP_FIELDS as $k => $label) {
        echo '<tr><th>' . esc_html($label) . '</th><td>' . nl2br(esc_html((string) get_post_meta($post->ID, '_ag_' . $k, true))) . '</td></tr>';
    }
    echo '<tr><th>Статус</th><td><label><input type="checkbox" name="ag_done" value="1"' . checked((bool) get_post_meta($post->ID, '_ag_done', true), true, false) . '> Обработана (родителю перезвонили)</label></td></tr>';
    echo '</tbody></table>';
}

function ag_signup_boxes()
{
    add_meta_box('ag_signup_main', 'Заявка', 'ag_signup_box', 'ag_signup', 'normal', 'high');
}
add_action('add_meta_boxes', 'ag_signup_boxes');

function ag_signup_save($post_id, $post)
{
    if ($post->post_type !== 'ag_signup' || !isset($_POST['ag_signup_nonce']) || !wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['ag_signup_nonce'])), 'ag_signup_box') || !current_user_can('edit_post', $post_id)) {
        return;
    }
    if (!empty($_POST['ag_done'])) {
        if (!get_post_meta($post_id, '_ag_done', true)) {
            update_post_meta($post_id, '_ag_done', current_time('mysql'));
        }
    } else {
        delete_post_meta($post_id, '_ag_done');
    }
}
add_action('save_post', 'ag_signup_save', 10, 2);

/** Заявки не редактируют в блочном редакторе: это просто карточка. */
function ag_signup_no_blocks($use, $post_type)
{
    return $post_type === 'ag_signup' ? false : $use;
}
add_filter('use_block_editor_for_post_type', 'ag_signup_no_blocks', 10, 2);

/** Число новых записей рядом с пунктом меню. */
function ag_signup_menu_count()
{
    global $submenu;
    $parent = 'edit.php?post_type=ag_group';
    if (empty($submenu[$parent])) {
        return;
    }
    $meta = array(array('key' => '_ag_done', 'compare' => 'NOT EXISTS'));
    if (function_exists('ag_user_club') && ag_user_club()) {
        $meta[] = array('key' => '_ag_club', 'value' => (string) ag_user_club());
    }
    $new = get_posts(array('post_type' => 'ag_signup', 'posts_per_page' => 100, 'fields' => 'ids', 'meta_query' => $meta));
    if (!$new) {
        return;
    }
    foreach ($submenu[$parent] as &$item) {
        if ($item[2] === 'edit.php?post_type=ag_signup') {
            $item[0] .= ' <span class="awaiting-mod">' . count($new) . '</span>';
        }
    }
}
add_action('admin_menu', 'ag_signup_menu_count', 99);
