// `maestro-cli models index` - what the semantic index's background indexer is
// doing: its state, how many sources (History entries, Director's Notes
// synopses, transcript turns) are indexed out of how many exist, and why it
// stopped when it cannot run.
//
// It runs in the desktop over the WS bridge and answers with the same record
// the `localModels:semanticIndex:status` IPC channel does, which is what
// Settings > Models draws. It reads memory only: no file, no model.
//
// The indexer has no "start" verb, here or in the app. It runs whenever
// Semantic search is assigned a source (`maestro-cli models assign
// semantic-search <source>`) and indexes Cue runs only when the
// `semanticIndexCue` setting is on (`maestro-cli settings set semanticIndexCue
// true`).
//
// Exit codes, for scripts: 0 unless the indexer is `unavailable`. `off` is the
// default and not a failure.

import { withMaestroClient } from '../services/maestro-client';
import { ExitCode, exitWith } from '../exit-codes';
import { formatSemanticIndexProgress } from '../output/formatter';
import type { SemanticIndexProgress } from '../../shared/local-models/embedding-index';
import { failCommand, failFromError } from '../services/session-command';

/** A memory read in the app; anything slower than this is the bridge, not the work. */
const INDEX_STATUS_TIMEOUT_MS = 10_000;

interface IndexOptions {
	json?: boolean;
}

export async function modelsIndex(options: IndexOptions): Promise<void> {
	let reply: { success: boolean; progress?: SemanticIndexProgress; error?: string };
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand(
				{ type: 'local_models_semantic_index_status' },
				'local_models_semantic_index_status_result',
				INDEX_STATUS_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}

	if (!reply.success || !reply.progress) {
		failCommand(reply.error || 'Index status check failed', options.json);
	}
	const progress = reply.progress;
	const ok = progress.state !== 'unavailable';

	if (options.json) console.log(JSON.stringify({ success: ok, ...progress }));
	else console.log(formatSemanticIndexProgress(progress));
	if (!ok) exitWith(ExitCode.GeneralError);
}
