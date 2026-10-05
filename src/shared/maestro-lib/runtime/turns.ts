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
import type { ToolType } from '../../types';
import type { AgentRepository } from '../agents/repository';
import { DEFAULT_RULE_CONTEXT, type RuleContext } from '../agents/rules';
import type { EventBus } from '../client/event-bus';
import type {
	ClientError,
	ClientErrorCode,
	ClientMethod,
	ClientResult,
	QueuedTurn,
	TurnEvent,
	TurnInput,
	TurnSendReceipt,
	TurnsApi,
	Unsubscribe,
} from '../client/types';
import { logger } from '../host';
import type { BinaryDetectionResult } from '../launch/path-prober';
import { createOutputParser } from '../parsers/parser-factory';
import type { MaestroPaths } from '../paths/resolve';
import {
	createExecutionQueue,
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
} from '../turns/record-turn';
import { toTurnAgent, toTurnTab } from '../turns/records';
import { runAgentTurn, type AgentTurnRun } from '../turns/run-agent-turn';
import { createTurnEventMapper, type UnstampedTurnEvent } from '../turns/turn-events';
import type { StatsConnectionConstructor } from '../turns/stats';
import type { DataDirVerdict } from './data-dir-lock';
import type { ProcessRegistry } from './processes';
import { createSshRemoteStore } from './ssh-store';

const LOG_CONTEXT = '[RuntimeTurns]';

/** What the host passes the runtime so it can run turns. Every field is optional. */
export interface RuntimeTurnOptions {
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
	options?: RuntimeTurnOptions;
	deps?: Partial<RuntimeTurnDeps>;
}

export interface RuntimeTurns {
	readonly api: TurnsApi;
	/** Look at an agent's queue again, for a hold that cleared (an Auto Run ended). */
	drain(agentId: string): void;
	/** Stop looking at queues: nothing more starts. Running turns are left to `registry.stopAll`. */
	dispose(): void;
}

/** One queued message, as the runtime holds it. */
interface TurnItem extends QueueItem {
	text: string;
	queuedAt: number;
	/** Model and effort at the moment it was queued (a model change before it runs must not relabel it). */
	turnSettings: { model?: string; effort?: string };
}

type Verdict = { ok: true } | { ok: false; message: string };

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
		loadSqlite: host.loadSqlite ?? noLoader,
		fence: options.fence,
		context: options.rules,
	});

	const sshStore = createSshRemoteStore(paths);

	const queues = new Map<string, ExecutionQueue<TurnItem>>();
	/** Resolved by the first dispatch attempt of an item that ran straight away. */
	const verdicts = new Map<string, (verdict: Verdict) => void>();

	const emitTurn = (agentId: string, tabId: string, event: UnstampedTurnEvent): void => {
		bus.emit({
			type: 'turn',
			agentId,
			tabId,
			event: { ...event, at: deps.now() } as TurnEvent,
		});
	};

	// -----------------------------------------------------------------------
	// Starting one turn (the queue's `start`)
	// -----------------------------------------------------------------------

	async function startItem(agentId: string, item: TurnItem): Promise<QueuedTurnHandle> {
		const record = repository.getAgent(agentId);
		if (!record) throw new Error(`No agent ${agentId}.`);
		const tabRecord = repository.getTab(agentId, item.tabId);
		if (!tabRecord) throw new Error(`The tab ${item.tabId} no longer exists.`);
		// The tab's previous process has not gone yet: a timing collision, not a verdict on the item.
		if (registry.isBusy(agentId, item.tabId)) throw new TurnCollisionError();

		const agent = toTurnAgent(record);
		if (!agent) throw new Error('The agent has no working directory to run in.');

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

		const tab: TurnTab = toTurnTab(tabRecord);
		const command = resolveSlashCommand(item.text, loaded.commands, agent.agentCommands);
		const message: TurnMessage = {
			text: item.text,
			turnSettings: item.turnSettings,
			...(command ? { command } : {}),
			...(item.readOnly ? { readOnly: true } : {}),
		};
		const assembled = assembleTurn(agent, tab, message, {
			...loaded.context,
			// A run that started between this message being queued and now makes it read-only instead.
			autoRunHoldsTree: options.autoRunHolds?.(agentId) ?? false,
		});
		if (!assembled.ok) throw new Error(assembled.message);
		const turn: AssembledTurn = assembled.turn;
		const provider = turn.settings.provider;

		const started = await deps.runAgentTurn(turn, {
			sessionId: `${agentId}-ai-${item.tabId}`,
			sshStore,
			claudeTokenSource: getClaudeTokenSourceFields(record as ClaudeTokenSourceFields),
			maestroPBinPath: host.maestroPBinPath ?? null,
		});
		if (!started.ok) throw new Error(started.message);
		const run = started.run;

		// The process exists, so the message is now sent: write it down, and spend a merge it carried.
		const startedAt = deps.now();
		const userEntry = buildUserTranscriptEntry(turn.entry, startedAt, ctx);
		const begun = await repository.beginTurn(agentId, item.tabId, {
			userEntry,
			provider: provider as ToolType,
			consumedMergedContext: turn.consumedMergedContext,
		});
		if (!begun.ok) {
			// Not recorded means not sent, as far as the person can tell: stop it and hold the item.
			run.terminate();
			await run.result.catch(() => undefined);
			throw new Error(begun.error.message);
		}

		emitTurn(agentId, item.tabId, { kind: 'user', entry: userEntry });
		emitTurn(agentId, item.tabId, { kind: 'started' });

		const done = streamTurn({ agentId, tabId: item.tabId, turn, run, startedAt });
		registry.register(agentId, item.tabId, {
			interrupt: () => run.interrupt(),
			terminate: () => run.terminate(),
			terminateNow: () => run.terminateNow(),
			done,
		});
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
	}): Promise<void> {
		const { agentId, tabId, turn, run, startedAt } = input;
		const provider = turn.settings.provider;
		const mapper = createTurnEventMapper({
			agentId: provider,
			parser: createOutputParser(provider) ?? undefined,
			resumedSessionId: turn.resumeSessionId,
			now: deps.now,
		});
		let recordedSession: string | undefined = turn.resumeSessionId;
		let sessionWrite: Promise<unknown> = Promise.resolve();

		/** Write the provider's session id the moment it is announced: a crash after this still resumes. */
		const noteSession = (id: string): void => {
			if (id === recordedSession) return;
			recordedSession = id;
			sessionWrite = sessionWrite.then(() =>
				repository.recordTabSession(agentId, tabId, provider, { agentSessionId: id })
			);
		};

		try {
			for await (const parsed of run.events) {
				for (const event of mapper.map(parsed)) {
					if (event.kind === 'session') noteSession(event.providerSessionId);
					emitTurn(agentId, tabId, event);
				}
			}
		} catch (error) {
			logger.warn(`Reading the turn's events failed: ${errorText(error)}`, LOG_CONTEXT);
		}

		const completed = await run.result;
		const endedAt = deps.now();
		if (completed.sessionId && completed.sessionId !== mapper.sessionId()) {
			emitTurn(agentId, tabId, { kind: 'session', providerSessionId: completed.sessionId });
		}
		if (completed.sessionId) noteSession(completed.sessionId);
		await sessionWrite.catch(() => undefined);

		try {
			const recorded = await recorder.recordTurn({
				agentId,
				tabId,
				assembled: turn,
				completed,
				startedAt,
				endedAt,
				userEntryWritten: true,
			});
			if (!recorded.transcript.ok && recorded.transcript.error.code !== 'not-found') {
				logger.warn(
					`The turn's transcript was not written: ${recorded.transcript.error.message}`,
					LOG_CONTEXT
				);
			}
			// The folded usage the tab record carries (`TurnEvent.usage` says clients must not sum).
			if (completed.usage) {
				await repository.recordTabSession(agentId, tabId, provider, {
					addUsage: completed.usage,
				});
			}
		} catch (error) {
			logger.warn(`Recording the turn failed: ${errorText(error)}`, LOG_CONTEXT);
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

	function onQueueEvent(agentId: string, event: QueueEvent<TurnItem>): void {
		switch (event.type) {
			case 'started':
				verdicts.get(event.item.id)?.({ ok: true });
				verdicts.delete(event.item.id);
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
			} else if (event.type === 'tab.removed') {
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
		if (input.images?.length) {
			return fail(
				method,
				'unsupported',
				'Images cannot be sent from here yet. Send the message without them, or use the desktop.'
			);
		}
		if (!input.text?.trim()) return fail(method, 'invalid', 'There is nothing to send.');
		const record = repository.getAgent(agentId);
		if (!record) return fail(method, 'not-found', `No agent ${agentId}.`);
		const tabRecord = repository.getTab(agentId, tabId);
		if (!tabRecord) return fail(method, 'not-found', `No tab ${tabId}.`);
		const agent = toTurnAgent(record);
		if (!agent) return fail(method, 'rejected', 'The agent has no working directory to run in.');
		const tab = toTurnTab(tabRecord);

		const item: TurnItem = {
			id: ctx.newId(),
			tabId,
			text: input.text,
			queuedAt: deps.now(),
			readOnly: tab.readOnlyMode === true || tab.permissionMode === 'readonly',
			turnSettings: {
				model: tab.customModel ?? agent.customModel,
				effort: tab.customEffort ?? agent.customEffort,
			},
		};

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
				const items = queues.get(agentId)?.items() ?? [];
				return ok(
					items.map(
						(item): QueuedTurn => ({
							itemId: item.id,
							tabId: item.tabId,
							queuedAt: item.queuedAt,
							kind: 'message',
							text: item.text,
							paused: item.paused === true,
						})
					)
				);
			},
			remove: async (agentId, itemId) => {
				if (!repository.getAgent(agentId)) {
					return fail('turns.queue.remove', 'not-found', `No agent ${agentId}.`);
				}
				return ok({ removed: queues.get(agentId)?.remove(itemId) ?? false });
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
		drain: (agentId) => queues.get(agentId)?.drain(),
		dispose() {
			unsubscribeLifecycle();
			for (const queue of queues.values()) queue.dispose();
			queues.clear();
		},
	};
}
