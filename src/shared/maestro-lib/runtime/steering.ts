/**
 * Steer Running Turn on a headless host (`maestro-cli host`): hand a waiting message to the turn
 * already running on its tab, as a desktop's Steer does (`steerQueuedItem()` in
 * src/renderer/services/chatSteering.ts). The host spawns its turns on its own machine, so a
 * Claude TUI turn opens maestro-p's steering socket here (`steeringSocketPathFor()`) and the
 * steer types into it over that socket, exactly as a local desktop turn's does.
 *
 * A steer is answered twice (see `SteeringVerdict` in src/shared/chatSteering.ts): the socket says
 * whether the text was typed, and the turn's stdout later says what the agent did with it. The
 * message leaves the queue before it is typed, so a turn that ends during the wait cannot run it
 * again, and comes back when the agent never took it:
 *
 * | Answer | The message | The transcript |
 * | --- | --- | --- |
 * | `delivered`, `absorbed`, `queued` | gone from the queue | a steered user entry |
 * | `refused` | back at the head of the queue, live | nothing |
 * | `unknown` | back at the head, paused (never typed twice) | nothing |
 * | later `dropped` | back at the head, live | a line saying it will send next |
 * | turn ends with no verdict | back at the head, paused | a line saying so |
 *
 * The host transcript is append-only (`AgentRepository.appendTranscript`), so the steered entry is
 * written once the agent has the text, and an outcome that takes it back adds a line rather than
 * removing the entry.
 */

import {
	startsWithTuiCommandPrefix,
	STEERING_REPLY_TIMEOUT_MS,
	type QueueSteerResult,
	type SteeringResultFrame,
} from '../../chatSteering';
import { steerOverSocket } from '../../chatSteeringSocket';
import { getAgentDisplayName } from '../../agentMetadata';
import { logger } from '../host';
import type { LogEntryRecord } from '../store/transcript';
import type { ExecutionQueue, QueueItem } from '../turns/queue';

const LOG_CONTEXT = '[RuntimeSteering]';

/** What a steer reads of a waiting message. */
export interface SteerableItem extends QueueItem {
	text: string;
	images?: string[];
}

/** The turn running on a tab, as the steer judges it. */
export interface SteeredTurn {
	/** The provider the turn runs on. */
	provider: string;
	/** The turn runs read-only: only then may a read-only message be typed into it. */
	readOnly: boolean;
	/** The socket the turn listens on (`AgentTurnRun.steeringSocket`). None: not steerable. */
	socketPath?: string;
}

/** What the runtime tells the steer about one turn it started. */
export interface SteeredTurnHandle {
	/** A verdict the turn printed (`RunAgentTurnOptions.onSteeringVerdict`). */
	verdict(frame: SteeringResultFrame): void;
	/** The turn's process is gone. Steers it never settled come back paused. */
	ended(): void;
}

export interface RuntimeSteeringOptions<T extends SteerableItem> {
	queueOf(agentId: string): ExecutionQueue<T> | undefined;
	/** The provider of the agent, for the words of a returned steer. */
	toolTypeOf(agentId: string): string | undefined;
	/** Add an entry to the end of a tab's transcript, and tell clients it changed. */
	appendEntry(agentId: string, tabId: string, entry: LogEntryRecord): Promise<void>;
	newId(): string;
	now(): number;
	/** Seam for tests: type a steer into a socket. Default: `steerOverSocket()`. */
	send?(socketPath: string, text: string, id: string): Promise<SteeringResultFrame>;
}

export interface RuntimeSteering {
	/** A turn started on a tab. Call `ended()` once its process is gone. */
	turnStarted(agentId: string, tabId: string, turn: SteeredTurn): SteeredTurnHandle;
	/** The queued card's Steer, and `maestro-cli queue steer`. Never rejects. */
	steer(agentId: string, itemId: string): Promise<QueueSteerResult>;
}

/** Why a message cannot be steered: the desktop's reasons (`SteerBlockedReason`), so it says the same. */
export type RuntimeSteerBlockedReason =
	| 'steer-in-flight'
	| 'tab-not-working'
	| 'grok-no-input-op'
	| 'codex-exec'
	| 'not-claude'
	| 'api-token-source'
	| 'nothing-to-type'
	| 'paused'
	| 'tui-command-prefix'
	| 'read-only'
	| 'has-images';

const STAYS_QUEUED = 'the message stays queued and sends when the current turn ends';

/** Why `item` cannot be typed into `turn`, or null when it can. The desktop's order of checks. */
export function runtimeSteerBlockedReason(
	item: SteerableItem,
	turn: SteeredTurn | undefined
): RuntimeSteerBlockedReason | null {
	if (!turn) return 'tab-not-working';
	if (!turn.socketPath) {
		// The turn took no input channel: what the desktop names for that provider's transport.
		if (turn.provider === 'grok') return 'grok-no-input-op';
		if (turn.provider === 'codex') return 'codex-exec';
		if (turn.provider !== 'claude-code') return 'not-claude';
		return 'api-token-source';
	}
	// Steering TYPES the text, so a message with nothing to type has nothing to steer with.
	if (!item.text.trim()) return 'nothing-to-type';
	// Held on purpose, by the person or by an unconfirmed steer (typing it again doubles it).
	if (item.paused) return 'paused';
	// A leading `/` or `!` is a command to Claude's TUI, not the message the person queued.
	if (startsWithTuiCommandPrefix(item.text)) return 'tui-command-prefix';
	// The text runs with the running turn's access: a read-only message never gains access.
	if (item.readOnly && !turn.readOnly) return 'read-only';
	// A running turn cannot take an attachment: typing the text alone would lose the images.
	if (item.images?.length) return 'has-images';
	return null;
}

/** What one steer heard from its turn while it was still being answered. */
interface Heard {
	verdicts: SteeringResultFrame[];
	exited: boolean;
}

interface PendingSteer<T> {
	agentId: string;
	tabId: string;
	item: T;
}

export function createRuntimeSteering<T extends SteerableItem>(
	options: RuntimeSteeringOptions<T>
): RuntimeSteering {
	const send =
		options.send ??
		((socketPath: string, text: string, id: string) =>
			steerOverSocket({
				socketPath,
				text,
				id,
				timeoutMs: STEERING_REPLY_TIMEOUT_MS,
				warn: (message, stage) =>
					logger.warn(
						stage === 'connect'
							? 'Steering channel unreachable'
							: 'Steering channel failed mid-request',
						LOG_CONTEXT,
						{ error: message }
					),
			}));
	const key = (agentId: string, tabId: string) => `${agentId}\u0000${tabId}`;
	/** The turn running on each tab, by `key`. */
	const turns = new Map<string, { turn: SteeredTurn; token: object }>();
	/** Delivered steers awaiting the turn's verdict, by the turn's token, then the steer id. */
	const pending = new Map<object, Map<string, PendingSteer<T>>>();
	/** Verdicts and an exit that arrived while a steer still waited on its socket. */
	const early = new Map<object, Set<Heard>>();
	/** Messages with a steer waiting on its socket, by `agentId` then item id. */
	const inFlight = new Set<string>();

	const agentName = (agentId: string) => getAgentDisplayName(options.toolTypeOf(agentId) ?? '');

	function systemLine(agentId: string, tabId: string, text: string): void {
		void options.appendEntry(agentId, tabId, {
			id: options.newId(),
			timestamp: options.now(),
			source: 'system',
			text,
		});
	}

	function returnToQueue(steered: PendingSteer<T>, paused: boolean): void {
		const queue = options.queueOf(steered.agentId);
		if (!queue) return;
		queue.returnToFront(paused ? { ...steered.item, paused: true } : steered.item);
	}

	/** The turn ended before the agent took the text: it sends next, as the desktop's toast says. */
	function dropped(steered: PendingSteer<T>): void {
		returnToQueue(steered, false);
		systemLine(
			steered.agentId,
			steered.tabId,
			`Steer returned to the queue: the turn ended before ${agentName(steered.agentId)} took your message, so it will send next.`
		);
	}

	/** Gone without a verdict: nobody knows whether the agent saw it, so it waits for the person. */
	function unconfirmed(steered: PendingSteer<T>): void {
		returnToQueue(steered, true);
		systemLine(
			steered.agentId,
			steered.tabId,
			`Steering result unconfirmed: ${agentName(steered.agentId)} may or may not have received the message, so it has been paused rather than sent twice. Resume it if the agent never answered it.`
		);
	}

	function turnStarted(agentId: string, tabId: string, turn: SteeredTurn): SteeredTurnHandle {
		const token = {};
		turns.set(key(agentId, tabId), { turn, token });
		return {
			verdict(frame) {
				const steered = pending.get(token)?.get(frame.id);
				if (!steered) {
					// Possibly the steer being typed right now, ahead of its own socket reply.
					for (const heard of early.get(token) ?? []) heard.verdicts.push(frame);
					return;
				}
				if (frame.verdict === 'absorbed' || frame.verdict === 'queued') {
					pending.get(token)?.delete(frame.id);
				} else if (frame.verdict === 'dropped') {
					pending.get(token)?.delete(frame.id);
					dropped(steered);
				}
				// `delivered` repeated on stdout says nothing new.
			},
			ended() {
				if (turns.get(key(agentId, tabId))?.token === token) turns.delete(key(agentId, tabId));
				for (const heard of early.get(token) ?? []) heard.exited = true;
				// maestro-p reports every unsettled steer as `dropped` before it exits, so one left
				// here means that report never came (a crash, a kill).
				for (const steered of pending.get(token)?.values() ?? []) unconfirmed(steered);
				pending.delete(token);
			},
		};
	}

	async function steer(agentId: string, itemId: string): Promise<QueueSteerResult> {
		const flightKey = key(agentId, itemId);
		// Checked first: while a steer waits, its message is off the queue.
		if (inFlight.has(flightKey)) {
			return {
				outcome: 'not-steerable',
				blockedReason: 'steer-in-flight',
				detail: 'a steer for this message is already waiting for an answer',
			};
		}
		const queue = options.queueOf(agentId);
		const item = queue?.items().find((entry) => entry.id === itemId);
		if (!queue || !item) {
			return { outcome: 'not-found', detail: `no queued item ${itemId} for agent ${agentId}` };
		}
		const running = turns.get(key(agentId, item.tabId));
		const blocked = runtimeSteerBlockedReason(item, running?.turn);
		if (blocked || !running?.turn.socketPath) {
			return {
				outcome: 'not-steerable',
				blockedReason: blocked ?? 'tab-not-working',
				detail: STAYS_QUEUED,
			};
		}
		const { token } = running;
		const socketPath = running.turn.socketPath;

		// Off the queue BEFORE it is typed: a turn that ends during the wait must not run it again.
		if (!queue.remove(itemId)) {
			return { outcome: 'not-found', detail: `no queued item ${itemId} for agent ${agentId}` };
		}
		const steered: PendingSteer<T> = { agentId, tabId: item.tabId, item };
		const heard: Heard = { verdicts: [], exited: false };
		const listening = early.get(token) ?? new Set<Heard>();
		listening.add(heard);
		early.set(token, listening);
		inFlight.add(flightKey);
		let frame: SteeringResultFrame;
		try {
			frame = await send(socketPath, item.text.trim(), options.newId());
		} catch (error) {
			// The socket client never rejects; anything here may have followed a write.
			frame = {
				type: 'steering',
				id: '',
				verdict: 'unknown',
				detail: error instanceof Error ? error.message : String(error),
			};
		} finally {
			inFlight.delete(flightKey);
		}
		// What the turn says while this steer is still being answered is held for it, until it is
		// registered below or settled.
		try {
			return await settleSteer(frame, steered, token, heard);
		} finally {
			listening.delete(heard);
			if (listening.size === 0 && early.get(token) === listening) early.delete(token);
		}
	}

	async function settleSteer(
		frame: SteeringResultFrame,
		steered: PendingSteer<T>,
		token: object,
		heard: Heard
	): Promise<QueueSteerResult> {
		const { agentId, item } = steered;

		if (frame.verdict === 'refused') {
			// Nothing was typed: the message is still the person's, live, at the head.
			returnToQueue(steered, false);
			return {
				outcome: 'refused',
				verdict: frame.verdict,
				...(frame.refusal ? { refusal: frame.refusal } : {}),
				...(frame.detail ? { detail: frame.detail } : {}),
			};
		}
		if (
			frame.verdict !== 'delivered' &&
			frame.verdict !== 'absorbed' &&
			frame.verdict !== 'queued'
		) {
			// `unknown` (or a `dropped` on the socket): it may have been typed. Paused, never doubled.
			returnToQueue(steered, true);
			return {
				outcome: 'unconfirmed',
				verdict: frame.verdict,
				...(frame.detail ? { detail: frame.detail } : {}),
			};
		}

		// The agent has the text: the steered entry joins the transcript, as the desktop's bubble,
		// before the answer goes back, so a client that reads the tab next finds it.
		await options.appendEntry(agentId, item.tabId, {
			id: options.newId(),
			timestamp: options.now(),
			source: 'user',
			text: item.text,
			steered: true,
			queuedItemId: item.id,
			...(item.readOnly ? { readOnly: true } : {}),
		});
		if (frame.verdict !== 'delivered') return { outcome: 'settled', verdict: frame.verdict };

		// What the turn said while the socket was still answering settles it now.
		const later = heard.verdicts.find((v) => v.id === frame.id && v.verdict !== 'delivered');
		if (later?.verdict === 'dropped') {
			dropped(steered);
			return { outcome: 'delivered', verdict: frame.verdict };
		}
		if (later?.verdict === 'absorbed' || later?.verdict === 'queued') {
			return { outcome: 'settled', verdict: later.verdict };
		}
		if (heard.exited) {
			unconfirmed(steered);
			return { outcome: 'delivered', verdict: frame.verdict };
		}
		let steers = pending.get(token);
		if (!steers) {
			steers = new Map();
			pending.set(token, steers);
		}
		steers.set(frame.id, steered);
		return { outcome: 'delivered', verdict: frame.verdict };
	}

	return { turnStarted, steer };
}
