import { describe, expect, it } from 'vite-plus/test';
import * as Option from 'effect/Option';
import { Packet } from '../src/index.ts';
import { some } from './fixtures.ts';

const utf8 = (text: string) => new TextEncoder().encode(text);

const utf16 = (text: string, littleEndian: boolean): Uint8Array => {
  const bytes = new Uint8Array(text.length * 2);
  const view = new DataView(bytes.buffer);
  Array.from(text).forEach((c, i) => view.setUint16(i * 2, c.charCodeAt(0), littleEndian));
  return bytes;
};

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((offset, p) => {
    out.set(p, offset);
    return offset + p.length;
  }, 0);
  return out;
};

const packet = (body: string, end = 'w') =>
  `<?xpacket begin="﻿" id="${Packet.PACKET_ID}"?>${body}<?xpacket end="${end}"?>`;

describe('Packet.find', () => {
  it('finds a UTF-8 packet among binary bytes', () => {
    const text = packet('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>');
    const prefix = Uint8Array.of(0x00, 0xff, 0x80, 0x9d, 0x3c);
    const bytes = concat(prefix, utf8(text), Uint8Array.of(0x81, 0x00));
    const found = some(Packet.find(bytes));
    expect(found.offset).toBe(prefix.length);
    expect(found.length).toBe(utf8(text).length);
    expect(found.encoding).toBe('utf-8');
    expect(found.writable).toBe(true);
    expect(found.text).toBe(text);
  });

  it('finds UTF-16 packets in either byte order', () => {
    const text = packet('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>', 'r');
    const orders = [
      [false, 'utf-16be'],
      [true, 'utf-16le'],
    ] as const;
    orders.forEach(([littleEndian, encoding]) => {
      const found = some(Packet.find(concat(Uint8Array.of(1, 2, 3), utf16(text, littleEndian))));
      expect(found.encoding).toBe(encoding);
      expect(found.offset).toBe(3);
      expect(found.writable).toBe(false);
      expect(found.text).toBe(text);
    });
  });

  it('finds nothing without a header, or with a header but no trailer', () => {
    expect(Option.isNone(Packet.find(utf8('<x:xmpmeta/>')))).toBe(true);
    expect(Option.isNone(Packet.find(utf8('<?xpacket begin="" id="x"?><x:xmpmeta/>')))).toBe(true);
  });

  it('finds every packet in order', () => {
    const a = packet('<a/>');
    const b = packet('<b/>', 'r');
    const bytes = utf8(`junk${a}more junk${b}tail`);
    const found = Packet.findAll(bytes);
    expect(found.map((p) => [p.offset, p.text, p.writable])).toEqual([
      [4, a, true],
      [4 + utf8(a).length + 'more junk'.length, b, false],
    ]);
    expect(some(Packet.find(bytes, 5)).text).toBe(b);
  });
});

describe('Packet.unwrap', () => {
  it('splits the XMP from its padding and trailer', () => {
    const text = Packet.wrap('<x:xmpmeta/>', { padding: 250 });
    expect(Packet.unwrap(text)).toEqual(
      Option.some({ xml: '<x:xmpmeta/>', padding: 251, writable: true }),
    );
  });

  it('is None for text that is not a packet', () => {
    expect(Option.isNone(Packet.unwrap('<x:xmpmeta/>'))).toBe(true);
    expect(Option.isNone(Packet.unwrap('<?xpacket end="w"?><?xpacket begin=""?>'))).toBe(true);
  });
});

describe('Packet.wrap', () => {
  it('writes a writable packet with 2 KiB of padding by default', () => {
    const text = Packet.wrap('<x:xmpmeta/>');
    expect(text.startsWith(`<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n`)).toBe(true);
    expect(text.endsWith('<?xpacket end="w"?>')).toBe(true);
    expect(some(Packet.unwrap(text)).padding).toBe(Packet.DEFAULT_PADDING + 1);
  });

  it('writes a read-only packet without padding by default', () => {
    expect(Packet.wrap('<x:xmpmeta/>\n', { writable: false })).toBe(
      `<?xpacket begin="﻿" id="${Packet.PACKET_ID}"?>\n<x:xmpmeta/>\n<?xpacket end="r"?>`,
    );
  });

  it('pads with lines of 100 bytes', () => {
    expect(Packet.padding(250)).toBe(`${' '.repeat(99)}\n${' '.repeat(99)}\n${' '.repeat(50)}`);
    expect(Packet.padding(0)).toBe('');
  });

  it('wraps to an exact byte size for in-place updates', () => {
    const xml = '<x:xmpmeta>é</x:xmpmeta>';
    const text = some(Packet.wrapToSize(xml, 400));
    expect(Packet.byteLength(text)).toBe(400);
    const readOnly = some(Packet.wrapToSize(xml, 400, { writable: false }));
    expect(Packet.byteLength(readOnly)).toBe(400);
    expect(readOnly.endsWith('end="r"?>')).toBe(true);
    expect(Option.isNone(Packet.wrapToSize(xml, 50))).toBe(true);
  });
});
