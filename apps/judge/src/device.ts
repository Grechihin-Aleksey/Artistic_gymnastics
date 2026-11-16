import { uuid } from "./uuid";

const KEY = "device-id";
let fallback: string | null = null;

/**
 * Метка этого планшета. Код судьи работает на том планшете, где его открыли первым,
 * поэтому метка хранится вместе с кодом и переживает перезагрузку страницы.
 */
export function deviceId(storage: Storage | null = globalThis.localStorage ?? null): string {
  try {
    const saved = storage?.getItem(KEY);
    if (saved) return saved;
    const id = uuid();
    storage?.setItem(KEY, id);
    return id;
  } catch {
    // приватный режим: метка живёт, пока открыта вкладка
    return (fallback ??= uuid());
  }
}
