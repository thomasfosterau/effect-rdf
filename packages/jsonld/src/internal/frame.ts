/** @internal */
import type { Env } from './context.ts';
import type { Json } from './util.ts';

/** @internal */
export interface FrameOptions {
  readonly embed: '@once' | '@always' | '@never';
  readonly explicit: boolean;
  readonly omitDefault: boolean;
  readonly requireAll: boolean;
  readonly ordered: boolean;
}

/** @internal */
export const frame = (_env: Env, expanded: Json, _frame: Json, _options: FrameOptions): Json =>
  expanded;
