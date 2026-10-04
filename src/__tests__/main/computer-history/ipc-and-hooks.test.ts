import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	service: null as Record<string, ReturnType<typeof vi.fn>> | null,
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn),
	},
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/computer-history', () => ({
	getComputerHistoryService: () => h.service,
}));

import { registerComputerHistoryHandlers } from '../../../main/ipc/handlers/computerHistory';
import { createComputerHistorySupervisorHooks } from '../../../main/computer-history/first-party';
import { isBridgeDeniedChannel } from '../../../main/web-server/handlers/bridgeDenyList';

const EXPECTED_CHANNELS = [
	'computerHistory:status',
	'computerHistory:getConfig',
	'computerHistory:setConfig',
	'computerHistory:pause',
	'computerHistory:resume',
	'computerHistory:listRules',
	'computerHistory:addRule',
	'computerHistory:removeRule',
	'computerHistory:clear',
	'computerHistory:requestAccessibility',
	'computerHistory:query',
	'computerHistory:activity',
	'computerHistory:knownApps',
	'computerHistory:digests',
];

beforeEach(() => {
	h.handlers.clear();
	h.service = {
		status: vi.fn(() => ({ state: 'recording' })),
		pause: vi.fn(async () => ({ state: 'paused' })),
		query: vi.fn(async () => ({ events: [], limited: false, segmentsScanned: 0 })),
		addRule: vi.fn(async () => ({ id: 'r' })),
		removeRule: vi.fn(async () => null),
		activity: vi.fn(async () => ({ buckets: [], apps: [], totalEvents: 0 })),
		digestsWithBodies: vi.fn(async () => []),
	};
	registerComputerHistoryHandlers();
});

describe('computerHistory IPC', () => {
	it('registers every channel, and every one is denied on the web bridge (D15)', () => {
		expect([...h.handlers.keys()].sort()).toEqual([...EXPECTED_CHANNELS].sort());
		for (const channel of EXPECTED_CHANNELS) expect(isBridgeDeniedChannel(channel)).toBe(true);
	});

	it('passes arguments through after the event and compiles grep for query', async () => {
		await h.handlers.get('computerHistory:pause')!({}, 3_600_000);
		expect(h.service!.pause).toHaveBeenCalledWith(3_600_000);
		await h.handlers.get('computerHistory:addRule')!({}, 'app', 'com.x');
		expect(h.service!.addRule).toHaveBeenCalledWith('app', 'com.x', 'ignore');
		await h.handlers.get('computerHistory:addRule')!({}, 'app', 'com.y', 'record');
		expect(h.service!.addRule).toHaveBeenLastCalledWith('app', 'com.y', 'record');
		await h.handlers.get('computerHistory:removeRule')!({}, 'com.y', 'record');
		expect(h.service!.removeRule).toHaveBeenCalledWith('com.y', 'record');
		await h.handlers.get('computerHistory:query')!({}, { grep: 'inv(', limit: 5 });
		const opts = h.service!.query.mock.calls[0][0] as { grep: RegExp; limit: number };
		expect(opts.grep).toBeInstanceOf(RegExp);
		expect(opts.grep.test('an inv( here')).toBe(true);
		expect(opts.limit).toBe(5);
	});

	it('passes ranges to activity and sanitizes the digest kind', async () => {
		await h.handlers.get('computerHistory:activity')!({}, { sinceMs: 1, untilMs: 2 });
		expect(h.service!.activity).toHaveBeenCalledWith({ sinceMs: 1, untilMs: 2 });
		await h.handlers.get('computerHistory:digests')!({}, { kind: 'bogus', limit: 3 });
		expect(h.service!.digestsWithBodies).toHaveBeenCalledWith({
			sinceMs: undefined,
			untilMs: undefined,
			kind: undefined,
			limit: 3,
		});
	});

	it('rejects with a clear message before the service exists', async () => {
		h.service = null;
		await expect(h.handlers.get('computerHistory:status')!({})).rejects.toThrow(/not available/);
	});
});

describe('first-party supervisor hooks', () => {
	it('reconcile starts and stopAll stops the service; a null service is a no-op', async () => {
		const svc = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
		const hooks = createComputerHistorySupervisorHooks(() => svc);
		hooks.reconcile();
		hooks.stopAll();
		expect(svc.start).toHaveBeenCalledTimes(1);
		expect(svc.stop).toHaveBeenCalledTimes(1);
		const none = createComputerHistorySupervisorHooks(() => null);
		expect(() => {
			none.reconcile();
			none.stopAll();
		}).not.toThrow();
	});
});
