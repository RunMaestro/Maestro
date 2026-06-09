/**
 * Tests for inlineWizardDocumentGeneration.ts - Session Overrides
 *
 * These tests verify that session-level overrides (customPath, customArgs, etc.)
 * are correctly propagated to the process manager during document generation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock window.maestro
const mockMaestro = {
	agents: {
		get: vi.fn(),
	},
	process: {
		spawn: vi.fn(),
		onData: vi.fn(() => vi.fn()),
		onExit: vi.fn(() => vi.fn()),
	},
	autorun: {
		watchFolder: vi.fn().mockResolvedValue({ success: true }),
		unwatchFolder: vi.fn().mockResolvedValue({ success: true }),
		onFileChanged: vi.fn(() => vi.fn()),
		listDocs: vi.fn().mockResolvedValue({ success: true, tree: [] }),
	},
};

vi.stubGlobal('window', { maestro: mockMaestro });

// Import after mocking
import { generateInlineDocuments } from '../../../renderer/services/inlineWizardDocumentGeneration';

describe('inlineWizardDocumentGeneration - Session Overrides', () => {
	let consoleLog: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		consoleLog.mockRestore();
	});

	it('should pass session overrides to process.spawn', async () => {
		// Setup mock agent
		const mockAgent = {
			id: 'opencode',
			available: true,
			command: 'opencode',
			args: [],
		};
		mockMaestro.agents.get.mockResolvedValue(mockAgent);
		mockMaestro.process.spawn.mockResolvedValue(undefined);

		// Start generation with overrides
		const generationPromise = generateInlineDocuments({
			agentType: 'opencode',
			directoryPath: '/test/project',
			projectName: 'Test Project',
			conversationHistory: [],
			mode: 'new',
			autoRunFolderPath: '/test/project/Auto Run Docs',
			sessionCustomPath: '/custom/path/opencode',
			sessionCustomArgs: '--custom',
			sessionCustomEnvVars: { TEST: 'true' },
			sessionCustomModel: 'test-model',
		});

		// Give it a moment to start spawning
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Verify spawn was called with correct overrides
		expect(mockMaestro.process.spawn).toHaveBeenCalled();
		const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

		expect(spawnCall.sessionCustomPath).toBe('/custom/path/opencode');
		expect(spawnCall.sessionCustomArgs).toBe('--custom');
		expect(spawnCall.sessionCustomEnvVars).toEqual({ TEST: 'true' });
		expect(spawnCall.sessionCustomModel).toBe('test-model');

		// Clean up
		const spawnSessionId = spawnCall.sessionId;
		const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
		exitCallback(spawnSessionId, 2);

		await expect(generationPromise).resolves.toMatchObject({
			success: false,
			error: 'Agent exited with code 2',
		});
	});

	it('should handle missing overrides gracefully', async () => {
		// Setup mock agent
		const mockAgent = {
			id: 'opencode',
			available: true,
			command: 'opencode',
			args: [],
		};
		mockMaestro.agents.get.mockResolvedValue(mockAgent);
		mockMaestro.process.spawn.mockResolvedValue(undefined);

		// Start generation WITHOUT overrides
		const generationPromise = generateInlineDocuments({
			agentType: 'opencode',
			directoryPath: '/test/project',
			projectName: 'Test Project',
			conversationHistory: [],
			mode: 'new',
			autoRunFolderPath: '/test/project/Auto Run Docs',
		});

		// Give it a moment to start spawning
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Verify spawn was called without overrides
		expect(mockMaestro.process.spawn).toHaveBeenCalled();
		const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

		expect(spawnCall.sessionCustomPath).toBeUndefined();
		expect(spawnCall.sessionCustomArgs).toBeUndefined();
		expect(spawnCall.sessionCustomEnvVars).toBeUndefined();
		expect(spawnCall.sessionCustomModel).toBeUndefined();

		// Clean up
		const spawnSessionId = spawnCall.sessionId;
		const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
		exitCallback(spawnSessionId, 2);

		await expect(generationPromise).resolves.toMatchObject({
			success: false,
			error: 'Agent exited with code 2',
		});
	});
});
