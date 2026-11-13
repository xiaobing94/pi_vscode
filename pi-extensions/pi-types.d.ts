declare module '@earendil-works/pi-coding-agent' {
  /** Structural subset used by shadow-snapshot.ts; Pi loads .ts via jiti and does not typecheck at runtime. */
  export interface ExtensionAPI {
    on(event: string, handler: (event: any, ctx?: any) => any): void;
    [key: string]: unknown;
  }
}
