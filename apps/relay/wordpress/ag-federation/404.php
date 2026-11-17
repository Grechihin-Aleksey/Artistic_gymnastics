<?php
if (!defined('ABSPATH')) {
    exit;
}
get_header(); ?>
<section class="page-head">
    <div class="container">
        <h1 class="page-head__title">Страница не найдена</h1>
        <p class="page-head__lead">Возможно, её перенесли. Загляните в календарь или поищите по сайту.</p>
        <div class="hero__actions">
            <a class="btn btn--accent" href="<?php echo esc_url(get_post_type_archive_link('ag_competition')); ?>">Календарь соревнований</a>
            <a class="btn btn--outline btn--onDark" href="<?php echo esc_url(home_url('/')); ?>">На главную</a>
        </div>
    </div>
</section>
<?php get_footer();
