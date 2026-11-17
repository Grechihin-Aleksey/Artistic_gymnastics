<?php
if (!defined('ABSPATH')) {
    exit;
}
get_header();
$by_city = array();
while (have_posts()) {
    the_post();
    $city = (string) get_post_meta(get_the_ID(), '_ag_city', true);
    $by_city[$city !== '' ? $city : 'Другие'][] = get_post();
}
?>
<section class="page-head">
    <div class="container">
        <h1 class="page-head__title">Клубы и спортивные школы</h1>
        <p class="page-head__lead">Где заниматься спортивной гимнастикой в области: адреса, тренеры, результаты.</p>
    </div>
</section>
<section class="section section--tight">
    <div class="container">
        <?php if (!$by_city) : ?>
            <div class="empty"><p>Клубы пока не добавлены.</p></div>
        <?php endif; ?>
        <?php foreach ($by_city as $city => $clubs) : ?>
            <h2 class="cal__month"><?php echo esc_html($city); ?></h2>
            <div class="club-grid club-grid--wide">
                <?php foreach ($clubs as $club) {
                    ag_club_card($club);
                } ?>
            </div>
        <?php endforeach; ?>
    </div>
</section>
<?php
get_footer();
