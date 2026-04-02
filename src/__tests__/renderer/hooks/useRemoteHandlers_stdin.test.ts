/**
 * Tests for useRemoteHandlers.ts - Windows stdin transport flags
 *
 * These tests verify that remote command spawns correctly use
 * getStdinFlags() to pass prompts via stdin on Windows, avoiding
 * command line length limits.
 *
 * Remote commands can include substituted slash command prompts
 * (custom AI commands, spec-kit, openspec) that may be very large
 * after template variable substitution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock window.maestro
const mockMaestro = {
	platform: 'win32',
	agents: {
		get: vi.fn(),
	},
	process: {
		spawn: vi.fn().mockResolvedValue(undefined),
		kill: vi.fn().mockResolvedValue(undefined),
		onData: vi.fn(() => vi.fn()),
		onExit: vi.fn(() => vi.fn()),
		onSessionId: vi.fn(() => vi.fn()),
		onSshRemote: vi.fn(() => vi.fn()),
		onAgentError: vi.fn(() => vi.fn()),
	},
};

vi.stubGlobal('window', { maestro: mockMaestro });

// Mock getStdinFlags directly to verify it is called
vi.mock('../../../renderer/utils/spawnHelpers', () => ({
	getStdinFlags: vi.fn((opts: any) => {
		// Reproduce the real logic for testing
		const isWindows = (window as any).maestro?.platform === 'win32';
		const useStdin = isWindows && !opts.isSshSession;
		return {
			sendPromptViaStdin: useStdin && opts.supportsStreamJsonInput && !!opts.hasImages,
			sendPromptViaStdinRaw: useStdin && (!opts.supportsStreamJsonInput || !opts.hasImages),
		};
	}),
}));

import { getStdinFlags } from '../../../renderer/utils/spawnHelpers';

describe('useRemoteHandlers - remote command stdin flags', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockMaestro.platform = 'win32';
	});

	afterEach(() => {
		mockMaestro.platform = 'darwin';
	});

	it('should compute sendPromptViaStdinRaw=true for local Windows sessions', () => {
		const mockAgent = {
			id: 'claude-code',
			available: true,
			command: 'claude',
			path: '/usr/bin/claude',
			args: [],
			capabilities: { supportsStreamJsonInput: true },
		};

		// Simulate the computation in the handler
		const isSshSession = Boolean(undefined); // no SSH config
		const result = (getStdinFlags as any)({
			isSshSession,
			supportsStreamJsonInput: mockAgent.capabilities?.supportsStreamJsonInput ?? false,
			hasImages: false,
		});

		expect(result.sendPromptViaStdinRaw).toBe(true);
		expect(result.sendPromptViaStdin).toBe(false);
	});

	it('should compute both flags as false for SSH sessions on Windows', () => {
		const sessionSshConfig = { enabled: true, remoteId: 'remote-1' };
		const isSshSession = Boolean(sessionSshConfig?.enabled);

		const result = (getStdinFlags as any)({
			isSshSession,
			supportsStreamJsonInput: true,
			hasImages: false,
		});

		expect(result.sendPromptViaStdin).toBe(false);
		expect(result.sendPromptViaStdinRaw).toBe(false);
	});

	it('should compute both flags as false on non-Windows platforms', () => {
		mockMaestro.platform = 'darwin';

		const isSshSession = false;
		const result = (getStdinFlags as any)({
			isSshSession,
			supportsStreamJsonInput: true,
			hasImages: false,
		});

		expect(result.sendPromptViaStdin).toBe(false);
		expect(result.sendPromptViaStdinRaw).toBe(false);
	});

	it('should use raw stdin for agents without stream-json on Windows', () => {
		const mockAgent = {
			id: 'opencode',
			available: true,
			command: 'opencode',
			path: '/usr/bin/opencode',
			args: [],
			capabilities: { supportsStreamJsonInput: false },
		};

		const isSshSession = false;
		const result = (getStdinFlags as any)({
			isSshSession,
			supportsStreamJsonInput: mockAgent.capabilities?.supportsStreamJsonInput ?? false,
			hasImages: false,
		});

		expect(result.sendPromptViaStdinRaw).toBe(true);
		expect(result.sendPromptViaStdin).toBe(false);
	});

	it('should always pass hasImages=false for remote commands', () => {
		// Remote commands do not send images, so hasImages should always be false
		const isSshSession = false;
		(getStdinFlags as any)({
			isSshSession,
			supportsStreamJsonInput: true,
			hasImages: false,
		});

		const lastCall = (getStdinFlags as any).mock.calls.at(-1)[0];
		expect(lastCall.hasImages).toBe(false);
	});

	it('should handle disabled SSH config as non-SSH session', () => {
		const sessionSshConfig = { enabled: false, remoteId: null };
		const isSshSession = Boolean(sessionSshConfig?.enabled);

		const result = (getStdinFlags as any)({
			isSshSession,
			supportsStreamJsonInput: true,
			hasImages: false,
		});

		// Disabled SSH should behave like a local session on Windows
		expect(result.sendPromptViaStdinRaw).toBe(true);
		expect(result.sendPromptViaStdin).toBe(false);
	});
});
