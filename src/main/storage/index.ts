/**
 * Agent Session Storage Module
 *
 * Exports all session storage implementations and provides
 * initialization for the storage registry.
 */

export { ClaudeSessionStorage } from './claude-session-storage';
export { OpenCodeSessionStorage } from './opencode-session-storage';
export { CodexSessionStorage } from './codex-session-storage';
export { FactoryDroidSessionStorage } from './factory-droid-session-storage';
export { CopilotSessionStorage } from './copilot-session-storage';
export { OmpSessionStorage } from './omp-session-storage';
export { GrokSessionStorage } from './grok-session-storage';

import Store from 'electron-store';
import type { AgentSessionOriginsData } from '../stores/types';
import { registerSessionStorage } from '../agents';
import { ClaudeSessionStorage } from './claude-session-storage';
import { OpenCodeSessionStorage } from './opencode-session-storage';
import { CodexSessionStorage } from './codex-session-storage';
import { FactoryDroidSessionStorage } from './factory-droid-session-storage';
import { CopilotSessionStorage } from './copilot-session-storage';
import { OmpSessionStorage } from './omp-session-storage';
import { GrokSessionStorage } from './grok-session-storage';

/**
 * Options for initializing session storages
 */
export interface InitializeSessionStoragesOptions {
	/** Shared canonical store for Claude session origins (names, stars, context usage). */
	agentSessionOriginsStore?: Store<AgentSessionOriginsData>;
}

/**
 * Initialize all session storage implementations.
 * Call this during application startup to register all storage providers.
 *
 * @param options - Optional configuration including shared stores
 */
export function initializeSessionStorages(options?: InitializeSessionStoragesOptions): void {
	registerSessionStorage(new ClaudeSessionStorage(options?.agentSessionOriginsStore));
	registerSessionStorage(new OpenCodeSessionStorage());
	registerSessionStorage(new CodexSessionStorage());
	registerSessionStorage(new FactoryDroidSessionStorage());
	registerSessionStorage(new CopilotSessionStorage());
	registerSessionStorage(new OmpSessionStorage());
	registerSessionStorage(new GrokSessionStorage());
}
