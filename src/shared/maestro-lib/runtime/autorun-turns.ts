/**
 * The runtime's turn runner for Auto Run: one process per task, iteration, synopsis, or handoff.
 *
 * The engine (`autorun/run-playbook.ts`, `run-goal.ts`) decides what to ask and what the answer
 * means; this starts the agent. It is the same path a chat turn takes, with an Auto Run's
 * differences (`spawnAgentForSession`, `assembleAutoRunTurn`):
 *
 * | Step | Piece |
 * | --- | --- |
 * | Read what the turn needs | `loadTurnContext` |
 * | Decide arguments and environment | `assembleAutoRunTurn` (no tab, no nudge, always writes, `querySource: auto`) |
 * | Start, stream, stop | `runAgentTurn`, under the desktop's batch id `<agentId>-batch-<ts>` |
 * | Be seen as busy | the process registry, as `(agentId, 'autorun')` |
 * | Notice a hung agent | `createIdleWatchdog` (AE11) |
 * | Count the work | one `query_events` row, `source: 'auto'` (AE12) |
 *
 * A run does not write a transcript: it has no tab, and its record is History.
 *
 * What the watchdog does is the desktop's: a turn silent for `autoRunInactivityTimeoutMin`, or
 * running past `autoRunMaxTaskDurationMin`, is killed and comes back `crashed` with an
 * `errorKind`, so the stall guard trips at once instead of after three more dispatches. A
 * watchdog kill is not an operator stop, which is why it never reads as `interrupted`.
 */

import { getClaudeTokenSourceFields, type ClaudeTokenSourceFields } from '../../claudeTokenMode';
import { usageStatsToTurnFields } from '../../turnUsageLedger';
import type { UsageStats } from '../../types';
import type { AgentRepository } from '../agents/repository';
import type { AutoRunTurnResult, AutoRunTurnRequest } from '../autorun/engine-types';
import { createIdleWatchdog } from '../control/idle-watchdog';
import { logger } from '../host';
import { createOutputParser } from '../parsers/parser-factory';
import type { MaestroPaths } from '../paths/resolve';
import { readSettingsStore } from '../store/read-stores';
import { sshRecordOf } from '../agents/rules';
import { assembleAutoRunTurn } from '../turns/assemble';
import { loadTurnContext } from '../turns/context';
import { describeCrash } from '../turns/record-turn';
import { toTurnAgent } from '../turns/records';
import { runAgentTurn } from '../turns/run-agent-turn';
import type { StatsRecorder } from '../turns/stats';
import { createTurnEventMapper } from '../turns/turn-events';
import type { ProcessRegistry } from './processes';
import { createSshRemoteStore } from './ssh-store';
import type { RuntimeTurnDeps, RuntimeTurnOptions } from './turns';

const LOG_CONTEXT = '[AutoRunTurns]';

/** The registry tab id an Auto Run's process is filed under: the run has no tab of its own. */
export const AUTORUN_PROCESS_TAB_ID = 'autorun';

/** The desktop's defaults (`settingsStore`): four hours of silence, eight hours in all. 0 turns one off. */
const DEFAULT_INACTIVITY_TIMEOUT_MIN = 240;
const DEFAULT_MAX_TASK_DURATION_MIN = 480;
/** The longest delay `setTimeout` takes. An idle budget of "never" is this. */
const MAX_TIMER_MS = 2_147_483_647;

/** What a run's process says while it works, folded by `reduceAutoRun` into the output tail and totals. */
export type AutoRunStreamEvent =
	| { kind: 'output'; processId: string; text: string }
	| { kind: 'usage'; processId: string; usage: UsageStats };

export interface AutoRunTurnRunnerOptions {
	agentId: string;
	paths: MaestroPaths;
	repository: Pick<AgentRepository, 'getAgent'>;
	registry: ProcessRegistry;
	statsRecorder: Pick<StatsRecorder, 'recordQuery'>;
	/** What the host told the runtime about prompts, the CLI script, and maestro-p. */
	host: RuntimeTurnOptions;
	deps: Pick<RuntimeTurnDeps, 'runAgentTurn' | 'probeBinary' | 'readGitBranch' | 'now'>;
	/** The run's live output and usage, for the progress stream. */
	onStream(event: AutoRunStreamEvent): void;
}

export interface AutoRunTurnRunner {
	run(request: AutoRunTurnRequest): Promise<AutoRunTurnResult>;
}

function minutesSetting(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** The watchdog's two budgets in ms, read fresh so a change in the desktop applies to the next turn. */
function watchdogLimits(paths: Pick<MaestroPaths, 'settingsFile'>): {
	idleMs: number;
	maxMs: number;
} {
	const read = readSettingsStore(paths.settingsFile);
	const data = read.status === 'ok' ? read.data : {};
	const idle = minutesSetting(data.autoRunInactivityTimeoutMin, DEFAULT_INACTIVITY_TIMEOUT_MIN);
	const max = minutesSetting(data.autoRunMaxTaskDurationMin, DEFAULT_MAX_TASK_DURATION_MIN);
	return { idleMs: idle * 60_000, maxMs: max * 60_000 };
}

const failure = (error: string): AutoRunTurnResult => ({ success: false, error });

export function createAutoRunTurnRunner(options: AutoRunTurnRunnerOptions): AutoRunTurnRunner {
	const { agentId, paths, repository, registry, statsRecorder, host, deps } = options;
	const sshStore = createSshRemoteStore(paths);
	const startTurn = deps.runAgentTurn ?? runAgentTurn;

	async function run(request: AutoRunTurnRequest): Promise<AutoRunTurnResult> {
		const record = repository.getAgent(agentId);
		const agent = record ? toTurnAgent(record) : undefined;
		if (!record || !agent)
			return failure('The agent is gone or has no working directory to run in.');

		const loaded = await loadTurnContext(agent, {
			paths,
			...(host.bundledPromptsDir ? { bundledPromptsDir: host.bundledPromptsDir } : {}),
			...(host.moduleDirectory ? { moduleDirectory: host.moduleDirectory } : {}),
			...(host.maestroCliPath ? { maestroCliPath: host.maestroCliPath } : {}),
			...(deps.probeBinary ? { probeBinary: deps.probeBinary } : {}),
			...(deps.readGitBranch ? { readGitBranch: deps.readGitBranch } : {}),
			now: () => new Date(deps.now()),
		});
		if (!loaded.ok) return failure(loaded.message);

		const assembled = assembleAutoRunTurn(
			agent,
			{
				prompt: request.prompt,
				resumeSessionId: request.resumeSessionId,
				model: request.model,
				effort: request.effort,
			},
			loaded.context
		);
		if (!assembled.ok) return failure(assembled.message);
		const turn = assembled.turn;
		const provider = turn.settings.provider;

		const sessionId = `${agentId}-batch-${deps.now()}`;
		const started = await startTurn(turn, {
			sessionId,
			sshStore,
			claudeTokenSource: getClaudeTokenSourceFields(record as ClaudeTokenSourceFields),
			maestroPBinPath: host.maestroPBinPath ?? null,
			...(request.signal ? { signal: request.signal } : {}),
		});
		if (!started.ok) return failure(started.message);
		const process = started.run;
		const startedAt = deps.now();

		// The watchdog is the run's own: one budget for silence, one for the whole turn. A turn it
		// gives up on is killed, and the result says why (the stall guard reads that).
		let watchdogKind: 'watchdog-stalled' | 'watchdog-timeout' | undefined;
		const limits = watchdogLimits(paths);
		const watchdog =
			limits.idleMs > 0 || limits.maxMs > 0
				? createIdleWatchdog({
						idleMs: limits.idleMs > 0 ? Math.min(limits.idleMs, MAX_TIMER_MS) : MAX_TIMER_MS,
						...(limits.maxMs > 0 ? { maxMs: Math.min(limits.maxMs, MAX_TIMER_MS) } : {}),
						onIdle: () => {
							watchdogKind = 'watchdog-stalled';
							process.terminate();
						},
						onMax: () => {
							watchdogKind = 'watchdog-timeout';
							process.terminate();
						},
					})
				: undefined;

		const mapper = createTurnEventMapper({
			agentId: provider,
			parser: createOutputParser(provider) ?? undefined,
			resumedSessionId: turn.resumeSessionId,
			now: deps.now,
		});

		const finished = (async () => {
			try {
				for await (const parsed of process.events) {
					watchdog?.touch();
					for (const event of mapper.map(parsed)) {
						if (event.kind === 'text') {
							options.onStream({ kind: 'output', processId: sessionId, text: event.text });
						} else if (event.kind === 'usage') {
							options.onStream({ kind: 'usage', processId: sessionId, usage: event.usage });
						}
					}
				}
			} catch (error) {
				logger.warn(
					`Reading an Auto Run turn's events failed: ${error instanceof Error ? error.message : String(error)}`,
					LOG_CONTEXT
				);
			}
			const completed = await process.result;
			watchdog?.disarm();
			return completed;
		})();

		registry.register(agentId, AUTORUN_PROCESS_TAB_ID, {
			interrupt: () => process.interrupt(),
			terminate: () => process.terminate(),
			terminateNow: () => process.terminateNow(),
			done: finished,
		});
		const completed = await finished;
		const endedAt = deps.now();

		// The usage row the desktop writes for every turn it spawns, marked as automation.
		await statsRecorder.recordQuery({
			sessionId: agentId,
			agentType: provider,
			source: 'auto',
			startTime: startedAt,
			duration: endedAt - startedAt,
			projectPath: agent.cwd,
			isRemote: sshRecordOf(record.sessionSshRemoteConfig)?.enabled === true,
			isWorktree: typeof record.parentSessionId === 'string' && record.parentSessionId !== '',
			...usageStatsToTurnFields(completed.usage),
		});

		const finishedWell =
			completed.outcome === 'completed' || completed.outcome === 'completed-with-warning';
		const common = {
			...(completed.answerText ? { response: completed.answerText } : {}),
			...(completed.sessionId ? { agentSessionId: completed.sessionId } : {}),
			...(completed.usage ? { usageStats: completed.usage } : {}),
		};

		if (watchdogKind) {
			// Killed by the watchdog, which is a stuck agent and not a stop: `crashed`, never
			// `interrupted`, so the engine does not end the run as if the operator had.
			return {
				success: false,
				outcome: 'crashed',
				errorKind: watchdogKind,
				error:
					watchdogKind === 'watchdog-timeout'
						? 'The agent task exceeded the maximum duration'
						: 'The agent task stalled: no output within the inactivity timeout',
				...common,
			};
		}
		return {
			success: finishedWell,
			outcome: completed.outcome,
			...(finishedWell
				? {}
				: {
						error: completed.error?.message ?? describeCrash(completed.exit),
						// A classified failure is what pauses a run that has somebody to answer it.
						...(completed.error && completed.outcome !== 'interrupted'
							? { agentError: completed.error }
							: {}),
					}),
			...common,
		};
	}

	return { run };
}
