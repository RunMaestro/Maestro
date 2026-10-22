/** Host-owned provider-session ownership for resumable plugin agent runs. */
import { createHash } from 'crypto';
import { logger } from '../utils/logger';
import { PluginKvStore } from './plugin-kv-store';

/**
 * The plugin only receives a provider session ID after a successful run. This
 * separate store is never exposed through maestro.storage, so a plugin cannot
 * claim another agent's provider session by writing its own KV data.
 */
export class PluginAgentSessionBindings {
	private readonly store: PluginKvStore;

	constructor(baseDir: string, maxBindings = 10_000) {
		this.store = new PluginKvStore({ baseDir, limits: { maxKeys: maxBindings } });
	}

	private key(sessionId: string): string {
		return createHash('sha256').update(sessionId).digest('hex');
	}

	assertOwned(pluginId: string, agentId: string, sessionId: string): void {
		if (this.store.get(pluginId, this.key(sessionId)) !== agentId) {
			throw new Error('agents.send: provider session is not owned by this plugin and agent');
		}
	}

	/** Read-only ownership check for conservative migration of old plugin sessions. */
	isOwned(pluginId: string, agentId: string, sessionId: string): boolean {
		return this.store.get(pluginId, this.key(sessionId)) === agentId;
	}

	hasBindings(pluginId: string): boolean {
		return this.store.keys(pluginId).length > 0;
	}

	remember(pluginId: string, agentId: string, sessionId: string): void {
		const key = this.key(sessionId);
		const currentOwner = this.store.get(pluginId, key);
		if (currentOwner && currentOwner !== agentId) {
			throw new Error('agents.send: provider session belongs to another agent');
		}
		// Keep the newest sessions resumable with one atomic replacement at the
		// limit. Evicted sessions fail closed in assertOwned.
		if (!currentOwner) {
			this.store.set(pluginId, key, agentId, { evictOldestOnLimit: true });
			return;
		}
		// Ownership was already persisted. A failed recency refresh must not
		// discard the provider's completed answer; the old binding remains valid.
		try {
			this.store.set(pluginId, key, agentId, { touch: true });
		} catch (error) {
			logger.warn('Could not refresh plugin provider session binding', '[Plugins]', {
				pluginId,
				error: String(error),
			});
		}
	}

	purge(pluginId: string): void {
		this.store.purge(pluginId);
	}
}
