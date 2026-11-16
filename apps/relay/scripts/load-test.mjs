// Нагрузочная проверка ретранслятора: много зрителей сайта смотрят табло одновременно.
//   node scripts/load-test.mjs node 1000     — Node-ретранслятор, 1000 зрителей с постоянным подключением
//   node scripts/load-test.mjs php 300 8     — PHP-ретранслятор, 300 зрителей, 8 процессов PHP (как на хостинге)
// Зал присылает снимок каждые 3 секунды (так бывает в разгар многоборья); скрипт меряет, через сколько
// новый снимок дошёл до каждого зрителя, и считает ошибки.
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [mode = "node", viewersArg = "300", workersArg = "8"] = process.argv.slice(2);
const VIEWERS = Number(viewersArg);
const ROUNDS = 6;
const EVERY_MS = 3000;
const POLL_MS = 3000;
const TOKEN = "load-test-token-0123456789";
const ID = "0b9b6a52-6c1e-4f0e-9a4f-2f1d3c4b5a69";
const here = join(import.meta.dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });

/** Снимок как у настоящего турнира: 120 участниц, 4 снаряда, многоборье и команды. */
function snapshot(round) {
  const g = (i) => ({ id: `g${i}`, bib: 100 + i, firstName: "Анна", lastName: `Участница${i}`, club: `Клуб ${i % 12}`, teamId: `t${i % 12}`, categoryId: `c${i % 4}` });
  const s = (i) => ({ d: 5 + (i % 10) / 10, e: 8 + (i % 7) / 10, neutral: 0, total: 13 + (i % 17) / 10 });
  const categories = [0, 1, 2, 3].map((c) => {
    const people = Array.from({ length: 30 }, (_, k) => k * 4 + c);
    return {
      id: `c${c}`,
      name: `Разряд ${c + 1}`,
      allAround: people.map((i, rank) => ({ rank: rank + 1, gymnast: g(i), total: 52 - rank / 10, complete: true, apparatus: { VT: s(i), UB: s(i + 1), BB: s(i + 2), FX: s(i + 3) } })),
      teams: [],
      apparatus: Object.fromEntries(["VT", "UB", "BB", "FX"].map((a, k) => [a, people.map((i, rank) => ({ rank: rank + 1, gymnast: g(i), score: s(i + k) }))])),
    };
  });
  return {
    competition: { id: ID, name: "Нагрузочный турнир", discipline: "WAG" },
    live: ["VT", "UB", "BB", "FX"].map((a, k) => ({ apparatus: a, current: { performanceId: `p${round}${k}`, attempt: 1, gymnast: g(k) }, last: null })),
    categories,
    generatedAt: new Date(Date.UTC(2026, 0, 1, 10, 0, round)).toISOString(),
  };
}

function request(base, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers, agent }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error("timeout")));
    if (body) req.end(body);
    else req.end();
  });
}

async function startServer() {
  const dataDir = await mkdtemp(join(tmpdir(), "relay-load-"));
  const port = 18000 + Math.floor(Math.random() * 1000);
  const env = { ...process.env, RELAY_TOKEN: TOKEN, PORT: String(port), DATA_DIR: dataDir, RELAY_DATA_DIR: dataDir, RELAY_POLL_MS: String(POLL_MS), PHP_CLI_SERVER_WORKERS: workersArg };
  const child =
    mode === "php"
      ? spawn("php", ["-S", `127.0.0.1:${port}`, "dev-router.php"], { cwd: join(here, "php"), env, stdio: "ignore" })
      : spawn("node", ["dist/main.js"], { cwd: here, env, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await request(base, "GET", "/health").then((r) => r.status === 200, () => false)) break;
    await sleep(100);
  }
  return { base, stop: async () => { child.kill(); await rm(dataDir, { recursive: true, force: true }); } };
}

const { base, stop } = await startServer();
const sent = new Map(); // generatedAt → время отправки
const latencies = [];
let errors = 0;
let requests = 0;
let running = true;

const ingest = async (round) => {
  const snap = snapshot(round);
  sent.set(snap.generatedAt, Date.now());
  const body = JSON.stringify({ snapshot: snap, approved: [] });
  const r = await request(base, "POST", `/ingest/${ID}`, { body, headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` } });
  if (r.status !== 200) throw new Error(`ingest ${r.status} ${r.text}`);
  return body.length;
};
const seen = (text) => {
  for (const m of text.matchAll(/"generatedAt":"([^"]+)"/g)) {
    const at = sent.get(m[1]);
    if (at !== undefined) return Date.now() - at;
  }
  return null;
};

const size = await ingest(0);

if (mode === "php") {
  // Зритель: опрос, пауза retry, снова опрос с Last-Event-ID — так делает EventSource.
  const viewer = async () => {
    let last = "";
    await sleep(Math.random() * POLL_MS);
    while (running) {
      try {
        requests++;
        const r = await request(base, "GET", `/api/competitions/${ID}/events`, { headers: last ? { "last-event-id": last } : {} });
        if (r.status !== 200) errors++;
        const id = /^id: (\d+)$/m.exec(r.text)?.[1];
        if (id && id !== last) {
          if (last) {
            const l = seen(r.text);
            if (l !== null) latencies.push(l);
          }
          last = id;
        }
      } catch {
        errors++;
      }
      await sleep(POLL_MS);
    }
  };
  const all = Array.from({ length: VIEWERS }, viewer);
  for (let round = 1; round <= ROUNDS; round++) {
    await sleep(EVERY_MS);
    await ingest(round);
  }
  await sleep(POLL_MS * 2);
  running = false;
  await Promise.all(all);
} else {
  // Зритель с постоянным подключением: снимки приходят сами.
  const streams = [];
  await Promise.all(
    Array.from({ length: VIEWERS }, () =>
      new Promise((resolve) => {
        const req = http.get(`${base}/api/competitions/${ID}/events`, { agent: false }, (res) => {
          let buf = "";
          let first = true;
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const frame = buf.slice(0, i);
              buf = buf.slice(i + 2);
              if (!frame.startsWith("event: snapshot")) continue;
              if (first) {
                first = false;
                resolve();
                continue;
              }
              const l = seen(frame);
              if (l !== null) latencies.push(l);
            }
          });
          res.on("error", () => errors++);
        });
        req.on("error", () => {
          errors++;
          resolve();
        });
        streams.push(req);
      }),
    ),
  );
  for (let round = 1; round <= ROUNDS; round++) {
    await sleep(EVERY_MS);
    await ingest(round);
  }
  await sleep(2000);
  for (const s of streams) s.destroy();
}

latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length * p) / 100))] ?? NaN;
const expected = VIEWERS * ROUNDS;
console.log(
  JSON.stringify({
    mode,
    viewers: VIEWERS,
    snapshotKB: Math.round(size / 1024),
    delivered: `${latencies.length}/${expected}`,
    medianMs: pct(50),
    p95Ms: pct(95),
    maxMs: latencies.at(-1),
    errors,
    ...(mode === "php" ? { requests } : {}),
  }),
);
await stop();
process.exit(0);
