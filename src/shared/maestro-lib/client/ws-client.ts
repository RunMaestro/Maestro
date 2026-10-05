/**
 * `createWsMaestroClient`: the `MaestroClient` interface over the running
 * desktop's WebSocket bridge (milestone M1).
 *
 * Follows `Plans/maestro-tui-client-api.md`. In short:
 *   - discovery reads `cli-server.json` from the caller's data dir; the socket
 *     is dialed on 127.0.0.1 with the per-boot `cliSecret`;
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
import { transcriptOf, type LogEntryRecord } from '../store/transcript';
import { logger } from '../host';
import { getAgentDisplayName } from '../../agentMetadata';
import {
	validateAutoRunLaunch,
	validateGoalRunLaunch,
	type AutoRunLaunchInput,
	type GoalRunLaunchInput,
} from '../autorun/launch';
import { parseAutoRunProgress } from '../autorun/progress';
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
import type { AgentError, SshRemoteConfig } from '../../types';
import {
	BridgeConnection,
	CommandTimeoutError,
	ConnectionClosedError,
	UnsupportedCommandError,
} from './bridge-connection';
import { isPidAlive, readCliServerInfoFrom, type CliServerInfo } from './discovery';
import {
	CUSTOM_COMMANDS_STORE_KEY,
	THEME_STORE_KEY,
	changedWebSettingKeys,
	classifyFailure,
	isUnsupportedInvokeError,
	parseBatchFrame,
	parseProcessFrame,
	parseUserInputFrame,
	resolveBridgeOutcome,
	type ProcessFrame,
	type ProcessTarget,
} from './bridge-frames';
import { ClientMirror, type ProjectedAgent, type ProjectedTab } from './mirror';
import type {
	AgentCreateInput,
	AgentPatch,
	AgentPatchField,
	AgentUpdateReceipt,
	ClientError,
	ClientErrorCode,
	ClientMethod,
	ClientResult,
	ConnectionState,
	ConsultAnswer,
	ConsultAskInput,
	EventFilter,
	GroupCreateInput,
	HostInfo,
	MaestroClient,
	MaestroEvent,
	ProviderInfo,
	QueuedTurn,
	SettingsChange,
	TabPatch,
	TranscriptOptions,
	TurnEvent,
	TurnInput,
	TurnSendReceipt,
	Unsubscribe,
	WsMaestroClientOptions,
} from './types';

const LOG_CONTEXT = '[WsMaestroClient]';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
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
const MAX_NAME_LENGTH = 100;

const TOO_OLD_MESSAGE = 'The running Maestro is too old for the TUI; update the desktop app.';

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

interface ListenerEntry {
	listener: (event: MaestroEvent) => void;
	filter?: EventFilter;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

class WsMaestroClient implements MaestroClient {
	private readonly requestTimeoutMs: number;
	private readonly reconnectInitialMs: number;
	private readonly reconnectMaxMs: number;
	private readonly heartbeatIntervalMs: number;
	private readonly heartbeatTimeoutMs: number;
	private readonly reconcileIntervalMs: number;
	private readonly now: () => number;

	private readonly mirror: ClientMirror;
	private readonly listeners = new Set<ListenerEntry>();
	private readonly turnStates = new Map<string, TurnState>();
	/** Group chats this client has read or heard about: each gets a `gap` when a connection could not resume. */
	private readonly knownGroupChats = new Set<string>();

	private state: ConnectionState = 'idle';
	private hostInfo: HostInfo | undefined;
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
			const found = this.discoverHost('connection.discover');
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
		const entry: ListenerEntry = { listener, filter };
		this.listeners.add(entry);
		return () => {
			this.listeners.delete(entry);
		};
	}

	private emit(event: MaestroEvent): void {
		for (const entry of [...this.listeners]) {
			if (!matchesFilter(event, entry.filter)) continue;
			try {
				entry.listener(event);
			} catch (error) {
				logger.warn(
					`An event listener threw: ${error instanceof Error ? error.message : String(error)}`,
					LOG_CONTEXT
				);
			}
		}
	}

	private emitAll(events: MaestroEvent[]): void {
		for (const event of events) this.emit(event);
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

	private discoverHost(
		method: ClientMethod
	): ClientResult<{ info: CliServerInfo; host: HostInfo }> {
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
		return ok({
			info,
			host: {
				kind: 'desktop',
				pid: info.pid,
				...(info.version ? { version: info.version } : {}),
				startedAt: info.startedAt,
				label: `desktop pid ${info.pid}`,
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
		const found = this.discoverHost(method);
		if (!found.ok) return found;
		const { host } = found.value;

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
		const query = resume && this.epoch ? { since: this.lastSeq, epoch: this.epoch } : undefined;
		const conn = new BridgeConnection({
			userDataDir: this.options.userDataDir,
			strictReplies: true,
			...(query ? { query } : {}),
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
					event: { kind: 'state', at: this.now(), state: parseAutoRunProgress(frame.state) },
				});
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
				const added = Array.isArray(payload.added)
					? agentsOf({ sessions: payload.added as unknown[] })
					: [];
				for (const agent of added) this.emitAll(this.mirror.upsert(agent));
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

	private async tryReconnect(
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
		const boot = await this.invoke<unknown>('agents.get', 'sessions:getBootstrap');
		if (!boot.ok) return boot;
		const all = agentsOf({ sessions: Array.isArray(boot.value) ? boot.value : [] });
		this.emitAll(this.mirror.syncAgents(all));
		const found = all.find((agent) => agent.id === agentId);
		return found ? ok(found) : this.fail('agents.get', 'not-found', `No agent ${agentId}`);
	}

	private async agentsCreate(input: AgentCreateInput): Promise<ClientResult<{ agentId: string }>> {
		const name = input.name?.trim();
		if (!name) return this.fail('agents.create', 'invalid', 'The agent needs a name.');
		if (!input.provider || input.provider === 'terminal' || !isValidAgentId(input.provider)) {
			return this.fail('agents.create', 'invalid', `Unknown provider "${input.provider}".`);
		}
		if (!input.cwd?.trim())
			return this.fail('agents.create', 'invalid', 'The agent needs a working directory.');

		const env = input.env ? stripBlankEnvVars(input.env) : undefined;
		const message: Record<string, unknown> = {
			type: 'create_session',
			name,
			toolType: input.provider,
			cwd: input.cwd,
			background: true,
		};
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
		for (const [key, value] of optional)
			if (value !== undefined && value !== '') message[key] = value;
		if (input.contextWindow !== undefined) message.contextWindowSource = 'user-edited';

		const sent = await this.send('agents.create', message, 'create_session_result');
		if (!sent.ok) return sent;
		const checked = this.checkResult('agents.create', sent.value);
		if (!checked.ok) return checked;
		const agentId = asString(sent.value.sessionId);
		if (!agentId)
			return this.fail('agents.create', 'failed', 'The desktop did not report the new agent.');
		return ok({ agentId });
	}

	private async agentsRename(agentId: string, name: string): Promise<ClientResult<void>> {
		const trimmed = name?.trim();
		if (!trimmed) return this.fail('agents.rename', 'invalid', 'The name cannot be empty.');
		if (trimmed.length > MAX_NAME_LENGTH) {
			return this.fail(
				'agents.rename',
				'invalid',
				`The name must be ${MAX_NAME_LENGTH} characters or fewer.`
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
			if (trimmed.length > MAX_NAME_LENGTH) {
				return this.fail(
					method,
					'invalid',
					`The name must be ${MAX_NAME_LENGTH} characters or fewer.`
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

		const config = buildConfigPatch(patch);
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
		const tabPatch: Record<string, unknown> = {};
		if (patch.readOnly !== undefined) tabPatch.readOnlyMode = patch.readOnly;
		if (patch.thinking !== undefined) tabPatch.showThinking = patch.thinking;
		if (patch.model !== undefined) tabPatch.customModel = patch.model;
		if (patch.effort !== undefined) tabPatch.customEffort = patch.effort;
		if (patch.saveToHistory !== undefined) tabPatch.saveToHistory = patch.saveToHistory;
		if (patch.enterToSend !== undefined) tabPatch.enterToSend = patch.enterToSend;
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
		let entries = transcriptOf({ id: tabId, logs: read.value?.logs ?? [] });
		if (options.sinceMs !== undefined) {
			const since = options.sinceMs;
			entries = entries.filter((entry) => entry.timestamp > since);
		}
		if (options.tail !== undefined) {
			entries = options.tail <= 0 ? [] : entries.slice(-options.tail);
		}
		return ok(entries);
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
		const message: Record<string, unknown> = {
			type: 'enqueue_command',
			sessionId: agentId,
			tabId,
			command: input.text,
			inputMode: 'ai',
			background: true,
		};
		if (hasImages) message.images = input.images;

		const sent = await this.send('turns.send', message, 'enqueue_command_result');
		if (!sent.ok) return sent;
		const checked = this.checkResult('turns.send', sent.value);
		if (!checked.ok) return checked;
		const reply = sent.value;
		if (reply.queued === true) {
			const queueLength = typeof reply.queueLength === 'number' ? reply.queueLength : 1;
			return ok({
				status: 'queued',
				itemId: asString(reply.itemId) ?? '',
				position: typeof reply.queuePosition === 'number' ? reply.queuePosition : queueLength,
				queueLength,
			});
		}
		this.beginTurn(agentId, asString(reply.tabId) ?? tabId);
		return ok({ status: 'started' });
	}

	private async turnsInterrupt(
		agentId: string,
		tabId: string
	): Promise<ClientResult<{ stopped: boolean }>> {
		const gate = this.requireConnected('turns.interrupt');
		if (gate) return gate;
		const state = this.turnStates.get(this.turnKey(agentId, tabId));
		const previous = state?.interruptRequested ?? false;
		// Record the request BEFORE asking: the exit can arrive ahead of the reply.
		if (state?.running) state.interruptRequested = true;

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

	private async queueList(agentId: string): Promise<ClientResult<QueuedTurn[]>> {
		const sent = await this.send(
			'turns.queue.list',
			{ type: 'list_queue', sessionId: agentId },
			'list_queue_result'
		);
		if (!sent.ok) return sent;
		const checked = this.checkResult('turns.queue.list', sent.value);
		if (!checked.ok) return checked;
		const queues = Array.isArray(sent.value.queues) ? sent.value.queues : [];
		const mine = queues.find((queue) => isObject(queue) && queue.sessionId === agentId);
		const items = isObject(mine) && Array.isArray(mine.items) ? mine.items : [];
		return ok(
			items.filter(isObject).map((item): QueuedTurn => {
				const command = asString(item.command);
				const args = asString(item.commandArgs);
				return {
					itemId: asString(item.id) ?? '',
					tabId: asString(item.tabId) ?? '',
					queuedAt: typeof item.timestamp === 'number' ? item.timestamp : 0,
					kind: item.type === 'command' ? 'command' : 'message',
					text: asString(item.text) ?? (command ? (args ? `${command} ${args}` : command) : ''),
					paused: item.paused === true,
				};
			})
		);
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
		const { documents, loop, maxLoops, model, effort } = checked.value;
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
		if (trimmed.length > MAX_NAME_LENGTH) {
			return this.fail(method, 'invalid', `Names are at most ${MAX_NAME_LENGTH} characters.`);
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
				timeoutMs,
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
 * Whether an event passes a filter. The agent filter narrows the agent-scoped
 * events (agent, tab, turn); connection, snapshot, group, and settings events
 * are about no single agent and always pass it.
 */
function matchesFilter(event: MaestroEvent, filter: EventFilter | undefined): boolean {
	if (!filter) return true;
	if (filter.types && !filter.types.includes(event.type)) return false;
	if (filter.agentId === undefined) return true;
	switch (event.type) {
		case 'agent.added':
		case 'agent.updated':
			return event.agent.id === filter.agentId;
		case 'agent.removed':
		case 'tab.added':
		case 'tab.updated':
		case 'tab.removed':
		case 'turn':
		case 'autorun':
			return event.agentId === filter.agentId;
		default:
			return true;
	}
}

/** The config-patch form of an `AgentPatch`: which fields it carries, and the host's keys for them. */
function buildConfigPatch(patch: AgentPatch): {
	fields: AgentPatchField[];
	patch: Record<string, unknown>;
} {
	const fields: AgentPatchField[] = [];
	const out: Record<string, unknown> = {};
	const put = (field: AgentPatchField, key: string, value: unknown): void => {
		fields.push(field);
		out[key] = value;
	};
	if (patch.model !== undefined) put('model', 'customModel', patch.model);
	if (patch.effort !== undefined) put('effort', 'customEffort', patch.effort);
	if (patch.contextWindow !== undefined) {
		fields.push('contextWindow');
		out.customContextWindow = patch.contextWindow;
		out.contextWindowSource = patch.contextWindow === null ? null : 'user-edited';
	}
	if (patch.customPath !== undefined) put('customPath', 'customPath', patch.customPath);
	if (patch.customArgs !== undefined) put('customArgs', 'customArgs', patch.customArgs);
	if (patch.env !== undefined) {
		put('env', 'customEnvVars', patch.env === null ? null : stripBlankEnvVars(patch.env));
	}
	if (patch.nudgeMessage !== undefined) put('nudgeMessage', 'nudgeMessage', patch.nudgeMessage);
	if (patch.newSessionMessage !== undefined) {
		put('newSessionMessage', 'newSessionMessage', patch.newSessionMessage);
	}
	if (patch.bookmarked !== undefined) put('bookmarked', 'bookmarked', patch.bookmarked);
	return { fields, patch: out };
}

/**
 * Create the `MaestroClient` for the desktop running against `userDataDir`.
 * Nothing is opened until `client.connection.connect()`.
 */
export function createWsMaestroClient(options: WsMaestroClientOptions): MaestroClient {
	return new WsMaestroClient(options);
}
