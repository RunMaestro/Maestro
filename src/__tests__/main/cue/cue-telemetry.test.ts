/**
 * Tests for cue-telemetry.ts — verifies the wire contract negotiated with the
 * runmaestro.ai backend (sha256-truncated identifiers, two-event model,
 * Encore-flag gating, kill-switch env var, and outbox→submit→delete lifecycle).
 *
 * cue-db is mocked at module level so tests run without better-sqlite3's
 * native binary, mirroring the pattern in cue-db.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---- cue-db module mock ----------------------------------------------------
// The outbox is an in-memory array shared with the test body. Each helper is
// vi.fn() so we can assert call patterns (e.g. that delete is called only on
// successful flush).

let outbox: Array<{ id: string; eventJson: string; createdAt: number }> = [];

const mockInsert = vi.fn((id: string, eventJson: string) => {
	outbox.push({ id, eventJson, createdAt: Date.now() });
});

const mockGetBatch = vi.fn((limit: number) => outbox.slice(0, limit));

const mockDelete = vi.fn((ids: string[]) => {
	const idSet = new Set(ids);
	outbox = outbox.filter((row) => !idSet.has(row.id));
});

const mockCount = vi.fn(() => outbox.length);

vi.mock('../../../main/cue/cue-db', () => ({
	insertTelemetryEvent: (id: string, json: string) => mockInsert(id, json),
	getTelemetryBatch: (limit: number) => mockGetBatch(limit),
	deleteTelemetryEvents: (ids: string[]) => mockDelete(ids),
	countTelemetryEvents: () => mockCount(),
}));

// Mock the logger to suppress output during tests.
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import {
	configureCueTelemetry,
	flushTelemetry,
	hashName,
	recordRunCompleted,
	recordTriggerFired,
	resetCueTelemetryForTests,
	type CueTelemetryEvent,
} from '../../../main/cue/cue-telemetry';

const INSTALL_ID = '11111111-1111-1111-1111-111111111111';

function defaultConfig(overrides: Partial<Parameters<typeof configureCueTelemetry>[0]> = {}) {
	return {
		getInstallationId: () => INSTALL_ID,
		getAppVersion: () => '1.2.3',
		getPlatform: () => 'darwin',
		isEncoreEnabled: () => true,
		endpoint: 'https://test.invalid/api/v1/cue/stats',
		...overrides,
	};
}

beforeEach(() => {
	outbox = [];
	mockInsert.mockClear();
	mockGetBatch.mockClear();
	mockDelete.mockClear();
	mockCount.mockClear();
	resetCueTelemetryForTests();
	delete process.env.MAESTRO_DISABLE_CUE_TELEMETRY;
	// Provide a default fetch stub so a stray network call in a misconfigured
	// test fails loudly rather than reaching the real network.
	globalThis.fetch = vi.fn(async () => {
		throw new Error('fetch should be stubbed by the test that needs it');
	}) as unknown as typeof fetch;
});

afterEach(() => {
	resetCueTelemetryForTests();
});

// ---- hashName --------------------------------------------------------------

describe('hashName', () => {
	it('produces a stable 16-char hex hash for the same install + name', () => {
		const a = hashName('pipeline:nightly', INSTALL_ID);
		const b = hashName('pipeline:nightly', INSTALL_ID);
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{16}$/);
	});

	it('produces a different hash for a different name on the same install', () => {
		const a = hashName('pipeline:a', INSTALL_ID);
		const b = hashName('pipeline:b', INSTALL_ID);
		expect(a).not.toBe(b);
	});

	it('produces a different hash for the same name on a different install (salt isolation)', () => {
		const a = hashName('pipeline:nightly', INSTALL_ID);
		const b = hashName('pipeline:nightly', '99999999-9999-9999-9999-999999999999');
		expect(a).not.toBe(b);
	});

	it('returns null when installationId is missing', () => {
		expect(hashName('something', null)).toBeNull();
	});

	it('returns null when name is empty', () => {
		expect(hashName('', INSTALL_ID)).toBeNull();
		expect(hashName(undefined, INSTALL_ID)).toBeNull();
	});
});

// ---- gating ---------------------------------------------------------------

describe('gating', () => {
	it('does not record events when telemetry is unconfigured', () => {
		recordTriggerFired({
			eventType: 'time.scheduled',
			subscriptionName: 'sub',
			triggerName: 'cron',
		});
		expect(mockInsert).not.toHaveBeenCalled();
	});

	it('does not record events when Encore flags are off', () => {
		configureCueTelemetry(defaultConfig({ isEncoreEnabled: () => false }));
		recordTriggerFired({
			eventType: 'time.scheduled',
			subscriptionName: 'sub',
			triggerName: 'cron',
		});
		expect(mockInsert).not.toHaveBeenCalled();
	});

	it('does not record events when the kill-switch env var is set', () => {
		configureCueTelemetry(defaultConfig());
		process.env.MAESTRO_DISABLE_CUE_TELEMETRY = '1';
		recordTriggerFired({
			eventType: 'time.scheduled',
			subscriptionName: 'sub',
			triggerName: 'cron',
		});
		expect(mockInsert).not.toHaveBeenCalled();
	});

	it('does not record events when installationId is null', () => {
		configureCueTelemetry(defaultConfig({ getInstallationId: () => null }));
		recordTriggerFired({
			eventType: 'time.scheduled',
			subscriptionName: 'sub',
			triggerName: 'cron',
		});
		expect(mockInsert).not.toHaveBeenCalled();
	});
});

// ---- recordTriggerFired ---------------------------------------------------

describe('recordTriggerFired', () => {
	beforeEach(() => {
		configureCueTelemetry(defaultConfig());
	});

	it('writes one outbox row per call with hashed identifiers', () => {
		recordTriggerFired({
			eventType: 'github.pull_request',
			subscriptionName: 'pr-handler',
			pipelineName: 'review-flow',
			triggerName: 'maestroio/maestro',
		});

		expect(mockInsert).toHaveBeenCalledTimes(1);
		const json = mockInsert.mock.calls[0][1];
		const event = JSON.parse(json) as CueTelemetryEvent;

		expect(event.type).toBe('trigger_fired');
		if (event.type !== 'trigger_fired') return; // type narrowing
		expect(event.event_type).toBe('github.pull_request');
		expect(event.subscription_id_hash).toMatch(/^[0-9a-f]{16}$/);
		expect(event.pipeline_id_hash).toMatch(/^[0-9a-f]{16}$/);
		expect(event.trigger_id_hash).toMatch(/^[0-9a-f]{16}$/);
		// No raw names anywhere in the serialized payload.
		expect(json).not.toContain('pr-handler');
		expect(json).not.toContain('review-flow');
		expect(json).not.toContain('maestroio/maestro');
	});

	it('omits pipeline_id_hash when no pipeline name is provided', () => {
		recordTriggerFired({
			eventType: 'time.scheduled',
			subscriptionName: 'sub',
			triggerName: 'cron',
		});
		const event = JSON.parse(mockInsert.mock.calls[0][1]) as CueTelemetryEvent;
		if (event.type !== 'trigger_fired') return;
		expect(event.pipeline_id_hash).toBeNull();
	});
});

// ---- recordRunCompleted ---------------------------------------------------

describe('recordRunCompleted', () => {
	beforeEach(() => {
		configureCueTelemetry(defaultConfig());
	});

	it('preserves chain_root_id raw and hashes the subscription name', () => {
		recordRunCompleted({
			subscriptionName: 'sub-1',
			pipelineName: 'pipeline-A',
			taskKind: 'agent_handoff',
			chainRootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
			parentRunId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
			durationMs: 4321,
			status: 'completed',
		});
		const event = JSON.parse(mockInsert.mock.calls[0][1]) as CueTelemetryEvent;
		if (event.type !== 'run_completed') {
			throw new Error('expected run_completed');
		}
		expect(event.chain_root_id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
		expect(event.parent_run_id).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
		expect(event.subscription_id_hash).toMatch(/^[0-9a-f]{16}$/);
		expect(event.task_kind).toBe('agent_handoff');
		expect(event.duration_ms).toBe(4321);
		expect(event.status).toBe('completed');
	});

	it('floors negative durations to zero', () => {
		recordRunCompleted({
			subscriptionName: 's',
			taskKind: 'trigger_action',
			durationMs: -50,
			status: 'failed',
		});
		const event = JSON.parse(mockInsert.mock.calls[0][1]) as CueTelemetryEvent;
		if (event.type !== 'run_completed') return;
		expect(event.duration_ms).toBe(0);
	});
});

// ---- flushTelemetry --------------------------------------------------------

describe('flushTelemetry', () => {
	beforeEach(() => {
		configureCueTelemetry(defaultConfig());
	});

	it('returns disabled when telemetry is gated off', async () => {
		resetCueTelemetryForTests();
		const result = await flushTelemetry({ reason: 'manual' });
		expect(result).toEqual({ ok: false, reason: 'disabled' });
	});

	it('returns empty when the outbox is empty', async () => {
		const result = await flushTelemetry({ reason: 'manual' });
		expect(result).toEqual({ ok: true, reason: 'empty' });
	});

	it('posts to the configured endpoint with hashed payload and clears the outbox on 2xx', async () => {
		recordTriggerFired({
			eventType: 'time.scheduled',
			subscriptionName: 'sub-x',
			triggerName: 'every-5m',
		});
		recordRunCompleted({
			subscriptionName: 'sub-x',
			taskKind: 'trigger_action',
			durationMs: 100,
			status: 'completed',
		});
		expect(outbox).toHaveLength(2);

		let capturedRequest: { url: string; init: RequestInit } | null = null;
		globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			capturedRequest = { url: String(url), init: init ?? {} };
			return new Response('{}', { status: 202, headers: { 'Content-Type': 'application/json' } });
		}) as unknown as typeof fetch;

		const result = await flushTelemetry({ reason: 'autorun' });
		expect(result.ok).toBe(true);
		expect(result.reason).toBe('sent');
		expect(result.sent).toBe(2);

		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest!.url).toBe('https://test.invalid/api/v1/cue/stats');
		const body = JSON.parse(capturedRequest!.init.body as string);
		expect(body.schema_version).toBe(1);
		expect(body.client_id).toBe(INSTALL_ID);
		expect(body.platform).toBe('darwin');
		expect(body.app_version).toBe('1.2.3');
		expect(body.events).toHaveLength(2);
		expect(body.totals.trigger_fired).toBe(1);
		expect(body.totals.run_completed).toBe(1);
		expect(body.totals.execution_time_ms).toBe(100);

		// Outbox drained on success.
		expect(outbox).toHaveLength(0);
		expect(mockDelete).toHaveBeenCalledTimes(1);
	});

	it('leaves outbox rows in place when the server returns 5xx', async () => {
		recordTriggerFired({
			eventType: 'time.scheduled',
			subscriptionName: 's',
			triggerName: 't',
		});
		expect(outbox).toHaveLength(1);

		globalThis.fetch = vi.fn(
			async () => new Response('Server error', { status: 503 })
		) as unknown as typeof fetch;

		const result = await flushTelemetry({ reason: 'manual' });
		expect(result.ok).toBe(false);
		expect(result.error).toBe('http-503');
		expect(outbox).toHaveLength(1);
		expect(mockDelete).not.toHaveBeenCalled();
	});

	it('drops the batch on 4xx so a malformed payload does not retry forever', async () => {
		recordTriggerFired({
			eventType: 'time.scheduled',
			subscriptionName: 's',
			triggerName: 't',
		});
		globalThis.fetch = vi.fn(
			async () => new Response('Bad request', { status: 400 })
		) as unknown as typeof fetch;

		const result = await flushTelemetry({ reason: 'manual' });
		expect(result.ok).toBe(false);
		expect(result.error).toBe('http-400');
		expect(outbox).toHaveLength(0);
	});

	it('honors the X-Cue-Telemetry-Backoff header by pausing subsequent flushes', async () => {
		recordTriggerFired({
			eventType: 'time.scheduled',
			subscriptionName: 's',
			triggerName: 't',
		});
		globalThis.fetch = vi.fn(
			async () =>
				new Response('{}', {
					status: 200,
					headers: { 'X-Cue-Telemetry-Backoff': '60' },
				})
		) as unknown as typeof fetch;

		const first = await flushTelemetry({ reason: 'manual' });
		expect(first.ok).toBe(true);

		recordTriggerFired({
			eventType: 'time.scheduled',
			subscriptionName: 's2',
			triggerName: 't',
		});
		const second = await flushTelemetry({ reason: 'manual' });
		expect(second).toEqual({ ok: false, reason: 'backoff' });
		// fetch was only called once — backoff blocked the second flush.
		expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(
			1
		);
	});

	it('does not double-flush when called concurrently', async () => {
		recordTriggerFired({
			eventType: 'time.scheduled',
			subscriptionName: 's',
			triggerName: 't',
		});
		let resolveFetch: (r: Response) => void = () => undefined;
		globalThis.fetch = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				})
		) as unknown as typeof fetch;

		const p1 = flushTelemetry({ reason: 'manual' });
		const p2 = flushTelemetry({ reason: 'manual' });
		const r2 = await p2;
		expect(r2).toEqual({ ok: false, reason: 'in-flight' });

		resolveFetch(new Response('{}', { status: 202 }));
		const r1 = await p1;
		expect(r1.ok).toBe(true);
	});

	it('survives a network error without throwing or losing rows', async () => {
		recordTriggerFired({
			eventType: 'time.scheduled',
			subscriptionName: 's',
			triggerName: 't',
		});
		globalThis.fetch = vi.fn(async () => {
			throw new Error('ECONNREFUSED');
		}) as unknown as typeof fetch;

		const result = await flushTelemetry({ reason: 'manual' });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe('error');
		expect(outbox).toHaveLength(1);
	});
});
