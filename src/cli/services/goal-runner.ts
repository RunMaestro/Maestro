// Goal-Driven Auto Run engine for the CLI.
//
// The engine lives in the library (`src/shared/maestro-lib/autorun/run-goal.ts`), where it drives
// the same pure goal rules as the desktop `useGoalRunner` hook (src/shared/goalDriven/*). This is
// the CLI's adapter: it builds the ports from CLI modules (`autorun-cli-deps.ts`) and hands the
// engine's events through as JSONL.

import type { SessionInfo } from '../../shared/types';
import type { JsonlEvent } from '../output/jsonl';
import type { GoalRunConfig } from '../../shared/goalDriven/types';
import {
	runGoal as runGoalEngine,
	type RunGoalOptions,
} from '../../shared/maestro-lib/autorun/run-goal';
import { createCliAutoRunDeps } from './autorun-cli-deps';

export type { RunGoalOptions };

/**
 * Run a Goal-Driven Auto Run for a session, yielding JSONL events.
 */
export async function* runGoal(
	session: SessionInfo,
	goalConfig: GoalRunConfig,
	options: RunGoalOptions = {}
): AsyncGenerator<JsonlEvent> {
	yield* runGoalEngine(session, goalConfig, options, createCliAutoRunDeps(session));
}
