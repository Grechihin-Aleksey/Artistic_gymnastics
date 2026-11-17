<?php
/**
 * Тема «Спортивная гимнастика — федерация».
 *
 * Что где:
 *   inc/helpers.php     — даты по-русски, стадия соревнования, запросы к ретранслятору результатов;
 *   inc/post-types.php  — типы записей «Соревнования», «Клубы», «Документы» и их поля;
 *   inc/customizer.php  — настройки в «Внешний вид → Настроить»;
 *   inc/components.php  — повторяющиеся блоки страниц: строка календаря, призёры, протоколы, табло;
 *   inc/archive.php     — результаты турниров копятся на сайте, страницы спортсменов;
 *   inc/rest.php        — карточка соревнования от программы (кнопка «Подключить к сайту»);
 *   inc/sections.php    — учебные группы, расписание занятий и объявления;
 *   inc/summary.php     — черновик новости «Итоги» и анонсы в Telegram и ВКонтакте;
 *   inc/signup.php      — онлайн-запись в группу;
 *   inc/rating.php      — рейтинг сезона (/rating/);
 *   inc/ical.php        — подписка на календарь соревнований;
 *   inc/gallery.php     — фотографии турнира;
 *   inc/normatives.php  — нормативы и приём их сдачи по группам;
 *   inc/roles.php       — администраторы клубов.
 */

if (!defined('ABSPATH')) {
    exit;
}

define('AG_THEME_VERSION', '1.3.0');

require_once __DIR__ . '/inc/helpers.php';
require_once __DIR__ . '/inc/post-types.php';
require_once __DIR__ . '/inc/customizer.php';
require_once __DIR__ . '/inc/components.php';
require_once __DIR__ . '/inc/archive.php';
require_once __DIR__ . '/inc/rest.php';
require_once __DIR__ . '/inc/sections.php';
require_once __DIR__ . '/inc/summary.php';
require_once __DIR__ . '/inc/signup.php';
require_once __DIR__ . '/inc/rating.php';
require_once __DIR__ . '/inc/ical.php';
require_once __DIR__ . '/inc/gallery.php';
require_once __DIR__ . '/inc/normatives.php';
require_once __DIR__ . '/inc/roles.php';

function ag_theme_setup()
{
    add_theme_support('title-tag');
    add_theme_support('post-thumbnails');
    add_theme_support('custom-logo', array('height' => 92, 'width' => 92, 'flex-width' => true, 'flex-height' => true));
    add_theme_support('html5', array('search-form', 'gallery', 'caption', 'style', 'script', 'navigation-widgets'));
    add_theme_support('responsive-embeds');
    add_theme_support('align-wide');
    add_theme_support('wp-block-styles');
    add_theme_support('editor-styles');
    add_editor_style(array('assets/css/fonts.css', 'assets/css/editor.css'));
    add_image_size('ag-card', 720, 420, true);
    register_nav_menus(array(
        'primary' => 'Главное меню',
        'footer' => 'Меню в подвале',
    ));
}
add_action('after_setup_theme', 'ag_theme_setup');

function ag_theme_assets()
{
    $uri = get_template_directory_uri();
    wp_enqueue_style('ag-fonts', $uri . '/assets/css/fonts.css', array(), AG_THEME_VERSION);
    wp_enqueue_style('ag-theme', $uri . '/assets/css/theme.css', array('ag-fonts'), AG_THEME_VERSION);
    wp_add_inline_style('ag-theme', ag_color_css());
    wp_enqueue_script('ag-theme', $uri . '/assets/js/theme.js', array(), AG_THEME_VERSION, true);
    wp_localize_script('ag-theme', 'agTheme', array('relay' => ag_relay_base()));
}
add_action('wp_enqueue_scripts', 'ag_theme_assets');

/** Шрифт подключается со своего сайта, без Google Fonts: быстрее и без передачи данных посетителей третьим лицам. */
function ag_preload_font()
{
    echo '<link rel="preload" href="' . esc_url(get_template_directory_uri() . '/assets/fonts/golos-text-cyrillic-wght-normal.woff2') . '" as="font" type="font/woff2" crossorigin>' . "\n";
}
add_action('wp_head', 'ag_preload_font', 1);

function ag_admin_assets($hook)
{
    if (!in_array($hook, array('post.php', 'post-new.php'), true)) {
        return;
    }
    $screen = get_current_screen();
    if (!$screen || !in_array($screen->post_type, array('ag_competition', 'ag_document', 'ag_club', 'ag_group', 'ag_notice', 'ag_signup', 'ag_norm_set', 'ag_norm_test'), true)) {
        return;
    }
    wp_enqueue_media();
    wp_enqueue_style('ag-admin', get_template_directory_uri() . '/assets/css/admin.css', array(), AG_THEME_VERSION);
    wp_enqueue_script('ag-admin', get_template_directory_uri() . '/assets/js/admin.js', array('jquery', 'jquery-ui-sortable'), AG_THEME_VERSION, true);
}
add_action('admin_enqueue_scripts', 'ag_admin_assets');

function ag_widgets()
{
    register_sidebar(array(
        'name' => 'Боковая колонка новостей',
        'id' => 'news',
        'before_widget' => '<section class="widget %2$s">',
        'after_widget' => '</section>',
        'before_title' => '<h3 class="widget__title">',
        'after_title' => '</h3>',
    ));
}
add_action('widgets_init', 'ag_widgets');

/** Длина анонса в карточках новостей. */
function ag_excerpt_length()
{
    return 24;
}
add_filter('excerpt_length', 'ag_excerpt_length');

function ag_excerpt_more()
{
    return '…';
}
add_filter('excerpt_more', 'ag_excerpt_more');

/** Заголовки архивов без «Рубрика:» и «Архивы:». */
function ag_archive_title($title)
{
    if (is_category() || is_tag() || is_tax()) {
        return single_term_title('', false);
    }
    if (is_post_type_archive()) {
        return post_type_archive_title('', false);
    }
    return $title;
}
add_filter('get_the_archive_title', 'ag_archive_title');

/** Меню по умолчанию, пока администратор не собрал своё в «Внешний вид → Меню». */
function ag_default_menu()
{
    $items = array(
        array(get_post_type_archive_link('ag_competition'), 'Календарь'),
        array(ag_results_url(), 'Результаты'),
        array(get_post_type_archive_link('ag_athlete'), 'Спортсмены'),
        array(ag_news_url(), 'Новости'),
        array(get_post_type_archive_link('ag_club'), 'Клубы'),
    );
    if (ag_has_groups()) {
        $items[] = array(ag_groups_url(), 'Занятия');
    }
    $items[] = array(get_post_type_archive_link('ag_document'), 'Документы');
    $about = (int) get_theme_mod('ag_about_page', 0);
    if ($about) {
        $items[] = array(get_permalink($about), 'Федерация');
    }
    echo '<ul class="menu">';
    foreach ($items as $item) {
        echo '<li><a href="' . esc_url($item[0]) . '">' . esc_html($item[1]) . '</a></li>';
    }
    echo '</ul>';
}

/** Адрес ленты новостей: страница записей, если она задана, иначе главная лента. */
function ag_news_url()
{
    $page = (int) get_option('page_for_posts');
    return $page ? get_permalink($page) : home_url('/?post_type=post');
}

/** Архив результатов: прошедшие соревнования. */
function ag_results_url()
{
    return add_query_arg('period', 'past', get_post_type_archive_link('ag_competition'));
}

/** После смены темы обновляем адреса, чтобы /competitions/ и /clubs/ сразу открывались. */
function ag_flush_rewrites()
{
    ag_register_types();
    ag_register_athletes();
    ag_register_sections();
    ag_rating_rewrite();
    ag_ical_rewrite();
    flush_rewrite_rules();
    update_option('ag_rewrite_version', AG_THEME_VERSION);
}
add_action('after_switch_theme', 'ag_flush_rewrites');
