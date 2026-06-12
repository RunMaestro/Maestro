/**
 * Tests for phaseGenerator.ts - Windows stdin transport flags
 *
 * These tests verify that the phase generator correctly uses getStdinFlags()
 * to pass prompts via stdin on Windows, avoiding command line length limits.
 *
 * The wizard document generation prompt is 12KB+ before variable substitution,
 * which exceeds the ~8KB cmd.exe limit on Windows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Captured callbacks from process events
let capturedExitCallback: ((sessionId: string, code: number) => void) | null = null;

// Mock window.maestro
const mockMaestro = {
	platform: 'win32',
	agents: {
		get: vi.fn(),
	},
	process: {
		spawn: vi.fn(),
		kill: vi.fn().mockResolvedValue(undefined),
		onData: vi.fn(() => vi.fn()),
		onExit: vi.fn((cb) => {
			capturedExitCallback = cb;
			return vi.fn();
		}),
	},
	autorun: {
		watchFolder: vi.fn().mockResolvedValue({ success: true }),
		unwatchFolder: vi.fn().mockResolvedValue({ success: true }),
		onFileChanged: vi.fn(() => vi.fn()),
		listDocs: vi.fn().mockResolvedValue({ success: true, files: [] }),
		readDoc: vi.fn().mockResolvedValue({ success: false }),
	},
	fs: {
		readFile: vi.fn().mockResolvedValue(''),
	},
};

vi.stubGlobal('window', { maestro: mockMaestro });

// Import after mocking
import { phaseGenerator } from '../../../../../renderer/components/Wizard/services/phaseGenerator';

/**
 * Configure spawn mock to capture the session ID and fire exit callback
 * with the correct session ID so the internal guards pass.
 */
function setupSpawnMock(exitDelay = 10) {
	mockMaestro.process.spawn.mockImplementation(async (config: { sessionId: string }) => {
		const sid = config.sessionId;
		setTimeout(() => {
			if (capturedExitCallback) {
				capturedExitCallback(sid, 0);
			}
		}, exitDelay);
		return { sessionId: sid };
	});
}

describe('phaseGenerator - Windows stdin transport flags', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		capturedExitCallback = null;
		mockMaestro.platform = 'win32';
	});

	afterEach(() => {
		mockMaestro.platform = 'darwin';
	});

	it('should pass sendPromptViaStdinRaw when on Windows without SSH', async () => {
		const mockAgent = {
			id: 'claude-code',
			available: true,
			command: 'claude',
			path: '/usr/bin/claude',
			args: [],
			capabilities: { supportsStreamJsonInput: true },
		};
		mockMaestro.agents.get.mockResolvedValue(mockAgent);
		setupSpawnMock();

		await phaseGenerator.generateDocuments({
			agentType: 'claude-code',
			directoryPath: '/test/project',
			projectName: 'Test Project',
			conversationHistory: [],
		});

		expect(mockMaestro.process.spawn).toHaveBeenCalled();
		const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

		// On Windows without SSH, text-only prompts use raw stdin
		// (supportsStreamJsonInput=true but hasImages=false -> sendPromptViaStdinRaw=true)
		expect(spawnCall.sendPromptViaStdinRaw).toBe(true);
		expect(spawnCall.sendPromptViaStdin).toBe(false);
	});

	it('should NOT pass stdin flags when SSH is enabled', async () => {
		const mockAgent = {
			id: 'claude-code',
			available: true,
			command: 'claude',
			path: '/usr/bin/claude',
			args: [],
			capabilities: { supportsStreamJsonInput: true },
		};
		mockMaestro.agents.get.mockResolvedValue(mockAgent);
		setupSpawnMock();

		await phaseGenerator.generateDocuments({
			agentType: 'claude-code',
			directoryPath: '/remote/project',
			projectName: 'Test Project',
			conversationHistory: [],
			sshRemoteConfig: {
				enabled: true,
				remoteId: 'test-remote-id',
			},
		});

		expect(mockMaestro.process.spawn).toHaveBeenCalled();
		const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

		// SSH sessions must NOT use stdin flags
		expect(spawnCall.sendPromptViaStdin).toBe(false);
		expect(spawnCall.sendPromptViaStdinRaw).toBe(false);
	}, 30000);

	it('should NOT pass stdin flags when SSH is enabled with null remoteId', async () => {
		const mockAgent = {
			id: 'claude-code',
			available: true,
			command: 'claude',
			path: '/usr/bin/claude',
			args: [],
			capabilities: { supportsStreamJsonInput: true },
		};
		mockMaestro.agents.get.mockResolvedValue(mockAgent);
		setupSpawnMock();

		await phaseGenerator.generateDocuments({
			agentType: 'claude-code',
			directoryPath: '/remote/project',
			projectName: 'Test Project',
			conversationHistory: [],
			sshRemoteConfig: {
				enabled: true,
				remoteId: null as any,
			},
		});

		expect(mockMaestro.process.spawn).toHaveBeenCalled();
		const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

		// SSH with enabled=true but remoteId=null must still be treated as SSH
		expect(spawnCall.sendPromptViaStdin).toBe(false);
		expect(spawnCall.sendPromptViaStdinRaw).toBe(false);
	}, 30000);

	it('should NOT pass stdin flags on non-Windows platforms', async () => {
		mockMaestro.platform = 'darwin';

		const mockAgent = {
			id: 'claude-code',
			available: true,
			command: 'claude',
			path: '/usr/bin/claude',
			args: [],
			capabilities: { supportsStreamJsonInput: true },
		};
		mockMaestro.agents.get.mockResolvedValue(mockAgent);
		setupSpawnMock();

		await phaseGenerator.generateDocuments({
			agentType: 'claude-code',
			directoryPath: '/test/project',
			projectName: 'Test Project',
			conversationHistory: [],
		});

		expect(mockMaestro.process.spawn).toHaveBeenCalled();
		const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

		expect(spawnCall.sendPromptViaStdin).toBe(false);
		expect(spawnCall.sendPromptViaStdinRaw).toBe(false);
	});

	it('should NOT add --input-format when sendPromptViaStdin is false', async () => {
		// When hasImages=false and supportsStreamJsonInput=true, sendPromptViaStdin is false
		// (sendPromptViaStdinRaw is true instead), so --input-format should not be added
		const mockAgent = {
			id: 'claude-code',
			available: true,
			command: 'claude',
			path: '/usr/bin/claude',
			args: [],
			capabilities: { supportsStreamJsonInput: true },
		};
		mockMaestro.agents.get.mockResolvedValue(mockAgent);
		setupSpawnMock();

		await phaseGenerator.generateDocuments({
			agentType: 'claude-code',
			directoryPath: '/test/project',
			projectName: 'Test Project',
			conversationHistory: [],
		});

		expect(mockMaestro.process.spawn).toHaveBeenCalled();
		const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

		// Document generation never has images, so sendPromptViaStdin should be false
		// and --input-format should NOT be added
		expect(spawnCall.sendPromptViaStdin).toBe(false);
		expect(spawnCall.args).not.toContain('--input-format');
	});

	it('should pass sendPromptViaStdinRaw for agents without stream-json support', async () => {
		const mockAgent = {
			id: 'opencode',
			available: true,
			command: 'opencode',
			path: '/usr/bin/opencode',
			args: [],
			capabilities: { supportsStreamJsonInput: false },
		};
		mockMaestro.agents.get.mockResolvedValue(mockAgent);
		setupSpawnMock();

		await phaseGenerator.generateDocuments({
			agentType: 'opencode' as any,
			directoryPath: '/test/project',
			projectName: 'Test Project',
			conversationHistory: [],
		});

		expect(mockMaestro.process.spawn).toHaveBeenCalled();
		const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

		// Agents without stream-json support always use raw stdin on Windows
		expect(spawnCall.sendPromptViaStdinRaw).toBe(true);
		expect(spawnCall.sendPromptViaStdin).toBe(false);
	});
});
