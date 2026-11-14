<?php
/**
 * Plugin Name: Табло результатов (спортивная гимнастика)
 * Description: Шорткод [ag_results id="…"] вставляет на страницу табло турнира с ретранслятора результатов. Работает и у редакторов без прав администратора: тег script на страницу вставлять не нужно.
 * Version: 1.0.0
 * Requires at least: 5.0
 * Requires PHP: 7.4
 * License: MIT
 * Text Domain: ag-results
 */

if (!defined('ABSPATH')) {
    exit;
}

const AG_RESULTS_OPTION = 'ag_results_base';

/**
 * Адрес ретранслятора без «/» в конце. Задаётся в «Настройки → Табло результатов»;
 * по умолчанию папка results в корне этого сайта (так ставится PHP-ретранслятор).
 */
function ag_results_base()
{
    $base = trim((string) get_option(AG_RESULTS_OPTION, ''));
    if ($base === '') {
        $base = home_url('/results/');
    }
    return rtrim($base, '/');
}

/**
 * Проверка и разбор атрибутов шорткода. Пропускается только то, что понимает табло:
 * ID соревнований (через запятую — части одного турнира), вид, тема и номер разряда.
 * Возвращает null, если ID не указан или записан с ошибкой.
 */
function ag_results_attributes($atts)
{
    $atts = shortcode_atts(
        array('id' => '', 'view' => 'auto', 'theme' => 'light', 'category' => ''),
        $atts,
        'ag_results'
    );
    $ids = array_values(array_filter(array_map('trim', explode(',', (string) $atts['id']))));
    if (count($ids) === 0 || count($ids) > 4) {
        return null;
    }
    foreach ($ids as $id) {
        if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $id)) {
            return null;
        }
    }
    $view = preg_match('/^[A-Za-z]{1,10}$/', (string) $atts['view']) ? (string) $atts['view'] : 'auto';
    $theme = $atts['theme'] === 'dark' ? 'dark' : 'light';
    $category = (int) $atts['category'];
    return array(
        'id' => implode(',', $ids),
        'view' => $view,
        'theme' => $theme,
        'category' => $category > 0 ? $category : null,
    );
}

/** [ag_results id="…" view="auto" theme="light" category="2"] */
function ag_results_shortcode($atts)
{
    $a = ag_results_attributes($atts);
    if ($a === null) {
        // Ошибку видят только те, кто может править страницу; зрителям ничего не показываем.
        return current_user_can('edit_posts')
            ? '<p><strong>Табло результатов:</strong> в шорткоде нет ID соревнования или он записан с ошибкой. Скопируйте шорткод заново в секретариате.</p>'
            : '';
    }
    wp_enqueue_script('ag-results-embed', ag_results_base() . '/embed.js', array(), null, true);
    $html = '<div data-ag-results="' . esc_attr($a['id']) . '" data-view="' . esc_attr($a['view'])
        . '" data-theme="' . esc_attr($a['theme']) . '"';
    if ($a['category'] !== null) {
        $html .= ' data-category="' . esc_attr((string) $a['category']) . '"';
    }
    return $html . '></div>';
}
add_shortcode('ag_results', 'ag_results_shortcode');

/** Скрипт табло грузится асинхронно и не задерживает показ страницы. */
function ag_results_async($tag, $handle)
{
    if ($handle !== 'ag-results-embed' || strpos($tag, ' async') !== false) {
        return $tag;
    }
    return str_replace(' src=', ' async src=', $tag);
}
add_filter('script_loader_tag', 'ag_results_async', 10, 2);

/** Адрес ретранслятора: только https или http, без лишнего. */
function ag_results_sanitize_base($value)
{
    $value = trim((string) $value);
    if ($value === '') {
        return '';
    }
    $url = esc_url_raw($value, array('https', 'http'));
    return $url === '' ? '' : rtrim($url, '/');
}

function ag_results_settings()
{
    register_setting('ag_results', AG_RESULTS_OPTION, array(
        'type' => 'string',
        'sanitize_callback' => 'ag_results_sanitize_base',
        'default' => '',
    ));
}
add_action('admin_init', 'ag_results_settings');

function ag_results_settings_page()
{
    if (!current_user_can('manage_options')) {
        return;
    }
    ?>
    <div class="wrap">
        <h1>Табло результатов</h1>
        <form method="post" action="options.php">
            <?php settings_fields('ag_results'); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><label for="ag_results_base">Адрес ретранслятора</label></th>
                    <td>
                        <input name="<?php echo esc_attr(AG_RESULTS_OPTION); ?>" id="ag_results_base" type="url" class="regular-text"
                            value="<?php echo esc_attr((string) get_option(AG_RESULTS_OPTION, '')); ?>"
                            placeholder="<?php echo esc_attr(home_url('/results')); ?>">
                        <p class="description">Оставьте пустым, если ретранслятор распакован в папку results этого сайта.</p>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>
        <p>Табло вставляется на страницу шорткодом, например <code>[ag_results id="ID соревнования" theme="dark"]</code>. Готовый шорткод есть в секретариате, в блоке «Результаты на сайте».</p>
    </div>
    <?php
}

function ag_results_menu()
{
    add_options_page('Табло результатов', 'Табло результатов', 'manage_options', 'ag-results', 'ag_results_settings_page');
}
add_action('admin_menu', 'ag_results_menu');
