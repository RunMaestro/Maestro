/**
 * Tests for the Context Timeline IPC handlers (finding S1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import { registerContextTimelineHandlers } from '../../../../main/ipc/handlers/context-timeline';
import {
	appendUsageCapture,
	getUsageCaptures,
	__resetUsageCaptureLogForTests,
} from '../../../../main/process-listeners/context-timeline-log';
import type { UsageStats } from '../../../../shared/types';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const usage = (overrides: Partial<UsageStats> = {}): UsageStats => ({
	inputTokens: 100,
	outputTokens: 50,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
	totalCostUsd: 0,
	contextWindow: 200000,
	...overrides,
});

describe('Context Timeline IPC Handlers', () => {
	let handlers: Map<string, Handler>;

	beforeEach(() => {
		vi.clearAllMocks();
		__resetUsageCaptureLogForTests();
		handlers = new Map();
		(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
			(channel: string, handler: Handler) => {
				handlers.set(channel, handler);
			}
		);
		registerContextTimelineHandlers();
	});

	it('registers both channels', () => {
		expect(handlers.has('contextTimeline:getCaptures')).toBe(true);
		expect(handlers.has('contextTimeline:clearCaptures')).toBe(true);
	});

	it('returns the captures and the trimmed flag for an agent', async () => {
		appendUsageCapture('agent-1', usage({ inputTokens: 1 }));
		appendUsageCapture('agent-1-ai-tab1', usage({ inputTokens: 2 }));

		const result = (await handlers.get('contextTimeline:getCaptures')!(null, 'agent-1')) as {
			success: boolean;
			captures: Array<{ usageStats: UsageStats }>;
			trimmed: boolean;
		};

		expect(result.success).toBe(true);
		expect(result.trimmed).toBe(false);
		expect(result.captures.map((c) => c.usageStats.inputTokens)).toEqual([1, 2]);
	});

	it('returns an empty result for a null session id', async () => {
		const result = (await handlers.get('contextTimeline:getCaptures')!(null, null)) as {
			success: boolean;
			captures: unknown[];
		};
		expect(result.success).toBe(true);
		expect(result.captures).toEqual([]);
	});

	it('does not read anything off the IPC event (web-desktop bridge has no sender)', async () => {
		appendUsageCapture('agent-1', usage());
		const hostileEvent = new Proxy(
			{},
			{
				get() {
					throw new Error('handler must not touch the IPC event');
				},
			}
		);
		await expect(
			handlers.get('contextTimeline:getCaptures')!(hostileEvent, 'agent-1')
		).resolves.toMatchObject({ success: true });
	});

	it('clears the captures for an agent', async () => {
		appendUsageCapture('agent-1', usage());
		appendUsageCapture('agent-2', usage());

		const result = (await handlers.get('contextTimeline:clearCaptures')!(null, 'agent-1')) as {
			success: boolean;
		};

		expect(result.success).toBe(true);
		expect(getUsageCaptures('agent-1').captures).toHaveLength(0);
		expect(getUsageCaptures('agent-2').captures).toHaveLength(1);
	});
});
