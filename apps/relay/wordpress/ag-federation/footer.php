<?php
if (!defined('ABSPATH')) {
    exit;
}
$live = ag_live_competition();
$address = ag_mod('ag_address');
$phone = ag_mod('ag_phone');
$email = ag_mod('ag_email');
?>
</main>
<footer class="site-footer">
    <div class="container site-footer__grid">
        <div class="site-footer__org">
            <b class="site-footer__name"><?php echo esc_html(ag_mod('ag_org_name')); ?></b>
            <?php if ($address !== '') : ?><p><?php echo ag_icon('pin', 16); ?> <?php echo esc_html($address); ?></p><?php endif; ?>
            <?php if ($phone !== '') : ?><p><?php echo ag_icon('phone', 16); ?> <a href="tel:<?php echo esc_attr(preg_replace('/[^0-9+]/', '', $phone)); ?>"><?php echo esc_html($phone); ?></a></p><?php endif; ?>
            <?php if ($email !== '') : ?><p><?php echo ag_icon('mail', 16); ?> <a href="mailto:<?php echo esc_attr($email); ?>"><?php echo esc_html($email); ?></a></p><?php endif; ?>
        </div>
        <div>
            <b class="site-footer__title">Соревнования</b>
            <ul>
                <li><a href="<?php echo esc_url(get_post_type_archive_link('ag_competition')); ?>">Календарь</a></li>
                <li><a href="<?php echo esc_url(ag_live_url()); ?>">Табло онлайн</a></li>
                <li><a href="<?php echo esc_url(ag_results_url()); ?>">Результаты и протоколы</a></li>
                <li><a href="<?php echo esc_url(add_query_arg('entries', '1', get_post_type_archive_link('ag_competition'))); ?>">Подать заявку</a></li>
                <?php if (post_type_exists('ag_athlete')) : ?><li><a href="<?php echo esc_url(get_post_type_archive_link('ag_athlete')); ?>">Спортсмены</a></li><?php endif; ?>
                <li><a href="<?php echo esc_url(ag_rating_url()); ?>">Рейтинг сезона</a></li>
                <li><a href="<?php echo esc_url(ag_ical_url(true)); ?>">Календарь в телефон</a></li>
            </ul>
        </div>
        <div>
            <b class="site-footer__title">Федерация</b>
            <?php
            if (has_nav_menu('footer')) {
                wp_nav_menu(array('theme_location' => 'footer', 'container' => false, 'depth' => 1));
            } else {
                echo '<ul>';
                echo '<li><a href="' . esc_url(ag_news_url()) . '">Новости</a></li>';
                echo '<li><a href="' . esc_url(get_post_type_archive_link('ag_club')) . '">Клубы</a></li>';
                if (ag_has_groups()) {
                    echo '<li><a href="' . esc_url(ag_groups_url(true)) . '">Расписание занятий</a></li>';
                }
                if (ag_has_notices()) {
                    echo '<li><a href="' . esc_url(get_post_type_archive_link('ag_notice')) . '">Объявления</a></li>';
                }
                echo '<li><a href="' . esc_url(get_post_type_archive_link('ag_document')) . '">Документы</a></li>';
                $about = (int) ag_mod('ag_about_page');
                if ($about) {
                    echo '<li><a href="' . esc_url(get_permalink($about)) . '">О федерации</a></li>';
                }
                echo '</ul>';
            }
            ?>
        </div>
        <?php if (ag_mod('ag_vk') !== '' || ag_mod('ag_telegram') !== '') : ?>
            <div>
                <b class="site-footer__title">Мы в соцсетях</b>
                <ul>
                    <?php if (ag_mod('ag_vk') !== '') : ?><li><a href="<?php echo esc_url(ag_mod('ag_vk')); ?>" rel="noopener" target="_blank">ВКонтакте</a></li><?php endif; ?>
                    <?php if (ag_mod('ag_telegram') !== '') : ?><li><a href="<?php echo esc_url(ag_mod('ag_telegram')); ?>" rel="noopener" target="_blank">Telegram</a></li><?php endif; ?>
                </ul>
            </div>
        <?php endif; ?>
    </div>
    <div class="container site-footer__copy">© <?php echo esc_html(wp_date('Y')); ?> <?php echo esc_html(ag_mod('ag_org_name')); ?></div>
</footer>

<nav class="tabbar" aria-label="Быстрые разделы">
    <a class="tabbar__item<?php echo $live ? ' is-live' : ''; ?>" href="<?php echo esc_url(ag_live_url()); ?>"><?php echo $live ? ag_live_dot() : ag_icon('cup', 20); ?><span>Табло</span></a>
    <a class="tabbar__item" href="<?php echo esc_url(get_post_type_archive_link('ag_competition')); ?>"><?php echo ag_icon('calendar', 20); ?><span>Календарь</span></a>
    <a class="tabbar__item" href="<?php echo esc_url(ag_results_url()); ?>"><?php echo ag_icon('cup', 20); ?><span>Результаты</span></a>
    <a class="tabbar__item" href="<?php echo esc_url(ag_news_url()); ?>"><?php echo ag_icon('news', 20); ?><span>Новости</span></a>
</nav>
<?php wp_footer(); ?>
</body>
</html>
