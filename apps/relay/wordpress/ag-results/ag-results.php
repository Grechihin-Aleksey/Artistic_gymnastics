<?php
/**
 * Plugin Name: Табло результатов (спортивная гимнастика)
 * Description: Шорткод [ag_results id="…"] вставляет на страницу табло турнира с ретранслятора результатов, а [ag_entry id="…" key="…"] — кнопку «Подать заявку» для клубов. Работает и у редакторов без прав администратора: тег script на страницу вставлять не нужно.
 * Version: 1.2.0
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

/**
 * [ag_entry id="…" key="…" text="Подать заявку"] — кнопка, ведущая клубы на форму онлайн-заявки.
 * Ссылка одна на весь турнир: id — ID соревнования, key — ключ приёма из секретариата.
 * Кнопка синяя с полосой триколора снизу; стили плагина перебивают стили кнопок темы и Elementor.
 */
function ag_entry_shortcode($atts)
{
    $atts = shortcode_atts(array('id' => '', 'key' => '', 'text' => 'Подать заявку'), $atts, 'ag_entry');
    $id = trim((string) $atts['id']);
    $key = trim((string) $atts['key']);
    if (
        !preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $id)
        || !preg_match('/^[A-Za-z0-9_-]{16,128}$/', $key)
    ) {
        return current_user_can('edit_posts')
            ? '<p><strong>Кнопка заявки:</strong> в шорткоде нет ID соревнования или ключа, или они записаны с ошибкой. Скопируйте шорткод заново в секретариате, в блоке «Онлайн-заявки клубов».</p>'
            : '';
    }
    $text = trim(wp_strip_all_tags((string) $atts['text']));
    if ($text === '') {
        $text = 'Подать заявку';
    }
    if (function_exists('mb_substr')) {
        $text = mb_substr($text, 0, 60);
    }
    $url = ag_results_base() . '/entry/index.html#c=' . rawurlencode($id) . '&k=' . rawurlencode($key);
    return ag_entry_style()
        . '<div class="ag-entry"><a class="ag-entry__button" href="' . esc_url($url) . '" target="_blank" rel="noopener">'
        . '<span class="ag-entry__text">' . esc_html($text) . '</span>'
        . '<span class="ag-entry__flag" aria-hidden="true"><span></span><span></span><span></span></span></a></div>';
}

/**
 * Стили кнопки заявки: один раз на страницу, прямо рядом с кнопкой. Селекторы с id-подобной
 * специфичностью и !important, потому что темы и Elementor красят все ссылки и кнопки по-своему.
 */
function ag_entry_style()
{
    static $printed = false;
    if ($printed) {
        return '';
    }
    $printed = true;
    $b = 'div.ag-entry a.ag-entry__button.ag-entry__button';
    return '<style id="ag-entry-style">'
        . 'div.ag-entry{margin:1em 0!important;line-height:1!important}'
        . $b . ',' . $b . ':visited{display:inline-flex!important;flex-direction:column!important;align-items:stretch!important;gap:6px!important;'
        . 'background:none!important;border:0!important;box-shadow:none!important;padding:0!important;text-decoration:none!important;'
        . 'width:auto!important;min-width:0!important;transition:transform .15s ease!important}'
        . $b . ' .ag-entry__text{display:block!important;background:#0039A6!important;color:#FFFFFF!important;border-radius:10px!important;'
        . 'padding:14px 32px!important;font-family:inherit!important;font-weight:600!important;font-size:17px!important;line-height:1.2!important;letter-spacing:.01em!important;'
        . 'text-align:center!important;text-transform:none!important;box-shadow:0 2px 6px rgba(0,57,166,.25)!important;transition:background .15s ease,box-shadow .15s ease!important}'
        . $b . ':hover .ag-entry__text,' . $b . ':focus-visible .ag-entry__text{background:#002D84!important;box-shadow:0 4px 12px rgba(0,57,166,.35)!important}'
        . $b . ':hover{transform:translateY(-1px)!important}'
        . $b . ':focus-visible{outline:3px solid #D52B1E!important;outline-offset:3px!important;border-radius:10px!important}'
        . $b . ' .ag-entry__flag{display:flex!important;height:5px!important;border-radius:3px!important;overflow:hidden!important}'
        . $b . ' .ag-entry__flag span{flex:1 1 0!important;display:block!important}'
        . $b . ' .ag-entry__flag span:nth-child(1){background:#FFFFFF!important;box-shadow:inset 1px 1px 0 #D0D7E2,inset 0 -1px 0 #D0D7E2!important}'
        . $b . ' .ag-entry__flag span:nth-child(2){background:#0039A6!important}'
        . $b . ' .ag-entry__flag span:nth-child(3){background:#D52B1E!important}'
        . '</style>';
}
add_shortcode('ag_entry', 'ag_entry_shortcode');

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
        <p>Кнопка «Подать заявку» для клубов: <code>[ag_entry id="ID соревнования" key="ключ приёма"]</code>, надпись меняется атрибутом <code>text</code>. Готовый шорткод есть в секретариате, в блоке «Онлайн-заявки клубов».</p>
    </div>
    <?php
}

function ag_results_menu()
{
    add_options_page('Табло результатов', 'Табло результатов', 'manage_options', 'ag-results', 'ag_results_settings_page');
}
add_action('admin_menu', 'ag_results_menu');
