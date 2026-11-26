/** Serialize a native reply as JavaScript while retaining exact document bytes. */
export function workbenchReplyScript(reply: { id: string; result?: unknown; error?: string; status?: number }): string {
  return `window.umedaWorkbenchReply?.(${JSON.stringify(reply).replace(/</g, '\\u003c')});true;`;
}
