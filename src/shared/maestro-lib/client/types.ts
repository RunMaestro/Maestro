/**
 * The `MaestroClient` interface: the one surface the TUI programs against.
 *
 * Types only. No runtime code and no Node imports, so an in-process
 * implementation (`createMaestroRuntime`, Phase 5) and the WebSocket one
 * (`createWsMaestroClient`, `./ws-client`) satisfy the same contract. The
 * design, the bridge mapping for every method, and the gaps the bridge leaves
 * are in `Plans/maestro-tui-client-api.md`; this file is section 4 of it.
 *
 * Rules the types encode:
 *   - transport-free: records and library types only (R1);
 *   - results, not exceptions: every method resolves to `ClientResult<T>` (R2);
 *   - records are the on-disk shapes without transcripts (R6).
 */

import type { AgentRecord, AITabRecord, GroupRecord } from '../store/records';
import type { LogEntryRecord } from '../store/transcript';
import type { TurnOutcome } from '../streaming/turn-outcome';
import type { AgentError, SshRemoteConfig, ThinkingMode, UsageStats } from '../../types';

// ---------------------------------------------------------------------------
// Results and errors
// ---------------------------------------------------------------------------

/** Every method resolves to one of these. Nothing throws for an expected failure. */
export type ClientResult<T> = { ok: true; value: T } | { ok: false; error: ClientError };

export type ClientErrorCode =
	/** The host cannot do this: no mapping exists yet, or the host build is too old. */
	| 'unsupported'
	/** No host is attached: none is running, or the connection is down. */
	| 'host-unavailable'
	/** The connection dropped while the call was in flight. It may or may not have been applied. */
	| 'host-lost'
	/** The host refused this client (Web Login gate, a secret from an earlier boot). */
	| 'unauthorized'
	/** The host did not answer in time. It may or may not have been applied. */
	| 'timeout'
	/** The agent, tab, group, or queued item does not exist. */
	| 'not-found'
	/** The input failed validation, in the client or on the host. */
	| 'invalid'
	/** The host refused for a reason of state; `message` says which (a live process blocks a cwd move). */
	| 'rejected'
	/** The host reported a failure that fits none of the above. */
	| 'failed';

export interface ClientError {
	code: ClientErrorCode;
	/** Safe to show a person. Never holds a token or a secret. */
	message: string;
	/** The method that failed. */
	method: ClientMethod;
	/** `agents.update` only: the fields applied before the failure. */
	appliedFields?: AgentPatchField[];
}

export type ClientMethod =
	| 'connection.discover'
	| 'connection.connect'
	| 'connection.reconnect'
	| 'agents.list'
	| 'agents.get'
	| 'agents.create'
	| 'agents.update'
	| 'agents.rename'
	| 'agents.remove'
	| 'groups.list'
	| 'groups.create'
	| 'groups.rename'
	| 'groups.remove'
	| 'groups.moveAgent'
	| 'tabs.list'
	| 'tabs.create'
	| 'tabs.rename'
	| 'tabs.close'
	| 'tabs.star'
	| 'tabs.update'
	| 'tabs.transcript'
	| 'turns.send'
	| 'turns.interrupt'
	| 'turns.queue.list'
	| 'turns.queue.remove'
	| 'settings.get'
	| 'settings.sshRemotes'
	| 'providers.list'
	| 'providers.models';

export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export type HostKind = 'desktop' | 'headless' | 'in-process';

export interface HostInfo {
	kind: HostKind;
	/** The host's process id. Absent when the host is this process. */
	pid?: number;
	/** The host build's version, when it reports one. */
	version?: string;
	/** When the host started serving, epoch ms. */
	startedAt?: number;
	/** What the status bar prints after `host: `: `desktop pid 4121`, `headless pid 812`, `this TUI`. */
	label: string;
}

export type ConnectionState =
	/** Not attached: never connected, or closed by the caller. */
	| 'idle'
	/** The first attempt is in flight. */
	| 'connecting'
	| 'connected'
	/** The host was lost; retrying with backoff. */
	| 'reconnecting'
	/** No host is running; watching for one to start. */
	| 'waiting-for-host';

export interface ConnectionApi {
	/** Is a host serving this data dir? Reads only; opens no connection. */
	discover(): Promise<ClientResult<HostInfo>>;
	/**
	 * Attach to the host. One attempt. Once it succeeds, the client keeps the
	 * connection itself (heartbeat, reconnect, resync) until `close()`.
	 */
	connect(): Promise<ClientResult<HostInfo>>;
	/** Try now instead of waiting out the backoff. */
	reconnect(): Promise<ClientResult<HostInfo>>;
	/** Detach. Calls in flight end with `host-unavailable`. Safe to call twice. */
	close(): Promise<void>;
	state(): ConnectionState;
	/** The attached host, or undefined while not connected. */
	host(): HostInfo | undefined;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/** Where an agent's turns run when they run over SSH. */
export interface AgentSshSettings {
	enabled: boolean;
	/** An id from `settings.sshRemotes()`, or null for none. */
	remoteId: string | null;
	workingDirOverride?: string;
}

/** AG-2 and AG-3. */
export interface AgentCreateInput {
	name: string;
	/** Provider id, e.g. `claude-code`: one `providers.list()` reports as available. */
	provider: string;
	cwd: string;
	groupId?: string;
	model?: string;
	effort?: string;
	/** A context window the person chose; recorded as user-edited. */
	contextWindow?: number;
	customPath?: string;
	customArgs?: string;
	/** Blank values (`isBlankEnvValue`) are dropped before sending: blank means unset. */
	env?: Record<string, string>;
	ssh?: AgentSshSettings;
	/** Absent means the default, `.maestro/playbooks` under `cwd`. */
	autoRunFolderPath?: string;
	nudgeMessage?: string;
	newSessionMessage?: string;
}

/**
 * AG-4. Absent means unchanged; `null` clears the field so it inherits again.
 * `env` replaces the whole map, because it is one field on the host.
 */
export interface AgentPatch {
	name?: string;
	cwd?: string;
	/** null moves the agent to ungrouped. */
	groupId?: string | null;
	/** Phase 4 (PS-1). `unsupported` until the host swaps providers without dropping tabs. */
	provider?: string;
	model?: string | null;
	effort?: string | null;
	contextWindow?: number | null;
	customPath?: string | null;
	customArgs?: string | null;
	env?: Record<string, string> | null;
	/** Merged onto the stored settings. */
	ssh?: Partial<AgentSshSettings>;
	autoRunFolderPath?: string;
	nudgeMessage?: string | null;
	newSessionMessage?: string | null;
	bookmarked?: boolean;
}

export type AgentPatchField = keyof AgentPatch;

export interface AgentUpdateReceipt {
	/** The fields applied, in the order they were applied. */
	applied: AgentPatchField[];
	/** Provider swap (Phase 4): what could not be parked and was cleared, for a notice. */
	notices?: string[];
}

export interface AgentsApi {
	/** Every agent, in host order, without transcripts. */
	list(): Promise<ClientResult<AgentRecord[]>>;
	/** One agent, read fresh from the host. An edit form opens on this. */
	get(agentId: string): Promise<ClientResult<AgentRecord>>;
	create(input: AgentCreateInput): Promise<ClientResult<{ agentId: string }>>;
	update(agentId: string, patch: AgentPatch): Promise<ClientResult<AgentUpdateReceipt>>;
	/** Same as `update(agentId, { name })`. */
	rename(agentId: string, name: string): Promise<ClientResult<void>>;
	/**
	 * AG-5. Removes the agent record, its tabs, and the transcripts stored in
	 * them. Kept: the agent's History entries, the provider's own session files,
	 * and the working directory.
	 */
	remove(agentId: string): Promise<ClientResult<void>>;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export interface GroupCreateInput {
	name: string;
	emoji?: string;
	/** Nest under this group. One level only; the host enforces it. */
	parentGroupId?: string;
}

export interface GroupsApi {
	list(): Promise<ClientResult<GroupRecord[]>>;
	create(input: GroupCreateInput): Promise<ClientResult<{ groupId: string }>>;
	rename(groupId: string, name: string): Promise<ClientResult<void>>;
	/** GR-1. Members become ungrouped and child groups move up a level. No agent is deleted. */
	remove(groupId: string): Promise<ClientResult<void>>;
	/** GR-2. `null` moves the agent to ungrouped. */
	moveAgent(agentId: string, groupId: string | null): Promise<ClientResult<void>>;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/** A tab's composer settings (the desktop's tab chips). Absent: unchanged. `null`: inherit. */
export interface TabPatch {
	readOnly?: boolean;
	thinking?: ThinkingMode;
	model?: string | null;
	effort?: string | null;
	saveToHistory?: boolean;
	enterToSend?: boolean | null;
}

export interface TranscriptOptions {
	/** Only entries with a timestamp after this, epoch ms. */
	sinceMs?: number;
	/** At most this many of the newest entries. 0 returns none. */
	tail?: number;
}

export interface TabsApi {
	/** CH-1. The AI tabs a person sees, in strip order. Hidden consult tabs are left out. */
	list(agentId: string): Promise<ClientResult<AITabRecord[]>>;
	create(agentId: string): Promise<ClientResult<{ tabId: string }>>;
	/** An empty name clears it, so the tab shows its session id label again. */
	rename(agentId: string, tabId: string, name: string): Promise<ClientResult<void>>;
	/** The tab moves to the host's closed-tab history. */
	close(agentId: string, tabId: string): Promise<ClientResult<void>>;
	star(agentId: string, tabId: string, starred: boolean): Promise<ClientResult<void>>;
	update(agentId: string, tabId: string, patch: TabPatch): Promise<ClientResult<void>>;
	/** CH-5. The tab's transcript as the host persisted it, oldest first. */
	transcript(
		agentId: string,
		tabId: string,
		options?: TranscriptOptions
	): Promise<ClientResult<LogEntryRecord[]>>;
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

export interface TurnInput {
	/**
	 * What the person typed. The host adds the system prompt, conductor
	 * profile, nudge, and template variables (CH-2).
	 */
	text: string;
	/** P2 (CH-8): images as data URLs. */
	images?: string[];
}

export type TurnSendReceipt =
	/** The agent was idle; the turn is running now. */
	| { status: 'started' }
	/** The agent was busy; the message waits in the host's execution queue (CH-4). */
	| { status: 'queued'; itemId: string; position: number; queueLength: number };

export interface QueuedTurn {
	itemId: string;
	tabId: string;
	queuedAt: number;
	kind: 'message' | 'command';
	/** The message, or the command line of a slash command. */
	text: string;
	/** The host paused the queue on this item. */
	paused: boolean;
}

export interface TurnToolCall {
	/** The provider's call id. A call's running and finished events share it. */
	id?: string;
	name: string;
	status: 'running' | 'completed' | 'error';
	/** Provider-specific input and output. Not validated. */
	detail?: unknown;
	/** Inside a subagent: the parent call's id. */
	parentId?: string;
}

export type TurnEvent =
	/** A message was accepted for this tab, from any surface (CO-2). */
	| { kind: 'user'; at: number; entry: LogEntryRecord }
	/** The tab's agent began working on a turn. */
	| { kind: 'started'; at: number }
	/** The provider assigned or confirmed its session id (CH-5 resume). */
	| { kind: 'session'; at: number; providerSessionId: string }
	/** The live stream the desktop shows as thinking. Show it per the tab's thinking mode. */
	| { kind: 'thinking'; at: number; text: string }
	/** Answer text, in order. Append it. */
	| { kind: 'text'; at: number; text: string }
	| { kind: 'tool'; at: number; tool: TurnToolCall }
	/**
	 * One usage report, exactly as the host's own UI receives it. Do not sum
	 * these into totals: the tab record's `usageStats` is the host's folded
	 * total (refreshed after `outcome`). A live gauge may show the latest report.
	 */
	| { kind: 'usage'; at: number; usage: UsageStats }
	| { kind: 'error'; at: number; error: AgentError }
	/** The turn ended. Always the last event of a turn. */
	| {
			kind: 'outcome';
			at: number;
			outcome: TurnOutcome;
			exitCode: number | null;
			error?: AgentError;
	  }
	/** Events were missed (the host was lost and could not replay). Re-read the tab and its transcript. */
	| { kind: 'gap'; at: number };

export interface TurnsApi {
	/** CH-2, CH-4. Runs now when the agent is idle; otherwise queues behind its current turn. */
	send(agentId: string, tabId: string, input: TurnInput): Promise<ClientResult<TurnSendReceipt>>;
	/** CH-4. Stop the tab's running turn. `stopped: false` when nothing was running. */
	interrupt(agentId: string, tabId: string): Promise<ClientResult<{ stopped: boolean }>>;
	readonly queue: {
		list(agentId: string): Promise<ClientResult<QueuedTurn[]>>;
		remove(agentId: string, itemId: string): Promise<ClientResult<{ removed: boolean }>>;
	};
	/** The tab's turn events, live: the `turn` events of `events.subscribe`, filtered to one tab. */
	subscribe(agentId: string, tabId: string, listener: (event: TurnEvent) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SettingsChange {
	/** The keys that changed, or 'unknown' when the host only said that something did. */
	keys: string[] | 'unknown';
}

export interface SettingsApi {
	/** ST-1. The values of `keys` as the host holds them. A key the host does not hold is absent. */
	get(keys: readonly string[]): Promise<ClientResult<Record<string, unknown>>>;
	/**
	 * Fires when any of `keys` may have changed; re-read with `get`. A change
	 * with `keys: 'unknown'` reaches every subscriber.
	 */
	subscribe(keys: readonly string[], listener: (change: SettingsChange) => void): Unsubscribe;
	/** AG-3. The SSH remotes configured on the host. */
	sshRemotes(): Promise<ClientResult<SshRemoteConfig[]>>;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export interface ProviderInfo {
	/** Provider id, e.g. `claude-code`. */
	id: string;
	/** Display name, e.g. `Claude Code`. */
	name: string;
	/** Installed and runnable where the agent will run. */
	available: boolean;
	/** From the host's capability probe; absent until probed. */
	version?: string;
	/** The binary the host resolved. */
	path?: string;
	/** Why it is unavailable, when the host knows. */
	unavailableReason?: string;
}

export interface ProvidersApi {
	/** AG-2, PS-4. Every provider the host knows, installed or not. Pass an SSH remote to probe that host. */
	list(options?: { sshRemoteId?: string }): Promise<ClientResult<ProviderInfo[]>>;
	/** Model ids the provider reports, for a picker. Empty when it reports none. */
	models(
		providerId: string,
		options?: { sshRemoteId?: string; refresh?: boolean }
	): Promise<ClientResult<string[]>>;
}

// ---------------------------------------------------------------------------
// Events and the client
// ---------------------------------------------------------------------------

export type MaestroEvent =
	| { type: 'host.connected'; host: HostInfo; resumed: boolean }
	| { type: 'host.lost'; reason: string }
	| { type: 'host.reconnecting'; attempt: number; delayMs: number }
	/** The whole state. Follows every `host.connected` with `resumed: false`, before any delta. */
	| { type: 'snapshot'; agents: AgentRecord[]; groups: GroupRecord[] }
	| { type: 'agent.added'; agent: AgentRecord }
	| { type: 'agent.updated'; agent: AgentRecord }
	| { type: 'agent.removed'; agentId: string }
	/** Groups are few and written wholesale, so a change carries the whole list. */
	| { type: 'groups.changed'; groups: GroupRecord[] }
	/** Tab events follow `tabs.list`: hidden consult tabs raise none. */
	| { type: 'tab.added'; agentId: string; tab: AITabRecord }
	| { type: 'tab.updated'; agentId: string; tab: AITabRecord }
	| { type: 'tab.removed'; agentId: string; tabId: string }
	| { type: 'settings.changed'; keys: string[] | 'unknown' }
	| { type: 'turn'; agentId: string; tabId: string; event: TurnEvent };

export type MaestroEventType = MaestroEvent['type'];

export interface EventFilter {
	/** Only these event types. */
	types?: readonly MaestroEventType[];
	/** Only agent, tab, and turn events about this agent. */
	agentId?: string;
}

export interface EventsApi {
	subscribe(listener: (event: MaestroEvent) => void, filter?: EventFilter): Unsubscribe;
}

export interface MaestroClient {
	readonly connection: ConnectionApi;
	readonly agents: AgentsApi;
	readonly groups: GroupsApi;
	readonly tabs: TabsApi;
	readonly turns: TurnsApi;
	readonly settings: SettingsApi;
	readonly providers: ProvidersApi;
	readonly events: EventsApi;
}

// ---------------------------------------------------------------------------
// The WebSocket factory's options
// ---------------------------------------------------------------------------

/** Transport options, kept off the interface (R1). */
export interface WsMaestroClientOptions {
	/** The data dir the caller resolved. Discovery reads `cli-server.json` here. */
	userDataDir: string;
	/** Per call. Default 10000. */
	requestTimeoutMs?: number;
	/** Default 500, doubling to 15000, with 20% jitter. */
	reconnect?: { initialDelayMs?: number; maxDelayMs?: number };
	/** A `ping` every this many ms. Default 15000. */
	heartbeatIntervalMs?: number;
	/** Silence after which the host counts as lost. Default 10000. */
	heartbeatTimeoutMs?: number;
	/** The reconcile poll's period. Default 5000. 0 turns the poll off. */
	reconcileIntervalMs?: number;
	/** Test seams. */
	WebSocketImpl?: typeof import('ws').WebSocket;
	now?: () => number;
}
