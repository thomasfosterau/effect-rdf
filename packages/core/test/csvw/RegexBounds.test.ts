import { describe, expect, it } from 'vite-plus/test';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import { Datatype } from '../../src/csvw/index.ts';

const datatype: Datatype.Datatype = { base: 'string', format: '(a+)+', common: {} };
const parse = (text: string) => Datatype.parse(text, datatype, Option.none());

describe('CSVW string format bounds', () => {
  it('a catastrophic format is evaluated in linear time', () => {
    const start = performance.now();
    const bad = parse(`${'a'.repeat(32)}!`);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2000);
    expect(Result.isFailure(bad)).toBe(true);
    expect(Result.isSuccess(parse('a'.repeat(32)))).toBe(true);
  });
});
