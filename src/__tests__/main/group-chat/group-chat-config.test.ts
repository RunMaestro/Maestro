/**
 * Tests for src/main/group-chat/group-chat-config.ts
 *
 * Tests the getWindowsSpawnConfig helper which consolidates Windows shell
 * and stdin mode configuration for group chat agent execution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the agent capabilities before importing
vi.mock('../../../main/agents', () => ({
	getAgentCapabilities: vi.fn(),
}));

// Mock the shell escape utility
vi.mock('../../../main/process-manager/utils/shellEscape', () => ({
	getWindowsShellForAgentExecution: vi.fn(() => ({
		shell: 'powershell.exe',
		useShell: true,
		source: 'powershell-default',
	})),
}));

import {
	getWindowsSpawnConfig,
	setGetCustomShellPathCallback,
	getCustomShellPath,
	type SpawnSshConfig,
} from '../../../main/group-chat/group-chat-config';
import { getAgentCapabilities } from '../../../main/agents';
import { getWindowsShellForAgentExecution } from '../../../main/process-manager/utils/shellEscape';

describe('group-chat-config', () => {
	let originalPlatform: NodeJS.Platform;

	beforeEach(() => {
		vi.clearAllMocks();
		// Save original platform
		originalPlatform = process.platform;
	});

	afterEach(() => {
		// Restore original platform
		Object.defineProperty(process, 'platform', { value: originalPlatform });
		// Clear the callback
		setGetCustomShellPathCallback(() => undefined);
	});

	describe('getCustomShellPath', () => {
		it('should return undefined when no callback is registered', () => {
			setGetCustomShellPathCallback(() => undefined);
			expect(getCustomShellPath()).toBeUndefined();
		});

		it('should return the value from the registered callback', () => {
			setGetCustomShellPathCallback(() => 'C:\\Custom\\PowerShell.exe');
			expect(getCustomShellPath()).toBe('C:\\Custom\\PowerShell.exe');
		});
	});

	describe('getWindowsSpawnConfig', () => {
		describe('on Windows', () => {
			beforeEach(() => {
				// Mock Windows platform
				Object.defineProperty(process, 'platform', { value: 'win32' });
			});

			it('should return shell config for stream-json agent on Windows', () => {
				vi.mocked(getAgentCapabilities).mockReturnValue({
					supportsStreamJsonInput: true,
				} as any);

				const result = getWindowsSpawnConfig('claude-code');

				expect(result.shell).toBe('powershell.exe');
				expect(result.runInShell).toBe(true);
				expect(result.sendPromptViaStdin).toBe(true);
				expect(result.sendPromptViaStdinRaw).toBe(false);
			});

			it('should return shell config for non-stream-json agent on Windows', () => {
				vi.mocked(getAgentCapabilities).mockReturnValue({
					supportsStreamJsonInput: false,
				} as any);

				const result = getWindowsSpawnConfig('opencode');

				expect(result.shell).toBe('powershell.exe');
				expect(result.runInShell).toBe(true);
				expect(result.sendPromptViaStdin).toBe(false);
				expect(result.sendPromptViaStdinRaw).toBe(true);
			});

			it('should NOT apply Windows config when SSH is enabled', () => {
				vi.mocked(getAgentCapabilities).mockReturnValue({
					supportsStreamJsonInput: true,
				} as any);

				const sshConfig: SpawnSshConfig = {
					enabled: true,
					remoteId: 'my-remote',
				};

				const result = getWindowsSpawnConfig('claude-code', sshConfig);

				expect(result.shell).toBeUndefined();
				expect(result.runInShell).toBe(false);
				expect(result.sendPromptViaStdin).toBe(false);
				expect(result.sendPromptViaStdinRaw).toBe(false);
				// Should NOT call getWindowsShellForAgentExecution when SSH is enabled
				expect(getWindowsShellForAgentExecution).not.toHaveBeenCalled();
			});

			it('should apply Windows config when SSH is disabled', () => {
				vi.mocked(getAgentCapabilities).mockReturnValue({
					supportsStreamJsonInput: true,
				} as any);

				const sshConfig: SpawnSshConfig = {
					enabled: false,
					remoteId: null,
				};

				const result = getWindowsSpawnConfig('claude-code', sshConfig);

				expect(result.shell).toBe('powershell.exe');
				expect(result.runInShell).toBe(true);
				expect(getWindowsShellForAgentExecution).toHaveBeenCalled();
			});

			it('should apply Windows config when sshConfig is undefined', () => {
				vi.mocked(getAgentCapabilities).mockReturnValue({
					supportsStreamJsonInput: false,
				} as any);

				const result = getWindowsSpawnConfig('opencode', undefined);

				expect(result.shell).toBe('powershell.exe');
				expect(result.runInShell).toBe(true);
				expect(result.sendPromptViaStdinRaw).toBe(true);
			});

			it('should use custom shell path from callback', () => {
				setGetCustomShellPathCallback(() => 'C:\\Custom\\pwsh.exe');
				vi.mocked(getWindowsShellForAgentExecution).mockReturnValue({
					shell: 'C:\\Custom\\pwsh.exe',
					useShell: true,
					source: 'custom',
				});
				vi.mocked(getAgentCapabilities).mockReturnValue({
					supportsStreamJsonInput: true,
				} as any);

				const result = getWindowsSpawnConfig('claude-code');

				expect(getWindowsShellForAgentExecution).toHaveBeenCalledWith({
					customShellPath: 'C:\\Custom\\pwsh.exe',
				});
				expect(result.shell).toBe('C:\\Custom\\pwsh.exe');
			});
		});

		describe('on non-Windows platforms', () => {
			beforeEach(() => {
				// Mock Linux platform
				Object.defineProperty(process, 'platform', { value: 'linux' });
			});

			it('should return no-op config on Linux', () => {
				vi.mocked(getAgentCapabilities).mockReturnValue({
					supportsStreamJsonInput: true,
				} as any);

				const result = getWindowsSpawnConfig('claude-code');

				expect(result.shell).toBeUndefined();
				expect(result.runInShell).toBe(false);
				expect(result.sendPromptViaStdin).toBe(false);
				expect(result.sendPromptViaStdinRaw).toBe(false);
				// Should NOT call getWindowsShellForAgentExecution on non-Windows
				expect(getWindowsShellForAgentExecution).not.toHaveBeenCalled();
			});

			it('should return no-op config on macOS', () => {
				Object.defineProperty(process, 'platform', { value: 'darwin' });
				vi.mocked(getAgentCapabilities).mockReturnValue({
					supportsStreamJsonInput: false,
				} as any);

				const result = getWindowsSpawnConfig('opencode');

				expect(result.shell).toBeUndefined();
				expect(result.runInShell).toBe(false);
				expect(result.sendPromptViaStdin).toBe(false);
				expect(result.sendPromptViaStdinRaw).toBe(false);
			});
		});

		describe('agent capability detection', () => {
			beforeEach(() => {
				Object.defineProperty(process, 'platform', { value: 'win32' });
			});

			it('should correctly identify Claude Code as stream-json capable', () => {
				vi.mocked(getAgentCapabilities).mockReturnValue({
					supportsStreamJsonInput: true,
				} as any);

				const result = getWindowsSpawnConfig('claude-code');

				expect(getAgentCapabilities).toHaveBeenCalledWith('claude-code');
				expect(result.sendPromptViaStdin).toBe(true);
				expect(result.sendPromptViaStdinRaw).toBe(false);
			});

			it('should correctly identify Codex as stream-json capable', () => {
				vi.mocked(getAgentCapabilities).mockReturnValue({
					supportsStreamJsonInput: true,
				} as any);

				const result = getWindowsSpawnConfig('codex');

				expect(getAgentCapabilities).toHaveBeenCalledWith('codex');
				expect(result.sendPromptViaStdin).toBe(true);
				expect(result.sendPromptViaStdinRaw).toBe(false);
			});

			it('should correctly identify OpenCode as non-stream-json', () => {
				vi.mocked(getAgentCapabilities).mockReturnValue({
					supportsStreamJsonInput: false,
				} as any);

				const result = getWindowsSpawnConfig('opencode');

				expect(getAgentCapabilities).toHaveBeenCalledWith('opencode');
				expect(result.sendPromptViaStdin).toBe(false);
				expect(result.sendPromptViaStdinRaw).toBe(true);
			});
		});
	});
});
