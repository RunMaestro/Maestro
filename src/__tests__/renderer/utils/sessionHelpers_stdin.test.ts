/**
 * Tests for sessionHelpers.ts - Windows stdin transport flags
 *
 * These tests verify that buildSpawnConfigForAgent correctly uses
 * getStdinFlags() to include stdin transport flags in spawn configs,
 * avoiding Windows command line length limits (~8KB cmd.exe).
 *
 * buildSpawnConfigForAgent is used by useCueAiChat and createSessionForAgent,
 * so this central fix protects all callers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock window.maestro
const mockMaestro = {
	platform: 'win32',
	agents: {
		get: vi.fn(),
	},
};

vi.stubGlobal('window', { maestro: mockMaestro });

// Import after mocking
import { buildSpawnConfigForAgent } from '../../../renderer/utils/sessionHelpers';

describe('buildSpawnConfigForAgent - Windows stdin transport flags', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockMaestro.platform = 'win32';
	});

	afterEach(() => {
		mockMaestro.platform = 'darwin';
	});

	it('should include sendPromptViaStdinRaw on Windows without SSH', async () => {
		const mockAgent = {
			id: 'claude-code',
			name: 'Claude Code',
			available: true,
			command: 'claude',
			path: '/usr/bin/claude',
			args: ['--print'],
			capabilities: { supportsStreamJsonInput: true },
		};
		mockMaestro.agents.get.mockResolvedValue(mockAgent);

		const result = await buildSpawnConfigForAgent({
			sessionId: 'test-session',
			toolType: 'claude-code',
			cwd: '/test/path',
			prompt: 'Hello, world!',
		});

		expect(result).not.toBeNull();
		// On Windows without SSH, text-only prompts (hasImages defaults to false)
		// use raw stdin transport
		expect(result!.sendPromptViaStdinRaw).toBe(true);
		expect(result!.sendPromptViaStdin).toBe(false);
	});

	it('should NOT include stdin flags when SSH is enabled', async () => {
		const mockAgent = {
			id: 'claude-code',
			name: 'Claude Code',
			available: true,
			command: 'claude',
			path: '/usr/bin/claude',
			args: ['--print'],
			capabilities: { supportsStreamJsonInput: true },
		};
		mockMaestro.agents.get.mockResolvedValue(mockAgent);

		const result = await buildSpawnConfigForAgent({
			sessionId: 'test-session',
			toolType: 'claude-code',
			cwd: '/test/path',
			prompt: 'Hello, world!',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'test-remote-id',
			},
		});

		expect(result).not.toBeNull();
		// SSH sessions must NOT use stdin flags
		expect(result!.sendPromptViaStdin).toBe(false);
		expect(result!.sendPromptViaStdinRaw).toBe(false);
	});

	it('should NOT include stdin flags on non-Windows platforms', async () => {
		mockMaestro.platform = 'darwin';

		const mockAgent = {
			id: 'claude-code',
			name: 'Claude Code',
			available: true,
			command: 'claude',
			path: '/usr/bin/claude',
			args: ['--print'],
			capabilities: { supportsStreamJsonInput: true },
		};
		mockMaestro.agents.get.mockResolvedValue(mockAgent);

		const result = await buildSpawnConfigForAgent({
			sessionId: 'test-session',
			toolType: 'claude-code',
			cwd: '/test/path',
			prompt: 'Hello, world!',
		});

		expect(result).not.toBeNull();
		expect(result!.sendPromptViaStdin).toBe(false);
		expect(result!.sendPromptViaStdinRaw).toBe(false);
	});

	it('should include sendPromptViaStdinRaw for agents without stream-json support', async () => {
		const mockAgent = {
			id: 'opencode',
			name: 'OpenCode',
			available: true,
			command: 'opencode',
			path: '/usr/bin/opencode',
			args: [],
			capabilities: { supportsStreamJsonInput: false },
		};
		mockMaestro.agents.get.mockResolvedValue(mockAgent);

		const result = await buildSpawnConfigForAgent({
			sessionId: 'test-session',
			toolType: 'opencode' as any,
			cwd: '/test/path',
			prompt: 'Hello, world!',
		});

		expect(result).not.toBeNull();
		// Agents without stream-json support always use raw stdin on Windows
		expect(result!.sendPromptViaStdinRaw).toBe(true);
		expect(result!.sendPromptViaStdin).toBe(false);
	});

	it('should include sendPromptViaStdin when hasImages is true and agent supports stream-json', async () => {
		const mockAgent = {
			id: 'claude-code',
			name: 'Claude Code',
			available: true,
			command: 'claude',
			path: '/usr/bin/claude',
			args: ['--print'],
			capabilities: { supportsStreamJsonInput: true },
		};
		mockMaestro.agents.get.mockResolvedValue(mockAgent);

		const result = await buildSpawnConfigForAgent({
			sessionId: 'test-session',
			toolType: 'claude-code',
			cwd: '/test/path',
			prompt: 'Hello, world!',
			hasImages: true,
		});

		expect(result).not.toBeNull();
		// With images and stream-json support, use JSON stdin
		expect(result!.sendPromptViaStdin).toBe(true);
		expect(result!.sendPromptViaStdinRaw).toBe(false);
	});

	it('should preserve all other spawn config fields alongside stdin flags', async () => {
		const mockAgent = {
			id: 'claude-code',
			name: 'Claude Code',
			available: true,
			command: 'claude',
			path: '/usr/bin/claude',
			args: ['--print'],
			capabilities: { supportsStreamJsonInput: true },
		};
		mockMaestro.agents.get.mockResolvedValue(mockAgent);

		const result = await buildSpawnConfigForAgent({
			sessionId: 'test-session',
			toolType: 'claude-code',
			cwd: '/test/path',
			prompt: 'Test prompt',
			agentSessionId: 'agent-session-123',
			readOnlyMode: true,
			sessionCustomPath: '/custom/path',
			sessionCustomModel: 'test-model',
		});

		expect(result).not.toBeNull();
		// Stdin flags should be present
		expect(result!.sendPromptViaStdinRaw).toBe(true);
		// All other fields should also be present
		expect(result!.sessionId).toBe('test-session');
		expect(result!.toolType).toBe('claude-code');
		expect(result!.cwd).toBe('/test/path');
		expect(result!.prompt).toBe('Test prompt');
		expect(result!.agentSessionId).toBe('agent-session-123');
		expect(result!.readOnlyMode).toBe(true);
		expect(result!.sessionCustomPath).toBe('/custom/path');
		expect(result!.sessionCustomModel).toBe('test-model');
	});

	it('should handle agents with no capabilities gracefully', async () => {
		const mockAgent = {
			id: 'unknown-agent',
			name: 'Unknown',
			available: true,
			command: 'unknown',
			path: '/usr/bin/unknown',
			args: [],
			// No capabilities property
		};
		mockMaestro.agents.get.mockResolvedValue(mockAgent);

		const result = await buildSpawnConfigForAgent({
			sessionId: 'test-session',
			toolType: 'unknown-agent' as any,
			cwd: '/test/path',
			prompt: 'Hello',
		});

		expect(result).not.toBeNull();
		// Without capabilities, supportsStreamJsonInput defaults to false,
		// so raw stdin should be used on Windows
		expect(result!.sendPromptViaStdinRaw).toBe(true);
		expect(result!.sendPromptViaStdin).toBe(false);
	});
});
