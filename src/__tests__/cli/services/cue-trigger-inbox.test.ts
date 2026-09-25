/**
 * The file inbox that lets `maestro-cli cue trigger` fire a subscription on a
 * STANDALONE engine, which has no desktop WebSocket to receive it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	drainCueTriggerInbox,
	startCueTriggerInbox,
	submitCueTrigger,
} from '../../../cli/services/cue-trigger-inbox';

describe('cue-trigger-inbox', () => {
	let dataDir: string;

	beforeEach(() => {
		dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-inbox-test-'));
	});

	afterEach(() => {
		fs.rmSync(dataDir, { recursive: true, force: true });
	});

	it('delivers a trigger to the engine and returns its answer', async () => {
		const handler = vi.fn(() => true);
		const stop = startCueTriggerInbox(handler, dataDir);
		try {
			const result = await submitCueTrigger(
				{ subscriptionName: 'deploy', prompt: 'staging only', sourceAgentId: 'agent-1' },
				{ dataDir, timeoutMs: 5000 }
			);
			expect(result).toEqual({ success: true, error: undefined });
			expect(handler).toHaveBeenCalledWith('deploy', 'staging only', 'agent-1');
		} finally {
			stop();
		}
		// Nothing is left behind once both sides are done.
		expect(fs.readdirSync(path.join(dataDir, 'cue-trigger-inbox'))).toEqual([]);
	});

	it('reports an unknown subscription as a failure, not a success', async () => {
		const stop = startCueTriggerInbox(() => false, dataDir);
		try {
			const result = await submitCueTrigger({ subscriptionName: 'nope' }, { dataDir });
			expect(result.success).toBe(false);
		} finally {
			stop();
		}
	});

	it('fires each request exactly once even when drained repeatedly', async () => {
		const handler = vi.fn(() => true);
		const pending = submitCueTrigger({ subscriptionName: 'once' }, { dataDir, timeoutMs: 3000 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		drainCueTriggerInbox(handler, dataDir);
		drainCueTriggerInbox(handler, dataDir);
		expect((await pending).success).toBe(true);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('times out cleanly and withdraws the request when no engine is serving', async () => {
		const result = await submitCueTrigger({ subscriptionName: 'x' }, { dataDir, timeoutMs: 200 });
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/did not answer/);
		// A late-starting engine must not fire a request its sender gave up on.
		const handler = vi.fn(() => true);
		drainCueTriggerInbox(handler, dataDir);
		expect(handler).not.toHaveBeenCalled();
	});

	it('drops a stale request instead of firing it', () => {
		const dir = path.join(dataDir, 'cue-trigger-inbox');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'old.request.json'),
			JSON.stringify({ subscriptionName: 'deploy', requestedAt: Date.now() - 5 * 60_000 })
		);
		const handler = vi.fn(() => true);
		drainCueTriggerInbox(handler, dataDir);
		expect(handler).not.toHaveBeenCalled();
		expect(fs.readdirSync(dir)).toEqual([]);
	});
});
