import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFileNoThrow } = vi.hoisted(() => ({
	mockExecFileNoThrow: vi.fn(),
}));

vi.mock('electron', () => ({
	app: {
		getAppPath: vi.fn().mockReturnValue('/mock/app'),
		getVersion: vi.fn().mockReturnValue('0.17.4'),
	},
}));

vi.mock('../../main/utils/execFile', () => ({
	execFileNoThrow: mockExecFileNoThrow,
}));

vi.mock('../../shared/platformDetection', () => ({
	getWhichCommand: vi.fn().mockReturnValue('where'),
	isWindows: vi.fn().mockReturnValue(true),
}));

vi.mock('../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

import { MaestroCliManager, normalizeVersion } from '../../main/maestro-cli-manager';

describe('MaestroCliManager', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockExecFileNoThrow.mockResolvedValue({
			exitCode: 0,
			stderr: '',
			stdout: '',
		});
	});

	describe('normalizeVersion', () => {
		it('finds a version line after incidental logger output', () => {
			expect(
				normalizeVersion(
					'[Logger] File logging enabled: C:\\logs\\maestro-debug-2026-09-10.log\r\n0.17.4\r\n'
				)
			).toBe('0.17.4');
		});

		it('normalizes an exact v-prefixed prerelease', () => {
			expect(normalizeVersion('v0.18.0-rc.1\n')).toBe('0.18.0-rc.1');
		});
	});

	it('updates the Windows user PATH with PowerShell directly and valid block syntax', async () => {
		const manager = new MaestroCliManager();
		const ensureWindowsUserPath = (
			manager as unknown as {
				ensureWindowsUserPath(installDir: string): Promise<boolean>;
			}
		).ensureWindowsUserPath.bind(manager);

		await expect(ensureWindowsUserPath("C:\\Users\\O'Brien\\.local\\bin")).resolves.toBe(true);

		expect(mockExecFileNoThrow).toHaveBeenCalledOnce();
		const [command, args] = mockExecFileNoThrow.mock.calls[0] as [string, string[]];
		expect(command).toBe('powershell.exe');
		expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);

		const script = args[3];
		expect(script).toContain("$installDir = 'C:\\Users\\O''Brien\\.local\\bin'");
		expect(script).toContain('if ($parts -notcontains $installDir) {\n');
		expect(script).not.toContain('{;');
	});
});
