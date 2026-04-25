/**
 * Cue Template Context Builder — builds the `templateContext.cue` object
 * from a CueEvent's payload using an enricher registry pattern.
 *
 * Each event type registers an enricher function that maps payload fields
 * to template context keys. Adding a new event type requires only adding
 * one enricher entry — no changes to the executor or engine.
 */

import type { CueEvent, CueSubscription } from './cue-types';
import type { CueEventType } from '../../shared/cue/contracts';
import type { TemplateContext } from '../../shared/templateVariables';
import { sanitizeVarName } from '../../shared/cue-pipeline-types';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A function that extracts template context fields from an event payload. */
type CueContextEnricher = (
	event: CueEvent,
	subscription: CueSubscription,
	runId: string
) => Record<string, string>;

/** The cue sub-object of TemplateContext */
export type CueTemplateContext = NonNullable<TemplateContext['cue']>;

// ─── Enricher Registry ───────────────────────────────────────────────────────

/**
 * Registry of enricher functions keyed by event type.
 * The special key '*' runs for every event type (base fields).
 */
const enricherRegistry = new Map<CueEventType | '*', CueContextEnricher>();

/** Base enricher — runs for all event types. Populates common fields. */
enricherRegistry.set('*', (event, subscription, runId) => {
	const base: Record<string, string> = {
		eventType: event.type,
		eventTimestamp: event.timestamp,
		triggerName: subscription.name,
		runId,
		filePath: String(event.payload.path ?? ''),
		fileName: String(event.payload.filename ?? ''),
		fileDir: String(event.payload.directory ?? ''),
		fileExt: String(event.payload.extension ?? ''),
		fileChangeType: String(event.payload.changeType ?? ''),
		sourceSession: String(event.payload.sourceSession ?? ''),
		sourceOutput: String(event.payload.sourceOutput ?? ''),
		sourceStatus: String(event.payload.status ?? ''),
		sourceExitCode: String(event.payload.exitCode ?? ''),
		sourceDuration: String(event.payload.durationMs ?? ''),
		sourceTriggeredBy: String(event.payload.triggeredBy ?? ''),
		// Unified "triggering agent's session ID" — populated by the completion
		// service (sourceSessionId) for agent.completed and by the CLI handler
		// (sourceAgentId) for cli.trigger. Surfaced to users as {{CUE_FROM_AGENT}}
		// so a single variable references whichever upstream agent fired this run.
		fromAgent: String(event.payload.sourceSessionId ?? event.payload.sourceAgentId ?? ''),
	};

	// Per-source output variables (e.g. CUE_OUTPUT_AGENT_A) so users can
	// place individual upstream outputs at specific positions in their prompt.
	const perSource = event.payload.perSourceOutputs as Record<string, string> | undefined;
	if (perSource) {
		for (const [name, output] of Object.entries(perSource)) {
			base[`output_${sanitizeVarName(name)}`] = output;
		}
	}

	// Forwarded outputs from earlier in the chain (e.g. CUE_FORWARDED_AGENT_B).
	const forwarded = event.payload.forwardedOutputs as Record<string, string> | undefined;
	if (forwarded) {
		for (const [name, output] of Object.entries(forwarded)) {
			base[`forwarded_${sanitizeVarName(name)}`] = output;
		}
	}

	return base;
});

/** task.pending enricher — adds task-specific fields. */
enricherRegistry.set('task.pending', (event) => ({
	taskFile: String(event.payload.path ?? ''),
	taskFileName: String(event.payload.filename ?? ''),
	taskFileDir: String(event.payload.directory ?? ''),
	taskCount: String(event.payload.taskCount ?? '0'),
	taskList: String(event.payload.taskList ?? ''),
	taskContent: String(event.payload.content ?? ''),
}));

/** Shared GitHub enricher for both pull_request and issue events. */
function buildGitHubContext(event: CueEvent): Record<string, string> {
	return {
		ghType: String(event.payload.type ?? ''),
		ghNumber: String(event.payload.number ?? ''),
		ghTitle: String(event.payload.title ?? ''),
		ghAuthor: String(event.payload.author ?? ''),
		ghUrl: String(event.payload.url ?? ''),
		ghBody: String(event.payload.body ?? ''),
		ghLabels: String(event.payload.labels ?? ''),
		ghState: String(event.payload.state ?? ''),
		ghRepo: String(event.payload.repo ?? ''),
		ghBranch: String(event.payload.head_branch ?? ''),
		ghBaseBranch: String(event.payload.base_branch ?? ''),
		ghAssignees: String(event.payload.assignees ?? ''),
		ghMergedAt: String(event.payload.merged_at ?? ''),
	};
}

enricherRegistry.set('github.pull_request', (event) => buildGitHubContext(event));
enricherRegistry.set('github.issue', (event) => buildGitHubContext(event));

/** cli.trigger enricher — adds CLI-specific fields. */
enricherRegistry.set('cli.trigger', (event) => ({
	cliPrompt: String(event.payload.cliPrompt ?? ''),
	sourceAgentId: String(event.payload.sourceAgentId ?? ''),
}));

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build the `templateContext.cue` object for a given event.
 *
 * Applies the base ('*') enricher first, then the event-type-specific enricher
 * if one exists. The result is a flat Record<string, string> that maps to
 * CUE_* template variables via substituteTemplateVariables.
 */
export function buildCueTemplateContext(
	event: CueEvent,
	subscription: CueSubscription,
	runId: string
): CueTemplateContext {
	let context: Record<string, string> = {};

	// Apply base enricher (always runs)
	const baseEnricher = enricherRegistry.get('*');
	if (baseEnricher) {
		context = { ...context, ...baseEnricher(event, subscription, runId) };
	}

	// Apply event-type-specific enricher (if registered)
	const specificEnricher = enricherRegistry.get(event.type as CueEventType);
	if (specificEnricher) {
		context = { ...context, ...specificEnricher(event, subscription, runId) };
	}

	return context as CueTemplateContext;
}
