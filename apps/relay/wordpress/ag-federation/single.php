<?php
if (!defined('ABSPATH')) {
    exit;
}
get_header();
while (have_posts()) :
    the_post();
    $cat = get_the_category();
    $comp = (int) get_post_meta(get_the_ID(), '_ag_competition', true);
    ?>
    <article class="article">
        <header class="container container--text article__head">
            <p class="crumbs"><a href="<?php echo esc_url(ag_news_url()); ?>">Новости</a><?php if ($cat) : ?> / <a href="<?php echo esc_url(get_category_link($cat[0])); ?>"><?php echo esc_html($cat[0]->name); ?></a><?php endif; ?></p>
            <h1 class="article__title"><?php the_title(); ?></h1>
            <p class="article__date"><?php echo esc_html(ag_post_date()); ?></p>
        </header>
        <?php if (has_post_thumbnail()) : ?>
            <figure class="container container--wide article__cover"><?php the_post_thumbnail('large', array('alt' => '')); ?></figure>
        <?php endif; ?>
        <div class="container container--text entry-content">
            <?php the_content(); ?>
            <?php wp_link_pages(); ?>
        </div>
        <?php if ($comp && get_post_status($comp) === 'publish') : ?>
            <div class="container container--text">
                <a class="card related-comp" href="<?php echo esc_url(get_permalink($comp) . '#results'); ?>"><?php echo ag_icon('cup', 22); ?><span><small>Соревнование</small><b><?php echo esc_html(get_the_title($comp)); ?></b></span><?php echo ag_icon('arrow', 18); ?></a>
            </div>
        <?php endif; ?>
    </article>
    <?php
    $more = get_posts(array('post_type' => 'post', 'posts_per_page' => 3, 'post__not_in' => array(get_the_ID())));
    if ($more) : ?>
        <section class="section section--tight">
            <div class="container">
                <?php ag_section_head('Ещё новости', ag_news_url(), 'Все новости'); ?>
                <div class="grid grid--3"><?php foreach ($more as $m) {
                    ag_news_card($m);
                } ?></div>
            </div>
        </section>
    <?php endif;
endwhile;
get_footer();
