/**
 * Pure frame and reply interpretation for the WebSocket client.
 *
 * Everything here is a function of a value the bridge sent: no socket, no
 * timers, no state. `ws-client.ts` owns the connection and calls these to turn
 * frames into `TurnEvent`s, turn a failed reply into a `ClientError`, and work
 * out which settings changed (sections 8, 9, and 6.1 of
 * `Plans/maestro-tui-client-api.md`).
 */

import type { AgentError, UsageStats } from '../../types';
import { createOutputParser } from '../parsers/parser-factory';
import { resolveTurnOutcome, type TurnOutcome } from '../streaming/turn-outcome';
import type { ClientErrorCode, TurnToolCall } from './types';

// ---------------------------------------------------------------------------
// Process ids (8.1)
// ---------------------------------------------------------------------------

/** What a desktop process id names, for the turn stream. */
export type ProcessTarget =
	/** An agent's AI tab: `<agentId>-ai-<tabId>`. */
	| { kind: 'tab'; agentId: string; tabId: string }
	/** The legacy id of an agent's ACTIVE tab: `<agentId>-ai`. Resolved from the mirror on arrival. */
	| { kind: 'legacy'; agentId: string };

const BATCH_OR_SYNOPSIS = /-(?:batch|synopsis)-\d+$/;
const FORCED_PARALLEL = /-fp-\d+$/;
const TAB_PROCESS = /^(.+)-ai-(.+?)(?:-fp-(\d+))?$/;
const LEGACY_PROCESS = /^(.+)-ai$/;

/**
 * Parse a desktop process id. Returns null for a process this client does not
 * stream: Auto Run and synopsis runs, group chat, consults, terminals, command
 * mode, and a forced-parallel run inside a tab (the TUI never force-sends, and
 * a desktop force-send shows in the transcript once persisted).
 */
export function parseProcessId(processId: string): ProcessTarget | null {
	if (
		BATCH_OR_SYNOPSIS.test(processId) ||
		processId.startsWith('group-chat-') ||
		processId.startsWith('cross-agent-') ||
		processId.includes('-terminal') ||
		processId.includes('-shell-')
	) {
		return null;
	}
	if (FORCED_PARALLEL.test(processId)) return null;

	const tab = TAB_PROCESS.exec(processId);
	if (tab) return { kind: 'tab', agentId: tab[1], tabId: tab[2] };

	const legacy = LEGACY_PROCESS.exec(processId);
	if (legacy) return { kind: 'legacy', agentId: legacy[1] };
	return null;
}

// ---------------------------------------------------------------------------
// Frames to turn events (8.2)
// ---------------------------------------------------------------------------

/** The turn events that map one to one from a `process:*` frame (everything but `outcome`). */
export type StreamedTurnEvent =
	| { kind: 'session'; providerSessionId: string }
	| { kind: 'thinking'; text: string }
	| { kind: 'text'; text: string }
	| { kind: 'tool'; tool: TurnToolCall }
	| { kind: 'usage'; usage: UsageStats }
	| { kind: 'error'; error: AgentError };

export type ProcessFrame =
	| { kind: 'stream'; event: StreamedTurnEvent }
	| { kind: 'exit'; exitCode: number | null; signal: string | number | null };

export interface ParsedProcessFrame {
	target: ProcessTarget;
	frame: ProcessFrame;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `failed` is the error spelling some providers use; a missing status is a call still running. */
function toolStatus(state: Record<string, unknown> | undefined): TurnToolCall['status'] {
	const status = state?.status;
	if (status === 'completed') return 'completed';
	if (status === 'error' || status === 'failed') return 'error';
	return 'running';
}

/**
 * Interpret a `bridge.event` on a `process:*` channel (or `agent:error`) whose
 * first argument is a desktop process id. Null when the channel is not one this
 * client streams, the id is not a tab's, or the arguments are malformed.
 */
export function parseProcessFrame(channel: string, args: unknown[]): ParsedProcessFrame | null {
	const processId = args[0];
	if (typeof processId !== 'string') return null;

	let build: ProcessFrame | null = null;
	switch (channel) {
		case 'process:session-id':
			if (typeof args[1] === 'string') {
				build = { kind: 'stream', event: { kind: 'session', providerSessionId: args[1] } };
			}
			break;
		case 'process:thinking-chunk':
			if (typeof args[1] === 'string') {
				build = { kind: 'stream', event: { kind: 'thinking', text: args[1] } };
			}
			break;
		case 'process:data':
			if (typeof args[1] === 'string') {
				build = { kind: 'stream', event: { kind: 'text', text: args[1] } };
			}
			break;
		case 'process:tool-execution': {
			const payload = args[1];
			if (isObject(payload) && typeof payload.toolName === 'string') {
				const state = isObject(payload.state) ? payload.state : undefined;
				const tool: TurnToolCall = {
					name: payload.toolName,
					status: toolStatus(state),
					...(typeof payload.toolCallId === 'string' ? { id: payload.toolCallId } : {}),
					...(payload.state !== undefined ? { detail: payload.state } : {}),
					...(typeof payload.parentToolUseId === 'string'
						? { parentId: payload.parentToolUseId }
						: {}),
				};
				build = { kind: 'stream', event: { kind: 'tool', tool } };
			}
			break;
		}
		case 'process:usage':
			if (isObject(args[1])) {
				build = {
					kind: 'stream',
					event: { kind: 'usage', usage: args[1] as unknown as UsageStats },
				};
			}
			break;
		case 'agent:error':
			if (isObject(args[1])) {
				build = {
					kind: 'stream',
					event: { kind: 'error', error: args[1] as unknown as AgentError },
				};
			}
			break;
		case 'process:exit': {
			const code = args[1];
			const signal = args[2];
			build = {
				kind: 'exit',
				exitCode: typeof code === 'number' ? code : null,
				signal: typeof signal === 'string' || typeof signal === 'number' ? signal : null,
			};
			break;
		}
		default:
			return null;
	}
	if (!build) return null;

	const target = parseProcessId(processId);
	return target ? { target, frame: build } : null;
}

/** A message the desktop accepted for a tab, from any surface (`process:user-input`). */
export interface UserInputFrame {
	agentId: string;
	/** Absent for an input aimed at the agent's active tab; the caller resolves it. */
	tabId: string | undefined;
	entry: Record<string, unknown> & {
		id: string;
		timestamp: number;
		source: string;
		text: string;
	};
}

/**
 * Interpret the payload of `process:user-input`. Terminal-mode input is not a
 * turn, so it is dropped.
 */
export function parseUserInputFrame(args: unknown[]): UserInputFrame | null {
	const payload = args[0];
	if (!isObject(payload)) return null;
	if (payload.inputMode === 'terminal') return null;
	const entry = payload.entry;
	if (
		typeof payload.sessionId !== 'string' ||
		!isObject(entry) ||
		typeof entry.id !== 'string' ||
		typeof entry.timestamp !== 'number' ||
		typeof entry.text !== 'string'
	) {
		return null;
	}
	return {
		agentId: payload.sessionId,
		tabId: typeof payload.tabId === 'string' ? payload.tabId : undefined,
		entry: {
			...entry,
			source: typeof entry.source === 'string' ? entry.source : 'user',
		} as UserInputFrame['entry'],
	};
}

// ---------------------------------------------------------------------------
// Outcome (8.4)
// ---------------------------------------------------------------------------

export interface BridgeTurnFacts {
	exitCode: number | null;
	signal: string | number | null;
	/** True when this client called `turns.interrupt` for the tab during the turn. */
	interruptRequested: boolean;
	/** The last `agent:error` of the turn. */
	lastError: AgentError | undefined;
	/** The turn's `text`, concatenated. */
	answerText: string;
	/** The provider the agent runs on; picks the parser whose `detectErrorFromExit` applies. */
	providerId: string;
	/** Only the tab-scoped part matters to the resolver's session-shape exclusions. */
	sessionId: string;
}

export interface ResolvedBridgeOutcome {
	outcome: TurnOutcome;
	exitCode: number | null;
	error?: AgentError;
}

/**
 * Resolve a turn's outcome from what the bridge carries, with the library's
 * `resolveTurnOutcome` so the precedence matches every other surface.
 *
 * `interrupted` is partly a guess (gap G5): an exit carrying a signal with no
 * `agent:error` reads as a stop even when this client did not ask for it,
 * because a Stop pressed in the desktop looks the same as an outside kill.
 */
export function resolveBridgeOutcome(facts: BridgeTurnFacts): ResolvedBridgeOutcome {
	const interrupted =
		facts.interruptRequested || (Boolean(facts.signal) && facts.lastError === undefined);
	const parser = createOutputParser(facts.providerId);
	const result = resolveTurnOutcome(
		{
			exitCode: facts.exitCode,
			signal: facts.signal,
			interrupted,
			stderrText: '',
			stdoutText: '',
			explicitError: facts.lastError,
			capturedAnswerText: facts.answerText,
			resultMessageSeen: facts.exitCode === 0,
		},
		parser ?? { detectErrorFromExit: () => null },
		{ providerId: facts.providerId, sessionId: facts.sessionId }
	);
	const error = result.error ?? facts.lastError;
	return {
		outcome: result.outcome,
		exitCode: facts.exitCode,
		...(error ? { error } : {}),
	};
}

// ---------------------------------------------------------------------------
// Settings (5.6)
// ---------------------------------------------------------------------------

/**
 * The fields of the bridge's curated `WebSettings` snapshot, and the settings
 * store key each one is read from. `autoScroll` is a constant in the snapshot,
 * so it never changes.
 */
const WEB_SETTING_STORE_KEYS: Record<string, string> = {
	theme: 'activeThemeId',
	fontSize: 'fontSize',
	enterToSendAI: 'enterToSendAI',
	defaultSaveToHistory: 'defaultSaveToHistory',
	defaultShowThinking: 'defaultShowThinking',
	notificationsEnabled: 'osNotificationsEnabled',
	audioFeedbackEnabled: 'audioFeedbackEnabled',
	colorBlindMode: 'colorBlindMode',
	conductorProfile: 'conductorProfile',
	maxOutputLines: 'maxOutputLines',
	shortcuts: 'shortcuts',
};

/**
 * Store keys whose value differs between two `WebSettings` snapshots. A
 * `settings_changed` frame carries the whole snapshot, not the key that moved,
 * so the client diffs it against the previous one. Null when there is nothing
 * to compare against: the caller reports `'unknown'`.
 */
export function changedWebSettingKeys(
	previous: Record<string, unknown> | undefined,
	next: Record<string, unknown>
): string[] | null {
	if (!previous) return null;
	const keys: string[] = [];
	for (const [field, storeKey] of Object.entries(WEB_SETTING_STORE_KEYS)) {
		if (JSON.stringify(previous[field]) !== JSON.stringify(next[field])) keys.push(storeKey);
	}
	return keys;
}

/** Store keys behind the other settings-bearing frames. */
export const THEME_STORE_KEY = 'activeThemeId';
export const CUSTOM_COMMANDS_STORE_KEY = 'customAICommands';

// ---------------------------------------------------------------------------
// Reply classification (9)
// ---------------------------------------------------------------------------

/** The error text the bridge answers an unregistered or denied channel with. */
export function isUnsupportedInvokeError(text: string): boolean {
	return (
		text.includes('No ipcMain handler registered') ||
		text.includes('is not available over the web interface')
	);
}

/** Text the handlers use for a missing agent, tab, group, or queue item. */
export function looksLikeNotFound(text: string): boolean {
	return /not found|no longer exists|no ai tabs|no such/i.test(text);
}

/** Reasons the renderer's `enqueue_command` reply carries, when it carries one. */
const ENQUEUE_NOT_FOUND_REASONS = new Set(['session-not-found', 'tab-not-found', 'no-ai-tabs']);

/**
 * Classify a failed reply by what it says. `rejected` is for the replies that
 * refuse on state (a live process blocks a working directory move); the caller
 * passes `stateRefusal` for the two messages whose failure is that.
 */
export function classifyFailure(
	text: string | undefined,
	options: { reason?: string; stateRefusal?: boolean } = {}
): ClientErrorCode {
	if (options.reason && ENQUEUE_NOT_FOUND_REASONS.has(options.reason)) return 'not-found';
	if (text && isUnsupportedInvokeError(text)) return 'unsupported';
	if (text && looksLikeNotFound(text)) return 'not-found';
	if (options.stateRefusal) return 'rejected';
	return 'failed';
}
