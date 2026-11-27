import { generateUUID } from '../../uuid';
import type { PianolaDispatchReceipt } from '../../pianola/pianola-dispatch';
/**
 * `createWsMaestroClient`: the `MaestroClient` interface over the running
 * desktop's WebSocket bridge (milestone M1).
 *
 * Follows `Plans/maestro-tui-client-api.md`. In short:
 *   - discovery reads `cli-server.json` from the caller's data dir, or takes
 *     the explicit endpoint the caller gave (a Federation remote's SSH
 *     forward); the socket is dialed on 127.0.0.1 with the per-boot `cliSecret`;
 *   - the client stays a dashboard client (it never sends `subscribe`), and
 *     turn streams come from `bridge.event` `process:*` frames (C3);
 *   - mutations are typed bridge messages; `bridge.invoke` is only for full
 *     reads and process control (R5);
 *   - nothing the client sends moves the desktop's view (R4): `background:
 *     true` rides every message that accepts it, and none of `select_session`,
 *     `select_tab`, `switch_mode`, `subscribe`, or an `open_*` is ever sent;
 *   - a drop is survived: heartbeat, backoff with jitter, resume from the last
 *     frame sequence, or a full resync with `gap` events for turns in flight.
 *
 * Every method resolves to a `ClientResult`; nothing here throws for an
 * expected failure (R2).
 */

import type { AgentRecord, AITabRecord, GroupRecord } from '../store/records';
import { agentsOf, groupsOf } from '../store/read-stores';
import { sliceTranscript, transcriptOf, type LogEntryRecord } from '../store/transcript';
import {
	buildAgentConfigPatch,
	buildTabConfigPatch,
	checkAgentCreateInput,
	checkAgentImportInput,
	MAX_AGENT_NAME_LENGTH,
} from '../agents/rules';
import { createEventBus } from './event-bus';
import { getAgentDisplayName } from '../../agentMetadata';
import {
	validateAutoRunLaunch,
	validateGoalRunLaunch,
	type AutoRunLaunchInput,
	type GoalRunLaunchInput,
} from '../autorun/launch';
import { parseAutoRunProgress } from '../autorun/progress';
import { parseAutoRunBroadcastState } from '../../autoRunBroadcast';
import {
	parseGroupChatFrame,
	parseGroupChatRecord,
	validateGroupChatCreate,
	type GroupChatCreateInput,
	type GroupChatRecord,
} from '../groupchat/chat';
import { isValidAgentId } from '../../agentIds';
import { buildSnapshotKey, type AgentCapabilitiesSnapshotMap } from '../../agentCapabilities';
import { stripBlankEnvVars } from '../../agentEnvironment';
import { validateGroupAppearance } from '../../groupAppearance';
import { WEB_LOGIN_WS_CLOSE_CODE } from '../../webLogin';
import { parseWireAskerKey } from '../../crossAgentTypes';
import { parseWireClosedTabs } from '../../closedTabHistory';
import { INTERRUPT_TURN_REPLY_TIMEOUT_MS, parseStoppedItemIds } from '../../turnInterrupt';
import { QUEUE_CHANGES_QUERY_PARAM } from '../../queueSnapshot';
import type { ClosedTabSummary } from '../../closedTabCommands';
import type { AgentError, HistoryEntry, SshRemoteConfig } from '../../types';
import {
	parseQueueSteerResult,
	QUEUE_STEER_ROUND_TRIP_TIMEOUT_MS,
	type QueueSteerResult,
} from '../../chatSteering';
import {
	normalizeSteeringCommandResult,
	type SteeringCommandInput,
	type SteeringCommandResult,
} from '../../autoRunSteeringCommands';
import {
	PROJECT_TOKEN_USAGE_REPLY,
	parseProjectTokenUsageReply,
	projectTokenUsageRequest,
	type ProjectTokenUsage,
	type ProjectTokenUsageProject,
} from '../../projectTokenUsage';
import {
	BridgeConnection,
	CommandTimeoutError,
	ConnectionClosedError,
	UnsupportedCommandError,
} from './bridge-connection';
import {
	isDialableEndpoint,
	isPidAlive,
	readCliServerInfoFrom,
	type ExplicitHostEndpoint,
} from './discovery';
import {
	CUSTOM_COMMANDS_STORE_KEY,
	THEME_STORE_KEY,
	changedWebSettingKeys,
	classifyFailure,
	isUnsupportedInvokeError,
	parseBatchFrame,
	parseProcessFrame,
	parseTranscriptChangedFrame,
	parseUserInputFrame,
	resolveBridgeOutcome,
	TRANSCRIPT_CHANGED_CHANNEL,
	type ProcessFrame,
	type ProcessTarget,
} from './bridge-frames';
import { ClientMirror, type ProjectedAgent, type ProjectedTab } from './mirror';
import type {
	AgentCreateInput,
	AgentImportInput,
	AgentImportReceipt,
	AgentImportTab,
	AgentPatch,
	AgentPatchField,
	AgentUpdateReceipt,
	AutoRunOutcome,
	ClientError,
	ClientErrorCode,
	ClientMethod,
	ClientResult,
	ConnectionState,
	ConsultAnswer,
	ConsultAskInput,
	EventFilter,
	GroupCreateInput,
	HistoryEntryUpdates,
	HistoryListOptions,
	HostInfo,
	MaestroClient,
	MaestroEvent,
	ProviderInfo,
	QueuedTurn,
	QueueExit,
	QueuedTurnEdit,
	SettingsChange,
	TabPatch,
	TranscriptOptions,
	TurnEvent,
	TurnInput,
	TurnSendReceipt,
	Unsubscribe,
	WsMaestroClientOptions,
} from './types';
import {
	normalizeOriginHost,
	normalizeTurnOverrides,
	parseHostCapabilities,
	parseQueuedTurnImages,
	parseQueuedTurnSettings,
	readTurnEntryId,
} from './types';
import { withTurnAgentText } from '../turns/prompt';

const LOG_CONTEXT = '[WsMaestroClient]';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** How long Stop waits for a host to confirm it stopped a consult. An older host never answers. */
const CONSULT_CANCEL_TIMEOUT_MS = 10_000;
/** The host's own consult bounds (`handleCrossAgentAsk` clamps again). */
const DEFAULT_CONSULT_TIMEOUT_MS = 600_000;
const MIN_CONSULT_TIMEOUT_MS = 10_000;
const MAX_CONSULT_TIMEOUT_MS = 3_600_000;
/** Extra wait on the socket so the HOST's timeout, which names the agent that went quiet, is the one that fires. */
const CONSULT_WAIT_GRACE_MS = 15_000;
const DEFAULT_RECONNECT_INITIAL_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 15_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;
const DEFAULT_RECONCILE_INTERVAL_MS = 5_000;
/** Section 8.5: the desktop persists a finished turn on a ~2 s debounce. */
const POST_OUTCOME_REFRESH_MS = 2_500;

/** The longest group chat name. Agent names have their own limit (`MAX_AGENT_NAME_LENGTH`). */
const MAX_CHAT_NAME_LENGTH = 100;

/** The longest queue item id read off a host's `queue_changed` frame (the host's ids are UUIDs). */
const MAX_QUEUE_ITEM_ID_CHARS = 200;

const TOO_OLD_MESSAGE = 'The running Maestro is too old for this request; update the desktop app.';

/** The least time an `import_agent` gets: it carries every transcript the agent has. */
const IMPORT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Reply = Record<string, unknown>;

const ok = <T>(value: T): ClientResult<T> => ({ ok: true, value });

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/** A `queue_changed` frame's `exit`, or undefined when it is not one this client can read. */
function parseQueueExit(raw: unknown): QueueExit | undefined {
	if (!isObject(raw)) return undefined;
	const itemId = asString(raw.itemId);
	if (!itemId || itemId.length > MAX_QUEUE_ITEM_ID_CHARS) return undefined;
	return raw.exit === 'started' || raw.exit === 'removed' ? { itemId, exit: raw.exit } : undefined;
}

/**
 * The waiting messages of one agent, from `list_queue`'s item shape: the desktop bridge's reply
 * and a headless host's `queue_changed` frame (`queuedTurnsToWire`) both carry it.
 */
function parseQueuedTurns(raw: unknown): QueuedTurn[] {
	const items = Array.isArray(raw) ? raw : [];
	return items.filter(isObject).map((item): QueuedTurn => {
		const command = asString(item.command);
		const args = asString(item.commandArgs);
		const turnSettings = parseQueuedTurnSettings(item.turnSettings);
		const images = parseQueuedTurnImages(item.images);
		return {
			itemId: asString(item.id) ?? '',
			tabId: asString(item.tabId) ?? '',
			queuedAt: typeof item.timestamp === 'number' ? item.timestamp : 0,
			kind: item.type === 'command' ? 'command' : 'message',
			text: asString(item.text) ?? (command ? (args ? `${command} ${args}` : command) : ''),
			paused: item.paused === true,
			...(turnSettings ? { turnSettings } : {}),
			...(images ? { images } : {}),
			// The host sent this item's images before: the mirror keeps the ones it holds (M26).
			...(!images && item.imagesKept === true ? { imagesKept: true as const } : {}),
		};
	});
}

/** The most item ids a desktop host's queue changes frame may list (a host caps its queue at 100). */
const MAX_QUEUE_CHANGES_ORDER = 1_000;

/** The most changes of one agent kept while its whole read is out; past it the next one reads again. */
const MAX_QUEUE_CHANGES_WHILE_READING = 100;

/** A desktop host's queue change (`QueueChangesFrame`, M28), read off the wire. */
interface QueueChanges {
	seq: number;
	base: number;
	order: string[];
	changed: QueuedTurn[];
}

/** A `queue_changed` frame's `changes`, or undefined when it is not one this client can read. */
function parseQueueChanges(raw: unknown): QueueChanges | undefined {
	if (!isObject(raw) || !Array.isArray(raw.order) || !Array.isArray(raw.changed)) return undefined;
	const { seq, base } = raw;
	if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(base)) return undefined;
	if ((seq as number) <= (base as number) || (base as number) < 0) return undefined;
	if (raw.order.length > MAX_QUEUE_CHANGES_ORDER) return undefined;
	const order = raw.order.filter(
		(id): id is string =>
			typeof id === 'string' && id.length > 0 && id.length <= MAX_QUEUE_ITEM_ID_CHARS
	);
	if (order.length !== raw.order.length) return undefined;
	return {
		seq: seq as number,
		base: base as number,
		order,
		changed: parseQueuedTurns(raw.changed),
	};
}

/**
 * The list `changes` makes of `held` (the list of the frame it changes): each id in order, from the
 * change when it carries the item, else as held. Undefined when an id is in neither.
 */
function applyQueueChanges(
	held: readonly QueuedTurn[],
	changes: QueueChanges
): QueuedTurn[] | undefined {
	const byId = new Map(held.map((item) => [item.itemId, item]));
	for (const item of changes.changed) byId.set(item.itemId, item);
	const items: QueuedTurn[] = [];
	for (const id of changes.order) {
		const item = byId.get(id);
		if (!item) return undefined;
		items.push(item);
	}
	return items;
}

/**
 * A headless host's `autorun_ended` outcome, or `undefined` for anything else: a status this
 * client does not know is dropped rather than passed on as one it does.
 */
/**
 * An agent input in `create_session`'s spelling (the record's keys), for `create_session` and
 * `import_agent`. `name` is the checked name. Blank env values are dropped: blank means unset.
 */
function agentWireFields(
	input: Omit<AgentCreateInput, 'ssh'> & { ssh?: AgentCreateInput['ssh'] },
	name: string
): Record<string, unknown> {
	const env = input.env ? stripBlankEnvVars(input.env) : undefined;
	const fields: Record<string, unknown> = { name, toolType: input.provider, cwd: input.cwd };
	const optional: Array<[string, unknown]> = [
		['groupId', input.groupId],
		['nudgeMessage', input.nudgeMessage],
		['newSessionMessage', input.newSessionMessage],
		['customPath', input.customPath],
		['customArgs', input.customArgs],
		['customEnvVars', env && Object.keys(env).length > 0 ? env : undefined],
		['customModel', input.model],
		['customEffort', input.effort],
		['customContextWindow', input.contextWindow],
		['sessionSshRemoteConfig', input.ssh],
		['autoRunFolderPath', input.autoRunFolderPath],
	];
	for (const [key, value] of optional) if (value !== undefined && value !== '') fields[key] = value;
	if (input.contextWindow !== undefined) fields.contextWindowSource = 'user-edited';
	return fields;
}

/** An imported tab in the record's spelling, as `import_agent` carries it. */
function importTabWireFields(tab: AgentImportTab): Record<string, unknown> {
	const fields: Record<string, unknown> = { id: tab.id, logs: tab.logs };
	const optional: Array<[string, unknown]> = [
		['name', tab.name],
		['starred', tab.starred],
		['agentSessionId', tab.agentSessionId],
		['createdAt', tab.createdAt],
		['saveToHistory', tab.saveToHistory],
		['showThinking', tab.showThinking],
		['readOnlyMode', tab.readOnlyMode],
		['customModel', tab.model],
		['customEffort', tab.effort],
		['usageStats', tab.usageStats],
	];
	for (const [key, value] of optional) if (value !== undefined) fields[key] = value;
	return fields;
}

function parseAutoRunOutcome(value: unknown): AutoRunOutcome | undefined {
	if (!isObject(value)) return undefined;
	const reason = asString(value.reason) ?? '';
	switch (value.status) {
		case 'completed':
		case 'stopped':
			return { status: value.status };
		case 'failed':
		case 'error':
			return { status: value.status, reason };
		default:
			return undefined;
	}
}

/** A timer that does not keep the process alive. */
function unref<T>(timer: T): T {
	(timer as { unref?: () => void } | undefined)?.unref?.();
	return timer;
}

interface TurnState {
	running: boolean;
	startedAt: number;
	answer: string;
	lastError: AgentError | undefined;
	interruptRequested: boolean;
}

type HandshakeResult = { ok: true; frame: Reply } | { ok: false; code?: number; reason?: string };

interface Attempt {
	conn?: BridgeConnection;
	/** Frames that arrived before the attempt finished, applied in order once it does. */
	pending: Reply[];
	settleHandshake: (result: HandshakeResult) => void;
	handshake: Promise<HandshakeResult>;
	handshakeSettled: boolean;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

class WsMaestroClient implements MaestroClient {
	private readonly requestTimeoutMs: number;
	private readonly reconnectInitialMs: number;
	private readonly reconnectMaxMs: number;
	/** The reconnect attempt dialing right now, so a second one joins it. */
	private reconnectInFlight:
		| Promise<ClientResult<{ host: HostInfo; resumed: boolean }>>
		| undefined;
	private readonly heartbeatIntervalMs: number;
	private readonly heartbeatTimeoutMs: number;
	private readonly reconcileIntervalMs: number;
	private readonly now: () => number;

	private readonly mirror: ClientMirror;
	private readonly bus = createEventBus(LOG_CONTEXT);
	private readonly turnStates = new Map<string, TurnState>();
	/** Group chats this client has read or heard about: each gets a `gap` when a connection could not resume. */
	private readonly knownGroupChats = new Set<string>();

	private state: ConnectionState = 'idle';
	private hostInfo: HostInfo | undefined;
	/**
	 * Whether the attached host puts a turn's agent-only text into its prompt (`host_capabilities`),
	 * asked once per connection: a reconnect may reach an upgraded host.
	 */
	private agentTextSupport: Promise<ClientResult<boolean>> | undefined;
	/**
	 * Per agent, its desktop host queue as this client last resolved it, and the `seq` of the
	 * changes frame (or the queue read's `queueSeq`) that list is at (M28). Dropped with the socket.
	 */
	private readonly heldQueues = new Map<string, { seq: number; items: QueuedTurn[] }>();
	/**
	 * Agents whose changes wait for a whole read, with the changes that came while it was out, in
	 * order: they are applied over its answer, so the list emitted last is at the newest change
	 * received (CodeRabbit on #2162). Bounded: past it the chain breaks and the next change reads
	 * the queue again.
	 */
	private readonly queueGapReads = new Map<
		string,
		Array<{ changes: QueueChanges; named: { namesExits?: true; exit?: QueueExit } }>
	>();
	private conn: BridgeConnection | undefined;
	private attempt: Attempt | undefined;
	private connecting: Promise<ClientResult<HostInfo>> | undefined;
	private secrets: string[] = [];

	private epoch: string | undefined;
	private lastSeq = 0;
	private lastWebSettings: Record<string, unknown> | undefined;

	private closedByCaller = false;
	private reconnectAttempt = 0;
	private unauthorizedStreak = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private silenceTimer: ReturnType<typeof setTimeout> | undefined;
	private reconcileTimer: ReturnType<typeof setInterval> | undefined;
	private reconciling = false;
	private refreshing: Promise<void> | undefined;
	private refreshQueued = false;
	private readonly refreshTimers = new Set<ReturnType<typeof setTimeout>>();

	constructor(private readonly options: WsMaestroClientOptions) {
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.reconnectInitialMs = options.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_MS;
		this.reconnectMaxMs = options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_MS;
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
		this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
		this.reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
		this.now = options.now ?? Date.now;
		this.mirror = new ClientMirror(this.now);
	}

	// =======================================================================
	// Interface surface
	// =======================================================================

	readonly connection = {
		discover: async (): Promise<ClientResult<HostInfo>> => {
			const found = await this.discoverHost('connection.discover');
			return found.ok ? ok(found.value.host) : found;
		},
		connect: (): Promise<ClientResult<HostInfo>> => this.connectPublic(),
		reconnect: (): Promise<ClientResult<HostInfo>> => this.reconnectPublic(),
		close: async (): Promise<void> => this.closePublic(),
		state: (): ConnectionState => this.state,
		host: (): HostInfo | undefined => (this.state === 'connected' ? this.hostInfo : undefined),
	};

	readonly agents = {
		list: async (): Promise<ClientResult<AgentRecord[]>> => {
			const gate = this.requireConnected('agents.list');
			return gate ?? ok(this.mirror.listAgents());
		},
		get: (agentId: string) => this.agentsGet(agentId),
		create: (input: AgentCreateInput) => this.agentsCreate(input),
		import: (input: AgentImportInput) => this.agentsImport(input),
		update: (agentId: string, patch: AgentPatch) => this.agentsUpdate(agentId, patch),
		rename: (agentId: string, name: string) => this.agentsRename(agentId, name),
		remove: (agentId: string) => this.agentsRemove(agentId),
	};

	readonly groups = {
		list: async (): Promise<ClientResult<GroupRecord[]>> => {
			const gate = this.requireConnected('groups.list');
			return gate ?? ok(this.mirror.listGroups());
		},
		create: (input: GroupCreateInput) => this.groupsCreate(input),
		rename: (groupId: string, name: string) => this.groupsRename(groupId, name),
		remove: (groupId: string) => this.groupsRemove(groupId),
		moveAgent: (agentId: string, groupId: string | null) => this.groupsMoveAgent(agentId, groupId),
	};

	readonly tabs = {
		list: async (agentId: string): Promise<ClientResult<AITabRecord[]>> => {
			const gate = this.requireConnected('tabs.list');
			if (gate) return gate;
			const tabs = this.mirror.visibleTabs(agentId);
			return tabs ? ok(tabs) : this.fail('tabs.list', 'not-found', `No agent ${agentId}`);
		},
		create: (agentId: string) => this.tabsCreate(agentId),
		rename: (agentId: string, tabId: string, name: string) => this.tabsRename(agentId, tabId, name),
		close: (agentId: string, tabId: string) => this.tabsClose(agentId, tabId),
		closed: (agentId: string) => this.tabsClosed(agentId),
		reopen: (agentId: string, target: { index?: number; tabId?: string }) =>
			this.tabsReopen(agentId, target),
		star: (agentId: string, tabId: string, starred: boolean) =>
			this.tabsStar(agentId, tabId, starred),
		update: (agentId: string, tabId: string, patch: TabPatch) =>
			this.tabsUpdate(agentId, tabId, patch),
		transcript: (agentId: string, tabId: string, options?: TranscriptOptions) =>
			this.tabsTranscript(agentId, tabId, options),
	};

	readonly turns = {
		send: (agentId: string, tabId: string, input: TurnInput) =>
			this.turnsSend(agentId, tabId, input),
		interrupt: (agentId: string, tabId: string) => this.turnsInterrupt(agentId, tabId),
		queue: {
			list: (agentId: string) => this.queueList(agentId),
			remove: (agentId: string, itemId: string) => this.queueRemove(agentId, itemId),
			setPaused: (agentId: string, itemId: string, paused: boolean) =>
				this.queueSetPaused(agentId, itemId, paused),
			merge: (agentId: string, itemId: string) => this.queueMerge(agentId, itemId),
			steer: (agentId: string, itemId: string) => this.queueSteer(agentId, itemId),
			edit: (agentId: string, itemId: string, edit: QueuedTurnEdit) =>
				this.queueEdit(agentId, itemId, edit),
			move: (agentId: string, itemId: string, toIndex: number, tabId?: string) =>
				this.queueMove(agentId, itemId, toIndex, tabId),
			sendNow: (agentId: string, itemId: string) => this.queueSendNow(agentId, itemId),
		},
		subscribe: (
			agentId: string,
			tabId: string,
			listener: (event: TurnEvent) => void
		): Unsubscribe =>
			this.subscribe(
				(event) => {
					if (event.type === 'turn' && event.tabId === tabId) listener(event.event);
				},
				{ types: ['turn'], agentId }
			),
	};

	readonly autoRun = {
		launch: (agentId: string, input: AutoRunLaunchInput) => this.autoRunLaunch(agentId, input),
		launchGoal: (agentId: string, input: GoalRunLaunchInput) =>
			this.autoRunLaunchGoal(agentId, input),
		stop: (agentId: string) =>
			this.autoRunControl('autoRun.stop', agentId, 'stop_auto_run', 'stop_auto_run_result'),
		resume: (agentId: string) =>
			this.autoRunControl(
				'autoRun.resume',
				agentId,
				'resume_auto_run_error',
				'resume_auto_run_error_result'
			),
		skip: (agentId: string) =>
			this.autoRunControl(
				'autoRun.skip',
				agentId,
				'skip_auto_run_document',
				'skip_auto_run_document_result'
			),
		abort: (agentId: string) =>
			this.autoRunControl(
				'autoRun.abort',
				agentId,
				'abort_auto_run_error',
				'abort_auto_run_error_result'
			),
		steer: (agentId: string, input: SteeringCommandInput) => this.autoRunSteer(agentId, input),
	};

	readonly groupChats = {
		list: () => this.groupChatsList(),
		get: (chatId: string) => this.groupChatsGet(chatId),
		create: (input: GroupChatCreateInput) => this.groupChatsCreate(input),
		send: (chatId: string, message: string) => this.groupChatsSend(chatId, message),
		stop: (chatId: string) => this.groupChatsStop(chatId),
		rename: (chatId: string, name: string) => this.groupChatsRename(chatId, name),
		remove: (chatId: string) => this.groupChatsRemove(chatId),
	};

	readonly consults = {
		ask: (input: ConsultAskInput) => this.consultsAsk(input),
		cancel: (input: { askerKey: string }) => this.consultsCancel(input),
	};

	readonly history = {
		list: (agentId: string, options?: HistoryListOptions) => this.historyList(agentId, options),
		remove: (agentId: string, entryId: string) => this.historyRemove(agentId, entryId),
		update: (agentId: string, entryId: string, updates: HistoryEntryUpdates) =>
			this.historyUpdate(agentId, entryId, updates),
	};

	readonly usage = {
		projectTokens: (
			projects: readonly ProjectTokenUsageProject[],
			options?: { timeoutMs?: number }
		) => this.usageProjectTokens(projects, options),
	};

	readonly settings = {
		get: (keys: readonly string[]) => this.settingsGet(keys),
		subscribe: (
			keys: readonly string[],
			listener: (change: SettingsChange) => void
		): Unsubscribe => {
			const wanted = new Set(keys);
			return this.subscribe(
				(event) => {
					if (event.type !== 'settings.changed') return;
					if (event.keys === 'unknown' || event.keys.some((key) => wanted.has(key))) {
						listener({ keys: event.keys });
					}
				},
				{ types: ['settings.changed'] }
			);
		},
		sshRemotes: () => this.settingsSshRemotes(),
	};

	readonly providers = {
		list: (options?: { sshRemoteId?: string }) => this.providersList(options),
		models: (providerId: string, options?: { sshRemoteId?: string; refresh?: boolean }) =>
			this.providersModels(providerId, options),
	};

	readonly events = {
		subscribe: (listener: (event: MaestroEvent) => void, filter?: EventFilter): Unsubscribe =>
			this.subscribe(listener, filter),
	};

	// =======================================================================
	// Events
	// =======================================================================

	private subscribe(listener: (event: MaestroEvent) => void, filter?: EventFilter): Unsubscribe {
		return this.bus.subscribe(listener, filter);
	}

	private emit(event: MaestroEvent): void {
		this.bus.emit(event);
	}

	private emitAll(events: MaestroEvent[]): void {
		this.bus.emitAll(events);
	}

	private emitTurn(agentId: string, tabId: string, event: TurnEvent): void {
		this.emit({ type: 'turn', agentId, tabId, event });
	}

	// =======================================================================
	// Errors and calls
	// =======================================================================

	private redact(text: string): string {
		let out = text;
		for (const secret of this.secrets) {
			if (secret) out = out.split(secret).join('***');
		}
		return out;
	}

	private fail<T = never>(
		method: ClientMethod,
		code: ClientErrorCode,
		message: string,
		extra: Partial<ClientError> = {}
	): ClientResult<T> {
		return { ok: false, error: { code, message: this.redact(message), method, ...extra } };
	}

	private requireConnected(method: ClientMethod): ClientResult<never> | undefined {
		if (this.state === 'connected' && this.conn) return undefined;
		return this.fail(method, 'host-unavailable', 'Not connected to a Maestro desktop.');
	}

	/** Map a thrown transport error to a typed failure. */
	private mapThrown<T>(method: ClientMethod, error: unknown): ClientResult<T> {
		if (error instanceof CommandTimeoutError) {
			return this.fail(method, 'timeout', 'The Maestro desktop did not answer in time.');
		}
		if (error instanceof UnsupportedCommandError) {
			return this.fail(method, 'unsupported', TOO_OLD_MESSAGE);
		}
		if (error instanceof ConnectionClosedError) {
			return error.closedByCaller
				? this.fail(method, 'host-unavailable', 'The client was closed.')
				: this.fail(method, 'host-lost', 'The connection to the Maestro desktop dropped.');
		}
		return this.fail(method, 'failed', error instanceof Error ? error.message : String(error));
	}

	/** Send one typed message on `conn` and wait for its reply. */
	private async sendOn<T = Reply>(
		conn: BridgeConnection,
		method: ClientMethod,
		message: Record<string, unknown>,
		replyType: string,
		options: { matchByType?: boolean; timeoutMs?: number } = {}
	): Promise<ClientResult<T>> {
		try {
			const { timeoutMs, ...commandOptions } = options;
			const reply = await conn.sendCommand<T>(
				message,
				replyType,
				timeoutMs ?? this.requestTimeoutMs,
				commandOptions
			);
			return ok(reply);
		} catch (error) {
			return this.mapThrown(method, error);
		}
	}

	/** `bridge.invoke` on `conn`: the IPC handler's result, or a typed failure. */
	private async invokeOn<T = unknown>(
		conn: BridgeConnection,
		method: ClientMethod,
		channel: string,
		args: unknown[] = []
	): Promise<ClientResult<T>> {
		const sent = await this.sendOn<Reply>(
			conn,
			method,
			{ type: 'bridge.invoke', channel, args },
			'bridge.response'
		);
		if (!sent.ok) return sent;
		const reply = sent.value;
		if (reply.ok === true) return ok(reply.result as T);
		const text = asString(reply.error) ?? `The desktop refused ${channel}`;
		if (isUnsupportedInvokeError(text)) return this.fail(method, 'unsupported', TOO_OLD_MESSAGE);
		return this.fail(method, classifyFailure(text), text);
	}

	private send<T = Reply>(
		method: ClientMethod,
		message: Record<string, unknown>,
		replyType: string,
		options: { matchByType?: boolean; timeoutMs?: number } = {}
	): Promise<ClientResult<T>> {
		const gate = this.requireConnected(method);
		if (gate || !this.conn) {
			return Promise.resolve(
				gate ?? this.fail(method, 'host-unavailable', 'Not connected to a Maestro desktop.')
			);
		}
		return this.sendOn<T>(this.conn, method, message, replyType, options);
	}

	private invoke<T = unknown>(
		method: ClientMethod,
		channel: string,
		args: unknown[] = []
	): Promise<ClientResult<T>> {
		const gate = this.requireConnected(method);
		if (gate || !this.conn) {
			return Promise.resolve(
				gate ?? this.fail(method, 'host-unavailable', 'Not connected to a Maestro desktop.')
			);
		}
		return this.invokeOn<T>(this.conn, method, channel, args);
	}

	/**
	 * A `*_result` reply to `success`, or the failure it reports. `stateRefusal`
	 * marks the replies whose failure is a refusal on state (section 9).
	 */
	private checkResult(
		method: ClientMethod,
		reply: Reply,
		options: { stateRefusal?: boolean } = {}
	): ClientResult<Reply> {
		if (reply.success === true) return ok(reply);
		const text = asString(reply.error);
		const code = classifyFailure(text, {
			reason: asString(reply.reason),
			stateRefusal: options.stateRefusal,
		});
		return this.fail(method, code, text ?? `The desktop refused ${method}.`);
	}

	// =======================================================================
	// Connection
	// =======================================================================

	/**
	 * Find the host to dial: the explicit endpoint when the caller gave one, else the local
	 * `cli-server.json`. Every attempt asks again, since a host's port and secret change per boot.
	 */
	private async discoverHost(
		method: ClientMethod
	): Promise<ClientResult<{ endpoint: ExplicitHostEndpoint | undefined; host: HostInfo }>> {
		if (this.options.endpoint !== undefined) return this.resolveExplicitEndpoint(method);
		const info = readCliServerInfoFrom(this.options.userDataDir);
		if (!info) {
			return this.fail(
				method,
				'host-unavailable',
				'No running Maestro desktop was found (cli-server.json is missing or unreadable).'
			);
		}
		this.secrets = [info.token, info.cliSecret ?? ''];
		if (!isPidAlive(info.pid)) {
			return this.fail(
				method,
				'host-unavailable',
				`The Maestro desktop (pid ${info.pid}) is not running.`
			);
		}
		const kind = info.hostKind === 'headless' ? 'headless' : 'desktop';
		return ok({
			endpoint: undefined,
			host: {
				kind,
				pid: info.pid,
				...(info.version ? { version: info.version } : {}),
				startedAt: info.startedAt,
				label: `${kind} pid ${info.pid}`,
			},
		});
	}

	/**
	 * The explicit endpoint, resolved and checked. Its pid is a label only: it can belong to
	 * another machine, so liveness is the socket answering, not a pid probe.
	 */
	private async resolveExplicitEndpoint(
		method: ClientMethod
	): Promise<ClientResult<{ endpoint: ExplicitHostEndpoint; host: HostInfo }>> {
		const source = this.options.endpoint;
		let endpoint: ExplicitHostEndpoint;
		try {
			endpoint = typeof source === 'function' ? await source() : source!;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return this.fail(method, 'host-unavailable', `The host endpoint is not available: ${reason}`);
		}
		this.secrets = [endpoint?.token ?? '', endpoint?.cliSecret ?? ''];
		if (!endpoint || !isDialableEndpoint(endpoint)) {
			return this.fail(
				method,
				'invalid',
				'The host endpoint is not valid: expected a TCP port and a URL-safe path token.'
			);
		}
		const kind = endpoint.hostKind === 'headless' ? 'headless' : 'desktop';
		return ok({
			endpoint,
			host: {
				kind,
				...(endpoint.pid !== undefined ? { pid: endpoint.pid } : {}),
				...(endpoint.version ? { version: endpoint.version } : {}),
				label:
					endpoint.pid !== undefined
						? `${kind} pid ${endpoint.pid}`
						: `${kind} 127.0.0.1:${endpoint.port}`,
			},
		});
	}

	private connectPublic(): Promise<ClientResult<HostInfo>> {
		if (this.state === 'connected' && this.hostInfo) return Promise.resolve(ok(this.hostInfo));
		if (this.connecting) return this.connecting;
		if (this.state === 'reconnecting' || this.state === 'waiting-for-host') {
			return this.reconnectPublic();
		}
		this.closedByCaller = false;
		this.state = 'connecting';
		this.connecting = (async () => {
			try {
				const result = await this.establish('connection.connect', false);
				if (!result.ok) {
					this.state = 'idle';
					return result;
				}
				this.reconnectAttempt = 0;
				this.unauthorizedStreak = 0;
				return ok(result.value.host);
			} finally {
				this.connecting = undefined;
			}
		})();
		return this.connecting;
	}

	private async reconnectPublic(): Promise<ClientResult<HostInfo>> {
		if (this.state === 'connected' && this.hostInfo) return ok(this.hostInfo);
		if (this.state === 'idle') return this.connectPublic();
		this.clearReconnectTimer();
		const result = await this.tryReconnect('connection.reconnect');
		return result.ok ? ok(result.value.host) : result;
	}

	private async closePublic(): Promise<void> {
		this.closedByCaller = true;
		this.clearReconnectTimer();
		this.stopTimers();
		for (const timer of this.refreshTimers) clearTimeout(timer);
		this.refreshTimers.clear();
		this.attempt?.settleHandshake({ ok: false, reason: 'closed' });
		this.attempt?.conn?.disconnect();
		this.attempt = undefined;
		this.conn?.disconnect();
		this.conn = undefined;
		this.hostInfo = undefined;
		this.state = 'idle';
	}

	/**
	 * One connection attempt: discovery, socket, handshake, and (unless the host
	 * resumed us) the snapshot reads that double as the version probe (C1).
	 * On success the client is `connected` and the events have been emitted.
	 */
	private async establish(
		method: 'connection.connect' | 'connection.reconnect',
		resume: boolean
	): Promise<ClientResult<{ host: HostInfo; resumed: boolean }>> {
		const found = await this.discoverHost(method);
		if (!found.ok) return found;
		const { host, endpoint } = found.value;

		let settle!: Attempt['settleHandshake'];
		const handshake = new Promise<HandshakeResult>((resolve) => {
			settle = resolve;
		});
		const attempt: Attempt = {
			pending: [],
			handshakeSettled: false,
			handshake,
			settleHandshake: (result) => {
				if (attempt.handshakeSettled) return;
				attempt.handshakeSettled = true;
				settle(result);
			},
		};
		// This client reads a desktop host's queue changes (M28); resume says where it left off.
		const query = {
			[QUEUE_CHANGES_QUERY_PARAM]: 1,
			...(resume && this.epoch ? { since: this.lastSeq, epoch: this.epoch } : {}),
		};
		const conn = new BridgeConnection({
			...(endpoint ? { endpoint } : { userDataDir: this.options.userDataDir }),
			strictReplies: true,
			query,
			WebSocketImpl: this.options.WebSocketImpl,
			onFrame: (frame) => this.onFrame(attempt, conn, frame),
			onClose: (code, reason) => this.onSocketClose(attempt, conn, code, reason),
		});
		attempt.conn = conn;
		this.attempt = attempt;

		const abandon = (): void => {
			conn.disconnect();
			if (this.attempt === attempt) this.attempt = undefined;
		};

		try {
			await conn.connect();
		} catch (error) {
			abandon();
			const message = error instanceof Error ? error.message : String(error);
			return this.fail(
				method,
				/timed out/i.test(message) ? 'timeout' : 'host-unavailable',
				message
			);
		}

		const handshakeTimer = unref(
			setTimeout(
				() => attempt.settleHandshake({ ok: false, reason: 'handshake timed out' }),
				this.requestTimeoutMs
			)
		);
		const connected = await attempt.handshake;
		clearTimeout(handshakeTimer);
		if (!connected.ok) {
			abandon();
			if (this.closedByCaller)
				return this.fail(method, 'host-unavailable', 'The client was closed.');
			if (connected.code === WEB_LOGIN_WS_CLOSE_CODE) {
				return this.fail(
					method,
					'unauthorized',
					'The Maestro desktop refused this client (Web Login is on and the secret was not accepted).'
				);
			}
			return this.fail(
				method,
				connected.reason === 'handshake timed out' ? 'timeout' : 'host-lost',
				connected.reason ?? 'The connection closed before the desktop answered.'
			);
		}

		const frame = connected.frame;
		const resumed = resume && frame.resumed === true;
		if (!resumed) {
			this.epoch = asString(frame.bridgeEpoch);
			if (typeof frame.bridgeSeq === 'number') this.lastSeq = frame.bridgeSeq;
		}

		let snapshot: { agents: AgentRecord[]; groups: GroupRecord[] } | undefined;
		if (!resumed) {
			const read = await this.readSnapshot(conn, method);
			if (!read.ok) {
				abandon();
				return read;
			}
			snapshot = read.value;
		}

		// Commit. From here the client is attached.
		const wasReconnect = resume;
		this.conn = conn;
		this.attempt = undefined;
		this.hostInfo = host;
		this.agentTextSupport = undefined;
		this.state = 'connected';
		if (snapshot) this.mirror.replace(snapshot.agents, snapshot.groups);
		this.startTimers();

		this.emit({ type: 'host.connected', host, resumed });
		if (snapshot) {
			this.emit({
				type: 'snapshot',
				agents: this.mirror.listAgents(),
				groups: this.mirror.listGroups(),
			});
			if (wasReconnect) this.emitGapForRunningTurns();
			else this.turnStates.clear();
			this.emitGapForGroupChats();
		}
		for (const queued of attempt.pending) this.handleFrame(queued);
		attempt.pending = [];
		return ok({ host, resumed });
	}

	private async readSnapshot(
		conn: BridgeConnection,
		method: ClientMethod
	): Promise<ClientResult<{ agents: AgentRecord[]; groups: GroupRecord[] }>> {
		const [boot, groups] = await Promise.all([
			this.invokeOn<unknown>(conn, method, 'sessions:getBootstrap'),
			this.invokeOn<unknown>(conn, method, 'groups:getAll'),
		]);
		if (!boot.ok) return boot;
		if (!groups.ok) return groups;
		return ok({
			agents: agentsOf({ sessions: Array.isArray(boot.value) ? boot.value : [] }),
			groups: groupsOf({ groups: Array.isArray(groups.value) ? groups.value : [] }),
		});
	}

	private emitGapForRunningTurns(): void {
		for (const [key, turn] of this.turnStates) {
			if (!turn.running) continue;
			const [agentId, tabId] = key.split('\u0000');
			this.emitTurn(agentId, tabId, { kind: 'gap', at: this.now() });
		}
		this.turnStates.clear();
	}

	/** A fresh snapshot means pushes were missed: every chat held must be read again. */
	private emitGapForGroupChats(): void {
		for (const chatId of this.knownGroupChats) {
			this.emit({ type: 'groupChat', chatId, event: { kind: 'gap', at: this.now() } });
		}
	}

	// -- frames --------------------------------------------------------------

	private onFrame(attempt: Attempt, conn: BridgeConnection, frame: Reply): void {
		if (typeof frame.seq === 'number' && frame.seq > this.lastSeq) this.lastSeq = frame.seq;
		if (frame.type === 'connected' && attempt.conn === conn && !attempt.handshakeSettled) {
			attempt.settleHandshake({ ok: true, frame });
			return;
		}
		if (this.attempt === attempt) {
			attempt.pending.push(frame);
			return;
		}
		if (this.conn !== conn) return;
		this.silenceCleared();
		this.handleFrame(frame);
	}

	private onSocketClose(
		attempt: Attempt,
		conn: BridgeConnection,
		code: number | undefined,
		reason: string | undefined
	): void {
		if (this.attempt === attempt && attempt.conn === conn) {
			attempt.settleHandshake({ ok: false, code, reason });
			return;
		}
		if (this.conn !== conn) return;
		// A list held from this socket's frames: the next socket's frames may not change it.
		this.heldQueues.clear();
		this.queueGapReads.clear();
		this.handleDrop(
			code === WEB_LOGIN_WS_CLOSE_CODE
				? 'The Maestro desktop closed the connection (login required).'
				: `The connection to the Maestro desktop closed${code ? ` (code ${code})` : ''}.`
		);
	}

	private handleFrame(frame: Reply): void {
		switch (frame.type) {
			case 'bridge.event':
				this.handleBridgeEvent(
					asString(frame.channel) ?? '',
					Array.isArray(frame.args) ? frame.args : []
				);
				break;
			case 'session_added': {
				const session = isObject(frame.session) ? frame.session : undefined;
				const id = asString(session?.id);
				if (id && !this.mirror.getAgent(id)) void this.refreshAgents();
				break;
			}
			case 'session_removed': {
				const id = asString(frame.sessionId);
				if (id) this.emitAll(this.mirror.remove(id));
				break;
			}
			case 'session_state_change': {
				const sessionId = asString(frame.sessionId);
				if (!sessionId) break;
				this.emitAll(
					this.mirror.mergeStateChange({
						sessionId,
						state: asString(frame.state),
						name: asString(frame.name),
						toolType: asString(frame.toolType),
						inputMode: asString(frame.inputMode),
						cwd: asString(frame.cwd),
					})
				);
				break;
			}
			case 'tabs_changed': {
				const sessionId = asString(frame.sessionId);
				if (!sessionId || !Array.isArray(frame.aiTabs)) break;
				const merged = this.mirror.mergeTabs(
					sessionId,
					frame.aiTabs as ProjectedTab[],
					asString(frame.activeTabId)
				);
				this.emitAll(merged.events);
				if (merged.unknownTab) void this.refreshAgents();
				break;
			}
			case 'autorun_state': {
				const agentId = asString(frame.sessionId);
				if (!agentId) break;
				this.emit({
					type: 'autorun',
					agentId,
					event: {
						kind: 'state',
						at: this.now(),
						state: parseAutoRunProgress(frame.state),
						frame: parseAutoRunBroadcastState(frame.state),
					},
				});
				break;
			}
			case 'queue_changed': {
				// A host's queue change: a headless host's, and a desktop's (`broadcastDesktopQueueChanges()`).
				const agentId = asString(frame.sessionId);
				if (!agentId) break;
				// How an item left, from a host that names it (an older one sends neither field).
				const exit = parseQueueExit(frame.exit);
				const named = {
					...(frame.namesExits === true ? { namesExits: true as const } : {}),
					...(exit ? { exit } : {}),
				};
				// A desktop host's change only, for this client that said it reads changes (M28).
				const changes = parseQueueChanges(frame.changes);
				if (changes) {
					this.onQueueChanges(agentId, changes, named);
					break;
				}
				if (!Array.isArray(frame.items)) break;
				this.emit({
					type: 'queue.changed',
					agentId,
					items: parseQueuedTurns(frame.items),
					...named,
				});
				break;
			}
			case 'autorun_ended': {
				// A headless host's own frame: the desktop sends none (see `AutoRunOutcome`).
				const agentId = asString(frame.sessionId);
				const outcome = parseAutoRunOutcome(frame.outcome);
				if (!agentId || !outcome) break;
				this.emit({ type: 'autorun.ended', agentId, at: this.now(), outcome });
				break;
			}
			case 'settings_changed': {
				const next = isObject(frame.settings) ? frame.settings : undefined;
				if (!next) break;
				const keys = changedWebSettingKeys(this.lastWebSettings, next);
				this.lastWebSettings = next;
				if (keys === null) this.emit({ type: 'settings.changed', keys: 'unknown' });
				else if (keys.length > 0) this.emit({ type: 'settings.changed', keys });
				break;
			}
			case 'theme':
				this.emit({ type: 'settings.changed', keys: [THEME_STORE_KEY] });
				break;
			case 'custom_commands':
				this.emit({ type: 'settings.changed', keys: [CUSTOM_COMMANDS_STORE_KEY] });
				break;
			default:
				// active_session_changed must stay ignored (CO-4), and the rest
				// (session_output, group_chat_*, cue_*, ...) is Phase 4.
				break;
		}
	}

	private handleBridgeEvent(channel: string, args: unknown[]): void {
		switch (channel) {
			case 'sessions:lifecycleSync': {
				const payload = isObject(args[0]) ? args[0] : undefined;
				if (!payload) return;
				// A headless host announces every changed agent in `added`. A desktop host lists the
				// agents that entered its store in `added` and the ones a write changed (an Edit
				// Agent save, a CLI update-agent) in `updated`; both are whole stored records without
				// transcripts, so both fold in the same way, and the mirror's diff drops a no-op.
				// `baselines` is the desktop windows' merge input and means nothing here.
				const records = [
					...(Array.isArray(payload.added) ? (payload.added as unknown[]) : []),
					...(Array.isArray(payload.updated) ? (payload.updated as unknown[]) : []),
				];
				for (const agent of agentsOf({ sessions: records })) {
					this.emitAll(this.mirror.upsert(agent));
				}
				if (Array.isArray(payload.removedIds)) {
					for (const id of payload.removedIds) {
						if (typeof id === 'string') this.emitAll(this.mirror.remove(id));
					}
				}
				return;
			}
			case 'settings:externalChange':
				this.emit({ type: 'settings.changed', keys: 'unknown' });
				return;
			case 'process:user-input': {
				const input = parseUserInputFrame(args);
				if (!input) return;
				const tabId = input.tabId ?? this.mirror.resolveActiveTabId(input.agentId);
				if (!tabId) return;
				this.emitTurn(input.agentId, tabId, {
					kind: 'user',
					at: this.now(),
					entry: input.entry as LogEntryRecord,
				});
				return;
			}
			case TRANSCRIPT_CHANGED_CHANNEL: {
				// A host wrote to an idle tab outside a turn (`/skills`, `/history`): read it again.
				const target = parseTranscriptChangedFrame(args);
				const resolved = target ? this.resolveTarget(target) : undefined;
				if (
					!resolved ||
					this.turnStates.get(this.turnKey(resolved.agentId, resolved.tabId))?.running
				) {
					// A running turn's own end reads the tab again, so its live text is never dropped.
					return;
				}
				this.emitTurn(resolved.agentId, resolved.tabId, { kind: 'gap', at: this.now() });
				return;
			}
			default: {
				if (channel.startsWith('groupChat:')) {
					const parsed = parseGroupChatFrame(channel, args, this.now());
					if (parsed) {
						this.knownGroupChats.add(parsed.chatId);
						this.emit({ type: 'groupChat', chatId: parsed.chatId, event: parsed.event });
					}
					return;
				}
				const batch = parseBatchFrame(channel, args);
				if (batch) {
					this.emit({
						type: 'autorun',
						agentId: batch.agentId,
						event: { ...batch.frame, at: this.now(), processId: batch.processId },
					});
					return;
				}
				const parsed = parseProcessFrame(channel, args);
				if (!parsed) return;
				const resolved = this.resolveTarget(parsed.target);
				if (resolved) this.handleProcessFrame(resolved.agentId, resolved.tabId, parsed.frame);
			}
		}
	}

	private resolveTarget(target: ProcessTarget): { agentId: string; tabId: string } | undefined {
		if (target.kind === 'tab') return { agentId: target.agentId, tabId: target.tabId };
		const tabId = this.mirror.resolveActiveTabId(target.agentId);
		return tabId ? { agentId: target.agentId, tabId } : undefined;
	}

	// -- turns ---------------------------------------------------------------

	private turnKey(agentId: string, tabId: string): string {
		return `${agentId}\u0000${tabId}`;
	}

	private turnState(agentId: string, tabId: string): TurnState {
		const key = this.turnKey(agentId, tabId);
		let state = this.turnStates.get(key);
		if (!state) {
			state = {
				running: false,
				startedAt: 0,
				answer: '',
				lastError: undefined,
				interruptRequested: false,
			};
			this.turnStates.set(key, state);
		}
		return state;
	}

	/** Mark the turn running and say so, once per turn. */
	private beginTurn(agentId: string, tabId: string): TurnState {
		const state = this.turnState(agentId, tabId);
		if (!state.running) {
			state.running = true;
			state.startedAt = this.now();
			state.answer = '';
			state.lastError = undefined;
			this.emitTurn(agentId, tabId, { kind: 'started', at: state.startedAt });
			this.emitAll(this.mirror.patchTab(agentId, tabId, { state: 'busy' }));
		}
		return state;
	}

	private handleProcessFrame(agentId: string, tabId: string, frame: ProcessFrame): void {
		const agent = this.mirror.getAgent(agentId);
		if (!agent?.aiTabs?.some((tab) => tab.id === tabId)) {
			// A turn for a tab the mirror does not hold yet: deliver it, and read the agent.
			void this.refreshAgents();
		}
		const state = this.beginTurn(agentId, tabId);
		const at = this.now();

		if (frame.kind === 'stream') {
			const event = frame.event;
			if (event.kind === 'text') state.answer += event.text;
			if (event.kind === 'error') state.lastError = event.error;
			this.emitTurn(agentId, tabId, { ...event, at } as TurnEvent);
			return;
		}

		const resolved = resolveBridgeOutcome({
			exitCode: frame.exitCode,
			signal: frame.signal,
			interruptRequested: state.interruptRequested,
			lastError: state.lastError,
			answerText: state.answer,
			providerId: agent?.toolType ?? '',
			sessionId: `${agentId}-ai-${tabId}`,
		});
		this.turnStates.delete(this.turnKey(agentId, tabId));
		this.emitTurn(agentId, tabId, {
			kind: 'outcome',
			at,
			outcome: resolved.outcome,
			exitCode: resolved.exitCode,
			...(resolved.error ? { error: resolved.error } : {}),
		});
		this.emitAll(this.mirror.patchTab(agentId, tabId, { state: 'idle' }));
		this.scheduleRefresh();
	}

	/** Section 8.5: re-read the agent once the desktop has persisted the finished turn. */
	private scheduleRefresh(): void {
		const timer = unref(
			setTimeout(() => {
				this.refreshTimers.delete(timer);
				if (this.state === 'connected') void this.refreshAgents();
			}, POST_OUTCOME_REFRESH_MS)
		);
		this.refreshTimers.add(timer);
	}

	// -- timers: heartbeat, silence, reconcile ---------------------------------

	private startTimers(): void {
		this.stopTimers();
		this.heartbeatTimer = unref(setInterval(() => this.heartbeat(), this.heartbeatIntervalMs));
		if (this.reconcileIntervalMs > 0) {
			this.reconcileTimer = unref(
				setInterval(() => void this.reconcile(), this.reconcileIntervalMs)
			);
		}
	}

	private stopTimers(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		if (this.reconcileTimer) clearInterval(this.reconcileTimer);
		this.silenceCleared();
		this.heartbeatTimer = undefined;
		this.reconcileTimer = undefined;
	}

	/** A ping per interval; silence after one means the host is gone. Any frame ends the wait. */
	private heartbeat(): void {
		if (!this.conn || this.state !== 'connected') return;
		this.conn.send({ type: 'ping' });
		if (this.silenceTimer) return;
		this.silenceTimer = unref(
			setTimeout(() => {
				this.silenceTimer = undefined;
				this.handleDrop('The Maestro desktop stopped answering.');
			}, this.heartbeatTimeoutMs)
		);
	}

	private silenceCleared(): void {
		if (this.silenceTimer) clearTimeout(this.silenceTimer);
		this.silenceTimer = undefined;
	}

	/** Section 6.3: cover what the bridge never pushes (G1 to G3). */
	private async reconcile(): Promise<void> {
		if (this.reconciling || this.state !== 'connected' || !this.conn) return;
		this.reconciling = true;
		try {
			const requestedAt = this.now();
			const [sessions, groups] = await Promise.all([
				this.send<Reply>('agents.list', { type: 'get_sessions' }, 'sessions_list', {
					matchByType: true,
				}),
				this.invoke<unknown>('groups.list', 'groups:getAll'),
			]);
			if (this.state !== 'connected') return;
			if (sessions.ok && Array.isArray(sessions.value.sessions)) {
				const result = this.mirror.reconcile(
					sessions.value.sessions as ProjectedAgent[],
					requestedAt
				);
				this.emitAll(result.events);
				if (result.needsRead) await this.refreshAgents();
			}
			if (groups.ok && Array.isArray(groups.value)) {
				this.emitAll(this.mirror.setGroups(groupsOf({ groups: groups.value })));
			}
		} finally {
			this.reconciling = false;
		}
	}

	/** One full read of every agent, single-flight, with one trailing re-run if asked meanwhile. */
	private refreshAgents(): Promise<void> {
		if (this.refreshing) {
			this.refreshQueued = true;
			return this.refreshing;
		}
		this.refreshing = (async () => {
			try {
				do {
					this.refreshQueued = false;
					const boot = await this.invoke<unknown>('agents.get', 'sessions:getBootstrap');
					if (boot.ok && Array.isArray(boot.value)) {
						this.emitAll(this.mirror.syncAgents(agentsOf({ sessions: boot.value })));
					}
				} while (this.refreshQueued && this.state === 'connected');
			} finally {
				this.refreshing = undefined;
			}
		})();
		return this.refreshing;
	}

	private async refreshGroups(): Promise<void> {
		const groups = await this.invoke<unknown>('groups.list', 'groups:getAll');
		if (groups.ok && Array.isArray(groups.value)) {
			this.emitAll(this.mirror.setGroups(groupsOf({ groups: groups.value })));
		}
	}

	// -- drop and reconnect ----------------------------------------------------

	private handleDrop(reason: string): void {
		if (this.closedByCaller || this.state !== 'connected') return;
		this.stopTimers();
		this.conn?.disconnect();
		this.conn = undefined;
		this.hostInfo = undefined;
		this.state = 'reconnecting';
		this.emit({ type: 'host.lost', reason });
		this.scheduleReconnect(false);
	}

	private backoffDelay(attempt: number): number {
		const base = Math.min(this.reconnectMaxMs, this.reconnectInitialMs * 2 ** (attempt - 1));
		const jitter = 1 + (Math.random() * 0.4 - 0.2);
		return Math.min(this.reconnectMaxMs, Math.round(base * jitter));
	}

	private scheduleReconnect(waiting: boolean): void {
		if (this.closedByCaller) return;
		this.clearReconnectTimer();
		const attempt = ++this.reconnectAttempt;
		const delayMs = waiting ? this.reconnectMaxMs : this.backoffDelay(attempt);
		this.emit({ type: 'host.reconnecting', attempt, delayMs });
		this.reconnectTimer = unref(
			setTimeout(() => {
				this.reconnectTimer = undefined;
				void this.tryReconnect('connection.reconnect');
			}, delayMs)
		);
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
	}

	/**
	 * One reconnect attempt at a time: a caller's `reconnect()` while the backoff's own attempt is
	 * dialing joins that attempt instead of opening a second socket beside it.
	 */
	private tryReconnect(
		method: 'connection.reconnect'
	): Promise<ClientResult<{ host: HostInfo; resumed: boolean }>> {
		if (this.reconnectInFlight) return this.reconnectInFlight;
		const attempt = this.tryReconnectOnce(method).finally(() => {
			if (this.reconnectInFlight === attempt) this.reconnectInFlight = undefined;
		});
		this.reconnectInFlight = attempt;
		return attempt;
	}

	private async tryReconnectOnce(
		method: 'connection.reconnect'
	): Promise<ClientResult<{ host: HostInfo; resumed: boolean }>> {
		if (this.closedByCaller) return this.fail(method, 'host-unavailable', 'The client was closed.');
		const result = await this.establish(method, true);
		if (result.ok) {
			this.reconnectAttempt = 0;
			this.unauthorizedStreak = 0;
			return result;
		}
		if (this.closedByCaller) return result;

		switch (result.error.code) {
			case 'unauthorized':
				// The secret rotates every boot, and each attempt re-reads discovery,
				// so one refusal can be a restart. Refused twice running: stop.
				this.unauthorizedStreak += 1;
				if (this.unauthorizedStreak >= 2) {
					this.state = 'idle';
					this.emit({ type: 'host.lost', reason: result.error.message });
					return result;
				}
				this.state = 'reconnecting';
				this.scheduleReconnect(false);
				return result;
			case 'host-unavailable':
				this.state = 'waiting-for-host';
				this.scheduleReconnect(true);
				return result;
			default:
				this.state = 'reconnecting';
				this.scheduleReconnect(false);
				return result;
		}
	}

	// =======================================================================
	// Agents
	// =======================================================================

	private async agentsGet(agentId: string): Promise<ClientResult<AgentRecord>> {
		// The stored records read idle mid-turn (the desktop persists every state as idle), so the
		// bridge's `get_sessions` projection, which reads the live process table (`isAgentBusy()`),
		// is folded over them: a caller asking "is it running a turn?" gets the live answer.
		const requestedAt = this.now();
		const [boot, live] = await Promise.all([
			this.invoke<unknown>('agents.get', 'sessions:getBootstrap'),
			this.send<Reply>('agents.get', { type: 'get_sessions' }, 'sessions_list', {
				matchByType: true,
			}),
		]);
		if (!boot.ok) return boot;
		const all = agentsOf({ sessions: Array.isArray(boot.value) ? boot.value : [] });
		this.emitAll(this.mirror.syncAgents(all));
		if (!all.some((agent) => agent.id === agentId)) {
			return this.fail('agents.get', 'not-found', `No agent ${agentId}`);
		}
		if (live.ok && Array.isArray(live.value.sessions)) {
			// The reconcile poll's own fold (section 6.3), so the mirror reads the same either way.
			this.emitAll(
				this.mirror.reconcile(live.value.sessions as ProjectedAgent[], requestedAt).events
			);
		}
		const found = this.mirror.getAgent(agentId) ?? all.find((agent) => agent.id === agentId);
		return found ? ok(found) : this.fail('agents.get', 'not-found', `No agent ${agentId}`);
	}

	private async agentsCreate(input: AgentCreateInput): Promise<ClientResult<{ agentId: string }>> {
		const inputCheck = checkAgentCreateInput(input);
		if (!inputCheck.ok) return this.fail('agents.create', inputCheck.code, inputCheck.message);

		const message: Record<string, unknown> = {
			type: 'create_session',
			...agentWireFields(input, inputCheck.value.name),
			background: true,
		};
		const sent = await this.send('agents.create', message, 'create_session_result');
		if (!sent.ok) return sent;
		const checked = this.checkResult('agents.create', sent.value);
		if (!checked.ok) return checked;
		const agentId = asString(sent.value.sessionId);
		if (!agentId)
			return this.fail('agents.create', 'failed', 'The desktop did not report the new agent.');
		return ok({ agentId });
	}

	private async agentsImport(input: AgentImportInput): Promise<ClientResult<AgentImportReceipt>> {
		const inputCheck = checkAgentImportInput(input);
		if (!inputCheck.ok) return this.fail('agents.import', inputCheck.code, inputCheck.message);

		const message: Record<string, unknown> = {
			type: 'import_agent',
			agent: agentWireFields(input.agent, inputCheck.value.name),
			tabs: input.tabs.map(importTabWireFields),
			...(input.activeTabId ? { activeTabId: input.activeTabId } : {}),
			...(input.queue && input.queue.length > 0 ? { queue: input.queue } : {}),
			...(input.replacesAgentId ? { replacesAgentId: input.replacesAgentId } : {}),
			...(input.liftedFromAgentId ? { liftedFromAgentId: input.liftedFromAgentId } : {}),
		};
		// A long transcript is a large frame: give it the time a large frame takes.
		const sent = await this.send('agents.import', message, 'import_agent_result', {
			timeoutMs: Math.max(this.requestTimeoutMs, IMPORT_TIMEOUT_MS),
		});
		if (!sent.ok) return sent;
		const checked = this.checkResult('agents.import', sent.value);
		if (!checked.ok) return checked;
		const agentId = asString(sent.value.sessionId);
		if (!agentId) {
			return this.fail('agents.import', 'failed', 'The host did not report the imported agent.');
		}
		const notices = Array.isArray(sent.value.notices)
			? sent.value.notices.filter((notice): notice is string => typeof notice === 'string')
			: [];
		return ok({
			agentId,
			queued: typeof sent.value.queued === 'number' ? sent.value.queued : 0,
			...(notices.length > 0 ? { notices } : {}),
		});
	}

	private async agentsRename(agentId: string, name: string): Promise<ClientResult<void>> {
		const trimmed = name?.trim();
		if (!trimmed) return this.fail('agents.rename', 'invalid', 'The name cannot be empty.');
		if (trimmed.length > MAX_AGENT_NAME_LENGTH) {
			return this.fail(
				'agents.rename',
				'invalid',
				`The name must be ${MAX_AGENT_NAME_LENGTH} characters or fewer.`
			);
		}
		const sent = await this.send(
			'agents.rename',
			{ type: 'rename_session', sessionId: agentId, newName: trimmed },
			'rename_session_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult('agents.rename', sent.value);
		if (!checked.ok) return checked;
		this.emitAll(this.mirror.patchAgent(agentId, { name: trimmed }));
		return ok(undefined);
	}

	private async agentsRemove(agentId: string): Promise<ClientResult<void>> {
		const gate = this.requireConnected('agents.remove');
		if (gate) return gate;
		// Gap G6: the host's delete kills only the legacy process ids, so a busy
		// tab's process would outlive its agent. Stop those first.
		const agent = this.mirror.getAgent(agentId);
		for (const tab of agent?.aiTabs ?? []) {
			if (tab.state === 'busy') {
				await this.invoke('agents.remove', 'process:kill', [`${agentId}-ai-${tab.id}`]);
			}
		}
		const sent = await this.send(
			'agents.remove',
			{ type: 'delete_session', sessionId: agentId },
			'delete_session_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult('agents.remove', sent.value);
		return checked.ok ? ok(undefined) : checked;
	}

	private async agentsUpdate(
		agentId: string,
		patch: AgentPatch
	): Promise<ClientResult<AgentUpdateReceipt>> {
		const method: ClientMethod = 'agents.update';
		const gate = this.requireConnected(method);
		if (gate) return gate;

		if (
			patch.provider !== undefined &&
			(patch.provider === 'terminal' || !isValidAgentId(patch.provider))
		) {
			return this.fail(method, 'invalid', `Unknown provider "${patch.provider}".`);
		}
		if (patch.name !== undefined) {
			const trimmed = patch.name.trim();
			if (!trimmed) return this.fail(method, 'invalid', 'The name cannot be empty.');
			if (trimmed.length > MAX_AGENT_NAME_LENGTH) {
				return this.fail(
					method,
					'invalid',
					`The name must be ${MAX_AGENT_NAME_LENGTH} characters or fewer.`
				);
			}
		}
		if (patch.cwd !== undefined && !patch.cwd.trim()) {
			return this.fail(method, 'invalid', 'The working directory cannot be empty.');
		}
		if (patch.autoRunFolderPath !== undefined && !patch.autoRunFolderPath.trim()) {
			return this.fail(method, 'invalid', 'The Auto Run folder cannot be empty.');
		}

		const applied: AgentPatchField[] = [];
		const stop = (failure: {
			ok: false;
			error: ClientError;
		}): ClientResult<AgentUpdateReceipt> => ({
			ok: false,
			error: { ...failure.error, ...(applied.length > 0 ? { appliedFields: [...applied] } : {}) },
		});

		// cwd first: the field the host refuses most (a live process, an
		// unvalidated SSH path), so a refusal stops the update before any change.
		if (patch.cwd !== undefined) {
			const sent = await this.send(
				method,
				{ type: 'update_session_cwd', sessionId: agentId, newCwd: patch.cwd },
				'update_session_cwd_result'
			);
			if (!sent.ok) return stop(sent);
			const checked = this.checkResult(method, sent.value, { stateRefusal: true });
			if (!checked.ok) return stop(checked);
			applied.push('cwd');
		}

		if (patch.ssh !== undefined) {
			const sent = await this.send(
				method,
				{ type: 'update_session_ssh', sessionId: agentId, sshPatch: patch.ssh },
				'update_session_ssh_result'
			);
			if (!sent.ok) return stop(sent);
			const checked = this.checkResult(method, sent.value, { stateRefusal: true });
			if (!checked.ok) return stop(checked);
			applied.push('ssh');
		}

		// The host swaps on a `toolType` key alone and ignores the rest of that
		// patch, so the swap is its own message, sent before the config fields: a
		// model or path in the same update then lands on the new provider's slot.
		// Naming the provider the agent is already on sends nothing (the host
		// would read it as an empty config patch).
		let notices: string[] | undefined;
		if (
			patch.provider !== undefined &&
			patch.provider !== this.mirror.getAgent(agentId)?.toolType
		) {
			const sent = await this.send(
				method,
				{
					type: 'update_session_config',
					sessionId: agentId,
					configPatch: { toolType: patch.provider },
				},
				'update_session_config_result'
			);
			if (!sent.ok) return stop(sent);
			const checked = this.checkResult(method, sent.value);
			if (!checked.ok) return stop(checked);
			applied.push('provider');
			const reported = sent.value.notices;
			if (Array.isArray(reported)) {
				const lines = reported.filter((line): line is string => typeof line === 'string');
				if (lines.length > 0) notices = lines;
			}
		}

		const config = buildAgentConfigPatch(patch);
		if (config.fields.length > 0) {
			const sent = await this.send(
				method,
				{ type: 'update_session_config', sessionId: agentId, configPatch: config.patch },
				'update_session_config_result'
			);
			if (!sent.ok) return stop(sent);
			const checked = this.checkResult(method, sent.value);
			if (!checked.ok) return stop(checked);
			applied.push(...config.fields);
		}

		if (patch.name !== undefined) {
			const sent = await this.send(
				method,
				{ type: 'rename_session', sessionId: agentId, newName: patch.name.trim() },
				'rename_session_result'
			);
			if (!sent.ok) return stop(sent);
			const checked = this.checkResult(method, sent.value);
			if (!checked.ok) return stop(checked);
			applied.push('name');
		}

		if (patch.groupId !== undefined) {
			const sent = await this.send(
				method,
				{ type: 'move_session_to_group', sessionId: agentId, groupId: patch.groupId },
				'move_session_to_group_result'
			);
			if (!sent.ok) return stop(sent);
			const checked = this.checkResult(method, sent.value);
			if (!checked.ok) return stop(checked);
			applied.push('groupId');
		}

		if (patch.autoRunFolderPath !== undefined) {
			const sent = await this.send(
				method,
				{ type: 'set_auto_run_folder', sessionId: agentId, folderPath: patch.autoRunFolderPath },
				'set_auto_run_folder_result'
			);
			if (!sent.ok) return stop(sent);
			const checked = this.checkResult(method, sent.value);
			if (!checked.ok) return stop(checked);
			applied.push('autoRunFolderPath');
		}

		// Config fields are in no push (G2): one full read refreshes the mirror.
		await this.refreshAgents();
		return ok({ applied, ...(notices ? { notices } : {}) });
	}

	// =======================================================================
	// Groups
	// =======================================================================

	private async groupsCreate(input: GroupCreateInput): Promise<ClientResult<{ groupId: string }>> {
		const name = input.name?.trim();
		if (!name) return this.fail('groups.create', 'invalid', 'The group needs a name.');
		const appearance = validateGroupAppearance({ emoji: input.emoji });
		if (!appearance.ok) return this.fail('groups.create', 'invalid', appearance.error);
		const message: Record<string, unknown> = { type: 'create_group', name };
		if (appearance.value.emoji) message.emoji = appearance.value.emoji;
		if (input.parentGroupId) message.parentGroupId = input.parentGroupId;

		const sent = await this.send('groups.create', message, 'create_group_result');
		if (!sent.ok) return sent;
		const checked = this.checkResult('groups.create', sent.value);
		if (!checked.ok) return checked;
		const groupId = asString(sent.value.groupId);
		if (!groupId)
			return this.fail('groups.create', 'failed', 'The desktop did not report the new group.');
		await this.refreshGroups();
		return ok({ groupId });
	}

	private async groupsRename(groupId: string, name: string): Promise<ClientResult<void>> {
		const trimmed = name?.trim();
		if (!trimmed) return this.fail('groups.rename', 'invalid', 'The name cannot be empty.');
		const sent = await this.send(
			'groups.rename',
			{ type: 'rename_group', groupId, name: trimmed },
			'rename_group_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult('groups.rename', sent.value);
		if (!checked.ok) return checked;
		await this.refreshGroups();
		return ok(undefined);
	}

	private async groupsRemove(groupId: string): Promise<ClientResult<void>> {
		const sent = await this.send(
			'groups.remove',
			{ type: 'delete_group', groupId },
			'delete_group_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult('groups.remove', sent.value);
		if (!checked.ok) return checked;
		await this.refreshGroups();
		await this.refreshAgents();
		return ok(undefined);
	}

	private async groupsMoveAgent(
		agentId: string,
		groupId: string | null
	): Promise<ClientResult<void>> {
		const sent = await this.send(
			'groups.moveAgent',
			{ type: 'move_session_to_group', sessionId: agentId, groupId },
			'move_session_to_group_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult('groups.moveAgent', sent.value);
		if (!checked.ok) return checked;
		const agent = this.mirror.getAgent(agentId);
		if (agent) {
			const next = { ...agent } as AgentRecord;
			if (groupId === null) delete next.groupId;
			else next.groupId = groupId;
			this.emitAll(this.mirror.upsert(next));
		}
		return ok(undefined);
	}

	// =======================================================================
	// Tabs
	// =======================================================================

	private async tabsCreate(agentId: string): Promise<ClientResult<{ tabId: string }>> {
		const sent = await this.send(
			'tabs.create',
			{ type: 'new_tab', sessionId: agentId, background: true },
			'new_tab_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult('tabs.create', sent.value);
		if (!checked.ok) return checked;
		const tabId = asString(sent.value.tabId);
		if (!tabId)
			return this.fail('tabs.create', 'failed', 'The desktop did not report the new tab.');
		// The reply names the tab but carries no record: one read fetches it.
		await this.refreshAgents();
		return ok({ tabId });
	}

	private async tabsRename(
		agentId: string,
		tabId: string,
		name: string
	): Promise<ClientResult<void>> {
		const sent = await this.send(
			'tabs.rename',
			{ type: 'rename_tab', sessionId: agentId, tabId, newName: name },
			'rename_tab_result'
		);
		// Silence (the renderer did not confirm in time) reads as `timeout`; the rename may still land.
		if (!sent.ok) return sent;
		const checked = this.checkResult('tabs.rename', sent.value);
		if (!checked.ok) return checked;
		this.emitAll(this.mirror.patchTab(agentId, tabId, { name: name === '' ? null : name }));
		return ok(undefined);
	}

	private async tabsClose(agentId: string, tabId: string): Promise<ClientResult<void>> {
		const sent = await this.send(
			'tabs.close',
			{ type: 'close_tab', sessionId: agentId, tabId },
			'close_tab_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult('tabs.close', sent.value);
		if (!checked.ok) return checked;
		this.emitAll(this.mirror.dropTab(agentId, tabId));
		return ok(undefined);
	}

	private async tabsStar(
		agentId: string,
		tabId: string,
		starred: boolean
	): Promise<ClientResult<void>> {
		const sent = await this.send(
			'tabs.star',
			{ type: 'star_tab', sessionId: agentId, tabId, starred },
			'star_tab_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult('tabs.star', sent.value);
		if (!checked.ok) return checked;
		this.emitAll(this.mirror.patchTab(agentId, tabId, { starred }));
		return ok(undefined);
	}

	private async tabsUpdate(
		agentId: string,
		tabId: string,
		patch: TabPatch
	): Promise<ClientResult<void>> {
		const tabPatch = buildTabConfigPatch(patch);
		if (Object.keys(tabPatch).length === 0) return ok(undefined);

		const sent = await this.send(
			'tabs.update',
			{
				type: 'update_session_config',
				sessionId: agentId,
				configPatch: { tabId, ...tabPatch },
			},
			'update_session_config_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult('tabs.update', sent.value);
		if (!checked.ok) return checked;
		const record: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(tabPatch))
			record[key] = value === null ? undefined : value;
		this.emitAll(this.mirror.patchTab(agentId, tabId, record as Partial<AITabRecord>));
		return ok(undefined);
	}

	private async tabsTranscript(
		agentId: string,
		tabId: string,
		options: TranscriptOptions = {}
	): Promise<ClientResult<LogEntryRecord[]>> {
		const read = await this.invoke<{ logs?: unknown[] }>(
			'tabs.transcript',
			'sessions:getDeferredContent',
			[agentId, tabId, false]
		);
		if (!read.ok) return read;
		return ok(sliceTranscript(transcriptOf({ id: tabId, logs: read.value?.logs ?? [] }), options));
	}

	// =======================================================================
	// Turns
	// =======================================================================

	private async turnsSend(
		agentId: string,
		tabId: string,
		input: TurnInput
	): Promise<ClientResult<TurnSendReceipt>> {
		const hasImages = Boolean(input.images && input.images.length > 0);
		if (!input.text?.trim() && !hasImages) {
			return this.fail('turns.send', 'invalid', 'There is nothing to send.');
		}
		const dispatchId = input.dispatchId ?? generateUUID();
		const message: Record<string, unknown> = {
			dispatchId,
			type: 'enqueue_command',
			sessionId: agentId,
			tabId,
			command: input.text,
			inputMode: 'ai',
			background: true,
		};
		if (hasImages) message.images = input.images;
		const originHost = normalizeOriginHost(input.originHost);
		if (originHost) message.originHost = originHost;
		const turnOverrides = normalizeTurnOverrides(input.overrides);
		if (turnOverrides) message.turnOverrides = turnOverrides;
		if (input.held === true) message.held = true;
		if (input.agentContext || input.agentNotes) {
			// A host too old to take the two fields would drop them, and the turn would answer
			// without a consult's replies. It gets them in the message instead, as an SSH turn's
			// prompt is built on this side (its transcript then shows them in the bubble).
			const applies = await this.hostAppliesAgentText();
			if (!applies.ok) return applies;
			if (applies.value) {
				if (input.agentContext) message.agentContext = input.agentContext;
				if (input.agentNotes) message.agentNotes = input.agentNotes;
			} else {
				message.command = withTurnAgentText(input.text, input);
			}
		}
		const entryId = readTurnEntryId(input.entryId);
		if (entryId) message.entryId = entryId;

		const sent = await this.send('turns.send', message, 'enqueue_command_result');
		if (!sent.ok)
			return {
				ok: false,
				error: {
					...sent.error,
					dispatchId,
					...(['timeout', 'host-lost'].includes(sent.error.code)
						? {
								unknown: true,
								message:
									sent.error.message +
									' Reconcile with the same dispatchId; do not resend with a new ID.',
							}
						: {}),
				},
			};
		const admission = sent.value.admission as PianolaDispatchReceipt | undefined;
		if (sent.value.unknown === true || admission?.outcome === 'unknown')
			return {
				ok: false,
				error: {
					code: 'failed',
					method: 'turns.send',
					dispatchId,
					admission,
					unknown: true,
					message:
						'Queue admission unknown. Reconcile with the same dispatchId; do not resend with a new ID.',
				},
			};
		const checked = this.checkResult('turns.send', sent.value);
		if (!checked.ok)
			return {
				ok: false,
				error: { ...checked.error, dispatchId, ...(admission ? { admission } : {}) },
			};
		const reply = sent.value;
		if (reply.queued === true) {
			const queueLength = typeof reply.queueLength === 'number' ? reply.queueLength : 1;
			return ok({
				status: 'queued',
				...(typeof reply.dispatchId === 'string' ? { dispatchId: reply.dispatchId } : {}),
				...(admission ? { admission } : {}),
				...(typeof reply.durable === 'boolean' ? { durable: reply.durable } : {}),
				itemId: asString(reply.itemId) ?? '',
				position: typeof reply.queuePosition === 'number' ? reply.queuePosition : queueLength,
				queueLength,
			});
		}
		// One of Maestro's own commands: the host ran it, and no turn will end, so none begins here.
		if (reply.ran === true) return ok({ status: 'ran' });
		// The message it named already ran on the host (`TurnSendReceipt` `answered`): nothing began.
		if (reply.answered === true) return ok({ status: 'answered' });
		this.beginTurn(agentId, asString(reply.tabId) ?? tabId);
		return ok({ status: 'started' });
	}

	private async turnsInterrupt(
		agentId: string,
		tabId: string
	): Promise<ClientResult<{ stopped: boolean; stoppedItemIds?: string[] }>> {
		const gate = this.requireConnected('turns.interrupt');
		if (gate) return gate;
		const state = this.turnStates.get(this.turnKey(agentId, tabId));
		const previous = state?.interruptRequested ?? false;
		// Record the request BEFORE asking: the exit can arrive ahead of the reply.
		if (state?.running) state.interruptRequested = true;

		// A desktop host runs its own Stop (`interruptTurn()`, as `maestro-cli interrupt` does), which
		// names the queue item whose turn it ended: its queue frames trail its writes, so only this
		// answer says which waiting message was the stopped turn (M27). A host that cannot (headless,
		// which has no `interrupt_turn`, or one too old) takes the process signal below.
		if (this.hostInfo?.kind === 'desktop') {
			const named = await this.send(
				'turns.interrupt',
				{ type: 'interrupt_turn', sessionId: agentId, tabId },
				'interrupt_turn_result',
				{ timeoutMs: INTERRUPT_TURN_REPLY_TIMEOUT_MS }
			);
			if (named.ok && named.value.success === true) {
				const stopped =
					Array.isArray(named.value.stoppedTabIds) && named.value.stoppedTabIds.includes(tabId);
				if (!stopped && state) state.interruptRequested = previous;
				const stoppedItemIds = parseStoppedItemIds(named.value.stoppedItemIds);
				return ok({ stopped, ...(stoppedItemIds ? { stoppedItemIds } : {}) });
			}
			// The process signal only where the host's own Stop sent none: a host without it, or a
			// desktop with no window that owns the agent. Any other failure may come after the host
			// stopped the turn and started the next one on this tab, which a signal to the tab's
			// process would then stop (CodeRabbit on #2160): that failure is the answer.
			const code = named.ok ? asString(named.value.code) : undefined;
			const signalSent = named.ok
				? code !== 'RENDERER_UNAVAILABLE'
				: named.error.code !== 'unsupported';
			if (signalSent) {
				if (state) state.interruptRequested = previous;
				if (!named.ok) return named;
				if (code === 'AGENT_NOT_FOUND' || code === 'TAB_NOT_FOUND') return ok({ stopped: false });
				return this.fail(
					'turns.interrupt',
					'failed',
					asString(named.value.error) ?? 'The Maestro desktop could not stop the turn.'
				);
			}
		}

		let stopped = false;
		const first = await this.invoke<boolean>('turns.interrupt', 'process:interrupt', [
			`${agentId}-ai-${tabId}`,
		]);
		if (!first.ok) {
			if (state) state.interruptRequested = previous;
			return first;
		}
		stopped = first.value === true;
		if (!stopped && this.mirror.resolveActiveTabId(agentId) === tabId) {
			const legacy = await this.invoke<boolean>('turns.interrupt', 'process:interrupt', [
				`${agentId}-ai`,
			]);
			if (legacy.ok) stopped = legacy.value === true;
		}
		if (!stopped && state) state.interruptRequested = previous;
		return ok({ stopped });
	}

	/**
	 * Whether the host puts a turn's `agentContext` and `agentNotes` into the prompt. A host that
	 * echoes `host_capabilities` (an older build) does not; a failed ask is not remembered.
	 */
	private hostAppliesAgentText(): Promise<ClientResult<boolean>> {
		if (!this.agentTextSupport) {
			const asked = this.send<Reply>(
				'turns.send',
				{ type: 'host_capabilities' },
				'host_capabilities_result'
			).then((reply): ClientResult<boolean> => {
				if (reply.ok) {
					return ok(parseHostCapabilities(reply.value.capabilities).includes('turn-agent-text'));
				}
				if (reply.error.code === 'unsupported') return ok(false);
				if (this.agentTextSupport === asked) this.agentTextSupport = undefined;
				return reply;
			});
			this.agentTextSupport = asked;
		}
		return this.agentTextSupport;
	}

	/**
	 * A desktop host's queue change (M28): applied over the list this client holds when that list is
	 * the one it changes (its `base`), and emitted as the whole list, as every host's frame is. Any
	 * other list (a frame missed, a socket new since) reads the queue whole instead, once, and that
	 * answer goes out as a whole read (no `namesExits`), so the mirror counts the gap and judges
	 * what waits by the tab, as after a reconnect. The changes that come while the read is out are
	 * kept and applied over its answer, from the `seq` it names on (CodeRabbit on #2162).
	 */
	private onQueueChanges(
		agentId: string,
		changes: QueueChanges,
		named: { namesExits?: true; exit?: QueueExit }
	): void {
		const waiting = this.queueGapReads.get(agentId);
		if (waiting) {
			if (waiting.length < MAX_QUEUE_CHANGES_WHILE_READING) waiting.push({ changes, named });
			return;
		}
		const held = this.heldQueues.get(agentId);
		// A change the list held already includes (a read answered at or past it): nothing to do.
		if (held && changes.seq <= held.seq) return;
		const items = held?.seq === changes.base ? applyQueueChanges(held.items, changes) : undefined;
		if (items) {
			this.heldQueues.set(agentId, { seq: changes.seq, items });
			this.emit({ type: 'queue.changed', agentId, items, ...named });
			return;
		}
		this.heldQueues.delete(agentId);
		this.queueGapReads.set(agentId, []);
		void this.readQueueAfterGap(agentId);
	}

	/**
	 * The whole read a change that did not fit asked for. A read sent after that change answers at
	 * or past it (the host takes its `queueSeq` as it starts the read, M29); every change sent
	 * while it was out chains from that `seq`, and is applied over the answer in order.
	 */
	private async readQueueAfterGap(agentId: string): Promise<void> {
		const read = await this.queueList(agentId);
		const later = this.queueGapReads.get(agentId) ?? [];
		this.queueGapReads.delete(agentId);
		// A failed read leaves the mirror as it was; the next change tries again.
		if (!read.ok) return;
		this.emit({ type: 'queue.changed', agentId, items: read.value });
		// An answer with no `seq` (a host before M28 sends no changes) has nothing to chain from.
		if (!this.heldQueues.has(agentId)) return;
		for (const { changes, named } of later) this.onQueueChanges(agentId, changes, named);
	}

	private async queueList(agentId: string): Promise<ClientResult<QueuedTurn[]>> {
		const sent = await this.send(
			'turns.queue.list',
			// The images ride along as data URLs, so a hosted card draws them as a local one does.
			{ type: 'list_queue', sessionId: agentId, inlineImages: true },
			'list_queue_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult('turns.queue.list', sent.value);
		if (!checked.ok) return checked;
		const queues = Array.isArray(sent.value.queues) ? sent.value.queues : [];
		const mine = queues.find((queue) => isObject(queue) && queue.sessionId === agentId);
		const items = parseQueuedTurns(isObject(mine) ? mine.items : undefined);
		// A desktop host's answer says which changes frame it is at (M28): the next change applies
		// over it. A list a newer frame already gave is kept.
		const queueSeq = isObject(mine) ? mine.queueSeq : undefined;
		if (Number.isSafeInteger(queueSeq) && (queueSeq as number) >= 0) {
			const held = this.heldQueues.get(agentId);
			if (!held || held.seq <= (queueSeq as number)) {
				this.heldQueues.set(agentId, { seq: queueSeq as number, items });
			}
		}
		return ok(items);
	}

	private async queueRemove(
		agentId: string,
		itemId: string
	): Promise<ClientResult<{ removed: boolean }>> {
		const sent = await this.send(
			'turns.queue.remove',
			{ type: 'remove_queue_item', sessionId: agentId, itemId },
			'remove_queue_item_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult('turns.queue.remove', sent.value);
		if (!checked.ok) return checked;
		return ok({ removed: sent.value.removed === true });
	}

	/** A headless host's own request: a desktop's bridge does not serve it (`unsupported`). */
	private async historyRemove(
		agentId: string,
		entryId: string
	): Promise<ClientResult<{ removed: boolean }>> {
		const sent = await this.send(
			'history.remove',
			{ type: 'delete_history_entry', sessionId: agentId, entryId },
			'delete_history_entry_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult('history.remove', sent.value);
		if (!checked.ok) return checked;
		return ok({ removed: sent.value.removed === true });
	}

	/** A headless host's own request: a desktop's bridge does not serve it (`unsupported`). */
	private async historyUpdate(
		agentId: string,
		entryId: string,
		updates: HistoryEntryUpdates
	): Promise<ClientResult<{ updated: boolean }>> {
		const sent = await this.send(
			'history.update',
			{
				type: 'update_history_entry',
				sessionId: agentId,
				entryId,
				...(updates.validated !== undefined ? { validated: updates.validated } : {}),
			},
			'update_history_entry_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult('history.update', sent.value);
		if (!checked.ok) return checked;
		return ok({ updated: sent.value.updated === true });
	}

	/** A headless host's own request: a desktop's bridge does not serve it (`unsupported`). */
	private async historyList(
		agentId: string,
		options: HistoryListOptions = {}
	): Promise<ClientResult<HistoryEntry[]>> {
		const sent = await this.send(
			'history.list',
			{
				type: 'get_history',
				sessionId: agentId,
				...(options.limit !== undefined ? { limit: options.limit } : {}),
			},
			'get_history_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult('history.list', sent.value);
		if (!checked.ok) return checked;
		const entries = Array.isArray(sent.value.entries) ? sent.value.entries : [];
		return ok(
			entries.filter(
				(entry): entry is HistoryEntry =>
					isObject(entry) &&
					typeof entry.id === 'string' &&
					typeof entry.timestamp === 'number' &&
					typeof entry.type === 'string'
			)
		);
	}

	/**
	 * Both host kinds answer it (a desktop and a headless host); an older host echoes it, which
	 * reads as `unsupported`. The numbers are parsed as untrusted input.
	 */
	private async usageProjectTokens(
		projects: readonly ProjectTokenUsageProject[],
		options: { timeoutMs?: number } = {}
	): Promise<ClientResult<ProjectTokenUsage>> {
		const request = projectTokenUsageRequest(projects);
		const sent = await this.send(
			'usage.projectTokens',
			{ ...request },
			PROJECT_TOKEN_USAGE_REPLY,
			options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult('usage.projectTokens', sent.value);
		if (!checked.ok) return checked;
		const usage = parseProjectTokenUsageReply(sent.value, request.projects);
		if (!usage) {
			return this.fail('usage.projectTokens', 'failed', 'The host answered no token usage.');
		}
		return ok(usage);
	}

	/** The message `maestro-cli queue hold` sends a desktop, which a headless host answers too. */
	private async queueSetPaused(
		agentId: string,
		itemId: string,
		paused: boolean
	): Promise<ClientResult<{ found: boolean; paused: boolean }>> {
		const sent = await this.send(
			'turns.queue.setPaused',
			{ type: 'set_queue_item_paused', sessionId: agentId, itemId, paused },
			'set_queue_item_paused_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult('turns.queue.setPaused', sent.value);
		if (!checked.ok) return checked;
		return ok({
			found: sent.value.found === true,
			paused: typeof sent.value.paused === 'boolean' ? sent.value.paused : paused,
		});
	}

	/** The message `maestro-cli queue merge` sends a desktop, which a headless host answers too. */
	private async queueMerge(
		agentId: string,
		itemId: string
	): Promise<ClientResult<{ merged: boolean; mergedIntoId?: string }>> {
		const sent = await this.send(
			'turns.queue.merge',
			{ type: 'merge_queue_item', sessionId: agentId, itemId },
			'merge_queue_item_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult('turns.queue.merge', sent.value);
		if (!checked.ok) return checked;
		const mergedIntoId = sent.value.mergedIntoId;
		return ok(
			sent.value.merged === true && typeof mergedIntoId === 'string' && mergedIntoId
				? { merged: true, mergedIntoId }
				: { merged: false }
		);
	}

	/**
	 * The message `maestro-cli queue steer` sends a desktop: its renderer runs the steer and answers
	 * with the outcome. Waits as long as the CLI does, because the host waits on the agent's socket.
	 */
	private async queueSteer(
		agentId: string,
		itemId: string
	): Promise<ClientResult<QueueSteerResult>> {
		const method: ClientMethod = 'turns.queue.steer';
		const sent = await this.send(
			method,
			{ type: 'steer_queue_item', sessionId: agentId, itemId },
			'steer_queue_item_result',
			{ timeoutMs: QUEUE_STEER_ROUND_TRIP_TIMEOUT_MS }
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult(method, sent.value);
		if (!checked.ok) return checked;
		const result = parseQueueSteerResult(sent.value.result);
		return result
			? ok(result)
			: this.fail(method, 'invalid', 'The host answered the steer with no outcome.');
	}

	/** The message `maestro-cli queue edit` sends a desktop, which a headless host answers too. */
	private async queueEdit(
		agentId: string,
		itemId: string,
		edit: QueuedTurnEdit
	): Promise<ClientResult<{ found: boolean }>> {
		const method: ClientMethod = 'turns.queue.edit';
		const sent = await this.send(
			method,
			{
				type: 'edit_queue_item',
				sessionId: agentId,
				itemId,
				text: edit.text,
				...(edit.turnSettings ? { turnSettings: edit.turnSettings } : {}),
				...(edit.images ? { images: edit.images } : {}),
			},
			'edit_queue_item_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult(method, sent.value);
		if (!checked.ok) return checked;
		return ok({ found: sent.value.found === true });
	}

	/** The message `maestro-cli queue move` sends a desktop, which a headless host answers too. */
	private async queueMove(
		agentId: string,
		itemId: string,
		toIndex: number,
		tabId?: string
	): Promise<ClientResult<{ moved: boolean }>> {
		const method: ClientMethod = 'turns.queue.move';
		const sent = await this.send(
			method,
			{
				type: 'move_queue_item',
				sessionId: agentId,
				itemId,
				toIndex,
				...(tabId ? { tabId } : {}),
			},
			'move_queue_item_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult(method, sent.value);
		if (!checked.ok) return checked;
		return ok({ moved: sent.value.moved === true });
	}

	/** The message `maestro-cli queue send-now` sends a desktop, which a headless host answers too. */
	private async queueSendNow(
		agentId: string,
		itemId: string
	): Promise<ClientResult<{ sent: boolean }>> {
		const method: ClientMethod = 'turns.queue.sendNow';
		const sent = await this.send(
			method,
			{ type: 'send_queue_item_now', sessionId: agentId, itemId },
			'send_queue_item_now_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult(method, sent.value);
		if (!checked.ok) return checked;
		return ok({ sent: sent.value.sent === true });
	}

	// =======================================================================
	// Auto Run
	// =======================================================================

	/** The checks every launch makes before a message is sent: attached, and the agent exists. */
	private autoRunTarget(method: ClientMethod, agentId: string): ClientResult<never> | undefined {
		const gate = this.requireConnected(method);
		if (gate) return gate;
		if (!this.mirror.getAgent(agentId))
			return this.fail(method, 'not-found', `No agent ${agentId}`);
		return undefined;
	}

	private async autoRunLaunch(
		agentId: string,
		input: AutoRunLaunchInput
	): Promise<ClientResult<void>> {
		const method: ClientMethod = 'autoRun.launch';
		const refused = this.autoRunTarget(method, agentId);
		if (refused) return refused;
		const checked = validateAutoRunLaunch(input);
		if (!checked.ok) return this.fail(method, 'invalid', checked.reason);
		const { documents, loop, maxLoops, model, effort, prompt, ignoreModelHints } = checked.value;
		const sent = await this.send(
			method,
			{
				type: 'configure_auto_run',
				sessionId: agentId,
				launch: true,
				// Absolute paths: the desktop works out each name under the agent's Auto Run folder.
				documents: documents.map((document) => ({
					filename: document.file,
					...(document.resetOnCompletion ? { resetOnCompletion: true } : {}),
				})),
				...(loop ? { loopEnabled: true } : {}),
				...(loop && typeof maxLoops === 'number' ? { maxLoops } : {}),
				...(model ? { model } : {}),
				...(effort ? { effort } : {}),
				// Under the names `maestro-cli auto-run` sends them and both hosts read them.
				...(prompt ? { prompt } : {}),
				...(ignoreModelHints ? { ignoreModelHints: true } : {}),
			},
			'configure_auto_run_result'
		);
		if (!sent.ok) return sent;
		const result = this.checkResult(method, sent.value, { stateRefusal: true });
		return result.ok ? ok(undefined) : result;
	}

	private async autoRunLaunchGoal(
		agentId: string,
		input: GoalRunLaunchInput
	): Promise<ClientResult<{ tabId?: string }>> {
		const method: ClientMethod = 'autoRun.launchGoal';
		const refused = this.autoRunTarget(method, agentId);
		if (refused) return refused;
		const checked = validateGoalRunLaunch(input);
		if (!checked.ok) return this.fail(method, 'invalid', checked.reason);
		const { goal, exitCriteria, maxIterations, model, effort } = checked.value;
		const sent = await this.send(
			method,
			{
				type: 'launch_goal_run',
				sessionId: agentId,
				goal,
				...(exitCriteria ? { exitCriteria } : {}),
				...(maxIterations !== undefined ? { maxIterations } : {}),
				...(model ? { model } : {}),
				...(effort ? { effort } : {}),
			},
			'launch_goal_run_result'
		);
		if (!sent.ok) return sent;
		const result = this.checkResult(method, sent.value, { stateRefusal: true });
		if (!result.ok) return result;
		const tabId = asString(result.value.tabId);
		return ok(tabId ? { tabId } : {});
	}

	/** Stop, resume, skip, and abort differ only in the message: each answers on delivery (G7). */
	private async autoRunControl(
		method: ClientMethod,
		agentId: string,
		type: string,
		replyType: string
	): Promise<ClientResult<void>> {
		const gate = this.requireConnected(method);
		if (gate) return gate;
		const sent = await this.send(method, { type, sessionId: agentId }, replyType);
		if (!sent.ok) return sent;
		const result = this.checkResult(method, sent.value, { stateRefusal: true });
		return result.ok ? ok(undefined) : result;
	}

	/**
	 * The message `maestro-cli steer-auto-run` sends a desktop, which a headless host answers too.
	 * A refusal (no run, the cap, a note already taken) is the host's answer, not a failure.
	 */
	private async autoRunSteer(
		agentId: string,
		input: SteeringCommandInput
	): Promise<ClientResult<SteeringCommandResult>> {
		const method: ClientMethod = 'autoRun.steer';
		const gate = this.requireConnected(method);
		if (gate) return gate;
		const sent = await this.send(
			method,
			{
				type: 'auto_run_steering_command',
				sessionId: agentId,
				action: input.action,
				...(input.text !== undefined ? { text: input.text } : {}),
				...(input.noteId !== undefined ? { noteId: input.noteId } : {}),
				...(input.deliveryId !== undefined ? { deliveryId: input.deliveryId } : {}),
			},
			'auto_run_steering_command_result'
		);
		if (!sent.ok) return sent;
		return ok(normalizeSteeringCommandResult(sent.value));
	}

	// =======================================================================
	// Group chats
	// =======================================================================

	private async groupChatsList(): Promise<ClientResult<GroupChatRecord[]>> {
		const method: ClientMethod = 'groupChats.list';
		const sent = await this.send(method, { type: 'get_group_chats' }, 'group_chats_list');
		if (!sent.ok) return sent;
		const chats = Array.isArray(sent.value.chats)
			? sent.value.chats
					.map(parseGroupChatRecord)
					.filter((chat): chat is GroupChatRecord => chat !== undefined)
			: [];
		for (const chat of chats) this.knownGroupChats.add(chat.id);
		return ok(chats);
	}

	private async groupChatsGet(chatId: string): Promise<ClientResult<GroupChatRecord>> {
		const method: ClientMethod = 'groupChats.get';
		const sent = await this.send(
			method,
			{ type: 'get_group_chat_state', chatId },
			'group_chat_state'
		);
		if (!sent.ok) return sent;
		const chat = parseGroupChatRecord(sent.value.state);
		if (!chat) return this.fail(method, 'not-found', `No group chat ${chatId}`);
		this.knownGroupChats.add(chat.id);
		return ok(chat);
	}

	private async groupChatsCreate(
		input: GroupChatCreateInput
	): Promise<ClientResult<{ chatId: string }>> {
		const method: ClientMethod = 'groupChats.create';
		const gate = this.requireConnected(method);
		if (gate) return gate;
		const checked = validateGroupChatCreate(input);
		if (!checked.ok) return this.fail(method, 'invalid', checked.reason);
		const { name, participantIds, message } = checked.value;
		const missing = participantIds.find((id) => !this.mirror.getAgent(id));
		if (missing) return this.fail(method, 'not-found', `No agent ${missing}`);
		// The host moderates with a provider, so the moderator agent is read down to its provider.
		const moderator = input.moderatorAgentId
			? this.mirror.getAgent(input.moderatorAgentId)
			: undefined;
		if (input.moderatorAgentId && !moderator) {
			return this.fail(method, 'not-found', `No agent ${input.moderatorAgentId}`);
		}
		const sent = await this.send(
			method,
			{
				type: 'start_group_chat',
				topic: name,
				participantIds,
				...(moderator?.toolType ? { moderatorAgentId: moderator.toolType } : {}),
				...(message ? { message } : {}),
			},
			'start_group_chat_result'
		);
		if (!sent.ok) return sent;
		const result = this.checkResult(method, sent.value);
		if (!result.ok) {
			// The chat can exist when only its opening message failed; the host's text says so.
			return result;
		}
		const chatId = asString(result.value.chatId);
		if (!chatId) return this.fail(method, 'failed', 'The desktop did not report the new chat.');
		this.knownGroupChats.add(chatId);
		return ok({ chatId });
	}

	private async groupChatsSend(chatId: string, message: string): Promise<ClientResult<void>> {
		const method: ClientMethod = 'groupChats.send';
		const gate = this.requireConnected(method);
		if (gate) return gate;
		if (!message.trim()) return this.fail(method, 'invalid', 'The message is empty.');
		const sent = await this.send(
			method,
			{ type: 'send_group_chat_message', chatId, message },
			'send_group_chat_message_result'
		);
		if (!sent.ok) return sent;
		if (sent.value.success === true) return ok(undefined);
		// The host answers a bare false for a chat that is busy and for one that is gone.
		return this.fail(
			method,
			'rejected',
			'The desktop did not take the message: the chat is still working, or it no longer exists.'
		);
	}

	private async groupChatsStop(chatId: string): Promise<ClientResult<void>> {
		const method: ClientMethod = 'groupChats.stop';
		const sent = await this.send(
			method,
			{ type: 'stop_group_chat', chatId },
			'stop_group_chat_result'
		);
		if (!sent.ok) return sent;
		const result = this.checkResult(method, sent.value);
		return result.ok ? ok(undefined) : result;
	}

	/** The host has no message for these two (gap G15), so they ride the IPC handlers the desktop's own UI calls. */
	private async groupChatsRename(chatId: string, name: string): Promise<ClientResult<void>> {
		const method: ClientMethod = 'groupChats.rename';
		const trimmed = name.trim();
		if (!trimmed) return this.fail(method, 'invalid', 'The name cannot be empty.');
		if (trimmed.length > MAX_CHAT_NAME_LENGTH) {
			return this.fail(method, 'invalid', `Names are at most ${MAX_CHAT_NAME_LENGTH} characters.`);
		}
		const done = await this.invoke<unknown>(method, 'groupChat:rename', [chatId, trimmed]);
		return done.ok ? ok(undefined) : done;
	}

	private async groupChatsRemove(chatId: string): Promise<ClientResult<void>> {
		const done = await this.invoke<unknown>('groupChats.remove', 'groupChat:delete', [chatId]);
		if (!done.ok) return done;
		this.knownGroupChats.delete(chatId);
		return ok(undefined);
	}

	// =======================================================================
	// Consults
	// =======================================================================

	private async consultsAsk(input: ConsultAskInput): Promise<ClientResult<ConsultAnswer>> {
		const method: ClientMethod = 'consults.ask';
		const gate = this.requireConnected(method);
		if (gate) return gate;
		if (!input.question.trim()) return this.fail(method, 'invalid', 'The question is empty.');
		if (input.fromAgentId && input.fromAgentId === input.targetAgentId) {
			return this.fail(method, 'invalid', 'An agent cannot consult itself.');
		}
		const timeoutMs = Math.min(
			Math.max(input.timeoutMs ?? DEFAULT_CONSULT_TIMEOUT_MS, MIN_CONSULT_TIMEOUT_MS),
			MAX_CONSULT_TIMEOUT_MS
		);
		const sent = await this.send(
			method,
			{
				type: 'cross_agent_ask',
				sessionId: input.targetAgentId,
				question: input.question,
				...(input.fromAgentId ? { fromSessionId: input.fromAgentId } : {}),
				...(input.fromTabId ? { fromTabId: input.fromTabId } : {}),
				withContext: input.withContext === true,
				...(input.transcript ? { transcript: input.transcript } : {}),
				...(input.fromAgentName ? { fromAgentName: input.fromAgentName } : {}),
				...(input.askerKey ? { askerKey: input.askerKey } : {}),
				timeoutMs,
				...(input.handoffAnswer !== undefined ? { handoffAnswer: input.handoffAnswer } : {}),
				...(input.sideQuestion === true ? { sideQuestion: true } : {}),
				...(input.targetTabId ? { targetTabId: input.targetTabId } : {}),
			},
			'cross_agent_ask_result',
			{ timeoutMs: timeoutMs + CONSULT_WAIT_GRACE_MS }
		);
		if (!sent.ok) return sent;
		const reply = sent.value;
		const agentName = asString(reply.targetAgentName);
		if (reply.success === true) return ok({ answer: asString(reply.answer) ?? '', agentName });
		const who = agentName ?? 'the agent';
		if (reply.canceled === true) {
			return this.fail(method, 'rejected', `The consult with ${who} was stopped.`);
		}
		const text = asString(reply.error);
		return this.fail(method, classifyFailure(text), text ?? `${who} did not answer.`);
	}

	/** The agent's closed-tab stack on the host (`closed_tab_command` list), bounded. */
	private async tabsClosed(agentId: string): Promise<ClientResult<ClosedTabSummary[]>> {
		const method: ClientMethod = 'tabs.closed';
		const sent = await this.send(
			method,
			{ type: 'closed_tab_command', action: 'list', sessionId: agentId },
			'closed_tab_command_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult(method, sent.value);
		return checked.ok ? ok(parseWireClosedTabs(checked.value.closedTabs)) : checked;
	}

	/** Reopen a closed AI tab on the host in the background (`closed_tab_command` reopen). */
	private async tabsReopen(
		agentId: string,
		target: { index?: number; tabId?: string }
	): Promise<ClientResult<{ tabId: string; wasDuplicate?: boolean }>> {
		const method: ClientMethod = 'tabs.reopen';
		const sent = await this.send(
			method,
			{
				type: 'closed_tab_command',
				action: 'reopen',
				sessionId: agentId,
				...(target.tabId ? { tabId: target.tabId } : { index: target.index ?? 0 }),
				background: true,
			},
			'closed_tab_command_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult(method, sent.value);
		if (!checked.ok) return checked;
		const tabId = asString(checked.value.tabId);
		if (!tabId || (checked.value.tabType !== undefined && checked.value.tabType !== 'ai')) {
			return this.fail(method, 'rejected', 'The host did not reopen an AI tab.');
		}
		return ok({ tabId, ...(checked.value.wasDuplicate === true ? { wasDuplicate: true } : {}) });
	}

	/** Stop one remote asker's consults on the host (`cross_agent_cancel`). */
	private async consultsCancel(input: {
		askerKey: string;
	}): Promise<ClientResult<{ canceled: number }>> {
		const method: ClientMethod = 'consults.cancel';
		const askerKey = parseWireAskerKey(input.askerKey);
		if (!askerKey) return this.fail(method, 'invalid', 'The asker key is not valid.');
		const sent = await this.send(
			method,
			{ type: 'cross_agent_cancel', askerKey },
			'cross_agent_cancel_result',
			{ timeoutMs: CONSULT_CANCEL_TIMEOUT_MS }
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult(method, sent.value);
		if (!checked.ok) return checked;
		const canceled = checked.value.canceled;
		return ok({ canceled: typeof canceled === 'number' && canceled > 0 ? canceled : 0 });
	}

	// =======================================================================
	// Settings and providers
	// =======================================================================

	private async settingsGet(
		keys: readonly string[]
	): Promise<ClientResult<Record<string, unknown>>> {
		const gate = this.requireConnected('settings.get');
		if (gate) return gate;
		const reads = await Promise.all(
			keys.map((key) => this.invoke<unknown>('settings.get', 'settings:get', [key]))
		);
		const values: Record<string, unknown> = {};
		for (const [index, read] of reads.entries()) {
			if (!read.ok) return read;
			if (read.value !== undefined) values[keys[index]] = read.value;
		}
		return ok(values);
	}

	private async settingsSshRemotes(): Promise<ClientResult<SshRemoteConfig[]>> {
		const read = await this.invoke<{
			success?: boolean;
			configs?: SshRemoteConfig[];
			error?: string;
		}>('settings.sshRemotes', 'ssh-remote:getConfigs');
		if (!read.ok) return read;
		if (read.value?.success === false) {
			return this.fail(
				'settings.sshRemotes',
				'failed',
				read.value.error ?? 'The desktop could not list SSH remotes.'
			);
		}
		return ok(Array.isArray(read.value?.configs) ? read.value.configs : []);
	}

	private async providersList(options?: {
		sshRemoteId?: string;
	}): Promise<ClientResult<ProviderInfo[]>> {
		const remoteId = options?.sshRemoteId;
		const [detected, snapshots] = await Promise.all([
			this.invoke<unknown>('providers.list', 'agents:detect', remoteId ? [remoteId] : []),
			this.invoke<AgentCapabilitiesSnapshotMap>('providers.list', 'agents:getAllSnapshots'),
		]);
		if (!detected.ok) return detected;
		const versions = snapshots.ok && isObject(snapshots.value) ? snapshots.value : {};
		const list = Array.isArray(detected.value) ? detected.value : [];
		return ok(
			list
				.filter(isObject)
				.filter((agent) => agent.id !== 'terminal' && typeof agent.id === 'string')
				.map((agent): ProviderInfo => {
					const id = agent.id as string;
					// The detection entry carries its own snapshot; the persisted map is the fallback.
					const own = isObject(agent.snapshot) ? asString(agent.snapshot.version) : undefined;
					const version = own ?? versions[buildSnapshotKey(id, remoteId)]?.version;
					const path = asString(agent.path);
					const reason = asString(agent.error);
					return {
						id,
						name: asString(agent.name) ?? getAgentDisplayName(id),
						available: agent.available === true,
						...(version ? { version } : {}),
						...(path ? { path } : {}),
						...(reason ? { unavailableReason: reason } : {}),
					};
				})
		);
	}

	private async providersModels(
		providerId: string,
		options?: { sshRemoteId?: string; refresh?: boolean }
	): Promise<ClientResult<string[]>> {
		// Trailing `undefined` would serialize as `null`; leave the remote off instead.
		const args: unknown[] = [providerId, options?.refresh ?? false];
		if (options?.sshRemoteId) args.push(options.sshRemoteId);
		const read = await this.invoke<unknown>('providers.models', 'agents:getModels', args);
		if (!read.ok) return read;
		const models = Array.isArray(read.value) ? read.value : [];
		return ok(
			models
				.map((model) =>
					typeof model === 'string' ? model : asString((model as { id?: unknown })?.id)
				)
				.filter((model): model is string => typeof model === 'string' && model !== '')
		);
	}
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Create the `MaestroClient` for the desktop running against `userDataDir`, or for the
 * host at an explicit `endpoint`.
 * Nothing is opened until `client.connection.connect()`.
 */
export function createWsMaestroClient(options: WsMaestroClientOptions): MaestroClient {
	return new WsMaestroClient(options);
}
