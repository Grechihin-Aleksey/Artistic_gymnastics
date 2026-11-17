<?php
/**
 * Повторяющиеся блоки страниц. Каждая функция печатает готовую разметку.
 */

if (!defined('ABSPATH')) {
    exit;
}

/** Значки линией цвета текста. */
function ag_icon($name, $size = 20)
{
    $paths = array(
        'logo' => '<circle cx="12" cy="4.5" r="2"/><path d="M4 9.5h16M12 9.5v5l-4 6M12 14.5l4 6"/>',
        'menu' => '<path d="M4 7h16M4 12h16M4 17h16"/>',
        'close' => '<path d="M6 6l12 12M18 6L6 18"/>',
        'calendar' => '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
        'cup' => '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3"/>',
        'news' => '<path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/>',
        'pin' => '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
        'phone' => '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
        'mail' => '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
        'link' => '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
        'arrow' => '<path d="M5 12h14M13 6l6 6-6 6"/>',
        'file' => '<path d="M14 3H6v18h12V7zM14 3v4h4"/>',
        'search' => '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
        'user' => '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    );
    return '<svg class="ag-icon" width="' . (int) $size . '" height="' . (int) $size . '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' . ($paths[$name] ?? '') . '</svg>';
}

/** Заголовок раздела со ссылкой «Все …». */
function ag_section_head($title, $url = '', $link = '', $tag = 'h2')
{
    echo '<div class="section-head"><' . $tag . ' class="section-head__title">' . esc_html($title) . '</' . $tag . '>';
    if ($url !== '') {
        echo '<a class="section-head__link" href="' . esc_url($url) . '">' . esc_html($link) . ' ' . ag_icon('arrow', 16) . '</a>';
    }
    echo '</div>';
}

/** Пульсирующая точка «идёт сейчас». */
function ag_live_dot()
{
    return '<span class="live-dot" aria-hidden="true"></span>';
}

/**
 * Статус соревнования для календаря: плашка и главное действие.
 * Возвращает ['chip' => класс, 'text' => подпись, 'url' => ссылка, 'action' => текст, 'button' => bool].
 */
function ag_status($c)
{
    $stage = ag_stage($c);
    $link = get_permalink($c['post']);
    if ($stage === 'live') {
        return array('chip' => 'live', 'text' => 'Идёт сейчас', 'url' => $link . '#live', 'action' => 'Табло', 'button' => false);
    }
    if ($stage === 'done') {
        return array('chip' => 'done', 'text' => 'Итоги', 'url' => $link . '#results', 'action' => 'Результаты', 'button' => false);
    }
    $entry = ag_entry_info($c);
    if ($entry && $entry['open']) {
        $text = $entry['deadline'] !== '' ? 'Заявки до ' . ag_date_range($entry['deadline'], $entry['deadline'], false) : 'Идёт приём заявок';
        return array('chip' => 'open', 'text' => $text, 'url' => $entry['url'], 'action' => 'Подать заявку', 'button' => true);
    }
    return array('chip' => 'soon', 'text' => ag_days_until($c['start']) !== '' ? 'Старт ' . ag_days_until($c['start']) : 'Скоро', 'url' => $link, 'action' => 'Подробнее', 'button' => false);
}

/** Строка календаря. */
function ag_competition_row($c)
{
    $s = ag_status($c);
    list($day, $month) = ag_date_badge($c['start'], $c['end']);
    $meta = array_filter(array($c['venue'] !== '' ? $c['venue'] : $c['city'], ag_gender_label($c['gender']), $c['levels']));
    $done = ag_stage($c) === 'done';
    ?>
    <article class="cal-row<?php echo $done ? ' cal-row--done' : ''; ?>">
        <div class="cal-row__date"><b><?php echo esc_html($day); ?></b><span><?php echo esc_html($month); ?></span></div>
        <div class="cal-row__main">
            <h3 class="cal-row__title"><a href="<?php the_permalink($c['post']); ?>"><?php echo esc_html(get_the_title($c['post'])); ?></a></h3>
            <?php if ($meta) : ?><p class="cal-row__meta"><?php echo esc_html(implode(' · ', $meta)); ?></p><?php endif; ?>
        </div>
        <span class="chip chip--<?php echo esc_attr($s['chip']); ?>"><?php echo $s['chip'] === 'live' ? ag_live_dot() : ''; ?><?php echo esc_html($s['text']); ?></span>
        <?php if ($s['button']) : ?>
            <a class="btn btn--accent btn--small cal-row__action" href="<?php echo esc_url($s['url']); ?>" target="_blank" rel="noopener"><?php echo esc_html($s['action']); ?></a>
        <?php else : ?>
            <a class="cal-row__action cal-row__link" href="<?php echo esc_url($s['url']); ?>"><?php echo esc_html($s['action']); ?> <?php echo ag_icon('arrow', 16); ?></a>
        <?php endif; ?>
    </article>
    <?php
}

/** Призёры: одна карточка на один зачёт. */
function ag_podium_card($podium, $caption = '', $files = array(), $url = '')
{
    ?>
    <div class="card podium">
        <?php if ($caption !== '') : ?><p class="podium__caption"><?php echo esc_html($caption); ?></p><?php endif; ?>
        <h3 class="podium__title"><?php echo $url !== '' ? '<a href="' . esc_url($url) . '">' . esc_html($podium['title']) . '</a>' : esc_html($podium['title']); ?></h3>
        <ol class="podium__list">
            <?php foreach ($podium['rows'] as $row) : ?>
                <li class="podium__row">
                    <span class="place place--<?php echo (int) $row[0]; ?>"><?php echo (int) $row[0]; ?></span>
                    <span class="podium__name"><?php echo isset($row[4]) && $row[4] !== '' ? '<a href="' . esc_url($row[4]) . '">' . esc_html($row[1]) . '</a>' : esc_html($row[1]); ?><?php if ($row[2] !== '') : ?><small><?php echo esc_html($row[2]); ?></small><?php endif; ?></span>
                    <b class="podium__total"><?php echo esc_html(ag_score($row[3])); ?></b>
                </li>
            <?php endforeach; ?>
        </ol>
        <?php if ($files) : ?>
            <div class="podium__files">
                <?php foreach (array_slice($files, 0, 3) as $f) : ?>
                    <a class="file-pill" href="<?php echo esc_url($f['url']); ?>" target="_blank" rel="noopener"><?php echo esc_html($f['title']); ?></a>
                <?php endforeach; ?>
            </div>
        <?php endif; ?>
    </div>
    <?php
}

/** Значок типа файла: PDF, XLS, DOC. */
function ag_file_badge($ext)
{
    $ext = strtoupper(substr((string) $ext, 0, 4));
    $kind = in_array($ext, array('XLS', 'XLSX', 'CSV'), true) ? 'xls' : (in_array($ext, array('DOC', 'DOCX', 'RTF'), true) ? 'doc' : 'pdf');
    $label = $kind === 'xls' ? 'XLS' : ($kind === 'doc' ? 'DOC' : ($ext !== '' ? $ext : 'FILE'));
    return '<span class="file-badge file-badge--' . esc_attr($kind) . '">' . esc_html($label) . '</span>';
}

/** Список файлов: протоколы с ретранслятора или документы. Строки сгруппированы по разделу. */
function ag_file_list($files)
{
    if (!$files) {
        return;
    }
    $groups = array();
    foreach ($files as $f) {
        $groups[$f['group'] ?? ''][] = $f;
    }
    foreach ($groups as $group => $items) {
        if ($group !== '' && count($groups) > 1) {
            echo '<h4 class="file-group">' . esc_html($group) . '</h4>';
        }
        echo '<ul class="file-list">';
        foreach ($items as $f) {
            echo '<li><a class="file-row" href="' . esc_url($f['url']) . '" target="_blank" rel="noopener">' . ag_file_badge($f['ext']) . '<span class="file-row__title">' . esc_html($f['title']) . '</span><span class="file-row__size">' . esc_html(ag_file_size($f['size'] ?? 0)) . '</span></a></li>';
        }
        echo '</ul>';
    }
}

/** Файлы из медиатеки в формате ag_file_list. */
function ag_attachment_files($ids)
{
    $out = array();
    foreach ($ids as $id) {
        $url = wp_get_attachment_url($id);
        if (!$url) {
            continue;
        }
        $path = get_attached_file($id);
        $out[] = array(
            'title' => get_the_title($id),
            'url' => $url,
            'ext' => strtoupper(pathinfo($url, PATHINFO_EXTENSION)),
            'size' => $path && file_exists($path) ? filesize($path) : 0,
            'group' => '',
        );
    }
    return $out;
}

/** Документ (запись ag_document) в формате ag_file_list. */
function ag_document_file($post)
{
    $url = ag_document_url($post->ID);
    $att = (int) get_post_meta($post->ID, '_ag_file', true);
    $path = $att ? get_attached_file($att) : '';
    return array(
        'title' => get_the_title($post),
        'url' => $url !== '' ? $url : get_permalink($post),
        'ext' => $url !== '' ? strtoupper(pathinfo(wp_parse_url($url, PHP_URL_PATH) ?: '', PATHINFO_EXTENSION)) : '',
        'size' => $path && file_exists($path) ? filesize($path) : 0,
        'group' => '',
    );
}

/**
 * Табло из программы соревнований. Скрипт встраивания берётся с ретранслятора;
 * если установлен плагин «Табло результатов», используется тот же скрипт, второй раз он не грузится.
 */
function ag_board($ids, $theme = 'dark', $view = 'auto')
{
    if (!$ids) {
        return;
    }
    wp_enqueue_script('ag-results-embed', ag_relay_base() . '/embed.js', array(), null, true);
    echo '<div class="board" data-ag-board data-ids="' . esc_attr(implode(',', $ids)) . '" data-theme="' . esc_attr($theme) . '">';
    echo '<div data-ag-results="' . esc_attr(implode(',', $ids)) . '" data-view="' . esc_attr($view) . '" data-theme="' . esc_attr($theme) . '"></div>';
    echo '</div>';
}

/** Скрипт табло — асинхронно (если плагин уже добавил такой фильтр, второй не нужен). */
function ag_embed_async($tag, $handle)
{
    if ($handle !== 'ag-results-embed' || strpos($tag, ' async') !== false) {
        return $tag;
    }
    return str_replace(' src=', ' async src=', $tag);
}
add_filter('script_loader_tag', 'ag_embed_async', 11, 2);

/**
 * Карточка «На помосте» для главной: заполняется скриптом темы со снимка ретранслятора.
 * Без скрипта или до первых оценок показывает заглушку.
 */
function ag_live_card($c)
{
    ?>
    <div class="live-card" data-ag-live data-ids="<?php echo esc_attr(implode(',', $c['ids'])); ?>" aria-live="polite">
        <div class="live-card__top"><span data-live="where">На помосте</span><span data-live="cat"></span></div>
        <div class="live-card__now">
            <div class="live-card__app" data-live="app">—</div>
            <div class="live-card__who"><b data-live="name">Ждём первые оценки</b><span data-live="club">Табло обновляется само</span></div>
            <div class="live-card__score"><b data-live="total"></b><span data-live="de"></span></div>
        </div>
        <div class="live-card__leaders" data-live="leaders-box" hidden>
            <p class="live-card__label" data-live="leaders-title">Многоборье · лидеры</p>
            <ol data-live="leaders"></ol>
        </div>
    </div>
    <?php
}

/** Карточка новости. */
function ag_news_card($post = null, $class = '')
{
    $post = get_post($post);
    $cat = get_the_category($post->ID);
    ?>
    <a class="card news-card <?php echo esc_attr($class); ?>" href="<?php echo esc_url(get_permalink($post)); ?>">
        <div class="news-card__img">
            <?php if (has_post_thumbnail($post)) : ?>
                <?php echo get_the_post_thumbnail($post, 'ag-card', array('loading' => 'lazy', 'alt' => '')); ?>
            <?php else : ?>
                <span class="news-card__ph"><?php echo ag_icon('logo', 40); ?></span>
            <?php endif; ?>
        </div>
        <div class="news-card__body">
            <?php if ($cat) : ?><span class="news-card__tag"><?php echo esc_html($cat[0]->name); ?></span><?php endif; ?>
            <span class="news-card__title"><?php echo esc_html(get_the_title($post)); ?></span>
            <span class="news-card__date"><?php echo esc_html(ag_post_date($post)); ?></span>
        </div>
    </a>
    <?php
}

function ag_post_date($post = null)
{
    $post = get_post($post);
    $t = get_post_timestamp($post);
    return $t ? wp_date('j', $t) . ' ' . ag_month_gen(wp_date('n', $t)) . ' ' . wp_date('Y', $t) : '';
}

/** Буква для значка клуба без логотипа: первая буква названия без «СШОР», «ДЮСШ» и кавычек. */
function ag_club_initial($title)
{
    $t = wp_strip_all_tags(html_entity_decode((string) $title, ENT_QUOTES, 'UTF-8'));
    $t = preg_replace('/^((МБУ|МАУ|ГБУ|МБОУ|ДО)\s+)*((С|СДЮ|ДЮ)?(СШОР|СШ|ШОР)|ДЮСШ|СДЮШОР|ДЮСШОР)\s*/u', '', $t);
    $t = trim(preg_replace('/[«»"“”„\'()]/u', '', $t));
    return $t !== '' ? mb_strtoupper(mb_substr($t, 0, 1)) : '•';
}

/** Карточка клуба. */
function ag_club_card($post)
{
    $city = (string) get_post_meta($post->ID, '_ag_city', true);
    ?>
    <a class="club-card" href="<?php echo esc_url(get_permalink($post)); ?>">
        <span class="club-card__logo">
            <?php if (has_post_thumbnail($post)) : ?>
                <?php echo get_the_post_thumbnail($post, 'thumbnail', array('alt' => '', 'loading' => 'lazy')); ?>
            <?php else : ?>
                <?php echo esc_html(ag_club_initial(get_the_title($post))); ?>
            <?php endif; ?>
        </span>
        <span class="club-card__text"><b><?php echo esc_html(get_the_title($post)); ?></b><?php if ($city !== '') : ?><small><?php echo esc_html($city); ?></small><?php endif; ?></span>
    </a>
    <?php
}

/** Пагинация архивов. */
function ag_pagination($query = null)
{
    global $wp_query;
    $q = $query ?: $wp_query;
    $links = paginate_links(array(
        'total' => (int) $q->max_num_pages,
        'current' => max(1, (int) get_query_var('paged')),
        'prev_text' => '←',
        'next_text' => '→',
        'type' => 'list',
    ));
    if ($links) {
        echo '<nav class="pagination" aria-label="Страницы">' . $links . '</nav>';
    }
}

/** Программа по дням из поля «Программа»: строки «дата | событие». */
function ag_program_rows($text)
{
    $rows = array();
    foreach (preg_split('/\r?\n/', (string) $text) as $line) {
        $line = trim($line);
        if ($line === '') {
            continue;
        }
        $parts = array_map('trim', explode('|', $line, 2));
        $rows[] = count($parts) === 2 ? $parts : array('', $parts[0]);
    }
    return $rows;
}
