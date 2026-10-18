/**
 * The Windows shell and stdin choices for a group chat or consult turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ windows: true }));
vi.mock('../../../platformDetection', () => ({
	isWindows: () => platform.windows,
	isMacOS: () => false,
	isLinux: () => !platform.windows,
}));
const shellFor = vi.hoisted(() => vi.fn());
vi.mock('../../launch/windows-shell-escape', () => ({
	getWindowsShellForAgentExecution: shellFor,
}));
const capabilities = vi.hoisted(() => vi.fn());
vi.mock('../../providers/capabilities', () => ({ getAgentCapabilities: capabilities }));

import { getWindowsSpawnConfig } from '../windows-spawn';

describe('getWindowsSpawnConfig', () => {
	beforeEach(() => {
		platform.windows = true;
		shellFor.mockReturnValue({
			shell: 'powershell.exe',
			useShell: true,
			source: 'powershell-default',
		});
		capabilities.mockReturnValue({ supportsStreamJsonInput: true, supportsPromptViaStdin: true });
	});
	afterEach(() => vi.clearAllMocks());

	it('changes nothing off Windows, or over SSH (the remote may be Linux)', () => {
		const none = {
			shell: undefined,
			runInShell: false,
			sendPromptViaStdin: false,
			sendPromptViaStdinRaw: false,
		};
		platform.windows = false;
		expect(getWindowsSpawnConfig('claude-code')).toEqual(none);
		platform.windows = true;
		expect(getWindowsSpawnConfig('claude-code', { enabled: true, remoteId: 'r1' })).toEqual(none);
		expect(shellFor).not.toHaveBeenCalled();
	});

	it('sends a stream-json provider its prompt as JSON over stdin, through the chosen shell', () => {
		expect(
			getWindowsSpawnConfig('claude-code', undefined, { customShellPath: 'C:\\pwsh.exe' })
		).toEqual({
			shell: 'powershell.exe',
			runInShell: true,
			sendPromptViaStdin: true,
			sendPromptViaStdinRaw: false,
		});
		expect(shellFor).toHaveBeenCalledWith({ customShellPath: 'C:\\pwsh.exe' });
	});

	it('sends any other provider that reads stdin its prompt as raw text', () => {
		capabilities.mockReturnValue({ supportsStreamJsonInput: false, supportsPromptViaStdin: true });
		expect(getWindowsSpawnConfig('hermes')).toMatchObject({
			sendPromptViaStdin: false,
			sendPromptViaStdinRaw: true,
		});
	});

	it('keeps the prompt in argv for a provider that cannot read it from stdin', () => {
		capabilities.mockReturnValue({ supportsStreamJsonInput: false, supportsPromptViaStdin: false });
		expect(getWindowsSpawnConfig('omp')).toMatchObject({
			sendPromptViaStdin: false,
			sendPromptViaStdinRaw: false,
		});
	});
});
