/** Host-owned provider-session ownership for resumable plugin agent runs. */
import { createHash } from 'crypto';
import { PluginKvStore } from './plugin-kv-store';

/**
 * The plugin only receives a provider session ID after a successful run. This
 * separate store is never exposed through maestro.storage, so a plugin cannot
 * claim another agent's provider session by writing its own KV data.
 */
export class PluginAgentSessionBindings {
	private readonly store: PluginKvStore;

	constructor(baseDir: string) {
		this.store = new PluginKvStore({ baseDir, limits: { maxKeys: 10_000 } });
	}

	private key(sessionId: string): string {
		return createHash('sha256').update(sessionId).digest('hex');
	}

	assertOwned(pluginId: string, agentId: string, sessionId: string): void {
		if (this.store.get(pluginId, this.key(sessionId)) !== agentId) {
			throw new Error('agents.send: provider session is not owned by this plugin and agent');
		}
	}

	remember(pluginId: string, agentId: string, sessionId: string): void {
		const key = this.key(sessionId);
		const currentOwner = this.store.get(pluginId, key);
		if (currentOwner && currentOwner !== agentId) {
			throw new Error('agents.send: provider session belongs to another agent');
		}
		if (!currentOwner) this.store.set(pluginId, key, agentId);
	}

	purge(pluginId: string): void {
		this.store.purge(pluginId);
	}
}
