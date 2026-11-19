/**
 * Playbook telemetry: the wire events and the pure rules that build them.
 *
 * The main-process channel (`src/main/services/playbook-telemetry.ts`) owns
 * the outbox, the gate, and the POST. This module holds what both sides need
 * without node: the event shapes and the builders, so the renderer can show
 * the literal JSON of an event before the user opts in.
 *
 * Privacy (PROPOSAL D17, the inversion of Cue's rule): Cue hashes names
 * because pipeline names are private. Playbook ids are public slugs shared by
 * every install, so hashing them would destroy the signal. The private things
 * are not hashed; they are not fields at all. No project path, parameter
 * value, agent name, folder name, or user is on any event. Only the envelope's
 * `client_id` (the installation id) identifies anything.
 */

import type {
	AutoRunFailureEntry,
	AutoRunFailureKind,
	AutoRunLaunchSource,
	AutoRunOutcomeStatus,
} from './stats-types';
import type { PlaybookInteraction, PlaybookSourceChannel } from './types';
import { playbookDocumentBaseName } from './playbookFailureCore';

/** At most this many `run_failed` events leave one run. */
export const MAX_PLAYBOOK_RUN_FAILED_EVENTS = 5;

export interface PlaybookTelemetryInstallEvent {
	type: 'install';
	ts: string;
	playbook_id: string;
	source_version: string | null;
}

export interface PlaybookTelemetryRunStartedEvent {
	type: 'run_started';
	ts: string;
	playbook_id: string;
	source_version: string | null;
	launch_source: AutoRunLaunchSource | null;
	interaction: PlaybookInteraction;
}

export interface PlaybookTelemetryRunCompletedEvent {
	type: 'run_completed';
	ts: string;
	playbook_id: string;
	source_version: string | null;
	status: AutoRunOutcomeStatus;
	duration_ms: number;
	documents_total: number;
	documents_stalled: number;
}

export interface PlaybookTelemetryRunFailedEvent {
	type: 'run_failed';
	ts: string;
	playbook_id: string;
	source_version: string | null;
	/** The shipped document name (no folder, no `.md`): the install folder is the user's. */
	document_filename: string;
	task_index: number;
	kind: AutoRunFailureKind;
	/** `playbookFailureFingerprint()`, the same key a filed issue carries. */
	fingerprint: string;
}

export type PlaybookTelemetryEvent =
	| PlaybookTelemetryInstallEvent
	| PlaybookTelemetryRunStartedEvent
	| PlaybookTelemetryRunCompletedEvent
	| PlaybookTelemetryRunFailedEvent;

export type PlaybookTelemetryEventType = PlaybookTelemetryEvent['type'];

/** Which playbook a run or install is about, as the caller knows it. */
export interface PlaybookTelemetrySubject {
	/** `provenance.marketplaceId`. */
	playbookId?: string;
	/** `provenance.sourceVersion`. */
	sourceVersion?: string;
	/** `provenance.sourceChannel`. Only `official` is ever sent. */
	sourceChannel?: PlaybookSourceChannel;
}

/** What the runner knows when a playbook run starts. */
export interface PlaybookTelemetryRunStart extends PlaybookTelemetrySubject {
	launchSource?: AutoRunLaunchSource;
	interaction?: PlaybookInteraction;
	/** Documents in the run list. */
	documentsTotal: number;
}

/** What the runner knows when a playbook run ends. */
export interface PlaybookTelemetryRunEnd {
	status: AutoRunOutcomeStatus;
	durationMs: number;
	documentsStalled?: number;
	failures?: AutoRunFailureEntry[];
}

/** The input of a `run_failed` fingerprint. */
export interface PlaybookTelemetryFailureCoordinates {
	playbookId: string;
	sourceVersion?: string;
	documentFilename: string;
	taskIndex: number;
	kind: AutoRunFailureKind;
}

/**
 * The playbook id when a subject may be sent at all: an official-channel
 * playbook with a marketplace id. A local-manifest playbook would send names
 * its author chose, and a local override of an official id would poison that
 * playbook's public health, so both are refused here.
 */
export function officialPlaybookId(subject: PlaybookTelemetrySubject): string | null {
	if (subject.sourceChannel !== 'official') return null;
	const id = subject.playbookId?.trim();
	return id ? id : null;
}

function nonNegativeInt(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function sourceVersionOf(subject: PlaybookTelemetrySubject): string | null {
	return subject.sourceVersion?.trim() || null;
}

export function buildPlaybookInstallEvent(
	subject: PlaybookTelemetrySubject,
	now: Date = new Date()
): PlaybookTelemetryInstallEvent | null {
	const playbookId = officialPlaybookId(subject);
	if (!playbookId) return null;
	return {
		type: 'install',
		ts: now.toISOString(),
		playbook_id: playbookId,
		source_version: sourceVersionOf(subject),
	};
}

export function buildPlaybookRunStartedEvent(
	start: PlaybookTelemetryRunStart,
	now: Date = new Date()
): PlaybookTelemetryRunStartedEvent | null {
	const playbookId = officialPlaybookId(start);
	if (!playbookId) return null;
	return {
		type: 'run_started',
		ts: now.toISOString(),
		playbook_id: playbookId,
		source_version: sourceVersionOf(start),
		launch_source: start.launchSource ?? null,
		interaction: start.interaction ?? 'form',
	};
}

export function buildPlaybookRunCompletedEvent(
	start: PlaybookTelemetryRunStart,
	end: PlaybookTelemetryRunEnd,
	now: Date = new Date()
): PlaybookTelemetryRunCompletedEvent | null {
	const playbookId = officialPlaybookId(start);
	if (!playbookId) return null;
	return {
		type: 'run_completed',
		ts: now.toISOString(),
		playbook_id: playbookId,
		source_version: sourceVersionOf(start),
		status: end.status,
		duration_ms: nonNegativeInt(end.durationMs),
		documents_total: nonNegativeInt(start.documentsTotal),
		documents_stalled: nonNegativeInt(end.documentsStalled),
	};
}

/**
 * The `run_failed` events of one run: one per recorded failure that names a
 * document and a task, at most `MAX_PLAYBOOK_RUN_FAILED_EVENTS`, and none at
 * all for a run the user stopped (a stop is a choice, not a defect).
 * `fingerprintOf` is injected because the fingerprint hashes with node crypto.
 */
export function buildPlaybookRunFailedEvents(
	start: PlaybookTelemetryRunStart,
	end: PlaybookTelemetryRunEnd,
	fingerprintOf: (coordinates: PlaybookTelemetryFailureCoordinates) => string,
	now: Date = new Date()
): PlaybookTelemetryRunFailedEvent[] {
	const playbookId = officialPlaybookId(start);
	if (!playbookId || end.status === 'stopped') return [];
	const events: PlaybookTelemetryRunFailedEvent[] = [];
	for (const failure of end.failures ?? []) {
		if (events.length >= MAX_PLAYBOOK_RUN_FAILED_EVENTS) break;
		const documentFilename = playbookDocumentBaseName(failure.documentFilename ?? '');
		const taskIndex = failure.taskIndex;
		if (
			!documentFilename ||
			typeof taskIndex !== 'number' ||
			!Number.isInteger(taskIndex) ||
			taskIndex < 0
		) {
			continue;
		}
		const sourceVersion = sourceVersionOf(start);
		events.push({
			type: 'run_failed',
			ts: now.toISOString(),
			playbook_id: playbookId,
			source_version: sourceVersion,
			document_filename: documentFilename,
			task_index: taskIndex,
			kind: failure.kind,
			fingerprint: fingerprintOf({
				playbookId,
				...(sourceVersion && { sourceVersion }),
				documentFilename,
				taskIndex,
				kind: failure.kind,
			}),
		});
	}
	return events;
}
