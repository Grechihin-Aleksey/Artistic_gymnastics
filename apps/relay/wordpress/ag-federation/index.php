<?php
/**
 * Лента новостей, рубрики, метки и всё, для чего нет своего шаблона.
 */
if (!defined('ABSPATH')) {
    exit;
}
get_header();
$title = is_home() ? 'Новости' : (is_search() ? 'Поиск: ' . get_search_query() : get_the_archive_title());
$cats = get_categories(array('hide_empty' => true));
?>
<section class="page-head">
    <div class="container">
        <h1 class="page-head__title"><?php echo esc_html($title); ?></h1>
        <?php if ((is_home() || is_category()) && count($cats) > 1) : ?>
            <div class="pills pills--head">
                <a class="pill<?php echo is_home() ? ' is-active' : ''; ?>" href="<?php echo esc_url(ag_news_url()); ?>">Все</a>
                <?php foreach ($cats as $cat) : ?>
                    <a class="pill<?php echo is_category($cat->term_id) ? ' is-active' : ''; ?>" href="<?php echo esc_url(get_category_link($cat)); ?>"><?php echo esc_html($cat->name); ?></a>
                <?php endforeach; ?>
            </div>
        <?php endif; ?>
    </div>
</section>
<section class="section section--tight">
    <div class="container">
        <?php if (have_posts()) : ?>
            <div class="grid grid--3">
                <?php while (have_posts()) {
                    the_post();
                    if (get_post_type() === 'post') {
                        ag_news_card();
                    } else {
                        echo '<a class="card search-card" href="' . esc_url(get_permalink()) . '"><span class="news-card__tag">' . esc_html(get_post_type_object(get_post_type())->labels->singular_name) . '</span><span class="news-card__title">' . esc_html(get_the_title()) . '</span></a>';
                    }
                } ?>
            </div>
            <?php ag_pagination(); ?>
        <?php else : ?>
            <div class="empty"><p><?php echo is_search() ? 'Ничего не нашлось. Попробуйте другое слово.' : 'Здесь пока пусто.'; ?></p></div>
        <?php endif; ?>
    </div>
</section>
<?php
get_footer();
