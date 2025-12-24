/**
 * ACP (Agent Client Protocol) Module
 *
 * Provides standardized communication with ACP-compatible agents like OpenCode.
 * This enables Maestro to use a single protocol for all agents instead of
 * custom parsers for each agent type.
 *
 * @see https://agentclientprotocol.com/
 */

export { ACPClient, type ACPClientConfig, type ACPClientEvents } from './acp-client';
export * from './types';
export {
  acpUpdateToParseEvent,
  createSessionIdEvent,
  createResultEvent,
  createErrorEvent,
} from './acp-adapter';
export { ACPProcess, spawnACPProcess, type ACPProcessConfig } from './acp-process';
