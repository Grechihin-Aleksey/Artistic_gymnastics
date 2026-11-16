// Собирает инструкции PDF в корне программы:
//   docs/install-guide.md   → «Инструкция по установке.pdf»
//   docs/secretary-guide.md → «Инструкция для секретаря.pdf»
// Запускать после правки инструкции, из корня репозитория:
//   npm i --no-save marked@15 playwright && npx playwright install chromium
//   node scripts/build-guide-pdf.mjs                     (обе)
//   node scripts/build-guide-pdf.mjs secretary-guide.md  (одну)
import { marked } from "marked";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = join(root, "docs");
const guides = [
  ["install-guide.md", "Инструкция по установке.pdf"],
  ["secretary-guide.md", "Инструкция для секретаря.pdf"],
];
const slug = (t) => t.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
const renderer = { heading({ tokens, depth }) { const text = this.parser.parseInline(tokens); const raw = tokens.map(t=>t.raw).join(""); return `<h${depth} id="${slug(raw)}">${text}</h${depth}>`; } };
marked.use({ renderer });
const browser = await chromium.launch();
for (const [mdName, outName] of guides.filter(([m]) => !process.argv[2] || m === process.argv[2])) {
  const md = join(docsDir, mdName);
  const out = join(root, outName);
  let body = marked.parse(readFileSync(md, "utf8"));
  body = body.replace(/<p>Эта же инструкция лежит в папке программы[^<]*<code>[^<]*<\/code>\.<\/p>/, "");
  body = body.replace(/src="([^"]+\.png)"/g, (_, f) => `src="data:image/png;base64,${readFileSync(docsDir + "/" + f).toString("base64")}"`);
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
  body{font-family:"Segoe UI","DejaVu Sans",Arial,sans-serif;font-size:11pt;line-height:1.5;color:#1b1f24;margin:0}
  h1{font-size:20pt;color:#0039A6;margin:0 0 .4em} h2{font-size:15pt;color:#0039A6;border-bottom:2px solid #0039A6;padding-bottom:3px;margin-top:1.4em;break-after:avoid}
  h3{font-size:12.5pt;margin-top:1.2em;break-after:avoid}
  code{font-family:Consolas,"DejaVu Sans Mono",monospace;background:#eef1f5;padding:1px 4px;border-radius:3px;font-size:.92em}
  pre{background:#eef1f5;padding:8px 12px;border-radius:6px;white-space:pre-wrap;break-inside:avoid} pre code{background:none;padding:0}
  table{border-collapse:collapse;width:100%;margin:.6em 0;font-size:10pt;break-inside:auto} th,td{border:1px solid #c9d1dc;padding:5px 7px;vertical-align:top;text-align:left} th{background:#e6ecf5} tr{break-inside:avoid}
  img{max-width:100%;max-height:140mm;border:1px solid #c9d1dc;border-radius:6px;display:block;margin:.6em auto;break-inside:avoid}
  blockquote{margin:.8em 0;padding:6px 12px;border-left:4px solid #D52B1E;background:#fff4f2} hr{display:none}
  a{color:#0039A6;text-decoration:none}
  li:has(> input[type=checkbox]){list-style:none;margin-left:-1.2em}
  </style></head><body>${body}</body></html>`;
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.pdf({ path: out, format: "A4", margin: { top: "16mm", bottom: "16mm", left: "16mm", right: "16mm" }, printBackground: true,
    displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: '<div style="font-size:8pt;width:100%;text-align:center;color:#777"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' });
}
await browser.close();
