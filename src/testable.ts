/** Stable entry point for integration tests (bundled to dist/testable.js). */
export { JsonlDecoder, encodeJsonLine } from './pi/Jsonl';
export { Config } from './core/Config';
export { Log } from './core/Log';
export { WorkspaceRegistry } from './core/WorkspaceRegistry';
export { PathMapper, globMatch } from './changes/PathMapper';
export { ShadowGit, emptyStats } from './changes/ShadowGit';
export { Collector } from './changes/Collector';
export { SnapshotService } from './changes/SnapshotService';
export { ShadowDocProvider } from './changes/ShadowDocProvider';
export { Resolver } from './pi/Resolver';
export { discoverSessions, readSessionInfo, normalizeCwd, preview } from './session/SessionDiscovery';
export { RpcGateway } from './pi/RpcGateway';
export { EditTracker, reversePatch, countLines, countPatch } from './changes/EditTracker';
export { RuntimeProbe } from './core/RuntimeProbe';
