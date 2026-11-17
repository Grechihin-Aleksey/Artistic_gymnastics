<?php
/**
 * Учебные группы: карточки групп по клубам или общая сетка «Расписание по дням недели» (?view=week).
 * Фильтры: клуб и девочки/мальчики.
 */
if (!defined('ABSPATH')) {
    exit;
}
get_header();
$f = ag_group_filters();
$groups = array();
while (have_posts()) {
    the_post();
    $groups[] = ag_group(get_post());
}
$club_ids = get_posts(array(
    'post_type' => 'ag_group',
    'posts_per_page' => 300,
    'fields' => 'ids',
    'meta_key' => '_ag_club',
));
$clubs = array();
foreach ($club_ids as $gid) {
    $cid = (int) get_post_meta($gid, '_ag_club', true);
    if ($cid && get_post_status($cid) === 'publish') {
        $clubs[$cid] = get_the_title($cid);
    }
}
asort($clubs);
$base = ag_groups_url();
$link = function ($changes) use ($f, $base) {
    $q = array_filter(array('view' => $f['week'] ? 'week' : '', 'club' => $f['club'] ?: '', 'gender' => $f['gender']));
    foreach ($changes as $k => $v) {
        $q[$k] = $v;
    }
    return add_query_arg(array_filter($q), $base);
};
?>
<section class="page-head">
    <div class="container">
        <h1 class="page-head__title">Группы и расписание занятий</h1>
        <p class="page-head__lead">Где и когда занимаются учебные группы, тренеры и набор в новые группы.</p>
        <div class="tabs-line" role="tablist">
            <a class="tabs-line__tab<?php echo $f['week'] ? '' : ' is-active'; ?>" href="<?php echo esc_url($link(array('view' => ''))); ?>">Группы</a>
            <a class="tabs-line__tab<?php echo $f['week'] ? ' is-active' : ''; ?>" href="<?php echo esc_url($link(array('view' => 'week'))); ?>">Расписание по дням</a>
        </div>
    </div>
</section>
<section class="section section--tight">
    <div class="container">
        <div class="filters">
            <?php if (count($clubs) > 1) : ?>
                <div class="pills" aria-label="Клуб">
                    <a class="pill<?php echo $f['club'] ? '' : ' is-active'; ?>" href="<?php echo esc_url($link(array('club' => ''))); ?>">Все клубы</a>
                    <?php foreach ($clubs as $cid => $name) : ?>
                        <a class="pill<?php echo $f['club'] === $cid ? ' is-active' : ''; ?>" href="<?php echo esc_url($link(array('club' => $cid))); ?>"><?php echo esc_html($name); ?></a>
                    <?php endforeach; ?>
                </div>
            <?php endif; ?>
            <div class="pills" aria-label="Кто занимается">
                <a class="pill<?php echo $f['gender'] === '' ? ' is-active' : ''; ?>" href="<?php echo esc_url($link(array('gender' => ''))); ?>">Все</a>
                <a class="pill<?php echo $f['gender'] === 'girls' ? ' is-active' : ''; ?>" href="<?php echo esc_url($link(array('gender' => 'girls'))); ?>">Девочки</a>
                <a class="pill<?php echo $f['gender'] === 'boys' ? ' is-active' : ''; ?>" href="<?php echo esc_url($link(array('gender' => 'boys'))); ?>">Мальчики</a>
            </div>
        </div>
        <?php if (!$groups) : ?>
            <div class="empty"><p>Групп по этому отбору нет.</p></div>
        <?php elseif ($f['week']) :
            ag_week_grid($groups, !$f['club']);
        else :
            $by_club = array();
            foreach ($groups as $g) {
                $by_club[$g['club'] ? get_the_title($g['club']) : ''][] = $g;
            }
            uksort($by_club, function ($a, $b) {
                return ($a === '') - ($b === '') ?: strcmp($a, $b);
            });
            foreach ($by_club as $name => $list) : ?>
                <?php if (count($by_club) > 1 || $name !== '') : ?>
                    <h2 class="cal__month group-club"><?php if ($name !== '') : ?><a href="<?php echo esc_url(get_permalink($list[0]['club'])); ?>"><?php echo esc_html($name); ?></a><?php else : ?>Другие группы<?php endif; ?></h2>
                <?php endif; ?>
                <div class="group-list">
                    <?php foreach ($list as $g) {
                        ag_group_card($g, false);
                    } ?>
                </div>
            <?php endforeach;
        endif; ?>
    </div>
</section>
<?php
get_footer();
