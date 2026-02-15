/**
 * Tests for inlineWizardConversation.ts - Session Overrides
 *
 * These tests verify that session-level overrides (customPath, customArgs, etc.)
 * are correctly propagated to the process manager.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock window.maestro
const mockMaestro = {
	agents: {
		get: vi.fn(),
	},
	process: {
		spawn: vi.fn(),
		onData: vi.fn(() => vi.fn()),
		onExit: vi.fn(() => vi.fn()),
		onThinkingChunk: vi.fn(() => vi.fn()),
		onToolExecution: vi.fn(() => vi.fn()),
	},
};

vi.stubGlobal('window', { maestro: mockMaestro });

// Import after mocking
import {
	startInlineWizardConversation,
	sendWizardMessage,
} from '../../../renderer/services/inlineWizardConversation';

describe('inlineWizardConversation - Session Overrides', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('startInlineWizardConversation', () => {
		it('should store session overrides in the returned session object', async () => {
			const overrides = {
				sessionCustomPath: '/custom/path/to/binary',
				sessionCustomArgs: '--custom-arg',
				sessionCustomEnvVars: { CUSTOM_VAR: 'value' },
				sessionCustomModel: 'custom-model-id',
			};

			const session = await startInlineWizardConversation({
				agentType: 'opencode',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'ask',
				...overrides,
			});

			expect(session.sessionCustomPath).toBe('/custom/path/to/binary');
			expect(session.sessionCustomArgs).toBe('--custom-arg');
			expect(session.sessionCustomEnvVars).toEqual({ CUSTOM_VAR: 'value' });
			expect(session.sessionCustomModel).toBe('custom-model-id');
		});
	});

	describe('sendWizardMessage', () => {
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

			// Start a conversation with overrides
			const session = await startInlineWizardConversation({
				agentType: 'opencode',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'ask',
				sessionCustomPath: '/custom/path/opencode',
				sessionCustomArgs: '--custom',
				sessionCustomEnvVars: { TEST: 'true' },
				sessionCustomModel: 'test-model',
			});

			// Send a message
			const messagePromise = sendWizardMessage(session, 'Hello', []);

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
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(session.sessionId, 0);

			await messagePromise;
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

			// Start a conversation WITHOUT overrides
			const session = await startInlineWizardConversation({
				agentType: 'opencode',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'ask',
			});

			// Send a message
			const messagePromise = sendWizardMessage(session, 'Hello', []);

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
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(session.sessionId, 0);

			await messagePromise;
		});
	});
});
