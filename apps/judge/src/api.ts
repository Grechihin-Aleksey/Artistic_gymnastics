export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Запрос к серверу в зале. Сетевая ошибка — status 0. */
export async function apiRequest<T>(
  path: string,
  options: { token?: string | null; method?: string; body?: unknown } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : null,
    });
  } catch {
    throw new ApiError(0, "Нет связи с сервером");
  }
  const text = await response.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "message" in data && typeof data.message === "string"
        ? data.message
        : `Ошибка сервера ${response.status}`;
    throw new ApiError(response.status, message);
  }
  return data as T;
}
