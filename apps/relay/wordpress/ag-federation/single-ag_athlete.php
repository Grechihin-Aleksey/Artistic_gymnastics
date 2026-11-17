<?php
/**
 * Страница спортсмена: клуб, медали, лучшие оценки по снарядам и вся история выступлений.
 */
if (!defined('ABSPATH')) {
    exit;
}
get_header();
while (have_posts()) :
    the_post();
    $id = get_the_ID();
    $history = ag_athlete_history($id);
    $all = $history ? array_merge(...array_values($history)) : array();
    $medals = ag_medals($all);
    $club = (string) get_post_meta($id, '_ag_club', true);
    $club_id = $club !== '' ? ag_club_by_name($club) : 0;
    $gender = (string) get_post_meta($id, '_ag_gender', true);
    $order = $gender === 'boys' ? array('FX', 'PH', 'SR', 'VT', 'PB', 'HB') : array('VT', 'UB', 'BB', 'FX');

    // Лучшие оценки: по каждому снаряду и в многоборье.
    $best = array();
    foreach ($all as $r) {
        $k = $r['kind'] === 'aa' ? 'AA' : ($r['kind'] === 'app' ? $r['apparatus'] : '');
        if ($k !== '' && (!isset($best[$k]) || (float) $r['total'] > (float) $best[$k]['total'])) {
            $best[$k] = $r;
        }
    }
    $earned = '';
    foreach ($history as $rows) {
        foreach ($rows as $r) {
            if ($r['kind'] === 'aa' && $r['earned'] !== '') {
                $earned = $r['earned'];
                break 2;
            }
        }
    }
    ?>
    <section class="page-head">
        <div class="container athlete-head">
            <span class="athlete-head__avatar"><?php echo has_post_thumbnail() ? get_the_post_thumbnail(null, 'thumbnail', array('alt' => '')) : esc_html(mb_substr(get_the_title(), 0, 1)); ?></span>
            <div>
                <p class="crumbs"><a href="<?php echo esc_url(get_post_type_archive_link('ag_athlete')); ?>">Спортсмены</a></p>
                <h1 class="page-head__title"><?php the_title(); ?></h1>
                <p class="page-head__lead">
                    <?php echo $club_id ? '<a href="' . esc_url(get_permalink($club_id)) . '" style="color:#fff">' . esc_html(get_the_title($club_id)) . '</a>' : esc_html($club); ?>
                    <?php echo $earned !== '' ? ' · выполнен разряд: ' . esc_html($earned) : ''; ?>
                </p>
            </div>
        </div>
    </section>
    <section class="section section--tight">
        <div class="container comp-results">
            <?php if (trim(get_the_content()) !== '') : ?>
                <div class="card"><div class="entry-content"><?php the_content(); ?></div></div>
            <?php endif; ?>
            <?php if ($best) : ?>
                <div class="card">
                    <div class="section-head"><h2 class="section-head__title">Лучшие оценки</h2><?php echo ag_medals_html($medals); ?></div>
                    <div class="best-grid">
                        <?php if (isset($best['AA'])) : ?>
                            <div class="best"><span>Многоборье</span><b><?php echo esc_html(ag_score($best['AA']['total'])); ?></b><small><?php echo esc_html(get_the_title((int) $best['AA']['competition'])); ?></small></div>
                        <?php endif; ?>
                        <?php foreach ($order as $a) :
                            if (!isset($best[$a])) {
                                continue;
                            } ?>
                            <div class="best"><span><?php echo esc_html(ag_apparatus_name($a)); ?></span><b><?php echo esc_html(ag_score($best[$a]['total'])); ?></b><small>D <?php echo esc_html(rtrim(rtrim(ag_score($best[$a]['d']), '0'), ',')); ?> · E <?php echo esc_html(ag_score($best[$a]['e'])); ?></small></div>
                        <?php endforeach; ?>
                    </div>
                </div>
            <?php endif; ?>
            <div class="card">
                <h2 class="card__title">Выступления</h2>
                <?php if (!$history) : ?>
                    <p class="muted">Сохранённых результатов пока нет.</p>
                <?php else : ?>
                    <div class="table-wrap">
                        <table class="rtable">
                            <thead><tr><th>Соревнование</th><th>Многоборье</th>
                                <?php foreach ($order as $a) : ?><th class="num" title="<?php echo esc_attr(ag_apparatus_name($a)); ?>"><?php echo esc_html(ag_apparatus_name($a, true)); ?></th><?php endforeach; ?>
                                <th>Финалы</th></tr></thead>
                            <tbody>
                            <?php foreach ($history as $cid => $rows) :
                                $c = ag_competition($cid);
                                $aa = null;
                                $apps = array();
                                $finals = array();
                                foreach ($rows as $r) {
                                    if ($r['kind'] === 'aa') {
                                        $aa = $r;
                                    } elseif ($r['kind'] === 'app' && $r['stage'] === 'qual') {
                                        $apps[$r['apparatus']] = $r;
                                    } elseif ($r['kind'] === 'app' && $r['stage'] === 'final') {
                                        $finals[] = $r;
                                    }
                                }
                                $category = $aa ? $aa['category'] : ($rows[0]['category'] ?? '');
                                ?>
                                <tr>
                                    <td><a href="<?php echo esc_url(get_permalink($cid) . '#results'); ?>"><?php echo esc_html(get_the_title($cid)); ?></a><small><?php echo esc_html(trim(($c ? ag_date_range($c['start'], $c['end'], true) : '') . ($category !== '' ? ' · ' . $category : ''))); ?></small></td>
                                    <td><?php if ($aa) : ?><?php echo $aa['place'] ? '<span class="place place--' . (int) $aa['place'] . '">' . (int) $aa['place'] . '</span> ' : ''; ?><b><?php echo esc_html(ag_score($aa['total'])); ?></b><?php echo $aa['earned'] !== '' ? '<small>' . esc_html($aa['earned']) . '</small>' : ''; ?><?php else : ?>—<?php endif; ?></td>
                                    <?php foreach ($order as $a) : ?>
                                        <td class="num"><?php echo isset($apps[$a]) ? esc_html(ag_score($apps[$a]['total'])) . ($apps[$a]['place'] ? '<small>' . (int) $apps[$a]['place'] . ' место</small>' : '') : '—'; ?></td>
                                    <?php endforeach; ?>
                                    <td><?php
                                    if (!$finals) {
                                        echo '—';
                                    }
                                    foreach ($finals as $f) {
                                        echo '<div>' . ($f['place'] ? '<span class="place place--' . (int) $f['place'] . '">' . (int) $f['place'] . '</span> ' : '') . esc_html(ag_apparatus_name($f['apparatus'])) . ' <small>' . esc_html(ag_score($f['total'])) . '</small></div>';
                                    }
                                    ?></td>
                                </tr>
                            <?php endforeach; ?>
                            </tbody>
                        </table>
                    </div>
                <?php endif; ?>
            </div>
        </div>
    </section>
<?php endwhile;
get_footer();
