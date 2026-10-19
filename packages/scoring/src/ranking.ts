/**
 * Расстановка мест: по убыванию ключей сравнения, при полном равенстве
 * участники делят место, следующее место пропускается (1, 1, 3).
 */
export type SortKey = readonly number[];

export interface Ranked<T> {
  rank: number;
  item: T;
}

export function compareKeys(a: SortKey, b: SortKey): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function rank<T>(items: readonly T[], key: (item: T) => SortKey): Ranked<T>[] {
  const keyed = items.map((item) => ({ item, key: key(item) }));
  keyed.sort((a, b) => compareKeys(a.key, b.key));
  const result: Ranked<T>[] = [];
  keyed.forEach((entry, i) => {
    const prev = keyed[i - 1];
    const prevRanked = result[i - 1];
    const tied = prev !== undefined && prevRanked !== undefined && compareKeys(prev.key, entry.key) === 0;
    result.push({ rank: tied ? prevRanked.rank : i + 1, item: entry.item });
  });
  return result;
}
