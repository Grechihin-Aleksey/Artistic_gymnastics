import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { apparatusFor, rotationOrder, shiftApparatus } from "@ag/scoring";
import { LIVE_EVENTS, type RotationView, type SetRotationInput, type SetShiftStartInput } from "@ag/shared";
import { and, asc, eq } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { competitions, gymnasts, shifts } from "../db/schema";
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
      this.db
        .select({ id: gymnasts.id, shift: gymnasts.shift })
        .from(gymnasts)
        .where(eq(gymnasts.competitionId, competitionId))
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

  private async changed(competitionId: string): Promise<RotationView> {
    const view = await this.view(competitionId);
    this.live.toCompetition(competitionId, LIVE_EVENTS.rotation, view);
    return view;
  }
}
