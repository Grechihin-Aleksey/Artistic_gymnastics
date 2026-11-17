<?php
/**
 * «Внешний вид → Настроить»: название, контакты, цифры федерации, цвета и адрес ретранслятора.
 */

if (!defined('ABSPATH')) {
    exit;
}

/** Значения по умолчанию: тема сразу выглядит законченной, их остаётся поправить. */
function ag_defaults()
{
    return array(
        'ag_brand_title' => 'Спортивная гимнастика',
        'ag_brand_sub' => 'Нижегородская область · федерация',
        'ag_org_name' => 'Федерация спортивной гимнастики Нижегородской области',
        'ag_hero_title' => 'Спортивная гимнастика Нижегородской области',
        'ag_hero_text' => 'Календарь стартов, онлайн-заявки клубов, результаты и протоколы всех соревнований федерации.',
        'ag_about_text' => 'Федерация объединяет спортивные школы, тренеров и судей региона и проводит соревнования всех уровней, от городских турниров до всероссийских стартов.',
        'ag_address' => '',
        'ag_phone' => '',
        'ag_email' => '',
        'ag_vk' => '',
        'ag_telegram' => '',
        'ag_stat1_value' => '20+', 'ag_stat1_label' => 'соревнований в год',
        'ag_stat2_value' => '1500+', 'ag_stat2_label' => 'спортсменов области',
        'ag_stat3_value' => '12', 'ag_stat3_label' => 'спортивных школ',
        'ag_stat4_value' => '86', 'ag_stat4_label' => 'тренеров и судей',
        'ag_color_primary' => '#0d2c54',
        'ag_color_accent' => '#e2603c',
        'ag_relay_base' => '',
        'ag_about_page' => 0,
        'ag_judges_page' => 0,
    );
}

function ag_mod($key)
{
    $d = ag_defaults();
    return get_theme_mod($key, $d[$key] ?? '');
}

function ag_customize($wp)
{
    $d = ag_defaults();
    $wp->add_panel('ag', array('title' => 'Сайт федерации', 'priority' => 20));

    $sections = array(
        'ag_brand' => 'Название и главный экран',
        'ag_contacts' => 'Контакты и соцсети',
        'ag_about' => 'О федерации и цифры',
        'ag_relay' => 'Программа соревнований',
    );
    foreach ($sections as $id => $title) {
        $wp->add_section($id, array('title' => $title, 'panel' => 'ag'));
    }

    $text = function ($key, $label, $section, $type = 'text', $desc = '') use ($wp, $d) {
        $sanitize = $type === 'url' ? 'esc_url_raw' : ($type === 'email' ? 'sanitize_email' : ($type === 'textarea' ? 'sanitize_textarea_field' : 'sanitize_text_field'));
        $wp->add_setting($key, array('default' => $d[$key], 'sanitize_callback' => $sanitize));
        $wp->add_control($key, array('label' => $label, 'section' => $section, 'type' => $type, 'description' => $desc));
    };

    $text('ag_brand_title', 'Название в шапке, первая строка', 'ag_brand');
    $text('ag_brand_sub', 'Вторая строка', 'ag_brand');
    $text('ag_org_name', 'Полное название организации (подвал)', 'ag_brand');
    $text('ag_hero_title', 'Заголовок главной, когда соревнований нет', 'ag_brand');
    $text('ag_hero_text', 'Текст под заголовком', 'ag_brand', 'textarea');

    $text('ag_address', 'Адрес', 'ag_contacts');
    $text('ag_phone', 'Телефон', 'ag_contacts');
    $text('ag_email', 'Почта', 'ag_contacts', 'email');
    $text('ag_vk', 'ВКонтакте', 'ag_contacts', 'url');
    $text('ag_telegram', 'Telegram', 'ag_contacts', 'url');

    $text('ag_about_text', 'Текст «О федерации» на главной', 'ag_about', 'textarea');
    foreach (array(1, 2, 3, 4) as $i) {
        $text("ag_stat{$i}_value", "Цифра $i", 'ag_about');
        $text("ag_stat{$i}_label", "Подпись к цифре $i", 'ag_about');
    }
    foreach (array('ag_about_page' => 'Страница «О федерации»', 'ag_judges_page' => 'Страница судейской коллегии') as $key => $label) {
        $wp->add_setting($key, array('default' => 0, 'sanitize_callback' => 'absint'));
        $wp->add_control($key, array('label' => $label, 'section' => 'ag_about', 'type' => 'dropdown-pages', 'allow_addition' => true));
    }

    $text(
        'ag_relay_base',
        'Адрес ретранслятора результатов',
        'ag_relay',
        'url',
        'Оставьте пустым, если ретранслятор распакован в папку results этого сайта. Отсюда тема берёт табло, протоколы и форму заявки.'
    );

    foreach (array('ag_color_primary' => 'Основной цвет (шапка, заголовки)', 'ag_color_accent' => 'Акцент (кнопки, «идёт сейчас»)') as $key => $label) {
        $wp->add_setting($key, array('default' => $d[$key], 'sanitize_callback' => 'sanitize_hex_color'));
        $wp->add_control(new WP_Customize_Color_Control($wp, $key, array('label' => $label, 'section' => 'colors')));
    }
}
add_action('customize_register', 'ag_customize');

/** Цвета из настроек: переменные CSS, всё остальное считается от них. */
function ag_color_css()
{
    $d = ag_defaults();
    $p = sanitize_hex_color(ag_mod('ag_color_primary')) ?: $d['ag_color_primary'];
    $a = sanitize_hex_color(ag_mod('ag_color_accent')) ?: $d['ag_color_accent'];
    if ($p === $d['ag_color_primary'] && $a === $d['ag_color_accent']) {
        return '';
    }
    return ':root{--ag-primary:' . $p . ';--ag-accent:' . $a . ';}';
}
