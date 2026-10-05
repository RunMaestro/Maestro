/**
 * The agent and group repository (gap L1a): the commands that create, change, and
 * remove agents, groups, and tabs, applied to the store files without a desktop.
 *
 * Each command is a pure rule (`rules.ts`) plus the executor here:
 *
 * - **One at a time.** Commands run through one queue, so two cannot interleave a
 *   read-modify-write on the in-memory documents.
 * - **Commit after write (RT5).** A command computes its next documents, performs
 *   its effects in order, writes through `store/io.ts`, and only then replaces the
 *   in-memory copy and emits. A failed write leaves memory and listeners as they
 *   were and answers `failed`, so `ok` means "applied and on disk".
 * - **Fenced (RT11).** Before every write the fence is asked whether this process is
 *   still the data directory's writer. A fenced repository answers `host-lost`
 *   instead of overwriting whoever took over.
 * - **Live process state (RT14).** Refusals read the process registry, never the
 *   stored `state` or `aiPid`: the desktop persists every agent as idle.
 * - **Events leave only after the commit (RT16)**, `tab.*` first and then one
 *   `agent.updated`.
 * - **Nothing is lost (DD-5).** The documents are kept whole: an entry this build
 *   does not recognize, or a key it has never heard of, is written back as read.
 *
 * Records handed out are projections without `aiTabs[].logs` (R6); a stored object
 * is never handed to a caller.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { workingDirectoryChangeBlocker } from '../../agentWorkingDirectory';
import { isValidAgentId } from '../../agentIds';
import { validateGroupAppearance } from '../../groupAppearance';
import { canSetGroupParent } from '../../groupHierarchy';
import type { Group } from '../../types';
import type {
	AgentCreateInput,
	AgentPatch,
	AgentPatchField,
	AgentUpdateReceipt,
	ClientError,
	ClientErrorCode,
	ClientMethod,
	ClientResult,
	GroupCreateInput,
	GroupPatch,
	MaestroEvent,
	TabPatch,
} from '../client/types';
import { valuesEqual } from '../client/mirror';
import type { EventBus } from '../client/event-bus';
import { listAutoRunDocuments } from '../autorun/documents';
import { logger } from '../host';
import { unusableCwdReason } from '../launch/cwd';
import type { MaestroPaths } from '../paths/resolve';
import type { DataDirVerdict } from '../runtime/data-dir-lock';
import {
	GROUPS_REGISTRY,
	KNOWN_STORE_SCHEMA_VERSION,
	quarantineStoreFile,
	readStoreDocument,
	SESSIONS_REGISTRY,
	StoreWriteError,
	storeSchemaVersion,
	writeStoreDocument,
} from '../store/io';
import type {
	AgentRecord,
	AITabRecord,
	GroupRecord,
	GroupsDocument,
	SessionsDocument,
} from '../store/records';
import {
	agentsOf,
	groupsOf,
	optionalArrayShape,
	projectAgentRecord as project,
	projectTabRecord as projectTab,
	visibleAiTabsOf,
} from '../store/read-stores';
import type { LogEntryRecord } from '../store/transcript';
import {
	archiveClosedTab,
	closedTabsFile,
	readClosedTabs,
	removeClosedTabArchive,
} from './closed-tabs';
import { applyDesktopFold } from './desktop-fold';
import type { DesktopFold, DesktopFoldResult, DesktopSnapshot } from './desktop-fold-types';
import {
	activeAgentAfterRemoval,
	addTabRecord,
	agentsMovingWithParent,
	applyAgentConfigPatch,
	applyTabPatch,
	buildAgentConfigPatch,
	buildAgentRecord,
	buildGroupRecord,
	beginTurnRecord,
	openConsultTabRecord,
	recordConsultAnswerRecord,
	buildTabConfigPatch,
	checkAgentCreateInput,
	checkAgentName,
	closeTabRecord,
	DEFAULT_GROUP_EMOJI,
	DEFAULT_RULE_CONTEXT,
	DEFAULT_TAB_DEFAULTS,
	groupsWithout,
	mergeSshPatch,
	normalizeGroupName,
	recordTabSession,
	relocateAgentPaths,
	sshRecordOf,
	renameTabRecord,
	switchAgentRecordProvider,
	tabDefaultsFromSettings,
	validateAgentRename,
	validateNewAgent,
	type RuleContext,
	type ConsultAnswerRecord,
	type ConsultTabOpen,
	type RuleResult,
	type TabDefaults,
	type TabSessionUpdate,
	type TurnBegin,
} from './rules';

const LOG_CONTEXT = '[AgentRepository]';

// ---------------------------------------------------------------------------
// Options and seams
// ---------------------------------------------------------------------------

/**
 * The part of the process registry the repository reads: whether an agent is
 * working right now, and a way to stop everything it runs. Empty until Phase 6
 * registers turns. The registry binds the terminate stage on `stopAgent` (lib-D5):
 * a deleted agent's output could no longer be recorded.
 */
export interface RepositoryProcesses {
	isBusy(agentId: string, tabId?: string): boolean;
	stopAgent(agentId: string): Promise<void>;
}

export const NO_PROCESSES: RepositoryProcesses = {
	isBusy: () => false,
	stopAgent: async () => undefined,
};

export interface AgentRepositoryOptions {
	paths: MaestroPaths;
	bus: EventBus;
	/** Is this process still the data directory's writer? Asked before every write. Default: always. */
	fence?: () => DataDirVerdict;
	processes?: RepositoryProcesses;
	/** Move a corrupt sessions or groups file aside and start empty, instead of refusing to load (RT8). */
	quarantineCorruptStores?: boolean;
	/** Ids, clock, randomness. */
	context?: Partial<RuleContext>;
	/** The settings a new tab starts from, read fresh. Default: the settings file. */
	readTabDefaults?: () => Promise<TabDefaults>;
	/** Why a local working directory cannot be used, or null. Default: `unusableCwdReason`. */
	checkCwd?: (cwd: string) => string | null;
	/**
	 * How long a desktop fold waits before its coalesced write (DG4). Folds replace the in-memory documents
	 * at once and share one write; 0 means the next tick. Default 250 ms, the desktop's own.
	 */
	foldWriteDelayMs?: number;
}

/** Why the repository could not load its documents. The runtime unions these into `RuntimeRefusal`. */
export type RepositoryLoadFailure =
	| { reason: 'store-corrupt'; file: string; detail: string; message: string }
	| { reason: 'store-too-new'; file: string; version: number; message: string };

export type RepositoryLoadResult = { ok: true } | { ok: false; failure: RepositoryLoadFailure };

export interface AgentRepository {
	/** Read the sessions and groups documents. Call once before anything else. */
	load(): Promise<RepositoryLoadResult>;
	/** Every agent in stored order, without transcripts. */
	listAgents(): AgentRecord[];
	getAgent(agentId: string): AgentRecord | undefined;
	listGroups(): GroupRecord[];
	/** The AI tabs a person sees, in strip order, without transcripts. */
	listTabs(agentId: string): AITabRecord[] | undefined;
	/** One tab with its transcript, hidden consult tabs included. */
	getTab(agentId: string, tabId: string): AITabRecord | undefined;
	/** After this, every command answers `host-lost` with `reason`. Reads still work. */
	fence(reason: string): void;
	/**
	 * Resolves once every command accepted so far has finished, written or failed, and every pending
	 * fold write has been attempted. Shutdown awaits it before releasing the lock.
	 */
	drain(): Promise<void>;

	/** The agent's revision, 0 when unknown. Bumped before the event of every committed change to it (DG5). */
	revisionOf(agentId: string): number;
	/** Bumped before every `groups.changed`. */
	groupsRevision(): number;
	/** The stored records WITH transcripts (the in-memory document, not a projection), and every revision. */
	snapshot(): DesktopSnapshot;
	/** The documents as held, for the main-process store facade. Read only; never held across an await. */
	documents(): { sessions: SessionsDocument; groups: GroupsDocument };
	/** DG8. A group's name, emoji, or parent, checked with `canSetGroupParent`. Write-through. */
	updateGroup(groupId: string, patch: GroupPatch): Promise<ClientResult<void>>;
	/**
	 * Land a desktop fold (4.5). Runs in the command queue; the documents change at once and one coalesced
	 * write follows. Fenced: answers `host-lost`.
	 */
	applyFold(fold: DesktopFold): Promise<ClientResult<DesktopFoldResult>>;
	/** Write every pending fold now. Resolves when durable; rejects when the write fails. */
	flush(): Promise<void>;

	createAgent(input: AgentCreateInput): Promise<ClientResult<{ agentId: string }>>;
	updateAgent(agentId: string, patch: AgentPatch): Promise<ClientResult<AgentUpdateReceipt>>;
	renameAgent(agentId: string, name: string): Promise<ClientResult<void>>;
	removeAgent(agentId: string): Promise<ClientResult<void>>;

	createGroup(input: GroupCreateInput): Promise<ClientResult<{ groupId: string }>>;
	renameGroup(groupId: string, name: string): Promise<ClientResult<void>>;
	removeGroup(groupId: string): Promise<ClientResult<void>>;
	moveAgentToGroup(agentId: string, groupId: string | null): Promise<ClientResult<void>>;

	createTab(agentId: string): Promise<ClientResult<{ tabId: string }>>;
	renameTab(agentId: string, tabId: string, name: string): Promise<ClientResult<void>>;
	closeTab(agentId: string, tabId: string): Promise<ClientResult<void>>;
	starTab(agentId: string, tabId: string, starred: boolean): Promise<ClientResult<void>>;
	updateTab(agentId: string, tabId: string, patch: TabPatch): Promise<ClientResult<void>>;
	/**
	 * Add entries to the end of a tab's transcript (CH-5). Append only: what the tab already
	 * holds is never rewritten, so a turn recorded here cannot cost the person an entry. A
	 * hidden consult tab takes entries like any other.
	 */
	appendTranscript(
		agentId: string,
		tabId: string,
		entries: readonly LogEntryRecord[]
	): Promise<ClientResult<void>>;
	/**
	 * Start a turn on a tab in one write: the person's message joins the transcript, the tab
	 * records which provider owns the turn, and a merged context the prompt carried is cleared.
	 * One write, so a crash cannot leave a message sent but its merge still pending.
	 */
	beginTurn(agentId: string, tabId: string, begin: TurnBegin): Promise<ClientResult<void>>;
	/**
	 * Record what `provider` said about the tab's conversation (its session id, its usage), on
	 * the slot that provider owns. A turn that outlives a provider swap writes its resume token
	 * to the parked slot, never the current provider's.
	 */
	recordTabSession(
		agentId: string,
		tabId: string,
		provider: string,
		update: TabSessionUpdate
	): Promise<ClientResult<void>>;
	/**
	 * Find or create the hidden consult tab an agent keeps for a (source agent, source tab) pairing
	 * and append the question (a consult is a background turn on the consulted agent). The tab is
	 * hidden, never active, raises no tab event and no unread. Answers the tab and the provider
	 * session id to resume, absent on the first consult.
	 */
	openConsultTab(
		agentId: string,
		open: ConsultTabOpen
	): Promise<ClientResult<{ tabId: string; resumeAgentSessionId?: string }>>;
	/**
	 * Record a finished consult on its consult tab in one write: the answer entry, and the
	 * provider session id only when the consult succeeded.
	 */
	recordConsultAnswer(
		agentId: string,
		tabId: string,
		answer: ConsultAnswerRecord
	): Promise<ClientResult<void>>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** A command's whole outcome, computed before anything is written. */
interface Plan<T> {
	value: T;
	/** The next sessions document, when the command changes it. */
	sessions?: SessionsDocument;
	/** The next groups document, when the command changes it. */
	groups?: GroupsDocument;
	/** Runs after validation and before the writes: stop processes, archive a tab. A throw fails the command. */
	before?: () => Promise<void>;
	/** Runs after the writes landed. A failure is logged and never fails the command. */
	after?: () => Promise<void>;
	/** Runs synchronously once the writes landed, before the revisions bump and the events leave. */
	onCommit?: () => void;
	events: MaestroEvent[];
}

type Planned<T> = { ok: true; plan: Plan<T> } | { ok: false; error: ClientError };

/** Thrown by the write path when the fence says this process is no longer the writer. */
class FencedError extends Error {
	constructor(readonly reason: string) {
		super(reason);
		this.name = 'FencedError';
	}
}

/** A tab the person can see: it exists and is not a hidden consult tab. */
function visibleTab(agent: AgentRecord, tabId: string): AITabRecord | undefined {
	return visibleAiTabsOf(agent).find((tab) => tab.id === tabId);
}

function isAgentEntry(entry: unknown): entry is AgentRecord {
	const candidate = entry as Partial<AgentRecord> | null;
	return (
		typeof candidate === 'object' &&
		candidate !== null &&
		typeof candidate.id === 'string' &&
		typeof candidate.name === 'string' &&
		typeof candidate.toolType === 'string'
	);
}

/** An id that is safe to use as a file name under a folder: no separator can climb out of it. */
function isSafeFileId(id: string): boolean {
	return id.length > 0 && !/[\\/]/.test(id) && id !== '.' && id !== '..';
}

/** Removed agents and groups remembered so a stale fold cannot bring one back. Bounded like main's tombstones. */
const TOMBSTONE_LIMIT = 1000;

/** The default wait before a fold's coalesced write: the desktop's own (`WRITE_COALESCE_MS`). */
const DEFAULT_FOLD_WRITE_DELAY_MS = 250;

/** `id` as the newest member of `set`, the oldest dropped past the limit. */
function remember(set: Set<string>, id: string): void {
	set.delete(id);
	set.add(id);
	while (set.size > TOMBSTONE_LIMIT) {
		const oldest = set.values().next().value;
		if (oldest === undefined) break;
		set.delete(oldest);
	}
}

const NO_TAB_IDS: ReadonlySet<string> = new Set();

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const DEFAULT_SESSIONS: SessionsDocument = { sessions: [] };
const DEFAULT_GROUPS: GroupsDocument = { groups: [] };

export function createAgentRepository(options: AgentRepositoryOptions): AgentRepository {
	const { paths, bus } = options;
	const processes = options.processes ?? NO_PROCESSES;
	const ctx: RuleContext = { ...DEFAULT_RULE_CONTEXT, ...options.context };
	const checkCwd = options.checkCwd ?? unusableCwdReason;

	let sessionsDoc: SessionsDocument = DEFAULT_SESSIONS;
	let groupsDoc: GroupsDocument = DEFAULT_GROUPS;
	let fencedReason: string | undefined;
	let chain: Promise<unknown> = Promise.resolve();

	// Revisions (DG5): one per agent and one for the groups, bumped before the event of every committed
	// change so a listener that reads them inside its callback sees the post-commit value.
	const revisions = new Map<string, number>();
	let groupsRev = 0;
	const removedAgents = new Set<string>();
	const removedGroups = new Set<string>();

	// Fold writes (DG4): the documents change at once; one trailing timer writes what is dirty.
	const foldWriteDelayMs = options.foldWriteDelayMs ?? DEFAULT_FOLD_WRITE_DELAY_MS;
	let sessionsDirty = false;
	let groupsDirty = false;
	let foldTimer: ReturnType<typeof setTimeout> | undefined;

	const readTabDefaults =
		options.readTabDefaults ??
		(async (): Promise<TabDefaults> => {
			const read = await readStoreDocument<Record<string, unknown>>(paths.settingsFile);
			return read.status === 'ok' ? tabDefaultsFromSettings(read.data) : DEFAULT_TAB_DEFAULTS;
		});

	const agents = (): AgentRecord[] => agentsOf(sessionsDoc);
	const groups = (): GroupRecord[] => groupsOf(groupsDoc);
	const findAgent = (agentId: string): AgentRecord | undefined =>
		agents().find((agent) => agent.id === agentId);

	// -----------------------------------------------------------------------
	// Failures
	// -----------------------------------------------------------------------

	const failure = (
		method: ClientMethod,
		code: ClientErrorCode,
		message: string,
		extra: Partial<ClientError> = {}
	): { ok: false; error: ClientError } => ({
		ok: false,
		error: { code, message, method, ...extra },
	});

	const noAgent = (method: ClientMethod, agentId: string) =>
		failure(method, 'not-found', `No agent ${agentId}.`);
	const noTab = (method: ClientMethod, tabId: string) =>
		failure(method, 'not-found', `No tab ${tabId}.`);
	const noGroup = (method: ClientMethod, groupId: string) =>
		failure(method, 'not-found', `No group ${groupId}.`);

	/** A thrown error mapped to the failure a caller can act on. */
	function failFromThrown(method: ClientMethod, error: unknown): { ok: false; error: ClientError } {
		if (error instanceof FencedError) return failure(method, 'host-lost', error.reason);
		if (error instanceof StoreWriteError) return failure(method, 'failed', error.message);
		const message = error instanceof Error ? error.message : String(error);
		logger.error(`${method} failed: ${message}`, LOG_CONTEXT);
		return failure(method, 'failed', message);
	}

	// -----------------------------------------------------------------------
	// Writes
	// -----------------------------------------------------------------------

	/** Throws when this process may no longer write. */
	function guardWrite(): void {
		if (fencedReason !== undefined) throw new FencedError(fencedReason);
		const verdict = options.fence?.();
		if (verdict && !verdict.ok) {
			fencedReason = verdict.reason;
			throw new FencedError(verdict.reason);
		}
	}

	/** Run `work` after everything queued before it. A rejection does not stop the queue. */
	function enqueue<T>(work: () => Promise<T>): Promise<T> {
		const next = chain.then(work);
		chain = next.catch(() => undefined);
		return next;
	}

	/** Revisions and tombstones for what a commit or a fold emits. Runs before the events leave. */
	function noteCommitted(events: readonly MaestroEvent[]): void {
		const bumped = new Set<string>();
		let groupsBumped = false;
		for (const event of events) {
			if (event.type === 'agent.added' || event.type === 'agent.updated') {
				const id = event.agent.id;
				if (bumped.has(id)) continue;
				bumped.add(id);
				revisions.set(id, (revisions.get(id) ?? 0) + 1);
			} else if (event.type === 'agent.removed') {
				revisions.delete(event.agentId);
				remember(removedAgents, event.agentId);
			} else if (event.type === 'groups.changed' && !groupsBumped) {
				groupsBumped = true;
				groupsRev += 1;
			}
		}
	}

	function clearFoldTimer(): void {
		if (foldTimer === undefined) return;
		clearTimeout(foldTimer);
		foldTimer = undefined;
	}

	/** Write what a fold left dirty. The caller is in the queue, so the documents cannot change under it. */
	async function writeDirty(): Promise<void> {
		if (!sessionsDirty && !groupsDirty) return;
		guardWrite();
		if (sessionsDirty) {
			await writeStoreDocument(paths.sessionsFile, sessionsDoc, {
				registry: SESSIONS_REGISTRY,
				memoKey: 'sessions',
			});
			sessionsDirty = false;
		}
		if (groupsDirty) {
			await writeStoreDocument(paths.groupsFile, groupsDoc, { registry: GROUPS_REGISTRY });
			groupsDirty = false;
		}
	}

	/** One trailing write for however many folds arrive inside the delay. It never throws into the timer. */
	function scheduleFoldWrite(): void {
		if ((!sessionsDirty && !groupsDirty) || foldTimer !== undefined) return;
		foldTimer = setTimeout(() => {
			foldTimer = undefined;
			void enqueue(async () => {
				try {
					await writeDirty();
				} catch (error) {
					// Still dirty: the next fold, command, or flush writes it.
					logger.warn(`The deferred fold write failed: ${errorText(error)}`, LOG_CONTEXT);
				}
			});
		}, foldWriteDelayMs);
		(foldTimer as { unref?: () => void }).unref?.();
	}

	async function run<T>(
		method: ClientMethod,
		planner: () => Promise<Planned<T>> | Planned<T>
	): Promise<ClientResult<T>> {
		return enqueue(async (): Promise<ClientResult<T>> => {
			try {
				if (fencedReason !== undefined) throw new FencedError(fencedReason);
				const planned = await planner();
				if (!planned.ok) return planned;
				const { plan } = planned;

				if (plan.sessions || plan.groups || plan.before) guardWrite();
				await plan.before?.();

				// Each file's in-memory copy is replaced as soon as ITS write lands, so a
				// failure on the second file leaves memory describing what is on disk.
				// The document is whole, so this write carries whatever a fold already put in memory.
				if (plan.sessions) {
					guardWrite();
					await writeStoreDocument(paths.sessionsFile, plan.sessions, {
						registry: SESSIONS_REGISTRY,
						memoKey: 'sessions',
					});
					sessionsDoc = plan.sessions;
					sessionsDirty = false;
				}
				if (plan.groups) {
					guardWrite();
					await writeStoreDocument(paths.groupsFile, plan.groups, { registry: GROUPS_REGISTRY });
					groupsDoc = plan.groups;
					groupsDirty = false;
				}
				if (!sessionsDirty && !groupsDirty) clearFoldTimer();
				plan.onCommit?.();

				if (plan.after) {
					try {
						await plan.after();
					} catch (error) {
						logger.warn(
							`${method}: cleanup after the write failed: ${error instanceof Error ? error.message : String(error)}`,
							LOG_CONTEXT
						);
					}
				}
				noteCommitted(plan.events);
				bus.emitAll(plan.events);
				return { ok: true, value: plan.value };
			} catch (error) {
				return failFromThrown(method, error);
			}
		});
	}

	// -----------------------------------------------------------------------
	// Document edits
	// -----------------------------------------------------------------------

	/** The sessions document with `updates` swapped in by id. Entries this build does not recognize stay put. */
	function withAgents(updates: ReadonlyMap<string, AgentRecord>): SessionsDocument {
		const entries = Array.isArray(sessionsDoc.sessions) ? sessionsDoc.sessions : [];
		return {
			...sessionsDoc,
			sessions: entries.map((entry) =>
				isAgentEntry(entry) && updates.has(entry.id) ? updates.get(entry.id) : entry
			),
		};
	}

	const withGroups = (next: readonly GroupRecord[]): GroupsDocument => ({
		...groupsDoc,
		groups: [...next],
	});

	/** `tab.updated` for each visible tab that changed, then one `agent.updated`. */
	function updateEvents(before: AgentRecord, after: AgentRecord): MaestroEvent[] {
		const events: MaestroEvent[] = [];
		const was = new Map(visibleAiTabsOf(before).map((tab) => [tab.id, tab]));
		for (const tab of visibleAiTabsOf(after)) {
			const old = was.get(tab.id);
			if (old && old !== tab && !valuesEqual(old, tab)) {
				events.push({ type: 'tab.updated', agentId: after.id, tab: projectTab(tab) });
			}
		}
		events.push({ type: 'agent.updated', agent: project(after) });
		return events;
	}

	// -----------------------------------------------------------------------
	// Loading
	// -----------------------------------------------------------------------

	async function loadDocument<T extends Record<string, unknown>>(
		file: string,
		key: 'sessions' | 'groups',
		defaults: T
	): Promise<{ ok: true; doc: T } | { ok: false; failure: RepositoryLoadFailure }> {
		const read = await readStoreDocument<T>(file, optionalArrayShape(key));
		if (read.status === 'missing') return { ok: true, doc: defaults };
		if (read.status === 'ok') {
			const version = storeSchemaVersion(read.data);
			if (version > KNOWN_STORE_SCHEMA_VERSION) {
				return {
					ok: false,
					failure: {
						reason: 'store-too-new',
						file,
						version,
						message: `${path.basename(file)} uses store schema ${version}, newer than this build knows. Update maestro-cli.`,
					},
				};
			}
			return { ok: true, doc: read.data };
		}
		if (read.status === 'corrupt' && options.quarantineCorruptStores) {
			const sidecar = await quarantineStoreFile(file);
			logger.warn(`${path.basename(file)} was not valid; kept as ${sidecar}`, LOG_CONTEXT);
			return { ok: true, doc: defaults };
		}
		return {
			ok: false,
			failure: {
				reason: 'store-corrupt',
				file,
				detail: read.reason,
				message: `${path.basename(file)} could not be read: ${read.reason}`,
			},
		};
	}

	async function load(): Promise<RepositoryLoadResult> {
		const sessions = await loadDocument<SessionsDocument>(
			paths.sessionsFile,
			'sessions',
			DEFAULT_SESSIONS
		);
		if (!sessions.ok) return sessions;
		const loadedGroups = await loadDocument<GroupsDocument>(
			paths.groupsFile,
			'groups',
			DEFAULT_GROUPS
		);
		if (!loadedGroups.ok) return loadedGroups;
		sessionsDoc = sessions.doc;
		groupsDoc = loadedGroups.doc;
		return { ok: true };
	}

	// -----------------------------------------------------------------------
	// Agents
	// -----------------------------------------------------------------------

	function createAgent(input: AgentCreateInput): Promise<ClientResult<{ agentId: string }>> {
		const method: ClientMethod = 'agents.create';
		return run(method, async () => {
			const checked = checkAgentCreateInput(input);
			if (!checked.ok) return failure(method, checked.code, checked.message);

			// Client-chosen ids (DG10): the caller's optimistic record and this one are the same record.
			if (input.id !== undefined) {
				if (!input.id.trim()) return failure(method, 'invalid', 'The agent id cannot be empty.');
				if (!isSafeFileId(input.id)) {
					return failure(method, 'invalid', `"${input.id}" cannot be used as an agent id.`);
				}
				if (findAgent(input.id)) {
					return failure(method, 'invalid', `An agent with the id "${input.id}" already exists.`);
				}
				if (removedAgents.has(input.id)) {
					return failure(
						method,
						'invalid',
						`The agent id "${input.id}" belonged to a removed agent.`
					);
				}
			}
			if (input.tabId !== undefined) {
				if (!input.tabId.trim()) return failure(method, 'invalid', 'The tab id cannot be empty.');
				if (!isSafeFileId(input.tabId)) {
					return failure(method, 'invalid', `"${input.tabId}" cannot be used as a tab id.`);
				}
			}

			const ssh = input.ssh?.enabled ? input.ssh : undefined;
			const validation = validateNewAgent(
				checked.value.name,
				checked.value.cwd,
				agents(),
				ssh?.remoteId ?? null
			);
			if (!validation.valid) {
				return failure(method, 'invalid', validation.error ?? 'The agent cannot be created.');
			}
			if (input.groupId && !groups().some((group) => group.id === input.groupId)) {
				return noGroup(method, input.groupId);
			}
			// A directory that only exists on another machine is the SSH remote's business.
			if (!ssh) {
				const reason = checkCwd(checked.value.cwd);
				if (reason) return failure(method, 'invalid', reason);
			}

			const defaults = await readTabDefaults();
			const { agent } = buildAgentRecord(input, checked.value, ctx, defaults);
			return {
				ok: true,
				plan: {
					value: { agentId: agent.id },
					sessions: {
						...sessionsDoc,
						sessions: [...(sessionsDoc.sessions ?? []), agent],
					},
					events: [{ type: 'agent.added', agent: project(agent) }],
				},
			};
		});
	}

	function updateAgent(
		agentId: string,
		patch: AgentPatch
	): Promise<ClientResult<AgentUpdateReceipt>> {
		const method: ClientMethod = 'agents.update';
		return run(method, async () => {
			const before = findAgent(agentId);
			if (!before) return noAgent(method, agentId);

			// Every check that needs no state runs before any change: one transaction (RT12).
			if (
				patch.provider !== undefined &&
				(patch.provider === 'terminal' || !isValidAgentId(patch.provider))
			) {
				return failure(method, 'invalid', `Unknown provider "${patch.provider}".`);
			}
			let name: string | undefined;
			if (patch.name !== undefined) {
				const checkedName = checkAgentName(patch.name);
				if (!checkedName.ok) return failure(method, checkedName.code, checkedName.message);
				const taken = validateAgentRename(checkedName.value, agentId, agents());
				if (!taken.valid) return failure(method, 'invalid', taken.error ?? 'That name is taken.');
				name = checkedName.value;
			}
			if (patch.cwd !== undefined && !patch.cwd.trim()) {
				return failure(method, 'invalid', 'The working directory cannot be empty.');
			}
			if (patch.autoRunFolderPath !== undefined && !patch.autoRunFolderPath.trim()) {
				return failure(method, 'invalid', 'The Auto Run folder cannot be empty.');
			}
			if (patch.groupId && !groups().some((group) => group.id === patch.groupId)) {
				return noGroup(method, patch.groupId);
			}

			const busy = processes.isBusy(agentId);
			const applied: AgentPatchField[] = [];
			let notices: string[] | undefined;
			let next: AgentRecord = before;

			if (patch.cwd !== undefined) {
				// A spawned process keeps the directory it launched with.
				const blocker = workingDirectoryChangeBlocker({ state: busy ? 'busy' : undefined });
				if (blocker) return failure(method, 'rejected', blocker);
				const remote = sshRecordOf(before.sessionSshRemoteConfig)?.enabled === true;
				const unusable = remote ? null : checkCwd(patch.cwd.trim());
				if (unusable) return failure(method, 'invalid', unusable);
				next = relocateAgentPaths(next, patch.cwd);
				applied.push('cwd');
			}

			if (patch.ssh !== undefined) {
				if (busy) {
					return failure(
						method,
						'rejected',
						'Agent process is running; stop it before changing SSH config.'
					);
				}
				next = {
					...next,
					sessionSshRemoteConfig: mergeSshPatch(
						sshRecordOf(next.sessionSshRemoteConfig),
						patch.ssh
					),
				};
				applied.push('ssh');
			}

			// The provider swap runs before the config fields, so a model or path in the
			// same update lands on the new provider's slot. A turn in flight finishes
			// under the provider that started it, so a busy agent may switch.
			if (patch.provider !== undefined && patch.provider !== next.toolType) {
				const switched = switchAgentRecordProvider(next, patch.provider);
				next = switched.agent;
				if (switched.notices.length > 0) notices = switched.notices;
				applied.push('provider');
			}

			const config = buildAgentConfigPatch(patch);
			if (config.fields.length > 0) {
				const result = applyAgentConfigPatch(next, config.patch);
				if (!result.ok) return failure(method, result.code, result.message);
				next = result.value;
				applied.push(...config.fields);
			}

			if (name !== undefined) {
				next = { ...next, name };
				applied.push('name');
			}

			const changed = new Map<string, AgentRecord>();
			if (patch.groupId !== undefined) {
				for (const id of agentsMovingWithParent(agents(), agentId)) {
					const member = id === agentId ? next : findAgent(id);
					if (!member) continue;
					const moved = { ...member };
					if (patch.groupId) moved.groupId = patch.groupId;
					else delete moved.groupId;
					if (id === agentId) next = moved;
					else changed.set(id, moved);
				}
				applied.push('groupId');
			}

			if (patch.autoRunFolderPath !== undefined) {
				if (sshRecordOf(next.sessionSshRemoteConfig)?.enabled) {
					return failure(
						method,
						'unsupported',
						'Changing the Auto Run folder of an SSH agent needs the desktop.'
					);
				}
				const root = next.projectRoot || next.cwd || '';
				const requested = patch.autoRunFolderPath.trim();
				const folder = path.isAbsolute(requested) ? requested : path.resolve(root, requested);
				const listing = listAutoRunDocuments(folder);
				if (listing.status !== 'ok') {
					return failure(
						method,
						'invalid',
						listing.status === 'missing'
							? `The Auto Run folder does not exist: ${folder}`
							: `The Auto Run folder cannot be read: ${listing.reason}`
					);
				}
				const { autoRunSelectedFile: _selected, autoRunContent: _content, ...rest } = next;
				next = {
					...rest,
					autoRunFolderPath: folder,
					...(listing.documents[0] ? { autoRunSelectedFile: listing.documents[0].name } : {}),
					// The cached document belonged to the old folder: the desktop reloads it.
					autoRunContentVersion:
						(typeof next.autoRunContentVersion === 'number' ? next.autoRunContentVersion : 0) + 1,
				} as AgentRecord;
				applied.push('autoRunFolderPath');
			}

			const receipt: AgentUpdateReceipt = { applied, ...(notices ? { notices } : {}) };
			if (applied.length === 0) {
				return { ok: true, plan: { value: receipt, events: [] } };
			}

			changed.set(agentId, next);
			const events = updateEvents(before, next);
			for (const [id, member] of changed) {
				if (id !== agentId) {
					const original = findAgent(id);
					if (original) events.push(...updateEvents(original, member));
				}
			}
			return {
				ok: true,
				plan: { value: receipt, sessions: withAgents(changed), events },
			};
		});
	}

	function renameAgent(agentId: string, name: string): Promise<ClientResult<void>> {
		const method: ClientMethod = 'agents.rename';
		return run(method, () => {
			const agent = findAgent(agentId);
			if (!agent) return noAgent(method, agentId);
			const checked = checkAgentName(name);
			if (!checked.ok) return failure(method, checked.code, checked.message);
			const taken = validateAgentRename(checked.value, agentId, agents());
			if (!taken.valid) return failure(method, 'invalid', taken.error ?? 'That name is taken.');
			if (agent.name === checked.value) return { ok: true, plan: { value: undefined, events: [] } };
			const next = { ...agent, name: checked.value };
			return {
				ok: true,
				plan: {
					value: undefined,
					sessions: withAgents(new Map([[agentId, next]])),
					events: [{ type: 'agent.updated', agent: project(next) }],
				},
			};
		});
	}

	function removeAgent(agentId: string): Promise<ClientResult<void>> {
		const method: ClientMethod = 'agents.remove';
		return run(method, () => {
			const agent = findAgent(agentId);
			if (!agent) return noAgent(method, agentId);
			const entries = Array.isArray(sessionsDoc.sessions) ? sessionsDoc.sessions : [];
			const survivors = entries.filter((entry) => !(isAgentEntry(entry) && entry.id === agentId));
			const active = activeAgentAfterRemoval(
				survivors.filter(isAgentEntry),
				agentId,
				sessionsDoc.activeSessionId
			);
			const next: SessionsDocument = { ...sessionsDoc, sessions: survivors };
			if (active !== undefined) next.activeSessionId = active;
			return {
				ok: true,
				plan: {
					value: undefined,
					sessions: next,
					// Every process of the agent, every tab's, not only the legacy `-ai` id (G6).
					before: () => processes.stopAgent(agentId),
					// Kept: History, the provider's own session files, the working directory (AG-5).
					after: async () => {
						if (isSafeFileId(agentId)) {
							await fs.rm(path.join(paths.userDataDir, 'playbooks', `${agentId}.json`), {
								force: true,
							});
						}
						await removeClosedTabArchive(paths.syncDir, agentId);
					},
					events: [{ type: 'agent.removed', agentId }],
				},
			};
		});
	}

	// -----------------------------------------------------------------------
	// Groups
	// -----------------------------------------------------------------------

	function createGroup(input: GroupCreateInput): Promise<ClientResult<{ groupId: string }>> {
		const method: ClientMethod = 'groups.create';
		return run(method, () => {
			const built = buildGroupRecord(input, groups(), ctx);
			if (!built.ok) return failure(method, built.code, built.message);
			const next = [...groups(), built.value];
			return {
				ok: true,
				plan: {
					value: { groupId: built.value.id },
					groups: withGroups(next),
					events: [{ type: 'groups.changed', groups: next }],
				},
			};
		});
	}

	function renameGroup(groupId: string, name: string): Promise<ClientResult<void>> {
		const method: ClientMethod = 'groups.rename';
		return run(method, () => {
			if (!groups().some((group) => group.id === groupId)) return noGroup(method, groupId);
			const normalized = normalizeGroupName(name);
			if (!normalized) return failure(method, 'invalid', 'The group needs a name.');
			const next = groups().map((group) =>
				group.id === groupId ? { ...group, name: normalized } : group
			);
			return {
				ok: true,
				plan: {
					value: undefined,
					groups: withGroups(next),
					events: [{ type: 'groups.changed', groups: next }],
				},
			};
		});
	}

	/** Members become ungrouped and child groups move up a level. No agent is deleted (GR-1). */
	function removeGroup(groupId: string): Promise<ClientResult<void>> {
		const method: ClientMethod = 'groups.remove';
		return run(method, () => {
			if (!groups().some((group) => group.id === groupId)) return noGroup(method, groupId);
			const members = agents().filter((agent) => agent.groupId === groupId);
			const ungrouped = new Map<string, AgentRecord>();
			for (const member of members) {
				const { groupId: _gone, ...rest } = member;
				ungrouped.set(member.id, rest as AgentRecord);
			}
			const next = groupsWithout(groups(), groupId);
			return {
				ok: true,
				plan: {
					value: undefined,
					onCommit: () => remember(removedGroups, groupId),
					// Members first: if the groups write then fails, nothing is lost, the group is just empty.
					...(ungrouped.size > 0 ? { sessions: withAgents(ungrouped) } : {}),
					groups: withGroups(next),
					events: [
						...[...ungrouped.values()].map(
							(agent): MaestroEvent => ({ type: 'agent.updated', agent: project(agent) })
						),
						{ type: 'groups.changed', groups: next },
					],
				},
			};
		});
	}

	/** `null` is ungrouped. Worktree children follow their parent. */
	function moveAgentToGroup(agentId: string, groupId: string | null): Promise<ClientResult<void>> {
		const method: ClientMethod = 'groups.moveAgent';
		return run(method, () => {
			const agent = findAgent(agentId);
			if (!agent) return noAgent(method, agentId);
			if (groupId && !groups().some((group) => group.id === groupId))
				return noGroup(method, groupId);

			const moved = new Map<string, AgentRecord>();
			for (const id of agentsMovingWithParent(agents(), agentId)) {
				const member = findAgent(id);
				if (!member || (member.groupId ?? null) === groupId) continue;
				const next = { ...member };
				if (groupId) next.groupId = groupId;
				else delete next.groupId;
				moved.set(id, next);
			}
			if (moved.size === 0) return { ok: true, plan: { value: undefined, events: [] } };
			return {
				ok: true,
				plan: {
					value: undefined,
					sessions: withAgents(moved),
					events: [...moved.values()].map(
						(next): MaestroEvent => ({ type: 'agent.updated', agent: project(next) })
					),
				},
			};
		});
	}

	/**
	 * DG8. A group's name, emoji, or parent. The parent is checked with `canSetGroupParent` (one level of
	 * nesting, an existing top-level parent, no cycle); `null` or an empty id moves the group to the top
	 * level. A patch that changes nothing writes nothing and says nothing.
	 */
	function updateGroup(groupId: string, patch: GroupPatch): Promise<ClientResult<void>> {
		const method: ClientMethod = 'groups.update';
		return run(method, () => {
			const list = groups();
			const group = list.find((candidate) => candidate.id === groupId);
			if (!group) return noGroup(method, groupId);

			let next: GroupRecord = group;
			if (patch.name !== undefined) {
				const normalized = normalizeGroupName(patch.name);
				if (!normalized) return failure(method, 'invalid', 'The group needs a name.');
				next = { ...next, name: normalized };
			}
			if (patch.emoji !== undefined) {
				const appearance = validateGroupAppearance({ emoji: patch.emoji });
				if (!appearance.ok) return failure(method, 'invalid', appearance.error);
				next = { ...next, emoji: appearance.value.emoji || DEFAULT_GROUP_EMOJI };
			}
			// Icon and color: null clears, a string is validated like a create.
			for (const key of ['icon', 'color'] as const) {
				const value = patch[key];
				if (value === undefined) continue;
				if (value === null) {
					const { [key]: _cleared, ...rest } = next;
					next = rest as GroupRecord;
					continue;
				}
				const look = validateGroupAppearance({ [key]: value });
				if (!look.ok) return failure(method, 'invalid', look.error);
				next = { ...next, [key]: look.value[key] };
			}
			if (patch.parentGroupId !== undefined) {
				const parent = patch.parentGroupId || undefined;
				if (!canSetGroupParent(list as unknown as Group[], groupId, parent)) {
					return failure(
						method,
						'invalid',
						'A group can only be nested one level deep, inside an existing top-level group.'
					);
				}
				if (parent) {
					next = { ...next, parentGroupId: parent };
				} else if (next.parentGroupId !== undefined) {
					const { parentGroupId: _top, ...rest } = next;
					next = rest;
				}
			}

			if (next === group || valuesEqual(next, group)) {
				return { ok: true, plan: { value: undefined, events: [] } };
			}
			const updated = list.map((candidate) => (candidate.id === groupId ? next : candidate));
			return {
				ok: true,
				plan: {
					value: undefined,
					groups: withGroups(updated),
					events: [{ type: 'groups.changed', groups: updated }],
				},
			};
		});
	}

	// -----------------------------------------------------------------------
	// Tabs
	// -----------------------------------------------------------------------

	/** One tab-level change on one agent: find both, apply `change`, emit `tab.updated` then `agent.updated`. */
	function changeTab(
		method: ClientMethod,
		agentId: string,
		tabId: string,
		change: (tab: AITabRecord) => RuleResult<AITabRecord>
	): Promise<ClientResult<void>> {
		return run(method, () => {
			const agent = findAgent(agentId);
			if (!agent) return noAgent(method, agentId);
			const tab = visibleTab(agent, tabId);
			if (!tab) return noTab(method, tabId);
			const result = change(tab);
			if (!result.ok) return failure(method, result.code, result.message);
			const changed = result.value;
			if (changed === tab || valuesEqual(changed, tab)) {
				return { ok: true, plan: { value: undefined, events: [] } };
			}
			const next: AgentRecord = {
				...agent,
				aiTabs: (agent.aiTabs ?? []).map((entry) => (entry.id === tabId ? changed : entry)),
			};
			return {
				ok: true,
				plan: {
					value: undefined,
					sessions: withAgents(new Map([[agentId, next]])),
					events: updateEvents(agent, next),
				},
			};
		});
	}

	function createTab(agentId: string): Promise<ClientResult<{ tabId: string }>> {
		const method: ClientMethod = 'tabs.create';
		return run(method, async () => {
			const agent = findAgent(agentId);
			if (!agent) return noAgent(method, agentId);
			const { agent: next, tab } = addTabRecord(agent, ctx, await readTabDefaults());
			return {
				ok: true,
				plan: {
					value: { tabId: tab.id },
					sessions: withAgents(new Map([[agentId, next]])),
					events: [
						{ type: 'tab.added', agentId, tab: projectTab(tab) },
						{ type: 'agent.updated', agent: project(next) },
					],
				},
			};
		});
	}

	const renameTab = (agentId: string, tabId: string, name: string) =>
		changeTab('tabs.rename', agentId, tabId, (tab) => ({
			ok: true,
			value: renameTabRecord(tab, name),
		}));

	const starTab = (agentId: string, tabId: string, starred: boolean) =>
		changeTab('tabs.star', agentId, tabId, (tab) => applyTabPatch(tab, { starred }));

	const updateTab = (agentId: string, tabId: string, patch: TabPatch) => {
		const record = buildTabConfigPatch(patch);
		return changeTab('tabs.update', agentId, tabId, (tab) =>
			Object.keys(record).length === 0 ? { ok: true, value: tab } : applyTabPatch(tab, record)
		);
	};

	/**
	 * Rewrite one tab, hidden consult tabs included, and say so: `tab.updated` (for a tab a person
	 * can see) then `agent.updated`. These are internal writes that report under the tab update
	 * they amount to. Not `updateEvents`: it compares the old and new tab deeply, and a transcript
	 * is the one field that is large and known to have changed.
	 */
	function rewriteTab(
		agentId: string,
		tabId: string,
		rewrite: (tab: AITabRecord, agent: AgentRecord) => AITabRecord
	): Promise<ClientResult<void>> {
		const method: ClientMethod = 'tabs.update';
		return run(method, () => {
			const agent = findAgent(agentId);
			if (!agent) return noAgent(method, agentId);
			const tab = agent.aiTabs?.find((candidate) => candidate.id === tabId);
			if (!tab) return noTab(method, tabId);
			const changed = rewrite(tab, agent);
			if (changed === tab) return { ok: true, plan: { value: undefined, events: [] } };
			const next: AgentRecord = {
				...agent,
				aiTabs: (agent.aiTabs ?? []).map((entry) => (entry.id === tabId ? changed : entry)),
			};
			const events: MaestroEvent[] = visibleTab(agent, tabId)
				? [{ type: 'tab.updated', agentId, tab: projectTab(changed) }]
				: [];
			events.push({ type: 'agent.updated', agent: project(next) });
			return {
				ok: true,
				plan: { value: undefined, sessions: withAgents(new Map([[agentId, next]])), events },
			};
		});
	}

	const appendTranscript = (agentId: string, tabId: string, entries: readonly LogEntryRecord[]) =>
		rewriteTab(agentId, tabId, (tab) =>
			entries.length === 0
				? tab
				: { ...tab, logs: [...(Array.isArray(tab.logs) ? tab.logs : []), ...entries] }
		);

	const beginTurn = (agentId: string, tabId: string, begin: TurnBegin) =>
		rewriteTab(agentId, tabId, (tab) => beginTurnRecord(tab, begin));

	const recordSession = (
		agentId: string,
		tabId: string,
		provider: string,
		update: TabSessionUpdate
	) => rewriteTab(agentId, tabId, (tab, agent) => recordTabSession(tab, agent, provider, update));

	function openConsultTab(
		agentId: string,
		open: ConsultTabOpen
	): Promise<ClientResult<{ tabId: string; resumeAgentSessionId?: string }>> {
		const method: ClientMethod = 'tabs.create';
		return run(method, async () => {
			const agent = findAgent(agentId);
			if (!agent) return noAgent(method, agentId);
			const opened = openConsultTabRecord(agent, open, ctx, await readTabDefaults());
			const value = {
				tabId: opened.tab.id,
				...(opened.resumeAgentSessionId
					? { resumeAgentSessionId: opened.resumeAgentSessionId }
					: {}),
			};
			// No `tab.added` or `tab.updated`: the tab is hidden, and a client's view of the agent does
			// not change. `agent.updated` keeps a mirror's copy of the record current.
			return {
				ok: true,
				plan: {
					value,
					sessions: withAgents(new Map([[agentId, opened.agent]])),
					events: [{ type: 'agent.updated', agent: project(opened.agent) }],
				},
			};
		});
	}

	const recordConsultAnswer = (agentId: string, tabId: string, answer: ConsultAnswerRecord) =>
		rewriteTab(agentId, tabId, (tab, agent) => recordConsultAnswerRecord(tab, agent, answer));

	/**
	 * Close a tab into the closed-tab archive (RT6), never deleting its transcript.
	 * The archive is written first: a failure between the two writes leaves the tab
	 * open and also archived. A tab with a turn running is refused until it stops,
	 * since closing it would orphan a process whose output nothing could record.
	 */
	function closeTab(agentId: string, tabId: string): Promise<ClientResult<void>> {
		const method: ClientMethod = 'tabs.close';
		return run(method, async () => {
			const agent = findAgent(agentId);
			if (!agent) return noAgent(method, agentId);
			if (!visibleTab(agent, tabId)) return noTab(method, tabId);
			if (processes.isBusy(agentId, tabId)) {
				return failure(
					method,
					'rejected',
					'The tab has a turn running. Stop it before closing the tab.'
				);
			}
			const outcome = closeTabRecord(agent, tabId, ctx, await readTabDefaults());
			if (!outcome) return noTab(method, tabId);
			const events: MaestroEvent[] = [{ type: 'tab.removed', agentId, tabId }];
			if (outcome.freshTab) {
				events.push({ type: 'tab.added', agentId, tab: projectTab(outcome.freshTab) });
			}
			events.push({ type: 'agent.updated', agent: project(outcome.agent) });
			return {
				ok: true,
				plan: {
					value: undefined,
					before: () => archiveClosedTab(paths.syncDir, agentId, outcome.closed),
					sessions: withAgents(new Map([[agentId, outcome.agent]])),
					events,
				},
			};
		});
	}

	// -----------------------------------------------------------------------
	// The desktop fold and its write
	// -----------------------------------------------------------------------

	/** Every agent's revision, 0 for one the runtime has never changed. */
	function revisionsOfAll(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const agent of agents()) out[agent.id] = revisions.get(agent.id) ?? 0;
		return out;
	}

	/**
	 * Land a desktop fold (4.5): the pure applier decides, this commits. Archives first (RT6), then the
	 * in-memory documents change at once and ONE coalesced write follows (DG4). Events leave with the
	 * revisions already bumped, `agent.removed` first and `groups.changed` last. A fold that changes
	 * nothing stored writes nothing and says nothing.
	 */
	function applyFold(fold: DesktopFold): Promise<ClientResult<DesktopFoldResult>> {
		const method: ClientMethod = 'desktop.fold';
		return enqueue(async (): Promise<ClientResult<DesktopFoldResult>> => {
			try {
				// A fenced repository never lands a fold: the data directory is someone else's now.
				guardWrite();

				// The archive is the tab tombstone, read only for the agents that adopt a tab.
				const closedTabs = new Map<string, ReadonlySet<string>>();
				for (const entry of fold.agents ?? []) {
					if (!entry.adoptTabs || entry.adoptTabs.length === 0) continue;
					const archived = await readClosedTabs(closedTabsFile(paths.syncDir, entry.id));
					closedTabs.set(entry.id, new Set(archived.map((closed) => closed.tab.id)));
				}
				const closing = (fold.agents ?? []).some((entry) => (entry.closeTabs?.length ?? 0) > 0);
				const defaults = closing ? await readTabDefaults() : DEFAULT_TAB_DEFAULTS;

				const plan = applyDesktopFold(
					{
						sessions: sessionsDoc,
						groups: groupsDoc,
						revisionOf: (agentId) => revisions.get(agentId) ?? 0,
						groupsRev,
						removedAgentIds: removedAgents,
						removedGroupIds: removedGroups,
						closedTabIds: (agentId) => closedTabs.get(agentId) ?? NO_TAB_IDS,
					},
					fold,
					{ ctx, defaults }
				);

				// A closed tab is archived before it leaves the record, so a failure between the two
				// writes leaves it open and also archived, never lost.
				for (const item of plan.archive) {
					await archiveClosedTab(paths.syncDir, item.agentId, item.closed);
				}

				if (plan.sessions) {
					sessionsDoc = plan.sessions;
					sessionsDirty = true;
				}
				if (plan.groups) {
					groupsDoc = plan.groups;
					groupsDirty = true;
				}
				for (const id of plan.tombstoneAgents) remember(removedAgents, id);
				for (const id of plan.tombstoneGroups) remember(removedGroups, id);
				noteCommitted(plan.events);
				scheduleFoldWrite();
				bus.emitAll(plan.events);
				return {
					ok: true,
					value: { revs: revisionsOfAll(), groupsRev, drift: plan.drift },
				};
			} catch (error) {
				return failFromThrown(method, error);
			}
		});
	}

	return {
		load,
		listAgents: () => agents().map(project),
		getAgent: (agentId) => {
			const agent = findAgent(agentId);
			return agent ? project(agent) : undefined;
		},
		listGroups: () => groups(),
		listTabs: (agentId) => {
			const agent = findAgent(agentId);
			return agent ? visibleAiTabsOf(agent).map(projectTab) : undefined;
		},
		getTab: (agentId, tabId) => {
			const agent = findAgent(agentId);
			return agent?.aiTabs?.find((tab) => tab.id === tabId);
		},
		fence: (reason) => {
			fencedReason ??= reason;
		},
		drain: async () => {
			await chain;
			// Shutdown: whatever a fold left dirty is written now, while the lock is still held. A failure
			// is logged: there is nobody left to retry it.
			await enqueue(async () => {
				clearFoldTimer();
				try {
					await writeDirty();
				} catch (error) {
					logger.warn(`Writing the pending fold failed: ${errorText(error)}`, LOG_CONTEXT);
				}
			});
		},
		revisionOf: (agentId) => revisions.get(agentId) ?? 0,
		groupsRevision: () => groupsRev,
		snapshot: (): DesktopSnapshot => ({
			agents: agents(),
			groups: groups(),
			activeSessionId: sessionsDoc.activeSessionId ?? '',
			revs: revisionsOfAll(),
			groupsRev,
		}),
		documents: () => ({ sessions: sessionsDoc, groups: groupsDoc }),
		updateGroup,
		applyFold,
		flush: () =>
			enqueue(async () => {
				clearFoldTimer();
				await writeDirty();
			}),
		createAgent,
		updateAgent,
		renameAgent,
		removeAgent,
		createGroup,
		renameGroup,
		removeGroup,
		moveAgentToGroup,
		createTab,
		renameTab,
		closeTab,
		starTab,
		updateTab,
		appendTranscript,
		beginTurn,
		recordTabSession: recordSession,
		openConsultTab,
		recordConsultAnswer,
	};
}
