<?php
/**
 * Роли по клубам: у каждого клуба свой администратор.
 *
 * Роль «Администратор клуба» видит в админке только свой клуб: страницу клуба, его группы и расписание,
 * объявления клуба, записи в группы клуба и ведомости сдачи нормативов. Чужие клубы, соревнования,
 * новости и настройки сайта ему недоступны. Клуб назначает администратор сайта в профиле пользователя
 * («Пользователи → изменить → Клуб»).
 *
 * Как устроено: группы, объявления, записи и ведомости используют общие права *_ag_items, клубы — *_ag_clubs.
 * Фильтр map_meta_cap запрещает администратору клуба трогать запись, у которой поле «Клуб» не его.
 */

if (!defined('ABSPATH')) {
    exit;
}

/** Типы записей, которые принадлежат клубу через поле _ag_club. */
const AG_CLUB_OWNED = array('ag_group', 'ag_notice', 'ag_signup', 'ag_norm_test', 'ag_norm_set');

function ag_item_caps()
{
    return array(
        'edit_ag_items', 'edit_others_ag_items', 'edit_published_ag_items', 'edit_private_ag_items',
        'publish_ag_items', 'read_private_ag_items',
        'delete_ag_items', 'delete_others_ag_items', 'delete_published_ag_items', 'delete_private_ag_items',
    );
}

function ag_club_caps()
{
    return array(
        'edit_ag_clubs', 'edit_others_ag_clubs', 'edit_published_ag_clubs', 'edit_private_ag_clubs',
        'publish_ag_clubs', 'read_private_ag_clubs',
        'delete_ag_clubs', 'delete_others_ag_clubs', 'delete_published_ag_clubs', 'delete_private_ag_clubs',
        'create_ag_clubs',
    );
}

/** Роль и права создаются один раз после установки или обновления темы. */
function ag_setup_roles()
{
    if (get_option('ag_roles_version') === AG_THEME_VERSION) {
        return;
    }
    foreach (array('administrator', 'editor') as $name) {
        $role = get_role($name);
        if ($role) {
            foreach (array_merge(ag_item_caps(), ag_club_caps()) as $cap) {
                $role->add_cap($cap);
            }
        }
    }
    $caps = array('read' => true, 'upload_files' => true, 'edit_ag_clubs' => true, 'edit_published_ag_clubs' => true, 'edit_others_ag_clubs' => true);
    foreach (ag_item_caps() as $cap) {
        $caps[$cap] = true;
    }
    remove_role('ag_club_admin');
    add_role('ag_club_admin', 'Администратор клуба', $caps);
    update_option('ag_roles_version', AG_THEME_VERSION);
}
add_action('init', 'ag_setup_roles', 5);

/** Группы, объявления, записи и ведомости — на общих правах клуба; клубы — на своих. */
function ag_club_post_type_args($args, $post_type)
{
    if (in_array($post_type, AG_CLUB_OWNED, true)) {
        $args['capability_type'] = array('ag_item', 'ag_items');
        $args['map_meta_cap'] = true;
    } elseif ($post_type === 'ag_club') {
        $args['capability_type'] = array('ag_club', 'ag_clubs');
        $args['map_meta_cap'] = true;
        $args['capabilities'] = array('create_posts' => 'create_ag_clubs');
    }
    return $args;
}
add_filter('register_post_type_args', 'ag_club_post_type_args', 10, 2);

/**
 * Клуб пользователя: 0 — ограничений нет (администратор сайта, редактор),
 * ID клуба — администратор клуба, -1 — администратор клуба, которому ещё не назначили клуб (ничего не видит).
 */
function ag_user_club($user_id = 0)
{
    $user = $user_id ? get_userdata($user_id) : wp_get_current_user();
    if (!$user || !$user->exists() || !in_array('ag_club_admin', (array) $user->roles, true) || user_can($user, 'manage_options')) {
        return 0;
    }
    $club = (int) get_user_meta($user->ID, '_ag_user_club', true);
    return $club && get_post_type($club) === 'ag_club' ? $club : -1;
}

/** Администратор клуба правит только записи своего клуба и страницу своего клуба. */
function ag_club_map_meta_cap($caps, $cap, $user_id, $args)
{
    if (!in_array($cap, array('edit_post', 'delete_post', 'publish_post', 'read_post'), true) || empty($args[0])) {
        return $caps;
    }
    $post = get_post($args[0]);
    if (!$post) {
        return $caps;
    }
    $owned = in_array($post->post_type, AG_CLUB_OWNED, true);
    if (!$owned && $post->post_type !== 'ag_club') {
        return $caps;
    }
    $club = ag_user_club($user_id);
    if (!$club) {
        return $caps;
    }
    if ($post->post_type === 'ag_club') {
        $ok = (int) $post->ID === $club && $cap !== 'delete_post';
    } elseif ($post->post_status === 'auto-draft' || ((int) $post->post_author === (int) $user_id && !get_post_meta($post->ID, '_ag_club', true))) {
        // Только что созданная запись: клуб проставится при сохранении.
        $ok = true;
    } else {
        $ok = (int) get_post_meta($post->ID, '_ag_club', true) === $club;
    }
    return $ok ? $caps : array('do_not_allow');
}
add_filter('map_meta_cap', 'ag_club_map_meta_cap', 10, 4);

/** Списки в админке: администратор клуба видит только своё. */
function ag_club_admin_lists($q)
{
    if (!is_admin() || !$q->is_main_query()) {
        return;
    }
    $club = ag_user_club();
    if (!$club) {
        return;
    }
    $type = $q->get('post_type');
    if (in_array($type, AG_CLUB_OWNED, true)) {
        $meta = (array) $q->get('meta_query');
        $meta[] = array('key' => '_ag_club', 'value' => (string) $club);
        $q->set('meta_query', $meta);
    } elseif ($type === 'ag_club') {
        $q->set('post__in', array(max($club, 0) ?: -1));
    } elseif ($type === 'attachment') {
        $q->set('author', get_current_user_id());
    }
}
add_action('pre_get_posts', 'ag_club_admin_lists');

/** Счётчики «Все (12) | Опубликованные (10)» считают все клубы — администратору клуба их не показываем. */
function ag_club_admin_views($views)
{
    return ag_user_club() ? array() : $views;
}
foreach (array_merge(AG_CLUB_OWNED, array('ag_club')) as $ag_type) {
    add_filter('views_edit-' . $ag_type, 'ag_club_admin_views');
}
unset($ag_type);

/** Медиатека в окне выбора файлов: администратор клуба видит только свои загрузки. */
function ag_club_admin_media($query)
{
    if (ag_user_club()) {
        $query['author'] = get_current_user_id();
    }
    return $query;
}
add_filter('ajax_query_attachments_args', 'ag_club_admin_media');

/** Группа и объявление администратора клуба всегда принадлежат его клубу. */
function ag_club_force_owner($post_id, $post)
{
    if (!in_array($post->post_type, array('ag_group', 'ag_notice'), true) || wp_is_post_revision($post_id)) {
        return;
    }
    $club = ag_user_club();
    if ($club > 0) {
        update_post_meta($post_id, '_ag_club', (string) $club);
    }
}
add_action('save_post', 'ag_club_force_owner', 20, 2);

/** Меню администратора клуба: «Мой клуб» вместо списка всех клубов, без лишних пунктов. */
function ag_club_admin_menu()
{
    $club = ag_user_club();
    if (!$club) {
        return;
    }
    remove_menu_page('edit.php?post_type=ag_club');
    remove_menu_page('tools.php');
    if ($club > 0) {
        add_menu_page('Мой клуб', 'Мой клуб', 'read', 'post.php?post=' . $club . '&action=edit', '', 'dashicons-groups', 4);
    }
}
add_action('admin_menu', 'ag_club_admin_menu', 100);

/** После входа администратор клуба попадает на сводку своего клуба, а не в профиль. */
function ag_club_admin_login_redirect($to, $requested, $user)
{
    if ($user instanceof WP_User && ag_user_club($user->ID) && ($requested === '' || $requested === admin_url() || strpos($to, 'profile.php') !== false)) {
        // Именно index.php: на адрес «/wp-admin/» WordPress отправляет пользователей без права писать новости в профиль.
        return admin_url('index.php');
    }
    return $to;
}
add_filter('login_redirect', 'ag_club_admin_login_redirect', 10, 3);

/** Стартовая страница администратора клуба: короткая сводка и ссылки на разделы. */
function ag_club_admin_dashboard()
{
    $club = ag_user_club();
    if (!$club) {
        return;
    }
    remove_meta_box('dashboard_primary', 'dashboard', 'side');
    remove_meta_box('dashboard_quick_press', 'dashboard', 'side');
    remove_meta_box('dashboard_site_health', 'dashboard', 'normal');
    remove_meta_box('dashboard_activity', 'dashboard', 'normal');
    wp_add_dashboard_widget('ag_my_club', $club > 0 ? 'Мой клуб: ' . get_the_title($club) : 'Мой клуб', 'ag_club_admin_widget');
}
add_action('wp_dashboard_setup', 'ag_club_admin_dashboard');

function ag_club_admin_widget()
{
    $club = ag_user_club();
    if ($club < 0) {
        echo '<p>Вам ещё не назначили клуб. Попросите администратора сайта указать клуб в вашем профиле.</p>';
        return;
    }
    $count = function ($type, $extra = array()) use ($club) {
        $meta = array_merge(array(array('key' => '_ag_club', 'value' => (string) $club)), $extra);
        return count(get_posts(array('post_type' => $type, 'post_status' => 'any', 'posts_per_page' => 500, 'fields' => 'ids', 'meta_query' => $meta)));
    };
    $new = $count('ag_signup', array(array('key' => '_ag_done', 'compare' => 'NOT EXISTS')));
    $links = array(
        array(admin_url('post.php?post=' . $club . '&action=edit'), 'Страница клуба', 'контакты, тренеры, описание'),
        array(admin_url('edit.php?post_type=ag_group'), 'Группы и расписание', 'групп: ' . $count('ag_group')),
        array(admin_url('edit.php?post_type=ag_notice'), 'Объявления', 'объявлений: ' . $count('ag_notice')),
        array(admin_url('edit.php?post_type=ag_signup'), 'Записи в группы', $new ? 'новых: ' . $new : 'новых нет'),
        array(admin_url('edit.php?post_type=ag_norm_test'), 'Сдача нормативов', 'ведомостей: ' . $count('ag_norm_test')),
    );
    echo '<ul class="ag-club-links">';
    foreach ($links as $l) {
        echo '<li><a href="' . esc_url($l[0]) . '"><b>' . esc_html($l[1]) . '</b></a> <span class="description">— ' . esc_html($l[2]) . '</span></li>';
    }
    echo '</ul><p><a class="button" href="' . esc_url(get_permalink($club)) . '" target="_blank">Открыть клуб на сайте</a></p>';
}

/* ------------------------------------------------------------------ */
/* Назначение клуба пользователю                                        */
/* ------------------------------------------------------------------ */

function ag_user_club_field($user)
{
    if (!current_user_can('promote_users')) {
        return;
    }
    $current = is_object($user) ? (int) get_user_meta($user->ID, '_ag_user_club', true) : 0;
    $clubs = get_posts(array('post_type' => 'ag_club', 'posts_per_page' => 300, 'orderby' => 'title', 'order' => 'ASC', 'post_status' => array('publish', 'draft', 'private')));
    echo '<h2>Клуб</h2><table class="form-table" role="presentation"><tr><th><label for="ag_user_club">Администратор клуба</label></th><td>';
    echo '<select name="ag_user_club" id="ag_user_club"><option value="">— не назначен —</option>';
    foreach ($clubs as $c) {
        echo '<option value="' . (int) $c->ID . '"' . selected($current, $c->ID, false) . '>' . esc_html(get_the_title($c)) . '</option>';
    }
    echo '</select><p class="description">Работает вместе с ролью «Администратор клуба»: пользователь видит в админке только этот клуб — его группы, расписание, объявления, записи и нормативы.</p></td></tr></table>';
}
add_action('show_user_profile', 'ag_user_club_field');
add_action('edit_user_profile', 'ag_user_club_field');
add_action('user_new_form', 'ag_user_club_field');

function ag_user_club_save($user_id)
{
    if (!current_user_can('promote_users') || !isset($_POST['ag_user_club'])) {
        return;
    }
    $club = absint($_POST['ag_user_club']);
    if ($club && get_post_type($club) === 'ag_club') {
        update_user_meta($user_id, '_ag_user_club', $club);
    } else {
        delete_user_meta($user_id, '_ag_user_club');
    }
}
add_action('personal_options_update', 'ag_user_club_save');
add_action('edit_user_profile_update', 'ag_user_club_save');
add_action('user_register', 'ag_user_club_save');

function ag_users_club_column($cols)
{
    $cols['ag_club'] = 'Клуб';
    return $cols;
}
add_filter('manage_users_columns', 'ag_users_club_column');

function ag_users_club_cell($value, $col, $user_id)
{
    if ($col !== 'ag_club') {
        return $value;
    }
    $club = (int) get_user_meta($user_id, '_ag_user_club', true);
    return $club && get_post_type($club) === 'ag_club' ? esc_html(get_the_title($club)) : '—';
}
add_filter('manage_users_custom_column', 'ag_users_club_cell', 10, 3);

/** На странице клуба в админке — кто его администраторы. */
function ag_club_admins_box_register()
{
    if (current_user_can('promote_users')) {
        add_meta_box('ag_club_admins', 'Администраторы клуба', 'ag_club_admins_box', 'ag_club', 'side');
    }
}
add_action('add_meta_boxes', 'ag_club_admins_box_register');

function ag_club_admins_box($post)
{
    $users = get_users(array('meta_key' => '_ag_user_club', 'meta_value' => (string) $post->ID));
    if ($users) {
        echo '<ul>';
        foreach ($users as $u) {
            $role = in_array('ag_club_admin', (array) $u->roles, true) ? '' : ' <span class="description">(нет роли «Администратор клуба»)</span>';
            echo '<li><a href="' . esc_url(get_edit_user_link($u->ID)) . '">' . esc_html($u->display_name) . '</a>' . $role . '</li>'; // phpcs:ignore WordPress.Security.EscapeOutput
        }
        echo '</ul>';
    } else {
        echo '<p>Пока нет.</p>';
    }
    echo '<p><a class="button" href="' . esc_url(admin_url('user-new.php')) . '">Добавить администратора</a></p>';
    echo '<p class="description">Роль — «Администратор клуба», внизу формы выберите этот клуб.</p>';
}
