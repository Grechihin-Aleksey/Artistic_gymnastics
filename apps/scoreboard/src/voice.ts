import { useEffect, useRef, useState } from "react";
import { APPARATUS_NAMES, type BoardSnapshot } from "@ag/shared";

/** Что объявлять голосом. Настройка своя у каждого ноутбука диктора. */
export interface VoiceSettings {
  on: boolean;
  scores: boolean;
}

const KEY = "announcer-voice";

function load(): VoiceSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<VoiceSettings> | null;
    // Включённый голос после перезагрузки страницы не продолжит без касания: браузер требует действия человека.
    return { on: false, scores: v?.scores ?? true };
  } catch {
    return { on: false, scores: true };
  }
}

/** Балл для голоса: «13,850» — так синтезатор читает «тринадцать целых восемьсот пятьдесят тысячных». */
const spoken = (n: number) => n.toFixed(3).replace(".", ",");

type Live = BoardSnapshot["live"][number];

/** «Бревно. Выступает номер 103, Сидорова Анна, клуб Олимп.» */
export function callText(live: Live): string | null {
  const c = live.current;
  if (!c) return null;
  const g = c.gymnast;
  const attempt = live.apparatus === "VT" && c.attempt === 2 ? " Второй прыжок." : "";
  const club = g.club ? `, клуб ${g.club}` : "";
  return `${APPARATUS_NAMES[live.apparatus]}. Выступает номер ${g.bib}, ${g.lastName} ${g.firstName}${club}.${attempt}`;
}

/** «Бревно. Номер 103, Сидорова Анна: 13,850.» */
export function scoreText(live: Live): string | null {
  const l = live.last;
  if (!l) return null;
  return `${APPARATUS_NAMES[live.apparatus]}. Номер ${l.gymnast.bib}, ${l.gymnast.lastName} ${l.gymnast.firstName}: ${spoken(l.score.total)}.`;
}

/**
 * Новые объявления после прошлого снимка: вызовы и, если включено, оценки.
 * Первый снимок ничего не объявляет — только запоминает, что уже на снарядах.
 */
export function announcements(
  prev: Map<string, { call: string | null; score: string | null }> | null,
  live: readonly Live[],
  settings: VoiceSettings,
): { said: Map<string, { call: string | null; score: string | null }>; texts: string[] } {
  const said = new Map<string, { call: string | null; score: string | null }>();
  const texts: string[] = [];
  for (const a of live) {
    const call = a.current ? `${a.current.performanceId}:${a.current.attempt}` : null;
    const score = a.last ? `${a.last.performanceId}:${a.last.attempt}:${a.last.score.total}` : null;
    said.set(a.apparatus, { call, score });
    if (!prev) continue;
    const before = prev.get(a.apparatus);
    // Оценка объявляется раньше вызова следующего: так и бывает в зале.
    if (settings.scores && score && score !== before?.score) texts.push(scoreText(a)!);
    if (call && call !== before?.call) texts.push(callText(a)!);
  }
  return { said, texts };
}

function russianVoice(): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => v.lang.toLowerCase().startsWith("ru") && v.localService) ?? voices.find((v) => v.lang.toLowerCase().startsWith("ru"));
}

export function speak(text: string) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ru-RU";
  const voice = russianVoice();
  if (voice) u.voice = voice;
  u.rate = 0.95;
  speechSynthesis.speak(u);
}

/** Голосовой вызов на экране диктора: озвучивает новые вызовы и оценки через колонки ноутбука. */
export function useVoice(live: readonly Live[] | undefined) {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [settings, setSettings] = useState(load);
  const said = useRef<Map<string, { call: string | null; score: string | null }> | null>(null);

  useEffect(() => {
    if (!live) return;
    const result = announcements(settings.on ? said.current : null, live, settings);
    said.current = result.said;
    if (supported && settings.on) for (const t of result.texts) speak(t);
  }, [live, settings, supported]);

  const update = (next: VoiceSettings) => {
    setSettings(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Без сохранения настройка живёт до перезагрузки.
    }
    if (!supported) return;
    if (!next.on) speechSynthesis.cancel();
    // Касание «Включить» разрешает браузеру говорить; заодно проверяем звук.
    else if (!settings.on) speak("Голосовой вызов включён.");
  };
  return { supported, settings, update };
}
