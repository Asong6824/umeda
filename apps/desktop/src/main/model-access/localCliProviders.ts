import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { mergeDiscoveredRuntimeModels, type AgentKind, type CustomProviderConfig,
  type DiscoveredModel, type ProviderRuntimeModelConfig } from '@cindy/model-providers';
import { isLocalCliProviderId } from '../../shared/localCliProvider.js';

type ObjectValue = Record<string, unknown>;
export interface LocalCliProviderConnection {
  config: CustomProviderConfig;
  agent: 'codex' | 'claude-code';
  /** Main-only. Never pass connections to catalog/IPC; only pass config. */
  apiKey: string;
  headers?: Record<string, string>;
}

export interface LocalCliProviderIo {
  home: string;
  env: NodeJS.ProcessEnv;
  /** Missing, unreadable or malformed files must not affect the other CLI. */
  read(path: string): Promise<string | null>;
  /** Main injects discovery for this exact API route; no native OAuth cache is imported. */
  discoverCodexModels?: LocalCliModelDiscovery;
}

type LocalCliModelDiscovery = (connection: LocalCliProviderConnection) => Promise<DiscoveredModel[] | null>;

/** One active Codex API route per owner. Coalesce refreshes and back off failures;
 * a destination, key or header change must immediately bypass the old snapshot. */
export function createLocalCliModelDiscovery(
  fetchModels: LocalCliModelDiscovery,
  now: () => number = Date.now,
): LocalCliModelDiscovery {
  let cached: { signature: string; expires: number; pending: Promise<DiscoveredModel[] | null> } | undefined;
  return connection => {
    const runtime = connection.config.runtimes.codex;
    const signature = createHash('sha256').update(JSON.stringify([
      runtime?.baseUrl, connection.apiKey,
      Object.entries(connection.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ])).digest('hex');
    if (cached?.signature === signature && now() < cached.expires) return cached.pending;
    const entry = { signature, expires: Infinity, pending: Promise.resolve(null) as Promise<DiscoveredModel[] | null> };
    cached = entry;
    entry.pending = Promise.resolve().then(() => fetchModels(connection)).catch(() => null).then(models => {
      entry.expires = now() + (models?.length ? 5 * 60_000 : 30_000);
      return models;
    });
    return entry.pending;
  };
}

function object(value: unknown): ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as ObjectValue : {};
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function endpoint(value: unknown): string | undefined {
  const raw = string(value);
  if (!raw) return;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return;
    return raw.replace(/\/+$/, '');
  } catch { return; }
}

function connection(
  agent: LocalCliProviderConnection['agent'], baseUrl: string, apiKey: string,
  models: ProviderRuntimeModelConfig[], wireProtocol: 'openai-responses' | 'anthropic-messages',
  headers: Record<string, string> = {},
): LocalCliProviderConnection | undefined {
  if (!models.length) return;
  // Route identity changes with the destination. An old task must never send its credential
  // to a newly configured endpoint under the same provider id.
  const suffix = createHash('sha256').update(JSON.stringify([agent, baseUrl])).digest('hex').slice(0, 24);
  return {
    agent, apiKey, headers,
    config: {
      id: `local-cli:${agent === 'codex' ? 'codex' : 'claude'}:${suffix}`,
      name: agent === 'codex' ? 'Codex CLI' : 'Claude Code CLI',
      runtimes: { [agent]: { baseUrl, wireProtocol, models,
        ...(Object.keys(headers).length ? { headersState: 'configured' as const } : {}),
      } },
    },
  };
}

function model(id: string): ProviderRuntimeModelConfig {
  return { id, name: id, defaultEnabled: true };
}

/** Reads only user-level configuration. Never executes apiKeyHelper/hooks or reads project settings. */
export async function discoverLocalCliProviders(io: LocalCliProviderIo): Promise<LocalCliProviderConnection[]> {
  if (io.env.XDT_UI_MOCK === '1') return [];
  const codex = async () => {
    const home = string(io.env.CODEX_HOME) ?? path.join(io.home, '.codex');
    const raw = await io.read(path.join(home, 'config.toml'));
    const root = raw ? object(parseToml(raw)) : {};
    const profile = object(object(root.profiles)[string(root.profile) ?? '']);
    const config = { ...root, ...profile };
    const providerName = string(config.model_provider);
    const provider = object(object(root.model_providers)[providerName ?? '']);
    const wire = string(provider.wire_api);
    if (wire && wire !== 'responses') return;
    const baseUrl = endpoint(provider.base_url ?? io.env.OPENAI_BASE_URL
      ?? (!providerName || providerName === 'openai' ? 'https://api.openai.com/v1' : undefined));
    const id = string(config.model);
    if (!baseUrl || !id) return;
    // Explicit env_key never falls back to credentials for a different provider.
    const envKey = string(provider.env_key);
    let apiKey = envKey ? string(io.env[envKey]) : string(provider.experimental_bearer_token);
    if (!apiKey && !envKey) {
      const auth = await io.read(path.join(home, 'auth.json'));
      apiKey = string(io.env.OPENAI_API_KEY) ?? (auth ? string(object(JSON.parse(auth)).OPENAI_API_KEY) : undefined);
    }
    if (!apiKey) return; // OAuth tokens are never imported as API keys.
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(object(provider.http_headers))) {
      if (typeof value !== 'string') return;
      headers[key] = value;
    }
    for (const [key, envName] of Object.entries(object(provider.env_http_headers))) {
      const value = typeof envName === 'string' ? string(io.env[envName]) : undefined;
      if (!value) return;
      headers[key] = value;
    }
    const inherited = connection('codex', baseUrl, apiKey, [model(id)], 'openai-responses', headers)!;
    try {
      const discovered = await io.discoverCodexModels?.(inherited);
      if (discovered?.length) {
        const models = mergeDiscoveredRuntimeModels([], discovered).map(item => ({ ...item, defaultEnabled: true }));
        // Keep the CLI's configured default first; discovery must not silently change it.
        inherited.config.runtimes.codex!.models = [
          models.find(item => item.id === id) ?? model(id),
          ...models.filter(item => item.id !== id),
        ];
      }
    } catch { /* A catalog outage must not hide an otherwise usable CLI connection. */ }
    return inherited;
  };
  const claude = async () => {
    const home = string(io.env.CLAUDE_CONFIG_DIR) ?? path.join(io.home, '.claude');
    const raw = await io.read(path.join(home, 'settings.json'));
    const config = raw ? object(JSON.parse(raw)) : {};
    const env = { ...io.env, ...object(config.env) };
    // Cloud provider modes have their own credentials and signing; do not reinterpret them.
    if (['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
      .some(key => env[key] === '1' || env[key] === 'true')) return;
    const baseUrl = endpoint(env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com');
    const token = string(env.ANTHROPIC_AUTH_TOKEN);
    // Native subscription credentials stay with Claude Code. Only inherit bearer tokens
    // for explicitly configured third-party API destinations, never the official OAuth route.
    const apiKey = token && baseUrl && new URL(baseUrl).hostname !== 'api.anthropic.com'
      && !token.startsWith('sk-ant-oat') ? token : string(env.ANTHROPIC_API_KEY);
    if (!baseUrl || !apiKey) return;
    const ids = [...new Set([
      env.ANTHROPIC_MODEL, config.model,
      env.ANTHROPIC_DEFAULT_OPUS_MODEL, env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ].map(string).filter((id): id is string => !!id && !['opus', 'sonnet', 'haiku'].includes(id)))];
    const headers: Record<string, string> = {};
    for (const line of (string(env.ANTHROPIC_CUSTOM_HEADERS) ?? '').split('\n').filter(Boolean)) {
      const colon = line.indexOf(':');
      if (colon < 1) return;
      headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
    return connection('claude-code', baseUrl, apiKey, ids.map(model), 'anthropic-messages', headers);
  };
  const results = await Promise.allSettled([codex(), claude()]);
  return results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
}

export function defaultLocalCliProviderIo(discoverCodexModels?: LocalCliModelDiscovery): LocalCliProviderIo {
  return {
    home: homedir(), env: { ...process.env }, discoverCodexModels,
    read: async file => {
      try { return await readFile(file, 'utf8'); } catch { return null; }
    },
  };
}

/** Atomic catalog/key snapshot; authorization is supplied by the current application session. */
export function createLocalCliProviderRegistry() {
  let connections: LocalCliProviderConnection[] = [];
  let authorized: () => boolean = () => false;
  return {
    replace(next: LocalCliProviderConnection[], isAuthorized: () => boolean,
      onChanged: (id: string) => void = () => {},
    ): CustomProviderConfig[] {
      const previous = new Map(connections.map(item => [item.config.id, item]));
      const incoming = new Map(next.map(item => [item.config.id, item]));
      for (const id of new Set([...previous.keys(), ...incoming.keys()])) {
        if (JSON.stringify(previous.get(id)) !== JSON.stringify(incoming.get(id))) onChanged(id);
      }
      connections = next;
      authorized = isAuthorized;
      return next.map(item => item.config);
    },
    readKey(providerId: string, agent: AgentKind | string): string | null {
      if (!authorized()) return null;
      return connections.find(item => item.config.id === providerId && item.agent === agent)?.apiKey ?? null;
    },
    readHeaders(providerId: string, agent: string): Record<string, string> | null {
      if (!authorized()) return null;
      const headers = connections.find(item => item.config.id === providerId && item.agent === agent)?.headers;
      return headers ? { ...headers } : null;
    },
    clear(): void { connections = []; authorized = () => false; },
  };
}

export const localCliProviderRegistry = createLocalCliProviderRegistry();
export { isLocalCliProviderId };
