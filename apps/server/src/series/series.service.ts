import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { birthYear, type SeriesInput, type SeriesStandingRow, type SeriesStandings, type SeriesView } from "@ag/shared";
import { asc, eq, inArray } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { competitions, gymnasts, series } from "../db/schema";
import { ResultsService } from "../results/results.service";

type Row = typeof series.$inferSelect;

const toView = (r: Row): SeriesView => ({ id: r.id, name: r.name, points: r.points, best: r.best, stages: r.stages });

/** Один и тот же спортсмен на разных этапах: фамилия, имя и год рождения. */
const personKey = (g: { lastName: string; firstName: string; birthDate: string | null }) =>
  [g.lastName, g.firstName, birthYear(g.birthDate)].map((v) => v.trim().toLowerCase().replace(/ё/g, "е")).join("|");

/**
 * Кубок из нескольких этапов. Каждое соревнование — этап; за место в многоборье
 * в своём разряде участник получает очки по таблице, итог — сумма лучших этапов.
 * При равенстве выше тот, у кого больше 1-х, затем 2-х и 3-х мест.
 */
@Injectable()
export class SeriesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly results: ResultsService,
  ) {}

  async list(): Promise<SeriesView[]> {
    return (await this.db.select().from(series).orderBy(asc(series.createdAt))).map(toView);
  }

  async get(id: string): Promise<SeriesView> {
    const [row] = await this.db.select().from(series).where(eq(series.id, id));
    if (!row) throw new NotFoundException("Кубок не найден");
    return toView(row);
  }

  async create(input: SeriesInput): Promise<SeriesView> {
    await this.checkStages(input.stages);
    const [row] = await this.db.insert(series).values(input).returning();
    return toView(row!);
  }

  async update(id: string, input: SeriesInput): Promise<SeriesView> {
    await this.checkStages(input.stages);
    const [row] = await this.db.update(series).set(input).where(eq(series.id, id)).returning();
    if (!row) throw new NotFoundException("Кубок не найден");
    return toView(row);
  }

  async remove(id: string): Promise<{ deleted: string }> {
    const [row] = await this.db.delete(series).where(eq(series.id, id)).returning();
    if (!row) throw new NotFoundException("Кубок не найден");
    return { deleted: row.id };
  }

  async standings(id: string): Promise<SeriesStandings> {
    const view = await this.get(id);
    const known = view.stages.length
      ? await this.db.select({ id: competitions.id, name: competitions.name }).from(competitions).where(inArray(competitions.id, view.stages))
      : [];
    const stages = view.stages.map((s) => known.find((c) => c.id === s)).filter((c): c is { id: string; name: string } => Boolean(c));

    const categories = new Map<string, { name: string; people: Map<string, SeriesStandingRow> }>();
    for (const [index, stage] of stages.entries()) {
      const people = await this.db
        .select({ id: gymnasts.id, birthDate: gymnasts.birthDate })
        .from(gymnasts)
        .where(eq(gymnasts.competitionId, stage.id));
      const birth = new Map(people.map((p) => [p.id, p.birthDate]));
      for (const category of await this.results.categoryList(stage.id)) {
        const title = category.name || "Общий зачёт";
        const key = title.trim().toLowerCase();
        let group = categories.get(key);
        if (!group) categories.set(key, (group = { name: title, people: new Map() }));
        for (const r of await this.results.allAround(stage.id, category.id)) {
          if (!r.complete) continue;
          const g = { ...r.gymnast, birthDate: birth.get(r.gymnast.id) ?? null };
          const pk = personKey(g);
          let row = group.people.get(pk);
          if (!row) {
            row = {
              rank: 0,
              name: `${g.lastName} ${g.firstName}`,
              club: null,
              birthYear: birthYear(g.birthDate),
              total: 0,
              stages: stages.map(() => null),
              dropped: [],
              places: [0, 0, 0],
            };
            group.people.set(pk, row);
          }
          // Клуб и написание имени — с последнего этапа.
          row.name = `${g.lastName} ${g.firstName}`;
          row.club = g.club?.trim() || row.club;
          row.stages[index] = view.points[r.rank - 1] ?? 0;
          if (r.rank <= 3) row.places[r.rank - 1]!++;
        }
      }
    }

    const order = (a: SeriesStandingRow, b: SeriesStandingRow) =>
      b.total - a.total || b.places[0] - a.places[0] || b.places[1] - a.places[1] || b.places[2] - a.places[2];
    const result = [...categories.values()].map(({ name, people }) => {
      const rows = [...people.values()];
      for (const row of rows) {
        const counted = row.stages
          .map((p, i) => ({ p, i }))
          .filter((s): s is { p: number; i: number } => s.p !== null)
          .sort((a, b) => b.p - a.p || a.i - b.i);
        const kept = view.best === null ? counted : counted.slice(0, view.best);
        row.total = kept.reduce((sum, s) => sum + s.p, 0);
        row.dropped = counted.slice(kept.length).map((s) => s.i).sort((a, b) => a - b);
      }
      rows.sort((a, b) => order(a, b) || a.name.localeCompare(b.name, "ru"));
      rows.forEach((r, i) => (r.rank = i > 0 && order(rows[i - 1]!, r) === 0 ? rows[i - 1]!.rank : i + 1));
      return { name, rows };
    });
    return { series: view, stages, categories: result.filter((c) => c.rows.length > 0) };
  }

  private async checkStages(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const found = await this.db.select({ id: competitions.id }).from(competitions).where(inArray(competitions.id, ids));
    if (found.length !== ids.length) throw new BadRequestException("Среди этапов есть несуществующее соревнование");
  }
}
