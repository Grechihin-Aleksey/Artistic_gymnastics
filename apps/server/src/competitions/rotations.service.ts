import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomInt } from "node:crypto";
import { apparatusFor, defaultStart, rotationOrder, shiftApparatus } from "@ag/scoring";
import {
  LIVE_EVENTS,
  type DistributeShiftsInput,
  type DrawInput,
  type DrawView,
  type RotationView,
  type SetRotationInput,
  type SetShiftStartInput,
} from "@ag/shared";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { auditLog, categories, competitions, gymnasts, performances, shifts } from "../db/schema";
import { LiveGateway } from "../live/live.gateway";
import { CompetitionsService } from "./competitions.service";

/** Смены и ротации: какая смена на каком снаряде и в каком порядке выходит. */
@Injectable()
export class RotationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly competitions: CompetitionsService,
    private readonly live: LiveGateway,
  ) {}

  async view(competitionId: string): Promise<RotationView> {
    const competition = await this.competitions.get(competitionId);
    const [shiftRows, people] = await Promise.all([
      this.db.select().from(shifts).where(eq(shifts.competitionId, competitionId)).orderBy(asc(shifts.number)),
      // Не явившиеся и снявшиеся из очереди выхода выпадают.
      this.db
        .select({ id: gymnasts.id, shift: gymnasts.shift })
        .from(gymnasts)
        .where(and(eq(gymnasts.competitionId, competitionId), eq(gymnasts.status, "ACTIVE")))
        .orderBy(asc(gymnasts.startOrder), asc(gymnasts.bib)),
    ]);
    return {
      rotation: competition.rotation,
      rotations: apparatusFor(competition.discipline).length,
      shifts: shiftRows.map((s) => ({
        number: s.number,
        startApparatus: s.startApparatus,
        apparatus: shiftApparatus(competition.discipline, s.startApparatus, competition.rotation),
        gymnastIds: rotationOrder(
          people.filter((g) => g.shift === s.number).map((g) => g.id),
          competition.rotation,
        ),
      })),
    };
  }

  async setStart(competitionId: string, number: number, input: SetShiftStartInput): Promise<RotationView> {
    const competition = await this.competitions.get(competitionId);
    if (!apparatusFor(competition.discipline).includes(input.startApparatus)) {
      throw new BadRequestException(`Снаряда ${input.startApparatus} нет в программе ${competition.discipline}`);
    }
    const [row] = await this.db
      .update(shifts)
      .set({ startApparatus: input.startApparatus })
      .where(and(eq(shifts.competitionId, competitionId), eq(shifts.number, number)))
      .returning();
    if (!row) throw new NotFoundException(`Смены ${number} нет`);
    return this.changed(competitionId);
  }

  async setRotation(competitionId: string, input: SetRotationInput): Promise<RotationView> {
    const competition = await this.competitions.get(competitionId);
    const rotations = apparatusFor(competition.discipline).length;
    if (input.rotation >= rotations) {
      throw new BadRequestException(`Ротаций всего ${rotations}`);
    }
    await this.db.update(competitions).set({ rotation: input.rotation }).where(eq(competitions.id, competitionId));
    return this.changed(competitionId);
  }

  async drawView(competitionId: string): Promise<DrawView> {
    await this.competitions.get(competitionId);
    const [started] = await this.db
      .select({ id: performances.id })
      .from(performances)
      .where(eq(performances.competitionId, competitionId))
      .limit(1);
    const [last] = await this.db
      .select({ action: auditLog.action, at: auditLog.createdAt })
      .from(auditLog)
      .where(and(eq(auditLog.competitionId, competitionId), inArray(auditLog.action, ["draw.random", "draw.manual"])))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    return {
      started: Boolean(started),
      last: last ? { mode: last.action === "draw.random" ? "random" : "manual", at: last.at.toISOString() } : null,
    };
  }

  /**
   * Жеребьёвка: новые стартовые номера и порядок выхода в сменах.
   * Только до первых оценок — потом номера уже в протоколах.
   */
  async draw(competitionId: string, input: DrawInput): Promise<DrawView> {
    if ((await this.drawView(competitionId)).started) {
      throw new ConflictException("Соревнование уже идёт: после первых оценок жеребьёвку не проводят");
    }
    const people = await this.db
      .select({
        id: gymnasts.id,
        bib: gymnasts.bib,
        lastName: gymnasts.lastName,
        firstName: gymnasts.firstName,
        teamId: gymnasts.teamId,
        shift: gymnasts.shift,
        startOrder: gymnasts.startOrder,
        category: categories.position,
      })
      .from(gymnasts)
      .leftJoin(categories, eq(categories.id, gymnasts.categoryId))
      .where(eq(gymnasts.competitionId, competitionId));
    if (people.length === 0) throw new BadRequestException("Сначала загрузите участников");

    // Новый номер каждого участника.
    const bibs = new Map(people.map((g) => [g.id, g.bib]));
    if (input.mode === "random") {
      // Группы — смены по номеру (без смены — в конце); если смен нет, разряды.
      const byShift = people.some((g) => g.shift !== null);
      const key = (g: (typeof people)[number]) => (byShift ? g.shift : g.category) ?? Number.MAX_SAFE_INTEGER;
      const groups = [...new Set(people.map(key))].sort((a, b) => a - b);
      let next = input.firstBib;
      for (const group of groups) {
        const members = people.filter((g) => key(g) === group);
        // Блоки: команда целиком или один участник; блоки и участники в блоке — в случайном порядке.
        const blocks = new Map<string, typeof members>();
        for (const g of members) {
          const block = input.keepTeams && g.teamId ? `team:${g.teamId}` : `one:${g.id}`;
          blocks.set(block, [...(blocks.get(block) ?? []), g]);
        }
        for (const block of shuffle([...blocks.values()])) {
          for (const g of shuffle(block)) bibs.set(g.id, next++);
        }
      }
    } else {
      const known = new Set(people.map((g) => g.id));
      for (const { gymnastId, bib } of input.bibs) {
        if (!known.has(gymnastId)) throw new BadRequestException("Участник не найден в этом соревновании");
        bibs.set(gymnastId, bib);
      }
      const owners = new Map<number, string[]>();
      for (const g of people) {
        const bib = bibs.get(g.id)!;
        owners.set(bib, [...(owners.get(bib) ?? []), `${g.lastName} ${g.firstName}`]);
      }
      const repeated = [...owners].filter(([, names]) => names.length > 1);
      if (repeated.length > 0) {
        throw new BadRequestException(
          `Номера повторяются: ${repeated.map(([bib, names]) => `№${bib} — ${names.join(", ")}`).join("; ")}`,
        );
      }
    }

    // Порядок выхода в смене — по возрастанию номеров.
    const order = new Map<string, number>();
    for (const shift of new Set(people.map((g) => g.shift))) {
      if (shift === null) continue;
      people
        .filter((g) => g.shift === shift)
        .sort((a, b) => bibs.get(a.id)! - bibs.get(b.id)!)
        .forEach((g, i) => order.set(g.id, i + 1));
    }

    await this.db.transaction(async (tx) => {
      // Номера уникальны в соревновании: сначала убираем старые во временные отрицательные.
      for (const g of people) await tx.update(gymnasts).set({ bib: -g.bib }).where(eq(gymnasts.id, g.id));
      for (const g of people) {
        await tx
          .update(gymnasts)
          .set({ bib: bibs.get(g.id)!, startOrder: order.get(g.id) ?? null })
          .where(eq(gymnasts.id, g.id));
      }
      await tx.insert(auditLog).values({
        competitionId,
        actor: "admin",
        action: `draw.${input.mode}`,
        details: { bibs: people.map((g) => ({ gymnastId: g.id, from: g.bib, to: bibs.get(g.id) })) },
      });
    });
    await this.changed(competitionId);
    return this.drawView(competitionId);
  }

  /**
   * Делит участников на смены или убирает смены совсем. Разряды (или команды
   * и участники по порядку разрядов) идут подряд и делятся на смены как можно
   * ровнее; команда не разрывается. Только до первых оценок.
   */
  async distribute(competitionId: string, input: DistributeShiftsInput): Promise<RotationView> {
    const competition = await this.competitions.get(competitionId);
    if ((await this.drawView(competitionId)).started) {
      throw new ConflictException("Соревнование уже идёт: после первых оценок смены не меняют");
    }
    const people = await this.db
      .select({ id: gymnasts.id, bib: gymnasts.bib, teamId: gymnasts.teamId, categoryId: gymnasts.categoryId, category: categories.position })
      .from(gymnasts)
      .leftJoin(categories, eq(categories.id, gymnasts.categoryId))
      .where(eq(gymnasts.competitionId, competitionId));
    if (people.length === 0) throw new BadRequestException("Сначала загрузите участников");

    const shiftOf = new Map<string, number | null>(people.map((g) => [g.id, null]));
    if (input.shifts > 0) {
      const last = Number.MAX_SAFE_INTEGER;
      const sorted = [...people].sort((a, b) => (a.category ?? last) - (b.category ?? last) || a.bib - b.bib);
      const blocks = new Map<string, typeof people>();
      for (const g of sorted) {
        const key = input.byCategory ? `category:${g.categoryId ?? "none"}` : g.teamId ? `team:${g.teamId}` : `one:${g.id}`;
        blocks.set(key, [...(blocks.get(key) ?? []), g]);
      }
      const list = [...blocks.values()];
      if (list.length < input.shifts) {
        throw new BadRequestException(
          input.byCategory
            ? `Разрядов ${list.length}, а смен ${input.shifts}: разряд целиком не делится. Уменьшите число смен или делите поровну`
            : `Участников и команд ${list.length}, на ${input.shifts} смен не хватает`,
        );
      }
      splitEvenly(list.map((b) => b.length), input.shifts).forEach((shift, i) => {
        for (const g of list[i]!) shiftOf.set(g.id, shift);
      });
    }

    await this.db.transaction(async (tx) => {
      // Стартовые снаряды оставшихся смен, выбранные секретариатом, сохраняются.
      const known = await tx.select().from(shifts).where(eq(shifts.competitionId, competitionId));
      await tx.delete(shifts).where(eq(shifts.competitionId, competitionId));
      for (let number = 1; number <= input.shifts; number++) {
        const startApparatus = known.find((s) => s.number === number)?.startApparatus ?? defaultStart(competition.discipline, number);
        await tx.insert(shifts).values({ competitionId, number, startApparatus });
      }
      // Порядок выхода в смене — по возрастанию номеров.
      const order = new Map<string, number>();
      for (let number = 1; number <= input.shifts; number++) {
        people
          .filter((g) => shiftOf.get(g.id) === number)
          .sort((a, b) => a.bib - b.bib)
          .forEach((g, i) => order.set(g.id, i + 1));
      }
      for (const g of people) {
        await tx
          .update(gymnasts)
          .set({ shift: shiftOf.get(g.id) ?? null, startOrder: order.get(g.id) ?? null })
          .where(eq(gymnasts.id, g.id));
      }
      await tx.update(competitions).set({ rotation: 0 }).where(eq(competitions.id, competitionId));
      await tx.insert(auditLog).values({
        competitionId,
        actor: "admin",
        action: "shifts.distributed",
        details: { shifts: input.shifts, byCategory: input.byCategory },
      });
    });
    return this.changed(competitionId);
  }

  private async changed(competitionId: string): Promise<RotationView> {
    const view = await this.view(competitionId);
    this.live.toCompetition(competitionId, LIVE_EVENTS.rotation, view);
    return view;
  }
}

/**
 * Делит блоки (размеры по порядку) на count подряд идущих групп так, чтобы
 * самая большая группа была как можно меньше. Номер группы каждого блока — с 1.
 */
export function splitEvenly(sizes: number[], count: number): number[] {
  const n = sizes.length;
  const prefix = [0];
  for (const size of sizes) prefix.push(prefix.at(-1)! + size);
  const sum = (from: number, to: number) => prefix[to]! - prefix[from]!;
  // best[k][i] — наименьший максимум, если первые i блоков разбиты на k групп; cut — где началась последняя.
  const best = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  const cut = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(0));
  best[0]![0] = 0;
  for (let k = 1; k <= count; k++) {
    for (let i = k; i <= n; i++) {
      for (let j = k - 1; j < i; j++) {
        const value = Math.max(best[k - 1]![j]!, sum(j, i));
        if (value <= best[k]![i]!) {
          best[k]![i] = value;
          cut[k]![i] = j;
        }
      }
    }
  }
  const groups = new Array<number>(n);
  for (let k = count, i = n; k > 0; k--) {
    const j = cut[k]![i]!;
    for (let b = j; b < i; b++) groups[b] = k;
    i = j;
  }
  return groups;
}

/** Случайная перестановка (Фишер — Йетс) на криптографическом генераторе. */
function shuffle<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
