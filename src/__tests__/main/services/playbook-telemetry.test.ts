/**
 * Tests for src/main/services/playbook-telemetry.ts: the opt-in gate, the
 * official-only filter, the run lifecycle, and the outbox -> POST -> delete
 * flush with Cue's envelope and the playbook backoff header.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	PLAYBOOK_TELEMETRY_BACKOFF_HEADER,
	PLAYBOOK_TELEMETRY_KILL_SWITCH,
	configurePlaybookTelemetry,
	flushPlaybookTelemetry,
	notePlaybookRunEnded,
	notePlaybookRunStarted,
	playbookTelemetryWritesSettled,
	recordPlaybookInstall,
	resetPlaybookTelemetryForTests,
	type PlaybookTelemetryConfig,
} from '../../../main/services/playbook-telemetry';
import { playbookFailureFingerprint } from '../../../shared/playbookFailure';
import type { PlaybookTelemetryRunStart } from '../../../shared/playbookTelemetry';

const INSTALL_ID = '11111111-1111-1111-1111-111111111111';

let tmpDir: string;
let outboxPath: string;

function configure(overrides: Partial<PlaybookTelemetryConfig> = {}): void {
	configurePlaybookTelemetry({
		getInstallationId: () => INSTALL_ID,
		getAppVersion: () => '1.2.3',
		getPlatform: () => 'darwin',
		isEnabled: () => true,
		isPackaged: () => true,
		outboxPath,
		endpoint: 'https://test.invalid/api/v1/playbooks/stats',
		...overrides,
	});
}

const OFFICIAL_START: PlaybookTelemetryRunStart = {
	playbookId: 'assistants-message-bus',
	sourceVersion: '2026-10-01',
	sourceChannel: 'official',
	launchSource: 'exchange',
	interaction: 'form',
	documentsTotal: 2,
};

function stubFetch(status = 202, headers: Record<string, string> = {}) {
	const bodies: unknown[] = [];
	globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)));
		return new Response(null, { status, headers });
	}) as unknown as typeof fetch;
	return bodies;
}

async function outboxOnDisk(): Promise<Array<{ event: { type: string } }>> {
	await playbookTelemetryWritesSettled();
	if (!fs.existsSync(outboxPath)) return [];
	return JSON.parse(fs.readFileSync(outboxPath, 'utf8'));
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-telemetry-'));
	outboxPath = path.join(tmpDir, 'outbox.json');
	resetPlaybookTelemetryForTests();
	delete process.env[PLAYBOOK_TELEMETRY_KILL_SWITCH];
	globalThis.fetch = vi.fn(async () => {
		throw new Error('fetch should be stubbed by the test that needs it');
	}) as unknown as typeof fetch;
});

afterEach(async () => {
	await playbookTelemetryWritesSettled();
	resetPlaybookTelemetryForTests();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('gate', () => {
	it('records nothing while the setting is off (the default)', async () => {
		configure({ isEnabled: () => false });
		recordPlaybookInstall({ playbookId: 'x', sourceChannel: 'official' });
		notePlaybookRunStarted('agent-1', OFFICIAL_START);
		expect(await outboxOnDisk()).toEqual([]);
		expect(await flushPlaybookTelemetry()).toEqual({ ok: false, reason: 'disabled' });
	});

	it('records nothing in an unpackaged build', async () => {
		configure({ isPackaged: () => false });
		recordPlaybookInstall({ playbookId: 'x', sourceChannel: 'official' });
		expect(await outboxOnDisk()).toEqual([]);
	});

	it('records nothing with the kill switch set', async () => {
		configure();
		process.env[PLAYBOOK_TELEMETRY_KILL_SWITCH] = '1';
		recordPlaybookInstall({ playbookId: 'x', sourceChannel: 'official' });
		expect(await outboxOnDisk()).toEqual([]);
	});

	it('records nothing before it is configured', async () => {
		recordPlaybookInstall({ playbookId: 'x', sourceChannel: 'official' });
		expect(await flushPlaybookTelemetry()).toEqual({ ok: false, reason: 'disabled' });
	});

	it('does not send run_completed for a run that started while telemetry was off', async () => {
		let enabled = false;
		configure({ isEnabled: () => enabled });
		notePlaybookRunStarted('agent-1', OFFICIAL_START);
		enabled = true;
		notePlaybookRunEnded('agent-1', { status: 'completed', durationMs: 5 });
		expect(await outboxOnDisk()).toEqual([]);
	});
});

describe('official-only filter', () => {
	it('records an official install', async () => {
		configure();
		recordPlaybookInstall({ playbookId: 'research-market', sourceChannel: 'official' });
		expect((await outboxOnDisk()).map((row) => row.event.type)).toEqual(['install']);
	});

	it('drops a local-manifest install and run', async () => {
		configure();
		recordPlaybookInstall({ playbookId: 'research-market', sourceChannel: 'local' });
		notePlaybookRunStarted('agent-1', { ...OFFICIAL_START, sourceChannel: 'local' });
		notePlaybookRunEnded('agent-1', { status: 'completed', durationMs: 5 });
		expect(await outboxOnDisk()).toEqual([]);
	});
});

describe('run lifecycle', () => {
	it('records started, completed, and the failures of one run', async () => {
		configure();
		notePlaybookRunStarted('agent-1', OFFICIAL_START);
		notePlaybookRunEnded('agent-1', {
			status: 'failed',
			durationMs: 900,
			documentsStalled: 0,
			failures: [
				{
					documentFilename: 'bus/1_SETUP.md',
					taskIndex: 1,
					kind: 'error',
					agentType: 'claude-code',
					createdAt: 0,
				},
			],
		});
		const rows = (await outboxOnDisk()) as Array<{ event: Record<string, unknown> }>;
		expect(rows.map((row) => row.event.type)).toEqual([
			'run_started',
			'run_completed',
			'run_failed',
		]);
		expect(rows[2].event.fingerprint).toBe(
			playbookFailureFingerprint({
				playbookId: 'assistants-message-bus',
				sourceVersion: '2026-10-01',
				documentFilename: '1_SETUP',
				taskIndex: 1,
				kind: 'error',
			})
		);
	});

	it('records a stopped run as run_completed with no run_failed', async () => {
		configure();
		notePlaybookRunStarted('agent-1', OFFICIAL_START);
		notePlaybookRunEnded('agent-1', {
			status: 'stopped',
			durationMs: 10,
			failures: [
				{ documentFilename: 'a', taskIndex: 0, kind: 'stall', agentType: 'x', createdAt: 0 },
			],
		});
		const rows = await outboxOnDisk();
		expect(rows.map((row) => row.event.type)).toEqual(['run_started', 'run_completed']);
	});

	it('ignores an end on an agent with no tracked playbook run', async () => {
		configure();
		notePlaybookRunEnded('agent-9', { status: 'stopped', durationMs: 10 });
		expect(await outboxOnDisk()).toEqual([]);
	});
});

describe('flush', () => {
	it('posts Cue-shaped envelope with client_id as the only identity and empties the outbox', async () => {
		configure();
		recordPlaybookInstall({
			playbookId: 'research-market',
			sourceVersion: '2026-09-01',
			sourceChannel: 'official',
		});
		const bodies = stubFetch(202);
		const result = await flushPlaybookTelemetry({ reason: 'autorun' });
		expect(result).toEqual({ ok: true, reason: 'sent', sent: 1 });
		expect(bodies).toHaveLength(1);
		const payload = bodies[0] as Record<string, unknown>;
		expect(payload).toMatchObject({
			schema_version: 1,
			client_id: INSTALL_ID,
			app_version: '1.2.3',
			platform: 'darwin',
			totals: { install: 1, run_started: 0, run_completed: 0, run_failed: 0 },
		});
		expect(payload.events).toEqual([
			expect.objectContaining({ type: 'install', playbook_id: 'research-market' }),
		]);
		expect(await outboxOnDisk()).toEqual([]);
	});

	it('keeps the rows on a 5xx for the next flush', async () => {
		configure();
		recordPlaybookInstall({ playbookId: 'x', sourceChannel: 'official' });
		stubFetch(503);
		expect((await flushPlaybookTelemetry()).reason).toBe('error');
		expect(await outboxOnDisk()).toHaveLength(1);
	});

	it('drops the rows on a 4xx', async () => {
		configure();
		recordPlaybookInstall({ playbookId: 'x', sourceChannel: 'official' });
		stubFetch(400);
		await flushPlaybookTelemetry();
		expect(await outboxOnDisk()).toEqual([]);
	});

	it('honors the backoff header', async () => {
		configure();
		recordPlaybookInstall({ playbookId: 'x', sourceChannel: 'official' });
		stubFetch(202, { [PLAYBOOK_TELEMETRY_BACKOFF_HEADER]: '60' });
		await flushPlaybookTelemetry();
		recordPlaybookInstall({ playbookId: 'y', sourceChannel: 'official' });
		expect(await flushPlaybookTelemetry()).toEqual({ ok: false, reason: 'backoff' });
	});

	it('reads back an outbox an earlier process left on disk', async () => {
		configure();
		recordPlaybookInstall({ playbookId: 'x', sourceChannel: 'official' });
		await playbookTelemetryWritesSettled();
		resetPlaybookTelemetryForTests();
		configure();
		const bodies = stubFetch(202);
		expect((await flushPlaybookTelemetry()).sent).toBe(1);
		expect(bodies).toHaveLength(1);
	});

	it('starts empty from a corrupt outbox file', async () => {
		fs.writeFileSync(outboxPath, '{not json');
		configure();
		expect(await flushPlaybookTelemetry()).toEqual({ ok: true, reason: 'empty' });
	});
});
