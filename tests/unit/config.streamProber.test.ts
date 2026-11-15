import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_STREAM_PROBER_CONFIG,
  defaultProbeBudget,
  loadConfig,
  parseStreamProber,
} from '../../src/config.js';

const DB = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/a' };

describe('stream prober settings', () => {
  it('is off when NOTESD_STREAM_PROBER is unset, blank or off, with the default limits', () => {
    for (const env of [{}, { NOTESD_STREAM_PROBER: '' }, { NOTESD_STREAM_PROBER: 'off' }]) {
      expect(parseStreamProber(env)).toEqual(DEFAULT_STREAM_PROBER_CONFIG);
    }
    expect(DEFAULT_STREAM_PROBER_CONFIG).toMatchObject({ enabled: false, catalogSize: 300, idleSeconds: 600, probeMs: 1_200_000 });
    expect(DEFAULT_STREAM_PROBER_CONFIG.probeBudget).toBe(defaultProbeBudget(1_200_000));
  });

  it('reads every setting, and the budget default follows the pause between passes', () => {
    expect(
      parseStreamProber({ NOTESD_STREAM_PROBER: 'on', NOTESD_STREAM_CATALOG_SIZE: '50', NOTESD_STREAM_PROBE_BUDGET: '4', NOTESD_STREAM_IDLE_SECONDS: '120', NOTESD_STREAM_PROBE_MS: '300000' }),
    ).toEqual({ enabled: true, catalogSize: 50, probeBudget: 4, idleSeconds: 120, probeMs: 300_000 });
    expect(parseStreamProber({ NOTESD_STREAM_PROBE_MS: '300000' }).probeBudget).toBe(defaultProbeBudget(300_000));
  });

  it('refuses a bad value', () => {
    expect(() => parseStreamProber({ NOTESD_STREAM_PROBER: 'maybe' })).toThrow(ConfigError);
    expect(() => parseStreamProber({ NOTESD_STREAM_CATALOG_SIZE: '0' })).toThrow(ConfigError);
    expect(() => parseStreamProber({ NOTESD_STREAM_PROBE_BUDGET: '-1' })).toThrow(ConfigError);
    expect(() => parseStreamProber({ NOTESD_STREAM_IDLE_SECONDS: 'ten' })).toThrow(ConfigError);
  });

  it('lands in config.directStream.prober', () => {
    expect(loadConfig({ env: DB, envFile: false }).directStream?.prober.enabled).toBe(false);
    expect(loadConfig({ env: { ...DB, NOTESD_STREAM_PROBER: 'on' }, envFile: false }).directStream?.prober.enabled).toBe(true);
  });
});
