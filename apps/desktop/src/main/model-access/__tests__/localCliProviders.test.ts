import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildUserProvider, parseModelsListResponse } from '@cindy/model-providers';
import { createLocalCliModelDiscovery, createLocalCliProviderRegistry, discoverLocalCliProviders, type LocalCliProviderIo } from '../localCliProviders.js';

// Test value: discoverLocalCliProviders -> real provider projection and main-only key lookup.
// Regression: existing CLI API settings were treated as missing official subscription logins.
// Coverage gap: native auth tests only cover OAuth; these cases never read real HOME or spawn CLI.
// Minimal failure: a custom model_provider + OPENAI_API_KEY, or settings.env with an API token.
// Tier: unit (in-memory IO, separate from DB/catalog integration). Timing recorded in delivery.
function fixture(files: Record<string, string>, env: NodeJS.ProcessEnv = {}): LocalCliProviderIo {
  const home = path.resolve('fixture-cli-home');
  const stored = new Map(Object.entries(files).map(([file, content]) => [path.join(home, ...file.split('/')), content]));
  return { home, env, read: async file => stored.get(file) ?? null };
}

const codexConfig = 'model = "custom-codex"\nmodel_provider = "relay"\n[model_providers.relay]\nbase_url = "https://relay.example/v1"\nwire_api = "responses"';
const claudeSettings = JSON.stringify({ env: {
  ANTHROPIC_BASE_URL: 'https://claude-relay.example/anthropic', ANTHROPIC_AUTH_TOKEN: 'fixture-claude-key',
  ANTHROPIC_MODEL: 'custom-sonnet', ANTHROPIC_DEFAULT_SONNET_MODEL: 'custom-sonnet',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'custom-haiku',
} });

describe('local CLI API connections', () => {
  // User regression: a multi-model Codex API connection exposed only config.model.
  // Existing cases cover config inheritance, never a discovered list. Unit tier:
  // production discovery -> provider projection with two models, entirely in memory.
  it('includes discovered Codex models and metadata while retaining the configured default and main-only credentials', async () => {
    const io = fixture({ '.codex/config.toml': codexConfig,
      '.codex/auth.json': '{"OPENAI_API_KEY":"fixture-key"}' });
    io.discoverCodexModels = async connection => {
      expect(connection.config.runtimes.codex?.baseUrl).toBe('https://relay.example/v1');
      expect(connection.apiKey).toBe('fixture-key');
      return parseModelsListResponse({ data: [
        { id: 'second-model', context_window: 400_000 },
        { id: 'custom-codex', display_name: 'Configured model' },
        { id: 'second-model' },
      ] });
    };
    const [item] = await discoverLocalCliProviders(io);
    const provider = buildUserProvider(item.config);
    expect(provider.models.codex?.map(model => model.id)).toEqual(['custom-codex', 'second-model']);
    expect(provider.models.codex?.[1].contextWindow).toBe(400_000);
    expect(JSON.stringify(item.config)).not.toContain('fixture-key');
  });

  it.each(['failure', 'empty', 'throw'] as const)('retains configured models when Codex discovery returns %s', async outcome => {
    const io = fixture({ '.codex/config.toml': codexConfig,
      '.codex/auth.json': '{"OPENAI_API_KEY":"fixture-key"}', '.claude/settings.json': claudeSettings });
    io.discoverCodexModels = async () => {
      if (outcome === 'throw') throw new Error('fixture network failure');
      return outcome === 'empty' ? [] : null;
    };
    const items = await discoverLocalCliProviders(io);
    expect(items.map(item => item.agent)).toEqual(['codex', 'claude-code']);
    expect(items[0].config.runtimes.codex?.models.map(model => model.id)).toEqual(['custom-codex']);
  });

  // The catalog is re-read from several UI/auth paths. Protect the new network
  // boundary against repeated requests and reusing one credential's model list
  // after a key/header/endpoint change; clock and responses are injected (unit).
  it('coalesces Codex discovery, refreshes expired lists and isolates changed route credentials', async () => {
    let time = 0;
    let release!: (models: { id: string; name: string }[]) => void;
    const fetchModels = vi.fn(() => new Promise<{ id: string; name: string }[]>(resolve => { release = resolve; }));
    const discover = createLocalCliModelDiscovery(fetchModels, () => time);
    const io = fixture({ '.codex/config.toml': codexConfig,
      '.codex/auth.json': '{"OPENAI_API_KEY":"fixture-key"}' });
    const [connection] = await discoverLocalCliProviders(io);
    const first = discover(connection);
    const concurrent = discover(connection);
    await Promise.resolve();
    expect(fetchModels).toHaveBeenCalledOnce();
    release([{ id: 'new-model', name: 'New model' }]);
    expect(await first).toEqual(await concurrent);
    await discover(connection);
    expect(fetchModels).toHaveBeenCalledOnce();
    fetchModels.mockImplementation(async () => [{ id: 'replacement', name: 'Replacement' }]);
    time = 300_001;
    expect(await discover(connection)).toEqual([{ id: 'replacement', name: 'Replacement' }]);
    await discover({ ...connection, apiKey: 'rotated-fixture-key' });
    await discover({ ...connection, apiKey: 'rotated-fixture-key', headers: { 'X-Tenant': 'second' } });
    await discover({ ...connection, config: { ...connection.config, runtimes: {
      codex: { ...connection.config.runtimes.codex!, baseUrl: 'https://another.example/v1' },
    } } });
    expect(fetchModels).toHaveBeenCalledTimes(5);
    // A fresh owner gets a fresh reader, including for an identical endpoint/key.
    await createLocalCliModelDiscovery(fetchModels)(connection);
    expect(fetchModels).toHaveBeenCalledTimes(6);
  });

  it('backs off failed Codex discovery and recovers on the next eligible refresh', async () => {
    let time = 0;
    const fetchModels = vi.fn(async (): Promise<{ id: string; name: string }[] | null> => { throw new Error('fixture offline'); });
    const discover = createLocalCliModelDiscovery(fetchModels, () => time);
    const io = fixture({ '.codex/config.toml': codexConfig,
      '.codex/auth.json': '{"OPENAI_API_KEY":"fixture-key"}' });
    io.discoverCodexModels = discover;
    await discoverLocalCliProviders(io);
    await discoverLocalCliProviders(io);
    expect(fetchModels).toHaveBeenCalledOnce();
    time = 30_001;
    fetchModels.mockResolvedValue([{ id: 'recovered', name: 'Recovered' }]);
    const [item] = await discoverLocalCliProviders(io);
    expect(item.config.runtimes.codex?.models.map(model => model.id)).toEqual(['custom-codex', 'recovered']);
    expect(fetchModels).toHaveBeenCalledTimes(2);
  });

  it('projects both API routes and models without including keys in catalog configs', async () => {
    const items = await discoverLocalCliProviders(fixture({
      '.codex/config.toml': codexConfig, '.codex/auth.json': '{"OPENAI_API_KEY":"fixture-codex-key"}',
      '.claude/settings.json': claudeSettings,
    }));
    expect(items).toHaveLength(2);
    expect(items.map(item => buildUserProvider(item.config))).toMatchObject([
      { auth: { method: 'apiKey' }, routing: { codex: { upstream: 'https://relay.example/v1' } },
        models: { codex: [{ id: 'custom-codex', defaultEnabled: true }] } },
      { auth: { method: 'apiKey' }, routing: { 'claude-code': { upstream: 'https://claude-relay.example/anthropic' } },
        models: { 'claude-code': [{ id: 'custom-sonnet' }, { id: 'custom-haiku' }] } },
    ]);
    expect(JSON.stringify(items.map(item => item.config))).not.toContain('fixture-');
  });

  it('uses the selected Codex profile and its explicit env_key without falling back to other keys', async () => {
    const files = { '.codex/config.toml': codexConfig + '\n' +
      'env_key = "RELAY_KEY"\n[profiles.work]\nmodel = "profile-model"\n',
    '.codex/auth.json': '{"OPENAI_API_KEY":"wrong-fixture-key"}' };
    files['.codex/config.toml'] = 'profile = "work"\n' + files['.codex/config.toml'];
    expect(await discoverLocalCliProviders(fixture(files))).toEqual([]);
    const [item] = await discoverLocalCliProviders(fixture(files, { RELAY_KEY: 'right-fixture-key' }));
    expect(item.apiKey).toBe('right-fixture-key');
    expect(item.config.runtimes.codex?.models[0].id).toBe('profile-model');
  });

  it('honors CLI home overrides and inherited API environment without reading default homes', async () => {
    const io = fixture({ 'alternate/config.toml': codexConfig,
      'alternate/auth.json': '{"OPENAI_API_KEY":"fixture-alternate-key"}' });
    io.env = { CODEX_HOME: path.join(io.home, 'alternate'), CLAUDE_CONFIG_DIR: path.join(io.home, 'empty'),
      ANTHROPIC_BASE_URL: 'https://env-relay.example', ANTHROPIC_API_KEY: 'fixture-env-key', ANTHROPIC_MODEL: 'env-model' };
    const items = await discoverLocalCliProviders(io);
    expect(items.map(item => item.apiKey)).toEqual(['fixture-alternate-key', 'fixture-env-key']);
  });

  it.each(['tokens', 'unsupported-wire', 'unsafe-url', 'missing-model'])('does not turn %s into an API connection', async kind => {
    let config = codexConfig;
    let auth = '{"OPENAI_API_KEY":"fixture-key"}';
    if (kind === 'tokens') auth = '{"tokens":{"access_token":"fixture-oauth-token"}}';
    if (kind === 'unsupported-wire') config = config.replace('"responses"', '"unknown"');
    if (kind === 'unsafe-url') config = config.replace('https://relay.example/v1', 'https://user:secret@relay.example/v1');
    if (kind === 'missing-model') config = config.replace('model = "custom-codex"', '');
    expect(await discoverLocalCliProviders(fixture({ '.codex/config.toml': config, '.codex/auth.json': auth }))).toEqual([]);
  });

  it('isolates malformed settings and never executes a Claude apiKeyHelper', async () => {
    const items = await discoverLocalCliProviders(fixture({ '.codex/config.toml': 'malformed [[[',
      '.claude/settings.json': claudeSettings }));
    expect(items.map(item => item.agent)).toEqual(['claude-code']);
    expect(await discoverLocalCliProviders(fixture({ '.claude/settings.json':
      '{"apiKeyHelper":"must-not-execute","model":"some-model"}' }))).toEqual([]);
  });

  it('keeps custom headers main-only and does not read user settings in UI mock mode', async () => {
    const io = fixture({ '.codex/config.toml': codexConfig + '\n[model_providers.relay.http_headers]\nx-tenant = "private-tenant"',
      '.codex/auth.json': '{"OPENAI_API_KEY":"fixture-key"}' });
    const items = await discoverLocalCliProviders(io);
    const registry = createLocalCliProviderRegistry();
    const [config] = registry.replace(items, () => true);
    expect(registry.readHeaders(config.id, 'codex')).toEqual({ 'x-tenant': 'private-tenant' });
    expect(JSON.stringify(buildUserProvider(config))).not.toContain('private-tenant');
    io.env.XDT_UI_MOCK = '1';
    io.read = async () => { throw new Error('UI mock must not read local configuration'); };
    expect(await discoverLocalCliProviders(io)).toEqual([]);
  });

  it('does not import official Claude subscription tokens as API credentials', async () => {
    expect(await discoverLocalCliProviders(fixture({ '.claude/settings.json': JSON.stringify({ env: {
      ANTHROPIC_AUTH_TOKEN: 'fixture-oauth-token', ANTHROPIC_MODEL: 'some-model',
    } }) }))).toEqual([]);
  });

  it('revokes an entire key snapshot on owner change or config removal and changes identity with the destination', async () => {
    const files = { '.codex/config.toml': codexConfig, '.codex/auth.json': '{"OPENAI_API_KEY":"fixture-key"}' };
    const items = await discoverLocalCliProviders(fixture(files));
    const registry = createLocalCliProviderRegistry();
    let authorized = true;
    const [config] = registry.replace(items, () => authorized);
    expect(registry.readKey(config.id, 'codex')).toBe('fixture-key');
    expect(registry.readKey(config.id, 'claude-code')).toBeNull();
    authorized = false;
    expect(registry.readKey(config.id, 'codex')).toBeNull();
    authorized = true;
    registry.replace([], () => authorized);
    expect(registry.readKey(config.id, 'codex')).toBeNull();
    const [changed] = await discoverLocalCliProviders(fixture({ ...files,
      '.codex/config.toml': codexConfig.replace('relay.example', 'different.example') }));
    expect(changed.config.id).not.toBe(config.id);
  });
});
