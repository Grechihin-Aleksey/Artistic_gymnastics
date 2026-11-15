import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type {
  OnlineEntryDecision,
  OnlineEntriesView,
  OnlineEntryCall,
  ReceivedOnlineEntry,
  RejectOnlineEntryInput,
  SetOnlineEntriesInput,
} from "@ag/shared";
import { and, asc, eq, isNotNull, max } from "drizzle-orm";
import { newToken } from "../auth/tokens";
import { CompetitionsService } from "../competitions/competitions.service";
import { APP_CONFIG, relayHeaders, type AppConfig } from "../config";
import { DB, type Db } from "../db/db.module";
import { auditLog, competitions, gymnasts, onlineEntries } from "../db/schema";
import { ResultsService } from "../results/results.service";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Онлайн-заявки клубов. Сайт для клубов — облачный ретранслятор: зал публикует
 * на нём приём заявок и забирает присланное по кнопке секретаря. Связь из зала
 * бывает плохой, поэтому принятое живёт в базе зала. Пока у ноутбука есть
 * интернет, зал сам забирает заявки раз в ENTRIES_SYNC_INTERVAL секунд и заодно
 * отправляет на сайт решения секретаря; без связи просто ждёт следующего раза.
 */
@Injectable()
export class OnlineEntriesService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("OnlineEntries");
  private timer: NodeJS.Timeout | null = null;
  private syncing = false;
  /** Соревнования, у которых последняя автоматическая попытка не удалась: чтобы не писать в журнал каждый раз. */
  private readonly failing = new Set<string>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly competitions: CompetitionsService,
    private readonly results: ResultsService,
  ) {}

  private get interval(): number {
    return this.enabled ? Math.max(0, this.config.entriesSyncInterval ?? 0) : 0;
  }

  onModuleInit(): void {
    if (this.interval === 0) return;
    this.timer = setInterval(() => void this.autoSync(), Math.max(60, this.interval) * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Забрать заявки по всем соревнованиям, где приём открыт или есть решения,
   * ещё не отправленные на сайт. Возвращает соревнования, по которым удалось.
   */
  async autoSync(): Promise<string[]> {
    if (!this.enabled || this.syncing) return [];
    this.syncing = true;
    const done: string[] = [];
    try {
      const rows = await this.db
        .select({ id: competitions.id, open: competitions.entriesOpen, syncedAt: competitions.entriesSyncedAt })
        .from(competitions)
        .where(isNotNull(competitions.entryKey));
      for (const c of rows) {
        if (!c.open) {
          const [last] = await this.db
            .select({ at: max(onlineEntries.decidedAt) })
            .from(onlineEntries)
            .where(eq(onlineEntries.competitionId, c.id));
          if (!last?.at || (c.syncedAt && last.at <= c.syncedAt)) continue;
        }
        try {
          await this.sync(c.id);
          done.push(c.id);
          if (this.failing.delete(c.id)) this.log.log("связь с сайтом восстановилась, заявки забраны");
        } catch (e) {
          if (!this.failing.has(c.id)) this.log.warn(`не удалось забрать заявки: ${(e as Error).message}`);
          this.failing.add(c.id);
        }
      }
    } finally {
      this.syncing = false;
    }
    return done;
  }

  private get enabled(): boolean {
    return Boolean(this.config.relayUrl && this.config.relayToken);
  }

  private relayUrl(path: string): URL {
    return new URL(path, this.config.relayUrl!.replace(/\/?$/, "/"));
  }

  async view(competitionId: string): Promise<OnlineEntriesView> {
    const competition = await this.competitions.get(competitionId);
    const shared = this.enabled && competition.entryKey;
    const rows = await this.db
      .select()
      .from(onlineEntries)
      .where(eq(onlineEntries.competitionId, competitionId))
      .orderBy(asc(onlineEntries.receivedAt));
    return {
      enabled: this.enabled,
      open: competition.entriesOpen,
      deadline: competition.entriesDeadline?.toISOString() ?? null,
      link: shared ? `${this.relayUrl("entry/index.html").toString()}#c=${competitionId}&k=${competition.entryKey}` : null,
      shortcode: shared ? `[ag_entry id="${competitionId}" key="${competition.entryKey}"]` : null,
      syncedAt: competition.entriesSyncedAt?.toISOString() ?? null,
      autoSync: this.interval,
      entries: rows.map((r) => ({
        ...r.entry,
        id: r.id,
        receivedAt: r.receivedAt.toISOString(),
        status: r.status,
        note: r.note,
        decidedAt: r.decidedAt?.toISOString() ?? null,
      })),
    };
  }

  /** Открыть или закрыть приём: сначала на сайте, потом у себя — иначе секретарь увидит неправду. */
  async setSettings(competitionId: string, input: SetOnlineEntriesInput): Promise<OnlineEntriesView> {
    this.requireRelay();
    const competition = await this.competitions.get(competitionId);
    const key = competition.entryKey ?? newToken();
    await this.publish(competitionId, key, { open: input.open, deadline: input.deadline });
    await this.db.transaction(async (tx) => {
      await tx
        .update(competitions)
        .set({ entryKey: key, entriesOpen: input.open, entriesDeadline: input.deadline ? new Date(input.deadline) : null })
        .where(eq(competitions.id, competitionId));
      await tx.insert(auditLog).values({ competitionId, actor: "admin", action: input.open ? "entries.opened" : "entries.closed", details: input });
    });
    return this.view(competitionId);
  }

  /** Забрать новые заявки с сайта; заодно обновить там список разрядов. */
  async sync(competitionId: string): Promise<OnlineEntriesView> {
    this.requireRelay();
    const competition = await this.competitions.get(competitionId);
    if (!competition.entryKey) throw new ConflictException("Приём онлайн-заявок ещё не открывали");
    await this.publish(competitionId, competition.entryKey, {
      open: competition.entriesOpen,
      deadline: competition.entriesDeadline?.toISOString() ?? null,
    });
    const { entries } = (await this.request("GET", `entries/${competitionId}`)) as { entries: ReceivedOnlineEntry[] };
    await this.db.transaction(async (tx) => {
      for (const { id, receivedAt, ...entry } of entries) {
        await tx
          .insert(onlineEntries)
          .values({ id, competitionId, entry, receivedAt: new Date(receivedAt) })
          .onConflictDoNothing({ target: onlineEntries.id });
      }
      await tx.update(competitions).set({ entriesSyncedAt: new Date() }).where(eq(competitions.id, competitionId));
    });
    return this.view(competitionId);
  }

  /**
   * Принять заявку: участники попадают в список с номерами после последнего,
   * клуб и город — из заявки. Номера потом можно переразыграть жеребьёвкой.
   */
  async accept(competitionId: string, entryId: string): Promise<OnlineEntriesView> {
    const row = await this.decide(competitionId, entryId, "ACCEPTED", null);
    const [last] = await this.db
      .select({ value: max(gymnasts.bib) })
      .from(gymnasts)
      .where(eq(gymnasts.competitionId, competitionId));
    let bib = last?.value ?? 0;
    const { entry } = row;
    try {
      await this.competitions.importGymnasts(competitionId, {
        rows: entry.rows.map((r) => ({
          bib: ++bib,
          lastName: r.lastName,
          firstName: r.firstName,
          club: entry.club,
          ...(entry.city ? { city: entry.city } : {}),
          ...(r.middleName ? { middleName: r.middleName } : {}),
          ...(r.birthDate ? { birthDate: r.birthDate } : {}),
          ...(r.coach ? { coach: r.coach } : {}),
          ...(r.category ? { category: r.category } : {}),
          ...(r.team ? { team: r.team } : {}),
        })),
      });
    } catch (e) {
      // Список не изменился (импорт — всё или ничего): возвращаем заявку в новые.
      await this.db.update(onlineEntries).set({ status: "NEW", decidedAt: null }).where(eq(onlineEntries.id, entryId));
      throw e;
    }
    await this.db.insert(auditLog).values({
      competitionId,
      actor: "admin",
      action: "entries.accepted",
      details: { entryId, club: entry.club, count: entry.rows.length },
    });
    await this.announce(competitionId);
    return this.view(competitionId);
  }

  async reject(competitionId: string, entryId: string, input: RejectOnlineEntryInput): Promise<OnlineEntriesView> {
    const row = await this.decide(competitionId, entryId, "REJECTED", input.note ?? null);
    await this.db.insert(auditLog).values({
      competitionId,
      actor: "admin",
      action: "entries.rejected",
      details: { entryId, club: row.entry.club, note: input.note ?? null },
    });
    await this.announce(competitionId);
    return this.view(competitionId);
  }

  /**
   * Сообщить сайту решения, чтобы клуб увидел статус заявки. Если связи нет,
   * решение уйдёт со следующим «Забрать заявки» — секретаря это не задерживает.
   */
  private async announce(competitionId: string): Promise<void> {
    const competition = await this.competitions.get(competitionId);
    if (!competition.entryKey) return;
    await this.publish(competitionId, competition.entryKey, {
      open: competition.entriesOpen,
      deadline: competition.entriesDeadline?.toISOString() ?? null,
    }).catch((e: unknown) => this.log.warn(`Решение по заявке не отправлено на сайт: ${(e as Error).message}`));
  }

  /** Решение по заявке принимается один раз: повторное нажатие получает отказ. */
  private async decide(competitionId: string, entryId: string, status: "ACCEPTED" | "REJECTED", note: string | null) {
    const [row] = await this.db
      .update(onlineEntries)
      .set({ status, note, decidedAt: new Date() })
      .where(and(eq(onlineEntries.id, entryId), eq(onlineEntries.competitionId, competitionId), eq(onlineEntries.status, "NEW")))
      .returning();
    if (row) return row;
    const [exists] = await this.db
      .select({ id: onlineEntries.id })
      .from(onlineEntries)
      .where(and(eq(onlineEntries.id, entryId), eq(onlineEntries.competitionId, competitionId)));
    if (!exists) throw new NotFoundException("Заявка не найдена");
    throw new ConflictException("По этой заявке уже есть решение");
  }

  private requireRelay(): void {
    if (!this.enabled) {
      throw new ConflictException("Онлайн-заявки идут через сайт: на сервере в зале задайте RELAY_URL и RELAY_TOKEN");
    }
  }

  private async publish(competitionId: string, key: string, state: Pick<OnlineEntryCall, "open" | "deadline">) {
    const competition = await this.competitions.get(competitionId);
    const categories = (await this.results.categoryList(competitionId)).filter((c) => c.id).map((c) => c.name);
    const call: OnlineEntryCall = { name: competition.name, discipline: competition.discipline, categories, ...state };
    const decided = await this.db
      .select({ id: onlineEntries.id, status: onlineEntries.status, note: onlineEntries.note, decidedAt: onlineEntries.decidedAt })
      .from(onlineEntries)
      .where(eq(onlineEntries.competitionId, competitionId));
    const decisions: Record<string, OnlineEntryDecision> = {};
    for (const d of decided) {
      if (d.status !== "NEW" && d.decidedAt) decisions[d.id] = { status: d.status, note: d.note, decidedAt: d.decidedAt.toISOString() };
    }
    await this.request("PUT", `entries/${competitionId}`, { key, call, decisions });
  }

  private async request(method: "GET" | "PUT", path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.relayUrl(path), {
        method,
        headers: relayHeaders(this.config),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new BadGatewayException("Нет связи с сайтом соревнований: проверьте интернет в зале и повторите");
    }
    if (!response.ok) throw new BadGatewayException(`Сайт соревнований ответил ошибкой ${response.status}`);
    return response.json();
  }
}
