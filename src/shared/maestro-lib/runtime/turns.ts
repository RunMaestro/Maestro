/**
 * The runtime's turns: send, queue, stop, and the per-tab event stream (CH-2 to CH-5, gap L10).
 *
 * This is the thin owner that joins the pieces Phase 6 built, in the order a turn needs them:
 *
 * | Step | Piece |
 * | --- | --- |
 * | Run now or wait | `createExecutionQueue` (one per agent: a write turn waits for the agent's other tabs) |
 * | Read what a turn needs | `loadTurnContext` |
 * | Decide the prompt and arguments | `assembleTurn` |
 * | Start, stream, stop | `runAgentTurn` (through the library run layer) |
 * | Write the message down | `AgentRepository.beginTurn` |
 * | Say what happened | `createTurnEventMapper`, then the event bus |
 * | Write the turn down | `createTurnRecorder`, then `AgentRepository.recordTabSession` |
 *
 * Rules this owner keeps, so no caller has to:
 *
 * - **A message is never dropped.** A turn that cannot start (the provider is not installed, the
 *   SSH remote does not resolve, the fence closed) leaves its message in the queue, held, and says
 *   why. `send` reports the first failure as an error and the item stays listed until someone
 *   removes it. The queue owns that rule (`dispatch-failed`); this only reports it.
 * - **The message is durable before the provider answers**, and only once the process exists: a
 *   refused launch must not leave a transcript entry that a retry would write a second time.
 * - **`outcome` is the last event of a turn, and it follows the records.** A client that reads the
 *   tab after `outcome` sees the answer, the session id and the folded usage.
 * - **Resume belongs to the provider that issued the id.** The session id is written to the slot of
 *   the provider the turn was sent under, so a swap mid-turn, or swap-and-back after one, resumes
 *   the right conversation.
 *
 * The queue is in memory. A host that exits drops what was waiting; a turn that was running is
 * stopped and recorded as interrupted (`stopAll`), which is what the person asked for by quitting.
 */

import { getClaudeTokenSourceFields, type ClaudeTokenSourceFields } from '../../claudeTokenMode';
import type { GrokLaunchScopePorts } from '../../agentAccountDir';
import { canonicalJson } from '../../canonicalJson';
import type { ToolType } from '../../types';
import type { AgentRepository, TabWriteGuard } from '../agents/repository';
import { matchesNativeSessionBinding, type NativeSessionBinding } from '../agents/providerSwap';
import {
	DEFAULT_RULE_CONTEXT,
	recordTabSession,
	type RuleContext,
	type TabSessionUpdate,
} from '../agents/rules';
import { liftedSendRefusal } from '../agents/lift-pointer';
import { parseMaestroBuiltinCommand, runsOutsideComposer } from '../../maestroBuiltinCommands';
import type { EventBus } from '../client/event-bus';
import type {
	ClientError,
	ClientErrorCode,
	ClientMethod,
	ClientResult,
	QueuedTurn,
	TurnEvent,
	TurnInput,
	TurnOverrides,
	TurnSendReceipt,
	TurnsApi,
	Unsubscribe,
} from '../client/types';
import {
	normalizeOriginHost,
	normalizeTurnOverrides,
	parseQueuedTurnSettings,
	readTurnAgentText,
	readTurnEntryId,
} from '../client/types';
import { logger } from '../host';
import { admitTurnImages, turnImageBoundsError } from '../launch/image-delivery';
import { inlineImageList, withInlineEntryImages } from '../launch/image-refs';
import type { SessionImageStore } from '../store/session-images';
import type { LogEntryRecord } from '../store/transcript';
import { agentIdCanReadImages } from '../providers/capabilities';
import { getAgentDisplayName } from '../../agentMetadata';
import { steeringSocketPathFor } from '../../chatSteeringSocket';
import { isAgentOwnWorkingDirectory } from '../launch/interactive-mode';
import type { BinaryDetectionResult } from '../launch/path-prober';
import { createOutputParser } from '../parsers/parser-factory';
import type { MaestroPaths } from '../paths/resolve';
import {
	createExecutionQueue,
	findQueueMergeTarget,
	joinMergedQueueImages,
	joinMergedQueueText,
	TurnCollisionError,
	type ExecutionQueue,
	type QueueEvent,
	type QueueItem,
	type QueuedTurnHandle,
} from '../turns/queue';
import {
	assembleTurn,
	type AssembledTurn,
	type TurnMessage,
	type TurnTab,
} from '../turns/assemble';
import { loadTurnContext } from '../turns/context';
import { resolveSlashCommand } from '../turns/prompt';
import {
	buildUserTranscriptEntry,
	createTurnRecorder,
	type TurnRecorder,
	type RecordedTurn,
} from '../turns/record-turn';
import { createHistoryWriter, type HistoryWriter } from '../turns/history';
import { toTurnAgent, toTurnTab } from '../turns/records';
import type { CompletedTurn } from '../run/run-to-completion';
import { runAgentTurn, type AgentTurnRun, type RunAgentTurnRefusal } from '../turns/run-agent-turn';
import { createTurnEventMapper, type UnstampedTurnEvent } from '../turns/turn-events';
import { foldLiveTurn, type LiveTurn } from '../client/live-turn';
import {
	createStatsRecorder,
	readStatsCollectionEnabled,
	type StatsConnectionConstructor,
} from '../turns/stats';
import { createRuntimeBuiltinCommands } from './builtin-commands';
import { createRuntimeSideQuestions, type RuntimeSideQuestions } from './side-questions';
import { createRuntimeSteering, type SteeredTurnHandle } from './steering';
import type { DataDirVerdict } from './data-dir-lock';
import type { ProcessRegistry } from './processes';
import { createSshRemoteStore } from './ssh-store';

const LOG_CONTEXT = '[RuntimeTurns]';

/** What the host passes the runtime so it can run turns. Every field is optional. */
export interface RuntimeTurnOptions {
	/** Host directory/endpoint observations; composed by the production runtime. */
	grokLaunchScope?: GrokLaunchScopePorts;
	/**
	 * The host's `better-sqlite3` loader (the CLI's `loadBetterSqlite3`). Absent: a turn records no
	 * usage row, and says so once in the log.
	 */
	loadSqlite?: () => StatsConnectionConstructor;
	/** The `maestro-cli.js` agents are told to call (a bare script path, PA6). */
	maestroCliPath?: string;
	/** The directory of the running bundle, which the bundled prompts are found from. */
	moduleDirectory?: string;
	/** The bundled prompts directory, when the host knows it. */
	bundledPromptsDir?: string;
	/** The `maestro-p` script for a Claude agent whose token source is the TUI. None: `claude --print`. */
	maestroPBinPath?: string | null;
}

/** Seams for tests: the provider launch and the probes `loadTurnContext` makes. */
export interface RuntimeTurnDeps {
	runAgentTurn: typeof runAgentTurn;
	probeBinary?(binaryName: string, customPath?: string): Promise<BinaryDetectionResult>;
	readGitBranch?(cwd: string): Promise<string | undefined>;
	/** The clock for events and records. */
	now: () => number;
	/** The home directory `/skills` reads the user's own skills under. Default: this process's. */
	homeDir?(): string;
	/** `queue.recheckMs` and the timer behind it. */
	recheckMs?: number;
	schedule?(run: () => void, ms: number): () => void;
}

export interface RuntimeTurnsOptions {
	paths: MaestroPaths;
	repository: AgentRepository;
	bus: EventBus;
	registry: ProcessRegistry;
	fence(): DataDirVerdict;
	rules?: Partial<RuleContext>;
	/** Does an Auto Run hold this agent's working tree? A write message then waits for the run (AE17). */
	autoRunHolds?(agentId: string): boolean;
	/** The runtime's one History writer (it shares each entry with the project). Default: the recorder's own. */
	historyWriter?: HistoryWriter;
	options?: RuntimeTurnOptions;
	deps?: Partial<RuntimeTurnDeps>;
	/**
	 * The data directory's session image store. An admitted image is kept there and a waiting
	 * message and its transcript entry hold the `maestro-image://` ref, as on the desktop; the ref is
	 * read back for the provider and for a client's queue read. Without one, images stay inline.
	 */
	images?: Pick<SessionImageStore, 'storeInlineImage'>;
}

/**
 * The most messages one agent may have waiting on a headless host. Past it a send is refused with
 * the reason, so a sender that never stops cannot grow the host's memory without bound.
 */
export const MAX_WAITING_TURNS_PER_AGENT = 100;

export interface RuntimeTurns {
	readonly api: TurnsApi;
	/** Look at an agent's queue again, for a hold that cleared (an Auto Run ended). */
	drain(agentId: string): void;
	/** `/btw` side questions about this host's tabs, which `consults.ask` hands over (M6). */
	readonly sideQuestions: Pick<RuntimeSideQuestions, 'ask'>;
	/** Stop looking at queues: nothing more starts. Running turns are left to `registry.stopAll`. */
	dispose(): void;
}

/** One queued message, as the runtime holds it. */
interface TurnItem extends QueueItem {
	text: string;
	/**
	 * The images it carries, in attachment order: refs into the host's image store once admitted
	 * (`admitTurnImages`) and kept (`RuntimeTurnsOptions.images`), never the bytes.
	 */
	images?: string[];
	/** The decoded bytes of `images` together, recorded at admission, for a merge's bounds. */
	imageBytes?: number;
	queuedAt: number;
	/** Model and effort at the moment it was queued (a model change before it runs must not relabel it). */
	turnSettings: { model?: string; effort?: string };
	/**
	 * The provider those settings were chosen on. A model name means nothing to another provider,
	 * so a message still queued when the agent switches runs with the new provider's settings.
	 */
	settingsProvider: string;
	/** The machine the person sent it from, for the History entry (`TurnInput.originHost`). */
	originHost?: string;
	/**
	 * The sender's own tab choices for this turn (`TurnInput.overrides`). Model and effort are
	 * already folded into `turnSettings` and read-only into `readOnly`; the item keeps the rest
	 * (the read-only chip that stands in for the tab's, save to History) until it runs. Never
	 * written to the tab record.
	 */
	overrides?: TurnOverrides;
	/** Agent-only text ahead of `text` when it runs (`TurnInput.agentContext`). */
	agentContext?: string;
	/** Agent-only notes behind `text` when it runs (`TurnInput.agentNotes`). */
	agentNotes?: string;
	/**
	 * The id its transcript entry takes (`TurnInput.entryId`). When the tab already holds that entry
	 * (a resend of a message the host wrote down before its turn died), no second one is written.
	 */
	entryId?: string;
}

type Verdict = { ok: true } | { ok: false; message: string };

/**
 * The entry id a send may take (`TurnInput.entryId`): one the tab does not hold yet, or the user
 * entry of this same message (a resend), which then stands for it. An id that names another entry
 * is dropped, and the message gets a new one: a send never hides or replaces what is there.
 */
function turnEntryIdFor(
	tab: { logs?: unknown } | undefined,
	raw: unknown,
	text: string
): string | undefined {
	const entryId = readTurnEntryId(raw);
	if (!entryId) return undefined;
	const logs = Array.isArray(tab?.logs) ? (tab.logs as LogEntryRecord[]) : [];
	const existing = logs.find((entry) => entry?.id === entryId);
	if (!existing) return entryId;
	return existing.source === 'user' && existing.text === text ? entryId : undefined;
}

/** A start the provider layer refused before anything ran, with its reason. */
class TurnStartRefusal extends Error {
	constructor(
		readonly reason: RunAgentTurnRefusal,
		message: string
	) {
		super(message);
		this.name = 'TurnStartRefusal';
	}
}

/** A waiting message as a client sees it (`turns.queue.list`, `queue.changed`). */
function toQueuedTurn(item: TurnItem): QueuedTurn {
	return {
		itemId: item.id,
		tabId: item.tabId,
		queuedAt: item.queuedAt,
		kind: 'message',
		text: item.text,
		paused: item.paused === true,
		turnSettings: parseQueuedTurnSettings(item.turnSettings) ?? {},
		// The images ride along, so a hosted card draws them as a local card does. The item holds
		// store refs, which name this machine's disk: the client gets the bytes (M10).
		...(item.images?.length ? inlineQueuedImages(item.images) : {}),
	};
}

/** A waiting message's images as data URLs for a client. A ref whose file is gone is dropped. */
function inlineQueuedImages(images: readonly string[]): { images?: string[] } {
	const { inline } = inlineImageList(images);
	return inline.length > 0 ? { images: inline } : {};
}

const ok = <T>(value: T): ClientResult<T> => ({ ok: true, value });

function fail<T = never>(
	method: ClientMethod,
	code: ClientErrorCode,
	message: string
): ClientResult<T> {
	const error: ClientError = { code, message, method };
	return { ok: false, error };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a turn event belongs in the cards a sticky tab keeps (`RecordedTurn.streamed`): a
 * thinking or tool event, or the first answer text after a thinking block, which closes that block
 * as the live tail closes it (so two blocks split by the answer stay two cards).
 */
function keepsCards(event: TurnEvent, streamed: LiveTurn | undefined): boolean {
	if (event.kind === 'thinking' || event.kind === 'tool') return true;
	if (event.kind !== 'text' || !streamed) return false;
	return streamed.entries[streamed.entries.length - 1]?.source === 'thinking';
}

function noLoader(): never {
	throw new Error('This host did not provide a SQLite loader, so usage is not recorded.');
}

export function createRuntimeTurns(options: RuntimeTurnsOptions): RuntimeTurns {
	const { paths, repository, bus, registry } = options;
	const host = options.options ?? {};
	const deps: RuntimeTurnDeps = {
		runAgentTurn,
		now: () => Date.now(),
		...options.deps,
	};
	const ctx: RuleContext = { ...DEFAULT_RULE_CONTEXT, ...options.rules };

	const recorder: TurnRecorder = createTurnRecorder({
		paths,
		repository,
		...(options.historyWriter ? { historyWriter: options.historyWriter } : {}),
		loadSqlite: host.loadSqlite ?? noLoader,
		fence: options.fence,
		context: options.rules,
		// A finished turn's History entry comes from a synopsis turn, by the desktop's exit rule
		// (`shouldRunSynopsisOnExit`): not while the tab has a message waiting to run, which would
		// be a second writer on the session the synopsis resumes. It runs once the tab is free.
		summarize: (handoff) => {
			const waiting = queues.get(handoff.agentId)?.items() ?? [];
			if (waiting.some((item) => item.tabId === handoff.tabId && !item.paused)) return;
			void builtins.summarizeTurn(handoff);
		},
	});

	const sshStore = createSshRemoteStore(paths);

	/**
	 * Admitted images kept in the image store: their refs, in order. Inline as given when this
	 * runtime has no store. A disk that refuses the write refuses the message, with the reason.
	 */
	async function keepImages(
		images: string[]
	): Promise<{ ok: true; images: string[] } | { ok: false; error: string }> {
		const store = options.images;
		if (!store || images.length === 0) return { ok: true, images };
		try {
			return {
				ok: true,
				images: await Promise.all(images.map((image) => store.storeInlineImage(image))),
			};
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			logger.warn(`Could not keep a message's images: ${reason}`, LOG_CONTEXT);
			return {
				ok: false,
				error: `The attached images could not be saved on this host (${reason}). Nothing was sent.`,
			};
		}
	}

	/** Woken when a tab may have become free (`reserveTabSession`), by `agentId` then `tabId`. */
	const idleWaiters = new Map<string, Array<() => void>>();
	const waiterKey = (agentId: string, tabId: string) => `${agentId}\u0000${tabId}`;
	/** Tabs whose provider session a `/history` synopsis holds: a send to one waits (`startItem`). */
	const synopsisHolds = new Set<string>();
	let disposed = false;
	/**
	 * Hold the tab's provider session for a synopsis: once no turn starts or runs on the tab and no
	 * other synopsis holds it. The check and the hold happen in one tick, so two `/history` commands
	 * and a send can never both resume the session. The answer releases it.
	 */
	function reserveTabSession(agentId: string, tabId: string): Promise<() => void> {
		const key = waiterKey(agentId, tabId);
		if (disposed) return Promise.reject(new Error('The host is shutting down.'));
		if (queues.get(agentId)?.isTabBusy(tabId) || synopsisHolds.has(key)) {
			return new Promise<void>((resolve) => {
				idleWaiters.set(key, [...(idleWaiters.get(key) ?? []), () => resolve()]);
			}).then(() => reserveTabSession(agentId, tabId));
		}
		synopsisHolds.add(key);
		let released = false;
		return Promise.resolve(() => {
			if (released) return;
			released = true;
			synopsisHolds.delete(key);
			wakeIdleWaiters(agentId, tabId);
			// A send that collided with the hold may start now.
			queues.get(agentId)?.drain();
		});
	}
	function wakeIdleWaiters(agentId: string, tabId: string): void {
		const key = waiterKey(agentId, tabId);
		const waiting = idleWaiters.get(key);
		idleWaiters.delete(key);
		for (const resolve of waiting ?? []) resolve();
	}

	// Maestro's own `/history` and `/skills`, run here for a tab as a desktop host runs them.
	const builtins = createRuntimeBuiltinCommands({
		paths,
		repository,
		registry,
		historyWriter: options.historyWriter ?? createHistoryWriter({ paths, fence: options.fence }),
		statsRecorder: createStatsRecorder({
			paths,
			loadSqlite: host.loadSqlite ?? noLoader,
			fence: options.fence,
			isEnabled: () => readStatsCollectionEnabled(paths.settingsFile),
		}),
		host,
		deps,
		rules: ctx,
		reserveTabSession,
		...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
		transcriptChanged: (agentId, tabId, entry) => announceEntry(agentId, tabId, entry),
	});

	// `/btw`: a read-only fork of a tab's session, beside whatever the tab runs, as a desktop host forks it.
	const sideQuestions = createRuntimeSideQuestions({
		paths,
		repository,
		registry,
		host,
		deps,
		rules: ctx,
	});

	const queues = new Map<string, ExecutionQueue<TurnItem>>();
	/**
	 * An entry written to a tab outside its turn's own stream (a steer, `/skills`, `/history`).
	 * Mid-turn it joins the live turn in order; on an idle tab `gap` tells clients to read the tab
	 * again (`TRANSCRIPT_CHANGED_CHANNEL` on the wire), so it shows at once, as a local agent's does.
	 */
	const announceEntry = (agentId: string, tabId: string, entry: LogEntryRecord): void => {
		if (queues.get(agentId)?.isTabBusy(tabId)) emitTurn(agentId, tabId, { kind: 'user', entry });
		else emitTurn(agentId, tabId, { kind: 'gap' });
	};
	// Steer Running Turn: a TUI turn this host runs takes a waiting message over its socket.
	const steering = createRuntimeSteering<TurnItem>({
		queueOf: (agentId) => queues.get(agentId),
		toolTypeOf: (agentId) => repository.getAgent(agentId)?.toolType,
		appendEntry: async (agentId, tabId, entry) => {
			const written = await repository.appendTranscript(agentId, tabId, [entry]);
			if (!written.ok) {
				logger.warn(
					`A steer's transcript entry was not written: ${written.error.message}`,
					LOG_CONTEXT
				);
				return;
			}
			announceEntry(agentId, tabId, entry);
		},
		newId: () => ctx.newId(),
		now: () => deps.now(),
	});
	/** Resolved by the first dispatch attempt of an item that ran straight away. */
	const verdicts = new Map<string, (verdict: Verdict) => void>();

	/** Send one turn event to every client; answers it as sent, stamped. */
	/** Whether the tab keeps its thinking and tool cards past the turn's end, read as it is now. */
	const isStickyTab = (agentId: string, tabId: string): boolean =>
		repository.getTab(agentId, tabId)?.showThinking === 'sticky';

	const emitTurn = (agentId: string, tabId: string, event: UnstampedTurnEvent): TurnEvent => {
		const stamped = { ...event, at: deps.now() } as TurnEvent;
		bus.emit({ type: 'turn', agentId, tabId, event: stamped });
		return stamped;
	};

	// -----------------------------------------------------------------------
	// Starting one turn (the queue's `start`)
	// -----------------------------------------------------------------------

	async function startItem(agentId: string, item: TurnItem): Promise<QueuedTurnHandle> {
		const record = repository.getAgent(agentId);
		if (!record) throw new Error(`No agent ${agentId}.`);
		const lifted = liftedSendRefusal(record);
		if (lifted) throw new Error(lifted);
		const tabRecord = repository.getTab(agentId, item.tabId);
		if (!tabRecord) throw new Error(`The tab ${item.tabId} no longer exists.`);
		// The tab's previous process has not gone yet, or a `/history` synopsis holds its provider
		// session: a timing collision, not a verdict on the item.
		if (registry.isBusy(agentId, item.tabId) || synopsisHolds.has(waiterKey(agentId, item.tabId))) {
			throw new TurnCollisionError();
		}

		const agent = toTurnAgent(record);
		if (!agent) throw new Error('The agent has no working directory to run in.');
		const tab: TurnTab = toTurnTab(tabRecord);
		const expected: NonNullable<TabSessionUpdate['expected']> = {
			turnId: item.id,
			agentSessionId: tab.agentSessionId ?? null,
			nativeSessionBinding: structuredClone(tabRecord.nativeSessionBinding),
		};
		const incarnation =
			agent.toolType === 'grok' ? repository.captureTabIncarnation(agentId, item.tabId) : undefined;
		let ownedTurnId = tabRecord.runtimeTurnId;
		const writeGuard: TabWriteGuard | undefined =
			incarnation &&
			(() => {
				if (!incarnation()) return false;
				const current = repository.getAgent(agentId);
				const currentTab = repository.getTab(agentId, item.tabId);
				if (!current || !currentTab || currentTab.runtimeTurnId !== ownedTurnId) return false;
				try {
					// Reuse the parked-slot CAS before beginTurn as well as after it.
					recordTabSession({ ...currentTab, runtimeTurnId: item.id }, current, agent.toolType, {
						expected,
					});
					return true;
				} catch {
					return false;
				}
			});
		const isWorktree = typeof record.parentSessionId === 'string' && record.parentSessionId !== '';
		// Do not let the generic record reader turn a malformed resume into a new session.
		if (
			agent.toolType === 'grok' &&
			tabRecord.agentSessionId != null &&
			(typeof tabRecord.agentSessionId !== 'string' || tabRecord.agentSessionId === '')
		) {
			throw new TurnStartRefusal(
				'grok-native-session-refused',
				'The retained Grok native session ID is invalid.'
			);
		}
		const nativeSelectionKey = () => {
			const current = repository.getAgent(agentId);
			const currentTab = repository.getTab(agentId, item.tabId);
			return canonicalJson({
				agent: current && {
					provider: current.toolType,
					cwd: current.cwd,
					projectRoot: current.projectRoot,
					fullPath: current.fullPath,
					ssh: current.sessionSshRemoteConfig,
					env: current.customEnvVars,
					args: current.customArgs,
					path: current.customPath,
				},
				tab: currentTab && {
					...toTurnTab(currentTab),
					nativeSessionBinding: currentTab.nativeSessionBinding,
					rawId: currentTab.agentSessionId,
				},
			});
		};
		const selectionKey = agent.toolType === 'grok' ? nativeSelectionKey() : undefined;

		const loaded = await loadTurnContext(agent, {
			paths,
			...(host.bundledPromptsDir ? { bundledPromptsDir: host.bundledPromptsDir } : {}),
			...(host.moduleDirectory ? { moduleDirectory: host.moduleDirectory } : {}),
			...(host.maestroCliPath ? { maestroCliPath: host.maestroCliPath } : {}),
			...(deps.probeBinary ? { probeBinary: deps.probeBinary } : {}),
			...(deps.readGitBranch ? { readGitBranch: deps.readGitBranch } : {}),
			now: () => new Date(deps.now()),
		});
		if (!loaded.ok) throw new Error(loaded.message);

		if (agent.toolType === 'grok' && (!writeGuard!() || nativeSelectionKey() !== selectionKey))
			throw new TurnStartRefusal(
				'grok-native-session-refused',
				'The Grok tab or launch selection changed while loading context.'
			);
		const command = resolveSlashCommand(item.text, loaded.commands, agent.agentCommands);
		const message: TurnMessage = {
			text: item.text,
			...(item.images?.length ? { images: item.images } : {}),
			// Frozen settings only hold on the provider they were frozen on (see `settingsProvider`).
			...(item.settingsProvider === agent.toolType ? { turnSettings: item.turnSettings } : {}),
			...(command ? { command } : {}),
			...(item.readOnly ? { readOnly: true } : {}),
			...(item.overrides?.readOnly !== undefined ? { tabReadOnly: item.overrides.readOnly } : {}),
			...(item.agentContext ? { agentContext: item.agentContext } : {}),
			...(item.agentNotes ? { agentNotes: item.agentNotes } : {}),
		};
		const assembled = assembleTurn(agent, tab, message, {
			...loaded.context,
			// A run that started between this message being queued and now makes it read-only instead.
			autoRunHoldsTree: options.autoRunHolds?.(agentId) ?? false,
		});
		if (!assembled.ok) throw new Error(assembled.message);
		const turn: AssembledTurn = assembled.turn;
		const provider = turn.settings.provider;
		const scope = Object.freeze({
			projectPath: turn.launch.cwd,
			isRemote: turn.launch.sshRemoteConfig?.enabled === true,
			isWorktree,
		});

		// A fenced runtime could not write this turn down, so it must not launch the provider either:
		// the item stays held instead of starting a process that is stopped at its first record.
		const fenced = repository.writeRefusal();
		if (fenced) throw new Error(fenced);
		// A fresh socket per spawn: a steer meant for a turn that just ended can never reach the next.
		const steeringSocketPath = steeringSocketPathFor(`${agentId}-ai-${item.tabId}:${ctx.newId()}`);
		// Bound once the run exists; a verdict can only follow a steer, which needs the run.
		const steered: { turn?: SteeredTurnHandle } = {};
		const started = await deps.runAgentTurn(turn, {
			sessionId: `${agentId}-ai-${item.tabId}`,
			steeringSocketPath,
			onSteeringVerdict: (verdict) => steered.turn?.verdict(verdict),
			grokLaunchScope: host.grokLaunchScope,
			retainedNativeSessionBinding: expected.nativeSessionBinding,
			...(provider === 'grok'
				? { recheckNativeSelection: () => writeGuard!() && nativeSelectionKey() === selectionKey }
				: {}),
			sshStore,
			claudeTokenSource: getClaudeTokenSourceFields(record as ClaudeTokenSourceFields),
			maestroPBinPath: host.maestroPBinPath ?? null,
			// A chat turn runs in the agent's own cwd, so a TUI turn may accept claude's
			// folder-trust prompt there (#1872).
			acceptWorkspaceTrust: isAgentOwnWorkingDirectory(turn.launch.cwd, agent),
		});
		if (!started.ok) throw new Error(started.message);
		const run = started.run;
		const steeredTurn = steering.turnStarted(agentId, item.tabId, {
			provider,
			readOnly: turn.readOnly,
			...(run.steeringSocket ? { socketPath: run.steeringSocket } : {}),
		});
		steered.turn = steeredTurn;
		void run.result.then(
			() => steeredTurn.ended(),
			() => steeredTurn.ended()
		);

		// The process exists, so the registry learns of it before anything is awaited: the agent
		// reads busy to Auto Run, and a shutdown stops this process, from this line on. `settled`
		// stands in for the stream's end until the stream exists.
		let settle: () => void = () => undefined;
		const settled = new Promise<void>((resolve) => {
			settle = resolve;
		});
		registry.register(agentId, item.tabId, {
			interrupt: () => run.interrupt(),
			terminate: () => run.terminate(),
			terminateNow: () => run.terminateNow(),
			done: settled,
		});

		let done: Promise<void>;
		try {
			// The message is now sent: write it down, and spend a merge it carried.
			const startedAt = deps.now();
			const built = buildUserTranscriptEntry(turn.entry, startedAt, ctx);
			const userEntry = item.entryId ? { ...built, id: item.entryId } : built;
			const begun = await repository.beginTurn(
				agentId,
				item.tabId,
				{
					turnId: item.id,
					userEntry,
					provider: provider as ToolType,
					consumedMergedContext: turn.consumedMergedContext,
				},
				...(writeGuard ? [writeGuard] : [])
			);
			// Not recorded means not sent, as far as the person can tell: stop it and hold the item.
			if (!begun.ok) throw new Error(begun.error.message);
			ownedTurnId = item.id;

			// The stored entry keeps store refs; a watching client gets the bytes (M10).
			emitTurn(agentId, item.tabId, { kind: 'user', entry: withInlineEntryImages(userEntry) });
			emitTurn(agentId, item.tabId, { kind: 'started' });

			done = streamTurn({
				agentId,
				tabId: item.tabId,
				turn,
				run,
				startedAt,
				scope,
				expected,
				writeGuard,
				...(item.originHost ? { originHost: item.originHost } : {}),
				...(item.overrides?.saveToHistory !== undefined
					? { saveToHistory: item.overrides.saveToHistory }
					: {}),
			});
		} catch (error) {
			run.terminate();
			await run.result.catch(() => undefined);
			settle();
			throw error;
		}
		done.then(settle, settle);
		return { done, interrupt: () => run.interrupt() };
	}

	// -----------------------------------------------------------------------
	// One turn's stream and its records
	// -----------------------------------------------------------------------

	async function streamTurn(input: {
		agentId: string;
		tabId: string;
		turn: AssembledTurn;
		run: AgentTurnRun;
		startedAt: number;
		scope: RecordedTurn['scope'];
		expected: NonNullable<TabSessionUpdate['expected']>;
		writeGuard?: TabWriteGuard;
		originHost?: string;
		/** The sender's save-to-History chip for this turn (`TurnOverrides.saveToHistory`). */
		saveToHistory?: boolean;
	}): Promise<void> {
		const { agentId, tabId, turn, run, startedAt, expected, writeGuard, originHost } = input;
		const { saveToHistory } = input;
		const provider = turn.settings.provider;
		const mapper = createTurnEventMapper({
			agentId: provider,
			parser: createOutputParser(provider) ?? undefined,
			resumedSessionId: turn.resumeSessionId,
			now: deps.now,
		});
		const receipt = provider === 'grok' ? run.nativeLaunchReceipt : undefined;
		const scope =
			receipt?.scope.state === 'bound'
				? {
						...input.scope!,
						projectPath: receipt.scope.cwd,
						isRemote: receipt.scope.host.kind === 'ssh',
					}
				: input.scope;
		let nativeSessionBinding: NativeSessionBinding | undefined;
		let recordedSession: string | undefined = turn.resumeSessionId;
		let observedSession: string | undefined;
		let identityFailure: string | undefined;
		let sessionWrite: Promise<void> = Promise.resolve();
		// The cards a 'sticky' tab keeps in the transcript once the turn ends (`RecordedTurn.streamed`),
		// folded as a client's live tail folds them from the very events sent. Only thinking and tool
		// events are folded, and only while the tab is sticky: no other tab keeps them, and the answer
		// is recorded from `completed`. Any other tab only notes that a tool ran (the History gate).
		let streamed: LiveTurn | undefined;
		let ranTool = false;
		const foldContext = { newId: () => ctx.newId() };

		/** Preserve an allocated ID even during cancellation; a different ID is never a resume. */
		const noteSession = (id: string): void => {
			if (provider === 'grok') {
				if (identityFailure) return;
				if (
					typeof id !== 'string' ||
					!id.trim() ||
					/[\x00-\x1f\x7f]/.test(id) ||
					((turn.resumeSessionId ?? observedSession) !== undefined &&
						id !== (turn.resumeSessionId ?? observedSession))
				) {
					identityFailure =
						'Grok returned an invalid or different native session ID. The original conversation was retained.';
					return;
				}
				if (observedSession === id) return;
				if (receipt && receipt.requestedNativeSessionId !== turn.resumeSessionId) {
					identityFailure = 'The Grok launch receipt belongs to a different native request.';
					return;
				}
				const binding: NativeSessionBinding =
					receipt?.scope.state === 'bound'
						? { ...receipt.scope, nativeSessionId: id }
						: { version: 1, state: 'unknown', reason: 'unobserved' };
				if (
					(binding.state === 'bound' && !matchesNativeSessionBinding(binding, binding)) ||
					(turn.resumeSessionId &&
						!matchesNativeSessionBinding(binding, expected.nativeSessionBinding))
				) {
					identityFailure =
						'The Grok launch receipt does not prove ownership of this native session.';
					return;
				}
				observedSession = id;
				nativeSessionBinding = binding;
			} else if (id === recordedSession) return;
			recordedSession = id;
			sessionWrite = sessionWrite
				.then(async () => {
					const binding = nativeSessionBinding;
					const result = await repository.recordTabSession(
						agentId,
						tabId,
						provider,
						{
							agentSessionId: id,
							...(provider === 'grok' ? { nativeSessionBinding: binding, expected } : {}),
						},
						...(writeGuard ? [writeGuard] : [])
					);
					if (!result.ok) throw new Error(result.error.message);
					expected.agentSessionId = id;
					if (provider === 'grok') expected.nativeSessionBinding = binding;
				})
				.catch((error) => {
					if (provider === 'grok') identityFailure ??= errorText(error);
					logger.warn(`Recording the native session failed: ${errorText(error)}`, LOG_CONTEXT);
				});
		};

		try {
			for await (const parsed of run.events) {
				// The mapper suppresses a resumed ID's first announcement; validate the raw event.
				if (provider === 'grok' && parsed.sessionId !== undefined) {
					noteSession(parsed.sessionId);
					await sessionWrite;
				}
				for (const event of mapper.map(parsed)) {
					if (event.kind === 'session') {
						if (provider !== 'grok') noteSession(event.providerSessionId);
						if (identityFailure) continue;
					}
					const sent = emitTurn(agentId, tabId, event);
					if (sent.kind === 'tool') ranTool = true;
					if (keepsCards(sent, streamed) && isStickyTab(agentId, tabId)) {
						streamed = foldLiveTurn(streamed, sent, foldContext) ?? streamed;
					}
				}
			}
		} catch (error) {
			logger.warn(`Reading the turn's events failed: ${errorText(error)}`, LOG_CONTEXT);
		}

		let completed: CompletedTurn = await run.result;
		const endedAt = deps.now();
		if (completed.sessionId !== undefined) noteSession(completed.sessionId);
		await sessionWrite;
		if (provider === 'grok' && !identityFailure) {
			if (!writeGuard?.())
				identityFailure = 'The original Grok tab or turn no longer owns these records.';
		}
		if (
			provider === 'grok' &&
			!identityFailure &&
			completed.sessionId === undefined &&
			observedSession
		) {
			// Only a genuinely observed early allocation survives an end without an ID.
			completed = { ...completed, sessionId: observedSession };
		}

		try {
			const recorded = await recorder.recordTurn({
				agentId,
				tabId,
				assembled: turn,
				completed,
				startedAt,
				endedAt,
				userEntryWritten: true,
				...(streamed ? { streamed: streamed.entries } : {}),
				ranTool,
				scope,
				nativeSessionBinding,
				writeGuard: provider === 'grok' ? () => !identityFailure && writeGuard!() : undefined,
				...(originHost ? { originHost } : {}),
				...(saveToHistory !== undefined ? { saveToHistory } : {}),
			});
			if (!recorded.transcript.ok && recorded.transcript.error.code !== 'not-found') {
				logger.warn(
					`The turn's transcript was not written: ${recorded.transcript.error.message}`,
					LOG_CONTEXT
				);
			}
			if (provider === 'grok' && !recorded.transcript.ok) {
				identityFailure ??= recorded.transcript.error.message;
			}
			// The folded usage the tab record carries (`TurnEvent.usage` says clients must not sum).
			if (completed.usage && !identityFailure) {
				const usage = await repository.recordTabSession(
					agentId,
					tabId,
					provider,
					{
						addUsage: completed.usage,
						...(provider === 'grok' ? { expected } : {}),
					},
					...(writeGuard ? [writeGuard] : [])
				);
				if (!usage.ok) {
					if (provider === 'grok') identityFailure ??= usage.error.message;
					logger.warn(`The turn's usage was not written: ${usage.error.message}`, LOG_CONTEXT);
				}
			}
		} catch (error) {
			if (provider === 'grok') identityFailure ??= errorText(error);
			logger.warn(`Recording the turn failed: ${errorText(error)}`, LOG_CONTEXT);
		}
		if (provider === 'grok' && !writeGuard?.())
			identityFailure ??= 'The original Grok tab or turn no longer owns these records.';
		if (provider === 'grok' && identityFailure) {
			const error: NonNullable<CompletedTurn['error']> = {
				type: 'session_not_found',
				message: identityFailure,
				recoverable: false,
				agentId: provider,
				timestamp: endedAt,
			};
			completed = { ...completed, outcome: 'crashed', sessionId: undefined, error };
			emitTurn(agentId, tabId, { kind: 'error', error });
		}
		if (completed.sessionId && completed.sessionId !== mapper.sessionId()) {
			emitTurn(agentId, tabId, { kind: 'session', providerSessionId: completed.sessionId });
		}
		emitTurn(agentId, tabId, {
			kind: 'outcome',
			outcome: completed.outcome,
			exitCode: completed.exit.exitCode,
			...(completed.error ? { error: completed.error } : {}),
		});
	}

	// -----------------------------------------------------------------------
	// Queues
	// -----------------------------------------------------------------------

	/** Tell every listener what now waits for the agent: the whole list, in order. */
	function emitQueue(agentId: string): void {
		const items = queues.get(agentId)?.items() ?? [];
		bus.emit({ type: 'queue.changed', agentId, items: items.map(toQueuedTurn) });
	}

	function onQueueEvent(agentId: string, event: QueueEvent<TurnItem>): void {
		// Every event but a turn's end, and a start that never waited, changes what waits.
		if (event.type !== 'ended' && !(event.type === 'started' && event.direct)) {
			emitQueue(agentId);
		}
		switch (event.type) {
			case 'started':
				verdicts.get(event.item.id)?.({ ok: true });
				verdicts.delete(event.item.id);
				break;
			case 'ended':
				wakeIdleWaiters(agentId, event.item.tabId);
				break;
			case 'dispatch-failed': {
				if (event.held) {
					logger.warn(`A turn could not start: ${event.error.message}`, LOG_CONTEXT);
					emitTurn(agentId, event.item.tabId, {
						kind: 'error',
						error: {
							type: 'unknown',
							message: `The message was not sent: ${event.error.message}`,
							recoverable: true,
							agentId: repository.getAgent(agentId)?.toolType ?? 'unknown',
							timestamp: deps.now(),
						},
					});
					// The tab is free again (the item is held, not running): a synopsis waiting on it
					// goes ahead. A collision (`held: false`) retries, so the tab may still be taken.
					wakeIdleWaiters(agentId, event.item.tabId);
				}
				verdicts.get(event.item.id)?.({ ok: false, message: event.error.message });
				verdicts.delete(event.item.id);
				break;
			}
			default:
				break;
		}
	}

	function queueFor(agentId: string): ExecutionQueue<TurnItem> {
		let queue = queues.get(agentId);
		if (!queue) {
			queue = createExecutionQueue<TurnItem>({
				start: (item) => startItem(agentId, item),
				onEvent: (event) => onQueueEvent(agentId, event),
				// A `/history` synopsis holding the tab's provider session holds the tab's queue, as a
				// retry does: the send waits, never spends its collision attempts, and runs at release.
				isRetryHeld: (tabId) => synopsisHolds.has(waiterKey(agentId, tabId)),
				holdsTree: () => options.autoRunHolds?.(agentId) ?? false,
				...(deps.recheckMs !== undefined ? { recheckMs: deps.recheckMs } : {}),
				...(deps.schedule ? { schedule: deps.schedule } : {}),
			});
			queues.set(agentId, queue);
		}
		return queue;
	}

	// An agent that is removed takes its queue with it; a tab that closes takes the messages waiting for it.
	const unsubscribeLifecycle = bus.subscribe(
		(event) => {
			if (event.type === 'agent.removed') {
				const queue = queues.get(event.agentId);
				queue?.dispose();
				queues.delete(event.agentId);
				builtins.stop(event.agentId);
			} else if (event.type === 'tab.removed') {
				// A closed tab's `/history` synopsis has nowhere to write: it stops with the tab.
				builtins.stop(event.agentId, event.tabId);
				const queue = queues.get(event.agentId);
				for (const item of queue?.items() ?? []) {
					if (item.tabId === event.tabId) queue?.remove(item.id);
				}
			}
		},
		{ types: ['agent.removed', 'tab.removed'] }
	);

	// -----------------------------------------------------------------------
	// The API
	// -----------------------------------------------------------------------

	async function send(
		agentId: string,
		tabId: string,
		input: TurnInput
	): Promise<ClientResult<TurnSendReceipt>> {
		const method: ClientMethod = 'turns.send';
		const record = repository.getAgent(agentId);
		if (!record) return fail(method, 'not-found', `No agent ${agentId}.`);
		// A provider that cannot read images never gets offered them on a desktop (the composer's
		// attach button is off), so a send that carries some is refused here, never run without them.
		if (input.images?.length && !agentIdCanReadImages(record.toolType)) {
			return fail(
				method,
				'unsupported',
				`${getAgentDisplayName(record.toolType)} cannot read images. Send the message without them.`
			);
		}
		// Images come from another machine: inline data URLs only, bounded in count and bytes.
		const admitted = admitTurnImages(input.images);
		if (!admitted.ok) return fail(method, 'invalid', admitted.error);
		const text = typeof input.text === 'string' ? input.text : '';
		if (!text.trim() && admitted.images.length === 0) {
			return fail(method, 'invalid', 'There is nothing to send.');
		}
		// A lifted agent runs on its host now: a turn here would resume the session the host owns.
		const lifted = liftedSendRefusal(record);
		if (lifted) return fail(method, 'rejected', lifted);
		// Agent-only text a desktop's `@mention` adds (a consult's replies, its notes). One this
		// host cannot take refuses the send before anything runs, a builtin included: the turn
		// would answer without what it was sent with.
		const agentContext = readTurnAgentText(input.agentContext, 'agentContext');
		if (!agentContext.ok) return fail(method, 'invalid', agentContext.error);
		const agentNotes = readTurnAgentText(input.agentNotes, 'agentNotes');
		if (!agentNotes.ok) return fail(method, 'invalid', agentNotes.error);
		const tabRecord = repository.getTab(agentId, tabId);
		// Maestro's own commands. `/history` and `/skills` run here for the tab, as a desktop host
		// runs them for a send it receives; one that needs the typing window's composer is refused,
		// never handed to the provider as a message. A held send stays a message, as Queue Held keeps
		// it on a desktop.
		const builtin = input.held === true ? null : parseMaestroBuiltinCommand(text, record.toolType);
		if (builtin) {
			if (!runsOutsideComposer(builtin)) {
				return fail(
					method,
					'unsupported',
					`${builtin.name} runs in the composer of the window that typed it, so it cannot run from here.`
				);
			}
			if (!tabRecord) return fail(method, 'not-found', `No tab ${tabId}.`);
			void builtins.run(agentId, tabId, builtin);
			return ok({ status: 'ran' });
		}
		if (!tabRecord) return fail(method, 'not-found', `No tab ${tabId}.`);
		const agent = toTurnAgent(record);
		if (!agent) return fail(method, 'rejected', 'The agent has no working directory to run in.');
		const tab = toTurnTab(tabRecord);
		// The sender's own chips stand in for the tab's, for this message only (`TurnOverrides`).
		const overrides = normalizeTurnOverrides(input.overrides);
		if ((queues.get(agentId)?.items().length ?? 0) >= MAX_WAITING_TURNS_PER_AGENT) {
			return fail(
				method,
				'rejected',
				`This agent already has ${MAX_WAITING_TURNS_PER_AGENT} messages waiting. Wait for some to run, or remove some, and send again.`
			);
		}
		const kept = await keepImages(admitted.images);
		if (!kept.ok) return fail(method, 'failed', kept.error);
		const images = kept.images;

		const item: TurnItem = {
			id: ctx.newId(),
			tabId,
			text,
			...(images.length > 0 ? { images, imageBytes: admitted.bytes } : {}),
			queuedAt: deps.now(),
			readOnly:
				(overrides?.readOnly ?? tab.readOnlyMode === true) || tab.permissionMode === 'readonly',
			turnSettings: {
				model: overrides?.model ?? tab.customModel ?? agent.customModel,
				effort: overrides?.effort ?? tab.customEffort ?? agent.customEffort,
			},
			settingsProvider: agent.toolType,
		};
		// Queue Held: queued paused, even on an idle tab, until someone resumes it.
		if (input.held === true) item.paused = true;
		const originHost = normalizeOriginHost(input.originHost);
		if (originHost) item.originHost = originHost;
		if (overrides) item.overrides = overrides;
		if (agentContext.value) item.agentContext = agentContext.value;
		if (agentNotes.value) item.agentNotes = agentNotes.value;
		const entryId = turnEntryIdFor(tabRecord, input.entryId, text);
		if (entryId) item.entryId = entryId;

		const queue = queueFor(agentId);
		const attempt = new Promise<Verdict>((resolve) => verdicts.set(item.id, resolve));
		const { queued } = queue.submit(item);
		if (queued) {
			verdicts.delete(item.id);
			const waiting = queue.items();
			return ok({
				status: 'queued',
				itemId: item.id,
				// 1-based: the position the message holds in line, as the desktop reports it.
				position: waiting.findIndex((entry) => entry.id === item.id) + 1,
				queueLength: waiting.length,
			});
		}
		const verdict = await attempt;
		if (verdict.ok) return ok({ status: 'started' });
		return fail(
			method,
			'failed',
			`${verdict.message} The message is held in the queue; remove it or fix the cause and resume.`
		);
	}

	const api: TurnsApi = {
		send,

		interrupt: async (agentId, tabId) => {
			const queue = queues.get(agentId);
			if (!queue?.isTabBusy(tabId)) return ok({ stopped: false });
			queue.interrupt(tabId);
			return ok({ stopped: true });
		},

		queue: {
			list: async (agentId) => {
				if (!repository.getAgent(agentId)) {
					return fail('turns.queue.list', 'not-found', `No agent ${agentId}.`);
				}
				return ok((queues.get(agentId)?.items() ?? []).map(toQueuedTurn));
			},
			remove: async (agentId, itemId) => {
				if (!repository.getAgent(agentId)) {
					return fail('turns.queue.remove', 'not-found', `No agent ${agentId}.`);
				}
				return ok({ removed: queues.get(agentId)?.remove(itemId) ?? false });
			},
			setPaused: async (agentId, itemId, paused) => {
				if (!repository.getAgent(agentId)) {
					return fail('turns.queue.setPaused', 'not-found', `No agent ${agentId}.`);
				}
				const found = queues.get(agentId)?.setPaused(itemId, paused) ?? false;
				return ok({ found, paused });
			},
			merge: async (agentId, itemId) => {
				if (!repository.getAgent(agentId)) {
					return fail('turns.queue.merge', 'not-found', `No agent ${agentId}.`);
				}
				// The merged message is one message: its images meet a send's bounds, or nothing merges.
				const queue = queues.get(agentId);
				const lower = queue?.items().find((item) => item.id === itemId);
				const upper = queue && lower ? findQueueMergeTarget(queue.items(), itemId) : null;
				if (upper && lower) {
					// Both were admitted when they were queued, so their count and recorded size say
					// whether the merged message fits.
					const tooLarge = turnImageBoundsError(
						(upper.images?.length ?? 0) + (lower.images?.length ?? 0),
						(upper.imageBytes ?? 0) + (lower.imageBytes ?? 0)
					);
					if (tooLarge) return fail('turns.queue.merge', 'invalid', tooLarge);
				}
				// The upper message is the turn that runs first: it keeps its own settings and hold.
				const mergedIntoId =
					queues.get(agentId)?.merge(itemId, (upper, lower) => {
						const images = joinMergedQueueImages(upper.images, lower.images);
						const { images: _upperImages, imageBytes: _upperBytes, ...rest } = upper;
						return {
							...rest,
							text: joinMergedQueueText(upper.text, lower.text),
							...(images
								? { images, imageBytes: (upper.imageBytes ?? 0) + (lower.imageBytes ?? 0) }
								: {}),
						};
					}) ?? null;
				return ok(mergedIntoId ? { merged: true, mergedIntoId } : { merged: false });
			},
			// The queued card's Steer: typed into the Claude TUI turn running on the message's tab, as
			// a desktop types it (`steering.ts`). A turn with no input channel (`claude --print`,
			// `codex exec`) answers `not-steerable`, and the message stays queued.
			steer: async (agentId, itemId) => {
				if (!repository.getAgent(agentId)) {
					return fail('turns.queue.steer', 'not-found', `No agent ${agentId}.`);
				}
				return ok(await steering.steer(agentId, itemId));
			},
			edit: async (agentId, itemId, edit) => {
				const record = repository.getAgent(agentId);
				if (!record) {
					return fail('turns.queue.edit', 'not-found', `No agent ${agentId}.`);
				}
				// `images` replaces the message's images when given (an empty list removes them all)
				// and keeps them when absent, as the desktop's Edit does. They are admitted as a send's
				// are, so an edit is never a way past the bounds.
				let images: string[] | undefined;
				let imageBytes = 0;
				if (edit.images !== undefined) {
					if (edit.images.length > 0 && !agentIdCanReadImages(record.toolType)) {
						return fail(
							'turns.queue.edit',
							'unsupported',
							`${getAgentDisplayName(record.toolType)} cannot read images. Edit the message without them.`
						);
					}
					const admitted = admitTurnImages(edit.images);
					if (!admitted.ok) return fail('turns.queue.edit', 'invalid', admitted.error);
					const kept = await keepImages(admitted.images);
					if (!kept.ok) return fail('turns.queue.edit', 'failed', kept.error);
					images = kept.images;
					imageBytes = admitted.bytes;
				}
				// An image-only message may keep its text empty; a message with neither is nothing.
				const current = queues
					.get(agentId)
					?.items()
					.find((item) => item.id === itemId);
				if (current && !edit.text.trim() && !(images ?? current.images ?? []).length) {
					return fail('turns.queue.edit', 'invalid', 'There is nothing to send.');
				}
				const found =
					queues.get(agentId)?.update(itemId, (item) => {
						const next: TurnItem = {
							...item,
							text: edit.text,
							...(edit.turnSettings ? { turnSettings: { ...edit.turnSettings } } : {}),
						};
						if (images !== undefined) {
							if (images.length > 0) {
								next.images = images;
								next.imageBytes = imageBytes;
							} else {
								delete next.images;
								delete next.imageBytes;
							}
						}
						return next;
					}) ?? false;
				return ok({ found });
			},
			move: async (agentId, itemId, toIndex, tabId) => {
				if (!repository.getAgent(agentId)) {
					return fail('turns.queue.move', 'not-found', `No agent ${agentId}.`);
				}
				return ok({ moved: queues.get(agentId)?.move(itemId, toIndex, tabId) ?? false });
			},
			sendNow: async (agentId, itemId) => {
				if (!repository.getAgent(agentId)) {
					return fail('turns.queue.sendNow', 'not-found', `No agent ${agentId}.`);
				}
				return ok({ sent: queues.get(agentId)?.sendNow(itemId) ?? false });
			},
		},

		subscribe: (agentId, tabId, listener): Unsubscribe =>
			bus.subscribe(
				(event) => {
					if (event.type === 'turn' && event.tabId === tabId) listener(event.event);
				},
				{ types: ['turn'], agentId }
			),
	};

	return {
		api,
		sideQuestions: { ask: sideQuestions.ask },
		drain: (agentId) => queues.get(agentId)?.drain(),
		dispose() {
			disposed = true;
			unsubscribeLifecycle();
			builtins.stop();
			sideQuestions.dispose();
			for (const queue of queues.values()) queue.dispose();
			queues.clear();
			// Nothing runs any more, so nothing is left to wait for.
			for (const key of [...idleWaiters.keys()]) {
				const [agentId, tabId] = key.split('\u0000');
				wakeIdleWaiters(agentId, tabId);
			}
		},
	};
}
