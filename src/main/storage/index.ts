/**
 * Agent Session Storage Module
 *
 * Exports all session storage implementations and provides
 * initialization for the storage registry.
 */

export { ClaudeSessionStorage, ClaudeSessionOriginsData } from './claude-session-storage';
export { OpenCodeSessionStorage } from './opencode-session-storage';
export { CodexSessionStorage } from './codex-session-storage';

import Store from 'electron-store';
import { registerSessionStorage } from '../agent-session-storage';
import { ClaudeSessionStorage, ClaudeSessionOriginsData } from './claude-session-storage';
import { OpenCodeSessionStorage } from './opencode-session-storage';
import { CodexSessionStorage } from './codex-session-storage';

/**
 * Options for initializing session storages
 */
export interface InitializeSessionStoragesOptions {
	/** The shared store for Claude session origins (names, starred status, etc.) */
	claudeSessionOriginsStore?: Store<ClaudeSessionOriginsData>;
}

/**
 * Initialize all session storage implementations.
 * Call this during application startup to register all storage providers.
 *
 * @param options - Optional configuration including shared stores
 */
export function initializeSessionStorages(options?: InitializeSessionStoragesOptions): void {
	registerSessionStorage(new ClaudeSessionStorage(options?.claudeSessionOriginsStore));
	registerSessionStorage(new OpenCodeSessionStorage());
	registerSessionStorage(new CodexSessionStorage());
}
