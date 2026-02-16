import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';

// Mock electron
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

// Mock execFileNoThrow
const mockExecFileNoThrow = vi.fn();
vi.mock('../../../../main/utils/execFile', () => ({
	execFileNoThrow: (...args: unknown[]) => mockExecFileNoThrow(...args),
}));

// Mock logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import { registerWakatimeHandlers } from '../../../../main/ipc/handlers/wakatime';

/** Create a mock WakaTimeManager with configurable behavior */
function createMockWakaTimeManager(overrides: {
	ensureCliInstalled?: () => Promise<boolean>;
	getCliPath?: () => string | null;
} = {}) {
	return {
		ensureCliInstalled: overrides.ensureCliInstalled ?? vi.fn().mockResolvedValue(true),
		getCliPath: overrides.getCliPath ?? vi.fn().mockReturnValue('/usr/local/bin/wakatime-cli'),
		sendHeartbeat: vi.fn(),
		removeSession: vi.fn(),
	} as any;
}

describe('WakaTime IPC Handlers', () => {
	const handlers: Map<string, Function> = new Map();

	beforeEach(() => {
		vi.clearAllMocks();
		handlers.clear();

		vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: Function) => {
			handlers.set(channel, handler);
		});
	});

	describe('wakatime:checkCli', () => {
		it('should register the handler', () => {
			registerWakatimeHandlers(createMockWakaTimeManager());
			expect(handlers.has('wakatime:checkCli')).toBe(true);
		});

		it('should return available: true with version when CLI is installed', async () => {
			const mockManager = createMockWakaTimeManager();
			registerWakatimeHandlers(mockManager);

			mockExecFileNoThrow.mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'wakatime-cli 1.73.0\n',
				stderr: '',
			});

			const handler = handlers.get('wakatime:checkCli')!;
			const result = await handler({});

			expect(result).toEqual({ available: true, version: 'wakatime-cli 1.73.0' });
			expect(mockManager.ensureCliInstalled).toHaveBeenCalled();
			expect(mockManager.getCliPath).toHaveBeenCalled();
			expect(mockExecFileNoThrow).toHaveBeenCalledWith('/usr/local/bin/wakatime-cli', ['--version']);
		});

		it('should return available: false when ensureCliInstalled fails', async () => {
			const mockManager = createMockWakaTimeManager({
				ensureCliInstalled: vi.fn().mockResolvedValue(false),
			});
			registerWakatimeHandlers(mockManager);

			const handler = handlers.get('wakatime:checkCli')!;
			const result = await handler({});

			expect(result).toEqual({ available: false });
			expect(mockExecFileNoThrow).not.toHaveBeenCalled();
		});

		it('should return available: false when getCliPath returns null', async () => {
			const mockManager = createMockWakaTimeManager({
				getCliPath: vi.fn().mockReturnValue(null),
			});
			registerWakatimeHandlers(mockManager);

			const handler = handlers.get('wakatime:checkCli')!;
			const result = await handler({});

			expect(result).toEqual({ available: false });
			expect(mockExecFileNoThrow).not.toHaveBeenCalled();
		});

		it('should trigger auto-install via ensureCliInstalled', async () => {
			const cliPath = '/home/user/.wakatime/wakatime-cli-linux-amd64';
			const mockManager = createMockWakaTimeManager({
				ensureCliInstalled: vi.fn().mockResolvedValue(true),
				getCliPath: vi.fn().mockReturnValue(cliPath),
			});
			registerWakatimeHandlers(mockManager);

			mockExecFileNoThrow.mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'wakatime-cli 1.90.0\n',
				stderr: '',
			});

			const handler = handlers.get('wakatime:checkCli')!;
			const result = await handler({});

			expect(result).toEqual({ available: true, version: 'wakatime-cli 1.90.0' });
			expect(mockManager.ensureCliInstalled).toHaveBeenCalled();
			expect(mockExecFileNoThrow).toHaveBeenCalledWith(cliPath, ['--version']);
		});
	});

	describe('wakatime:validateApiKey', () => {
		it('should register the handler', () => {
			registerWakatimeHandlers(createMockWakaTimeManager());
			expect(handlers.has('wakatime:validateApiKey')).toBe(true);
		});

		it('should return valid: false for empty key', async () => {
			const mockManager = createMockWakaTimeManager();
			registerWakatimeHandlers(mockManager);

			const handler = handlers.get('wakatime:validateApiKey')!;
			const result = await handler({}, '');

			expect(result).toEqual({ valid: false });
			expect(mockManager.ensureCliInstalled).not.toHaveBeenCalled();
		});

		it('should return valid: true when CLI validates the key', async () => {
			const mockManager = createMockWakaTimeManager();
			registerWakatimeHandlers(mockManager);

			// Key validation succeeds
			mockExecFileNoThrow.mockResolvedValueOnce({
				exitCode: 0,
				stdout: '{}',
				stderr: '',
			});

			const handler = handlers.get('wakatime:validateApiKey')!;
			const result = await handler({}, 'waka_test_key_123');

			expect(result).toEqual({ valid: true });
			expect(mockManager.ensureCliInstalled).toHaveBeenCalled();
			expect(mockExecFileNoThrow).toHaveBeenCalledWith(
				'/usr/local/bin/wakatime-cli',
				['--key', 'waka_test_key_123', '--today']
			);
		});

		it('should return valid: false when CLI rejects the key', async () => {
			const mockManager = createMockWakaTimeManager();
			registerWakatimeHandlers(mockManager);

			// Key validation fails
			mockExecFileNoThrow.mockResolvedValueOnce({
				exitCode: 1,
				stdout: '',
				stderr: 'Invalid API key',
			});

			const handler = handlers.get('wakatime:validateApiKey')!;
			const result = await handler({}, 'waka_bad_key');

			expect(result).toEqual({ valid: false });
		});

		it('should return valid: false when CLI is not available', async () => {
			const mockManager = createMockWakaTimeManager({
				ensureCliInstalled: vi.fn().mockResolvedValue(false),
			});
			registerWakatimeHandlers(mockManager);

			const handler = handlers.get('wakatime:validateApiKey')!;
			const result = await handler({}, 'waka_test_key_123');

			expect(result).toEqual({ valid: false });
			expect(mockExecFileNoThrow).not.toHaveBeenCalled();
		});

		it('should return valid: false when getCliPath returns null', async () => {
			const mockManager = createMockWakaTimeManager({
				getCliPath: vi.fn().mockReturnValue(null),
			});
			registerWakatimeHandlers(mockManager);

			const handler = handlers.get('wakatime:validateApiKey')!;
			const result = await handler({}, 'waka_test_key_123');

			expect(result).toEqual({ valid: false });
			expect(mockExecFileNoThrow).not.toHaveBeenCalled();
		});

		it('should use the manager CLI path for validation', async () => {
			const cliPath = '/home/user/.wakatime/wakatime-cli-linux-amd64';
			const mockManager = createMockWakaTimeManager({
				getCliPath: vi.fn().mockReturnValue(cliPath),
			});
			registerWakatimeHandlers(mockManager);

			mockExecFileNoThrow.mockResolvedValueOnce({
				exitCode: 0,
				stdout: '{}',
				stderr: '',
			});

			const handler = handlers.get('wakatime:validateApiKey')!;
			const result = await handler({}, 'waka_test_key_123');

			expect(result).toEqual({ valid: true });
			expect(mockExecFileNoThrow).toHaveBeenCalledWith(
				cliPath,
				['--key', 'waka_test_key_123', '--today']
			);
		});
	});
});
