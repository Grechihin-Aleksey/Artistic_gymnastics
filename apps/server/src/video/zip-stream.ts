import { once } from "node:events";
import { createReadStream } from "node:fs";
import type { Writable } from "node:stream";
import { crc32 } from "node:zlib";

/**
 * ZIP-архив видео потоком, без сжатия (видео уже сжато) и без загрузки файлов в память.
 * Архив может быть больше 4 ГБ: тогда пишутся записи ZIP64, их понимают Проводник
 * Windows, 7-Zip и macOS. Имена в UTF-8, русские названия открываются как есть.
 */

export interface ZipFile {
  /** Путь внутри архива через «/». */
  name: string;
  path: string;
  size: number;
}

const MAX32 = 0xffffffff;

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function localHeader(name: Buffer, crc: number, size: number, time: number, date: number): Buffer {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(0x0800, 6); // имена в UTF-8
  h.writeUInt16LE(0, 8); // без сжатия
  h.writeUInt16LE(time, 10);
  h.writeUInt16LE(date, 12);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(size, 18);
  h.writeUInt32LE(size, 22);
  h.writeUInt16LE(name.length, 26);
  h.writeUInt16LE(0, 28);
  return h;
}

function centralHeader(name: Buffer, crc: number, size: number, offset: number, time: number, date: number): Buffer {
  const big = offset >= MAX32;
  const extra = big ? Buffer.alloc(12) : Buffer.alloc(0);
  if (big) {
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(8, 2);
    extra.writeBigUInt64LE(BigInt(offset), 4);
  }
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(big ? 45 : 20, 4);
  h.writeUInt16LE(big ? 45 : 20, 6);
  h.writeUInt16LE(0x0800, 8);
  h.writeUInt16LE(0, 10);
  h.writeUInt16LE(time, 12);
  h.writeUInt16LE(date, 14);
  h.writeUInt32LE(crc, 16);
  h.writeUInt32LE(size, 20);
  h.writeUInt32LE(size, 24);
  h.writeUInt16LE(name.length, 28);
  h.writeUInt16LE(extra.length, 30);
  h.writeUInt32LE(big ? MAX32 : offset, 42);
  return Buffer.concat([h, name, extra]);
}

function endRecords(count: number, cdOffset: number, cdSize: number): Buffer {
  const zip64 = count >= 0xffff || cdOffset >= MAX32 || cdSize >= MAX32;
  const parts: Buffer[] = [];
  if (zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(count), 24);
    rec.writeBigUInt64LE(BigInt(count), 32);
    rec.writeBigUInt64LE(BigInt(cdSize), 40);
    rec.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
    loc.writeUInt32LE(1, 16);
    parts.push(rec, loc);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(count, 0xffff), 8);
  end.writeUInt16LE(Math.min(count, 0xffff), 10);
  end.writeUInt32LE(Math.min(cdSize, MAX32), 12);
  end.writeUInt32LE(Math.min(cdOffset, MAX32), 16);
  parts.push(end);
  return Buffer.concat(parts);
}

/** Размер архива заранее: браузер покажет, сколько осталось скачать. */
export function zipSize(files: readonly ZipFile[]): number {
  let offset = 0;
  let cd = 0;
  for (const f of files) {
    const name = Buffer.byteLength(f.name, "utf8");
    cd += 46 + name + (offset >= MAX32 ? 12 : 0);
    offset += 30 + name + f.size;
  }
  return offset + cd + endRecords(files.length, offset, cd).length;
}

async function fileCrc(path: string): Promise<number> {
  let crc = 0;
  for await (const chunk of createReadStream(path)) crc = crc32(chunk as Buffer, crc);
  return crc;
}

async function write(out: Writable, chunk: Buffer): Promise<void> {
  if (!out.write(chunk)) await once(out, "drain");
}

/** Пишет архив в поток (ответ сервера). Файлы читаются дважды: для контрольной суммы и для записи. */
export async function writeZip(out: Writable, files: readonly ZipFile[], at = new Date()): Promise<void> {
  const { time, date } = dosTime(at);
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    if (out.destroyed) return;
    const name = Buffer.from(f.name, "utf8");
    const crc = await fileCrc(f.path);
    await write(out, Buffer.concat([localHeader(name, crc, f.size, time, date), name]));
    let written = 0;
    for await (const chunk of createReadStream(f.path, { end: f.size - 1 })) {
      if (out.destroyed) return;
      written += (chunk as Buffer).length;
      await write(out, chunk as Buffer);
    }
    if (written !== f.size) throw new Error(`Файл ${f.name} изменился во время записи архива`);
    central.push(centralHeader(name, crc, f.size, offset, time, date));
    offset += 30 + name.length + f.size;
  }
  const cd = Buffer.concat(central);
  await write(out, Buffer.concat([cd, endRecords(files.length, offset, cd.length)]));
  out.end();
}
