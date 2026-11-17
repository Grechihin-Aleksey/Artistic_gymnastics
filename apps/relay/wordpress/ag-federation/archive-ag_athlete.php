<?php
/**
 * Спортсмены: все, у кого есть сохранённые на сайте результаты. Поиск по фамилии, буквы, пол.
 */
if (!defined('ABSPATH')) {
    exit;
}
get_header();
$base = get_post_type_archive_link('ag_athlete');
$find = isset($_GET['q']) ? sanitize_text_field(wp_unslash($_GET['q'])) : '';
$letter = isset($_GET['letter']) ? mb_substr(sanitize_text_field(wp_unslash($_GET['letter'])), 0, 1) : '';
$gender = isset($_GET['gender']) ? sanitize_key(wp_unslash($_GET['gender'])) : '';
$letters = preg_split('//u', 'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ', -1, PREG_SPLIT_NO_EMPTY);
?>
<section class="page-head">
    <div class="container">
        <h1 class="page-head__title">Спортсмены</h1>
        <p class="page-head__lead">История выступлений, лучшие оценки и медали гимнастов области. Страницы появляются сами из протоколов соревнований.</p>
        <form class="athlete-search" method="get" action="<?php echo esc_url($base); ?>" role="search">
            <label class="screen-reader-text" for="athlete-q">Фамилия или имя</label>
            <input id="athlete-q" type="search" name="q" value="<?php echo esc_attr($find); ?>" placeholder="Фамилия или имя">
            <button class="btn btn--accent" type="submit">Найти</button>
        </form>
    </div>
</section>
<section class="section section--tight">
    <div class="container">
        <div class="filters">
            <div class="pills">
                <a class="pill<?php echo $gender === '' ? ' is-active' : ''; ?>" href="<?php echo esc_url(remove_query_arg('gender')); ?>">Все</a>
                <a class="pill<?php echo $gender === 'girls' ? ' is-active' : ''; ?>" href="<?php echo esc_url(add_query_arg('gender', 'girls')); ?>">Девушки</a>
                <a class="pill<?php echo $gender === 'boys' ? ' is-active' : ''; ?>" href="<?php echo esc_url(add_query_arg('gender', 'boys')); ?>">Юноши</a>
            </div>
            <nav class="letters" aria-label="Первая буква фамилии">
                <?php foreach ($letters as $l) : ?>
                    <a class="<?php echo $l === $letter ? 'is-active' : ''; ?>" href="<?php echo esc_url($l === $letter ? remove_query_arg(array('letter', 'paged')) : add_query_arg('letter', $l, remove_query_arg('paged'))); ?>"><?php echo esc_html($l); ?></a>
                <?php endforeach; ?>
            </nav>
        </div>
        <?php if (have_posts()) : ?>
            <div class="athlete-list">
                <?php while (have_posts()) {
                    the_post();
                    ag_athlete_item(get_the_ID());
                } ?>
            </div>
            <?php ag_pagination(); ?>
        <?php else : ?>
            <div class="empty"><p><?php echo $find !== '' || $letter !== '' ? 'Никого не нашлось.' : 'Спортсмены появятся здесь после первого завершённого турнира с сохранёнными результатами.'; ?></p></div>
        <?php endif; ?>
    </div>
</section>
<?php
get_footer();
