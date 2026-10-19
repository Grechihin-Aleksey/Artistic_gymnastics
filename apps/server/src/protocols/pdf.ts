import PdfPrinter from "pdfmake";
import vfsFonts from "pdfmake/build/vfs_fonts.js";
import type { TDocumentDefinitions } from "pdfmake/interfaces";

/** Roboto из поставки pdfmake: в нём есть кириллица. */
function loadFonts() {
  // В разных сборках pdfmake шрифты лежат то в корне модуля, то в pdfMake.vfs.
  const module = vfsFonts as unknown as { pdfMake?: { vfs: Record<string, string> } } & Record<string, string>;
  const vfs = module.pdfMake?.vfs ?? module;
  const font = (name: string) => Buffer.from(vfs[name]!, "base64");
  return {
    Roboto: {
      normal: font("Roboto-Regular.ttf"),
      bold: font("Roboto-Medium.ttf"),
      italics: font("Roboto-Italic.ttf"),
      bolditalics: font("Roboto-MediumItalic.ttf"),
    },
  };
}

let printer: PdfPrinter | null = null;

export function renderPdf(definition: TDocumentDefinitions): Promise<Buffer> {
  printer ??= new PdfPrinter(loadFonts());
  const doc = printer.createPdfKitDocument(definition);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}
