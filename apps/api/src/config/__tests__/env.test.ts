import { describe, expect, it } from 'vitest';
import { parseEnv } from '../env';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(20),
  COOKIE_SECRET: 'y'.repeat(20),
  PLAYBACK_SIGNING_SECRET: 'z'.repeat(20),
};

describe('parseEnv', () => {
  it('applies defaults and treats empty strings as unset', () => {
    const env = parseEnv({ ...base, RPC_URL: '', CHAIN_ID: '80002' } as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(4000);
    expect(env.CONFIRMATIONS).toBe(3);
    expect(env.RPC_URL).toBe('https://rpc-amoy.polygon.technology');
  });

  it('uses a Hardhat relayer key and 1 confirmation on the local chain', () => {
    const env = parseEnv({ ...base, CHAIN_ID: '31337' } as NodeJS.ProcessEnv);
    expect(env.SETTLEMENT_RELAYER_PRIVATE_KEY).toMatch(/^0xac09/);
    expect(env.CONFIRMATIONS).toBe(1);
    expect(env.RPC_URL).toBe('http://127.0.0.1:8545');
  });

  it('lists every missing variable', () => {
    expect(() => parseEnv({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL[\s\S]*JWT_SECRET/);
  });

  it('rejects the all-zero relayer key in production when payments run on the chain', () => {
    const zero = '0x' + '0'.repeat(64);
    expect(() =>
      parseEnv({ ...base, PAYMENTS_MODE: 'chain', NODE_ENV: 'production', SETTLEMENT_RELAYER_PRIVATE_KEY: zero } as NodeJS.ProcessEnv),
    ).toThrow(/relayer key is required/);
  });

  it('defaults to the demo bank, which needs no relayer key', () => {
    const env = parseEnv({ ...base, NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(env.PAYMENTS_MODE).toBe('bank');
    expect(env.PLATFORM_FEE_BPS).toBe(0);
  });

  it('requires a secret wallet seed for built-in wallets on a public chain, and supplies a dev seed locally', () => {
    const chain = { ...base, PAYMENTS_MODE: 'chain', CHAIN_ID: '80002' };
    expect(() => parseEnv(chain as NodeJS.ProcessEnv)).toThrow(/WALLET_MASTER_SEED/);
    expect(() => parseEnv({ ...chain, WALLET_MASTER_SEED: '0x' + '5a'.repeat(32) } as NodeJS.ProcessEnv)).toThrow(/WALLET_MASTER_SEED/);
    expect(parseEnv({ ...chain, WALLET_MASTER_SEED: '0x' + 'ab'.repeat(32) } as NodeJS.ProcessEnv).WALLET_MODE).toBe('managed');
    // Linking browser wallets needs no seed, and neither does the local development chain.
    expect(parseEnv({ ...chain, WALLET_MODE: 'external' } as NodeJS.ProcessEnv).WALLET_MASTER_SEED).toBeUndefined();
    expect(parseEnv({ ...base, PAYMENTS_MODE: 'chain', CHAIN_ID: '31337' } as NodeJS.ProcessEnv).WALLET_MASTER_SEED).toMatch(/^0x5a5a/);
  });

  it('keeps the public RPC URL separate from the server one', () => {
    const env = parseEnv({ ...base, POLYGON_AMOY_RPC_URL: 'https://polygon-amoy.example/v2/secret-key' } as NodeJS.ProcessEnv);
    expect(env.PUBLIC_RPC_URL).toBeUndefined();
    expect(parseEnv({ ...base, PUBLIC_RPC_URL: 'https://public.example' } as NodeJS.ProcessEnv).PUBLIC_RPC_URL).toBe('https://public.example');
  });

  it('reads on/off settings from the usual spellings', () => {
    expect(parseEnv({ ...base } as NodeJS.ProcessEnv).LEDGER_RESET_ON_CHANGE).toBe(false);
    expect(parseEnv({ ...base, LEDGER_RESET_ON_CHANGE: 'true' } as NodeJS.ProcessEnv).LEDGER_RESET_ON_CHANGE).toBe(true);
    expect(parseEnv({ ...base, LEDGER_RESET_ON_CHANGE: 'false' } as NodeJS.ProcessEnv).LEDGER_RESET_ON_CHANGE).toBe(false);
  });

  it('fails on unimplemented storage providers', () => {
    expect(() => parseEnv({ ...base, STORAGE_PROVIDER: 's3' } as NodeJS.ProcessEnv)).toThrow(/not implemented/);
  });
});
