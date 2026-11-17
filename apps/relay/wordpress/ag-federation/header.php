<?php
if (!defined('ABSPATH')) {
    exit;
}
$live = ag_live_competition();
?><!doctype html>
<html <?php language_attributes(); ?>>
<head>
<meta charset="<?php bloginfo('charset'); ?>">
<meta name="viewport" content="width=device-width, initial-scale=1">
<?php wp_head(); ?>
</head>
<body <?php body_class($live ? 'is-live' : ''); ?>>
<?php wp_body_open(); ?>
<a class="skip-link" href="#content">Перейти к содержимому</a>
<header class="site-header">
    <div class="container site-header__inner">
        <a class="brand" href="<?php echo esc_url(home_url('/')); ?>" rel="home">
            <?php if (has_custom_logo()) : ?>
                <span class="brand__logo brand__logo--img"><?php echo wp_get_attachment_image((int) get_theme_mod('custom_logo'), 'thumbnail', false, array('alt' => '')); ?></span>
            <?php else : ?>
                <span class="brand__logo"><?php echo ag_icon('logo', 26); ?></span>
            <?php endif; ?>
            <span class="brand__text"><b><?php echo esc_html(ag_mod('ag_brand_title')); ?></b><small><?php echo esc_html(ag_mod('ag_brand_sub')); ?></small></span>
        </a>
        <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav" aria-label="Меню" data-ag-nav-toggle>
            <span class="nav-toggle__open"><?php echo ag_icon('menu', 22); ?></span><span class="nav-toggle__close"><?php echo ag_icon('close', 22); ?></span>
        </button>
        <nav class="site-nav" id="site-nav" aria-label="Главное меню">
            <?php
            wp_nav_menu(array(
                'theme_location' => 'primary',
                'container' => false,
                'menu_class' => 'menu',
                'depth' => 2,
                'fallback_cb' => 'ag_default_menu',
            ));
            ?>
            <form class="site-nav__search" role="search" method="get" action="<?php echo esc_url(home_url('/')); ?>">
                <label class="screen-reader-text" for="nav-search">Поиск по сайту</label>
                <input id="nav-search" type="search" name="s" placeholder="Поиск по сайту" value="<?php echo esc_attr(get_search_query()); ?>">
            </form>
        </nav>
        <a class="btn btn--accent site-header__live" href="<?php echo esc_url(ag_live_url()); ?>">
            <?php echo $live ? ag_live_dot() : ''; ?>Табло онлайн
        </a>
    </div>
</header>
<main id="content" class="site-main">
