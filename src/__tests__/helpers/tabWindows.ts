/**
 * Shared Tab Windows test helpers: put tabs into `tabWindowStore` as popped
 * out, install a fake `window.maestro.tabWindows` (the global setup mock has
 * none, which is also what the web-desktop build looks like, TW-13), play an
 * owner's patch stream into a tab window, and stand in for the owner's
 * hook-bound intent handlers.
 */

import { vi } from 'vitest';
import { useTabWindowStore } from '../../renderer/stores/tabWindowStore';
import type { TabWindowOwnerHandlers } from '../../renderer/services/tabWindowIntents';
import type { Session } from '../../renderer/types';
import { buildTabWindowSnapshot, diffTabWindowSession } from '../../shared/tabWindowPatch';
import type {
	TabWindowCommandRequest,
	TabWindowCommandResult,
} from '../../shared/tabWindowCommands';
import type {
	TabWindowDockResult,
	TabWindowInfo,
	TabWindowFocusResult,
	TabWindowIntent,
	TabWindowPopOutResult,
	TabWindowSessionPatch,
	TabWindowTabRef,
} from '../../shared/tabWindowTypes';

/** Mark `tabRefs` of `agentId` as popped out into one tab window. */
export function popOutTabsInStore(agentId: string, tabRefs: TabWindowTabRef[]): void {
	useTabWindowStore
		.getState()
		.setWindows([
			{ windowId: `tw-${agentId}`, agentId, tabRefs, activeTabRef: tabRefs[0] ?? null },
		]);
}

/** Dock every tab: the store reports no tab window. */
export function clearTabWindowStore(): void {
	useTabWindowStore.getState().setWindows([]);
}

/**
 * Install a fake `window.maestro.tabWindows` whose `focus` answers `result`,
 * whose `dock` answers `dockResult`, whose `popOut` answers `popOutResult`, and whose `getState` (a tab window's own
 * record) answers null until a test says otherwise. `list` answers no tab
 * windows until a test says otherwise. `emitRemoteCommand` plays a
 * `maestro-cli tab pop-out` / `tab dock` the way main sends it, and resolves
 * with what the renderer answered on `sendRemoteCommandResponse`. The relay half records
 * what is sent (`sendSessionPatch`, `sendIntent`). As main's relay would,
 * `emitIntent` delivers an intent to every `onIntent` subscriber, and
 * `emitPatch` delivers a patch to every `onSessionPatch` subscriber, cloned
 * the way IPC clones it. Returns the mocks and a restore function.
 */
export function installTabWindowsApi(
	result: TabWindowFocusResult = { focused: true, windowId: 'tw-1' },
	dockResult: TabWindowDockResult = { docked: true, windowId: 'tw-1' },
	popOutResult: TabWindowPopOutResult = { poppedOut: true, windowId: 'tw-1', created: true }
): {
	focus: ReturnType<typeof vi.fn>;
	dock: ReturnType<typeof vi.fn>;
	popOut: ReturnType<typeof vi.fn>;
	getState: ReturnType<typeof vi.fn>;
	list: ReturnType<typeof vi.fn>;
	sendSessionPatch: ReturnType<typeof vi.fn>;
	sendIntent: ReturnType<typeof vi.fn>;
	onIntent: ReturnType<typeof vi.fn>;
	onSessionPatch: ReturnType<typeof vi.fn>;
	onRemoteCommand: ReturnType<typeof vi.fn>;
	sendRemoteCommandResponse: ReturnType<typeof vi.fn>;
	emitIntent: (intent: TabWindowIntent) => void;
	emitPatch: (patch: TabWindowSessionPatch) => void;
	emitRemoteCommand: (request: TabWindowCommandRequest) => Promise<TabWindowCommandResult>;
	restore: () => void;
} {
	const maestro = (window as unknown as { maestro: Record<string, unknown> }).maestro;
	const previous = maestro.tabWindows;
	const focus = vi.fn().mockResolvedValue(result);
	const dock = vi.fn().mockResolvedValue(dockResult);
	const popOut = vi.fn().mockResolvedValue(popOutResult);
	const getState = vi.fn().mockResolvedValue(null);
	const list = vi.fn().mockResolvedValue([] as TabWindowInfo[]);
	const sendSessionPatch = vi.fn();
	const sendIntent = vi.fn();
	const intentListeners = new Set<(intent: TabWindowIntent) => void>();
	const onIntent = vi.fn((callback: (intent: TabWindowIntent) => void) => {
		intentListeners.add(callback);
		return () => intentListeners.delete(callback);
	});
	const patchListeners = new Set<(patch: TabWindowSessionPatch) => void>();
	const onSessionPatch = vi.fn((callback: (patch: TabWindowSessionPatch) => void) => {
		patchListeners.add(callback);
		return () => patchListeners.delete(callback);
	});
	const commandListeners = new Set<
		(request: TabWindowCommandRequest, responseChannel: string) => void
	>();
	const onRemoteCommand = vi.fn(
		(callback: (request: TabWindowCommandRequest, responseChannel: string) => void) => {
			commandListeners.add(callback);
			return () => commandListeners.delete(callback);
		}
	);
	const replies = new Map<string, (result: TabWindowCommandResult) => void>();
	const sendRemoteCommandResponse = vi.fn(
		(responseChannel: string, result: TabWindowCommandResult) => {
			replies.get(responseChannel)?.(result);
			replies.delete(responseChannel);
		}
	);
	let commandSeq = 0;
	maestro.tabWindows = {
		focus,
		dock,
		popOut,
		getState,
		list,
		sendSessionPatch,
		sendIntent,
		onIntent,
		onSessionPatch,
		onRemoteCommand,
		sendRemoteCommandResponse,
	};
	return {
		focus,
		dock,
		popOut,
		getState,
		list,
		sendSessionPatch,
		sendIntent,
		onIntent,
		onSessionPatch,
		onRemoteCommand,
		sendRemoteCommandResponse,
		emitRemoteCommand: (request) =>
			new Promise((resolve) => {
				commandSeq += 1;
				const responseChannel = `remote:tabWindowCommand:response:${commandSeq}`;
				replies.set(responseChannel, resolve);
				for (const listener of [...commandListeners]) listener(request, responseChannel);
			}),
		emitIntent: (intent) => {
			for (const listener of [...intentListeners]) listener(intent);
		},
		emitPatch: (patch) => {
			// Electron IPC is a structured clone: the receiver never shares an
			// object with the sender, and keys set to `undefined` survive.
			for (const listener of [...patchListeners]) listener(structuredClone(patch));
		},
		restore: () => {
			if (previous === undefined) delete maestro.tabWindows;
			else maestro.tabWindows = previous;
		},
	};
}

/** A fake of the terminal handoff half of `window.maestro.tabWindows`. */
export interface TerminalHandoffApiDouble {
	beginTerminalRelease: ReturnType<typeof vi.fn>;
	commitTerminalRelease: ReturnType<typeof vi.fn>;
	claimTerminalReplay: ReturnType<typeof vi.fn>;
	/** Main's answer to a release, on the window's own channel. */
	emitReleaseBegun: (processId: string) => void;
	/** Main's answer to a claim: the replay, or null for nothing to replay. */
	emitReplay: (processId: string, text: string | null) => void;
	restore: () => void;
}

/**
 * Add the terminal handoff methods (D5, `services/terminalHandoff.ts`) to
 * `window.maestro.tabWindows`, creating it when the test installed none.
 * Main's answers are played with `emitReleaseBegun` / `emitReplay`.
 */
export function installTerminalHandoffApi(): TerminalHandoffApiDouble {
	const maestro = (window as unknown as { maestro: Record<string, unknown> }).maestro;
	const previous = maestro.tabWindows as Record<string, unknown> | undefined;
	const begunListeners = new Set<(processId: string) => void>();
	const replayListeners = new Set<(processId: string, text: string | null) => void>();
	const beginTerminalRelease = vi.fn();
	const commitTerminalRelease = vi.fn();
	const claimTerminalReplay = vi.fn();
	maestro.tabWindows = {
		...(previous ?? {}),
		beginTerminalRelease,
		commitTerminalRelease,
		claimTerminalReplay,
		onTerminalReleaseBegun: vi.fn((callback: (processId: string) => void) => {
			begunListeners.add(callback);
			return () => begunListeners.delete(callback);
		}),
		onTerminalReplay: vi.fn((callback: (processId: string, text: string | null) => void) => {
			replayListeners.add(callback);
			return () => replayListeners.delete(callback);
		}),
	};
	return {
		beginTerminalRelease,
		commitTerminalRelease,
		claimTerminalReplay,
		emitReleaseBegun: (processId) => {
			for (const listener of [...begunListeners]) listener(processId);
		},
		emitReplay: (processId, text) => {
			for (const listener of [...replayListeners]) listener(processId, text);
		},
		restore: () => {
			if (previous === undefined) delete maestro.tabWindows;
			else maestro.tabWindows = previous;
		},
	};
}

/**
 * The owner window's hook-bound intent handlers (`TabWindowOwnerHandlers`), as
 * mocks: each answers the way its real function does when it succeeds.
 */
export function createTabWindowOwnerHandlers(): TabWindowOwnerHandlers {
	return {
		processInput: vi.fn(() => Promise.resolve()),
		interruptAgent: vi.fn(() => Promise.resolve()),
		performTabClose: vi.fn(),
		closeTabRefs: vi.fn(),
		forceSendQueuedItem: vi.fn(),
		steerQueuedItem: vi.fn(() => Promise.resolve()),
		deleteLog: vi.fn(() => null),
		forkConversation: vi.fn(),
		recoverSession: vi.fn(() => Promise.resolve()),
		summarizeAndContinue: vi.fn(),
		cancelSummarize: vi.fn(),
		cancelMerge: vi.fn(),
		stopBatchRun: vi.fn(),
		cancelWizardTurn: vi.fn(() => Promise.resolve(true)),
		clearAgentError: vi.fn(),
		openFileLink: vi.fn(() => Promise.resolve()),
		showAgent: vi.fn(),
		raiseWindow: vi.fn(),
	};
}

/** An owner's patch stream to one tab window. See {@link createOwnerPatchStream}. */
export interface OwnerPatchStream {
	/** Send `session` whole, for `tabRefs` (the stream's refs when omitted). */
	snapshot: (session: Session, tabRefs?: TabWindowTabRef[]) => void;
	/** Send what changed since the last patch; false when nothing did. */
	delta: (next: Session) => boolean;
	/** Number a patch and never deliver it, as a gap in the stream would. */
	lose: () => void;
}

/**
 * The owner window's half of the patch stream in miniature: the real snapshot
 * and diff functions (`src/shared/tabWindowPatch.ts`), numbered the way the
 * publisher numbers them and diffed from the state the last patch was built
 * from, delivered through `emit` (for example `installTabWindowsApi().emitPatch`).
 * No timing: each call is one patch.
 */
export function createOwnerPatchStream(
	emit: (patch: TabWindowSessionPatch) => void,
	agentId: string,
	tabRefs: TabWindowTabRef[]
): OwnerPatchStream {
	let refs = tabRefs;
	let prev: Session | null = null;
	let seq = -1;
	return {
		snapshot: (session, nextRefs = refs) => {
			refs = nextRefs;
			prev = session;
			seq += 1;
			emit({
				form: 'snapshot',
				agentId,
				seq,
				tabRefs: refs,
				session: buildTabWindowSnapshot(session, refs),
			});
		},
		delta: (next) => {
			if (!prev) throw new Error('createOwnerPatchStream: send a snapshot first');
			const changes = diffTabWindowSession(prev, next, refs);
			prev = next;
			if (!changes) return false;
			seq += 1;
			emit({ form: 'delta', agentId, seq, ...changes });
			return true;
		},
		lose: () => {
			seq += 1;
		},
	};
}
