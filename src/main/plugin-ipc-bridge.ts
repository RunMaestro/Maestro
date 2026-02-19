/**
 * Plugin IPC Bridge
 *
 * Enables split-architecture plugins where a renderer component sends data
 * to its main-process component via IPC. This is what makes patterns like
 * Notifications work: renderer subscribes to Zustand batch state, forwards
 * events via bridge, and the main-process component dispatches webhooks.
 */

import { logger } from './utils/logger';

const LOG_CONTEXT = '[Plugins]';

/**
 * Routes IPC messages between renderer and main-process plugin components.
 * Channels are namespaced as `plugin:<pluginId>:<channel>`.
 */
export class PluginIpcBridge {
	/** Handlers keyed by `plugin:<pluginId>:<channel>` */
	private handlers: Map<string, (...args: unknown[]) => unknown> = new Map();

	/**
	 * Builds the internal channel key.
	 */
	private channelKey(pluginId: string, channel: string): string {
		return `plugin:${pluginId}:${channel}`;
	}

	/**
	 * Registers a handler for a specific plugin channel.
	 * Returns an unsubscribe function.
	 */
	register(pluginId: string, channel: string, handler: (...args: unknown[]) => unknown): () => void {
		const key = this.channelKey(pluginId, channel);
		this.handlers.set(key, handler);
		logger.debug(`IPC bridge handler registered: ${key}`, LOG_CONTEXT);

		return () => {
			this.handlers.delete(key);
		};
	}

	/**
	 * Invokes a registered handler and returns its result.
	 * Throws if no handler is registered for the channel.
	 */
	async invoke(pluginId: string, channel: string, ...args: unknown[]): Promise<unknown> {
		const key = this.channelKey(pluginId, channel);
		const handler = this.handlers.get(key);
		if (!handler) {
			throw new Error(`No handler registered for channel '${key}'`);
		}
		return handler(...args);
	}

	/**
	 * Sends a one-way message to a registered handler (fire-and-forget).
	 * Silently ignores if no handler is registered.
	 */
	send(pluginId: string, channel: string, ...args: unknown[]): void {
		const key = this.channelKey(pluginId, channel);
		const handler = this.handlers.get(key);
		if (handler) {
			try {
				handler(...args);
			} catch (err) {
				logger.error(
					`IPC bridge send error on '${key}': ${err instanceof Error ? err.message : String(err)}`,
					LOG_CONTEXT
				);
			}
		}
	}

	/**
	 * Removes all handlers for a given plugin.
	 */
	unregisterAll(pluginId: string): void {
		const prefix = `plugin:${pluginId}:`;
		const keysToDelete: string[] = [];

		for (const key of this.handlers.keys()) {
			if (key.startsWith(prefix)) {
				keysToDelete.push(key);
			}
		}

		for (const key of keysToDelete) {
			this.handlers.delete(key);
		}

		if (keysToDelete.length > 0) {
			logger.debug(`IPC bridge: removed ${keysToDelete.length} handler(s) for plugin '${pluginId}'`, LOG_CONTEXT);
		}
	}

	/**
	 * Returns whether a handler is registered for a channel.
	 */
	hasHandler(pluginId: string, channel: string): boolean {
		return this.handlers.has(this.channelKey(pluginId, channel));
	}
}
