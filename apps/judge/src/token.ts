const KEY = "judge-token";

/**
 * Токен судьи приходит в адресе из QR-кода (#token=…). Сохраняем его на планшете
 * и убираем из адресной строки, чтобы он не попал в историю и на чужой экран.
 */
export function takeTokenFromLocation(location: Location, storage: Storage): string | null {
  const match = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (match?.[1]) {
    const token = decodeURIComponent(match[1]);
    try {
      storage.setItem(KEY, token);
    } catch {
      // приватный режим: токен живёт только в этой вкладке
    }
    history.replaceState(null, "", location.pathname + location.search);
    return token;
  }
  try {
    return storage.getItem(KEY);
  } catch {
    return null;
  }
}

export function forgetToken(storage: Storage): void {
  try {
    storage.removeItem(KEY);
  } catch {
    // нечего удалять
  }
}
