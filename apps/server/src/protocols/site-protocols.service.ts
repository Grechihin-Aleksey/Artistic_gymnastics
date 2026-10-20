import { BadGatewayException, ConflictException, Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { apparatusFor } from "@ag/scoring";
import { APPARATUS_NAMES, type ProtocolsIndex, type RelayProtocols } from "@ag/shared";
import { eq } from "drizzle-orm";
import { CompetitionsService } from "../competitions/competitions.service";
import { APP_CONFIG, relayHeaders, type AppConfig } from "../config";
import { DB, type Db } from "../db/db.module";
import { auditLog, competitions } from "../db/schema";
import { ResultsService } from "../results/results.service";
import { ProtocolsService } from "./protocols.service";

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Итоговые протоколы на сайте соревнований: зал собирает PDF по каждому разряду
 * (многоборье, снаряды, финалы, команды), общекомандный зачёт и Excel и выкладывает
 * их на ретранслятор одной отправкой. Публикуется только то, где есть результаты.
 */
@Injectable()
export class SiteProtocolsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly competitions: CompetitionsService,
    private readonly results: ResultsService,
    private readonly protocols: ProtocolsService,
  ) {}

  /** page — страница протоколов на сайте, её можно разослать клубам. */
  async view(competitionId: string): Promise<{ enabled: boolean; published: ProtocolsIndex | null; page: string | null }> {
    const competition = await this.competitions.get(competitionId);
    return {
      enabled: this.enabled,
      published: competition.siteProtocols,
      page: this.enabled ? `${this.relayUrl("widget/").toString()}#c=${competitionId}&view=docs` : null,
    };
  }

  async publish(competitionId: string) {
    this.requireRelay();
    const files = await this.collect(competitionId);
    if (files.length === 0) throw new ConflictException("Утверждённых оценок пока нет: выкладывать нечего");
    const index = (await this.request("PUT", competitionId, { files })) as ProtocolsIndex;
    await this.db.transaction(async (tx) => {
      await tx.update(competitions).set({ siteProtocols: index }).where(eq(competitions.id, competitionId));
      await tx.insert(auditLog).values({ competitionId, actor: "admin", action: "protocols.published", details: { count: index.files.length } });
    });
    return this.view(competitionId);
  }

  async unpublish(competitionId: string) {
    this.requireRelay();
    await this.competitions.get(competitionId);
    await this.request("DELETE", competitionId);
    await this.db.transaction(async (tx) => {
      await tx.update(competitions).set({ siteProtocols: null }).where(eq(competitions.id, competitionId));
      await tx.insert(auditLog).values({ competitionId, actor: "admin", action: "protocols.unpublished", details: {} });
    });
    return this.view(competitionId);
  }

  /** Файлы для сайта по порядку списка: разряд за разрядом, в конце общие документы. */
  async collect(competitionId: string): Promise<RelayProtocols["files"]> {
    const competition = await this.competitions.get(competitionId);
    const program = apparatusFor(competition.discipline);
    const files: RelayProtocols["files"] = [];
    const add = (file: string, title: string, group: string, data: Buffer) =>
      files.push({ file, title, group, data: data.toString("base64") });
    const categories = await this.results.categoryList(competitionId);
    for (const [i, c] of categories.entries()) {
      const n = i + 1;
      if ((await this.results.allAround(competitionId, c.id)).length > 0) {
        add(`all-around-${n}.pdf`, "Многоборье", c.name, await this.protocols.allAround(competitionId, c.id));
      }
      for (const a of program) {
        if ((await this.results.apparatus(competitionId, a, "average", c.id)).length > 0) {
          add(`${a.toLowerCase()}-${n}.pdf`, APPARATUS_NAMES[a]!, c.name, await this.protocols.apparatus(competitionId, a, c.id));
        }
      }
      for (const a of program) {
        if ((await this.results.apparatus(competitionId, a, "average", c.id, "FINAL")).length > 0) {
          add(`final-${a.toLowerCase()}-${n}.pdf`, `Финал: ${APPARATUS_NAMES[a]}`, c.name, await this.protocols.apparatus(competitionId, a, c.id, "FINAL"));
        }
      }
      const teams = await this.results.teams(competitionId, c.id).catch((e: unknown) => {
        if (e instanceof UnprocessableEntityException) return [];
        throw e;
      });
      if (teams.length > 0) add(`teams-${n}.pdf`, "Командный зачёт", c.name, await this.protocols.teams(competitionId, c.id));
    }
    if (files.length === 0) return files;
    if ((await this.results.clubs(competitionId)).rows.length > 0) {
      add("clubs.pdf", "Общекомандный зачёт", "", await this.protocols.clubs(competitionId));
    }
    add("results.xlsx", "Все итоги в Excel", "", await this.protocols.workbook(competitionId));
    return files;
  }

  private relayUrl(path: string): URL {
    return new URL(path, this.config.relayUrl!.replace(/\/?$/, "/"));
  }

  private get enabled(): boolean {
    return Boolean(this.config.relayUrl && this.config.relayToken);
  }

  private requireRelay(): void {
    if (!this.enabled) {
      throw new ConflictException("Протоколы выкладываются на сайт соревнований: на сервере в зале задайте RELAY_URL и RELAY_TOKEN");
    }
  }

  private async request(method: "PUT" | "DELETE", competitionId: string, body?: RelayProtocols): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.relayUrl(`protocols/${competitionId}`), {
        method,
        headers: relayHeaders(this.config),
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new BadGatewayException("Нет связи с сайтом соревнований: проверьте интернет в зале и повторите");
    }
    if (!response.ok) throw new BadGatewayException(`Сайт соревнований ответил ошибкой ${response.status}`);
    return response.json();
  }
}
