import type { BoardSnapshot, GymnastView, LiveApparatus } from "@ag/shared";

type Apparatus = LiveApparatus["apparatus"];

/** Клуб для сравнения: без регистра и лишних пробелов. */
export const clubKey = (club: string | null | undefined) => club?.trim().toLowerCase() ?? "";

export interface ClubGymnast {
  gymnast: GymnastView;
  category: string;
  /** Многоборье: место и сумма; complete — выступил(а) на всех снарядах. */
  allAround: { rank: number; total: number; complete: boolean } | null;
  apparatus: { apparatus: Apparatus; rank: number; total: number }[];
  /** Где выступает прямо сейчас. */
  now: Apparatus | null;
}

/** Клубы, у которых есть участники с оценками или на снарядах сейчас, по алфавиту. */
export function clubList(data: BoardSnapshot): string[] {
  const names = new Map<string, string>();
  const add = (g: GymnastView) => {
    const key = clubKey(g.club);
    if (key && !names.has(key)) names.set(key, g.club!.trim());
  };
  for (const c of data.categories) {
    for (const r of c.allAround) add(r.gymnast);
    for (const rows of Object.values(c.apparatus)) for (const r of rows ?? []) add(r.gymnast);
  }
  for (const a of data.live) if (a.current) add(a.current.gymnast);
  return [...names.values()].sort((a, b) => a.localeCompare(b, "ru"));
}

/** Участники клуба с местами в многоборье и на снарядах, по разрядам и фамилиям. */
export function clubResults(data: BoardSnapshot, club: string): ClubGymnast[] {
  const key = clubKey(club);
  const people = new Map<string, ClubGymnast>();
  const entry = (g: GymnastView, category: string) => {
    let item = people.get(g.id);
    if (!item) {
      item = { gymnast: g, category, allAround: null, apparatus: [], now: null };
      people.set(g.id, item);
    }
    return item;
  };
  for (const c of data.categories) {
    for (const r of c.allAround) {
      if (clubKey(r.gymnast.club) !== key) continue;
      entry(r.gymnast, c.name).allAround = { rank: r.rank, total: r.total, complete: r.complete };
    }
    for (const a of data.live.map((l) => l.apparatus)) {
      for (const r of c.apparatus[a] ?? []) {
        if (clubKey(r.gymnast.club) !== key) continue;
        entry(r.gymnast, c.name).apparatus.push({ apparatus: a, rank: r.rank, total: r.score.total });
      }
    }
  }
  for (const a of data.live) {
    const g = a.current?.gymnast;
    if (!g || clubKey(g.club) !== key) continue;
    const category = data.categories.find((c) => c.id === g.categoryId)?.name ?? "";
    entry(g, category).now = a.apparatus;
  }
  const order = data.categories.map((c) => c.name);
  return [...people.values()].sort(
    (a, b) =>
      order.indexOf(a.category) - order.indexOf(b.category) ||
      a.gymnast.lastName.localeCompare(b.gymnast.lastName, "ru") ||
      a.gymnast.firstName.localeCompare(b.gymnast.firstName, "ru"),
  );
}
