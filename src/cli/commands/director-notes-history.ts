// Director's Notes History command
// Displays unified history aggregated across all agents

import { readSessions, readHistory, readSettings } from '../services/storage';
import { formatError, formatDirectorNotesHistory } from '../output/formatter';
import type { HistoryEntry } from '../../shared/types';

type OutputFormat = 'json' | 'markdown' | 'text';

interface DirectorNotesHistoryOptions {
	days?: string;
	format?: OutputFormat;
	filter?: string;
	limit?: string;
	json?: boolean;
}

interface UnifiedHistoryEntry extends HistoryEntry {
	agentName?: string;
	sourceSessionId: string;
}

function resolveFormat(options: DirectorNotesHistoryOptions): OutputFormat {
	if (options.json) return 'json';
	return options.format || 'text';
}

function getDefaultLookbackDays(): number {
	const settings = readSettings();
	const dnSettings = settings.directorNotesSettings as { defaultLookbackDays?: number } | undefined;
	return dnSettings?.defaultLookbackDays ?? 7;
}

function checkEncoreFeatureEnabled(): void {
	const settings = readSettings();
	const encoreFeatures = settings.encoreFeatures as { directorNotes?: boolean } | undefined;
	if (!encoreFeatures?.directorNotes) {
		throw new Error("Director's Notes is not enabled. Enable it in Settings > Encore Features.");
	}
}

export function directorNotesHistory(options: DirectorNotesHistoryOptions): void {
	try {
		checkEncoreFeatureEnabled();

		const format = resolveFormat(options);
		const lookbackDays = options.days ? parseInt(options.days, 10) : getDefaultLookbackDays();
		const limit = options.limit ? parseInt(options.limit, 10) : 100;
		const typeFilter = options.filter?.toUpperCase() as 'AUTO' | 'USER' | 'CUE' | undefined;

		if (typeFilter && !['AUTO', 'USER', 'CUE'].includes(typeFilter)) {
			throw new Error(`Invalid filter: ${options.filter}. Must be one of: auto, user, cue`);
		}

		const now = Date.now();
		const cutoffTime = lookbackDays > 0 ? now - lookbackDays * 24 * 60 * 60 * 1000 : 0;

		// Build session name map
		const sessions = readSessions();
		const sessionNameMap = new Map<string, string>();
		for (const s of sessions) {
			if (s.id && s.name) {
				sessionNameMap.set(s.id, s.name);
			}
		}

		// Aggregate history from all sessions
		const allEntries: UnifiedHistoryEntry[] = [];
		const agentsWithEntries = new Set<string>();
		let autoCount = 0;
		let userCount = 0;
		let cueCount = 0;

		// readHistory with no args returns all entries across all sessions
		const entries = readHistory();

		for (const entry of entries) {
			if (cutoffTime > 0 && entry.timestamp < cutoffTime) continue;

			// Track stats before type filter
			if (entry.sessionId) agentsWithEntries.add(entry.sessionId);
			if (entry.type === 'AUTO') autoCount++;
			else if (entry.type === 'USER') userCount++;
			else if (entry.type === 'CUE') cueCount++;

			// Apply type filter
			if (typeFilter && entry.type !== typeFilter) continue;

			allEntries.push({
				...entry,
				sourceSessionId: entry.sessionId || 'unknown',
				agentName: entry.sessionId ? sessionNameMap.get(entry.sessionId) : undefined,
			});
		}

		// Sort newest first
		allEntries.sort((a, b) => b.timestamp - a.timestamp);

		// Apply limit
		const limitedEntries = allEntries.slice(0, limit);

		const stats = {
			agentCount: agentsWithEntries.size,
			autoCount,
			userCount,
			cueCount,
			totalCount: autoCount + userCount + cueCount,
			lookbackDays,
		};

		if (format === 'json') {
			console.log(
				JSON.stringify(
					{
						stats,
						total: allEntries.length,
						showing: limitedEntries.length,
						entries: limitedEntries.map((e) => ({
							id: e.id,
							type: e.type,
							timestamp: e.timestamp,
							date: new Date(e.timestamp).toISOString(),
							summary: e.summary,
							agentName: e.agentName,
							sourceSessionId: e.sourceSessionId,
							projectPath: e.projectPath,
							success: e.success,
							elapsedTimeMs: e.elapsedTimeMs,
							cost: e.usageStats?.totalCostUsd,
						})),
					},
					null,
					2
				)
			);
		} else if (format === 'markdown') {
			const lines: string[] = [];
			lines.push("# Director's Notes — History");
			lines.push('');
			lines.push(
				`**Period:** ${lookbackDays > 0 ? `Last ${lookbackDays} day${lookbackDays !== 1 ? 's' : ''}` : 'All time'}`
			);
			lines.push(
				`**Stats:** ${stats.agentCount} agents, ${stats.totalCount} entries (${stats.autoCount} auto, ${stats.userCount} user, ${stats.cueCount} cue)`
			);
			lines.push(`**Showing:** ${limitedEntries.length} of ${allEntries.length} entries`);
			lines.push('');

			if (limitedEntries.length === 0) {
				lines.push('*No entries found for the specified period.*');
			} else {
				lines.push('| Date | Type | Agent | Summary | Cost | Duration |');
				lines.push('|------|------|-------|---------|------|----------|');

				for (const entry of limitedEntries) {
					const date = new Date(entry.timestamp).toLocaleString();
					const agent = entry.agentName || entry.sourceSessionId.slice(0, 8);
					const summary = (entry.summary || '')
						.replace(/\|/g, '\\|')
						.replace(/\n/g, ' ')
						.slice(0, 60);
					const cost =
						entry.usageStats?.totalCostUsd !== undefined
							? `$${entry.usageStats.totalCostUsd.toFixed(4)}`
							: '-';
					const duration = entry.elapsedTimeMs ? formatDurationMs(entry.elapsedTimeMs) : '-';
					lines.push(`| ${date} | ${entry.type} | ${agent} | ${summary} | ${cost} | ${duration} |`);
				}
			}

			console.log(lines.join('\n'));
		} else {
			console.log(
				formatDirectorNotesHistory(
					{
						stats,
						total: allEntries.length,
						showing: limitedEntries.length,
						entries: limitedEntries,
					},
					lookbackDays
				)
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (resolveFormat(options) === 'json') {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(formatError(message));
		}
		process.exit(1);
	}
}

function formatDurationMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 3600_000) return `${(ms / 60_000).toFixed(1)}m`;
	return `${(ms / 3600_000).toFixed(1)}h`;
}
