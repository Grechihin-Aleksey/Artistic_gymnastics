export type SlideKind = "now" | "aa" | "teams" | { apparatus: string };

export interface Slide {
  kind: SlideKind;
  /** Номер разряда в снимке; для «сейчас на снарядах» не важен. */
  category: number;
  /** Номер страницы таблицы с нуля. */
  page: number;
  pages: number;
}

export const ROWS_PER_PAGE = 10;

export function pageCount(rows: number, perPage = ROWS_PER_PAGE): number {
  return Math.max(1, Math.ceil(rows / perPage));
}

export interface CategoryCounts {
  aa: number;
  teams: number;
  apparatus: { code: string; rows: number }[];
}

/**
 * Последовательность слайдов для автоматического режима большого экрана:
 * «сейчас на снарядах», затем по каждому разряду многоборье, команды и снаряды
 * с результатами, длинные таблицы — по страницам.
 */
export function buildSlides(categories: CategoryCounts[]): Slide[] {
  const slides: Slide[] = [{ kind: "now", category: 0, page: 0, pages: 1 }];
  categories.forEach((counts, category) => {
    const add = (kind: SlideKind, rows: number) => {
      if (rows === 0) return;
      const pages = pageCount(rows);
      for (let page = 0; page < pages; page++) slides.push({ kind, category, page, pages });
    };
    add("aa", counts.aa);
    add("teams", counts.teams);
    for (const a of counts.apparatus) add({ apparatus: a.code }, a.rows);
  });
  return slides;
}

export function pageRows<T>(rows: readonly T[], page: number, perPage = ROWS_PER_PAGE): T[] {
  return rows.slice(page * perPage, (page + 1) * perPage);
}
