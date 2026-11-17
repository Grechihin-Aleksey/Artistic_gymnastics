<?php
/**
 * Рейтинг сезона (/rating/): спортсмены и клубы года по медалям из сохранённых на сайте результатов.
 * Считаются медали многоборья и финалов в отдельных видах, как на страницах спортсменов.
 * Порядок: золото, затем серебро, бронза и число стартов.
 */

if (!defined('ABSPATH')) {
    exit;
}

function ag_rating_rewrite()
{
    add_rewrite_rule('^rating/?$', 'index.php?ag_rating=1', 'top');
}
add_action('init', 'ag_rating_rewrite');

function ag_rating_query_vars($vars)
{
    $vars[] = 'ag_rating';
    return $vars;
}
add_filter('query_vars', 'ag_rating_query_vars');

function ag_rating_template($template)
{
    if (get_query_var('ag_rating')) {
        global $wp_query;
        $wp_query->is_404 = false;
        status_header(200);
        return get_template_directory() . '/rating.php';
    }
    return $template;
}
add_filter('template_include', 'ag_rating_template');

function ag_rating_title($parts)
{
    if (get_query_var('ag_rating')) {
        $parts['title'] = 'Рейтинг сезона';
    }
    return $parts;
}
add_filter('document_title_parts', 'ag_rating_title');

function ag_rating_url($args = array())
{
    $url = get_option('permalink_structure') ? home_url('/rating/') : home_url('/?ag_rating=1');
    return $args ? add_query_arg($args, $url) : $url;
}

/** Годы, за которые на сайте есть результаты: от новых к старым. */
function ag_rating_years()
{
    global $wpdb;
    $ids = $wpdb->get_col('SELECT DISTINCT competition FROM ' . ag_results_table());
    $years = array();
    foreach ($ids as $id) {
        $start = (string) get_post_meta((int) $id, '_ag_start', true);
        if ($start !== '' && get_post_status((int) $id) === 'publish') {
            $years[(int) substr($start, 0, 4)] = true;
        }
    }
    krsort($years);
    return array_keys($years);
}

/**
 * Рейтинг за год. $gender — '', 'girls' или 'boys'.
 * Возвращает ['athletes' => [[id, [з, с, б], стартов], …], 'clubs' => [[название, id клуба или 0, [з, с, б], спортсменов], …]].
 */
function ag_rating($year, $gender = '')
{
    global $wpdb;
    $comps = get_posts(array(
        'post_type' => 'ag_competition',
        'posts_per_page' => 300,
        'fields' => 'ids',
        'meta_query' => array(array('key' => '_ag_start', 'value' => array($year . '-01-01', $year . '-12-31'), 'compare' => 'BETWEEN')),
    ));
    if (!$comps) {
        return array('athletes' => array(), 'clubs' => array());
    }
    $in = implode(',', array_map('intval', $comps));
    $rows = $wpdb->get_results('SELECT competition, athlete, club, kind, stage, place FROM ' . ag_results_table() . " WHERE competition IN ($in) AND athlete > 0 AND kind IN ('aa', 'app')", ARRAY_A);
    $athletes = array();
    $clubs = array();
    $genders = array();
    foreach ($rows as $r) {
        $id = (int) $r['athlete'];
        if (!isset($genders[$id])) {
            $genders[$id] = get_post_status($id) === 'publish' ? (string) get_post_meta($id, '_ag_gender', true) : 'skip';
        }
        if ($genders[$id] === 'skip' || ($gender !== '' && $genders[$id] !== $gender)) {
            continue;
        }
        if (!isset($athletes[$id])) {
            $athletes[$id] = array($id, array(0, 0, 0), array());
        }
        $athletes[$id][2][(int) $r['competition']] = true;
        $p = (int) $r['place'];
        $counts = $r['kind'] === 'aa' || $r['stage'] === 'final';
        $club_key = ag_norm($r['club']);
        if ($club_key !== '' && !isset($clubs[$club_key])) {
            $club_id = ag_club_by_name($r['club']);
            $clubs[$club_key] = array($club_id ? get_the_title($club_id) : $r['club'], $club_id, array(0, 0, 0), array());
        }
        if ($club_key !== '') {
            $clubs[$club_key][3][$id] = true;
        }
        if ($counts && $p >= 1 && $p <= 3) {
            $athletes[$id][1][$p - 1]++;
            if ($club_key !== '') {
                $clubs[$club_key][2][$p - 1]++;
            }
        }
    }
    // Клуб, записанный в протоколах по-разному, но с одной карточкой на сайте, считается один раз.
    $merged = array();
    foreach ($clubs as $key => $c) {
        $k = $c[1] ? 'id' . $c[1] : $key;
        if (!isset($merged[$k])) {
            $merged[$k] = $c;
            continue;
        }
        foreach (array(0, 1, 2) as $i) {
            $merged[$k][2][$i] += $c[2][$i];
        }
        $merged[$k][3] += $c[3];
    }
    $athletes = array_map(function ($a) {
        return array($a[0], $a[1], count($a[2]));
    }, array_values($athletes));
    $clubs = array_map(function ($c) {
        return array($c[0], $c[1], $c[2], count($c[3]));
    }, array_values($merged));
    usort($athletes, function ($a, $b) {
        return array($b[1][0], $b[1][1], $b[1][2], $b[2]) <=> array($a[1][0], $a[1][1], $a[1][2], $a[2]) ?: strcmp(get_the_title($a[0]), get_the_title($b[0]));
    });
    usort($clubs, function ($a, $b) {
        return array($b[2][0], $b[2][1], $b[2][2], $b[3]) <=> array($a[2][0], $a[2][1], $a[2][2], $a[3]) ?: strcmp($a[0], $b[0]);
    });
    return array('athletes' => $athletes, 'clubs' => $clubs);
}
