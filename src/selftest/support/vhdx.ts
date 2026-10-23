// A file with the parts of a VHDX the contained-storage checks read (the signature, the two headers with their CRC-32C,
// the region table and the metadata table), shared by the script tests and the storage helper tests. Nothing here is a
// usable disk.
import fs from 'node:fs';

/** Mixed-endian GUID bytes, as VHDX (and .NET's Guid) store them. */
export function guidBytes(text: string): Buffer {
  const hex = text.replace(/-/g, '');
  const raw = Buffer.from(hex, 'hex');
  return Buffer.concat([
    Buffer.from(raw.subarray(0, 4)).reverse(),
    Buffer.from(raw.subarray(4, 6)).reverse(),
    Buffer.from(raw.subarray(6, 8)).reverse(),
    raw.subarray(8, 16),
  ]);
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** CRC-32C (Castagnoli), the checksum of a VHDX header. */
export function crc32c(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function header(sequence: number, log: boolean): Buffer {
  const h = Buffer.alloc(4096);
  h.write('head', 0, 'ascii');
  h.writeBigUInt64LE(BigInt(sequence), 8);
  if (log) guidBytes('11111111-2222-3333-4444-555555555555').copy(h, 48);
  h.writeUInt32LE(crc32c(h), 4);
  return h;
}

/**
 * `gb`: the virtual size; `parent`: a parent locator item (a differencing disk); `log`: the current header names a log
 * to replay; `staleLog`: only the older header names one (fine).
 */
export function fakeVhdx(file: string, o: { gb: number; parent?: boolean; log?: boolean; staleLog?: boolean }): void {
  const buf = Buffer.alloc(2 * 1024 * 1024);
  buf.write('vhdxfile', 0, 'ascii');
  header(2, o.log === true).copy(buf, 65536);
  header(1, o.staleLog === true).copy(buf, 131072);
  const table = 196608;
  buf.write('regi', table, 'ascii');
  buf.writeUInt32LE(1, table + 8);
  guidBytes('8b7ca206-4790-4b9a-b8fe-575f050f886e').copy(buf, table + 16);
  buf.writeBigUInt64LE(BigInt(1048576), table + 32);
  buf.writeUInt32LE(65536, table + 40);
  const md = 1048576;
  buf.write('metadata', md, 'ascii');
  const items = [
    { guid: '2fa54224-cd1b-4876-b211-5dbed83bf4b8', offset: 65536 },
    ...(o.parent ? [{ guid: 'a8d35f2d-b30b-454d-abf7-d3d84834ab0c', offset: 65600 }] : []),
  ];
  buf.writeUInt16LE(items.length, md + 10);
  items.forEach((item, i) => {
    const at = md + 32 + 32 * i;
    guidBytes(item.guid).copy(buf, at);
    buf.writeUInt32LE(item.offset, at + 16);
    buf.writeUInt32LE(8, at + 20);
  });
  buf.writeBigUInt64LE(BigInt(o.gb) * 1024n ** 3n, md + 65536);
  fs.writeFileSync(file, buf);
}
