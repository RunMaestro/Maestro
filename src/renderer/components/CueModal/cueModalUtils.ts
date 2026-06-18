/**
 * Shared utilities for CueModal sub-components.
 *
 * Formatting functions, pipeline mapping helpers.
 */

import type { CuePipeline } from '../../../shared/cue-pipeline-types';
import { formatDurationHuman } from '../../../shared/formatters';

export function formatRelativeTime(dateStr?: string): string {
	if (!dateStr) return '—';
	const parsed = new Date(dateStr).getTime();
	if (isNaN(parsed)) return '—';
	const diff = Date.now() - parsed;
	if (diff < 0) return 'just now';
	const seconds = Math.floor(diff / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

export const formatDuration = formatDurationHuman;

export function formatElapsed(startedAt: string): string {
	const parsed = new Date(startedAt).getTime();
	if (isNaN(parsed)) return formatDuration(0);
	return formatDuration(Math.max(0, Date.now() - parsed));
}

/**
 * Informational stderr diagnostics that a few agent CLIs emit on every run —
 * they are NOT actual errors and are misleading when painted red under the
 * "Errors" header. Matched as case-insensitive line prefixes after trimming,
 * so minor variants (trailing dots, extra whitespace) are all caught.
 *
 * This runs at display time in addition to the backend filter in
 * `cue-process-lifecycle.ts` so it also covers (a) pre-fix activity-log
 * entries still in the in-memory ring buffer and (b) any future diagnostic
 * wording we haven't yet added to the backend allowlist. A display-time
 * filter is safe because the patterns are intentionally specific — real
 * errors from any supported agent don't start with any of these strings.
 */
const BENIGN_STDERR_LINE_PREFIXES = ['reading additional input from stdin'];

export function cleanStderrForDisplay(rawStderr: string): string {
	if (!rawStderr) return rawStderr;
	const lines = rawStderr.split('\n');
	const kept: string[] = [];
	for (const line of lines) {
		const normalised = line.trim().toLowerCase();
		if (BENIGN_STDERR_LINE_PREFIXES.some((prefix) => normalised.startsWith(prefix))) continue;
		kept.push(line);
	}
	const cleaned = kept.join('\n');
	return cleaned.trim() ? cleaned : '';
}

/** Maps subscription names to pipeline info by checking name prefixes. */
export function buildSubscriptionPipelineMap(
	pipelines: CuePipeline[]
): Map<string, { name: string; color: string }> {
	const map = new Map<string, { name: string; color: string }>();
	for (const pipeline of pipelines) {
		// Pipeline subscriptions are named: pipelineName, pipelineName-chain-N
		map.set(pipeline.name, { name: pipeline.name, color: pipeline.color });
	}
	return map;
}

/** Looks up the pipeline for a subscription name by matching the base name prefix. */
export function getPipelineForSubscription(
	subscriptionName: string,
	pipelineMap: Map<string, { name: string; color: string }>
): { name: string; color: string } | null {
	// Strip -chain-N suffix to get base pipeline name
	const baseName = subscriptionName.replace(/-chain-\d+$/, '').replace(/-fanin$/, '');
	return pipelineMap.get(baseName) ?? null;
}

/** Formats event payload into human-readable key-value pairs, filtering out noise. */
export function formatPayloadEntries(payload: Record<string, unknown>): Array<[string, string]> {
	const skipKeys = new Set(['outputPromptPhase', 'manual']);
	const entries: Array<[string, string]> = [];
	for (const [key, value] of Object.entries(payload)) {
		if (skipKeys.has(key)) continue;
		if (value === undefined || value === null || value === '') continue;
		const strValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
		// Truncate very long values for display
		entries.push([key, strValue.length > 500 ? strValue.slice(0, 500) + '…' : strValue]);
	}
	return entries;
}
