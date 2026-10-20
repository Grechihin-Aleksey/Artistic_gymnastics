import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";

export interface Diploma {
  /** Кого награждают: участник или команда. */
  who: string;
  /** Клуб, команда или город — мелко под именем. */
  from?: string;
  place: number;
  /** «в многоборье», «в командном зачёте», «в упражнении на перекладине». */
  event: string;
  category?: string;
  team: boolean;
}

const PLACE = ["", "I", "II", "III"];

/** «занявший I место …» — в чём именно. */
export const APPARATUS_EVENT: Readonly<Record<string, string>> = {
  FX: "в вольных упражнениях",
  PH: "в упражнениях на коне",
  SR: "в упражнениях на кольцах",
  VT: "в опорном прыжке",
  PB: "в упражнениях на брусьях",
  HB: "в упражнениях на перекладине",
  UB: "в упражнениях на брусьях разной высоты",
  BB: "в упражнениях на бревне",
};

/** Грамоты победителям и призёрам: по странице A4 на каждого. */
export function diplomasDocument(
  competition: { name: string; discipline: "MAG" | "WAG"; logo?: string | null },
  diplomas: Diploma[],
): TDocumentDefinitions {
  const date = new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  const page = (d: Diploma): Content[] => {
    // В мужской программе награждают гимнастов, в женской — гимнасток; команда — женского рода.
    const took = d.team || competition.discipline === "WAG" ? "занявшая" : "занявший";
    return [
      {
        stack: [
          ...(competition.logo ? [{ image: competition.logo, fit: [110, 110], alignment: "center" } as Content] : []),
          { text: "ГРАМОТА", style: "title" },
          { text: d.team ? "награждается команда" : "награждается", style: "lead" },
          { text: d.who, style: "who" },
          ...(d.from ? [{ text: d.from, style: "from" } as Content] : []),
          { text: `${took} ${PLACE[d.place] ?? d.place} место`, style: "place" },
          { text: d.event, style: "event" },
          ...(d.category ? [{ text: `разряд «${d.category}»`, style: "event" } as Content] : []),
          { text: competition.name, style: "competition" },
        ],
        margin: [0, competition.logo ? 10 : 80, 0, 0],
      },
      {
        absolutePosition: { x: 70, y: 700 },
        columns: [
          { text: "Главный судья\n\n______________________", width: "*" },
          { text: "Главный секретарь\n\n______________________", width: "*", alignment: "right" },
        ],
        width: 455,
      } as Content,
      { text: date, absolutePosition: { x: 70, y: 770 }, style: "date" },
    ];
  };

  return {
    pageSize: "A4",
    pageOrientation: "portrait",
    pageMargins: [60, 70, 60, 70],
    info: { title: `${competition.name}. Грамоты` },
    defaultStyle: { font: "Roboto", fontSize: 12, alignment: "center" },
    styles: {
      title: { fontSize: 48, bold: true, color: "#8a1c1c", characterSpacing: 6, margin: [0, 24, 0, 18] },
      lead: { fontSize: 16, italics: true, margin: [0, 0, 0, 10] },
      who: { fontSize: 30, bold: true, color: "#14213d", margin: [0, 0, 0, 6] },
      from: { fontSize: 14, color: "#444", margin: [0, 0, 0, 22] },
      place: { fontSize: 24, bold: true, margin: [0, 6, 0, 8] },
      event: { fontSize: 16, margin: [0, 0, 0, 4] },
      competition: { fontSize: 15, bold: true, margin: [0, 30, 0, 0] },
      date: { fontSize: 11, color: "#444", alignment: "left" },
    },
    // Двойная рамка по краю листа.
    background: () => ({
      canvas: [
        { type: "rect", x: 24, y: 24, w: 547, h: 794, lineWidth: 3, lineColor: "#8a1c1c" },
        { type: "rect", x: 32, y: 32, w: 531, h: 778, lineWidth: 1, lineColor: "#c9a227" },
      ],
    }),
    content:
      diplomas.length === 0
        ? [{ text: "Призёров пока нет: грамоты появятся, когда будут утверждены оценки.", margin: [0, 200, 0, 0] }]
        : diplomas.flatMap((d, i) => [
            ...(i > 0 ? [{ text: "", pageBreak: "before" } as Content] : []),
            ...page(d),
          ]),
  };
}
