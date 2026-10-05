/**
 * The desktop bridge's agent, group, and tab messages, answered by the runtime (DM15).
 *
 * With the runtime hosted, `create_session`, `new_tab`, and the rest no longer round-trip through a
 * renderer window. They run against the same `createRequestHandler` the detached host answers with,
 * so the desktop and `maestro-cli host` answer a client alike and no third copy of the CRUD rules
 * exists. The pushes come from `framesForEvent` over the runtime's events.
 *
 * The view verbs (`select_session`, `select_tab`, `switch_mode`), turns, Auto Run, group chats, and
 * consults are not in this set: they keep their desktop paths in Phase 9.
 *
 * Design: `Plans/maestro-tui-desktop-migration.md` section 4.6.
 */

import type { DesktopRuntimeApi } from '../../shared/maestro-lib/agents/desktop-fold-types';
import type {
	GroupPatch,
	MaestroClient,
	MaestroEvent,
} from '../../shared/maestro-lib/client/types';
import type { GroupUpdateRequest } from '../../shared/groupAppearance';
import { DEFAULT_GROUP_EMOJI } from '../../shared/maestro-lib/agents/rules';
import { createFrameState, framesForEvent } from '../../shared/maestro-lib/runtime/server-frames';
import { createRequestHandler } from '../../shared/maestro-lib/runtime/server-requests';

/** The bridge messages the runtime answers while it is hosted. */
export const RUNTIME_BRIDGE_MESSAGE_TYPES: ReadonlySet<string> = new Set([
	'create_session',
	'rename_session',
	'delete_session',
	'update_session_cwd',
	'update_session_ssh',
	'update_session_config',
	'set_auto_run_folder',
	'move_session_to_group',
	'create_group',
	'rename_group',
	'delete_group',
	'new_tab',
	'rename_tab',
	'close_tab',
	'star_tab',
]);

/** The events whose frames replace the renderer-driven `session_*` broadcasts. */
const BROADCAST_EVENT_TYPES = [
	'agent.added',
	'agent.updated',
	'agent.removed',
	'groups.changed',
	'tab.added',
	'tab.updated',
	'tab.removed',
] as const satisfies readonly MaestroEvent['type'][];

type Frame = Record<string, unknown>;

/** What the web server's message handler asks of the bridge. */
export interface RuntimeMessageRouter {
	handles(type: unknown): boolean;
	/** The reply to send, or undefined when the runtime does not know the message. */
	handle(message: Record<string, unknown>): Promise<Frame | undefined>;
}

/** What a web server gives the bridge to push through. */
export interface RuntimeBroadcastTarget {
	broadcastToAll(message: object): void;
}

/**
 * The three desktop messages the library's request handler has no case for, because the operation
 * lives on `runtime.desktop` (a group's appearance, a tab's place in the strip) or reads the stored
 * record (a bookmark toggle). The web server's own handlers still parse and validate the message and
 * shape the reply; what these replace is the round trip through a renderer window. Each answers the
 * `Promise<boolean>` its callback type promises, `false` for a refusal.
 */
export interface RuntimeDesktopCallbacks {
	updateGroup(groupId: string, update: GroupUpdateRequest): Promise<boolean>;
	/** Indices count the agent's `aiTabs`, as the web client sees them. */
	reorderTab(sessionId: string, fromIndex: number, toIndex: number): Promise<boolean>;
	toggleBookmark(sessionId: string): Promise<boolean>;
}

/**
 * A validated `update_group` as a runtime patch. `clear` is the wire's way to say "remove it"; the
 * runtime's is `null`, except the emoji, which cannot be absent on a stored group and so goes back to
 * the default folder (the renderer's rule, kept).
 */
export function groupPatchFromUpdate(update: GroupUpdateRequest): GroupPatch {
	const clear = new Set<string>(update.clear ?? []);
	const patch: GroupPatch = {};
	if (update.name) patch.name = update.name;
	if (update.emoji) patch.emoji = update.emoji;
	else if (clear.has('emoji')) patch.emoji = DEFAULT_GROUP_EMOJI;
	if (update.icon) patch.icon = update.icon;
	else if (clear.has('icon')) patch.icon = null;
	if (update.color) patch.color = update.color;
	else if (clear.has('color')) patch.color = null;
	if (update.parentGroupId) patch.parentGroupId = update.parentGroupId;
	else if (clear.has('parent')) patch.parentGroupId = null;
	return patch;
}

function createDesktopCallbacks(desktop: DesktopRuntimeApi, client: MaestroClient) {
	const callbacks: RuntimeDesktopCallbacks = {
		async updateGroup(groupId, update) {
			return (await desktop.updateGroup(groupId, groupPatchFromUpdate(update))).ok;
		},
		async reorderTab(sessionId, fromIndex, toIndex) {
			const agent = desktop.snapshot().agents.find((candidate) => candidate.id === sessionId);
			const tabs = Array.isArray(agent?.aiTabs) ? agent.aiTabs : [];
			const moved = tabs[fromIndex];
			const anchor = tabs[toIndex];
			if (!agent || !moved || !anchor) return false;
			if (moved.id === anchor.id) return true;
			// The strip is `unifiedTabOrder`, which also holds file, terminal, and browser tabs, so a
			// position among AI tabs is the position of the AI tab that holds it.
			const order = Array.isArray(agent.unifiedTabOrder) ? agent.unifiedTabOrder : [];
			const slot = order.findIndex((ref) => ref.type === 'ai' && ref.id === anchor.id);
			if (slot < 0) return false;
			return (await desktop.reorderTab(sessionId, { type: 'ai', id: moved.id }, slot)).ok;
		},
		async toggleBookmark(sessionId) {
			const agent = await client.agents.get(sessionId);
			if (!agent.ok) return false;
			return (await client.agents.update(sessionId, { bookmarked: !agent.value.bookmarked })).ok;
		},
	};
	return callbacks;
}

export interface RuntimeBridge extends RuntimeMessageRouter {
	/** Present when the runtime runs in mode `desktop`; see {@link RuntimeDesktopCallbacks}. */
	readonly desktopCallbacks?: RuntimeDesktopCallbacks;
	/**
	 * Push the runtime's agent, group, and tab changes to this server's clients. A second `attach`
	 * (the web interface was stopped and started again) replaces the first. Returns the detach function.
	 */
	attach(target: RuntimeBroadcastTarget): () => void;
	/** Stop listening. */
	dispose(): void;
}

export function createRuntimeBridge(
	runtime: MaestroClient & { readonly desktop?: DesktopRuntimeApi }
): RuntimeBridge {
	const handle = createRequestHandler(runtime);
	const frameState = createFrameState();
	let target: RuntimeBroadcastTarget | undefined;

	const unsubscribe = runtime.events.subscribe(
		(event) => {
			if (!target) return;
			for (const frame of framesForEvent(event, frameState)) target.broadcastToAll(frame);
		},
		{ types: BROADCAST_EVENT_TYPES }
	);

	return {
		...(runtime.desktop
			? { desktopCallbacks: createDesktopCallbacks(runtime.desktop, runtime) }
			: {}),
		handles: (type) => typeof type === 'string' && RUNTIME_BRIDGE_MESSAGE_TYPES.has(type),
		handle: (message) => handle(message),
		attach(next) {
			target = next;
			return () => {
				if (target === next) target = undefined;
			};
		},
		dispose() {
			unsubscribe();
			target = undefined;
		},
	};
}
