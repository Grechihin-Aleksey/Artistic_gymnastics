<?php
/** Объявления: действующие (важные первыми), ниже — прошедшие. */
if (!defined('ABSPATH')) {
    exit;
}
get_header();
$paged = max(1, (int) get_query_var('paged'));
$active = $paged === 1 ? ag_notices(50) : array();
$active_ids = wp_list_pluck($active, 'ID');
$past = array();
while (have_posts()) {
    the_post();
    if (!in_array(get_the_ID(), $active_ids, true)) {
        $past[] = get_post();
    }
}
?>
<section class="page-head">
    <div class="container">
        <h1 class="page-head__title">Объявления</h1>
        <p class="page-head__lead">Сборы, переносы занятий, набор в группы, собрания и всё, что важно знать спортсменам, родителям и тренерам.</p>
    </div>
</section>
<section class="section section--tight">
    <div class="container container--text">
        <?php if (!$active && !$past) : ?><div class="empty"><p>Объявлений пока нет.</p></div><?php endif; ?>
        <?php if ($active) : ?>
            <div class="notice-list"><?php foreach ($active as $n) {
                ag_notice_card($n);
            } ?></div>
        <?php endif; ?>
        <?php if ($past) : ?>
            <h2 class="cal__month notice-past-title">Прошедшие</h2>
            <div class="notice-list"><?php foreach ($past as $n) {
                ag_notice_card($n);
            } ?></div>
        <?php endif; ?>
        <?php ag_pagination(); ?>
    </div>
</section>
<?php
get_footer();
