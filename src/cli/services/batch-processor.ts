// Batch processor service for CLI
// Executes playbooks and yields JSONL events
//
// The engine lives in the library (`src/shared/maestro-lib/autorun/run-playbook.ts`) so the CLI
// and the runtime behind the TUI run the same loop. This is the CLI's adapter: it builds the
// ports from CLI modules (`autorun-cli-deps.ts`) and hands the engine's events through as JSONL.

import type { Playbook, SessionInfo } from '../../shared/types';
import type { JsonlEvent } from '../output/jsonl';
import {
	runPlaybook as runPlaybookEngine,
	type RunPlaybookOptions,
} from '../../shared/maestro-lib/autorun/run-playbook';
import { createCliAutoRunDeps } from './autorun-cli-deps';

// Halt detection lives in `shared/autorunMarkers` so the desktop renderer can
// both share it and draw a pill for a marker that would block the next run.
// Re-exported because this module is where the CLI engine and its tests reach
// for it.
import { detectHaltMarker } from '../../shared/autorunMarkers';
export { detectHaltMarker };

/**
 * Process a playbook and yield JSONL events
 */
export async function* runPlaybook(
	session: SessionInfo,
	playbook: Playbook,
	folderPath: string,
	options: RunPlaybookOptions = {}
): AsyncGenerator<JsonlEvent> {
	yield* runPlaybookEngine(session, playbook, folderPath, options, createCliAutoRunDeps(session));
}
