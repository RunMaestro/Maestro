// `maestro-cli search "<query>"` - find past work across History entries,
// Director's Notes synopses, and persisted tab transcripts.
//
// Two modes, one command. With no flag the query is matched as written
// (case-insensitive), newest first, with no model involved. `--semantic`
// matches by MEANING instead: the query is embedded on the Semantic search
// assignment and compared against the semantic index, best match first.
//
// It runs in the desktop over the WS bridge and calls the same function as the
// History panel's and cross-tab search's semantic mode (`localModels:search`),
// so the three rank and cut snippets identically.
//
// `--semantic` never falls back to text matching: when Semantic search is off
// or its source cannot run, the command says so and exits non-zero.
//
// Exit codes, for scripts: 0 when the search ran (zero hits included), 1 when
// it could not.

import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';
import { ExitCode, exitWith } from '../exit-codes';
import { formatWorkSearchResult } from '../output/formatter';
import type { EmbeddingSourceType } from '../../shared/local-models/embedding-index';
import {
	MAX_WORK_SEARCH_LIMIT,
	parseWorkSearchSource,
	WORK_SEARCH_OFF_REASON,
	WORK_SEARCH_SOURCE_NAMES,
	type WorkSearchRequest,
	type WorkSearchResult,
} from '../../shared/local-models/work-search';
import { failCommand, failFromError } from '../services/session-command';

/**
 * A semantic search may have to load the embedding model first; a text search
 * reads every History file. Both are well inside this.
 */
const SEARCH_TIMEOUT_MS = 120_000;

interface SearchOptions {
	semantic?: boolean;
	/** Repeatable, and each value may be a comma-separated list. */
	source?: string[];
	agent?: string;
	limit?: string;
	json?: boolean;
}

function parseSources(values: string[] | undefined, json: boolean | undefined) {
	if (!values || values.length === 0) return undefined;
	const types = new Set<EmbeddingSourceType>();
	for (const name of values.flatMap((value) => value.split(','))) {
		if (name.trim() === '') continue;
		const type = parseWorkSearchSource(name);
		if (!type) {
			failCommand(
				`Unknown source "${name.trim()}". Use: ${Object.values(WORK_SEARCH_SOURCE_NAMES).join(', ')}.`,
				json
			);
		}
		types.add(type);
	}
	return types.size > 0 ? [...types] : undefined;
}

export async function search(query: string, options: SearchOptions): Promise<void> {
	if (query.trim() === '') failCommand('A search needs a query.', options.json);

	const request: WorkSearchRequest = {
		query,
		mode: options.semantic ? 'semantic' : 'text',
	};
	const sourceTypes = parseSources(options.source, options.json);
	if (sourceTypes) request.sourceTypes = sourceTypes;

	if (options.agent !== undefined) {
		try {
			request.agentId = resolveAgentId(options.agent);
		} catch (error) {
			failCommand(error instanceof Error ? error.message : String(error), options.json);
		}
	}

	if (options.limit !== undefined) {
		const limit = Number(options.limit);
		if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WORK_SEARCH_LIMIT) {
			failCommand(
				`--limit must be a whole number from 1 to ${MAX_WORK_SEARCH_LIMIT}.`,
				options.json
			);
		}
		request.limit = limit;
	}

	let reply: { success: boolean; result?: WorkSearchResult; error?: string };
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand(
				{ type: 'local_models_search', request },
				'local_models_search_result',
				SEARCH_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}

	if (!reply.success || !reply.result) failCommand(reply.error || 'Search failed', options.json);
	const result = reply.result;

	if (result.status !== 'ok') {
		const reason =
			result.status === 'off'
				? `${WORK_SEARCH_OFF_REASON} From the CLI: maestro-cli models assign semantic-search <source>`
				: result.status === 'cancelled'
					? 'The search was cancelled.'
					: result.reason;
		if (options.json) {
			console.log(JSON.stringify({ success: false, status: result.status, error: reason }));
			return exitWith(ExitCode.GeneralError);
		}
		failCommand(reason, false);
	}

	if (options.json) console.log(JSON.stringify({ success: true, query, ...result }));
	else console.log(formatWorkSearchResult(query, result));
}
