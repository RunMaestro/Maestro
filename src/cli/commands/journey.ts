// User Journey command: read what the USER did inside Maestro (files opened,
// saved, renamed, pages browsed) so an agent can see the user's recent steps.
//
// Read-only. Reads `<config>/journey/<agentId>.jsonl` straight off disk through
// `readJourney()` in the storage service, so it works with the desktop closed.
// The desktop app owns every write (`src/main/user-journey-manager.ts`).

import { readLiveSessions, readJourney, resolveAgentId } from '../services/storage';
import { formatError } from '../output/formatter';
import { parseCliTimestamp } from '../utils/parse';
import {
	USER_JOURNEY_KINDS,
	formatJourneyLine,
	isUserJourneyKind,
	type UserJourneyEntry,
	type UserJourneyKind,
} from '../../shared/userJourney';
import type { SessionInfo } from '../../shared/types';

export interface JourneyOptions {
	agent?: string;
	since?: string;
	tail?: string;
	kind?: string;
	json?: boolean;
}

interface AgentJourney {
	agent: SessionInfo;
	entries: UserJourneyEntry[];
}

function parseSince(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = parseCliTimestamp(value);
	if (parsed === null) {
		throw new Error(`Invalid --since value: ${value} (expected ISO-8601 or epoch number)`);
	}
	return parsed;
}

function parseTail(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	// Strict: `parseInt('5abc', 10)` is 5, which would hide a typo.
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) {
		throw new Error(`Invalid --tail value: ${value} (expected non-negative integer)`);
	}
	return Number(trimmed);
}

function parseKinds(value: string | undefined): UserJourneyKind[] | undefined {
	if (value === undefined) return undefined;
	const kinds = value
		.split(',')
		.map((k) => k.trim())
		.filter(Boolean);
	const invalid = kinds.filter((k) => !isUserJourneyKind(k));
	if (invalid.length > 0) {
		throw new Error(
			`Invalid --kind value: ${invalid.join(', ')}. Must be one of: ${USER_JOURNEY_KINDS.join(', ')}`
		);
	}
	return kinds as UserJourneyKind[];
}

export function journey(options: JourneyOptions): void {
	try {
		const since = parseSince(options.since);
		const tail = parseTail(options.tail);
		const kinds = parseKinds(options.kind);

		const sessions = readLiveSessions();
		const agentId = options.agent ? resolveAgentId(options.agent, sessions) : undefined;
		const agents = agentId ? sessions.filter((s) => s.id === agentId) : sessions;

		const journeys: AgentJourney[] = agents
			.map((agent) => ({ agent, entries: readJourney(agent.id, { since, tail, kinds }) }))
			.filter((j) => j.entries.length > 0);

		if (options.json) {
			const entries = journeys
				.flatMap(({ agent, entries }) => entries.map((e) => ({ ...e, agentName: agent.name })))
				.sort((a, b) => a.ts - b.ts);
			console.log(JSON.stringify({ success: true, entries }, null, 2));
			return;
		}

		if (journeys.length === 0) {
			console.log('No journey entries.');
			return;
		}

		const now = Date.now();
		const grouped = journeys.length > 1;
		const lines: string[] = [];
		for (const { agent, entries } of journeys) {
			if (grouped) {
				if (lines.length > 0) lines.push('');
				lines.push(`${agent.name} (${agent.id})`);
			}
			const indent = grouped ? '  ' : '';
			for (const entry of entries) {
				lines.push(`${indent}${formatJourneyLine(entry, now, { cwd: agent.cwd })}`);
			}
		}
		console.log(lines.join('\n'));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: message }, null, 2));
		} else {
			console.error(formatError(message));
		}
		process.exit(1);
	}
}
