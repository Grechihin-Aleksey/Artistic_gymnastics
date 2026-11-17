import { BadGatewayException, ConflictException, Inject, Injectable } from "@nestjs/common";
import type { SiteCard, SiteCardInput, SiteCardView } from "@ag/shared";
import { asc, eq } from "drizzle-orm";
import { CompetitionsService } from "../competitions/competitions.service";
import { APP_CONFIG, type AppConfig } from "../config";
import { DB, type Db } from "../db/db.module";
import { auditLog, competitions } from "../db/schema";
import { ResultsService } from "../results/results.service";

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Кнопка «Подключить к сайту»: создаёт или обновляет карточку соревнования на сайте федерации
 * (WordPress с темой ag-federation). В карточку уходят название, пол, разряды, ID всех частей
 * турнира и ключ онлайн-заявок, а даты и место секретарь вписывает в секретариате. После этого
 * на странице турнира сами появляются заявки, табло, протоколы и итоги.
 *
 * Программа входит в WordPress паролем приложения пользователя WP_USER; это не пароль от сайта.
 */
@Injectable()
export class SiteCardService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly competitions: CompetitionsService,
    private readonly results: ResultsService,
  ) {}

  /** Адрес сайта: WP_URL, а без него — сайт, на котором лежит ретранслятор (RELAY_URL без /results). */
  get site(): string | null {
    const raw = this.config.wpUrl || (this.config.relayUrl ? this.config.relayUrl.replace(/\/+$/, "").replace(/\/results$/i, "") : "");
    if (!raw) return null;
    try {
      const url = new URL(raw);
      return url.toString().replace(/\/+$/, "");
    } catch {
      return null;
    }
  }

  get enabled(): boolean {
    return Boolean(this.site && this.config.wpUser && this.config.wpAppPassword);
  }

  async view(competitionId: string): Promise<SiteCardView> {
    const parts = await this.parts(competitionId);
    const main = parts[0]!;
    const base = { enabled: this.enabled, site: this.site, card: null, error: null, trial: main.trial };
    if (!this.enabled || main.trial) return base;
    try {
      const card = (await this.request("GET", `&id=${main.id}`)) as SiteCard | null;
      return { ...base, card };
    } catch (e) {
      return { ...base, error: (e as Error).message };
    }
  }

  async publish(competitionId: string, input: SiteCardInput): Promise<SiteCardView> {
    if (!this.enabled) {
      throw new ConflictException("Сайт федерации не подключён: впишите в .env строки WP_USER и WP_APP_PASSWORD и перезапустите программу");
    }
    const parts = await this.parts(competitionId);
    const main = parts[0]!;
    if (main.trial) throw new ConflictException("Пробный турнир на сайт не отправляется");
    // Девушки первыми: так части идут и на табло сайта.
    const ordered = [...parts].sort((a, b) => Number(b.discipline === "WAG") - Number(a.discipline === "WAG"));
    const disciplines = new Set(parts.map((p) => p.discipline));
    const levels = [...new Set((await Promise.all(parts.map((p) => this.results.categoryList(p.id)))).flat().filter((c) => c.id).map((c) => c.name))];
    const body = {
      ids: [main.id, ...ordered.map((p) => p.id).filter((id) => id !== main.id)],
      name: main.name,
      gender: disciplines.size > 1 ? "both" : disciplines.has("MAG") ? "boys" : "girls",
      levels: levels.join(", "),
      start: input.start,
      end: input.end,
      venue: input.venue,
      city: input.city,
      entryKey: main.entryKey ?? "",
      ...(main.entryKey ? { deadline: main.entriesDeadline ? localDate(main.entriesDeadline) : "" } : {}),
    };
    const card = (await this.request("POST", "", body)) as SiteCard;
    await this.db.insert(auditLog).values({
      competitionId: main.id,
      actor: "admin",
      action: "site.card",
      details: { created: card.created, link: card.link },
    });
    return { enabled: true, site: this.site, card, error: null, trial: false };
  }

  /** Части турнира: основная (в ней ключ заявок) первой, затем вторая, если турнир девочек и мальчиков. */
  private async parts(competitionId: string) {
    const competition = await this.competitions.get(competitionId);
    if (!competition.pairId) return [competition];
    const all = await this.db.select().from(competitions).where(eq(competitions.pairId, competition.pairId)).orderBy(asc(competitions.createdAt));
    const main = all.find((c) => c.id === competition.pairId) ?? all[0] ?? competition;
    return [main, ...all.filter((c) => c.id !== main.id)];
  }

  /** Запрос к теме сайта. Адрес через ?rest_route=, чтобы работало и без «красивых» ссылок WordPress. */
  private async request(method: "GET" | "POST", query: string, body?: unknown): Promise<unknown> {
    const url = `${this.site}/?rest_route=${encodeURIComponent("/ag/v1/competition")}${query}`;
    const auth = Buffer.from(`${this.config.wpUser}:${(this.config.wpAppPassword ?? "").replace(/\s+/g, "")}`).toString("base64");
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { authorization: `Basic ${auth}`, "content-type": "application/json", accept: "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new BadGatewayException(`Нет связи с сайтом ${this.site}: проверьте интернет в зале и адрес сайта`);
    }
    const text = await response.text();
    let data: { code?: string; message?: string } | null = null;
    try {
      data = JSON.parse(text) as { code?: string; message?: string };
    } catch {
      data = null;
    }
    if (response.ok && data) return data;
    if (method === "GET" && response.status === 404 && data?.code === "ag_not_found") return null;
    throw new BadGatewayException(siteError(response.status, data));
  }
}

/** Понятная причина ошибки WordPress для секретаря. */
function siteError(status: number, data: { code?: string; message?: string } | null): string {
  const code = data?.code ?? "";
  if (code === "rest_no_route") return "На сайте не включена тема «Спортивная гимнастика — федерация» (или она старой версии)";
  if (status === 401 || code === "ag_auth" || code === "incorrect_password" || code === "invalid_username") {
    return "Сайт не принял пароль приложения: проверьте WP_USER и WP_APP_PASSWORD в .env. Если сайт открывается по http, а не https, WordPress пароли приложений не принимает";
  }
  if (status === 403) return data?.message ?? "У пользователя WP_USER нет прав публиковать записи: нужен редактор или администратор";
  if (!data) return `Сайт ответил ошибкой ${status}: проверьте адрес сайта (WP_URL)`;
  return data.message ? `Сайт: ${data.message}` : `Сайт ответил ошибкой ${status}`;
}

/** Дата окончания приёма заявок в часовом поясе зала: «до 1 декабря» значит до конца этого дня. */
function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
