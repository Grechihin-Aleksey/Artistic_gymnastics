/**
 * Копирует текст в буфер обмена.
 *
 * Секретариат в сети зала открыт по http (например, http://192.168.1.10:3000), а там браузер
 * не даёт navigator.clipboard — он есть только на https и localhost. Поэтому, если современный
 * способ недоступен или отказал, копируем старым: временное поле с текстом, выделение и
 * команда «копировать». Он работает по http во всех браузерах, где запущен секретариат.
 */
export async function copyText(text: string): Promise<boolean> {
  // Старый способ пробуем первым на http: он срабатывает сразу, пока нажатие кнопки ещё «свежее».
  if (!window.isSecureContext && legacyCopy(text)) return true;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Пробуем запасной путь.
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const active = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const ranges: Range[] = [];
  if (selection) for (let i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i));

  const area = document.createElement("textarea");
  area.value = text;
  // readonly не даёт телефону открыть клавиатуру; поле вне экрана, но видимое для выделения.
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  Object.assign(area.style, {
    position: "fixed",
    top: "0",
    left: "-9999px",
    width: "1px",
    height: "1px",
    padding: "0",
    border: "0",
    fontSize: "16px",
  });
  // Внутри модального окна элементы снаружи нельзя выделить — кладём поле в само окно.
  const host = active?.closest("dialog") ?? document.body;
  host.appendChild(area);

  let ok = false;
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length); // iPad/iPhone не выделяют текст через select()
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    area.remove();
    if (selection) {
      selection.removeAllRanges();
      for (const r of ranges) selection.addRange(r);
    }
    active?.focus?.({ preventScroll: true });
  }
  return ok;
}
