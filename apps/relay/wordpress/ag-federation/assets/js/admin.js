/* Выбор файлов из медиатеки в полях соревнования и документа. */
(function ($) {
  "use strict";

  $(document).on("click", "[data-ag-docs] .ag-docs__add", function (e) {
    e.preventDefault();
    var box = $(this).closest("[data-ag-docs]");
    var frame = wp.media({ title: "Документы соревнования", button: { text: "Добавить" }, multiple: true });
    frame.on("select", function () {
      frame.state().get("selection").each(function (att) {
        var a = att.toJSON();
        if (box.find('li[data-id="' + a.id + '"]').length) return;
        var li = $('<li><a target="_blank"></a> <button type="button" class="button-link ag-docs__remove">убрать</button></li>');
        li.attr("data-id", a.id);
        li.find("a").attr("href", a.url).text(a.title || a.filename);
        box.find(".ag-docs__list").append(li);
      });
      sync(box);
    });
    frame.open();
  });

  $(document).on("click", "[data-ag-docs] .ag-docs__remove", function (e) {
    e.preventDefault();
    var box = $(this).closest("[data-ag-docs]");
    $(this).closest("li").remove();
    sync(box);
  });

  function sync(box) {
    var ids = box.find("li[data-id]").map(function () {
      return $(this).attr("data-id");
    }).get();
    box.find("input[type=hidden]").val(ids.join(","));
  }

  $(document).on("click", "[data-ag-file] .ag-file__pick", function (e) {
    e.preventDefault();
    var box = $(this).closest("[data-ag-file]");
    var frame = wp.media({ title: "Файл документа", button: { text: "Выбрать" }, multiple: false });
    frame.on("select", function () {
      var a = frame.state().get("selection").first().toJSON();
      box.find("input[type=hidden]").val(a.id);
      box.find(".ag-file__name").empty().append($('<a target="_blank"></a>').attr("href", a.url).text(a.filename));
    });
    frame.open();
  });
})(jQuery);

/* Расписание группы: строки занятий добавляются и убираются кнопками. */
(function ($) {
  "use strict";
  $(document).on("click", ".ag-sched__add", function (e) {
    e.preventDefault();
    var table = $("[data-ag-sched]");
    var tpl = $("[data-ag-sched-template]");
    if (!table.length || !tpl.length) return;
    var row = $(tpl.html());
    var last = table.find("tbody tr").last();
    if (last.length) {
      // Новое занятие — через день (Пн → Ср → Пт → Сб) в то же время.
      var day = parseInt(last.find("select").val(), 10) || 0;
      row.find("select").val(String(Math.min(7, day >= 5 ? day + 1 : day + 2)));
      row.find('input[name="ag_sched[from][]"]').val(last.find('input[name="ag_sched[from][]"]').val());
      row.find('input[name="ag_sched[to][]"]').val(last.find('input[name="ag_sched[to][]"]').val());
      row.find('input[name="ag_sched[place][]"]').val(last.find('input[name="ag_sched[place][]"]').val());
    }
    table.find("tbody").append(row);
    row.find("select").trigger("focus");
  });
  $(document).on("click", ".ag-sched__remove", function (e) {
    e.preventDefault();
    $(this).closest("tr").remove();
  });
})(jQuery);
