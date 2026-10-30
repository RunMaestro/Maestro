/**
 * The `sketch_command` WS message (`maestro-cli sketch`, spec section 9) and
 * the renderer hop behind it.
 *
 * The CLI sends one message with an `action`; main answers it through the
 * SketchService, the same service the `sketch:*` IPC handlers call. Two
 * actions need a window: opening a sketch tab (the tab lives in the renderer's
 * agent model) and rendering PNG or SVG (Excalidraw measures text in a DOM).
 * For those, main sends a `SketchRendererRequest` to the window that owns the
 * agent and waits for a `SketchRendererResult`. The agent read tools (T1, T3,
 * T4) use the same hop to read the live `SketchSession` (`readSession`): the
 * scene with unsaved edits and the author map, which only the window holds.
 * The agent write tools (T5-T8, T11, T12) use it to change that session
 * (`agentWrite`, after main's outbound screen) and to turn Mermaid into
 * element skeletons (`convertMermaid`), since both need Excalidraw's DOM.
 * `sketch_screenshot` and `sketch_export` (T9, T10) draw the session's
 * elements that main picked, with the session's files (`renderForAgent`).
 * The `@bot` decisions (`sketch requests|approve|deny|escalate|publish|
 * discard`) list and act on the bot relay's requests, which live in the
 * window that owns the sketch (`botRequest`). `sketch bot-policy` sends
 * `policy.set` through the room client that window runs (`botPolicy`), and
 * the Collaborate panel verbs (`sketch stats|kick|unlock|unsuspend`) read
 * `room.stats` and send the conductor frames through it too (`roomAdmin`).
 * `sketch chat` reads the chat pane and sends the conductor's chat through
 * the same composer path the Sketch tab uses (`chat`).
 *
 * Also here: `summarizeSketchScene()`, the `read --format summary` view of a
 * saved scene. Bundled into the renderer and the CLI, so it imports nothing
 * from Electron or Node.
 */

import type { ElementAuthorship } from './attribution';
import type { SketchBotRequestInfo, SketchBotRequestOp } from './bot-requests';
import type { SketchRoomAdminOp, SketchRoomStatsReading } from './room-admin';
import type { SketchOwnerStatus } from './server';
import type { SketchWireElement } from './payloads';
import {
	SKETCH_ACTOR_KINDS,
	SKETCH_ROLES,
	type BotPolicy,
	type SketchActor,
	type SketchLinkRole,
	type SketchRecord,
	type SketchScene,
} from './types';

export const SKETCH_COMMAND_ACTIONS = [
	'new',
	'list',
	'open',
	'rename',
	'delete',
	'read',
	'export',
	'screening-consent',
	'share',
	'unshare',
	'revoke-link',
	'link',
	'reset-link',
	'rotate',
	'owner',
	'requests',
	'approve',
	'deny',
	'escalate',
	'publish',
	'discard',
	'bot-policy',
	'stats',
	'kick',
	'unlock',
	'unsuspend',
	'audit',
	'chat',
] as const;
export type SketchCommandAction = (typeof SKETCH_COMMAND_ACTIONS)[number];

/**
 * The verbs that change who can reach a room (spec section 9, A1). From an
 * agent caller each raises a desktop confirmation and runs only on Allow.
 */
export const SKETCH_SHARING_ACTIONS = [
	'share',
	'unshare',
	'revoke-link',
	'link',
	'reset-link',
	'rotate',
] as const;
export type SketchSharingAction = (typeof SKETCH_SHARING_ACTIONS)[number];

/** `maestro-cli sketch owner <op>`: this device's RunMaestro.ai owner sign-in (spec section 6, M1). */
export const SKETCH_OWNER_OPS = ['status', 'register', 'sign-out'] as const;
export type SketchOwnerOp = (typeof SKETCH_OWNER_OPS)[number];

/** `maestro-cli sketch screening-consent <op>` (spec section 8.10). */
export const SKETCH_SCREENING_CONSENT_OPS = ['grant', 'revoke', 'status'] as const;
export type SketchScreeningConsentOp = (typeof SKETCH_SCREENING_CONSENT_OPS)[number];

export const SKETCH_READ_FORMATS = ['summary', 'elements'] as const;
export type SketchReadFormat = (typeof SKETCH_READ_FORMATS)[number];

export const SKETCH_EXPORT_FORMATS = ['png', 'svg', 'json'] as const;
export type SketchExportFormat = (typeof SKETCH_EXPORT_FORMATS)[number];

/** The formats only a window can draw. */
export type SketchImageFormat = Exclude<SketchExportFormat, 'json'>;

export const SKETCH_EXPORT_MIME_TYPES: Readonly<Record<SketchExportFormat, string>> = {
	png: 'image/png',
	svg: 'image/svg+xml',
	json: 'application/json',
};

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export function isSketchCommandAction(value: unknown): value is SketchCommandAction {
	return isOneOf(SKETCH_COMMAND_ACTIONS, value);
}

export function isSketchSharingAction(value: unknown): value is SketchSharingAction {
	return isOneOf(SKETCH_SHARING_ACTIONS, value);
}

export function isSketchOwnerOp(value: unknown): value is SketchOwnerOp {
	return isOneOf(SKETCH_OWNER_OPS, value);
}

export function isSketchScreeningConsentOp(value: unknown): value is SketchScreeningConsentOp {
	return isOneOf(SKETCH_SCREENING_CONSENT_OPS, value);
}

export function isSketchReadFormat(value: unknown): value is SketchReadFormat {
	return isOneOf(SKETCH_READ_FORMATS, value);
}

export function isSketchExportFormat(value: unknown): value is SketchExportFormat {
	return isOneOf(SKETCH_EXPORT_FORMATS, value);
}

/**
 * An exported file, ready to write. Text formats (SVG, JSON) travel as UTF-8,
 * PNG as base64, so the bytes survive the JSON hops between the window, main
 * and the CLI.
 */
export interface SketchExportFile {
	format: SketchExportFormat;
	mimeType: string;
	encoding: 'utf8' | 'base64';
	data: string;
}

/**
 * A scene as an `.excalidraw` file: the scene JSON as given, tab-indented, so
 * it opens in excalidraw.com unchanged. `maestro-cli sketch export --format
 * json` and the agent's `sketch_export` both write it.
 */
export function sketchSceneJsonFile(scene: SketchScene): SketchExportFile {
	return {
		format: 'json',
		mimeType: SKETCH_EXPORT_MIME_TYPES.json,
		encoding: 'utf8',
		data: JSON.stringify(scene, null, '\t'),
	};
}

/** `new` and `open`: a sketch and the tab it is shown in. */
export interface OpenedSketch {
	record: SketchRecord;
	tabId: string | null;
}

/** `read`: the saved board as a summary, or its live elements whole. */
export type SketchReading =
	| { record: SketchRecord; format: 'summary'; summary: SketchSceneSummary }
	| { record: SketchRecord; format: 'elements'; elements: SketchWireElement[] };

/** `export`: the file, ready to write, and the sketch it came from. */
export interface ExportedSketch {
	record: SketchRecord;
	file: SketchExportFile;
}

/** `owner`: the sign-in state, and for `register` what the server did with the email. */
export interface SketchOwnerCommandResult {
	status: SketchOwnerStatus;
	email?: 'sent' | 'already-confirmed';
}

/**
 * A link as `share` and `reset-link` mint it, or `link` reads it back. `url`
 * holds the key and the cap: the cap is sealed on the desktop, never in a record.
 */
export interface SketchMintedLink {
	capId: string;
	role: SketchLinkRole;
	label: string;
	/** Server expiry, ms since the epoch, or null for a link that never expires. */
	expiresAt: number | null;
	url: string;
}

/** `share`: the sketch, whether a room was made for it, and the new link. */
export interface SketchShareResult {
	record: SketchRecord;
	createdRoom: boolean;
	link: SketchMintedLink;
}

/** What `share` takes beyond the sketch. Every field is optional. */
export interface SketchShareOptions {
	role?: SketchLinkRole;
	/** Days until the link expires; the role's default (Q7) when unset. */
	expiresInDays?: number;
	label?: string;
}

/**
 * Everything the room client needs to join a shared sketch's room (spec
 * section 6). Main hands it only to the window that owns the sketch's agent;
 * the key and the owner token never go to the CLI or into a log.
 */
export interface SketchRoomJoin {
	sketchId: string;
	roomId: string;
	/** The room key, base64url. */
	roomKey: string;
	/** The owner token, for `hello.auth.owner`. */
	ownerToken: string;
	serverUrl: string;
	/** The agent the room's bot speaks for, announced after `screening.set` (D4). */
	bot: { agentId: string; name: string } | null;
}

/** What made main take every room offline (`suspend`, `quit`) or back online (`resume`). */
export type SketchPresenceReason = 'suspend' | 'resume' | 'quit';

/**
 * Main's push to every window on sleep, wake and quit (spec section 5,
 * contract obligation 5): `online:false` sends `bot.presence {online:false}`
 * and closes each room socket; `online:true` reconnects them.
 */
export interface SketchPresenceChange {
	online: boolean;
	reason: SketchPresenceReason;
}

/**
 * Main's push to every window on each sketch tool call an agent makes on one
 * sketch (`sketch:agentActivity`), before the tool runs. The window shows the
 * agent as working on the sketch until the turn that made the call ends.
 */
export interface SketchAgentActivity {
	agentId: string;
	sketchId: string;
	/** The call changes the canvas (add, update, delete, Mermaid). */
	writes: boolean;
}

/** One element's version: what the room is known to hold after a snapshot upload. */
export interface SketchElementVersion {
	id: string;
	version: number;
}

/** A live scene for a snapshot upload, and the newest op seq it includes. */
export interface SketchSceneForSnapshot {
	scene: SketchScene;
	baseSeq: number;
}

/** Main to the renderer: the work only a window can do. */
export type SketchRendererRequest =
	| {
			action: 'open';
			/** The agent that owns the sketch; the tab opens there. */
			sessionId: string;
			sketchId: string;
			name: string;
			/** Leave the active agent and tab alone (`--background`). */
			background: boolean;
	  }
	| { action: 'export'; format: SketchImageFormat; scene: SketchScene }
	| {
			/**
			 * The sketch was deleted: close every tab pointing at it and drop its
			 * live session, so no view autosaves into a record that is gone.
			 */
			action: 'forget';
			sketchId: string;
	  }
	| {
			action: 'readSession';
			sketchId: string;
			/**
			 * Read the scene into a session when none is open yet. False answers
			 * `session: null` instead, so a listing never loads every board.
			 */
			open: boolean;
	  }
	| {
			action: 'agentWrite';
			sketchId: string;
			/** The agent making the change: stamped `kind: 'bot'`, `id: 'agent:<id>'` (spec section 7). */
			agent: { id: string; name: string };
			/** Already through main's outbound screen. */
			write: SketchAgentWrite;
	  }
	| { action: 'convertMermaid'; mermaid: string }
	| {
			action: 'renderForAgent';
			sketchId: string;
			format: SketchExportFormat;
			/**
			 * Exactly what to draw (T9, T10). Main has already removed every
			 * withheld element and unapproved guest image (spec section 8.4,
			 * Pixels); the window adds only the session's background and the
			 * binary files these elements name.
			 */
			elements: SketchWireElement[];
			/** PNG pixels per scene pixel; 1 when unset. */
			scale?: number;
	  }
	| {
			/** The live scene (unsaved edits included) for a snapshot, and the room's seq. */
			action: 'snapshotScene';
			sketchId: string;
	  }
	| {
			/**
			 * The bot relay's `@bot` requests: `list` the ones in `sketchIds`, or
			 * act on the request `replyTo` of `sketchId` (spec sections 5 and 9).
			 * Main has already raised the desktop confirmation an agent caller
			 * needs (A1).
			 */
			action: 'botRequest';
			op: SketchBotRequestOp;
			sketchIds?: string[];
			sketchId?: string;
			replyTo?: string;
	  }
	| {
			/**
			 * Send `policy.set` on the sketch's live room (spec section 5, B2).
			 * Main has already checked `isB2Available()` for `writers` and raised
			 * the desktop confirmation an agent caller needs (A1). `notice` is
			 * set when main puts the room back on `conductor` because the screen
			 * became unusable: the Sketch tab shows it.
			 */
			action: 'botPolicy';
			sketchId: string;
			botPolicy: BotPolicy;
			notice?: string;
	  }
	| {
			/**
			 * The Collaborate panel on the sketch's live room (spec section 6): `stats`
			 * reads the newest `room.stats` (asking the server again first), and
			 * `kick`, `unlock` and `unsuspend` send the conductor frame, then read
			 * it again. Main has already raised the desktop confirmation an agent
			 * caller needs (A1).
			 */
			action: 'roomAdmin';
			sketchId: string;
			op: SketchRoomAdminOp;
			actorId?: string;
			capId?: string;
			minutes?: number;
	  }
	| {
			/**
			 * Read the chat pane, and first send `text` as the conductor when it
			 * is set (`sketch chat`). Main has already raised the desktop
			 * confirmation an agent caller needs (A1).
			 */
			action: 'chat';
			sketchId: string;
			text?: string;
	  }
	| {
			/**
			 * Join the sketch's room, or leave it (`connection: null`). `baseline`
			 * is what the room holds after the snapshot main just uploaded; edits
			 * newer than it go out as deltas once the client is live.
			 */
			action: 'syncRoom';
			sketchId: string;
			connection: SketchRoomJoin | null;
			baseline?: SketchElementVersion[];
	  };

/** Element skeletons in Excalidraw's `convertToExcalidrawElements` shape (spec T5). */
export type SketchElementSkeleton = Record<string, unknown>;

/** One `sketch_update_elements` patch: the element, the version read, and the props to set. */
export interface SketchElementPatch {
	id: string;
	baseVersion?: number;
	props: Record<string, unknown>;
}

/** An agent's change to a live session (T5-T8, T11, T12). */
export type SketchAgentWrite =
	| {
			op: 'add';
			skeletons: SketchElementSkeleton[];
			/**
			 * Give every element a fresh id (Mermaid). Off for T5, where an agent
			 * names ids so later elements can bind to them.
			 */
			regenerateIds: boolean;
			/** Place the new elements below the drawing instead of where they say (Mermaid). */
			placeBelowScene: boolean;
	  }
	| { op: 'update'; patches: SketchElementPatch[] }
	| { op: 'delete'; ids: string[] }
	| { op: 'focus'; elementIds: string[] }
	| { op: 'chat'; text: string };

/** What an agent write did. */
export interface SketchAgentWriteResult {
	/** The session's scene version after the write. */
	sceneVersion: number;
	/** Elements the write created, changed, deleted or focused, in order. */
	elements: { id: string; type: string }[];
	/** Named ids the scene does not hold (or holds only as deleted). */
	missing: string[];
	/**
	 * `update` patches refused on a stale `baseVersion`: the elements as they
	 * are now, with their author map entries, for main to gate and return.
	 */
	conflicts: SketchSessionSnapshot;
}

/**
 * A live `SketchSession` as the agent read tools see it: the elements (deleted
 * ones included, for `sketch_changes`) and the author map (spec section 7).
 * Binary files stay in the window; only their count crosses.
 */
export interface SketchSessionSnapshot {
	elements: SketchWireElement[];
	authors: Record<string, ElementAuthorship>;
	fileCount: number;
	/**
	 * Guest images the conductor approved for the agent (spec section 8.2, I3):
	 * element id -> the `fileId` approved. An approval covers only that file,
	 * so a guest who swaps the picture needs a new one. Absent means none.
	 */
	approvedImages?: SketchImageApprovals;
}

/** Element id -> the image `fileId` the conductor approved for the agent (spec section 8.2, I3). */
export type SketchImageApprovals = Record<string, string>;

export type SketchRendererResult =
	| {
			success: true;
			tabId?: string;
			file?: SketchExportFile;
			/** `readSession`: null when no session is open and `open` was false. */
			session?: SketchSessionSnapshot | null;
			/** `agentWrite`. */
			write?: SketchAgentWriteResult;
			/** `convertMermaid`. */
			skeletons?: SketchElementSkeleton[];
			/** `snapshotScene`. */
			snapshot?: SketchSceneForSnapshot;
			/** `botRequest`: the listed requests, or the one an op acted on. */
			botRequests?: SketchBotRequestInfo[];
			/** `roomAdmin`: the room as it stands after the op. */
			roomStats?: SketchRoomStatsReading;
			/** `chat`: the pane after the call. */
			chat?: SketchChatReading;
	  }
	| { success: false; error: string };

function isExportFile(value: unknown): value is SketchExportFile {
	if (!value || typeof value !== 'object') return false;
	const file = value as Record<string, unknown>;
	return (
		isSketchExportFormat(file.format) &&
		typeof file.mimeType === 'string' &&
		(file.encoding === 'utf8' || file.encoding === 'base64') &&
		typeof file.data === 'string'
	);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAuthorship(value: unknown): value is ElementAuthorship {
	if (!isObjectRecord(value) || !isObjectRecord(value.actor)) return false;
	const actor = value.actor;
	return (
		typeof value.version === 'number' &&
		typeof value.textHash === 'string' &&
		typeof value.guestTouched === 'boolean' &&
		typeof actor.id === 'string' &&
		typeof actor.name === 'string' &&
		(SKETCH_ACTOR_KINDS as readonly unknown[]).includes(actor.kind) &&
		(SKETCH_ROLES as readonly unknown[]).includes(actor.role)
	);
}

/**
 * A session snapshot as main may trust it, or undefined when it is malformed.
 * An author map entry that does not parse is dropped, so its element reads as
 * unknown-author, which the gate treats as third-party (fail closed).
 */
function normalizeSessionSnapshot(value: unknown): SketchSessionSnapshot | undefined {
	if (!isObjectRecord(value) || !Array.isArray(value.elements)) return undefined;
	const elements = value.elements.filter(
		(element): element is SketchWireElement =>
			isObjectRecord(element) &&
			typeof element.id === 'string' &&
			typeof element.version === 'number'
	);
	if (elements.length !== value.elements.length) return undefined;
	const authors: Record<string, ElementAuthorship> = {};
	if (isObjectRecord(value.authors)) {
		for (const [id, entry] of Object.entries(value.authors)) {
			if (isAuthorship(entry)) authors[id] = entry;
		}
	}
	const fileCount =
		typeof value.fileCount === 'number' && Number.isFinite(value.fileCount) ? value.fileCount : 0;
	return { elements, authors, fileCount };
}

function isIdAndType(value: unknown): value is { id: string; type: string } {
	return isObjectRecord(value) && typeof value.id === 'string' && typeof value.type === 'string';
}

/** A write result as main may trust it, or undefined when it is malformed. */
function normalizeAgentWriteResult(value: unknown): SketchAgentWriteResult | undefined {
	if (!isObjectRecord(value)) return undefined;
	const { sceneVersion, elements, missing } = value;
	if (typeof sceneVersion !== 'number' || !Number.isFinite(sceneVersion)) return undefined;
	if (!Array.isArray(elements) || !elements.every(isIdAndType)) return undefined;
	if (!Array.isArray(missing) || !missing.every((id) => typeof id === 'string')) return undefined;
	const conflicts = normalizeSessionSnapshot(value.conflicts);
	if (!conflicts) return undefined;
	return {
		sceneVersion,
		elements: elements.map(({ id, type }) => ({ id, type })),
		missing: [...missing],
		conflicts,
	};
}

/** A renderer reply as main may trust it. Anything malformed is a failure. */
export function normalizeSketchRendererResult(raw: unknown): SketchRendererResult {
	if (!raw || typeof raw !== 'object') {
		return { success: false, error: 'The Maestro window sent no answer.' };
	}
	const reply = raw as Record<string, unknown>;
	if (reply.success !== true) {
		return {
			success: false,
			error:
				typeof reply.error === 'string' && reply.error
					? reply.error
					: 'The Maestro window could not do that.',
		};
	}
	const session = reply.session === null ? null : normalizeSessionSnapshot(reply.session);
	const write = normalizeAgentWriteResult(reply.write);
	const skeletons =
		Array.isArray(reply.skeletons) && reply.skeletons.every(isObjectRecord)
			? reply.skeletons
			: undefined;
	const snapshot = normalizeSceneForSnapshot(reply.snapshot);
	const botRequests =
		Array.isArray(reply.botRequests) && reply.botRequests.every(isBotRequestInfo)
			? reply.botRequests
			: undefined;
	return {
		success: true,
		...(typeof reply.tabId === 'string' ? { tabId: reply.tabId } : {}),
		...(isExportFile(reply.file) ? { file: reply.file } : {}),
		...(session !== undefined ? { session } : {}),
		...(write ? { write } : {}),
		...(skeletons ? { skeletons } : {}),
		...(snapshot ? { snapshot } : {}),
		...(botRequests ? { botRequests } : {}),
		...(isRoomStatsReading(reply.roomStats) ? { roomStats: reply.roomStats } : {}),
		...(isChatReading(reply.chat) ? { chat: reply.chat } : {}),
	};
}

/** One chat pane message as `sketch chat` reads it. */
export interface SketchChatEntry {
	id: string;
	/** The server-stamped actor (A2), or the local conductor. */
	actor: SketchActor;
	ts: number;
	/** Null when withheld from an agent caller. */
	text: string | null;
	/**
	 * A guest's chat is not screened, so an agent caller never reads it (spec
	 * section 8): its text is null and this says why.
	 */
	withheld?: 'unscreened';
	/** The `@bot` request the message started (the conductor's own). */
	replyTo?: string;
}

/** What a send did: asked the agent (with the request id), or posted to the room. */
export interface SketchChatSent {
	toBot: boolean;
	replyTo?: string;
}

/** `chat`: the pane after the call, oldest first, and what a send did. */
export interface SketchChatReading {
	sketchId: string;
	messages: SketchChatEntry[];
	sent?: SketchChatSent;
}

function isChatEntry(value: unknown): value is SketchChatEntry {
	return (
		isObjectRecord(value) &&
		typeof value.id === 'string' &&
		isRequestActor(value.actor) &&
		typeof value.ts === 'number' &&
		(typeof value.text === 'string' || value.text === null) &&
		(value.replyTo === undefined || typeof value.replyTo === 'string')
	);
}

/** A `chat` reply as main may trust it. */
function isChatReading(value: unknown): value is SketchChatReading {
	if (!isObjectRecord(value) || typeof value.sketchId !== 'string') return false;
	if (!Array.isArray(value.messages) || !value.messages.every(isChatEntry)) return false;
	const sent = value.sent;
	return (
		sent === undefined ||
		(isObjectRecord(sent) &&
			typeof sent.toBot === 'boolean' &&
			(sent.replyTo === undefined || typeof sent.replyTo === 'string'))
	);
}

/**
 * The chat as an agent caller may read it: a guest's text is withheld, since
 * nothing screened it (spec section 8). The conductor's and the bot's stay.
 */
export function withholdGuestChat(reading: SketchChatReading): SketchChatReading {
	return {
		...reading,
		messages: reading.messages.map((message) =>
			message.actor.kind === 'guest'
				? { ...message, text: null, withheld: 'unscreened' as const }
				: message
		),
	};
}

const ROOM_CONNECTIONS = ['connecting', 'catching-up', 'live', 'reconnecting', 'stopped'];

/**
 * A `roomAdmin` reply as main may trust it: the shape the Collaborate panel reads.
 * The stats are the server's frame, already parsed by the room client.
 */
function isRoomStatsReading(value: unknown): value is SketchRoomStatsReading {
	if (!isObjectRecord(value) || typeof value.sketchId !== 'string') return false;
	if (value.connection !== null && !ROOM_CONNECTIONS.includes(value.connection as string)) {
		return false;
	}
	const stats = value.stats;
	return (
		stats === null ||
		(isObjectRecord(stats) && Array.isArray(stats.actors) && Array.isArray(stats.caps))
	);
}

function isRequestActor(value: unknown): value is SketchActor {
	return (
		isObjectRecord(value) &&
		typeof value.id === 'string' &&
		typeof value.name === 'string' &&
		(SKETCH_ACTOR_KINDS as readonly unknown[]).includes(value.kind) &&
		(SKETCH_ROLES as readonly unknown[]).includes(value.role)
	);
}

/** A listed `@bot` request as main may trust it. */
function isBotRequestInfo(value: unknown): value is SketchBotRequestInfo {
	return (
		isObjectRecord(value) &&
		typeof value.sketchId === 'string' &&
		typeof value.replyTo === 'string' &&
		isRequestActor(value.actor) &&
		typeof value.text === 'string' &&
		typeof value.ts === 'number' &&
		['awaiting_approval', 'running', 'held', 'ended'].includes(value.status as string) &&
		(value.verdict === null || isObjectRecord(value.verdict)) &&
		(value.posture === 'restricted' || value.posture === 'full') &&
		typeof value.canEscalate === 'boolean'
	);
}

/** A `snapshotScene` reply as main may trust it, or undefined. The store checks the scene again. */
function normalizeSceneForSnapshot(value: unknown): SketchSceneForSnapshot | undefined {
	if (!isObjectRecord(value) || !isObjectRecord(value.scene)) return undefined;
	const { scene, baseSeq } = value;
	if (!Number.isSafeInteger(baseSeq) || (baseSeq as number) < 0) return undefined;
	if (
		!Array.isArray(scene.elements) ||
		!isObjectRecord(scene.appState) ||
		!isObjectRecord(scene.files)
	) {
		return undefined;
	}
	return { scene: scene as unknown as SketchScene, baseSeq: baseSeq as number };
}

/** One shape on the board, named by its own or its bound text. */
export interface SketchSummaryShape {
	id: string;
	type: string;
	label?: string;
}

/** An arrow or line, with the shapes its ends are bound to (`A -> B`). */
export interface SketchSummaryConnection {
	id: string;
	type: string;
	/** The start shape's label, or `type#id-prefix`; null when the end is loose. */
	from: string | null;
	to: string | null;
	label?: string;
}

/** `read --format summary`: what is on a saved board, without its geometry. */
export interface SketchSceneSummary {
	/** Live (not deleted) elements. */
	elementCount: number;
	deletedCount: number;
	/** Live elements by Excalidraw type. */
	byType: Record<string, number>;
	/** Shapes that are neither connectors nor bound text. Text elements count as shapes. */
	shapes: SketchSummaryShape[];
	connections: SketchSummaryConnection[];
	/** The box around every live element, in scene coordinates. */
	bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
	/** Embedded images (Excalidraw binary files). */
	fileCount: number;
}

/** The element types drawn as connectors (`from -> to`). */
export const SKETCH_CONNECTOR_TYPES: ReadonlySet<string> = new Set(['arrow', 'line']);

/** A string field, trimmed; undefined when missing or blank. */
export function sketchStringField(element: SketchWireElement, field: string): string | undefined {
	const value = element[field];
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** A finite number field, or 0. */
export function sketchNumberField(element: SketchWireElement, field: string): number {
	const value = element[field];
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The element id an arrow end (`startBinding` / `endBinding`) is bound to, or null. */
export function sketchBoundElementId(element: SketchWireElement, field: string): string | null {
	const binding = element[field];
	if (!binding || typeof binding !== 'object') return null;
	const id = (binding as Record<string, unknown>).elementId;
	return typeof id === 'string' ? id : null;
}

/** The short name of an element nobody labeled: `rectangle#1a2b3c4d`. */
export function sketchAnonymousName(element: SketchWireElement): string {
	return `${String(element.type ?? 'element')}#${element.id.slice(0, 8)}`;
}

/**
 * What a saved scene holds, in the words a reader needs: shapes with their
 * labels, connectors as `from -> to`, counts and bounds. Bound text is folded
 * into the shape it labels. Pure, so the CLI, main and tests agree.
 */
export function summarizeSketchScene(scene: SketchScene): SketchSceneSummary {
	const live = scene.elements.filter((element) => element.isDeleted !== true);
	const byId = new Map(live.map((element) => [element.id, element]));

	// A text element with a live container labels that container.
	const boundText = new Map<string, string>();
	for (const element of live) {
		const containerId = sketchStringField(element, 'containerId');
		const text = sketchStringField(element, 'text');
		if (element.type === 'text' && containerId && text && byId.has(containerId)) {
			boundText.set(containerId, text);
		}
	}
	const labelOf = (element: SketchWireElement): string | undefined =>
		boundText.get(element.id) ??
		(element.type === 'text' ? sketchStringField(element, 'text') : undefined);
	const endName = (id: string | null): string | null => {
		if (!id) return null;
		const end = byId.get(id);
		return end ? (labelOf(end) ?? sketchAnonymousName(end)) : null;
	};

	const byType: Record<string, number> = {};
	const shapes: SketchSummaryShape[] = [];
	const connections: SketchSummaryConnection[] = [];
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (const element of live) {
		const type = String(element.type ?? 'unknown');
		byType[type] = (byType[type] ?? 0) + 1;

		const x = sketchNumberField(element, 'x');
		const y = sketchNumberField(element, 'y');
		const width = sketchNumberField(element, 'width');
		const height = sketchNumberField(element, 'height');
		minX = Math.min(minX, x, x + width);
		minY = Math.min(minY, y, y + height);
		maxX = Math.max(maxX, x, x + width);
		maxY = Math.max(maxY, y, y + height);

		const label = labelOf(element);
		if (SKETCH_CONNECTOR_TYPES.has(type)) {
			connections.push({
				id: element.id,
				type,
				from: endName(sketchBoundElementId(element, 'startBinding')),
				to: endName(sketchBoundElementId(element, 'endBinding')),
				...(label ? { label } : {}),
			});
			continue;
		}
		// Bound text is already the label of its container.
		const containerId = sketchStringField(element, 'containerId');
		if (type === 'text' && containerId && byId.has(containerId)) continue;
		shapes.push({ id: element.id, type, ...(label ? { label } : {}) });
	}

	return {
		elementCount: live.length,
		deletedCount: scene.elements.length - live.length,
		byType,
		shapes,
		connections,
		bounds: live.length > 0 ? { minX, minY, maxX, maxY } : null,
		fileCount: Object.keys(scene.files ?? {}).length,
	};
}
