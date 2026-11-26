/** The runtime-only base class; domain code uses the structural ports in runtime.ts. */
declare module 'cloudflare:workers' {
  export class DurableObject<Env = unknown> {
    constructor(ctx: import('./runtime').ObjectContext, env: Env);
  }
}
