import { afterEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ discover: vi.fn(), discoverFrom: vi.fn(), socket: vi.fn() }));
vi.mock('../../../shared/maestro-lib/client/discovery', () => ({
	readCliServerInfo: io.discover,
	readCliServerInfoFrom: io.discoverFrom,
	isCliServerRunning: vi.fn(),
	isPidAlive: vi.fn(),
}));
vi.mock('ws', () => ({
	default: class {
		constructor() {
			io.socket();
		}
	},
}));
afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
	vi.clearAllMocks();
});

describe('isolated desktop bridge refusal', () => {
	it('allows ordinary inherited demo mode to reach mocked discovery', async () => {
		vi.stubEnv('MAESTRO_DEMO_DIR', '/demo');
		process.argv.push('--demo');
		try {
			const { BridgeConnection } =
				await import('../../../shared/maestro-lib/client/bridge-connection');
			io.discover.mockReturnValue(null);
			await expect(new BridgeConnection().connect()).rejects.toThrow(
				'Maestro desktop app is not running'
			);
			expect(io.discover).toHaveBeenCalledOnce();
			expect(io.socket).not.toHaveBeenCalled();
		} finally {
			process.argv.pop();
		}
	});
	it.each(['BOARD_DB_PATH', 'BOARD_ISOLATION_CONTRACT', 'MAESTRO_E2E_TEST'])(
		'refuses %s before discovery',
		async (key) => {
			vi.stubEnv(key, '');
			const { BridgeConnection } =
				await import('../../../shared/maestro-lib/client/bridge-connection');
			await expect(new BridgeConnection().connect()).rejects.toThrow('fixture IPC');
			expect(io.discover).not.toHaveBeenCalled();
			expect(io.socket).not.toHaveBeenCalled();
		}
	);
	it.each([undefined, '/explicit/user-data'])(
		'denies discovery and sockets for %s, including after marker removal',
		async (userDataDir) => {
			vi.stubEnv('BOARD_ISOLATION_ID', 'fixture');
			const { BridgeConnection } =
				await import('../../../shared/maestro-lib/client/bridge-connection');
			await expect(new BridgeConnection({ userDataDir }).connect()).rejects.toThrow('fixture IPC');
			delete process.env.BOARD_ISOLATION_ID;
			await expect(new BridgeConnection({ userDataDir }).connect()).rejects.toThrow('fixture IPC');
			expect(io.discover).not.toHaveBeenCalled();
			expect(io.discoverFrom).not.toHaveBeenCalled();
			expect(io.socket).not.toHaveBeenCalled();
		}
	);
});
