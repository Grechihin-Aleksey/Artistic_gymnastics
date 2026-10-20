import type { ImportGymnastsInput } from "@ag/shared";

type Row = ImportGymnastsInput["rows"][number];

/** Строка списка; пол нужен только турниру девочек и мальчиков, на сервер он не уходит. */
export type RosterRow = Row & { gender?: "F" | "M" };

/**
 * Список участников, вставленный из таблицы (Excel, Google Таблицы) или набранный вручную:
 * № · Фамилия · Имя · Клуб · Команда · Разряд · Смена · Дата рождения · Город · Тренер · Отчество · Пол.
 * Обязательны только первые три. Столбцы разделяются табуляцией, «;» или «,».
 * Порядок строк внутри смены — порядок выхода.
 * Строка заголовка (без номера в первом столбце) пропускается.
 */
export function parseRoster(text: string): { rows: RosterRow[]; errors: string[] } {
  const rows: RosterRow[] = [];
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
    const [, lastName, firstName, club, team, category, shiftText, birthDate, city, coach, middleName, genderText] = cells;
    if (!lastName || !firstName) {
      errors.push(`Строка ${index + 1}: нужны фамилия и имя`);
      return;
    }
    const shift = shiftText ? Number(shiftText.replace(/^смена\s*/i, "")) : undefined;
    if (shift !== undefined && !(Number.isInteger(shift) && shift >= 1 && shift <= 50)) {
      errors.push(`Строка ${index + 1}: смена должна быть числом от 1 до 50`);
      return;
    }
    if (birthDate && !/^(\d{4}|\d{2}\.\d{2}\.\d{4})$/.test(birthDate)) {
      errors.push(`Строка ${index + 1}: дата рождения — год (2012) или дата (15.03.2012)`);
      return;
    }
    const gender = genderText ? genderOf(genderText) : undefined;
    if (gender === null) {
      errors.push(`Строка ${index + 1}: пол — «Ж» или «М»`);
      return;
    }
    rows.push({
      ...(gender ? { gender } : {}),
      bib: Number(bibText),
      lastName,
      firstName,
      ...(club ? { club } : {}),
      ...(team ? { team } : {}),
      ...(category ? { category } : {}),
      ...(shift !== undefined ? { shift } : {}),
      ...(birthDate ? { birthDate } : {}),
      ...(city ? { city } : {}),
      ...(coach ? { coach } : {}),
      ...(middleName ? { middleName } : {}),
    });
  });
  return { rows, errors };
}

function genderOf(text: string): "F" | "M" | null {
  const t = text.trim().toLowerCase().replace(/\.$/, "");
  if (/^(ж|жен|женский|д|дев|девочка|девушка|f|w)$/.test(t)) return "F";
  if (/^(м|муж|мужской|мал|мальчик|юн|юноша|m)$/.test(t)) return "M";
  return null;
}

/**
 * Турнир девочек и мальчиков: список делится на две части по столбцу «Пол».
 * Без пола строку некуда отнести — это ошибка, а не тихая загрузка не туда.
 */
export function splitByGender(rows: RosterRow[]): { girls: Row[]; boys: Row[]; missing: number[] } {
  const girls: Row[] = [];
  const boys: Row[] = [];
  const missing: number[] = [];
  for (const { gender, ...row } of rows) {
    if (gender === "F") girls.push(row);
    else if (gender === "M") boys.push(row);
    else missing.push(row.bib);
  }
  return { girls, boys, missing };
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
