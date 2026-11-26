/* Only the selected public relay is contacted. No Agent, credential or filesystem access. */
const channel = new BroadcastChannel('umeda-kos-v1');
const requests = new Map();
const configuration = fetch('/host-config.json').then(async response => {
  if (!response.ok) throw new Error('资料库地址尚未配置。');
  const value = await response.json(), url = new URL(value.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('资料库地址无效。');
  return { baseUrl: url.origin };
});
async function handle(operation, payload) {
  const { baseUrl } = await configuration;
  if (operation === 'info') return { namespace: `relay:${baseUrl}`, platform: 'desktop' };
  if (operation !== 'http') throw new Error('不支持此操作。');
  if (!payload || typeof payload.path !== 'string' || !/^\/api\/vaults(?:[/?]|$)/.test(payload.path) || payload.path.includes('..') || payload.path.length > 5000) throw new Error('资料库请求无效。');
  const method = payload.method || 'GET';
  if (!['GET', 'PUT', 'DELETE'].includes(method) || (payload.body !== undefined && (typeof payload.body !== 'string' || new TextEncoder().encode(payload.body).length > 256 * 1024))) throw new Error('资料库请求超过范围。');
  const headers = {};
  for (const key of ['x-vault-base-revision', 'content-type']) if (typeof payload.headers?.[key] === 'string') headers[key] = payload.headers[key];
  const result = await cindy.fetch({ url: baseUrl + payload.path, method, headers, ...(payload.body !== undefined ? { body: payload.body } : {}), timeoutMs: 60000, as: 'text' });
  if (!result.ok || result.truncated || typeof result.body !== 'string') throw new Error('暂时无法连接资料库，未同步的编辑仍保存在本机。');
  return { status: result.status, body: result.body };
}
channel.onmessage = event => {
  const message = event.data;
  if (!message || typeof message.id !== 'string' || message.id.length > 160 || typeof message.operation !== 'string') return;
  let request = requests.get(message.id);
  if (!request) {
    request = handle(message.operation, message.payload).then(result => ({ id: message.id, result }), error => ({ id: message.id, error: error instanceof Error ? error.message : '暂时无法完成操作。' }));
    requests.set(message.id, request);
    if (requests.size > 48) requests.delete(requests.keys().next().value);
  }
  void request.then(reply => channel.postMessage(reply));
};
cindy.onHostMessage(() => undefined);
