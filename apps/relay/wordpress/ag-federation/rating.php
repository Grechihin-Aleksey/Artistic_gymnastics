<?php
/** Рейтинг сезона: медали спортсменов и клубов за год. */
if (!defined('ABSPATH')) {
    exit;
}
get_header();
$years = ag_rating_years();
$year = isset($_GET['season']) ? absint($_GET['season']) : 0;
if (!in_array($year, $years, true)) {
    $year = $years ? $years[0] : (int) wp_date('Y');
}
$gender = isset($_GET['gender']) ? sanitize_key(wp_unslash($_GET['gender'])) : '';
$gender = in_array($gender, array('girls', 'boys'), true) ? $gender : '';
$data = ag_rating($year, $gender);
$athletes = array_values(array_filter($data['athletes'], function ($a) {
    return array_sum($a[1]) > 0;
}));
$clubs = array_values(array_filter($data['clubs'], function ($c) {
    return array_sum($c[2]) > 0;
}));
$link = function ($args) use ($year, $gender) {
    return ag_rating_url(array_filter(array_merge(array('season' => $year, 'gender' => $gender), $args)));
};
$medal_cells = function ($m) {
    $out = '';
    foreach (array(0, 1, 2) as $i) {
        $out .= '<td class="num">' . ($m[$i] ? '<span class="place place--' . ($i + 1) . '">' . (int) $m[$i] . '</span>' : '<span class="muted">—</span>') . '</td>';
    }
    return $out;
};
?>
<section class="page-head">
    <div class="container">
        <h1 class="page-head__title">Рейтинг сезона <?php echo (int) $year; ?></h1>
        <p class="page-head__lead">Медали спортсменов и клубов области в многоборье и финалах отдельных видов на соревнованиях федерации. Считается сам по протоколам.</p>
        <?php if (count($years) > 1) : ?>
            <div class="pills pills--head">
                <?php foreach ($years as $y) : ?>
                    <a class="pill<?php echo $y === $year ? ' is-active' : ''; ?>" href="<?php echo esc_url($link(array('season' => $y))); ?>"><?php echo (int) $y; ?></a>
                <?php endforeach; ?>
            </div>
        <?php endif; ?>
    </div>
</section>
<section class="section section--tight">
    <div class="container">
        <div class="filters">
            <div class="pills">
                <a class="pill<?php echo $gender === '' ? ' is-active' : ''; ?>" href="<?php echo esc_url($link(array('gender' => ''))); ?>">Все</a>
                <a class="pill<?php echo $gender === 'girls' ? ' is-active' : ''; ?>" href="<?php echo esc_url($link(array('gender' => 'girls'))); ?>">Девушки</a>
                <a class="pill<?php echo $gender === 'boys' ? ' is-active' : ''; ?>" href="<?php echo esc_url($link(array('gender' => 'boys'))); ?>">Юноши</a>
            </div>
        </div>
        <?php if (!$athletes && !$clubs) : ?>
            <div class="empty"><p>За этот сезон результатов на сайте пока нет. Они появятся сами после первого турнира.</p></div>
        <?php else : ?>
            <div class="rating-grid">
                <div class="card">
                    <h2 class="card__title">Спортсмены</h2>
                    <div class="table-wrap">
                        <table class="rtable rating-table">
                            <thead><tr><th class="num">#</th><th>Спортсмен</th><th class="num" title="Золото"><span class="place place--1">1</span></th><th class="num" title="Серебро"><span class="place place--2">2</span></th><th class="num" title="Бронза"><span class="place place--3">3</span></th><th class="num">Стартов</th></tr></thead>
                            <tbody>
                                <?php foreach (array_slice($athletes, 0, 50) as $i => $a) : ?>
                                    <tr>
                                        <td class="num rating-table__pos"><?php echo (int) $i + 1; ?></td>
                                        <td><a href="<?php echo esc_url(get_permalink($a[0])); ?>"><?php echo esc_html(get_the_title($a[0])); ?></a><small><?php echo esc_html((string) get_post_meta($a[0], '_ag_club', true)); ?></small></td>
                                        <?php echo $medal_cells($a[1]); // phpcs:ignore WordPress.Security.EscapeOutput ?>
                                        <td class="num"><?php echo (int) $a[2]; ?></td>
                                    </tr>
                                <?php endforeach; ?>
                            </tbody>
                        </table>
                    </div>
                </div>
                <div class="card">
                    <h2 class="card__title">Клубы</h2>
                    <div class="table-wrap">
                        <table class="rtable rating-table">
                            <thead><tr><th class="num">#</th><th>Клуб</th><th class="num" title="Золото"><span class="place place--1">1</span></th><th class="num" title="Серебро"><span class="place place--2">2</span></th><th class="num" title="Бронза"><span class="place place--3">3</span></th><th class="num">Спортсменов</th></tr></thead>
                            <tbody>
                                <?php foreach ($clubs as $i => $c) : ?>
                                    <tr>
                                        <td class="num rating-table__pos"><?php echo (int) $i + 1; ?></td>
                                        <td><?php echo $c[1] ? '<a href="' . esc_url(get_permalink($c[1])) . '">' . esc_html($c[0]) . '</a>' : esc_html($c[0]); ?></td>
                                        <?php echo $medal_cells($c[2]); // phpcs:ignore WordPress.Security.EscapeOutput ?>
                                        <td class="num"><?php echo (int) $c[3]; ?></td>
                                    </tr>
                                <?php endforeach; ?>
                            </tbody>
                        </table>
                    </div>
                    <p class="muted small">Считаются личные медали спортсменов клуба. Командные места — на страницах соревнований.</p>
                </div>
            </div>
        <?php endif; ?>
    </div>
</section>
<?php
get_footer();
