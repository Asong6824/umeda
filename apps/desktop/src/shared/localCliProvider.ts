/** In-memory connections inherited from local CLI settings, never editable as stored providers. */
export function isLocalCliProviderId(id: string): boolean {
  return /^local-cli:(codex|claude):[a-f0-9]{24}$/.test(id);
}
