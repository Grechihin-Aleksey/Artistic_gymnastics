<?php
/**
 * Страница соревнования: три вкладки — «До старта · заявки», «Табло онлайн», «Итоги и протоколы».
 * Открытая вкладка выбирается по стадии турнира. Без скрипта все три идут друг за другом.
 */
if (!defined('ABSPATH')) {
    exit;
}
get_header();

while (have_posts()) :
    the_post();
    $c = ag_competition(get_post());
    $stage = ag_stage($c);
    $entry = ag_entry_info($c);
    $program = ag_program_rows($c['program']);
    $docs = ag_attachment_files($c['docs']);
    $files = ag_competition_protocols($c);
    $podiums = $stage === 'before' ? array() : ag_competition_podiums($c);
    $news = get_posts(array('post_type' => 'post', 'posts_per_page' => 6, 'meta_key' => '_ag_competition', 'meta_value' => get_the_ID()));
    $tabs = array('info' => 'До старта · заявки');
    if ($c['ids']) {
        $tabs['live'] = 'Табло онлайн';
    }
    $tabs['results'] = 'Итоги и протоколы';
    $active = $stage === 'live' && $c['ids'] ? 'live' : ($stage === 'done' ? 'results' : 'info');
    $place = implode(', ', array_filter(array($c['venue'], $c['city'])));
    ?>
    <section class="comp-head">
        <div class="container">
            <p class="crumbs"><a href="<?php echo esc_url(get_post_type_archive_link('ag_competition')); ?>">Календарь</a> / <?php echo esc_html(ag_date_range($c['start'], $c['end'], true)); ?></p>
            <?php if ($stage === 'live') : ?><p class="eyebrow"><?php echo ag_live_dot(); ?> Идёт сейчас</p><?php endif; ?>
            <h1 class="comp-head__title"><?php the_title(); ?></h1>
            <ul class="comp-head__meta">
                <li><b><?php echo esc_html(ag_date_range($c['start'], $c['end'], true)); ?></b></li>
                <?php if ($place !== '') : ?><li><?php echo esc_html($place); ?></li><?php endif; ?>
                <?php if (ag_gender_label($c['gender']) !== '') : ?><li><?php echo esc_html(ag_gender_label($c['gender'])); ?></li><?php endif; ?>
                <?php if ($c['levels'] !== '') : ?><li><?php echo esc_html($c['levels']); ?></li><?php endif; ?>
                <?php if ($stage === 'before' && $c['start'] !== '') : ?><li><a class="comp-head__ics" href="<?php echo esc_url(add_query_arg('ics', '1', get_permalink())); ?>"><?php echo ag_icon('calendar', 16); ?> В календарь</a></li><?php endif; ?>
            </ul>
            <div class="comp-tabs" role="tablist" data-ag-tabs data-active="<?php echo esc_attr($active); ?>">
                <?php foreach ($tabs as $id => $label) : ?>
                    <a class="comp-tabs__tab<?php echo $id === $active ? ' is-active' : ''; ?>" role="tab" href="#<?php echo esc_attr($id); ?>" aria-controls="<?php echo esc_attr($id); ?>" aria-selected="<?php echo $id === $active ? 'true' : 'false'; ?>"><?php echo esc_html($label); ?></a>
                <?php endforeach; ?>
            </div>
        </div>
    </section>

    <section class="comp-panel" id="info" role="tabpanel" data-ag-panel>
        <div class="container comp-layout">
            <div class="comp-layout__main">
                <?php if (trim(get_the_content()) !== '') : ?>
                    <div class="card">
                        <h2 class="card__title">О соревновании</h2>
                        <div class="entry-content"><?php the_content(); ?></div>
                    </div>
                <?php endif; ?>
                <?php if ($program) : ?>
                    <div class="card">
                        <h2 class="card__title">Программа</h2>
                        <dl class="program">
                            <?php foreach ($program as $row) : ?>
                                <div class="program__row"><dt><?php echo esc_html($row[0]); ?></dt><dd><?php echo esc_html($row[1]); ?></dd></div>
                            <?php endforeach; ?>
                        </dl>
                    </div>
                <?php endif; ?>
                <?php if ($stage === 'before') : ?>
                    <div class="card">
                        <h2 class="card__title">Стартовые протоколы</h2>
                        <?php if ($files) {
                            ag_file_list($files);
                        } else {
                            echo '<p class="muted">Появятся здесь сами после жеребьёвки, когда секретариат выложит их на сайт.</p>';
                        } ?>
                    </div>
                <?php endif; ?>
            </div>
            <aside class="comp-layout__side">
                <?php if ($entry) : ?>
                    <div class="card entry-card<?php echo $entry['open'] ? ' entry-card--open' : ''; ?>">
                        <?php if ($entry['open']) : ?>
                            <p class="entry-card__label">Приём заявок открыт</p>
                            <?php if ($entry['deadline'] !== '') : ?>
                                <p>до <b><?php echo esc_html(ag_date_range($entry['deadline'], $entry['deadline'], false)); ?></b><?php
                                $left = ag_days_until($entry['deadline']);
                                echo $left !== '' && $left !== 'сегодня' ? ', осталось ' . esc_html(preg_replace('/^через /u', '', $left)) : ($left === 'сегодня' ? ', последний день' : '');
                                ?></p>
                            <?php endif; ?>
                            <a class="btn btn--accent btn--block" href="<?php echo esc_url($entry['url']); ?>" target="_blank" rel="noopener">Подать заявку клуба</a>
                            <p class="muted small">Форма из программы соревнований. Статус заявки будет виден по той же ссылке.</p>
                        <?php else : ?>
                            <p class="entry-card__label entry-card__label--closed">Приём заявок закрыт</p>
                            <a class="btn btn--outline btn--block" href="<?php echo esc_url($entry['url']); ?>" target="_blank" rel="noopener">Проверить статус заявки</a>
                        <?php endif; ?>
                    </div>
                <?php endif; ?>
                <?php if ($docs) : ?>
                    <div class="card">
                        <h2 class="card__title card__title--small">Документы</h2>
                        <?php ag_file_list($docs); ?>
                    </div>
                <?php endif; ?>
                <?php if ($place !== '') : ?>
                    <a class="card place-card" href="<?php echo esc_url('https://yandex.ru/maps/?text=' . rawurlencode($place)); ?>" target="_blank" rel="noopener">
                        <?php echo ag_icon('pin', 22); ?><span><b><?php echo esc_html($c['venue'] !== '' ? $c['venue'] : $c['city']); ?></b><small>Открыть на карте</small></span>
                    </a>
                <?php endif; ?>
            </aside>
        </div>
    </section>

    <?php if ($c['ids']) : ?>
        <section class="comp-panel comp-panel--dark" id="live" role="tabpanel" data-ag-panel>
            <div class="container">
                <div class="section-head section-head--dark">
                    <h2 class="section-head__title"><?php echo $stage === 'live' ? 'Табло онлайн' : ($stage === 'done' ? 'Итоговое табло' : 'Табло'); ?></h2>
                </div>
                <?php if ($stage === 'before') : ?>
                    <p class="board-note">Табло оживёт в день старта: оценки будут появляться здесь сразу после судей.</p>
                <?php endif; ?>
                <?php ag_board($c['ids'], $c['board_theme']); ?>
            </div>
        </section>
    <?php endif; ?>

    <section class="comp-panel" id="results" role="tabpanel" data-ag-panel>
        <div class="container comp-results">
            <?php if ($podiums) : ?>
                <div class="grid grid--3">
                    <?php foreach ($podiums as $pod) {
                        ag_podium_card($pod);
                    } ?>
                </div>
            <?php endif; ?>
            <div class="card">
                <h2 class="card__title">Протоколы</h2>
                <?php if ($files) {
                    ag_file_list($files);
                    echo '<p class="muted small">Протоколы выкладывает секретариат прямо из программы соревнований.</p>';
                } else {
                    echo '<p class="muted">' . ($stage === 'done' ? 'Протоколы ещё не выложены.' : 'Появятся после окончания соревнований.') . '</p>';
                } ?>
            </div>
            <?php ag_gallery(get_the_ID()); ?>
            <?php if (function_exists('ag_archive_competition_table')) {
                ag_archive_competition_table(get_the_ID());
            } ?>
            <?php if ($news) : ?>
                <div>
                    <?php ag_section_head('Новости турнира'); ?>
                    <div class="grid grid--3">
                        <?php foreach ($news as $n) {
                            ag_news_card($n);
                        } ?>
                    </div>
                </div>
            <?php endif; ?>
        </div>
    </section>
<?php endwhile;

get_footer();
