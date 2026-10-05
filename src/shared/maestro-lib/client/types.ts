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
import type { AutoRunLaunchInput, GoalRunLaunchInput } from '../autorun/launch';
import type { AutoRunRunEvent } from '../autorun/run-tracker';
import type { GroupChatCreateInput, GroupChatEvent, GroupChatRecord } from '../groupchat/chat';

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
	| 'groups.update'
	| 'desktop.fold'
	| 'tabs.list'
	| 'tabs.create'
	| 'tabs.rename'
	| 'tabs.close'
	| 'tabs.star'
	| 'tabs.reorder'
	| 'tabs.update'
	| 'tabs.transcript'
	| 'turns.send'
	| 'turns.interrupt'
	| 'turns.queue.list'
	| 'turns.queue.remove'
	| 'autoRun.launch'
	| 'autoRun.launchGoal'
	| 'autoRun.stop'
	| 'autoRun.resume'
	| 'autoRun.skip'
	| 'autoRun.abort'
	| 'groupChats.list'
	| 'groupChats.get'
	| 'groupChats.create'
	| 'groupChats.send'
	| 'groupChats.stop'
	| 'groupChats.rename'
	| 'groupChats.remove'
	| 'consults.ask'
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
	/** DG6. Keep the remote's History in step with this machine's. The desktop's Edit Agent sets it. */
	syncHistory?: boolean;
	/** DG6. Mirror History into the project directory. Kept even when SSH is off. */
	shareHistoryToProjectDir?: boolean;
}

/** AG-2 and AG-3. */
export interface AgentCreateInput {
	/**
	 * A client-chosen agent id (DG10), so a caller's optimistic record and the host's are the same
	 * record. Refused when taken or unsafe as a file name. Absent: the host picks one.
	 */
	id?: string;
	/** A client-chosen id for the agent's first AI tab (DG10). Same rules as `id`. */
	tabId?: string;
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
	// DG6: what the desktop's New Agent flows set that a script never did. All optional; absent keeps the
	// record exactly as it was built before these existed.
	/** The provider binary (`customProviderPath`), distinct from the agent's own `customPath`. */
	customProviderPath?: string;
	/** Environment variables switched off in the editor: kept on the record, never spawned with. */
	customEnvVarsDisabled?: Record<string, string>;
	/** Extra directories the agent may read and write (the provider's directory grants). */
	additionalDirectories?: string[];
	retryOnAvailabilityErrors?: boolean;
	retryOnTokenExhaustion?: boolean;
	/** Stored only when true: the flag's absence already means off. */
	codexAutoResetOnExhaustion?: boolean;
	/** A worktree agent's parent, branch, and the parent's worktree folder. */
	parentSessionId?: string;
	worktreeBranch?: string;
	worktreeParentPath?: string;
	/** The parent's per-agent worktree settings (`SessionWorktreeConfig`), stored as given. */
	worktreeConfig?: Record<string, unknown>;
	isPianola?: boolean;
	/** Symphony contribution metadata (`SymphonySessionMetadata`), stored as given. */
	symphonyMetadata?: Record<string, unknown>;
	/** The Claude token source: `enableMaestroP`, `maestroPMode`, `maestroPPath`. */
	enableMaestroP?: boolean;
	maestroPPath?: string;
	maestroPMode?: 'interactive' | 'dynamic';
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
	/** PS-1. The host parks every tab's provider session and the agent's overrides; nothing is dropped. */
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
	// DG6: the rest of what the desktop's Edit Agent writes. Each is a config field, so `null` clears it.
	/** The provider binary (`customProviderPath`), distinct from the agent's own `customPath`. */
	customProviderPath?: string | null;
	/** Variables switched off in the editor: kept on the record, never spawned with. Replaces the whole map. */
	envDisabled?: Record<string, string> | null;
	/** Extra directories the agent may read and write. Replaces the whole list. */
	additionalDirectories?: Array<string | Record<string, unknown>> | null;
	retryOnAvailabilityErrors?: boolean | null;
	retryOnTokenExhaustion?: boolean | null;
	/** Codex only. Stored only when true: the flag's absence already means off. */
	codexAutoResetOnExhaustion?: boolean | null;
	/** The Claude token source. `false` is an explicit API choice, distinct from `null` (unset). */
	enableMaestroP?: boolean | null;
	maestroPPath?: string | null;
	maestroPMode?: 'interactive' | 'dynamic' | null;
}

export type AgentPatchField = keyof AgentPatch;

export interface AgentUpdateReceipt {
	/** The fields applied, in the order they were applied. */
	applied: AgentPatchField[];
	/** Provider swap: what the host could not park and cleared, one line each, for a notice. */
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
	/** A client-chosen group id (DG10). Refused when taken. Absent: the host picks one. */
	id?: string;
	name: string;
	emoji?: string;
	/** A built-in or plugin icon id (`groupAppearance`). Kept beside the emoji: the desktop stores both. */
	icon?: string;
	/** `#RRGGBB` or a plugin color id. */
	color?: string;
	/** Nest under this group. One level only; the host enforces it. */
	parentGroupId?: string;
}

/** DG8. Absent means unchanged. Used by the desktop binding (`runtime.desktop.updateGroup`), not part of `GroupsApi`. */
export interface GroupPatch {
	name?: string;
	emoji?: string;
	/** null clears the icon. */
	icon?: string | null;
	/** null clears the color. */
	color?: string | null;
	/** null moves the group to the top level. One level only, checked with `canSetGroupParent`. */
	parentGroupId?: string | null;
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
// Auto Run
// ---------------------------------------------------------------------------

/**
 * AR-4 to AR-7. The run is owned by one desktop window: a launch asks that
 * window to start it, and the controls ask it to act. Nothing here drives the
 * run from this client, and none of it moves the desktop's view (CO-4).
 *
 * There is no `state()` read: the host's `get_auto_run_state` always answers
 * `null` (gap G14), so a run is known only from the `autorun` events, which
 * the host also replays for every live run when a client connects.
 */
export interface AutoRunApi {
	/**
	 * AR-4. Start a spec-driven run over `input.documents`, in that order. Answers
	 * once the desktop has accepted the launch, not when the run ends: watch the
	 * `autorun` events. A busy agent or a missing Auto Run folder is `rejected`.
	 */
	launch(agentId: string, input: AutoRunLaunchInput): Promise<ClientResult<void>>;
	/** AR-5. Start a goal-driven run. `tabId` is the tab the desktop shows it on, when it says. */
	launchGoal(agentId: string, input: GoalRunLaunchInput): Promise<ClientResult<{ tabId?: string }>>;
	/**
	 * AR-7. Ask the owning window to stop after the current task. `ok` means the
	 * request was delivered, as for a tab close: watch the `autorun` events to
	 * see it land.
	 */
	stop(agentId: string): Promise<ClientResult<void>>;
	/** AR-7. Continue a run parked on an error, or pass a HITL gate (the desktop writes the acknowledgement). */
	resume(agentId: string): Promise<ClientResult<void>>;
	/** AR-7. Leave the failing document and go on to the next. */
	skip(agentId: string): Promise<ClientResult<void>>;
	/** AR-7. End a run parked on an error. */
	abort(agentId: string): Promise<ClientResult<void>>;
}

// ---------------------------------------------------------------------------
// Group chats
// ---------------------------------------------------------------------------

/**
 * GC-1 to GC-4. The chats are the desktop's own (same storage, GC-4): one
 * started here continues on the desktop and the other way round. A chat is
 * driven by its moderator, which routes a message to participants, collects
 * their replies, and posts a synthesis; none of that runs in this client.
 *
 * Progress arrives as `groupChat` events (a line landing, the moderator's state,
 * a participant starting or finishing). A participant's reply lands as one
 * line when its turn ends: the bridge carries no partial text for a chat.
 */
export interface GroupChatsApi {
	/** Every chat, without its lines. */
	list(): Promise<ClientResult<GroupChatRecord[]>>;
	/** One chat with its log, read fresh from the host. */
	get(chatId: string): Promise<ClientResult<GroupChatRecord>>;
	/**
	 * GC-1. Creates the chat and sends the moderator its opening message, so the
	 * chat is already running when this answers. Every participant is addressed
	 * by name in that message, which is what makes the router add them.
	 */
	create(input: GroupChatCreateInput): Promise<ClientResult<{ chatId: string }>>;
	/**
	 * GC-2. Send a message to the moderator. A chat takes one round at a time:
	 * while the moderator or a participant is working this is `rejected`, and the
	 * message is not queued.
	 */
	send(chatId: string, message: string): Promise<ClientResult<void>>;
	/** GC-3. Stop the moderator, every participant, and any Auto Run the chat started. */
	stop(chatId: string): Promise<ClientResult<void>>;
	/** GC-1. The desktop's Left Bar reads the new name after its next load (gap G15). */
	rename(chatId: string, name: string): Promise<ClientResult<void>>;
	/**
	 * GC-1. Stops the chat's processes, then deletes its log and images. The
	 * desktop's Left Bar still lists the chat until its next load (gap G15).
	 */
	remove(chatId: string): Promise<ClientResult<void>>;
}

// ---------------------------------------------------------------------------
// Consults
// ---------------------------------------------------------------------------

export interface ConsultAskInput {
	/** The agent to ask. */
	targetAgentId: string;
	/** A self-contained question: no transcript is forwarded unless `withContext`. */
	question: string;
	/** The asking agent, for attribution and for the consult tab the target keeps per asker. */
	fromAgentId?: string;
	/** The asking agent's tab, so the desktop can place its hand-off marker there. */
	fromTabId?: string;
	/** Forward the asking tab's transcript as context. Off by default. */
	withContext?: boolean;
	/** How long to wait for the answer. The host clamps it to 10 seconds through an hour. Default 600000. */
	timeoutMs?: number;
}

export interface ConsultAnswer {
	/** What the consulted agent said. Empty when it answered with nothing. */
	answer: string;
	/** The consulted agent's name, as the host reports it. */
	agentName?: string;
}

/**
 * XM-1 to XM-3. A consult is one question to one agent, read-only, and fully in
 * the background on the consulted agent: it runs in a hidden tab of its own, with
 * no tab chip, no unread mark, and no change to the desktop's view. It is NOT a
 * `turns.send` to the target, which would land in whatever conversation the
 * person has open there.
 */
export interface ConsultsApi {
	/**
	 * Ask `targetAgentId` and wait for the answer, which can take minutes. Not
	 * `ok` when the agent is gone, did not answer in time, or the consult was
	 * stopped; the error message says which. A partial answer is not returned.
	 */
	ask(input: ConsultAskInput): Promise<ClientResult<ConsultAnswer>>;
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
	| { type: 'turn'; agentId: string; tabId: string; event: TurnEvent }
	/**
	 * A run's progress, from the host's `autorun_state` and the run's own
	 * process stream (its output and usage). Fold them with `reduceAutoRun`.
	 */
	| { type: 'autorun'; agentId: string; event: AutoRunRunEvent }
	/**
	 * Something happened in a group chat. Fold it with `reduceGroupChat`. A `gap`
	 * follows a connection that could not resume: re-read the chats you hold.
	 */
	| { type: 'groupChat'; chatId: string; event: GroupChatEvent };

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
	readonly autoRun: AutoRunApi;
	readonly groupChats: GroupChatsApi;
	readonly consults: ConsultsApi;
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
