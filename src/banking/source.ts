import { ConfigError, type EnvLike } from '../config';
import { createLiveSourceFromEnv } from '../pluggy/source';
import type { BankingSource } from './types';

export function createBankingSource(env: EnvLike = process.env): BankingSource {
  try {
    return createLiveSourceFromEnv(env);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('Could not prepare the Pluggy read.');
  }
}
