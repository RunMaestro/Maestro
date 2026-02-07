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

describe('WakaTime IPC Handlers', () => {
	const handlers: Map<string, Function> = new Map();

	beforeEach(() => {
		vi.clearAllMocks();
		handlers.clear();

		vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: Function) => {
			handlers.set(channel, handler);
		});

		registerWakatimeHandlers();
	});

	describe('wakatime:checkCli', () => {
		it('should register the handler', () => {
			expect(handlers.has('wakatime:checkCli')).toBe(true);
		});

		it('should return available: true with version when wakatime-cli is found', async () => {
			mockExecFileNoThrow.mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'wakatime-cli 1.73.0\n',
				stderr: '',
			});

			const handler = handlers.get('wakatime:checkCli')!;
			const result = await handler({});

			expect(result).toEqual({ available: true, version: 'wakatime-cli 1.73.0' });
			expect(mockExecFileNoThrow).toHaveBeenCalledWith('wakatime-cli', ['--version']);
		});

		it('should try wakatime if wakatime-cli is not found', async () => {
			// wakatime-cli not found
			mockExecFileNoThrow.mockResolvedValueOnce({
				exitCode: 'ENOENT',
				stdout: '',
				stderr: '',
			});
			// wakatime found
			mockExecFileNoThrow.mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'wakatime 1.73.0\n',
				stderr: '',
			});

			const handler = handlers.get('wakatime:checkCli')!;
			const result = await handler({});

			expect(result).toEqual({ available: true, version: 'wakatime 1.73.0' });
			expect(mockExecFileNoThrow).toHaveBeenCalledTimes(2);
			expect(mockExecFileNoThrow).toHaveBeenCalledWith('wakatime-cli', ['--version']);
			expect(mockExecFileNoThrow).toHaveBeenCalledWith('wakatime', ['--version']);
		});

		it('should return available: false when no CLI is found', async () => {
			mockExecFileNoThrow.mockResolvedValue({
				exitCode: 'ENOENT',
				stdout: '',
				stderr: '',
			});

			const handler = handlers.get('wakatime:checkCli')!;
			const result = await handler({});

			expect(result).toEqual({ available: false });
			expect(mockExecFileNoThrow).toHaveBeenCalledTimes(2);
		});
	});

	describe('wakatime:validateApiKey', () => {
		it('should register the handler', () => {
			expect(handlers.has('wakatime:validateApiKey')).toBe(true);
		});

		it('should return valid: false for empty key', async () => {
			const handler = handlers.get('wakatime:validateApiKey')!;
			const result = await handler({}, '');

			expect(result).toEqual({ valid: false });
			expect(mockExecFileNoThrow).not.toHaveBeenCalled();
		});

		it('should return valid: true when CLI validates the key', async () => {
			// CLI detection succeeds
			mockExecFileNoThrow.mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'wakatime-cli 1.73.0\n',
				stderr: '',
			});
			// Key validation succeeds
			mockExecFileNoThrow.mockResolvedValueOnce({
				exitCode: 0,
				stdout: '{}',
				stderr: '',
			});

			const handler = handlers.get('wakatime:validateApiKey')!;
			const result = await handler({}, 'waka_test_key_123');

			expect(result).toEqual({ valid: true });
			expect(mockExecFileNoThrow).toHaveBeenCalledWith('wakatime-cli', ['--key', 'waka_test_key_123', '--today']);
		});

		it('should return valid: false when CLI rejects the key', async () => {
			// CLI detection succeeds
			mockExecFileNoThrow.mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'wakatime-cli 1.73.0\n',
				stderr: '',
			});
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
			// Neither CLI binary found
			mockExecFileNoThrow.mockResolvedValue({
				exitCode: 'ENOENT',
				stdout: '',
				stderr: '',
			});

			const handler = handlers.get('wakatime:validateApiKey')!;
			const result = await handler({}, 'waka_test_key_123');

			expect(result).toEqual({ valid: false });
			// Called twice for detection attempts (wakatime-cli, wakatime), never for validation
			expect(mockExecFileNoThrow).toHaveBeenCalledTimes(2);
		});

		it('should try wakatime binary if wakatime-cli detection fails', async () => {
			// wakatime-cli not found
			mockExecFileNoThrow.mockResolvedValueOnce({
				exitCode: 'ENOENT',
				stdout: '',
				stderr: '',
			});
			// wakatime found
			mockExecFileNoThrow.mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'wakatime 1.73.0\n',
				stderr: '',
			});
			// Key validation succeeds
			mockExecFileNoThrow.mockResolvedValueOnce({
				exitCode: 0,
				stdout: '{}',
				stderr: '',
			});

			const handler = handlers.get('wakatime:validateApiKey')!;
			const result = await handler({}, 'waka_test_key_123');

			expect(result).toEqual({ valid: true });
			expect(mockExecFileNoThrow).toHaveBeenCalledWith('wakatime', ['--key', 'waka_test_key_123', '--today']);
		});
	});
});
