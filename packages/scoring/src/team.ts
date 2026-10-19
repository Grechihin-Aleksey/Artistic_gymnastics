import { rank, type Ranked } from "./ranking.ts";
import { apparatusFor, type Apparatus, type Discipline, type ScoreBreakdown } from "./types.ts";
import type { Points } from "./points.ts";

/** Формат командного зачёта, например 5-4-3: в составе 5, выступают 4, идут в зачёт 3. */
export interface TeamFormat {
  roster: number;
  perApparatus: number;
  counting: number;
}

export const QUALIFICATION_5_4_3: TeamFormat = { roster: 5, perApparatus: 4, counting: 3 };
export const FINAL_5_3_3: TeamFormat = { roster: 5, perApparatus: 3, counting: 3 };

export interface TeamEntry<Id = string, MemberId = string> {
  id: Id;
  members: readonly {
    id: MemberId;
    scores: Partial<Record<Apparatus, ScoreBreakdown>>;
  }[];
}

export interface TeamApparatusResult<MemberId = string> {
  apparatus: Apparatus;
  total: Points;
  /** Участники, чьи оценки пошли в зачёт, по убыванию оценки. */
  counted: MemberId[];
}

export interface TeamResult<Id = string, MemberId = string> {
  id: Id;
  total: Points;
  /** Сумма без самой низкой зачётной оценки, для разрешения равенства. */
  tieBreak: Points;
  byApparatus: TeamApparatusResult<MemberId>[];
}

export function teamTotal<Id, MemberId>(
  discipline: Discipline,
  format: TeamFormat,
  team: TeamEntry<Id, MemberId>,
): TeamResult<Id, MemberId> {
  if (team.members.length > format.roster) {
    throw new RangeError(`В команде ${team.members.length} участников, допускается ${format.roster}`);
  }
  const countedScores: Points[] = [];
  const byApparatus = apparatusFor(discipline).map((apparatus) => {
    const performed = team.members
      .flatMap((m) => {
        const s = m.scores[apparatus];
        return s ? [{ id: m.id, total: s.total }] : [];
      })
      .sort((a, b) => b.total - a.total);
    if (performed.length > format.perApparatus) {
      throw new RangeError(
        `На снаряде ${apparatus} выступили ${performed.length}, допускается ${format.perApparatus}`,
      );
    }
    const counted = performed.slice(0, format.counting);
    countedScores.push(...counted.map((c) => c.total));
    return {
      apparatus,
      total: counted.reduce((acc, c) => acc + c.total, 0),
      counted: counted.map((c) => c.id),
    };
  });
  const total = byApparatus.reduce((acc, a) => acc + a.total, 0);
  const lowest = countedScores.length > 0 ? Math.min(...countedScores) : 0;
  return { id: team.id, total, tieBreak: total - lowest, byApparatus };
}

export function rankTeams<Id, MemberId>(
  discipline: Discipline,
  format: TeamFormat,
  teams: readonly TeamEntry<Id, MemberId>[],
): Ranked<TeamResult<Id, MemberId>>[] {
  const results = teams.map((t) => teamTotal(discipline, format, t));
  return rank(results, (r) => [r.total, r.tieBreak]);
}
