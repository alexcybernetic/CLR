import type { ModelIdentity } from './model.ts';
import type { ReactorEngine } from '../../engine/src/soup.ts';

export const CUBFF_SOURCE_REVISION = '8e3f774df03d1c895ec6ee0d21b6897ecea46806';
export const BRAINFUCK_LIFE_SOURCE_REVISION = '9d2638361a0ae5519dfe56539059cfec094cbd6e';
export const ORDER_COMPRESSOR = 'Brotli 1.1.0; quality=2; lgwin=24; mode=generic';

export function modelIdentity(
  appVersion: string,
  engine: ReactorEngine,
  core = 'pending',
): ModelIdentity {
  return {
    appVersion,
    core,
    sourceRevision:
      engine === 'brainfuck-life' ? BRAINFUCK_LIFE_SOURCE_REVISION : CUBFF_SOURCE_REVISION,
    compressor: ORDER_COMPRESSOR,
  };
}
