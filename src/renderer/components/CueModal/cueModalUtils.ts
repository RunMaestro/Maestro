/**
 * Shared utilities for CueModal sub-components.
 *
 * Formatting functions, pipeline mapping helpers.
 */

import type { CuePipeline } from '../../../shared/cue-pipeline-types';

export function formatRelativeTime(dateStr?: string): string {
	if (!dateStr) return '—';
	const diff = Date.now() - new Date(dateStr).getTime();
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

export function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainSeconds = seconds % 60;
	return `${minutes}m ${remainSeconds}s`;
}

export function formatElapsed(startedAt: string): string {
	const diff = Date.now() - new Date(startedAt).getTime();
	return formatDuration(Math.max(0, diff));
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
