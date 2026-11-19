/**
 * Tests for src/shared/playbookTelemetry.ts: the official-only filter, the
 * event shapes, and the run_failed cap and stop rule.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	MAX_PLAYBOOK_RUN_FAILED_EVENTS,
	buildPlaybookInstallEvent,
	buildPlaybookRunCompletedEvent,
	buildPlaybookRunFailedEvents,
	buildPlaybookRunStartedEvent,
	officialPlaybookId,
	type PlaybookTelemetryRunStart,
} from '../../shared/playbookTelemetry';
import type { AutoRunFailureEntry } from '../../shared/stats-types';

const NOW = new Date('2026-11-19T12:00:00.000Z');

const START: PlaybookTelemetryRunStart = {
	playbookId: 'assistants-message-bus',
	sourceVersion: '2026-10-01',
	sourceChannel: 'official',
	launchSource: 'exchange',
	interaction: 'guided',
	documentsTotal: 3,
};

function failure(overrides: Partial<AutoRunFailureEntry> = {}): AutoRunFailureEntry {
	return {
		documentFilename: 'message-bus/1_SETUP.md',
		taskIndex: 2,
		kind: 'error',
		agentType: 'claude-code',
		createdAt: 0,
		...overrides,
	};
}

describe('officialPlaybookId', () => {
	it('returns the id only for an official playbook', () => {
		expect(officialPlaybookId({ playbookId: 'a', sourceChannel: 'official' })).toBe('a');
		expect(officialPlaybookId({ playbookId: 'a', sourceChannel: 'local' })).toBeNull();
		expect(officialPlaybookId({ playbookId: 'a' })).toBeNull();
		expect(officialPlaybookId({ sourceChannel: 'official' })).toBeNull();
		expect(officialPlaybookId({ playbookId: '  ', sourceChannel: 'official' })).toBeNull();
	});
});

describe('buildPlaybookInstallEvent', () => {
	it('builds the install event with the raw (unhashed) playbook id', () => {
		expect(
			buildPlaybookInstallEvent(
				{ playbookId: 'research-market', sourceVersion: '2026-09-01', sourceChannel: 'official' },
				NOW
			)
		).toEqual({
			type: 'install',
			ts: NOW.toISOString(),
			playbook_id: 'research-market',
			source_version: '2026-09-01',
		});
	});

	it('sends a null version when the manifest had none', () => {
		expect(
			buildPlaybookInstallEvent({ playbookId: 'x', sourceChannel: 'official' }, NOW)?.source_version
		).toBeNull();
	});

	it('refuses a local-manifest playbook, including a local override of an official id', () => {
		expect(
			buildPlaybookInstallEvent({ playbookId: 'research-market', sourceChannel: 'local' }, NOW)
		).toBeNull();
	});
});

describe('buildPlaybookRunStartedEvent', () => {
	it('carries exactly the documented fields', () => {
		expect(buildPlaybookRunStartedEvent(START, NOW)).toEqual({
			type: 'run_started',
			ts: NOW.toISOString(),
			playbook_id: 'assistants-message-bus',
			source_version: '2026-10-01',
			launch_source: 'exchange',
			interaction: 'guided',
		});
	});

	it('defaults the interaction to form and the launch source to null', () => {
		const event = buildPlaybookRunStartedEvent(
			{ playbookId: 'x', sourceChannel: 'official', documentsTotal: 1 },
			NOW
		);
		expect(event?.interaction).toBe('form');
		expect(event?.launch_source).toBeNull();
	});

	it('refuses a non-official playbook', () => {
		expect(buildPlaybookRunStartedEvent({ ...START, sourceChannel: 'local' }, NOW)).toBeNull();
	});
});

describe('buildPlaybookRunCompletedEvent', () => {
	it('carries status, duration, and document counts', () => {
		expect(
			buildPlaybookRunCompletedEvent(
				START,
				{ status: 'stalled', durationMs: 1234.7, documentsStalled: 1 },
				NOW
			)
		).toEqual({
			type: 'run_completed',
			ts: NOW.toISOString(),
			playbook_id: 'assistants-message-bus',
			source_version: '2026-10-01',
			status: 'stalled',
			duration_ms: 1234,
			documents_total: 3,
			documents_stalled: 1,
		});
	});

	it('clamps a negative or missing figure to zero', () => {
		const event = buildPlaybookRunCompletedEvent(
			{ ...START, documentsTotal: Number.NaN },
			{ status: 'completed', durationMs: -5 },
			NOW
		);
		expect(event?.duration_ms).toBe(0);
		expect(event?.documents_total).toBe(0);
		expect(event?.documents_stalled).toBe(0);
	});

	it('never names a path, parameter, or agent', () => {
		const event = buildPlaybookRunCompletedEvent(
			START,
			{ status: 'completed', durationMs: 1 },
			NOW
		);
		expect(Object.keys(event ?? {}).sort()).toEqual(
			[
				'documents_stalled',
				'documents_total',
				'duration_ms',
				'playbook_id',
				'source_version',
				'status',
				'ts',
				'type',
			].sort()
		);
	});
});

describe('buildPlaybookRunFailedEvents', () => {
	const fingerprintOf = vi.fn(
		(c: { documentFilename: string; taskIndex: number; kind: string }) =>
			`fp-${c.documentFilename}-${c.taskIndex}-${c.kind}`
	);

	it('emits one event per failure with the bare document name and the fingerprint', () => {
		const events = buildPlaybookRunFailedEvents(
			START,
			{ status: 'failed', durationMs: 10, failures: [failure()] },
			fingerprintOf,
			NOW
		);
		expect(events).toEqual([
			{
				type: 'run_failed',
				ts: NOW.toISOString(),
				playbook_id: 'assistants-message-bus',
				source_version: '2026-10-01',
				document_filename: '1_SETUP',
				task_index: 2,
				kind: 'error',
				fingerprint: 'fp-1_SETUP-2-error',
			},
		]);
		expect(fingerprintOf).toHaveBeenCalledWith({
			playbookId: 'assistants-message-bus',
			sourceVersion: '2026-10-01',
			documentFilename: '1_SETUP',
			taskIndex: 2,
			kind: 'error',
		});
	});

	it('caps the events at five per run', () => {
		const failures = Array.from({ length: 9 }, (_, i) => failure({ taskIndex: i }));
		const events = buildPlaybookRunFailedEvents(
			START,
			{ status: 'failed', durationMs: 10, failures },
			fingerprintOf,
			NOW
		);
		expect(events).toHaveLength(MAX_PLAYBOOK_RUN_FAILED_EVENTS);
		expect(events.map((e) => e.task_index)).toEqual([0, 1, 2, 3, 4]);
	});

	it('emits nothing for a stopped run', () => {
		expect(
			buildPlaybookRunFailedEvents(
				START,
				{ status: 'stopped', durationMs: 10, failures: [failure()] },
				fingerprintOf,
				NOW
			)
		).toEqual([]);
	});

	it('skips a failure with no document or task index', () => {
		const events = buildPlaybookRunFailedEvents(
			START,
			{
				status: 'failed',
				durationMs: 10,
				failures: [
					failure({ documentFilename: undefined }),
					failure({ taskIndex: undefined }),
					failure({ taskIndex: -1 }),
				],
			},
			fingerprintOf,
			NOW
		);
		expect(events).toEqual([]);
	});

	it('emits nothing for a non-official playbook', () => {
		expect(
			buildPlaybookRunFailedEvents(
				{ ...START, sourceChannel: 'local' },
				{ status: 'failed', durationMs: 10, failures: [failure()] },
				fingerprintOf,
				NOW
			)
		).toEqual([]);
	});
});
