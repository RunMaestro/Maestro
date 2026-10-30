/**
 * Sketch Book live sessions (spec sections 2 and 7): one `SketchSession` per
 * open sketch, keyed by sketch id.
 *
 * The session is the runtime owner of a drawing, not the React tab. Closing,
 * tiling, snoozing or moving the tab only unmounts a view; the scene, the
 * author map and any unsaved change stay here, so the next view picks up
 * exactly where the last one left off. (The room socket and the bot join the
 * session in later phases for the same reason.)
 *
 * - `scene` is the last synced scene: what the store last read or stamped.
 *   `stampLocalEdits()` diffs each Excalidraw change against it by `version`.
 * - `authors` is the author map (`elementId -> ElementAuthorship`). It is kept
 *   from the edits this desktop makes and, later, from incoming ops; never
 *   from `customData`. An element with no entry has an unknown author, which
 *   the gate treats as third-party (spec section 7): a scene loaded from disk
 *   starts with an empty map on purpose.
 * - `dirty` is true while a change has not reached disk. Saves go through
 *   `window.maestro.sketch.writeScene`, one at a time per sketch.
 * - `externalRevision` is bumped by a change no view made (an agent write,
 *   `applyAgentChange()`), so a mounted view knows to pull the scene into
 *   Excalidraw. A view's own `onChange` never bumps it, so nothing echoes.
 * - `focusRequest` is an agent's `sketch_focus`, waiting for a view to scroll
 *   to it; `chat` is the chat pane: the agent's local posts (T12) and the
 *   room's chat as the bot relay mirrors it (`sketchBotRelay.ts`). The
 *   conductor's own `@bot` messages carry their request (`request`), so the
 *   pane can offer "Run with full access" on one that ran restricted (Q2).
 * - `botRequests` are the `@bot` requests the bot relay holds (spec section
 *   5): a guest request the gate passed, waiting on the approval chip (B2),
 *   and every turn running for the sketch. Never a request still being
 *   screened, so text the gate has not passed is never offered to Run.
 * - `approvedImages` are the guest images the conductor let the agent see
 *   (spec section 8.2, I3), each bound to the `fileId` approved. Every other
 *   guest image is withheld from the agent's reads and renders. Kept for the
 *   session only, never saved.
 * - `room` is the shared sketch's live room as `sketchRoomClient.ts` sees it
 *   (wire contract sections 4 and 5): the connection, the `welcome` state, the
 *   screening value the server confirmed and its `since` (spec section 8.10),
 *   and a notice for the Sketch tab. Null for a sketch with no room client.
 *   Remote elements arrive through `applyRemoteElements()`, which saves and
 *   bumps `externalRevision` like an agent write, but stamps nothing: the
 *   author of a remote version is the op's envelope actor, recorded by the
 *   room client, never `customData`.
 *
 * Beside the sessions, `agentActivity` keeps each sketch's latest agent tool
 * call (main's `sketch:agentActivity` push), stamped with this window's clock
 * on arrival. It is kept apart from the session because a call can arrive
 * before any session is open. `useSketchAgentWork()` reads it with the bot
 * requests to show that the agent is working on the sketch.
 */

import { create } from 'zustand';
import {
	botActor,
	botEditor,
	conductorEditor,
	localConductorActor,
	nextElementAuthorship,
	sketchTextHash,
	stampLocalEdits,
	type AuthorshipUpdate,
	type ElementAuthorship,
	type SketchEditor,
} from '../../shared/sketch/attribution';
import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import type { SketchBotRequestStatus } from '../../shared/sketch/bot-requests';
import type { SketchAgentActivity, SketchImageApprovals } from '../../shared/sketch/commands';
import type { SketchWireElement } from '../../shared/sketch/payloads';
import type { Screening } from '../../shared/sketch/protocol';
import type { SketchRoomStats } from '../../shared/sketch/room-stats';
import type { SketchRoomConnection } from '../../shared/sketch/room-admin';
import type {
	BotPolicy,
	SketchActor,
	SketchRole,
	SketchScene,
	SketchScreenVerdict,
	SketchTurnPosture,
} from '../../shared/sketch/types';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';

/** How long a view waits after the last change before it autosaves. */
export const SKETCH_AUTOSAVE_DEBOUNCE_MS = 1000;

/**
 * The `appState` keys a sketch file keeps: what Excalidraw's own export keeps
 * for the canvas, minus the view (scroll, zoom, selection), which is per user.
 */
export const PERSISTED_SKETCH_APP_STATE_KEYS = [
	'viewBackgroundColor',
	'gridSize',
	'gridStep',
	'gridModeEnabled',
] as const;

/** The persisted part of an Excalidraw `appState`. */
export function pickPersistedAppState(appState: Record<string, unknown>): Record<string, unknown> {
	const picked: Record<string, unknown> = {};
	for (const key of PERSISTED_SKETCH_APP_STATE_KEYS) {
		if (appState[key] !== undefined) picked[key] = appState[key];
	}
	return picked;
}

export type SketchSessionStatus = 'loading' | 'ready' | 'error';

/** Most chat messages a session keeps; older ones drop off the top. */
export const SKETCH_CHAT_HISTORY_LIMIT = 200;

/**
 * The `@bot` request a conductor message started, kept on the message so the
 * pane can offer "Run with full access" once its restricted turn is over (Q2).
 */
export interface SketchChatRequestMark {
	replyTo: string;
	/** The posture the message's own turn ran under. */
	posture: SketchTurnPosture;
	/** The room saw it as a `toBot` chat, so a reply threads under `replyTo`. */
	shared: boolean;
	/** The conductor ran it again with full access. Escalation never carries over. */
	escalated?: true;
}

/** One message in the Sketch tab's chat pane. */
export interface SketchChatMessage {
	id: string;
	/** Who posted it, as the pane names them. */
	actor: SketchActor;
	text: string;
	ts: number;
	/** Set on the conductor's own `@bot` messages. */
	request?: SketchChatRequestMark;
}

export type { SketchBotRequestStatus };

/** One `@bot` request the bot relay holds (spec section 5). */
export interface SketchBotRequest {
	/** The chat message id, or a local id for a conductor message on an unshared sketch. */
	replyTo: string;
	/** The server-stamped envelope actor (A2), never anything from the ciphertext. */
	actor: SketchActor;
	/** The decrypted request. */
	text: string;
	/** Server `chat.ts` for a room request; the local clock for a conductor message. */
	ts: number;
	status: SketchBotRequestStatus;
	/** The gate's decision for a guest request; null for the conductor's own message. */
	verdict: SketchScreenVerdict | null;
	/** The posture the turn runs (or will run) under (spec section 5, Turn posture). */
	posture: SketchTurnPosture;
	/** The server expired it while it ran (Y3): the reply is still posted. */
	expired?: true;
	/** Why the outbound screen holds the reply (`held`), naming the model and its score. */
	heldReason?: string;
}

/** An agent's `sketch_focus`, until a view scrolls to it. */
export interface SketchFocusRequest {
	elementIds: string[];
	/** Unique per request, so a view clears only the one it handled. */
	nonce: number;
}

/** An agent's latest sketch tool call on one sketch, as this window received it. */
export interface SketchAgentActivityMark {
	agentId: string;
	/** The call changes the canvas. */
	writes: boolean;
	/** This window's clock when the push arrived, comparable with a tab's `thinkingStartTime`. */
	at: number;
}

/** The agent behind an agent write. */
export interface SketchAgentIdentity {
	id: string;
	name: string;
}

/** Where the room socket stands. */
export type { SketchRoomConnection };

/** A message for the Sketch tab about the room (a close code, a reconnect). */
export interface SketchRoomNotice {
	tone: 'info' | 'warning' | 'error';
	text: string;
	/** The close code that raised it, when one did. */
	closeCode?: number;
}

/** The room's screening flag (wire contract X10, spec section 8.10 G4 and H1). */
export interface SketchRoomScreening {
	/** What this desktop last sent as `screening.set` on the current socket, or null. */
	reported: Screening | null;
	/** The server's value: `welcome.screening` or the latest `screening` frame. */
	server: Screening | null;
	/** Server ms the server's value took effect (`welcome.screeningSince` / `since`). */
	since: number | null;
}

/** A shared sketch's live room. */
export interface SketchRoomState {
	roomId: string;
	connection: SketchRoomConnection;
	notice: SketchRoomNotice | null;
	/** This desktop's envelope actor, from `welcome`. */
	actor: SketchActor | null;
	role: SketchRole | null;
	botPolicy: BotPolicy | null;
	botOnline: boolean;
	/** Mirror of the server flag (M5): a guest has edited the canvas. */
	guestEdited: boolean;
	/** The newest op seq the server reported. */
	headSeq: number;
	/** The key epoch from `welcome`, the AAD epoch of every frame. Null before one. */
	keyEpoch: number | null;
	/** Every op up to this seq is merged into the scene. */
	syncedSeq: number;
	screening: SketchRoomScreening;
	/**
	 * Why the room was put back on `conductor` (spec section 8.3, rule 2): the
	 * screen became unusable while guests could ask the agent. Shown in the
	 * Sketch tab until dismissed or B2 is turned on again.
	 */
	botPolicyNotice: string | null;
	/**
	 * The newest `room.stats` the server pushed (hosted spec section 8), or
	 * null before one. Kept across a reconnect: the next `welcome` brings a
	 * fresh one.
	 */
	stats: SketchRoomStats | null;
}

/**
 * The server has confirmed `value` for this room: it is what the desktop
 * reports and what the server echoed (`welcome` counts, since an identical
 * `screening.set` is not rebroadcast). The gate sends no guest text to a
 * cloud engine until this is true for `cloud` (spec section 8.10 G4).
 */
export function isRoomScreeningConfirmed(
	room: SketchRoomState | null | undefined,
	value: Screening
): boolean {
	return room?.screening.reported === value && room.screening.server === value;
}

export interface SketchSession {
	sketchId: string;
	status: SketchSessionStatus;
	/** Why the scene could not be read. Set only while `status` is `error`. */
	loadError: string | null;
	/** The last synced scene. Null until the first read finishes. */
	scene: SketchScene | null;
	/** The author map (spec section 7). */
	authors: Record<string, ElementAuthorship>;
	/** A change has not reached disk yet. */
	dirty: boolean;
	/** Bumped on every change, so a save can tell whether it caught up. */
	revision: number;
	/** Why the last save failed, until a save succeeds. */
	saveError: string | null;
	/** Bumped by every change a view did not make, so mounted views pull it in. */
	externalRevision: number;
	/** The newest `sketch_focus` no view has handled yet. */
	focusRequest: SketchFocusRequest | null;
	/** The chat pane, oldest first. */
	chat: SketchChatMessage[];
	/** The bot relay's open requests, oldest first. */
	botRequests: SketchBotRequest[];
	/** Guest images the conductor approved for the agent: element id -> `fileId` (I3). */
	approvedImages: SketchImageApprovals;
	/** The live room, or null when no room client runs for this sketch. */
	room: SketchRoomState | null;
}

/**
 * A guest has edited this board (spec section 5, Turn posture): the room's
 * flag (M5), or any element a guest touched. The conductor's own turns run
 * restricted while it is true.
 */
export function sketchGuestEdited(session: SketchSession | null | undefined): boolean {
	if (!session) return false;
	return (
		session.room?.guestEdited === true ||
		Object.values(session.authors).some((author) => author.guestTouched)
	);
}

/**
 * "Run with full access" is offered on this message (Q2): the conductor's
 * own `@bot` message, whose turn ran restricted and is not running now, not
 * escalated before, while a guest has edited the board.
 */
export function canEscalateSketchMessage(
	session: SketchSession | null | undefined,
	message: SketchChatMessage
): boolean {
	const mark = message.request;
	if (!session || !mark || mark.posture !== 'restricted' || mark.escalated) return false;
	if (!sketchGuestEdited(session)) return false;
	return !session.botRequests.some((request) => request.replyTo === mark.replyTo);
}

/** One Excalidraw `onChange`, as the session takes it. */
export interface SketchLocalChange {
	elements: readonly SketchWireElement[];
	/** The full Excalidraw `appState`; only the persisted keys are kept. */
	appState: Record<string, unknown>;
	/** Excalidraw's `BinaryFiles`. */
	files: Record<string, unknown>;
}

export interface SketchLocalChangeResult {
	/** False when nothing the file keeps changed (a pointer move, a selection). */
	changed: boolean;
	/** The stamped copies of the elements this change created, edited or deleted. */
	stamped: SketchWireElement[];
}

interface SketchSessionState {
	sessions: Record<string, SketchSession>;
	/** Each sketch's latest agent tool call, keyed by sketch id. */
	agentActivity: Record<string, SketchAgentActivityMark>;
	/** Main's `sketch:agentActivity` push arrived. `at` defaults to now. */
	noteSketchAgentActivity: (activity: SketchAgentActivity, at?: number) => void;
	/**
	 * Read the sketch's scene into a session. A ready session is left alone, a
	 * loading one is awaited (the promise settles when that read does), and a
	 * failed one is read again.
	 */
	openSketchSession: (sketchId: string) => Promise<void>;
	/**
	 * Fold one local change into the session: stamp what changed (spec
	 * section 7), update the author map, and mark the session dirty.
	 */
	applyLocalChange: (
		sketchId: string,
		change: SketchLocalChange,
		editor?: SketchEditor,
		actor?: SketchActor
	) => SketchLocalChangeResult;
	/**
	 * Fold an agent's change into the session: `elements` is the whole next
	 * scene. Stamped `kind: 'bot'`, `id: 'agent:<agentId>'` (spec section 7),
	 * recorded in the author map as the agent, saved, and pushed to mounted
	 * views through `externalRevision`. Returns the stamped copies.
	 */
	applyAgentChange: (
		sketchId: string,
		elements: readonly SketchWireElement[],
		agent: SketchAgentIdentity
	) => SketchWireElement[];
	/**
	 * Fold a change the conductor made outside the canvas (the Collaborate panel's
	 * delete of a flagged element): `elements` is the whole next scene,
	 * stamped as the conductor, saved, and pushed to mounted views the way an
	 * agent's change is. Returns the stamped copies.
	 */
	applyConductorChange: (
		sketchId: string,
		elements: readonly SketchWireElement[]
	) => SketchWireElement[];
	/** Ask the views to scroll to these elements. Returns the request. */
	requestSketchFocus: (sketchId: string, elementIds: string[]) => SketchFocusRequest | null;
	/** A view handled this focus request. A newer one is left alone. */
	clearSketchFocus: (sketchId: string, nonce: number) => void;
	/**
	 * Append a chat message. `ts` is the server's `chat.ts` for a room message;
	 * the local clock otherwise. Returns it, or null when the sketch has no session.
	 */
	postSketchChat: (
		sketchId: string,
		message: { actor: SketchActor; text: string; ts?: number }
	) => SketchChatMessage | null;
	/** Change one chat message in place. Nothing happens when it has dropped off. */
	updateSketchChatMessage: (
		sketchId: string,
		messageId: string,
		update: (message: SketchChatMessage) => SketchChatMessage
	) => void;
	/** Add a bot request, or replace the one with the same `replyTo`. */
	putSketchBotRequest: (sketchId: string, request: SketchBotRequest) => void;
	/** Change one bot request in place. Nothing happens when it is gone. */
	updateSketchBotRequest: (
		sketchId: string,
		replyTo: string,
		update: (request: SketchBotRequest) => SketchBotRequest
	) => void;
	/** Forget a bot request (answered, denied, failed or expired). */
	removeSketchBotRequest: (sketchId: string, replyTo: string) => void;
	/**
	 * The conductor lets the agent see this image as it is now (spec section
	 * 8.2, I3): the approval is bound to its current `fileId`. False when the
	 * sketch has no live image with that id.
	 */
	approveSketchImage: (sketchId: string, elementId: string) => boolean;
	/** Withdraw an image approval. */
	revokeSketchImageApproval: (sketchId: string, elementId: string) => void;
	/** Record a delivered version in the author map. A stale version is ignored. */
	recordAuthorship: (sketchId: string, elementId: string, update: AuthorshipUpdate) => void;
	/**
	 * Replace the scene's elements with a merge of remote ops (the room
	 * client's `reconcileElements` result). Nothing is stamped; the scene is
	 * saved and pushed to mounted views. False when the sketch has no scene.
	 */
	applyRemoteElements: (sketchId: string, elements: readonly SketchWireElement[]) => boolean;
	/** Set, update or clear the session's room state. */
	updateSketchRoom: (
		sketchId: string,
		update: (room: SketchRoomState | null) => SketchRoomState | null
	) => void;
	/** Write the scene to disk now. Saves of one sketch never overlap. */
	saveSketchSession: (sketchId: string) => Promise<void>;
	/** Forget a session (the sketch was deleted). Unsaved changes are dropped. */
	dropSketchSession: (sketchId: string) => void;
}

const saveQueue = createKeyedWriteQueue();

/** The scene reads in flight, so a second open awaits the first instead of returning early. */
const pendingOpens = new Map<string, Promise<void>>();

function newSession(sketchId: string): SketchSession {
	return {
		sketchId,
		status: 'loading',
		loadError: null,
		scene: null,
		authors: {},
		dirty: false,
		revision: 0,
		saveError: null,
		externalRevision: 0,
		focusRequest: null,
		chat: [],
		botRequests: [],
		approvedImages: {},
		room: null,
	};
}

let nextFocusNonce = 1;
let nextChatId = 1;

function sameKeys(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	const aKeys = Object.keys(a);
	if (aKeys.length !== Object.keys(b).length) return false;
	return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key));
}

function sameValues(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	return sameKeys(a, b) && Object.keys(a).every((key) => a[key] === b[key]);
}

export const useSketchSessionStore = create<SketchSessionState>((set, get) => {
	function patchSession(sketchId: string, patch: (session: SketchSession) => SketchSession) {
		set((state) => {
			const session = state.sessions[sketchId];
			if (!session) return state;
			const next = patch(session);
			return next === session ? state : { sessions: { ...state.sessions, [sketchId]: next } };
		});
	}

	/** Hash each stamped element's text, then record the version it delivered. */
	async function recordLocalAuthorship(
		sketchId: string,
		elements: SketchWireElement[],
		actor: SketchActor
	): Promise<void> {
		const hashes = await Promise.all(elements.map((element) => sketchTextHash(element)));
		elements.forEach((element, index) => {
			get().recordAuthorship(sketchId, element.id, {
				version: element.version,
				actor,
				textHash: hashes[index],
			});
		});
	}

	/**
	 * A whole next scene made outside every view (an agent's write, the Room
	 * panel): folded in like a local change by `editor`, then pushed to the
	 * mounted views through `externalRevision` and saved, since no view may be
	 * mounted to autosave it.
	 */
	function applyPushedChange(
		sketchId: string,
		elements: readonly SketchWireElement[],
		editor?: SketchEditor,
		actor?: SketchActor
	): SketchWireElement[] {
		const session = get().sessions[sketchId];
		if (!session?.scene) return [];
		const { scene } = session;
		const result = get().applyLocalChange(
			sketchId,
			{ elements, appState: scene.appState, files: scene.files },
			editor,
			actor
		);
		if (!result.changed) return [];
		patchSession(sketchId, (current) => ({
			...current,
			externalRevision: current.externalRevision + 1,
		}));
		void get().saveSketchSession(sketchId);
		return result.stamped;
	}

	return {
		sessions: {},
		agentActivity: {},

		noteSketchAgentActivity: ({ agentId, sketchId, writes }, at = Date.now()) => {
			set((state) => ({
				agentActivity: { ...state.agentActivity, [sketchId]: { agentId, writes, at } },
			}));
		},

		openSketchSession: (sketchId) => {
			const pending = pendingOpens.get(sketchId);
			if (pending) return pending;
			const existing = get().sessions[sketchId];
			if (existing && existing.status !== 'error') return Promise.resolve();
			set((state) => ({ sessions: { ...state.sessions, [sketchId]: newSession(sketchId) } }));
			// Deferred one microtask, so the read is registered before it can settle.
			const read = Promise.resolve().then(async () => {
				try {
					const scene = await window.maestro.sketch.readScene(sketchId);
					patchSession(sketchId, (session) => ({ ...session, status: 'ready', scene }));
				} catch (error) {
					patchSession(sketchId, (session) => ({
						...session,
						status: 'error',
						loadError: ipcErrorMessage(error),
					}));
				} finally {
					pendingOpens.delete(sketchId);
				}
			});
			pendingOpens.set(sketchId, read);
			return read;
		},

		applyLocalChange: (
			sketchId,
			change,
			editor = conductorEditor(),
			actor = localConductorActor()
		) => {
			const session = get().sessions[sketchId];
			if (!session?.scene) return { changed: false, stamped: [] };
			const scene = session.scene;
			const { elements, changedIds } = stampLocalEdits(
				scene.elements,
				change.elements,
				editor,
				Date.now()
			);
			const appState = pickPersistedAppState(change.appState);
			const sameElements = changedIds.length === 0 && elements.length === scene.elements.length;
			const sameAppState = sameValues(appState, pickPersistedAppState(scene.appState));
			const sameFiles = sameKeys(change.files, scene.files);
			if (sameElements && sameAppState && sameFiles) return { changed: false, stamped: [] };

			const nextScene: SketchScene = {
				...scene,
				elements,
				appState: sameAppState ? scene.appState : { ...scene.appState, ...appState },
				files: sameFiles ? scene.files : { ...change.files },
			};
			patchSession(sketchId, (current) => ({
				...current,
				scene: nextScene,
				dirty: true,
				revision: current.revision + 1,
			}));

			const changed = new Set(changedIds);
			const stamped = elements.filter((element) => changed.has(element.id));
			if (stamped.length > 0) void recordLocalAuthorship(sketchId, stamped, actor);
			return { changed: true, stamped };
		},

		applyAgentChange: (sketchId, elements, agent) =>
			applyPushedChange(
				sketchId,
				elements,
				botEditor(agent.id, agent.name),
				botActor(agent.id, agent.name)
			),

		applyConductorChange: (sketchId, elements) => applyPushedChange(sketchId, elements),

		requestSketchFocus: (sketchId, elementIds) => {
			if (!get().sessions[sketchId]) return null;
			const request: SketchFocusRequest = { elementIds: [...elementIds], nonce: nextFocusNonce++ };
			patchSession(sketchId, (session) => ({ ...session, focusRequest: request }));
			return request;
		},

		clearSketchFocus: (sketchId, nonce) => {
			patchSession(sketchId, (session) =>
				session.focusRequest?.nonce === nonce ? { ...session, focusRequest: null } : session
			);
		},

		postSketchChat: (sketchId, { actor, text, ts }) => {
			if (!get().sessions[sketchId]) return null;
			const message: SketchChatMessage = {
				id: `chat-${nextChatId++}`,
				actor,
				text,
				ts: ts ?? Date.now(),
			};
			patchSession(sketchId, (session) => ({
				...session,
				chat: [...session.chat, message].slice(-SKETCH_CHAT_HISTORY_LIMIT),
			}));
			return message;
		},

		updateSketchChatMessage: (sketchId, messageId, update) =>
			patchSession(sketchId, (session) => {
				const index = session.chat.findIndex((message) => message.id === messageId);
				if (index < 0) return session;
				const chat = [...session.chat];
				chat[index] = update(chat[index]);
				return { ...session, chat };
			}),

		putSketchBotRequest: (sketchId, request) =>
			patchSession(sketchId, (session) => ({
				...session,
				botRequests: [
					...session.botRequests.filter((existing) => existing.replyTo !== request.replyTo),
					request,
				],
			})),

		updateSketchBotRequest: (sketchId, replyTo, update) =>
			patchSession(sketchId, (session) => {
				const index = session.botRequests.findIndex((request) => request.replyTo === replyTo);
				if (index < 0) return session;
				const botRequests = [...session.botRequests];
				botRequests[index] = update(botRequests[index]);
				return { ...session, botRequests };
			}),

		removeSketchBotRequest: (sketchId, replyTo) =>
			patchSession(sketchId, (session) =>
				session.botRequests.some((request) => request.replyTo === replyTo)
					? {
							...session,
							botRequests: session.botRequests.filter((request) => request.replyTo !== replyTo),
						}
					: session
			),

		approveSketchImage: (sketchId, elementId) => {
			const element = get().sessions[sketchId]?.scene?.elements.find(
				(candidate) => candidate.id === elementId
			);
			const fileId = element?.fileId;
			if (!element || element.type !== 'image' || element.isDeleted === true) return false;
			if (typeof fileId !== 'string' || !fileId) return false;
			patchSession(sketchId, (session) => ({
				...session,
				approvedImages: { ...session.approvedImages, [elementId]: fileId },
			}));
			return true;
		},

		revokeSketchImageApproval: (sketchId, elementId) => {
			patchSession(sketchId, (session) => {
				if (!(elementId in session.approvedImages)) return session;
				const { [elementId]: _revoked, ...approvedImages } = session.approvedImages;
				return { ...session, approvedImages };
			});
		},

		recordAuthorship: (sketchId, elementId, update) => {
			patchSession(sketchId, (session) => {
				const previous = session.authors[elementId];
				if (previous && previous.version >= update.version) return session;
				return {
					...session,
					authors: {
						...session.authors,
						[elementId]: nextElementAuthorship(previous, update),
					},
				};
			});
		},

		applyRemoteElements: (sketchId, elements) => {
			if (!get().sessions[sketchId]?.scene) return false;
			patchSession(sketchId, (current) =>
				current.scene
					? {
							...current,
							scene: { ...current.scene, elements: [...elements] },
							dirty: true,
							revision: current.revision + 1,
							externalRevision: current.externalRevision + 1,
						}
					: current
			);
			// No view may be mounted to autosave it, so the merge saves itself.
			void get().saveSketchSession(sketchId);
			return true;
		},

		updateSketchRoom: (sketchId, update) => {
			patchSession(sketchId, (session) => {
				const room = update(session.room);
				return room === session.room ? session : { ...session, room };
			});
		},

		saveSketchSession: (sketchId) =>
			saveQueue.enqueue(sketchId, async () => {
				const session = get().sessions[sketchId];
				if (!session?.scene || !session.dirty) return;
				const { scene, revision } = session;
				try {
					await window.maestro.sketch.writeScene(sketchId, scene);
				} catch (error) {
					patchSession(sketchId, (current) => ({
						...current,
						saveError: ipcErrorMessage(error),
					}));
					return;
				}
				patchSession(sketchId, (current) => ({
					...current,
					dirty: current.revision !== revision,
					saveError: null,
				}));
			}),

		dropSketchSession: (sketchId) => {
			set((state) => {
				if (!state.sessions[sketchId] && !state.agentActivity[sketchId]) return state;
				const { [sketchId]: _dropped, ...sessions } = state.sessions;
				const { [sketchId]: _activity, ...agentActivity } = state.agentActivity;
				return { sessions, agentActivity };
			});
		},
	};
});

/**
 * The sketch's session, read into the store first when no view has opened it
 * (and kept, so the author map it gathers from here on is kept too). Throws
 * the load error when the scene cannot be read.
 */
export async function openReadySketchSession(
	sketchId: string
): Promise<SketchSession & { scene: SketchScene }> {
	const existing = useSketchSessionStore.getState().sessions[sketchId];
	if (!existing || existing.status !== 'ready' || !existing.scene) {
		await useSketchSessionStore.getState().openSketchSession(sketchId);
	}
	const session = useSketchSessionStore.getState().sessions[sketchId];
	if (!session?.scene || session.status !== 'ready') {
		throw new Error(session?.loadError ?? 'The sketch could not be read.');
	}
	return session as SketchSession & { scene: SketchScene };
}
