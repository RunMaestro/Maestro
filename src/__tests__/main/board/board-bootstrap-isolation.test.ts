import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trace = vi.hoisted(() => ({ events: [] as string[], failAdmission: false }));
vi.mock('electron', () => ({
	app: { getPath: () => '/production', setPath: () => trace.events.push('setPath'), exit: vi.fn() },
}));
vi.mock('../../../main/board/board-isolation', () => ({
	isBoardIsolationRequested: () => true,
	requireBoardIsolation: () => {
		trace.events.push('admit');
		if (trace.failAdmission) throw new Error('refused');
		return { userData: '/fixture' };
	},
	assertBoardIsolationBootstrap: () => trace.events.push('bootstrap-check'),
	readBoardIsolationRegistries: () => trace.events.push('registries'),
}));
vi.mock('../../../main/board/board-source-host', () => ({
	configureIsolatedBoardSourceHost: () => trace.events.push('source-host'),
}));
vi.mock('../../../main/index', () => {
	trace.events.push('index-store-import');
	return {};
});
vi.mock('../../../main/lite', () => {
	trace.events.push('lite-import');
	return { startLite: vi.fn() };
});

beforeEach(() => {
	vi.resetModules();
	trace.events = [];
	trace.failAdmission = false;
	vi.stubEnv('MAESTRO_DEMO_DIR', '/fixture');
});
afterEach(() => {
	vi.unstubAllEnvs();
	process.argv = process.argv.filter((arg) => arg !== '--lite');
});

describe('isolated native bootstrap', () => {
	it('admits registries and configures sources before backend/store import', async () => {
		await import('../../../main/bootstrap');
		await vi.waitFor(() => expect(trace.events).toContain('index-store-import'));
		expect(trace.events).toEqual([
			'admit',
			'bootstrap-check',
			'registries',
			'setPath',
			'source-host',
			'index-store-import',
		]);
	});
	it('refuses an invalid contract before changing paths or importing the backend', async () => {
		trace.failAdmission = true;
		await expect(import('../../../main/bootstrap')).rejects.toThrow('refused');
		expect(trace.events).toEqual(['admit']);
	});
	it('refuses Lite before importing its desktop bridge', async () => {
		process.argv.push('--lite');
		await expect(import('../../../main/bootstrap')).rejects.toThrow('refuses the Lite');
		expect(trace.events).not.toContain('lite-import');
		expect(trace.events).not.toContain('index-store-import');
	});
});
