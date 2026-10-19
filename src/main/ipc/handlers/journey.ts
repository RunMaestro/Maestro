/**
 * User Journey IPC (`journey:*`).
 *
 * Thin pass-throughs to `src/main/user-journey-manager.ts`, which owns the
 * per-agent JSONL files. The store normalizes every entry (known fields only,
 * `browser.*` targets re-sanitized), so `journey:append` hands the renderer's
 * object straight through. The handlers only check that an agent id is a
 * non-empty string, so a malformed call fails loudly instead of writing to
 * `journey/.jsonl`.
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging } from '../../utils/ipcHandler';
import {
	appendJourneyEntry,
	getJourneyFilePath,
	readJourney,
	type ReadJourneyOptions,
} from '../../user-journey-manager';
import { isUserJourneyKind, type UserJourneyEntry } from '../../../shared/userJourney';

const LOG_CONTEXT = '[UserJourney]';

function opts(operation: string) {
	return { context: LOG_CONTEXT, operation };
}

function requireAgentId(agentId: unknown): string {
	if (typeof agentId !== 'string' || agentId.length === 0) {
		throw new Error('journey: agentId must be a non-empty string');
	}
	return agentId;
}

/** Keep only well-typed read options; anything else is ignored, not trusted. */
function toReadOptions(raw: unknown): ReadJourneyOptions {
	if (!raw || typeof raw !== 'object') return {};
	const { since, tail, kinds } = raw as Record<string, unknown>;
	const options: ReadJourneyOptions = {};
	if (typeof since === 'number' && Number.isFinite(since)) options.since = since;
	if (typeof tail === 'number' && Number.isFinite(tail)) options.tail = Math.floor(tail);
	if (Array.isArray(kinds)) options.kinds = kinds.filter(isUserJourneyKind);
	return options;
}

export function registerJourneyHandlers(): void {
	ipcMain.handle(
		'journey:append',
		withIpcErrorLogging(opts('append'), async (entry: UserJourneyEntry) =>
			appendJourneyEntry(entry)
		)
	);
	ipcMain.handle(
		'journey:read',
		withIpcErrorLogging(opts('read'), async (agentId: unknown, options?: unknown) =>
			readJourney(requireAgentId(agentId), toReadOptions(options))
		)
	);
	ipcMain.handle(
		'journey:path',
		withIpcErrorLogging(opts('path'), async (agentId: unknown) =>
			getJourneyFilePath(requireAgentId(agentId))
		)
	);
}
