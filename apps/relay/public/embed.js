/*
 * Встраивание результатов на сайт:
 *
 *   <div data-ag-results="ID соревнования" data-view="auto" data-theme="light"></div>
 *   <script src="https://АДРЕС-РЕТРАНСЛЯТОРА/embed.js" async></script>
 *
 * data-view: auto (по очереди), now (сейчас на снарядах), aa (многоборье),
 * teams (команды) или код снаряда (FX, VT, BB…). data-theme: light или dark.
 * data-category: номер разряда по порядку, начиная с 1 (если разрядов несколько).
 */
(function () {
  var script = document.currentScript;
  var base = script ? script.src.replace(/\/embed\.js(\?.*)?$/, "") : "";
  var origin = base ? new URL(base).origin : "";
  var frames = [];

  function mount(el) {
    if (el.getAttribute("data-ag-mounted")) return;
    el.setAttribute("data-ag-mounted", "1");
    var params = new URLSearchParams();
    params.set("c", el.getAttribute("data-ag-results") || "");
    params.set("view", el.getAttribute("data-view") || "auto");
    params.set("theme", el.getAttribute("data-theme") || "light");
    var category = Number(el.getAttribute("data-category"));
    if (category > 1) params.set("cat", String(category - 1));
    params.set("embed", "1");
    var frame = document.createElement("iframe");
    frame.src = base + "/widget/index.html#" + params.toString();
    frame.title = "Результаты соревнований";
    frame.loading = "lazy";
    frame.style.cssText = "display:block;width:100%;height:420px;border:0;";
    el.appendChild(frame);
    frames.push(frame);
  }

  // Виджет сообщает свою высоту, чтобы на странице не было второй полосы прокрутки.
  window.addEventListener("message", function (event) {
    if (event.origin !== origin || !event.data || event.data.type !== "ag-results:height") return;
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === event.source) {
        frames[i].style.height = Math.max(120, Math.ceil(event.data.height)) + "px";
      }
    }
  });

  function scan() {
    var nodes = document.querySelectorAll("[data-ag-results]");
    for (var i = 0; i < nodes.length; i++) mount(nodes[i]);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
  else scan();
})();
