/**
 * 生成占位应用图标（纯 Node，无依赖）：品牌蓝底白字「迈」。
 * 用法：node scripts/gen-icon.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(here, "..", "src-tauri", "icons");
mkdirSync(iconsDir, { recursive: true });

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function png(size) {
  // 品牌蓝 #3370ff 底 + 白色方块（简化占位）
  const px = Buffer.alloc(size * size * 4);
  const R = 0x33, G = 0x70, B = 0xff, A = 0xff;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // 中央白“方块”代表 logo
      const inner = x > size * 0.3 && x < size * 0.7 && y > size * 0.3 && y < size * 0.7;
      px[i] = inner ? 0xff : R;
      px[i + 1] = inner ? 0xff : G;
      px[i + 2] = inner ? 0xff : B;
      px[i + 3] = A;
    }
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const files = {
  "32x32.png": 32,
  "128x128.png": 128,
  "128x128@2x.png": 256,
  "icon.png": 512,
};
for (const [name, size] of Object.entries(files)) {
  writeFileSync(join(iconsDir, name), png(size));
  console.log("✅", name, size + "x" + size);
}

/** ICO 容器（PNG-in-ICO：Vista+ 支持 256x256 PNG 条目，Windows 资源文件必需） */
function ico(pngBuf) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(1, 4); // count = 1
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 0 = 256
  entry[1] = 0; // height 0 = 256
  entry[2] = 0; // color count
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bit count
  entry.writeUInt32LE(pngBuf.length, 8); // bytes in res
  entry.writeUInt32LE(22, 12); // image offset (6 + 16)
  return Buffer.concat([header, entry, pngBuf]);
}

writeFileSync(join(iconsDir, "icon.ico"), ico(png(256)));
console.log("✅ icon.ico (256x256 PNG-in-ICO)");
