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

import type { MaestroClient, MaestroEvent } from '../../shared/maestro-lib/client/types';
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

export interface RuntimeBridge extends RuntimeMessageRouter {
	/**
	 * Push the runtime's agent, group, and tab changes to this server's clients. A second `attach`
	 * (the web interface was stopped and started again) replaces the first. Returns the detach function.
	 */
	attach(target: RuntimeBroadcastTarget): () => void;
	/** Stop listening. */
	dispose(): void;
}

export function createRuntimeBridge(runtime: MaestroClient): RuntimeBridge {
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
