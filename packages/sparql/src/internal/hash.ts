/**
 * Pure, synchronous implementations of MD5, SHA-1, SHA-256, SHA-384 and
 * SHA-512 over UTF-8 strings, returning lower-case hex digests.
 *
 * @internal
 */

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** `0 … n - 1`. */
const range = (n: number): ReadonlyArray<number> => Array.from({ length: n }, (_, i) => i);

/** The offsets of the `blockSize`-byte blocks of a padded message. */
const blocks = (m: Uint8Array, blockSize: number): ReadonlyArray<number> =>
  range(m.length / blockSize).map((b) => b * blockSize);

const pad = (msg: Uint8Array, blockSize: number, lengthBytes: number, littleEndian: boolean) => {
  const bitLen = BigInt(msg.length) * 8n;
  const total = Math.ceil((msg.length + 1 + lengthBytes) / blockSize) * blockSize;
  const out = new Uint8Array(total);
  out.set(msg);
  out[msg.length] = 0x80;
  range(lengthBytes).forEach((i) => {
    const byte = Number((bitLen >> BigInt(8 * i)) & 0xffn);
    if (littleEndian) out[total - lengthBytes + i] = byte;
    else out[total - 1 - i] = byte;
  });
  return out;
};

const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** Big-endian 32-bit words of a digest, as hex. */
const hexWords = (words: ReadonlyArray<number>): string =>
  words.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');

// --- MD5 ---------------------------------------------------------------------

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** One MD5 step: its index, constant, shift and message word. */
interface Md5Step {
  readonly i: number;
  readonly k: number;
  readonly s: number;
  readonly g: number;
}

const MD5_STEPS: ReadonlyArray<Md5Step> = MD5_S.map((s, i) => ({
  i,
  k: Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0,
  s,
  g: i < 16 ? i : i < 32 ? (5 * i + 1) % 16 : i < 48 ? (3 * i + 5) % 16 : (7 * i) % 16,
}));

export const md5 = (input: string): string => {
  const m = pad(utf8(input), 64, 8, true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476;
  const view = new DataView(m.buffer);
  blocks(m, 64).forEach((off) => {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    MD5_STEPS.forEach(({ i, k, s, g }) => {
      const f =
        i < 16
          ? (b & c) | (~b & d)
          : i < 32
            ? (d & b) | (~d & c)
            : i < 48
              ? b ^ c ^ d
              : c ^ (b | ~d);
      const tmp = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + k + (view.getUint32(off + g * 4, true) | 0)) | 0, s)) | 0;
      a = tmp;
    });
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  });
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((x, i) => out.setUint32(i * 4, x >>> 0, true));
  return hex(new Uint8Array(out.buffer));
};

// --- SHA-1 -------------------------------------------------------------------

const ROUNDS_16 = range(16);
const SCHEDULE_80 = range(80).slice(16);
const SCHEDULE_64 = range(64).slice(16);
const SHA1_ROUNDS = range(80);

export const sha1 = (input: string): string => {
  const m = pad(utf8(input), 64, 8, false);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89 | 0;
  let h2 = 0x98badcfe | 0;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0 | 0;
  const view = new DataView(m.buffer);
  // The message schedule, 80 words.
  const w = new DataView(new ArrayBuffer(80 * 4));
  const word = (i: number) => w.getInt32(i * 4);
  blocks(m, 64).forEach((off) => {
    ROUNDS_16.forEach((i) => w.setInt32(i * 4, view.getUint32(off + i * 4) | 0));
    SCHEDULE_80.forEach((i) =>
      w.setInt32(i * 4, rotl(word(i - 3) ^ word(i - 8) ^ word(i - 14) ^ word(i - 16), 1)),
    );
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    SHA1_ROUNDS.forEach((i) => {
      const f =
        i < 20
          ? (b & c) | (~b & d)
          : i < 40
            ? b ^ c ^ d
            : i < 60
              ? (b & c) | (b & d) | (c & d)
              : b ^ c ^ d;
      const k =
        i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc | 0 : 0xca62c1d6 | 0;
      const t = (rotl(a, 5) + f + e + k + word(i)) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    });
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  });
  return hexWords([h0, h1, h2, h3, h4]);
};

// --- SHA-256 -----------------------------------------------------------------

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
].map((x) => x | 0);

export const sha256 = (input: string): string => {
  const m = pad(utf8(input), 64, 8, false);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85 | 0;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a | 0;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c | 0;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const view = new DataView(m.buffer);
  // The message schedule, 64 words.
  const w = new DataView(new ArrayBuffer(64 * 4));
  const word = (i: number) => w.getInt32(i * 4);
  blocks(m, 64).forEach((off) => {
    ROUNDS_16.forEach((i) => w.setInt32(i * 4, view.getUint32(off + i * 4) | 0));
    SCHEDULE_64.forEach((i) => {
      const x = word(i - 15);
      const y = word(i - 2);
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w.setInt32(i * 4, (word(i - 16) + s0 + word(i - 7) + s1) | 0);
    });
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let hh = h7;
    K256.forEach((k, i) => {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + k + word(i)) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    });
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + hh) | 0;
  });
  return hexWords([h0, h1, h2, h3, h4, h5, h6, h7]);
};

// --- SHA-512 / SHA-384 (BigInt based) -------------------------------------------

const K512 = [
  '428a2f98d728ae22',
  '7137449123ef65cd',
  'b5c0fbcfec4d3b2f',
  'e9b5dba58189dbbc',
  '3956c25bf348b538',
  '59f111f1b605d019',
  '923f82a4af194f9b',
  'ab1c5ed5da6d8118',
  'd807aa98a3030242',
  '12835b0145706fbe',
  '243185be4ee4b28c',
  '550c7dc3d5ffb4e2',
  '72be5d74f27b896f',
  '80deb1fe3b1696b1',
  '9bdc06a725c71235',
  'c19bf174cf692694',
  'e49b69c19ef14ad2',
  'efbe4786384f25e3',
  '0fc19dc68b8cd5b5',
  '240ca1cc77ac9c65',
  '2de92c6f592b0275',
  '4a7484aa6ea6e483',
  '5cb0a9dcbd41fbd4',
  '76f988da831153b5',
  '983e5152ee66dfab',
  'a831c66d2db43210',
  'b00327c898fb213f',
  'bf597fc7beef0ee4',
  'c6e00bf33da88fc2',
  'd5a79147930aa725',
  '06ca6351e003826f',
  '142929670a0e6e70',
  '27b70a8546d22ffc',
  '2e1b21385c26c926',
  '4d2c6dfc5ac42aed',
  '53380d139d95b3df',
  '650a73548baf63de',
  '766a0abb3c77b2a8',
  '81c2c92e47edaee6',
  '92722c851482353b',
  'a2bfe8a14cf10364',
  'a81a664bbc423001',
  'c24b8b70d0f89791',
  'c76c51a30654be30',
  'd192e819d6ef5218',
  'd69906245565a910',
  'f40e35855771202a',
  '106aa07032bbd1b8',
  '19a4c116b8d2d0c8',
  '1e376c085141ab53',
  '2748774cdf8eeb99',
  '34b0bcb5e19b48a8',
  '391c0cb3c5c95a63',
  '4ed8aa4ae3418acb',
  '5b9cca4f7763e373',
  '682e6ff3d6b2b8a3',
  '748f82ee5defb2fc',
  '78a5636f43172f60',
  '84c87814a1f0ab72',
  '8cc702081a6439ec',
  '90befffa23631e28',
  'a4506cebde82bde9',
  'bef9a3f7b2c67915',
  'c67178f2e372532b',
  'ca273eceea26619c',
  'd186b8c721c0c207',
  'eada7dd6cde0eb1e',
  'f57d4f7fee6ed178',
  '06f067aa72176fba',
  '0a637dc5a2c898a6',
  '113f9804bef90dae',
  '1b710b35131c471b',
  '28db77f523047d84',
  '32caab7b40c72493',
  '3c9ebe0a15c9bebc',
  '431d67c49c100d4c',
  '4cc5d4becb3e42b6',
  '597f299cfc657e2a',
  '5fcb6fab3ad6faec',
  '6c44198c4a475817',
].map((h) => BigInt(`0x${h}`));

const MASK64 = (1n << 64n) - 1n;
const rotr64 = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & MASK64;

const SCHEDULE_512 = range(80).slice(16);

/** The eight 64-bit words of a SHA-512 state. */
type State512 = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

const sha512core = (input: string, init: State512, outWords: number): string => {
  const m = pad(utf8(input), 128, 16, false);
  let h = init;
  const view = new DataView(m.buffer);
  // The message schedule, 80 words.
  const w = new DataView(new ArrayBuffer(80 * 8));
  const word = (i: number) => w.getBigUint64(i * 8);
  blocks(m, 128).forEach((off) => {
    ROUNDS_16.forEach((i) => w.setBigUint64(i * 8, view.getBigUint64(off + i * 8)));
    SCHEDULE_512.forEach((i) => {
      const x = word(i - 15);
      const y = word(i - 2);
      const s0 = rotr64(x, 1n) ^ rotr64(x, 8n) ^ (x >> 7n);
      const s1 = rotr64(y, 19n) ^ rotr64(y, 61n) ^ (y >> 6n);
      w.setBigUint64(i * 8, (word(i - 16) + s0 + word(i - 7) + s1) & MASK64);
    });
    let [a, b, c, d, e, f, g, hh] = h;
    K512.forEach((k, i) => {
      const S1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
      const ch = (e & f) ^ (~e & MASK64 & g);
      const t1 = (hh + S1 + ch + k + word(i)) & MASK64;
      const S0 = rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) & MASK64;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) & MASK64;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) & MASK64;
    });
    const [h0, h1, h2, h3, h4, h5, h6, h7] = h;
    h = [
      (h0 + a) & MASK64,
      (h1 + b) & MASK64,
      (h2 + c) & MASK64,
      (h3 + d) & MASK64,
      (h4 + e) & MASK64,
      (h5 + f) & MASK64,
      (h6 + g) & MASK64,
      (h7 + hh) & MASK64,
    ];
  });
  return h
    .slice(0, outWords)
    .map((x) => x.toString(16).padStart(16, '0'))
    .join('');
};

const big = (x: string): bigint => BigInt(`0x${x}`);

/** A SHA-512 initial state, from its hex words. */
const state512 = (
  ...[a, b, c, d, e, f, g, h]: readonly [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ]
): State512 => [big(a), big(b), big(c), big(d), big(e), big(f), big(g), big(h)];

export const sha512 = (input: string): string =>
  sha512core(
    input,
    state512(
      '6a09e667f3bcc908',
      'bb67ae8584caa73b',
      '3c6ef372fe94f82b',
      'a54ff53a5f1d36f1',
      '510e527fade682d1',
      '9b05688c2b3e6c1f',
      '1f83d9abfb41bd6b',
      '5be0cd19137e2179',
    ),
    8,
  );

export const sha384 = (input: string): string =>
  sha512core(
    input,
    state512(
      'cbbb9d5dc1059ed8',
      '629a292a367cd507',
      '9159015a3070dd17',
      '152fecd8f70e5939',
      '67332667ffc00b31',
      '8eb44a8768581511',
      'db0c2e0d64f98fa7',
      '47b5481dbefa4fa4',
    ),
    6,
  );
