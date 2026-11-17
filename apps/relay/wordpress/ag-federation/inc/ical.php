<?php
/**
 * Календарь соревнований для телефона: подписка (/competitions/calendar.ics) и файл одного турнира (?ics=1).
 * Подписку понимают Google Календарь, календарь iPhone и Outlook: новые турниры появляются у подписчиков сами.
 */

if (!defined('ABSPATH')) {
    exit;
}

function ag_ical_rewrite()
{
    add_rewrite_rule('^competitions/calendar\.ics$', 'index.php?ag_ical=1', 'top');
}
add_action('init', 'ag_ical_rewrite');

function ag_ical_query_vars($vars)
{
    $vars[] = 'ag_ical';
    return $vars;
}
add_filter('query_vars', 'ag_ical_query_vars');

/** Адрес подписки. $webcal — со схемой webcal://, чтобы телефон сразу предложил подписаться. */
function ag_ical_url($webcal = false)
{
    $url = get_option('permalink_structure') ? home_url('/competitions/calendar.ics') : home_url('/?ag_ical=1');
    return $webcal ? preg_replace('#^https?://#', 'webcal://', $url) : $url;
}

/** Ссылка «Добавить в Google Календарь» на подписку. */
function ag_ical_google_url()
{
    return 'https://calendar.google.com/calendar/render?cid=' . rawurlencode(ag_ical_url(true));
}

/** Экранирование текста в iCalendar и перенос строк длиннее 75 байт. */
function ag_ical_text($s)
{
    return str_replace(array('\\', ';', ',', "\r\n", "\n"), array('\\\\', '\;', '\,', '\n', '\n'), (string) $s);
}

function ag_ical_fold($line)
{
    $out = '';
    while (strlen($line) > 75) {
        $cut = 75;
        // Не режем букву UTF-8 посередине.
        while ($cut > 0 && (ord($line[$cut]) & 0xC0) === 0x80) {
            $cut--;
        }
        $out .= substr($line, 0, $cut) . "\r\n ";
        $line = substr($line, $cut);
    }
    return $out . $line . "\r\n";
}

function ag_ical_event($post_id)
{
    $c = ag_competition($post_id);
    if ($c['start'] === '') {
        return '';
    }
    $end = $c['end'] !== '' ? $c['end'] : $c['start'];
    $place = implode(', ', array_filter(array($c['venue'], $c['city'])));
    $desc = array_filter(array(ag_gender_label($c['gender']), $c['levels'], get_permalink($post_id)));
    $lines = array(
        'BEGIN:VEVENT',
        'UID:competition-' . $post_id . '@' . wp_parse_url(home_url(), PHP_URL_HOST),
        'DTSTAMP:' . gmdate('Ymd\THis\Z', strtotime(get_post_modified_time('Y-m-d H:i:s', true, $post_id) . ' UTC')),
        'DTSTART;VALUE=DATE:' . str_replace('-', '', $c['start']),
        'DTEND;VALUE=DATE:' . gmdate('Ymd', strtotime($end . ' +1 day')),
        'SUMMARY:' . ag_ical_text(get_the_title($post_id)),
        'URL:' . get_permalink($post_id),
    );
    if ($place !== '') {
        $lines[] = 'LOCATION:' . ag_ical_text($place);
    }
    if ($desc) {
        $lines[] = 'DESCRIPTION:' . ag_ical_text(implode("\n", $desc));
    }
    $lines[] = 'END:VEVENT';
    return implode('', array_map('ag_ical_fold', $lines));
}

function ag_ical_send($posts, $filename)
{
    $name = ag_mod('ag_org_name');
    $out = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//ag-federation//RU\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\n";
    $out .= ag_ical_fold('X-WR-CALNAME:' . ag_ical_text('Соревнования · ' . $name));
    if (strpos(wp_timezone_string(), '/') !== false) {
        $out .= 'X-WR-TIMEZONE:' . wp_timezone_string() . "\r\n";
    }
    $out .= "REFRESH-INTERVAL;VALUE=DURATION:PT12H\r\n";
    foreach ($posts as $id) {
        $out .= ag_ical_event($id);
    }
    $out .= "END:VCALENDAR\r\n";
    nocache_headers();
    header('Content-Type: text/calendar; charset=utf-8');
    header('Content-Disposition: inline; filename="' . $filename . '"');
    echo $out; // phpcs:ignore WordPress.Security.EscapeOutput -- формат iCalendar, текст экранирован ag_ical_text
    exit;
}

function ag_ical_serve()
{
    if (get_query_var('ag_ical')) {
        // Год назад и всё будущее: так в календаре видно и прошедшие старты сезона.
        $ids = get_posts(array(
            'post_type' => 'ag_competition',
            'posts_per_page' => 300,
            'fields' => 'ids',
            'meta_query' => array(array('key' => '_ag_end', 'value' => wp_date('Y-m-d', time() - YEAR_IN_SECONDS), 'compare' => '>=')),
        ));
        ag_ical_send($ids, 'competitions.ics');
    }
    if (is_singular('ag_competition') && isset($_GET['ics'])) {
        ag_ical_send(array(get_queried_object_id()), 'competition-' . get_queried_object_id() . '.ics');
    }
}
add_action('template_redirect', 'ag_ical_serve', 1);

/** Ссылка на подписку в шапке страницы календаря. */
function ag_ical_link_tag()
{
    if (is_post_type_archive('ag_competition') || is_front_page()) {
        echo '<link rel="alternate" type="text/calendar" title="Календарь соревнований" href="' . esc_url(ag_ical_url()) . '">' . "\n";
    }
}
add_action('wp_head', 'ag_ical_link_tag');
