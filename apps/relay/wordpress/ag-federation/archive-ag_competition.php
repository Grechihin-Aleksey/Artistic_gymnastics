<?php
/**
 * Календарь (/competitions/) и архив результатов (/competitions/?period=past).
 * Фильтры в адресе: gender=girls|boys, entries=1 (идёт приём заявок), year=2026 (для архива).
 */
if (!defined('ABSPATH')) {
    exit;
}
get_header();

$f = ag_calendar_filters();
$period = $f['period'];
$gender = $f['gender'];
$entries = $f['entries'];
$year = $f['year'];
global $wp_query;
$q = $wp_query;
$base = get_post_type_archive_link('ag_competition');

$link = function ($args) use ($base, $period, $gender, $entries, $year) {
    $all = array_merge(array('period' => $period === 'past' ? 'past' : null, 'gender' => $gender ?: null, 'entries' => $entries ? 1 : null, 'year' => $year ?: null), $args);
    return add_query_arg(array_filter($all, function ($v) {
        return $v !== null && $v !== '';
    }), $base);
};
$pill = function ($url, $label, $active) {
    echo '<a class="pill' . ($active ? ' is-active' : '') . '" href="' . esc_url($url) . '"' . ($active ? ' aria-current="page"' : '') . '>' . esc_html($label) . '</a>';
};
?>
<section class="page-head">
    <div class="container">
        <h1 class="page-head__title"><?php echo $period === 'past' ? 'Результаты соревнований' : 'Календарь соревнований'; ?></h1>
        <p class="page-head__lead"><?php echo $period === 'past' ? 'Призёры и протоколы всех завершённых турниров федерации.' : 'Ближайшие старты, приём заявок и турниры, которые идут прямо сейчас.'; ?></p>
        <div class="tabs-line">
            <a class="tabs-line__tab<?php echo $period === 'upcoming' ? ' is-active' : ''; ?>" href="<?php echo esc_url(add_query_arg(array_filter(array('gender' => $gender ?: null)), $base)); ?>">Предстоящие</a>
            <a class="tabs-line__tab<?php echo $period === 'past' ? ' is-active' : ''; ?>" href="<?php echo esc_url(add_query_arg(array_filter(array('period' => 'past', 'gender' => $gender ?: null)), $base)); ?>">Прошедшие</a>
        </div>
    </div>
</section>

<section class="section section--tight">
    <div class="container">
        <div class="filters">
            <div class="pills">
                <?php
                $pill($link(array('gender' => null)), 'Все', $gender === '');
                $pill($link(array('gender' => 'girls')), 'Девушки', $gender === 'girls');
                $pill($link(array('gender' => 'boys')), 'Юноши', $gender === 'boys');
                if ($period === 'upcoming') {
                    $pill($link(array('entries' => $entries ? null : 1)), 'Идёт приём заявок', $entries);
                }
                ?>
            </div>
            <?php if ($period === 'past') :
                $first = get_posts(array('post_type' => 'ag_competition', 'posts_per_page' => 1, 'meta_key' => '_ag_start', 'orderby' => 'meta_value', 'order' => 'ASC', 'fields' => 'ids'));
                $from = $first ? (int) substr((string) get_post_meta($first[0], '_ag_start', true), 0, 4) : (int) wp_date('Y');
                $to = (int) wp_date('Y');
                if ($from && $from < $to) : ?>
                    <div class="pills">
                        <?php
                        $pill($link(array('year' => null)), 'Все годы', $year === 0);
                        for ($y = $to; $y >= $from; $y--) {
                            $pill($link(array('year' => $y)), (string) $y, $year === $y);
                        }
                        ?>
                    </div>
                <?php endif; ?>
            <?php endif; ?>
        </div>

        <?php if (!$q->have_posts()) : ?>
            <div class="empty">
                <p><?php echo $period === 'past' ? 'Завершённых соревнований с такими условиями нет.' : 'Ближайших соревнований с такими условиями пока нет.'; ?></p>
            </div>
        <?php elseif ($period === 'upcoming') : ?>
            <?php
            $month = '';
            echo '<div class="cal">';
            foreach ($q->posts as $p) {
                $c = ag_competition($p);
                $d = ag_parse_date($c['start']);
                $m = $d ? $d[0] . '-' . $d[1] : '';
                if ($m !== $month && $d) {
                    $names = array(1 => 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь');
                    echo '<h2 class="cal__month">' . esc_html($names[$d[1]] . ($d[0] !== (int) wp_date('Y') ? ' ' . $d[0] : '')) . '</h2>';
                    $month = $m;
                }
                ag_competition_row($c);
            }
            echo '</div>';
            ?>
        <?php else : ?>
            <div class="results-list">
                <?php foreach ($q->posts as $p) :
                    $c = ag_competition($p);
                    $podiums = ag_competition_podiums($c);
                    $files = ag_competition_protocols($c);
                    ?>
                    <article class="card result-item">
                        <div class="result-item__head">
                            <div>
                                <p class="result-item__date"><?php echo esc_html(ag_date_range($c['start'], $c['end'], true) . ($c['city'] !== '' ? ' · ' . $c['city'] : '')); ?></p>
                                <h2 class="result-item__title"><a href="<?php echo esc_url(get_permalink($p) . '#results'); ?>"><?php echo esc_html(get_the_title($p)); ?></a></h2>
                            </div>
                            <a class="btn btn--outline btn--small" href="<?php echo esc_url(get_permalink($p) . '#results'); ?>">Все итоги</a>
                        </div>
                        <?php if ($podiums) : ?>
                            <div class="mini-podiums">
                                <?php foreach (array_slice($podiums, 0, 4) as $pod) : ?>
                                    <div class="mini-podium">
                                        <p class="mini-podium__title"><?php echo esc_html($pod['title']); ?></p>
                                        <?php foreach (array_slice($pod['rows'], 0, 3) as $row) : ?>
                                            <p class="mini-podium__row"><span class="place place--<?php echo (int) $row[0]; ?>"><?php echo (int) $row[0]; ?></span><?php echo isset($row[4]) && $row[4] !== '' ? '<a href="' . esc_url($row[4]) . '">' . esc_html($row[1]) . '</a>' : esc_html($row[1]); ?></p>
                                        <?php endforeach; ?>
                                    </div>
                                <?php endforeach; ?>
                            </div>
                        <?php endif; ?>
                        <?php if ($files) : ?>
                            <div class="podium__files">
                                <?php foreach (array_slice($files, 0, 6) as $f) : ?>
                                    <a class="file-pill" href="<?php echo esc_url($f['url']); ?>" target="_blank" rel="noopener"><?php echo esc_html($f['title']); ?></a>
                                <?php endforeach; ?>
                            </div>
                        <?php elseif (!$podiums) : ?>
                            <p class="muted">Протоколы ещё не выложены.</p>
                        <?php endif; ?>
                    </article>
                <?php endforeach; ?>
            </div>
        <?php endif; ?>
        <?php ag_pagination($q); ?>
    </div>
</section>
<?php
get_footer();
