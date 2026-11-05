import { describe, expect, it } from '@effect/vitest';
import * as Schema from 'effect/Schema';
import { LanguageTag } from '../src/index.ts';

const wellFormed = [
  'en',
  'EN',
  'en-GB',
  'en-gb-oed',
  'zh-Hant-TW',
  'sr-Latn-RS',
  'es-419',
  'de-CH-1901',
  'sl-rozaj-biske',
  'hy-Latn-IT-arevela',
  'zh-yue-HK',
  'en-US-u-islamcal',
  'en-a-myext-b-another',
  'de-CH-x-phonebk',
  'x-whatever',
  'i-klingon',
  'qaa-Qaaa-QM-x-southern',
  'abcdefgh',
];

const illFormed = [
  '',
  'e',
  'abcdefghi',
  'en-',
  '-en',
  'en--gb',
  'en-x',
  'en-a',
  'en-a-b',
  'de-419-DE-1',
  'en_GB',
  'en-GB-toolongsubtag',
  '1en',
  'ar--rtl',
];

describe('LanguageTag', () => {
  it('accepts well-formed BCP 47 tags', () => {
    expect(wellFormed.filter((tag) => !LanguageTag.isWellFormed(tag))).toStrictEqual([]);
  });
  it('rejects ill-formed tags', () => {
    expect(illFormed.filter((tag) => LanguageTag.isWellFormed(tag))).toStrictEqual([]);
  });
  it('normalizes to lower case', () => {
    expect(LanguageTag.normalize('en-GB')).toBe('en-gb');
  });
  it('validates through LanguageTagSchema', () => {
    const decode = Schema.decodeUnknownResult(LanguageTag.LanguageTagSchema);
    expect(decode('zh-Hant')._tag).toBe('Success');
    expect(decode('en_GB')._tag).toBe('Failure');
    expect(decode(1)._tag).toBe('Failure');
  });
});
