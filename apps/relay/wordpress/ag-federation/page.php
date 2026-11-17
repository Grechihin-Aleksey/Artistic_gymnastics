<?php
if (!defined('ABSPATH')) {
    exit;
}
get_header();
while (have_posts()) :
    the_post(); ?>
    <section class="page-head">
        <div class="container"><h1 class="page-head__title"><?php the_title(); ?></h1></div>
    </section>
    <div class="section section--tight">
        <div class="container container--text entry-content">
            <?php the_content(); ?>
            <?php wp_link_pages(); ?>
        </div>
    </div>
<?php endwhile;
get_footer();
