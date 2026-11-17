<?php
if (!defined('ABSPATH')) {
    exit;
}
get_header();
while (have_posts()) :
    the_post();
    $important = get_post_meta(get_the_ID(), '_ag_important', true) === '1';
    $until = (string) get_post_meta(get_the_ID(), '_ag_until', true);
    $club = (int) get_post_meta(get_the_ID(), '_ag_club', true);
    $expired = ag_notice_expired(get_the_ID());
    ?>
    <article class="article">
        <header class="container container--text article__head">
            <p class="crumbs"><a href="<?php echo esc_url(get_post_type_archive_link('ag_notice')); ?>">Объявления</a><?php if ($club && get_post_status($club) === 'publish') : ?> / <a href="<?php echo esc_url(get_permalink($club)); ?>"><?php echo esc_html(get_the_title($club)); ?></a><?php endif; ?></p>
            <?php if ($important && !$expired) : ?><p class="notice__meta"><span class="notice__flag">Важно</span></p><?php endif; ?>
            <h1 class="article__title"><?php the_title(); ?></h1>
            <p class="article__date"><?php echo esc_html(ag_post_date()); ?><?php
            if ($expired) {
                echo ' · объявление устарело';
            } elseif ($until !== '') {
                echo ' · актуально до ' . esc_html(ag_date_range($until, $until, false));
            } ?></p>
        </header>
        <div class="container container--text entry-content">
            <?php the_content(); ?>
        </div>
    </article>
    <?php
    $more = array_filter(ag_notices(4), function ($p) {
        return $p->ID !== get_the_ID();
    });
    if ($more) : ?>
        <section class="section section--tight">
            <div class="container container--text">
                <?php ag_section_head('Другие объявления', get_post_type_archive_link('ag_notice'), 'Все объявления'); ?>
                <div class="notice-list"><?php foreach (array_slice($more, 0, 3) as $n) {
                    ag_notice_card($n, true);
                } ?></div>
            </div>
        </section>
    <?php endif;
endwhile;
get_footer();
