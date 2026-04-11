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
enricherRegistry.set('*', (event, subscription, runId) => ({
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
}));

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

/** cli.trigger enricher — adds CLI prompt override field. */
enricherRegistry.set('cli.trigger', (event) => ({
	cliPrompt: String(event.payload.cliPrompt ?? ''),
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
