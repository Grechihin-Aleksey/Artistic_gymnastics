import type { ImportGymnastsInput } from "@ag/shared";

type Row = ImportGymnastsInput["rows"][number];

/**
 * Список участников, вставленный из таблицы (Excel, Google Таблицы) или набранный вручную:
 * № · Фамилия · Имя · Клуб · Команда · Разряд · Смена. Столбцы разделяются табуляцией, «;» или «,».
 * Порядок строк внутри смены — порядок выхода.
 * Строка заголовка (без номера в первом столбце) пропускается.
 */
export function parseRoster(text: string): { rows: Row[]; errors: string[] } {
  const rows: Row[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const separator = line.includes("\t") ? "\t" : line.includes(";") ? ";" : ",";
    const cells = line.split(separator).map((c) => c.trim());
    const bibText = cells[0]!.replace(/^№\s*/, "");
    if (!/^\d+$/.test(bibText)) {
      if (index === 0) return;
      errors.push(`Строка ${index + 1}: нет номера участника`);
      return;
    }
    const [, lastName, firstName, club, team, category, shiftText] = cells;
    if (!lastName || !firstName) {
      errors.push(`Строка ${index + 1}: нужны фамилия и имя`);
      return;
    }
    const shift = shiftText ? Number(shiftText.replace(/^смена\s*/i, "")) : undefined;
    if (shift !== undefined && !(Number.isInteger(shift) && shift >= 1 && shift <= 50)) {
      errors.push(`Строка ${index + 1}: смена должна быть числом от 1 до 50`);
      return;
    }
    rows.push({
      bib: Number(bibText),
      lastName,
      firstName,
      ...(club ? { club } : {}),
      ...(team ? { team } : {}),
      ...(category ? { category } : {}),
      ...(shift !== undefined ? { shift } : {}),
    });
  });
  return { rows, errors };
}

export interface TeamFormat {
  roster: number;
  perApparatus: number;
  counting: number;
}

/** Предупреждения о составах команд, которые не уложатся в формат соревнования. */
export function teamFormatWarnings(sizes: Map<string, number>, format: TeamFormat): string[] {
  const out: string[] = [];
  for (const [name, size] of sizes) {
    if (size > format.roster) {
      out.push(`В команде «${name}» ${size} уч., а в составе допускается ${format.roster}.`);
    } else if (size > format.perApparatus) {
      out.push(
        `В команде «${name}» ${size} уч., а на снаряде за команду выступают ${format.perApparatus}. ` +
          `Если на снаряд выйдут все, командный зачёт не посчитается. Когда выступают все, ` +
          `создайте соревнование с форматом ${format.roster}-${format.roster}-${format.counting}.`,
      );
    }
  }
  return out;
}
