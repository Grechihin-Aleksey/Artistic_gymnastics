<?php
/** Ведомость сдачи нормативов: итог и таблица; страница печатается или сохраняется в PDF. */
if (!defined('ABSPATH')) {
    exit;
}
get_header();
while (have_posts()) :
    the_post();
    $t = ag_norm_test(get_the_ID());
    $g = $t['group'] ? ag_group($t['group']) : null;
    $s = ag_norm_summary($t);
    $club = $t['club'] && get_post_status($t['club']) === 'publish' ? $t['club'] : 0;
    ?>
    <section class="page-head norm-head">
        <div class="container">
            <p class="crumbs"><a href="<?php echo esc_url(get_post_type_archive_link('ag_norm_test')); ?>">Сдача нормативов</a><?php if ($club) : ?> / <a href="<?php echo esc_url(get_permalink($club)); ?>"><?php echo esc_html(get_the_title($club)); ?></a><?php endif; ?></p>
            <p class="norm-print-only norm-print-title">Ведомость сдачи нормативов</p>
            <h1 class="page-head__title"><?php echo esc_html($t['group'] ? get_the_title($t['group']) : get_the_title()); ?></h1>
            <ul class="comp-head__meta">
                <li><?php echo esc_html(ag_date_range($t['date'], '', true)); ?></li>
                <li><?php echo esc_html(ag_gender_short($t['gender'])); ?></li>
                <?php if ($club) : ?><li><?php echo esc_html(get_the_title($club)); ?></li><?php endif; ?>
                <?php if ($g && $g['coach'] !== '') : ?><li>Тренер: <?php echo esc_html($g['coach']); ?></li><?php endif; ?>
            </ul>
        </div>
    </section>
    <section class="section section--tight">
        <div class="container">
            <div class="card">
                <div class="norm-sum">
                    <div class="norm-sum__big"><b><?php echo (int) $s[0]; ?></b> из <?php echo (int) $s[3]; ?><span>сдали нормативы</span></div>
                    <div class="norm-sum__text">
                        <p><b>Нормативы:</b> <?php echo esc_html(get_the_title($t['set'])); ?>.<br>
                        Для зачёта нужно выполнить <?php echo (int) $t['need']; ?> из <?php echo (int) count($t['items']); ?> упражнений.</p>
                        <p class="muted">Не сдали: <?php echo (int) $s[1]; ?><?php echo $s[2] ? ' · нет результатов: ' . (int) $s[2] : ''; ?></p>
                    </div>
                    <div class="norm-sum__actions norm-no-print">
                        <button type="button" class="btn btn--outline" onclick="window.print()">Распечатать или сохранить PDF</button>
                    </div>
                </div>
                <?php if ($t['public']) : ?>
                    <?php ag_norm_table($t); ?>
                <?php else : ?>
                    <p class="muted">Поимённые результаты клуб не публикует. Узнать свой результат можно у тренера.</p>
                <?php endif; ?>
                <div class="norm-sign norm-print-only">
                    <p>Тренер ______________________ <?php echo $g ? esc_html($g['coach']) : ''; ?></p>
                    <p>Принял ______________________</p>
                </div>
            </div>
            <?php if ($g) : ?>
                <p class="norm-no-print norm-back"><a class="btn btn--outline" href="<?php echo esc_url(get_permalink($t['group'])); ?>">Страница группы</a></p>
            <?php endif; ?>
        </div>
    </section>
    <?php
endwhile;
get_footer();
