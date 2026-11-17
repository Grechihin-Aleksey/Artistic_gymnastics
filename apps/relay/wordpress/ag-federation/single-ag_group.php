<?php
/** Страница учебной группы: расписание, тренер, состав, контакты клуба и его объявления. */
if (!defined('ABSPATH')) {
    exit;
}
get_header();
while (have_posts()) :
    the_post();
    $g = ag_group(get_post());
    $club = $g['club'];
    $phone = $club ? (string) get_post_meta($club, '_ag_phone', true) : '';
    $address = $club ? trim((string) get_post_meta($club, '_ag_city', true) . ', ' . (string) get_post_meta($club, '_ag_address', true), ', ') : '';
    $notices = ag_notices(3, $club);
    $line = ag_group_meta_line($g);
    ?>
    <section class="page-head">
        <div class="container">
            <p class="crumbs"><a href="<?php echo esc_url(ag_groups_url()); ?>">Группы</a><?php if ($club) : ?> / <a href="<?php echo esc_url(get_permalink($club)); ?>"><?php echo esc_html(get_the_title($club)); ?></a><?php endif; ?></p>
            <h1 class="page-head__title"><?php the_title(); ?></h1>
            <?php if ($line !== '' || $g['recruit']) : ?>
                <ul class="comp-head__meta group-head__meta">
                    <?php if ($line !== '') : ?><li><?php echo esc_html($line); ?></li><?php endif; ?>
                    <?php if ($g['recruit']) : ?><li><span class="chip chip--done">Идёт набор</span></li><?php endif; ?>
                </ul>
            <?php endif; ?>
        </div>
    </section>
    <section class="section section--tight">
        <div class="container comp-layout">
            <div class="comp-layout__main">
                <div class="card">
                    <h2 class="card__title">Расписание занятий</h2>
                    <?php if ($g['schedule']) : ?>
                        <dl class="program">
                            <?php foreach ($g['schedule'] as $r) :
                                $place = $r['place'] !== '' ? $r['place'] : $g['place']; ?>
                                <div class="program__row<?php echo (int) $r['day'] === ag_weekday_today() ? ' program__row--today' : ''; ?>">
                                    <dt><?php echo esc_html(AG_DAYS[$r['day']]); ?></dt>
                                    <dd><b><?php echo esc_html($r['from'] . ($r['to'] !== '' ? '–' . $r['to'] : '')); ?></b><?php echo $place !== '' ? ' · ' . esc_html($place) : ''; ?></dd>
                                </div>
                            <?php endforeach; ?>
                        </dl>
                        <?php if ($g['period'] !== '') : ?><p class="muted small">Расписание действует <?php echo esc_html($g['period']); ?>.</p><?php endif; ?>
                    <?php else : ?>
                        <p class="muted">Расписание уточняйте у тренера.</p>
                    <?php endif; ?>
                </div>
                <?php if (trim(get_the_content()) !== '') : ?>
                    <div class="card"><div class="entry-content"><?php the_content(); ?></div></div>
                <?php endif; ?>
                <?php if ($g['roster']) : ?>
                    <div class="card">
                        <h2 class="card__title">Состав группы <span class="muted card__count"><?php echo (int) count($g['roster']); ?></span></h2>
                        <ol class="roster">
                            <?php foreach ($g['roster'] as $name) : ?><li><?php echo esc_html($name); ?></li><?php endforeach; ?>
                        </ol>
                    </div>
                <?php endif; ?>
                <?php ag_group_normatives_section(get_the_ID()); ?>
            </div>
            <aside class="comp-layout__side">
                <div class="card contacts">
                    <h2 class="card__title card__title--small">Контакты</h2>
                    <?php if ($g['coach'] !== '') : ?><p><?php echo ag_icon('user', 18); ?> <span>Тренер: <?php echo esc_html($g['coach']); ?></span></p><?php endif; ?>
                    <?php if ($g['place'] !== '') : ?><p><?php echo ag_icon('pin', 18); ?> <a href="<?php echo esc_url('https://yandex.ru/maps/?text=' . rawurlencode($g['place'])); ?>" target="_blank" rel="noopener"><?php echo esc_html($g['place']); ?></a></p>
                    <?php elseif ($address !== '') : ?><p><?php echo ag_icon('pin', 18); ?> <a href="<?php echo esc_url('https://yandex.ru/maps/?text=' . rawurlencode($address)); ?>" target="_blank" rel="noopener"><?php echo esc_html($address); ?></a></p><?php endif; ?>
                    <?php if ($phone !== '') : ?><p><?php echo ag_icon('phone', 18); ?> <a href="tel:<?php echo esc_attr(preg_replace('/[^0-9+]/', '', $phone)); ?>"><?php echo esc_html($phone); ?></a></p><?php endif; ?>
                    <?php if ($club) : ?><a class="btn btn--outline btn--block" href="<?php echo esc_url(get_permalink($club)); ?>">Страница клуба</a><?php endif; ?>
                </div>
                <?php if ($g['recruit']) {
                    ag_signup_form($g);
                } ?>
                <?php if ($notices) : ?>
                    <div class="card">
                        <h2 class="card__title card__title--small">Объявления</h2>
                        <div class="notice-list notice-list--side"><?php foreach ($notices as $n) {
                            ag_notice_card($n, true);
                        } ?></div>
                    </div>
                <?php endif; ?>
            </aside>
        </div>
    </section>
<?php endwhile;
get_footer();
