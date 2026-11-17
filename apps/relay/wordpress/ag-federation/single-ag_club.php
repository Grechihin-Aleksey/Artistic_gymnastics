<?php
if (!defined('ABSPATH')) {
    exit;
}
get_header();
while (have_posts()) :
    the_post();
    $id = get_the_ID();
    $city = (string) get_post_meta($id, '_ag_city', true);
    $address = (string) get_post_meta($id, '_ag_address', true);
    $phone = (string) get_post_meta($id, '_ag_phone', true);
    $site = (string) get_post_meta($id, '_ag_site', true);
    $coaches = array_filter(array_map('trim', preg_split('/\r?\n/', (string) get_post_meta($id, '_ag_coaches', true))));
    ?>
    <section class="page-head">
        <div class="container club-head">
            <?php if (has_post_thumbnail()) : ?><span class="club-head__logo"><?php the_post_thumbnail('thumbnail', array('alt' => '')); ?></span><?php endif; ?>
            <div>
                <p class="crumbs"><a href="<?php echo esc_url(get_post_type_archive_link('ag_club')); ?>">Клубы</a><?php echo $city !== '' ? ' / ' . esc_html($city) : ''; ?></p>
                <h1 class="page-head__title"><?php the_title(); ?></h1>
            </div>
        </div>
    </section>
    <section class="section section--tight">
        <div class="container comp-layout">
            <div class="comp-layout__main">
                <?php if (trim(get_the_content()) !== '') : ?>
                    <div class="card"><div class="entry-content"><?php the_content(); ?></div></div>
                <?php endif; ?>
                <?php ag_club_groups_section($id); ?>
                <?php if (function_exists('ag_archive_club_section')) {
                    ag_archive_club_section($id);
                } ?>
            </div>
            <aside class="comp-layout__side">
                <div class="card contacts">
                    <h2 class="card__title card__title--small">Контакты</h2>
                    <?php if ($address !== '' || $city !== '') : ?>
                        <p><?php echo ag_icon('pin', 18); ?> <a href="<?php echo esc_url('https://yandex.ru/maps/?text=' . rawurlencode(trim($city . ', ' . $address, ', '))); ?>" target="_blank" rel="noopener"><?php echo esc_html(trim($city . ', ' . $address, ', ')); ?></a></p>
                    <?php endif; ?>
                    <?php if ($phone !== '') : ?><p><?php echo ag_icon('phone', 18); ?> <a href="tel:<?php echo esc_attr(preg_replace('/[^0-9+]/', '', $phone)); ?>"><?php echo esc_html($phone); ?></a></p><?php endif; ?>
                    <?php if ($site !== '') : ?><p><?php echo ag_icon('link', 18); ?> <a href="<?php echo esc_url($site); ?>" target="_blank" rel="noopener"><?php echo esc_html(preg_replace('#^https?://(www\.)?#', '', untrailingslashit($site))); ?></a></p><?php endif; ?>
                </div>
                <?php if ($coaches) : ?>
                    <div class="card">
                        <h2 class="card__title card__title--small">Тренеры</h2>
                        <ul class="coach-list">
                            <?php foreach ($coaches as $coach) : ?><li><?php echo ag_icon('user', 18); ?> <?php echo esc_html($coach); ?></li><?php endforeach; ?>
                        </ul>
                    </div>
                <?php endif; ?>
                <?php $club_notices = ag_notices(3, $id);
                if ($club_notices) : ?>
                    <div class="card">
                        <h2 class="card__title card__title--small">Объявления</h2>
                        <div class="notice-list notice-list--side"><?php foreach ($club_notices as $n) {
                            ag_notice_card($n, true);
                        } ?></div>
                    </div>
                <?php endif; ?>
            </aside>
        </div>
    </section>
<?php endwhile;
get_footer();
