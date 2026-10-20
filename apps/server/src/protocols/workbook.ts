import ExcelJS from "exceljs";
import { APPARATUS_NAMES, scoreLabels, type AllAroundRow, type Rules, type ApparatusResultRow, type TeamResultRow } from "@ag/shared";

export interface WorkbookCategory {
  name: string;
  allAround: AllAroundRow[];
  teams: TeamResultRow[];
  apparatus: { code: string; rows: ApparatusResultRow[] }[];
  /** Финалы на снарядах, если они проводились. */
  finals?: { code: string; rows: ApparatusResultRow[] }[];
}

const SHEET_FORBIDDEN = /[[\]:*?/\\]/g;

/**
 * Итоги соревнования в Excel: по разряду лист многоборья, лист снарядов,
 * лист финалов (если были) и лист команд.
 */
export async function resultsWorkbook(
  competitionName: string,
  program: readonly string[],
  categories: WorkbookCategory[],
  teamNames: Map<string, string>,
  rules: Rules = "FIG",
): Promise<Buffer> {
  const labels = scoreLabels(rules);
  const book = new ExcelJS.Workbook();
  book.creator = "Artistic gymnastics";
  const used = new Set<string>();
  const sheet = (title: string) => {
    let name = title.replace(SHEET_FORBIDDEN, " ").slice(0, 31).trim();
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${title.slice(0, 27)} (${i})`;
    used.add(name.toLowerCase());
    const ws = book.addWorksheet(name, { views: [{ state: "frozen", ySplit: 2 }] });
    ws.addRow([`${competitionName}. ${title}`]).font = { bold: true, size: 13 };
    return ws;
  };
  const header = (ws: ExcelJS.Worksheet, cells: string[]) => {
    const row = ws.addRow(cells);
    row.font = { bold: true };
    row.eachCell((c) => {
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEEEEE" } };
      c.border = { bottom: { style: "thin" } };
    });
  };
  const score = "0.000";
  const prefix = (c: WorkbookCategory) => (c.name ? `${c.name} — ` : "");
  const team = (id: string | null) => (id ? (teamNames.get(id) ?? "") : "");

  const apparatusSheet = (title: string, list: { code: string; rows: ApparatusResultRow[] }[]) => {
    const app = sheet(title);
    for (const { code, rows } of list) {
      app.addRow([APPARATUS_NAMES[code]]).font = { bold: true };
      header(app, ["Место", "№", "Фамилия", "Имя", "Клуб", labels.d, labels.e, rules === "CUSTOM" ? "НС" : "Сбавка", "Итог"]);
      for (const r of rows) {
        app.addRow([
          r.rank,
          r.gymnast.bib,
          r.gymnast.lastName,
          r.gymnast.firstName,
          r.gymnast.club ?? "",
          r.score.d,
          Math.abs(r.score.e),
          r.score.neutral || null,
          r.score.total,
        ]);
      }
      app.addRow([]);
    }
    for (let i = 6; i <= 9; i++) app.getColumn(i).numFmt = score;
  };

  for (const c of categories) {
    const aa = sheet(`${prefix(c)}многоборье`);
    const earned = c.allAround.some((r) => r.earned);
    header(aa, [
      "Место",
      "№",
      "Фамилия",
      "Имя",
      "Клуб",
      "Команда",
      ...program.map((a) => APPARATUS_NAMES[a]!),
      "Сумма",
      ...(earned ? ["Выполнил разряд"] : []),
    ]);
    for (const r of c.allAround) {
      aa.addRow([
        r.rank,
        r.gymnast.bib,
        r.gymnast.lastName,
        r.gymnast.firstName,
        r.gymnast.club ?? "",
        team(r.gymnast.teamId),
        ...program.map((a) => r.apparatus[a as keyof typeof r.apparatus]?.total ?? null),
        r.total,
        ...(earned ? [r.earned ?? ""] : []),
      ]);
    }
    for (let i = 7; i <= 7 + program.length; i++) aa.getColumn(i).numFmt = score;

    apparatusSheet(`${prefix(c)}снаряды`, c.apparatus);
    const finals = c.finals?.filter((f) => f.rows.length > 0) ?? [];
    if (finals.length > 0) apparatusSheet(`${prefix(c)}финалы`, finals);

    if (c.teams.length > 0) {
      const teams = sheet(`${prefix(c)}команды`);
      header(teams, ["Место", "Команда", ...c.teams[0]!.apparatus.map((a) => APPARATUS_NAMES[a.apparatus]!), "Сумма"]);
      for (const t of c.teams) teams.addRow([t.rank, t.team.name ?? "", ...t.apparatus.map((a) => a.total), t.total]);
      for (let i = 3; i <= 3 + c.teams[0]!.apparatus.length; i++) teams.getColumn(i).numFmt = score;
    }
  }

  for (const ws of book.worksheets) {
    ws.columns.forEach((col, i) => {
      let width = 6;
      col.eachCell?.({ includeEmpty: false }, (cell, row) => {
        if (row > 1) width = Math.max(width, String(cell.value ?? "").length + 2);
      });
      col.width = Math.min(i === 2 ? 24 : 30, width);
    });
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}
