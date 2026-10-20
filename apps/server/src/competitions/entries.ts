import ExcelJS from "exceljs";

/** Порядок столбцов в списке участников секретариата. */
export const ENTRY_COLUMNS = ["Стартовый номер", "Фамилия", "Имя", "Клуб", "Команда", "Разряд", "Смена"] as const;

type Field = "bib" | "lastName" | "firstName" | "fullName" | "club" | "city" | "team" | "category" | "shift";

/**
 * Заголовки, по которым узнаём столбцы заявки. Первый подходящий столбец побеждает.
 * «№» и «№ п/п» — это порядковый номер строки, а не стартовый номер: номера
 * раздаются по порядку, если в файле нет столбца со стартовым (нагрудным) номером.
 */
const HEADERS: [Field, RegExp][] = [
  ["bib", /нагрудн|стартов|бирк|номер\s+участника|№\s*участника/i],
  ["fullName", /^ф\.?\s*и\.?\s*о|фамилия[,\s]+имя|^участник|^спортсмен/i],
  ["lastName", /фамилия/i],
  ["firstName", /^имя/i],
  ["club", /клуб|организац|школ|сш|дюсш|сдюшор|ведомств|коллектив/i],
  ["city", /город|регион|субъект|населённ|населенн|муниципал/i],
  ["team", /команд/i],
  ["category", /разряд|категори|групп|программ/i],
  ["shift", /смена|поток/i],
];

export interface ParsedEntries {
  /** Список в формате поля вставки: столбцы ENTRY_COLUMNS через табуляцию, без заголовка. */
  text: string;
  count: number;
  /** Что пропущено или додумано: показываем секретариату перед загрузкой. */
  notes: string[];
}

const clean = (value: string) => value.replace(/\s+/g, " ").trim();

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && "result" in v) return clean(String(v.result ?? ""));
  return clean(cell.text ?? "");
}

function findColumns(cells: string[]): Map<Field, number> | null {
  const columns = new Map<Field, number>();
  cells.forEach((text, i) => {
    if (!text) return;
    const field = HEADERS.find(([f, re]) => !columns.has(f) && re.test(text))?.[0];
    if (field) columns.set(field, i);
  });
  const named = columns.has("fullName") || (columns.has("lastName") && columns.has("firstName"));
  return named ? columns : null;
}

/**
 * Читает заявку из Excel. На каждом листе ищет строку заголовка (Фамилия, Имя или ФИО)
 * в первых 20 строках и берёт строки под ней. Стартовые номера, если их нет в файле,
 * раздаются по порядку начиная с nextBib.
 */
export async function parseEntries(file: Buffer, nextBib: number): Promise<ParsedEntries> {
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(new Uint8Array(file).buffer);
  } catch {
    throw new Error("Не удалось открыть файл. Нужна таблица Excel в формате .xlsx");
  }
  const lines: string[] = [];
  const notes: string[] = [];
  let bib = nextBib;
  let autoBibs = 0;
  let found = false;

  for (const ws of book.worksheets) {
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= Math.max(row.cellCount, ws.columnCount); c++) cells.push(cellText(row.getCell(c)));
      rows.push(cells);
    });
    const headerIndex = rows.slice(0, 20).findIndex((cells) => findColumns(cells) !== null);
    if (headerIndex < 0) continue;
    found = true;
    const columns = findColumns(rows[headerIndex]!)!;
    const get = (cells: string[], field: Field) => {
      const i = columns.get(field);
      return i === undefined ? "" : (cells[i] ?? "");
    };

    rows.slice(headerIndex + 1).forEach((cells, offset) => {
      const rowNumber = headerIndex + offset + 2;
      let lastName = get(cells, "lastName");
      let firstName = get(cells, "firstName");
      if (columns.has("fullName") && !(lastName && firstName)) {
        // «Иванова Анна Сергеевна»: фамилия, имя, отчество не нужно.
        const parts = get(cells, "fullName").split(" ").filter(Boolean);
        lastName = parts[0] ?? "";
        firstName = parts[1] ?? "";
      }
      if (!lastName && !firstName) return;
      if (!lastName || !firstName) {
        notes.push(`Лист «${ws.name}», строка ${rowNumber}: нет фамилии или имени, строка пропущена`);
        return;
      }
      let number = get(cells, "bib").replace(/^№\s*/, "");
      if (!/^\d+$/.test(number)) {
        number = String(bib++);
        autoBibs++;
      }
      const club = get(cells, "club") || get(cells, "city");
      const shift = get(cells, "shift").replace(/^(смена|поток)\s*/i, "");
      lines.push([number, lastName, firstName, club, get(cells, "team"), get(cells, "category"), shift].join("\t"));
    });
  }

  if (!found) {
    throw new Error("В файле не нашлась строка заголовка: нужны столбцы «Фамилия» и «Имя» или «ФИО»");
  }
  if (autoBibs > 0) {
    notes.unshift(`Стартовых номеров в файле нет у ${autoBibs} уч.: выданы по порядку с №${nextBib}`);
  }
  return { text: lines.join("\n"), count: lines.length, notes };
}

/** Пустой бланк заявки с примером строки. */
export async function entriesTemplate(): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet("Заявка");
  const header = ws.addRow([...ENTRY_COLUMNS]);
  header.font = { bold: true };
  ws.addRow([101, "Иванова", "Анна", "СШОР №1", "СШОР №1", "1 юношеский", 1]);
  ws.addRow([102, "Петрова", "Мария", "СШОР №1", "СШОР №1", "1 юношеский", 1]);
  ws.columns.forEach((c, i) => (c.width = [16, 18, 14, 24, 20, 16, 8][i]));
  ws.views = [{ state: "frozen", ySplit: 1 }];
  return Buffer.from(await book.xlsx.writeBuffer());
}
