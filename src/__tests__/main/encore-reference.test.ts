/**
 * Tests for Reference Plugins (Agent Status Exporter & Notification Webhook)
 *
 * Covers:
 * - Agent Status Exporter: activate/deactivate exports, event subscriptions, debounced writes, JSON schema
 * - Notification Webhook: activate/deactivate exports, webhook sending, settings-based gating
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Agent Status Exporter Tests ────────────────────────────────────────────

describe('Agent Status Exporter Plugin', () => {
	let dashboard: any;
	let mockApi: any;
	let storageWrites: Array<{ filename: string; data: string }>;
	let eventHandlers: Record<string, Array<(...args: any[]) => void>>;

	beforeEach(() => {
		vi.useFakeTimers();
		storageWrites = [];
		eventHandlers = {};

		// Fresh module for each test to reset module-level state
		vi.resetModules();
		dashboard = require('../../encores/agent-status-exporter/index.js');

		mockApi = {
			process: {
				getActiveProcesses: vi.fn().mockResolvedValue([]),
				onData: vi.fn((cb: any) => {
					if (!eventHandlers['data']) eventHandlers['data'] = [];
					eventHandlers['data'].push(cb);
					return vi.fn();
				}),
				onUsage: vi.fn((cb: any) => {
					if (!eventHandlers['usage']) eventHandlers['usage'] = [];
					eventHandlers['usage'].push(cb);
					return vi.fn();
				}),
				onToolExecution: vi.fn((cb: any) => {
					if (!eventHandlers['tool']) eventHandlers['tool'] = [];
					eventHandlers['tool'].push(cb);
					return vi.fn();
				}),
				onExit: vi.fn((cb: any) => {
					if (!eventHandlers['exit']) eventHandlers['exit'] = [];
					eventHandlers['exit'].push(cb);
					return vi.fn();
				}),
			},
			storage: {
				write: vi.fn(async (filename: string, data: string) => {
					storageWrites.push({ filename, data });
				}),
				read: vi.fn().mockResolvedValue(null),
				list: vi.fn().mockResolvedValue([]),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			settings: {
				get: vi.fn().mockResolvedValue(undefined),
			},
		};
	});

	afterEach(async () => {
		// Clean up heartbeat timer by deactivating
		try { await dashboard.deactivate(); } catch { /* ignore if not activated */ }
		vi.useRealTimers();
	});

	it('exports activate and deactivate functions', () => {
		expect(typeof dashboard.activate).toBe('function');
		expect(typeof dashboard.deactivate).toBe('function');
	});

	it('calls getActiveProcesses on activate', async () => {
		await dashboard.activate(mockApi);
		expect(mockApi.process.getActiveProcesses).toHaveBeenCalledOnce();
	});

	it('subscribes to all four process events', async () => {
		await dashboard.activate(mockApi);
		expect(mockApi.process.onUsage).toHaveBeenCalledOnce();
		expect(mockApi.process.onToolExecution).toHaveBeenCalledOnce();
		expect(mockApi.process.onExit).toHaveBeenCalledOnce();
		expect(mockApi.process.onData).toHaveBeenCalledOnce();
	});

	it('seeds state from already-running processes', async () => {
		mockApi.process.getActiveProcesses.mockResolvedValue([
			{ sessionId: 'sess-1', toolType: 'claude-code', pid: 1234, startTime: 1000 },
		]);

		await dashboard.activate(mockApi);

		// activate() now writes immediately (no debounce needed)
		expect(storageWrites.length).toBeGreaterThanOrEqual(1);
		const output = JSON.parse(storageWrites[storageWrites.length - 1].data);
		expect(output.agents).toHaveLength(1);
		expect(output.agents[0].sessionId).toBe('sess-1');
		expect(output.agents[0].agentType).toBe('claude-code');
		expect(output.agents[0].pid).toBe(1234);
	});

	it('writes valid JSON matching the expected schema', async () => {
		mockApi.process.getActiveProcesses.mockResolvedValue([
			{ sessionId: 'sess-1', toolType: 'claude-code', pid: 1234, startTime: 1000 },
		]);

		await dashboard.activate(mockApi);

		const output = JSON.parse(storageWrites[storageWrites.length - 1].data);

		// Top-level keys
		expect(output).toHaveProperty('timestamp');
		expect(output).toHaveProperty('agents');
		expect(output).toHaveProperty('totals');

		// Agent shape
		const agent = output.agents[0];
		expect(agent).toHaveProperty('sessionId');
		expect(agent).toHaveProperty('agentType');
		expect(agent).toHaveProperty('pid');
		expect(agent).toHaveProperty('startTime');
		expect(agent).toHaveProperty('runtimeSeconds');
		expect(agent).toHaveProperty('status');
		expect(agent).toHaveProperty('tokens');
		expect(agent).toHaveProperty('cost');
		expect(agent.tokens).toHaveProperty('input');
		expect(agent.tokens).toHaveProperty('output');
		expect(agent.tokens).toHaveProperty('cacheRead');
		expect(agent.tokens).toHaveProperty('contextWindow');
		expect(agent).toHaveProperty('lastTool');

		// Totals shape
		expect(output.totals).toHaveProperty('activeAgents');
		expect(output.totals).toHaveProperty('totalInputTokens');
		expect(output.totals).toHaveProperty('totalOutputTokens');
		expect(output.totals).toHaveProperty('totalCost');
	});

	it('debounces multiple rapid writes (only last one within 500ms executes)', async () => {
		await dashboard.activate(mockApi);
		// activate() writes immediately; capture baseline
		const initialWriteCount = storageWrites.length;

		// Simulate rapid usage events
		const usageCb = eventHandlers['usage'][0];
		usageCb('sess-1', { inputTokens: 100, outputTokens: 10 });
		usageCb('sess-1', { inputTokens: 200, outputTokens: 20 });
		usageCb('sess-1', { inputTokens: 300, outputTokens: 30 });

		// Before debounce timeout — no new writes (only advance 400ms, not enough)
		await vi.advanceTimersByTimeAsync(400);
		expect(storageWrites.length).toBe(initialWriteCount);

		// After debounce timeout — exactly one write
		await vi.advanceTimersByTimeAsync(100);
		expect(storageWrites.length).toBe(initialWriteCount + 1);

		// Verify final state has latest values
		const output = JSON.parse(storageWrites[storageWrites.length - 1].data);
		const agent = output.agents.find((a: any) => a.sessionId === 'sess-1');
		expect(agent.tokens.input).toBe(300);
		expect(agent.tokens.output).toBe(30);
	});

	it('updates token counts on usage events', async () => {
		await dashboard.activate(mockApi);

		const usageCb = eventHandlers['usage'][0];
		usageCb('sess-1', {
			inputTokens: 1500,
			outputTokens: 320,
			cacheReadTokens: 800,
			contextWindow: 200000,
			totalCostUsd: 0.42,
		});

		await vi.advanceTimersByTimeAsync(500);

		const output = JSON.parse(storageWrites[storageWrites.length - 1].data);
		const agent = output.agents.find((a: any) => a.sessionId === 'sess-1');
		expect(agent.tokens.input).toBe(1500);
		expect(agent.tokens.output).toBe(320);
		expect(agent.tokens.cacheRead).toBe(800);
		expect(agent.tokens.contextWindow).toBe(200000);
		expect(agent.cost).toBe(0.42);
	});

	it('updates lastTool on tool execution events', async () => {
		await dashboard.activate(mockApi);

		const toolCb = eventHandlers['tool'][0];
		toolCb('sess-1', { toolName: 'Edit' });

		await vi.advanceTimersByTimeAsync(500);

		const output = JSON.parse(storageWrites[storageWrites.length - 1].data);
		const agent = output.agents.find((a: any) => a.sessionId === 'sess-1');
		expect(agent.lastTool).not.toBeNull();
		expect(agent.lastTool.name).toBe('Edit');
		expect(typeof agent.lastTool.timestamp).toBe('number');
	});

	it('marks agent as exited on exit event', async () => {
		mockApi.process.getActiveProcesses.mockResolvedValue([
			{ sessionId: 'sess-1', toolType: 'claude-code', pid: 1234, startTime: 1000 },
		]);

		await dashboard.activate(mockApi);

		const exitCb = eventHandlers['exit'][0];
		exitCb('sess-1', 0);

		// Only advance the debounce time, not the 30s cleanup
		await vi.advanceTimersByTimeAsync(500);

		const output = JSON.parse(storageWrites[storageWrites.length - 1].data);
		const agent = output.agents.find((a: any) => a.sessionId === 'sess-1');
		expect(agent.status).toBe('exited');
	});

	it('removes exited agent after 30 seconds', async () => {
		mockApi.process.getActiveProcesses.mockResolvedValue([
			{ sessionId: 'sess-1', toolType: 'claude-code', pid: 1234, startTime: 1000 },
		]);

		await dashboard.activate(mockApi);

		const exitCb = eventHandlers['exit'][0];
		exitCb('sess-1', 0);

		// Advance past 30s cleanup + debounce
		await vi.advanceTimersByTimeAsync(30500);

		const output = JSON.parse(storageWrites[storageWrites.length - 1].data);
		expect(output.agents.find((a: any) => a.sessionId === 'sess-1')).toBeUndefined();
	});

	it('catches agents that started between getActiveProcesses and event subscription via onData', async () => {
		await dashboard.activate(mockApi);

		const dataCb = eventHandlers['data'][0];
		dataCb('late-sess', 'some output');

		await vi.advanceTimersByTimeAsync(500);

		const output = JSON.parse(storageWrites[storageWrites.length - 1].data);
		expect(output.agents.find((a: any) => a.sessionId === 'late-sess')).toBeDefined();
	});

	it('deactivate marks all agents as exited and writes final status', async () => {
		mockApi.process.getActiveProcesses.mockResolvedValue([
			{ sessionId: 'sess-1', toolType: 'claude-code', pid: 1234, startTime: 1000 },
		]);

		await dashboard.activate(mockApi);
		await dashboard.deactivate();

		const output = JSON.parse(storageWrites[storageWrites.length - 1].data);
		// All agents should be exited in the final write
		for (const agent of output.agents) {
			expect(agent.status).toBe('exited');
		}
	});

	it('computes correct totals', async () => {
		mockApi.process.getActiveProcesses.mockResolvedValue([
			{ sessionId: 'sess-1', toolType: 'claude-code', pid: 1, startTime: 1000 },
			{ sessionId: 'sess-2', toolType: 'codex', pid: 2, startTime: 2000 },
		]);

		await dashboard.activate(mockApi);

		const usageCb = eventHandlers['usage'][0];
		usageCb('sess-1', { inputTokens: 1000, outputTokens: 200, totalCostUsd: 0.10 });
		usageCb('sess-2', { inputTokens: 2000, outputTokens: 400, totalCostUsd: 0.20 });

		await vi.advanceTimersByTimeAsync(500);

		const output = JSON.parse(storageWrites[storageWrites.length - 1].data);
		expect(output.totals.activeAgents).toBe(2);
		expect(output.totals.totalInputTokens).toBe(3000);
		expect(output.totals.totalOutputTokens).toBe(600);
		expect(output.totals.totalCost).toBeCloseTo(0.30);
	});
});

// ─── Notification Webhook Tests ──────────────────────────────────────────────

describe('Notification Webhook Plugin', () => {
	let webhook: any;
	let mockApi: any;
	let eventHandlers: Record<string, Array<(...args: any[]) => void>>;
	let settingsData: Record<string, unknown>;

	beforeEach(() => {
		vi.resetModules();
		webhook = require('../../encores/notification-webhook/index.js');

		eventHandlers = {};
		settingsData = {
			webhookUrl: 'https://example.com/webhook',
			notifyOnCompletion: true,
			notifyOnError: true,
		};

		mockApi = {
			process: {
				onExit: vi.fn((cb: any) => {
					if (!eventHandlers['exit']) eventHandlers['exit'] = [];
					eventHandlers['exit'].push(cb);
					return vi.fn();
				}),
				onData: vi.fn((cb: any) => {
					if (!eventHandlers['data']) eventHandlers['data'] = [];
					eventHandlers['data'].push(cb);
					return vi.fn();
				}),
			},
			settings: {
				get: vi.fn(async (key: string) => settingsData[key]),
				set: vi.fn(),
				getAll: vi.fn().mockResolvedValue({}),
			},
		};
	});

	it('exports activate and deactivate functions', () => {
		expect(typeof webhook.activate).toBe('function');
		expect(typeof webhook.deactivate).toBe('function');
	});

	it('subscribes to onExit and onData on activate', async () => {
		await webhook.activate(mockApi);
		expect(mockApi.process.onExit).toHaveBeenCalledOnce();
		expect(mockApi.process.onData).toHaveBeenCalledOnce();
	});

	it('checks settings before sending webhook on exit', async () => {
		await webhook.activate(mockApi);

		const exitCb = eventHandlers['exit'][0];
		await exitCb('sess-1', 0);

		expect(mockApi.settings.get).toHaveBeenCalledWith('notifyOnCompletion');
		expect(mockApi.settings.get).toHaveBeenCalledWith('webhookUrl');
	});

	it('skips webhook when notifyOnCompletion is false', async () => {
		settingsData.notifyOnCompletion = false;
		await webhook.activate(mockApi);

		const exitCb = eventHandlers['exit'][0];
		await exitCb('sess-1', 0);

		// Should have checked notifyOnCompletion but not webhookUrl
		expect(mockApi.settings.get).toHaveBeenCalledWith('notifyOnCompletion');
		// webhookUrl should not be checked since we skipped early
		const webhookUrlCalls = mockApi.settings.get.mock.calls.filter(
			(c: any[]) => c[0] === 'webhookUrl'
		);
		expect(webhookUrlCalls.length).toBe(0);
	});

	it('skips webhook when URL is empty', async () => {
		settingsData.webhookUrl = '';
		await webhook.activate(mockApi);

		const exitCb = eventHandlers['exit'][0];
		// Should not throw even with empty URL
		await exitCb('sess-1', 0);
	});

	it('containsError detects common error patterns', () => {
		expect(webhook.containsError('Error: something went wrong')).toBe(true);
		expect(webhook.containsError('FATAL crash')).toBe(true);
		expect(webhook.containsError('panic: runtime error')).toBe(true);
		expect(webhook.containsError('Traceback (most recent call last)')).toBe(true);
		expect(webhook.containsError('ECONNREFUSED 127.0.0.1:3000')).toBe(true);
		expect(webhook.containsError('Permission denied')).toBe(true);
	});

	it('containsError returns false for normal output', () => {
		expect(webhook.containsError('Hello world')).toBe(false);
		expect(webhook.containsError('Build succeeded')).toBe(false);
		expect(webhook.containsError('')).toBe(false);
		expect(webhook.containsError(null)).toBe(false);
		expect(webhook.containsError(undefined)).toBe(false);
	});

	it('deactivate calls all unsubscribers', async () => {
		const unsubExit = vi.fn();
		const unsubData = vi.fn();
		mockApi.process.onExit.mockReturnValue(unsubExit);
		mockApi.process.onData.mockReturnValue(unsubData);

		await webhook.activate(mockApi);
		await webhook.deactivate();

		expect(unsubExit).toHaveBeenCalledOnce();
		expect(unsubData).toHaveBeenCalledOnce();
	});

	it('sendWebhook handles invalid URLs gracefully', async () => {
		// Should resolve (not throw) even with invalid URL
		const result = await webhook.sendWebhook('not-a-valid-url', { test: true });
		expect(result).toHaveProperty('error');
	});
});
