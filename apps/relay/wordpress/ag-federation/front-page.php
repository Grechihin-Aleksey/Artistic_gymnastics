<?php
/**
 * Главная. Во время турнира первый экран — «Идёт сейчас» с живой карточкой и табло,
 * в остальное время — заголовок федерации и ближайший старт.
 */
if (!defined('ABSPATH')) {
    exit;
}
get_header();

$live = ag_live_competition();
$upcoming = ag_competitions_query('upcoming', array('per_page' => 6));
$next = null;
foreach ($upcoming->posts as $p) {
    $c = ag_competition($p);
    if (ag_stage($c) === 'before') {
        $next = $c;
        break;
    }
}
?>

<?php if ($live) : ?>
    <section class="hero hero--live">
        <div class="container hero__grid">
            <div class="hero__text">
                <p class="eyebrow"><?php echo ag_live_dot(); ?> Идёт сейчас<?php
                $days = (int) round((strtotime($live['end']) - strtotime($live['start'])) / DAY_IN_SECONDS) + 1;
                if ($days > 1) {
                    $n = (int) round((strtotime(ag_today()) - strtotime($live['start'])) / DAY_IN_SECONDS) + 1;
                    echo esc_html(' · день ' . max(1, min($days, $n)) . ' из ' . $days);
                }
                ?></p>
                <h1 class="hero__title"><?php echo esc_html(get_the_title($live['post'])); ?></h1>
                <p class="hero__lead"><?php echo esc_html(implode(', ', array_filter(array($live['venue'], $live['city'])))); ?><?php echo $live['venue'] !== '' || $live['city'] !== '' ? '. ' : ''; ?>Оценки приходят прямо с судейских планшетов, табло обновляется само.</p>
                <div class="hero__actions">
                    <a class="btn btn--accent btn--large" href="#tablo">Открыть табло</a>
                    <a class="btn btn--ghost btn--large" href="<?php echo esc_url(get_permalink($live['post'])); ?>">Страница турнира и протоколы</a>
                </div>
            </div>
            <?php if ($live['ids']) {
                ag_live_card($live);
            } ?>
        </div>
    </section>
    <?php if ($live['ids']) : ?>
        <section class="tablo" id="tablo">
            <div class="container">
                <div class="section-head section-head--dark">
                    <h2 class="section-head__title">Табло онлайн</h2>
                </div>
                <?php ag_board($live['ids'], 'dark'); ?>
            </div>
        </section>
    <?php endif; ?>
<?php else : ?>
    <section class="hero">
        <div class="container">
            <h1 class="hero__title hero__title--wide"><?php echo esc_html(ag_mod('ag_hero_title')); ?></h1>
            <p class="hero__lead"><?php echo esc_html(ag_mod('ag_hero_text')); ?></p>
            <?php if ($next) :
                $entry = ag_entry_info($next); ?>
                <div class="next-start">
                    <span class="next-start__label">Следующий старт</span>
                    <a class="next-start__name" href="<?php echo esc_url(get_permalink($next['post'])); ?>"><?php echo esc_html(get_the_title($next['post']) . ' · ' . ag_date_range($next['start'], $next['end'])); ?></a>
                    <span class="next-start__when"><?php echo esc_html(ag_days_until($next['start'])); ?></span>
                    <?php if ($entry && $entry['open']) : ?>
                        <a class="btn btn--accent" href="<?php echo esc_url($entry['url']); ?>" target="_blank" rel="noopener">Подать заявку</a>
                    <?php endif; ?>
                </div>
            <?php else : ?>
                <div class="hero__actions"><a class="btn btn--accent btn--large" href="<?php echo esc_url(get_post_type_archive_link('ag_competition')); ?>">Календарь соревнований</a></div>
            <?php endif; ?>
        </div>
    </section>
<?php endif; ?>

<?php
$recent = ag_competitions_query('past', array('per_page' => 1));
if ($upcoming->have_posts() || $recent->have_posts()) : ?>
    <section class="section">
        <div class="container">
            <div class="section-head">
                <h2 class="section-head__title">Календарь соревнований</h2>
                <a class="section-head__link" href="<?php echo esc_url(get_post_type_archive_link('ag_competition')); ?>">Весь календарь <?php echo ag_icon('arrow', 16); ?></a>
            </div>
            <div class="cal">
                <?php
                foreach (array_slice($upcoming->posts, 0, 4) as $p) {
                    ag_competition_row(ag_competition($p));
                }
                foreach ($recent->posts as $p) {
                    ag_competition_row(ag_competition($p));
                }
                ?>
            </div>
        </div>
    </section>
<?php endif; ?>

<?php
// Последние результаты: призёры двух последних завершённых турниров.
$done = ag_competitions_query('past', array('per_page' => 3));
$cards = array();
foreach ($done->posts as $p) {
    $c = ag_competition($p);
    if (!$c['ids'] && !(function_exists('ag_archive_has_results') && ag_archive_has_results($p->ID))) {
        continue;
    }
    $podiums = ag_competition_podiums($c);
    $files = ag_competition_protocols($c);
    foreach (array_slice($podiums, 0, 2) as $pod) {
        $cards[] = array($pod, ag_date_range($c['start'], $c['end']) . ' · ' . get_the_title($p), $files, get_permalink($p) . '#results');
        $files = array();
    }
    if (count($cards) >= 2) {
        break;
    }
}
if ($cards) : ?>
    <section class="section section--tight">
        <div class="container">
            <?php ag_section_head('Последние результаты', ag_results_url(), 'Архив результатов'); ?>
            <div class="grid grid--3">
                <?php foreach (array_slice($cards, 0, 2) as $card) {
                    ag_podium_card($card[0], $card[1], $card[2], $card[3]);
                } ?>
                <div class="card card--brand cta">
                    <p class="eyebrow eyebrow--light">Для тренеров</p>
                    <h3 class="cta__title">Подача заявки онлайн: без писем и таблиц</h3>
                    <p>Заполните состав клуба на сайте. Секретариат примет заявку в программу одной кнопкой, статус будет виден по той же ссылке.</p>
                    <a class="btn btn--accent" href="<?php echo esc_url(add_query_arg('entries', '1', get_post_type_archive_link('ag_competition'))); ?>">Открытые приёмы заявок</a>
                </div>
            </div>
        </div>
    </section>
<?php endif; ?>

<?php
$news = new WP_Query(array('post_type' => 'post', 'posts_per_page' => 3, 'ignore_sticky_posts' => false, 'no_found_rows' => true));
if ($news->have_posts()) : ?>
    <section class="section section--tight">
        <div class="container">
            <?php ag_section_head('Новости', ag_news_url(), 'Все новости'); ?>
            <div class="grid grid--3">
                <?php while ($news->have_posts()) {
                    $news->the_post();
                    ag_news_card();
                }
                wp_reset_postdata(); ?>
            </div>
        </div>
    </section>
<?php endif; ?>

<?php
$clubs = get_posts(array('post_type' => 'ag_club', 'posts_per_page' => 6, 'orderby' => array('menu_order' => 'ASC', 'title' => 'ASC')));
$docs = get_posts(array('post_type' => 'ag_document', 'posts_per_page' => 5));
if ($clubs || $docs) : ?>
    <section class="section section--tight">
        <div class="container grid grid--2">
            <?php if ($clubs) : ?>
                <div class="card">
                    <?php ag_section_head('Клубы и школы', get_post_type_archive_link('ag_club'), 'Все клубы', 'h2'); ?>
                    <div class="club-grid">
                        <?php foreach ($clubs as $club) {
                            ag_club_card($club);
                        } ?>
                    </div>
                </div>
            <?php endif; ?>
            <?php if ($docs) : ?>
                <div class="card">
                    <?php ag_section_head('Документы', get_post_type_archive_link('ag_document'), 'Все документы', 'h2'); ?>
                    <?php ag_file_list(array_map('ag_document_file', $docs)); ?>
                </div>
            <?php endif; ?>
        </div>
    </section>
<?php endif; ?>

<section class="about">
    <div class="container about__grid">
        <div class="about__text">
            <h2>О федерации</h2>
            <p><?php echo esc_html(ag_mod('ag_about_text')); ?></p>
            <div class="about__links">
                <?php if ((int) ag_mod('ag_about_page')) : ?><a class="btn btn--outline" href="<?php echo esc_url(get_permalink((int) ag_mod('ag_about_page'))); ?>">Руководство и контакты</a><?php endif; ?>
                <?php if ((int) ag_mod('ag_judges_page')) : ?><a class="btn btn--outline btn--muted" href="<?php echo esc_url(get_permalink((int) ag_mod('ag_judges_page'))); ?>">Судейская коллегия</a><?php endif; ?>
            </div>
        </div>
        <div class="stats">
            <?php foreach (array(1, 2, 3, 4) as $i) :
                if (ag_mod("ag_stat{$i}_value") === '') {
                    continue;
                } ?>
                <div class="stat"><b><?php echo esc_html(ag_mod("ag_stat{$i}_value")); ?></b><span><?php echo esc_html(ag_mod("ag_stat{$i}_label")); ?></span></div>
            <?php endforeach; ?>
        </div>
    </div>
</section>

<?php
get_footer();
