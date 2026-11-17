<?php
/** Итоги сдачи нормативов всех групп; фильтр по клубу (?club=ID). */
if (!defined('ABSPATH')) {
    exit;
}
get_header();
$club = isset($_GET['club']) ? absint($_GET['club']) : 0;
$all = ag_norm_tests(array('limit' => 300));
$clubs = array();
foreach ($all as $t) {
    if ($t['club'] && get_post_status($t['club']) === 'publish') {
        $clubs[$t['club']] = get_the_title($t['club']);
    }
}
asort($clubs);
$tests = $club ? array_values(array_filter($all, function ($t) use ($club) {
    return $t['club'] === $club;
})) : $all;
$base = get_post_type_archive_link('ag_norm_test');
?>
<section class="page-head">
    <div class="container">
        <h1 class="page-head__title">Сдача нормативов</h1>
        <p class="page-head__lead">Итоги сдачи контрольных нормативов в учебных группах. У каждой группы свои нормативы, у девочек и мальчиков — отдельно.</p>
        <?php if (count($clubs) > 1) : ?>
            <nav class="pills pills--head" aria-label="Клуб">
                <a class="pill<?php echo $club ? '' : ' is-active'; ?>" href="<?php echo esc_url($base); ?>">Все клубы</a>
                <?php foreach ($clubs as $id => $name) : ?>
                    <a class="pill<?php echo $club === $id ? ' is-active' : ''; ?>" href="<?php echo esc_url(add_query_arg('club', $id, $base)); ?>"><?php echo esc_html($name); ?></a>
                <?php endforeach; ?>
            </nav>
        <?php endif; ?>
    </div>
</section>
<section class="section section--tight">
    <div class="container container--text">
        <?php if (!$tests) : ?>
            <div class="empty"><p>Итогов сдачи нормативов пока нет.</p></div>
        <?php else : ?>
            <div class="card norm-lines"><?php foreach ($tests as $t) {
                ag_norm_test_line($t);
            } ?></div>
        <?php endif; ?>
    </div>
</section>
<?php
get_footer();
