<?php
/**
 * Документы по разделам (рубрики «Разделы документов»). Работает и для страницы одного раздела.
 */
if (!defined('ABSPATH')) {
    exit;
}
get_header();
$groups = array();
while (have_posts()) {
    the_post();
    $terms = get_the_terms(get_the_ID(), 'ag_doc_group');
    $name = $terms && !is_wp_error($terms) ? $terms[0]->name : 'Прочие документы';
    $groups[$name][] = ag_document_file(get_post());
}
$all = get_terms(array('taxonomy' => 'ag_doc_group', 'hide_empty' => true));
?>
<section class="page-head">
    <div class="container">
        <h1 class="page-head__title"><?php echo is_tax() ? esc_html(single_term_title('', false)) : 'Документы'; ?></h1>
        <p class="page-head__lead">Положения, календарный план, разрядные требования и правила.</p>
        <?php if ($all && !is_wp_error($all) && count($all) > 1) : ?>
            <div class="pills pills--head">
                <a class="pill<?php echo is_tax() ? '' : ' is-active'; ?>" href="<?php echo esc_url(get_post_type_archive_link('ag_document')); ?>">Все</a>
                <?php foreach ($all as $t) : ?>
                    <a class="pill<?php echo is_tax('ag_doc_group', $t->term_id) ? ' is-active' : ''; ?>" href="<?php echo esc_url(get_term_link($t)); ?>"><?php echo esc_html($t->name); ?></a>
                <?php endforeach; ?>
            </div>
        <?php endif; ?>
    </div>
</section>
<section class="section section--tight">
    <div class="container container--text">
        <?php if (!$groups) : ?><div class="empty"><p>Документы пока не добавлены.</p></div><?php endif; ?>
        <?php foreach ($groups as $name => $files) : ?>
            <div class="card doc-group">
                <h2 class="card__title"><?php echo esc_html($name); ?></h2>
                <?php ag_file_list($files); ?>
            </div>
        <?php endforeach; ?>
    </div>
</section>
<?php
get_footer();
