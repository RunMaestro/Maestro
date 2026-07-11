/**
 * Main-process ownership and lifecycle for plugin-contributed host views.
 *
 * This registry deliberately stores only host-owned metadata. Plugin code never
 * receives a renderer handle: the broker resolves a declared view, then this
 * registry forwards BlockView data through Concerto's existing payload channel.
 */

import type { HostViewBlocks, HostViewContribution } from '../../shared/plugins/contributions';

export type HostViewMutation =
	| {
			kind: 'upsert';
			view: HostViewContribution;
			blocks: HostViewBlocks;
	  }
	| {
			kind: 'remove';
			view: HostViewContribution;
			/** Lifecycle teardown may remove an already-rendered view after a flag
			 * changed; it must not create/buffer new view state. */
			force?: boolean;
	  };

export interface PluginHostViewRegistryDeps {
	/** Both Encore flags must be live at every runtime call. */
	isEnabled: () => boolean;
	/** Active declarations, normally PluginManager.getContributions().hostViews. */
	getHostViews: () => readonly HostViewContribution[];
	/** Whether the plugin's registry record is PRESENT (any loadStatus). Presence —
	 * including permanent failure states like `invalid`/`incompatible` — means the
	 * declaration set is authoritative and undeclared runtime views are purged.
	 * Absence means a transient reload window: retain runtime views until the
	 * record reappears (plugin code cannot re-send them unprompted). */
	isPluginRecordPresent: (pluginId: string) => boolean;
	/** Host-owned bridge to Concerto's existing Movement/Cadenza payload channels. */
	forward: (mutation: HostViewMutation) => boolean;
}

type HostViewSource = 'static' | 'runtime';

interface LiveHostView {
	view: HostViewContribution;
	blocks: HostViewBlocks;
	source: HostViewSource;
}

/**
 * Tracks only views that the main process has successfully forwarded. This makes
 * disabling, uninstalling, sandbox stops, and feature-flag changes remove every
 * plugin-owned live view without retaining a renderer-side plugin channel.
 */
export class PluginHostViewRegistry {
	private readonly live = new Map<string, LiveHostView>();

	constructor(private readonly deps: PluginHostViewRegistryDeps) {}

	/** Resolve a caller-owned local id against the currently active declarations. */
	getDeclared(pluginId: string, localId: string): HostViewContribution | null {
		if (typeof localId !== 'string' || localId.trim() === '') return null;
		return (
			this.deps
				.getHostViews()
				.find((view) => view.pluginId === pluginId && view.localId === localId) ?? null
		);
	}

	/** Render newly active static declarations. Existing runtime data is never
	 * overwritten by a later registry refresh. */
	sync(): void {
		if (!this.deps.isEnabled()) {
			this.purgeAll();
			return;
		}

		const declarations = this.deps.getHostViews();
		const declaredById = new Map(declarations.map((view) => [view.id, view]));
		for (const [id, live] of this.live) {
			const declaration = declaredById.get(id);
			if (
				(!declaration && this.deps.isPluginRecordPresent(live.view.pluginId)) ||
				(live.source === 'static' && declaration?.blocks === undefined)
			) {
				this.removeLive(id, false);
			}
		}

		for (const view of declarations) {
			if (view.blocks === undefined) continue;
			const live = this.live.get(view.id);
			if (!live) {
				if (this.deps.forward({ kind: 'upsert', view, blocks: view.blocks })) {
					this.live.set(view.id, { view, blocks: view.blocks, source: 'static' });
				}
				continue;
			}
			if (live.source !== 'static') continue;

			const changed =
				live.view.surface !== view.surface ||
				live.view.title !== view.title ||
				JSON.stringify(live.blocks) !== JSON.stringify(view.blocks);
			if (!changed) {
				this.live.set(view.id, { ...live, view });
				continue;
			}
			if (live.view.surface !== view.surface) this.removeLive(view.id, false);
			if (this.deps.forward({ kind: 'upsert', view, blocks: view.blocks })) {
				this.live.set(view.id, { view, blocks: view.blocks, source: 'static' });
			}
		}
	}

	/** Re-forward active data after the main renderer finishes (re)loading. It
	 * preserves tier-1 runtime updates while also attempting previously missed
	 * static views that were discovered before a window existed. */
	replay(): void {
		if (!this.deps.isEnabled()) {
			this.purgeAll();
			return;
		}
		const priorLive = [...this.live.values()];
		this.sync();
		for (const previous of priorLive) {
			const live = this.live.get(previous.view.id);
			if (live) this.deps.forward({ kind: 'upsert', view: live.view, blocks: live.blocks });
		}
	}

	/** Apply a broker-authorized code-tier update to the caller's declared view. */
	update(pluginId: string, localId: string, blocks: HostViewBlocks): boolean {
		if (!this.deps.isEnabled()) return false;
		const view = this.getDeclared(pluginId, localId);
		if (!view) return false;
		if (!this.deps.forward({ kind: 'upsert', view, blocks })) return false;
		this.live.set(view.id, { view, blocks, source: 'runtime' });
		return true;
	}
	/** Remove a caller's declared live view. Removing an unseen declaration is an
	 * idempotent success and never emits a new payload. */
	remove(pluginId: string, localId: string): boolean {
		if (!this.deps.isEnabled()) return false;
		const view = this.getDeclared(pluginId, localId);
		if (!view) return false;
		const live = this.live.get(view.id);
		if (!live) return true;
		if (!this.deps.forward({ kind: 'remove', view: live.view })) return false;
		this.live.delete(view.id);
		return true;
	}

	/** Remove every live view for one plugin. Called for disable, uninstall, and
	 * intentional sandbox stop; deletion is local even when the renderer is gone. */
	purge(pluginId: string): void {
		for (const [id, live] of this.live) {
			if (live.view.pluginId === pluginId) this.removeLive(id, true);
		}
	}

	/** Remove all live plugin views when either Encore feature is switched off. */
	purgeAll(): void {
		for (const id of this.live.keys()) this.removeLive(id, true);
	}

	private removeLive(id: string, force: boolean): void {
		const live = this.live.get(id);
		if (!live) return;
		this.deps.forward({ kind: 'remove', view: live.view, ...(force ? { force: true } : {}) });
		this.live.delete(id);
	}
}
