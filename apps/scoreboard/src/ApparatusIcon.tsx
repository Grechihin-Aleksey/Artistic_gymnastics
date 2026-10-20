import { APPARATUS_ICONS } from "@ag/shared";

/** Значок снаряда рядом с его названием; цвет берётся от текста. */
export function ApparatusIcon({ code }: { code: string }) {
  const d = APPARATUS_ICONS[code];
  if (!d) return null;
  return (
    <svg className="app-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
