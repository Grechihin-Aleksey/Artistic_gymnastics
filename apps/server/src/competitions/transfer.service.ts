import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { eq, getTableColumns, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import { DB, MIGRATIONS_FOLDER, type Db } from "../db/db.module";
import { RelayPublisher } from "../relay/relay.publisher";
import {
  auditLog,
  categories,
  competitions,
  finalists,
  gymnasts,
  inquiries,
  judges,
  marks,
  onlineEntries,
  performances,
  series,
  shifts,
  teams,
} from "../db/schema";

/** Таблицы турнира в порядке вставки: сначала те, на кого ссылаются остальные. */
const TABLES = {
  competitions,
  categories,
  shifts,
  teams,
  gymnasts,
  judges,
  performances,
  marks,
  finalists,
  inquiries,
  auditLog,
  onlineEntries,
} satisfies Record<string, PgTable>;
type TableName = keyof typeof TABLES;

export const EXPORT_FORMAT = "ag-competition";
const EXPORT_VERSION = 1;

/** Миграции этой версии программы: файл из более новой версии сюда не загрузить. */
function migrationTags(): string[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  return journal.entries.map((e) => e.tag);
}

const importSchema = z.object({
  format: z.literal(EXPORT_FORMAT, "Это не файл турнира"),
  version: z.literal(EXPORT_VERSION, "Файл выгружен другой версией программы"),
  schema: z.string(),
  exportedAt: z.string(),
  data: z.object(
    Object.fromEntries(Object.keys(TABLES).map((name) => [name, z.array(z.record(z.string(), z.unknown()))])) as Record<
      TableName,
      z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>>
    >,
  ),
});
export type CompetitionExport = z.infer<typeof importSchema>;

/** По 500 строк за запрос: у Postgres предел на число параметров. */
const CHUNK = 500;

/** Перенос турнира на другой компьютер одним файлом и удаление турнира целиком. */
@Injectable()
export class TransferService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly relay: RelayPublisher,
  ) {}

  async export(competitionId: string): Promise<CompetitionExport> {
    const [competition] = await this.db.select().from(competitions).where(eq(competitions.id, competitionId));
    if (!competition) throw new NotFoundException("Соревнование не найдено");
    const [cats, shiftRows, teamRows, people, judgeRows, perfs, markRows, finalRows, inquiryRows, audit, entries] =
      await Promise.all([
        this.db.select().from(categories).where(eq(categories.competitionId, competitionId)),
        this.db.select().from(shifts).where(eq(shifts.competitionId, competitionId)),
        this.db.select().from(teams).where(eq(teams.competitionId, competitionId)),
        this.db.select().from(gymnasts).where(eq(gymnasts.competitionId, competitionId)),
        this.db.select().from(judges).where(eq(judges.competitionId, competitionId)),
        this.db.select().from(performances).where(eq(performances.competitionId, competitionId)),
        this.db
          .select({ mark: marks })
          .from(marks)
          .innerJoin(performances, eq(marks.performanceId, performances.id))
          .where(eq(performances.competitionId, competitionId))
          .then((rows) => rows.map((r) => r.mark)),
        this.db.select().from(finalists).where(eq(finalists.competitionId, competitionId)),
        this.db.select().from(inquiries).where(eq(inquiries.competitionId, competitionId)),
        this.db.select().from(auditLog).where(eq(auditLog.competitionId, competitionId)),
        this.db.select().from(onlineEntries).where(eq(onlineEntries.competitionId, competitionId)),
      ]);
    const tags = migrationTags();
    const data: Record<TableName, Record<string, unknown>[]> = {
      competitions: [competition],
      categories: cats,
      shifts: shiftRows,
      teams: teamRows,
      gymnasts: people,
      judges: judgeRows,
      performances: perfs,
      marks: markRows,
      finalists: finalRows,
      inquiries: inquiryRows,
      auditLog: audit,
      onlineEntries: entries,
    };
    return {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      schema: tags[tags.length - 1]!,
      exportedAt: new Date().toISOString(),
      data: JSON.parse(JSON.stringify(data)) as CompetitionExport["data"],
    };
  }

  /** Загружает турнир из файла с теми же id: QR-коды судей продолжают действовать. */
  async import(input: unknown): Promise<{ id: string; name: string }> {
    const parsed = importSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequestException(
        issue?.path.length === 1 && (issue.path[0] === "format" || issue.path[0] === "version")
          ? issue.message
          : "Файл повреждён или это не файл турнира",
      );
    }
    const file = parsed.data;
    if (!migrationTags().includes(file.schema)) {
      throw new UnprocessableEntityException("Файл выгружен из более новой версии программы. Обновите программу на этом компьютере");
    }
    const [competition] = file.data.competitions;
    if (!competition || file.data.competitions.length !== 1 || typeof competition.id !== "string") {
      throw new BadRequestException("Файл повреждён или это не файл турнира");
    }
    const id = competition.id;
    const [existing] = await this.db.select({ name: competitions.name }).from(competitions).where(eq(competitions.id, id));
    if (existing) {
      throw new ConflictException(
        `Турнир «${existing.name}» уже есть на этом компьютере. Чтобы загрузить его из файла заново, сначала удалите его`,
      );
    }
    try {
      await this.db.transaction(async (tx) => {
        for (const name of Object.keys(TABLES) as TableName[]) {
          const table = TABLES[name];
          const rows = file.data[name].map((row) => revive(table, row));
          // Все строки принадлежат загружаемому турниру, даже если файл правили вручную.
          if (name !== "competitions" && name !== "marks") for (const row of rows) row.competitionId = id;
          for (let i = 0; i < rows.length; i += CHUNK) await tx.insert(table as typeof auditLog).values(rows.slice(i, i + CHUNK) as (typeof auditLog.$inferInsert)[]);
        }
        await tx.insert(auditLog).values({
          competitionId: id,
          actor: "admin",
          action: "competition.imported",
          details: { exportedAt: file.exportedAt },
        });
      });
    } catch (e) {
      throw new UnprocessableEntityException(`Не удалось загрузить турнир: ${(e as Error).message}`);
    }
    this.relay.notify(id);
    return { id, name: String(competition.name) };
  }

  /** Удаляет турнир со всеми участниками, судьями, оценками и журналом; из кубков он пропадает. */
  async remove(competitionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const deleted = await tx.delete(competitions).where(eq(competitions.id, competitionId)).returning({ id: competitions.id });
      if (deleted.length === 0) throw new NotFoundException("Соревнование не найдено");
      await tx
        .update(series)
        .set({ stages: sql`(select coalesce(jsonb_agg(s), '[]'::jsonb) from jsonb_array_elements(${series.stages}) s where s <> to_jsonb(${competitionId}::text))` })
        .where(sql`${series.stages} ? ${competitionId}`);
    });
    // На сайте остаются последние отправленные результаты.
    this.relay.forget(competitionId);
  }
}

/** Строка из JSON обратно в значения для вставки: даты из строк, неизвестные поля отбрасываются. */
function revive(table: PgTable, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    if (!(key in row)) continue;
    const value = row[key];
    out[key] = column.columnType === "PgTimestamp" && typeof value === "string" ? new Date(value) : value;
  }
  return out;
}
