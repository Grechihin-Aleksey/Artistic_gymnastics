import { Inject, Injectable } from "@nestjs/common";
import { fromPoints, type Apparatus } from "@ag/scoring";
import {
  APPARATUS_NAMES,
  GYMNAST_STATUS_NAMES,
  scoreLabels,
  type AuditEntry,
  type AuditGroup,
  type GymnastStatus,
  type Rules,
} from "@ag/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { CompetitionsService } from "../competitions/competitions.service";
import { DB, type Db } from "../db/db.module";
import { auditLog, gymnasts, judges, performances } from "../db/schema";

type Details = Record<string, unknown>;
type Judge = { name: string; role: string; seat: number; apparatus: Apparatus };
type Performance = { apparatus: Apparatus; attempt: number; gymnastId: string };

const fmt = (points: unknown) => (typeof points === "number" ? fromPoints(Math.abs(points)).toFixed(3) : "—");
const balls = (value: unknown) => (typeof value === "number" ? value.toFixed(3) : "—");

const FIELD_NAMES: Record<string, string> = {
  bib: "номер",
  lastName: "фамилия",
  firstName: "имя",
  middleName: "отчество",
  club: "клуб",
  birthDate: "дата рождения",
  city: "город",
  coach: "тренер",
  status: "статус",
  category: "разряд",
  team: "команда",
  shift: "смена",
};

/**
 * Журнал изменений: кто и когда ставил и менял оценки, разбирал запросы,
 * правил участников и настройки. Записи пишут сервисы в момент изменения,
 * здесь они только переводятся на понятный язык.
 */
@Injectable()
export class AuditService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly competitions: CompetitionsService,
  ) {}

  /** Новые сверху; group — только один раздел. */
  async list(competitionId: string, group?: AuditGroup): Promise<AuditEntry[]> {
    const competition = await this.competitions.get(competitionId);
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.competitionId, competitionId))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id));

    const judgeRows = await this.db
      .select({ id: judges.id, name: judges.name, role: judges.role, seat: judges.seat, apparatus: judges.apparatus })
      .from(judges)
      .where(eq(judges.competitionId, competitionId));
    const judgeById = new Map<string, Judge>(judgeRows.map((j) => [j.id, j]));
    const performanceIds = [...new Set(rows.map((r) => (r.details as Details).performanceId).filter((id): id is string => typeof id === "string"))];
    const performanceById = new Map<string, Performance>(
      performanceIds.length === 0
        ? []
        : (
            await this.db
              .select({ id: performances.id, apparatus: performances.apparatus, attempt: performances.attempt, gymnastId: performances.gymnastId })
              .from(performances)
              .where(and(eq(performances.competitionId, competitionId), inArray(performances.id, performanceIds)))
          ).map((p) => [p.id, p]),
    );
    const people = await this.db
      .select({ id: gymnasts.id, bib: gymnasts.bib, lastName: gymnasts.lastName, firstName: gymnasts.firstName })
      .from(gymnasts)
      .where(eq(gymnasts.competitionId, competitionId));
    const personById = new Map(people.map((g) => [g.id, `№${g.bib} ${g.lastName} ${g.firstName}`]));

    const entries = rows.map((row): AuditEntry => {
      const details = row.details as Details;
      const perf = typeof details.performanceId === "string" ? performanceById.get(details.performanceId) : undefined;
      const described = describe(row.action, details, {
        rules: competition.rules,
        person: (id: unknown) => (typeof id === "string" ? (personById.get(id) ?? "участник удалён") : "—"),
        judge: (id: unknown) => (typeof id === "string" ? judgeById.get(id) : undefined),
      });
      const gymnastId = perf?.gymnastId ?? (typeof details.gymnastId === "string" ? details.gymnastId : null);
      const deleted = typeof details.bib === "number" ? `№${details.bib} ${String(details.name)}` : null;
      return {
        id: row.id,
        at: row.createdAt.toISOString(),
        actor: actorLabel(row.actor, judgeById),
        group: described.group,
        action: row.action,
        apparatus: perf?.apparatus ?? described.apparatus ?? null,
        gymnast: gymnastId ? (personById.get(gymnastId) ?? deleted) : deleted,
        text: perf?.apparatus === "VT" && perf.attempt > 1 ? `${described.text} (прыжок ${perf.attempt})` : described.text,
      };
    });
    return group ? entries.filter((e) => e.group === group) : entries;
  }
}

const judgeRole = (j: Judge) => (j.role === "SUPERVISOR" ? "Старший судья" : `Судья ${j.role}${j.seat}`);

function judgeLabel(j: Judge): string {
  return `${judgeRole(j)} · ${APPARATUS_NAMES[j.apparatus]} · ${j.name}`;
}

function actorLabel(actor: string, judgeById: Map<string, Judge>): string {
  if (actor === "admin") return "Секретариат";
  const judge = actor.startsWith("judge:") ? judgeById.get(actor.slice(6)) : undefined;
  // Снаряд судьи — в своей колонке записи.
  return judge ? `${judgeRole(judge)} · ${judge.name}` : "Судья";
}

interface Context {
  rules: Rules;
  person: (id: unknown) => string;
  judge: (id: unknown) => Judge | undefined;
}

/** Текст записи журнала по её действию и подробностям. */
export function describe(
  action: string,
  d: Details,
  ctx: Context,
): { group: AuditGroup; text: string; apparatus?: Apparatus } {
  const labels = scoreLabels(ctx.rules);
  const kind = (k: unknown) => (k === "D" ? labels.d : k === "E" ? "сбавка E" : "нейтральная сбавка");
  switch (action) {
    case "mark.changed":
      return { group: "marks", text: `Изменена оценка (${kind(d.kind)}): ${fmt(d.from)} → ${fmt(d.to)}` };
    case "marks.entered_from_tablet": {
      const marks = (d.marks as { judgeId: string; kind: string; value: number }[] | undefined) ?? [];
      const part = (k: string, title: string) => {
        const values = marks.filter((m) => m.kind === k).map((m) => fmt(m.value));
        return values.length > 0 ? `${title} ${values.join(", ")}` : null;
      };
      const text = [part("D", labels.d), part("E", "сбавки E"), part("NEUTRAL", "нейтральная")].filter(Boolean).join("; ");
      return { group: "marks", text: `Оценки бригады введены с планшета старшего судьи: ${text}` };
    }
    case "performance.approved":
      return {
        group: "marks",
        text: `Оценка утверждена: ${labels.d} ${fmt(d.d)}, ${labels.e} ${fmt(d.e)}${typeof d.neutral === "number" && d.neutral > 0 ? `, сбавки ${fmt(d.neutral)}` : ""}, итог ${fmt(d.total)}`,
      };
    case "performance.reopened":
      return { group: "marks", text: `Оценка ${fmt(d.previousTotal)} возвращена на правку: ${String(d.reason ?? "")}` };
    case "inquiry.created":
      return {
        group: "inquiries",
        text: `Запрос на пересмотр ${labels.d} от тренера ${String(d.coach)}${typeof d.claimedD === "number" ? `, заявлено ${balls(d.claimedD)}` : ""}${d.late ? ", подан после срока" : ""}`,
      };
    case "inquiry.accepted":
      return {
        group: "inquiries",
        text: `Запрос удовлетворён: ${labels.d} ${fmt(d.previousD)} → ${fmt(d.newD)}${d.previousTotal !== undefined ? `, прежний итог ${fmt(d.previousTotal)}` : ""}`,
      };
    case "inquiry.rejected":
      return { group: "inquiries", text: `Запрос отклонён, ${labels.d} остаётся ${fmt(d.previousD)}` };
    case "draw.random":
    case "draw.manual": {
      const bibs = (d.bibs as { from: number; to: number }[] | undefined) ?? [];
      const changed = bibs.filter((b) => b.from !== b.to).length;
      return { group: "roster", text: `Жеребьёвка номеров (${action === "draw.random" ? "случайная" : "ручная"}): изменено номеров — ${changed}` };
    }
    case "gymnast.added":
      return { group: "roster", text: "Участник добавлен" };
    case "gymnasts.imported":
      return { group: "roster", text: `Загружен список участников: ${String(d.count)} чел.` };
    case "gymnast.deleted":
      return { group: "roster", text: "Участник удалён из списка" };
    case "gymnast.updated": {
      const changes = (d.changes as Record<string, { from: unknown; to: unknown }> | undefined) ?? {};
      const value = (field: string, v: unknown) =>
        v === null || v === undefined || v === "" ? "пусто" : field === "status" ? GYMNAST_STATUS_NAMES[v as GymnastStatus] : String(v);
      const parts = Object.entries(changes).map(([field, c]) => `${FIELD_NAMES[field] ?? field}: ${value(field, c.from)} → ${value(field, c.to)}`);
      return { group: "roster", text: `Изменены данные участника: ${parts.join("; ")}` };
    }
    case "entries.opened":
      return {
        group: "setup",
        text: `Открыт приём онлайн-заявок${typeof d.deadline === "string" ? ` до ${new Date(d.deadline).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}` : ""}`,
      };
    case "entries.closed":
      return { group: "setup", text: "Приём онлайн-заявок закрыт" };
    case "entries.accepted":
      return { group: "roster", text: `Принята онлайн-заявка клуба «${String(d.club)}»: ${String(d.count)} чел. добавлено в список` };
    case "entries.rejected":
      return { group: "roster", text: `Отклонена онлайн-заявка клуба «${String(d.club)}»${d.note ? `: ${String(d.note)}` : ""}` };
    case "finals.created":
      return {
        group: "setup",
        text: `Сформированы финалы: по ${String(d.size)} в финал, запасных ${String(d.reserves)}${typeof d.perClub === "number" ? `, от клуба не больше ${d.perClub}` : ""}`,
      };
    case "finals.phase":
      return { group: "setup", text: d.phase === "FINAL" ? "Начаты финалы на снарядах" : "Возврат к квалификации" };
    case "finals.replaced":
      return {
        group: "setup",
        apparatus: d.apparatus as Apparatus,
        text: `Финалист ${ctx.person(d.out)} заменён запасным ${ctx.person(d.in)}`,
      };
    case "protocols.published":
      return { group: "setup", text: `Протоколы выложены на сайт: файлов — ${String(d.count)}` };
    case "protocols.unpublished":
      return { group: "setup", text: "Протоколы сняты с сайта" };
    case "ceremony.shown":
      return { group: "setup", text: "Награждение выведено на табло" };
    case "ceremony.hidden":
      return { group: "setup", text: "Награждение убрано с табло" };
    case "rules.changed":
      return { group: "setup", text: `Изменены правила судейства: ${d.rules === "CUSTOM" ? "свои (база по разряду)" : "FIG"}` };
    case "judge.added":
    case "judge.token_reissued": {
      const judge = ctx.judge(d.judgeId);
      const who = judge ? judgeLabel(judge) : "судья";
      return {
        group: "setup",
        ...(judge ? { apparatus: judge.apparatus } : {}),
        text: action === "judge.added" ? `Заведён судья: ${who}` : `Выдан новый QR-код: ${who}, прежний больше не действует`,
      };
    }
    default:
      return { group: "setup", text: action };
  }
}
