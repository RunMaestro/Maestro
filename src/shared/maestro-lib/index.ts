// src/shared/maestro-lib/index.ts

/**
 * maestro-lib: run an AI coding agent's turn from a plain Node program.
 *
 * This is the library's one public entry. A tool built on it imports from
 * here and nowhere else; every other module under `src/shared/maestro-lib/`
 * is internal and may change without a version bump. The documentation for
 * that tool's developer is `docs/maestro-lib.md`; `docs-examples.test.ts`
 * type-checks its examples against this module, so a change here that breaks
 * one fails the tests. `npm run
 * build:maestro-lib` bundles this module into `dist/maestro-lib/` with its
 * type declarations and a `package.json` carrying `MAESTRO_LIB_VERSION`.
 *
 * The whole path, with nothing but this module:
 *
 *   const planned = await planSessionTurn({ agentId, cwd, prompt, resumeSessionId });
 *   if (!planned.ok) throw new Error(planned.error);
 *   const { handle, completed } = runTurn(
 *     planned.spec,
 *     { agentId, sessionId: 'my-tool', stopGraceMs: INTERACTIVE_STOP_GRACE_MS },
 *     { onEvent: (event) => render(event) }
 *   );
 *   // handle.interrupt() stops it the way a user does.
 *   const turn = await completed; // turn.outcome, turn.answerText, turn.usage
 *   // turn.sessionId is the next turn's `resumeSessionId`.
 *
 * Groups, from the top down:
 * - Providers: which agents exist and what each can do.
 * - Plan: `planSessionTurn` turns "this agent, this folder, this prompt" (and
 *   a session id to resume) into a process spec, refusing what cannot run.
 *   The lower-level launch steps it is made of are exported for a caller that
 *   assembles its own arguments.
 * - Run: `runTurn` / `runToCompletion` start, stream and settle a turn;
 *   `startTurn` is the raw form that leaves settling to the caller.
 * - Stop: a running turn is stopped through its `TurnHandle`. `stopProcess`
 *   and the process-tree helpers are for a process the caller started itself.
 * - Outcome: what a finished turn amounted to (`resolveTurnOutcome`, used by
 *   `runTurn`, and by a `startTurn` caller directly).
 * - Parsers: each provider's stream parser and the events it yields.
 * - Host hooks: where the library's logs, error reports, image refs and
 *   capability snapshots go. All optional; the defaults drop or skip them.
 *
 * Resume is not a separate call: pass the `sessionId` a finished turn
 * returned as the next request's `resumeSessionId`.
 *
 * Plain Node only. Nothing reachable from here imports Electron or the
 * desktop app (`no-desktop-framework.smoke.test.ts` walks this module's
 * import graph to keep it so).
 */

export { MAESTRO_LIB_VERSION } from './version';

// Providers
export {
	getAgentIds,
	getAgentDefinition,
	getVisibleAgentDefinitions,
	type AgentDefinition,
	type AgentConfig,
} from './providers/definitions';
export {
	getAgentCapabilities,
	hasCapability,
	type AgentCapabilities,
} from './providers/capabilities';

// Plan
export { planSessionTurn, type SessionTurnRequest, type SessionTurnPlan } from './run/session';
export { buildAgentArgs, type BuildAgentArgsOptions } from './launch/agent-args';
export {
	buildAgentLaunchPlan,
	type AgentLaunchInput,
	type AgentLaunchPlan,
	type AgentLaunchPlanResult,
	type LaunchPlanAgent,
} from './launch/launch-plan';
export type { AgentEnvSurface } from './launch/env';
export {
	checkBinaryExists,
	checkCustomPath,
	type BinaryDetectionResult,
} from './launch/path-prober';
export type { QuerySource } from '../querySource';

// Run
export {
	startTurn,
	turnProcessSpecFromPlan,
	DEFAULT_MAX_LINE_LENGTH,
	DEFAULT_STDOUT_TAIL_LIMIT,
	DEFAULT_STDERR_TAIL_LIMIT,
	type TurnProcessSpec,
	type LocalLaunchPlan,
	type TurnHandlers,
	type StartTurnOptions,
	type TurnExit,
	type TurnHandle,
} from './run/start-turn';
export {
	runTurn,
	runToCompletion,
	UnknownProviderError,
	type RunTurnOptions,
	type RunningTurn,
	type CompletedTurn,
} from './run/run-to-completion';
export { TurnCapture, type TurnCaptureOptions } from './run/turn-capture';

// Stop
export {
	stopProcess,
	INTERACTIVE_STOP_GRACE_MS,
	BACKGROUND_STOP_GRACE_MS,
	type StopStage,
	type StopTarget,
	type StopOptions,
	type StopHandle,
} from './control/termination';
export {
	killProcessTreeNow,
	snapshotProcessTree,
	type ProcessTreeSnapshot,
	type ProcessSnapshotEntry,
} from './control/process-tree';

// Outcome
export {
	resolveTurnOutcome,
	type TurnOutcome,
	type TurnFacts,
	type TurnOutcomeProvider,
	type ResolveTurnOutcomeOptions,
	type TurnOutcomeResult,
} from './streaming/turn-outcome';
export type { AgentError, AgentErrorType, UsageStats } from '../types';

// Parsers
export {
	initializeOutputParsers,
	createOutputParser,
	getOutputParser,
	hasOutputParser,
	getAllOutputParsers,
	type AgentOutputParser,
	type ParsedEvent,
} from './parsers';

// Host hooks
export {
	setMaestroLibLogger,
	setMaestroLibErrorReporter,
	setMaestroLibImageRefResolver,
	setMaestroLibCapabilitySnapshotLookup,
	type MaestroLibLogger,
	type MaestroLibSeverity,
	type MaestroLibErrorReporter,
	type ImageRefResolver,
	type CapabilitySnapshotLookup,
} from './host';
export type { AgentCapabilitiesSnapshot } from '../agentCapabilities';
