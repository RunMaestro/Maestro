/**
 * Tests for inlineWizardDocumentGeneration.ts - Windows stdin transport flags
 *
 * These tests verify that inline wizard document generation correctly uses
 * getStdinFlags() to pass prompts via stdin on Windows, avoiding command
 * line length limits.
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
		listDocs: vi.fn().mockResolvedValue({ success: true, tree: [] }),
		writeDoc: vi.fn().mockResolvedValue({ success: true }),
		readDoc: vi.fn().mockResolvedValue({ success: false }),
	},
	fs: {
		readFile: vi.fn().mockResolvedValue(''),
	},
};

vi.stubGlobal('window', { maestro: mockMaestro });

// Import after mocking
import { generateInlineDocuments } from '../../../renderer/services/inlineWizardDocumentGeneration';

/**
 * Configure spawn mock to capture the session ID and fire exit callback
 * with the correct session ID so the internal guards pass.
 */
function setupSpawnMock(mockOutput: string, exitDelay = 15) {
	mockMaestro.process.spawn.mockImplementation(async (config: { sessionId: string }) => {
		const sid = config.sessionId;

		// Fire data callback with the real session ID
		const dataCallback = mockMaestro.process.onData.mock.calls[0]?.[0];
		if (dataCallback && mockOutput) {
			setTimeout(() => dataCallback(sid, mockOutput), 5);
		}

		// Fire exit callback with code 0
		setTimeout(() => {
			if (capturedExitCallback) {
				capturedExitCallback(sid, 0);
			}
		}, exitDelay);
	});
}

describe('inlineWizardDocumentGeneration - Windows stdin transport flags', () => {
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

		const mockOutput = `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Test.md
CONTENT:
# Phase 01: Test
- [ ] Task 1
---END DOCUMENT---
`;
		setupSpawnMock(mockOutput);

		await generateInlineDocuments({
			agentType: 'claude-code',
			directoryPath: '/test/project',
			projectName: 'Test Project',
			conversationHistory: [],
			mode: 'new',
			autoRunFolderPath: '/test/project/.maestro/playbooks',
		});

		expect(mockMaestro.process.spawn).toHaveBeenCalled();
		const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

		// On Windows without SSH, text-only prompts use raw stdin
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

		const mockOutput = `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Test.md
CONTENT:
# Phase 01: Test
- [ ] Task 1
---END DOCUMENT---
`;
		setupSpawnMock(mockOutput);

		await generateInlineDocuments({
			agentType: 'claude-code',
			directoryPath: '/remote/project',
			projectName: 'Test Project',
			conversationHistory: [],
			mode: 'new',
			autoRunFolderPath: '/remote/project/.maestro/playbooks',
			sessionSshRemoteConfig: {
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

		const mockOutput = `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Test.md
CONTENT:
# Phase 01: Test
- [ ] Task 1
---END DOCUMENT---
`;
		setupSpawnMock(mockOutput);

		await generateInlineDocuments({
			agentType: 'claude-code',
			directoryPath: '/test/project',
			projectName: 'Test Project',
			conversationHistory: [],
			mode: 'new',
			autoRunFolderPath: '/test/project/.maestro/playbooks',
		});

		expect(mockMaestro.process.spawn).toHaveBeenCalled();
		const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

		expect(spawnCall.sendPromptViaStdin).toBe(false);
		expect(spawnCall.sendPromptViaStdinRaw).toBe(false);
	});

	it('should NOT add --input-format when sendPromptViaStdin is false', async () => {
		// Document generation never has images, so sendPromptViaStdin is always false
		// (sendPromptViaStdinRaw is true instead on Windows), so --input-format should not be added
		const mockAgent = {
			id: 'claude-code',
			available: true,
			command: 'claude',
			path: '/usr/bin/claude',
			args: [],
			capabilities: { supportsStreamJsonInput: true },
		};
		mockMaestro.agents.get.mockResolvedValue(mockAgent);

		const mockOutput = `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Test.md
CONTENT:
# Phase 01: Test
- [ ] Task 1
---END DOCUMENT---
`;
		setupSpawnMock(mockOutput);

		await generateInlineDocuments({
			agentType: 'claude-code',
			directoryPath: '/test/project',
			projectName: 'Test Project',
			conversationHistory: [],
			mode: 'new',
			autoRunFolderPath: '/test/project/.maestro/playbooks',
		});

		expect(mockMaestro.process.spawn).toHaveBeenCalled();
		const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

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

		const mockOutput = `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Test.md
CONTENT:
# Phase 01: Test
- [ ] Task 1
---END DOCUMENT---
`;
		setupSpawnMock(mockOutput);

		await generateInlineDocuments({
			agentType: 'opencode' as any,
			directoryPath: '/test/project',
			projectName: 'Test Project',
			conversationHistory: [],
			mode: 'new',
			autoRunFolderPath: '/test/project/.maestro/playbooks',
		});

		expect(mockMaestro.process.spawn).toHaveBeenCalled();
		const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

		// Agents without stream-json support always use raw stdin on Windows
		expect(spawnCall.sendPromptViaStdinRaw).toBe(true);
		expect(spawnCall.sendPromptViaStdin).toBe(false);
	});

	it('should preserve existing session overrides alongside stdin flags', async () => {
		const mockAgent = {
			id: 'opencode',
			available: true,
			command: 'opencode',
			path: '/usr/bin/opencode',
			args: [],
			capabilities: { supportsStreamJsonInput: false },
		};
		mockMaestro.agents.get.mockResolvedValue(mockAgent);
		mockMaestro.process.spawn.mockResolvedValue(undefined);

		const generationPromise = generateInlineDocuments({
			agentType: 'opencode' as any,
			directoryPath: '/test/project',
			projectName: 'Test Project',
			conversationHistory: [],
			mode: 'new',
			autoRunFolderPath: '/test/project/.maestro/playbooks',
			sessionCustomPath: '/custom/path',
			sessionCustomModel: 'test-model',
		});

		// Wait for spawn to be called rather than relying on a fixed timeout
		await vi.waitFor(() => {
			expect(mockMaestro.process.spawn).toHaveBeenCalled();
		});

		const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

		// Stdin flags should be present
		expect(spawnCall.sendPromptViaStdinRaw).toBe(true);
		// Session overrides should also be present
		expect(spawnCall.sessionCustomPath).toBe('/custom/path');
		expect(spawnCall.sessionCustomModel).toBe('test-model');

		// Clean up
		const spawnSessionId = spawnCall.sessionId;
		const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
		exitCallback(spawnSessionId, 0);

		try {
			await generationPromise;
		} catch {
			// Ignore expected errors from incomplete mock setup
		}
	});
});
