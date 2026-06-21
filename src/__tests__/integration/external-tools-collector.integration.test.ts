import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	detectShells: vi.fn(),
	execFileNoThrow: vi.fn(),
	isCloudflaredInstalled: vi.fn(),
}));

vi.mock('../../main/utils/shellDetector', () => ({
	detectShells: mocks.detectShells,
}));

vi.mock('../../main/utils/execFile', () => ({
	execFileNoThrow: mocks.execFileNoThrow,
}));

vi.mock('../../main/utils/cliDetection', () => ({
	isCloudflaredInstalled: mocks.isCloudflaredInstalled,
}));

import { collectExternalTools } from '../../main/debug-package/collectors/external-tools';

describe('external tools collector integration', () => {
	beforeEach(() => {
		mocks.detectShells.mockResolvedValue([
			{ id: 'zsh', name: 'Zsh', path: '/bin/zsh', available: true },
			{ id: 'fish', name: 'Fish', path: '/opt/homebrew/bin/fish', available: false },
		]);
		mocks.execFileNoThrow.mockImplementation(async (command: string, args: string[]) => {
			if (command === 'git' && args[0] === '--version') {
				return { exitCode: 0, stdout: 'git version 2.51.0\n', stderr: '' };
			}
			if (command === 'gh' && args[0] === '--version') {
				return { exitCode: 0, stdout: 'gh version 2.0.0\n', stderr: '' };
			}
			if (command === 'gh' && args[0] === 'auth') {
				return { exitCode: 0, stdout: 'authenticated\n', stderr: '' };
			}
			return { exitCode: 127, stdout: '', stderr: 'missing' };
		});
		mocks.isCloudflaredInstalled.mockResolvedValue(true);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('collects availability without exposing local executable paths', async () => {
		const result = await collectExternalTools();

		expect(result).toEqual({
			shells: [
				{ id: 'zsh', name: 'Zsh', available: true },
				{ id: 'fish', name: 'Fish', available: false },
			],
			git: {
				available: true,
				version: '2.51.0',
			},
			github: {
				ghCliInstalled: true,
				ghCliAuthenticated: true,
			},
			cloudflared: {
				installed: true,
			},
		});
		expect(JSON.stringify(result)).not.toContain('/bin/zsh');
		expect(JSON.stringify(result)).not.toContain('/opt/homebrew/bin/fish');
	});

	it('handles installed tools with missing version details and failed gh auth', async () => {
		mocks.detectShells.mockResolvedValue([]);
		mocks.execFileNoThrow.mockImplementation(async (command: string, args: string[]) => {
			if (command === 'git' && args[0] === '--version') {
				return { exitCode: 0, stdout: 'git from source\n', stderr: '' };
			}
			if (command === 'gh' && args[0] === '--version') {
				return { exitCode: 0, stdout: 'gh version 2.0.0\n', stderr: '' };
			}
			return { exitCode: 1, stdout: '', stderr: 'not authenticated' };
		});
		mocks.isCloudflaredInstalled.mockResolvedValue(false);

		await expect(collectExternalTools()).resolves.toEqual({
			shells: [],
			git: {
				available: true,
			},
			github: {
				ghCliInstalled: true,
				ghCliAuthenticated: false,
			},
			cloudflared: {
				installed: false,
			},
		});
	});

	it('keeps safe defaults when dependency probes fail or return nonzero results', async () => {
		mocks.detectShells.mockRejectedValue(new Error('shell detection unavailable'));
		mocks.execFileNoThrow.mockRejectedValue(new Error('exec unavailable'));
		mocks.isCloudflaredInstalled.mockRejectedValue(new Error('cloudflared unavailable'));

		await expect(collectExternalTools()).resolves.toEqual({
			shells: [],
			git: {
				available: false,
			},
			github: {
				ghCliInstalled: false,
				ghCliAuthenticated: false,
			},
			cloudflared: {
				installed: false,
			},
		});
	});

	it('does not mark unavailable git or gh as installed', async () => {
		mocks.execFileNoThrow.mockResolvedValue({ exitCode: 127, stdout: '', stderr: 'missing' });

		const result = await collectExternalTools();

		expect(result.git).toEqual({ available: false });
		expect(result.github).toEqual({
			ghCliInstalled: false,
			ghCliAuthenticated: false,
		});
	});
});
