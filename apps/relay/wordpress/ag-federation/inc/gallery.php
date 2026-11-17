<?php
/**
 * Фотографии турнира: снимки из медиатеки и ссылка на альбом (ВКонтакте, Яндекс Диск).
 * На странице соревнования — сетка во вкладке «Итоги и протоколы», снимок открывается на весь экран.
 */

if (!defined('ABSPATH')) {
    exit;
}

function ag_gallery_ids($post_id)
{
    return array_values(array_filter(array_map('absint', explode(',', (string) get_post_meta($post_id, '_ag_photos', true))), function ($id) {
        return $id && wp_attachment_is_image($id);
    }));
}

function ag_gallery_boxes()
{
    add_meta_box('ag_gallery', 'Фотографии турнира', 'ag_gallery_box', 'ag_competition', 'normal', 'default');
}
add_action('add_meta_boxes', 'ag_gallery_boxes');

function ag_gallery_box($post)
{
    wp_nonce_field('ag_gallery', 'ag_gallery_nonce');
    $ids = ag_gallery_ids($post->ID);
    echo '<div class="ag-photos" data-ag-photos><input type="hidden" name="ag_photos" value="' . esc_attr(implode(',', $ids)) . '"><ul class="ag-photos__list">';
    foreach ($ids as $id) {
        echo '<li data-id="' . (int) $id . '">' . wp_get_attachment_image($id, 'thumbnail') . '<button type="button" class="ag-photos__remove" aria-label="Убрать фото">×</button></li>';
    }
    echo '</ul><p><button type="button" class="button ag-photos__add">Добавить фото</button> <span class="description">Можно выбрать сразу много снимков; порядок меняется перетаскиванием.</span></p></div>';
    echo '<div class="ag-field"><label for="ag-album">Ссылка на весь альбом</label><input id="ag-album" type="url" name="ag_album" value="' . esc_attr((string) get_post_meta($post->ID, '_ag_album', true)) . '" placeholder="https://vk.com/album-…" style="width:100%"><p class="description">Необязательно: альбом ВКонтакте или папка на Яндекс Диске со всеми снимками.</p></div>';
}

function ag_gallery_save($post_id, $post)
{
    if ($post->post_type !== 'ag_competition' || !isset($_POST['ag_gallery_nonce']) || !wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['ag_gallery_nonce'])), 'ag_gallery')) {
        return;
    }
    if ((defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) || !current_user_can('edit_post', $post_id)) {
        return;
    }
    $ids = array_filter(array_map('absint', explode(',', sanitize_text_field(wp_unslash($_POST['ag_photos'] ?? '')))));
    $ids ? update_post_meta($post_id, '_ag_photos', implode(',', array_unique($ids))) : delete_post_meta($post_id, '_ag_photos');
    $album = esc_url_raw(wp_unslash($_POST['ag_album'] ?? ''));
    $album !== '' ? update_post_meta($post_id, '_ag_album', $album) : delete_post_meta($post_id, '_ag_album');
}
add_action('save_post', 'ag_gallery_save', 10, 2);

/** Сетка фотографий на странице соревнования. */
function ag_gallery($post_id)
{
    $ids = ag_gallery_ids($post_id);
    $album = (string) get_post_meta($post_id, '_ag_album', true);
    if (!$ids && $album === '') {
        return;
    }
    echo '<div class="card"><div class="section-head"><h2 class="section-head__title">Фото</h2>';
    if ($album !== '') {
        echo '<a class="section-head__link" href="' . esc_url($album) . '" target="_blank" rel="noopener">Весь альбом ' . ag_icon('arrow', 16) . '</a>';
    }
    echo '</div>';
    if ($ids) {
        echo '<div class="gallery" data-ag-gallery>';
        foreach ($ids as $i => $id) {
            $full = wp_get_attachment_image_url($id, 'large');
            $caption = wp_get_attachment_caption($id);
            echo '<a class="gallery__item" href="' . esc_url($full) . '" data-index="' . (int) $i . '"' . ($caption ? ' data-caption="' . esc_attr($caption) . '"' : '') . '>' . wp_get_attachment_image($id, 'medium', false, array('loading' => 'lazy', 'alt' => $caption ?: get_the_title($post_id))) . '</a>';
        }
        echo '</div>';
    }
    echo '</div>';
}
