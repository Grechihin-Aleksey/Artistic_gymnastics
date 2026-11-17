/*
 * Скрипт темы: меню на телефоне, вкладки страницы соревнования, фото турнира на весь экран
 * и живая карточка «На помосте» на главной (опрашивает ретранслятор результатов).
 */
(function () {
  "use strict";
  var relay = (window.agTheme && window.agTheme.relay) || "";
  document.documentElement.classList.add("js");

  /* ---------- Меню ---------- */
  var toggle = document.querySelector("[data-ag-nav-toggle]");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var open = document.body.classList.toggle("nav-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && document.body.classList.contains("nav-open")) {
        document.body.classList.remove("nav-open");
        toggle.setAttribute("aria-expanded", "false");
        toggle.focus();
      }
    });
  }

  /* ---------- Вкладки соревнования ---------- */
  var tabs = document.querySelector("[data-ag-tabs]");
  if (tabs) {
    var links = tabs.querySelectorAll("a[role=tab]");
    var panels = document.querySelectorAll("[data-ag-panel]");
    var show = function (id, scroll) {
      var found = false;
      for (var i = 0; i < panels.length; i++) {
        var on = panels[i].id === id;
        panels[i].hidden = !on;
        found = found || on;
      }
      if (!found) return false;
      for (var j = 0; j < links.length; j++) {
        var active = links[j].getAttribute("href") === "#" + id;
        links[j].classList.toggle("is-active", active);
        links[j].setAttribute("aria-selected", active ? "true" : "false");
      }
      if (scroll === false) return true;
      return true;
    };
    var initial = location.hash.slice(1);
    if (!show(initial, false)) show(tabs.getAttribute("data-active"), false);
    tabs.addEventListener("click", function (e) {
      var a = e.target.closest("a[role=tab]");
      if (!a) return;
      e.preventDefault();
      var id = a.getAttribute("href").slice(1);
      show(id);
      if (history.replaceState) history.replaceState(null, "", "#" + id);
    });
    window.addEventListener("hashchange", function () {
      show(location.hash.slice(1));
    });
  }

  /* ---------- Фото турнира: просмотр на весь экран ---------- */
  var gallery = document.querySelector("[data-ag-gallery]");
  if (gallery) {
    var items = gallery.querySelectorAll(".gallery__item");
    var box = document.createElement("div");
    box.className = "lightbox";
    box.hidden = true;
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Фото");
    box.innerHTML = '<span class="lightbox__count"></span><figure><img alt=""><figcaption></figcaption></figure>' +
      '<button type="button" class="lightbox__close" aria-label="Закрыть">×</button>' +
      '<button type="button" class="lightbox__prev" aria-label="Предыдущее фото">‹</button>' +
      '<button type="button" class="lightbox__next" aria-label="Следующее фото">›</button>';
    document.body.appendChild(box);
    var img = box.querySelector("img");
    var cap = box.querySelector("figcaption");
    var count = box.querySelector(".lightbox__count");
    var current = 0;
    var opener = null;
    var open = function (i) {
      current = (i + items.length) % items.length;
      var a = items[current];
      img.src = a.getAttribute("href");
      img.alt = (a.querySelector("img") || {}).alt || "";
      cap.textContent = a.getAttribute("data-caption") || "";
      count.textContent = current + 1 + " / " + items.length;
      if (box.hidden) {
        opener = document.activeElement;
        box.hidden = false;
        document.body.style.overflow = "hidden";
        box.querySelector(".lightbox__close").focus();
      }
    };
    var close = function () {
      box.hidden = true;
      img.removeAttribute("src");
      document.body.style.overflow = "";
      if (opener) opener.focus();
    };
    gallery.addEventListener("click", function (e) {
      var a = e.target.closest(".gallery__item");
      if (!a) return;
      e.preventDefault();
      open(parseInt(a.getAttribute("data-index"), 10) || 0);
    });
    box.addEventListener("click", function (e) {
      if (e.target.closest(".lightbox__prev")) open(current - 1);
      else if (e.target.closest(".lightbox__next")) open(current + 1);
      else if (e.target.closest(".lightbox__close") || e.target === box) close();
    });
    document.addEventListener("keydown", function (e) {
      if (box.hidden) return;
      if (e.key === "Escape") close();
      if (e.key === "ArrowLeft") open(current - 1);
      if (e.key === "ArrowRight") open(current + 1);
    });
    var startX = null;
    box.addEventListener("touchstart", function (e) { startX = e.touches[0].clientX; }, { passive: true });
    box.addEventListener("touchend", function (e) {
      if (startX === null) return;
      var dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) > 50) open(current + (dx < 0 ? 1 : -1));
      startX = null;
    });
  }

  /* ---------- Карточка «На помосте» ---------- */
  var card = document.querySelector("[data-ag-live]");
  if (!card || !relay || !window.fetch) return;
  var ids = (card.getAttribute("data-ids") || "").split(",").filter(Boolean);
  if (!ids.length) return;
  var short = { FX: "ВУ", PH: "КН", SR: "КЛ", VT: "ОП", PB: "БР", HB: "ПК", UB: "БР", BB: "БВ" };
  var names = { FX: "Вольные", PH: "Конь", SR: "Кольца", VT: "Опорный прыжок", PB: "Брусья", HB: "Перекладина", UB: "Брусья", BB: "Бревно" };
  var lastShown = "";

  function el(name) {
    return card.querySelector('[data-live="' + name + '"]');
  }
  function set(name, text) {
    var node = el(name);
    if (node) node.textContent = text;
  }
  function score(v) {
    return typeof v === "number" ? v.toFixed(3).replace(".", ",") : "";
  }
  function person(g) {
    return g ? [g.lastName, g.firstName].filter(Boolean).join(" ") : "";
  }

  /** Самое свежее событие на снарядах: выступление с оценкой, а если оценок ещё нет — кто вызван. */
  function pick(snaps) {
    var best = null;
    snaps.forEach(function (snap) {
      (snap.live || []).forEach(function (a) {
        if (a.last && (!best || !best.last || a.last.approvedAt > best.last.approvedAt)) best = { app: a.apparatus, last: a.last, current: a.current, snap: snap };
        else if (!best && a.current) best = { app: a.apparatus, last: null, current: a.current, snap: snap };
      });
    });
    return best;
  }

  function categoryOf(snap, gymnast) {
    var cats = snap.categories || [];
    if (!gymnast) return cats[0] || null;
    for (var i = 0; i < cats.length; i++) if (cats[i].id === gymnast.categoryId) return cats[i];
    return cats[0] || null;
  }

  function render(snaps) {
    var ev = pick(snaps);
    if (!ev) return;
    var g = ev.last ? ev.last.gymnast : ev.current.gymnast;
    set("where", "На помосте · " + (names[ev.app] || ev.app));
    set("app", short[ev.app] || ev.app);
    set("name", person(g));
    set("club", g.club || "");
    var total = el("total");
    if (ev.last) {
      var key = ev.last.performanceId + ":" + ev.last.attempt + ":" + ev.last.score.total;
      if (total) {
        total.textContent = score(ev.last.score.total);
        if (lastShown && lastShown !== key) {
          total.classList.remove("is-new");
          void total.offsetWidth;
          total.classList.add("is-new");
        }
      }
      lastShown = key;
      set("de", "D " + score(ev.last.score.d).replace(/0+$/, "").replace(/,$/, "") + " · E " + score(ev.last.score.e));
    } else {
      if (total) total.textContent = "";
      set("de", "выступает");
    }
    var cat = categoryOf(ev.snap, g);
    set("cat", cat && cat.name ? cat.name : "");
    var rows = cat ? (cat.allAround || []).slice(0, 3) : [];
    var box = el("leaders-box");
    var list = el("leaders");
    if (!rows.length || !list) {
      if (box) box.hidden = true;
      return;
    }
    list.textContent = "";
    rows.forEach(function (r) {
      var li = document.createElement("li");
      var i = document.createElement("i");
      i.textContent = String(r.rank);
      var name = document.createElement("span");
      name.textContent = person(r.gymnast);
      var b = document.createElement("b");
      b.textContent = score(r.total);
      li.appendChild(i);
      li.appendChild(name);
      li.appendChild(b);
      list.appendChild(li);
    });
    set("leaders-title", "Многоборье" + (cat.name ? " · " + cat.name : "") + " · лидеры");
    box.hidden = false;
  }

  function load() {
    Promise.all(
      ids.map(function (id) {
        return fetch(relay + "/api/competitions/" + encodeURIComponent(id), { cache: "no-store" })
          .then(function (r) {
            return r.ok ? r.json() : null;
          })
          .catch(function () {
            return null;
          });
      })
    ).then(function (snaps) {
      render(snaps.filter(Boolean));
    });
  }
  load();
  var timer = setInterval(load, 8000);
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      clearInterval(timer);
    } else {
      load();
      timer = setInterval(load, 8000);
    }
  });
})();
