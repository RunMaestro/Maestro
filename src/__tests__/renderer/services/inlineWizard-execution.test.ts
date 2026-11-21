// Source: src/__tests__/renderer/services/inlineWizardConversation_overrides.test.ts
// Source: src/__tests__/renderer/services/inlineWizardDocumentGeneration_overrides.test.ts
// Source: src/__tests__/renderer/services/inlineWizardDocumentGeneration_ssh.test.ts
import { afterEach } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { startInlineWizardConversation } from '../../../renderer/services/inlineWizardConversation';
import { sendWizardMessage } from '../../../renderer/services/inlineWizardConversation';
import { generateInlineDocuments } from '../../../renderer/services/inlineWizardDocumentGeneration';

describe('inlineWizardConversation_overrides', () => {
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

	describe('inlineWizardConversation - Session Overrides', () => {
		afterEach(() => vi.unstubAllGlobals());
		beforeEach(() => {
			vi.stubGlobal('window', { maestro: mockMaestro });
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
});
describe('inlineWizardDocumentGeneration_overrides', () => {
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

	describe('inlineWizardDocumentGeneration - Session Overrides', () => {
		afterEach(() => vi.unstubAllGlobals());
		beforeEach(() => {
			vi.stubGlobal('window', { maestro: mockMaestro });
			vi.clearAllMocks();
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
				autoRunFolderPath: '/test/project/.maestro/playbooks',
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
			exitCallback(spawnSessionId, 0);

			// We don't need to await the full promise since we just wanted to check spawn args
			// But waiting for it ensures we don't leave floating promises
			try {
				await generationPromise;
			} catch (e) {
				// Ignore expected errors from incomplete mock setup (parsing etc)
			}
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
				autoRunFolderPath: '/test/project/.maestro/playbooks',
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
			exitCallback(spawnSessionId, 0);

			try {
				await generationPromise;
			} catch (e) {
				// Ignore
			}
		});
	});
});
describe('inlineWizardDocumentGeneration_ssh', () => {
	// Captured callbacks from onData/onExit registration
	let capturedDataCallback: ((sessionId: string, data: string) => void) | null = null;
	let capturedExitCallback: ((sessionId: string, code: number) => void) | null = null;
	let capturedFileChangedCallback:
		| ((data: { filename: string; eventType: string; folderPath: string }) => void)
		| null = null;

	// Mock window.maestro
	const mockMaestro = {
		agents: {
			get: vi.fn(),
		},
		process: {
			spawn: vi.fn(),
			kill: vi.fn().mockResolvedValue(undefined),
			onData: vi.fn((cb) => {
				capturedDataCallback = cb;
				return vi.fn(); // cleanup function
			}),
			onExit: vi.fn((cb) => {
				capturedExitCallback = cb;
				return vi.fn(); // cleanup function
			}),
		},
		autorun: {
			watchFolder: vi.fn().mockResolvedValue({ success: true }),
			unwatchFolder: vi.fn().mockResolvedValue({ success: true }),
			onFileChanged: vi.fn((cb) => {
				capturedFileChangedCallback = cb;
				return vi.fn(); // cleanup function
			}),
			listDocs: vi.fn().mockResolvedValue({ success: true, tree: [] }),
			writeDoc: vi.fn().mockResolvedValue({ success: true }),
			readDoc: vi.fn().mockResolvedValue({ success: false }),
		},
		fs: {
			readFile: vi.fn().mockResolvedValue(''),
		},
	};

	/**
	 * Configure spawn mock to capture the session ID and fire data + exit callbacks
	 * with the correct session ID so the internal guards pass.
	 */
	function setupSpawnMock(mockOutput: string) {
		mockMaestro.process.spawn.mockImplementation(async (config: { sessionId: string }) => {
			const sid = config.sessionId;

			// Fire data callback with the real session ID (after a microtask to match async flow)
			setTimeout(() => {
				if (capturedDataCallback) {
					capturedDataCallback(sid, mockOutput);
				}
			}, 5);

			// Fire exit callback with code 0 (after data arrives)
			setTimeout(() => {
				if (capturedExitCallback) {
					capturedExitCallback(sid, 0);
				}
			}, 15);
		});
	}

	describe('inlineWizardDocumentGeneration - SSH Remote Support', () => {
		afterEach(() => vi.unstubAllGlobals());
		beforeEach(() => {
			vi.stubGlobal('window', { maestro: mockMaestro });
			vi.clearAllMocks();
			capturedDataCallback = null;
			capturedExitCallback = null;
			capturedFileChangedCallback = null;
		});

		describe('writeDoc operations', () => {
			it('should pass sshRemoteId to writeDoc when saving documents', async () => {
				const mockAgent = {
					id: 'opencode',
					available: true,
					command: 'opencode',
					args: [],
				};
				mockMaestro.agents.get.mockResolvedValue(mockAgent);

				const mockOutput = `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Test.md
CONTENT:
# Test Phase
- [ ] Task 1
---END DOCUMENT---
`;
				setupSpawnMock(mockOutput);

				await generateInlineDocuments({
					agentType: 'opencode',
					directoryPath: '/remote/path',
					projectName: 'Test Project',
					conversationHistory: [],
					mode: 'new',
					autoRunFolderPath: '/remote/path/.maestro/playbooks',
					sessionSshRemoteConfig: {
						enabled: true,
						remoteId: 'test-remote-id',
					},
				});

				// Verify writeDoc was called with sshRemoteId
				expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
					expect.stringContaining('/remote/path/.maestro/playbooks'), // folder path
					'Phase-01-Test.md', // filename
					expect.stringContaining('# Test Phase'), // content
					'test-remote-id' // sshRemoteId (CRITICAL CHECK)
				);
			});

			it('should NOT pass sshRemoteId when SSH is disabled', async () => {
				const mockAgent = {
					id: 'opencode',
					available: true,
					command: 'opencode',
					args: [],
				};
				mockMaestro.agents.get.mockResolvedValue(mockAgent);

				const mockOutput = `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Test.md
CONTENT:
# Test
- [ ] Task 1
---END DOCUMENT---
`;
				setupSpawnMock(mockOutput);

				await generateInlineDocuments({
					agentType: 'opencode',
					directoryPath: '/local/path',
					projectName: 'Test Project',
					conversationHistory: [],
					mode: 'new',
					autoRunFolderPath: '/local/path/.maestro/playbooks',
				});

				// Verify writeDoc was called WITHOUT sshRemoteId (undefined)
				expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
					expect.any(String),
					expect.any(String),
					expect.any(String),
					undefined // sshRemoteId should be undefined
				);
			});
		});

		describe('watchFolder operations', () => {
			it('should pass sshRemoteId to watchFolder when SSH is enabled', async () => {
				const mockAgent = {
					id: 'opencode',
					available: true,
					command: 'opencode',
					args: [],
				};
				mockMaestro.agents.get.mockResolvedValue(mockAgent);

				const mockOutput = `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Test.md
CONTENT:
# Test Phase
- [ ] Task 1
---END DOCUMENT---
`;
				setupSpawnMock(mockOutput);

				await generateInlineDocuments({
					agentType: 'opencode',
					directoryPath: '/remote/path',
					projectName: 'Test Project',
					conversationHistory: [],
					mode: 'new',
					autoRunFolderPath: '/remote/path/.maestro/playbooks',
					sessionSshRemoteConfig: {
						enabled: true,
						remoteId: 'test-remote-id',
					},
				});

				// Verify watchFolder was called with sshRemoteId
				expect(mockMaestro.autorun.watchFolder).toHaveBeenCalledWith(
					expect.stringContaining('/remote/path/.maestro/playbooks'),
					'test-remote-id' // sshRemoteId
				);
			});

			it('should pass undefined to watchFolder when SSH is disabled', async () => {
				const mockAgent = {
					id: 'opencode',
					available: true,
					command: 'opencode',
					args: [],
				};
				mockMaestro.agents.get.mockResolvedValue(mockAgent);

				const mockOutput = `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Test.md
CONTENT:
# Test
- [ ] Task 1
---END DOCUMENT---
`;
				setupSpawnMock(mockOutput);

				await generateInlineDocuments({
					agentType: 'opencode',
					directoryPath: '/local/path',
					projectName: 'Test Project',
					conversationHistory: [],
					mode: 'new',
					autoRunFolderPath: '/local/path/.maestro/playbooks',
				});

				// Verify watchFolder was called with undefined
				expect(mockMaestro.autorun.watchFolder).toHaveBeenCalledWith(
					expect.any(String),
					undefined // sshRemoteId should be undefined
				);
			});
		});

		describe('file watcher readFile operations', () => {
			it('should pass sshRemoteId to readFile in watcher callback when SSH is enabled', async () => {
				const mockAgent = {
					id: 'opencode',
					available: true,
					command: 'opencode',
					args: [],
				};
				mockMaestro.agents.get.mockResolvedValue(mockAgent);

				const mockOutput = `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Test.md
CONTENT:
# Test Phase
- [ ] Task 1
---END DOCUMENT---
`;
				setupSpawnMock(mockOutput);

				// Setup readFile to return content
				mockMaestro.fs.readFile.mockResolvedValue('# Test content');

				await generateInlineDocuments({
					agentType: 'opencode',
					directoryPath: '/remote/path',
					projectName: 'Test Project',
					conversationHistory: [],
					mode: 'new',
					autoRunFolderPath: '/remote/path/.maestro/playbooks',
					sessionSshRemoteConfig: {
						enabled: true,
						remoteId: 'test-remote-id',
					},
				});

				// Simulate file change event
				if (capturedFileChangedCallback) {
					// Capture the actual subfolder path from watchFolder call
					const watchFolderCall = mockMaestro.autorun.watchFolder.mock.calls[0];
					const actualSubfolderPath = (watchFolderCall?.[0] as string) || '';

					capturedFileChangedCallback({
						filename: 'Phase-01-Test',
						eventType: 'rename',
						folderPath: actualSubfolderPath,
					});
				}

				// Wait for async readFile call
				await new Promise((resolve) => setTimeout(resolve, 50));

				// Verify readFile was called with sshRemoteId
				expect(mockMaestro.fs.readFile).toHaveBeenCalledWith(
					expect.stringContaining('Phase-01-Test.md'),
					'test-remote-id' // sshRemoteId
				);
			});
		});

		describe('disk fallback operations', () => {
			it('should pass sshRemoteId to listDocs in disk fallback when SSH is enabled', async () => {
				const mockAgent = {
					id: 'opencode',
					available: true,
					command: 'opencode',
					args: [],
				};
				mockMaestro.agents.get.mockResolvedValue(mockAgent);

				// Empty output to trigger disk fallback
				const mockOutput = '';
				setupSpawnMock(mockOutput);

				// Setup listDocs to return files
				mockMaestro.autorun.listDocs.mockResolvedValue({
					success: true,
					files: ['Phase-01-Test'],
				});

				// Setup readDoc to return content
				mockMaestro.autorun.readDoc.mockResolvedValue({
					success: true,
					content: '# Test content',
				});

				await generateInlineDocuments({
					agentType: 'opencode',
					directoryPath: '/remote/path',
					projectName: 'Test Project',
					conversationHistory: [],
					mode: 'new',
					autoRunFolderPath: '/remote/path/.maestro/playbooks',
					sessionSshRemoteConfig: {
						enabled: true,
						remoteId: 'test-remote-id',
					},
				});

				// Wait for async operations
				await new Promise((resolve) => setTimeout(resolve, 50));

				// Verify listDocs was called with sshRemoteId
				expect(mockMaestro.autorun.listDocs).toHaveBeenCalledWith(
					expect.stringContaining('/remote/path/.maestro/playbooks'),
					'test-remote-id' // sshRemoteId
				);
			});

			it('should pass sshRemoteId to readDoc in disk fallback when SSH is enabled', async () => {
				const mockAgent = {
					id: 'opencode',
					available: true,
					command: 'opencode',
					args: [],
				};
				mockMaestro.agents.get.mockResolvedValue(mockAgent);

				// Empty output to trigger disk fallback
				const mockOutput = '';
				setupSpawnMock(mockOutput);

				// Force the new emitter's pre-read path to come up empty so we fall
				// through to the legacy readDoc-based disk fallback. (vi.clearAllMocks
				// only resets call history, not implementations, so the previous test's
				// successful readFile mock would otherwise leak in here.)
				mockMaestro.fs.readFile.mockResolvedValue('');

				// Setup listDocs to return files
				mockMaestro.autorun.listDocs.mockResolvedValue({
					success: true,
					files: ['Phase-01-Test'],
				});

				// Setup readDoc to return content
				mockMaestro.autorun.readDoc.mockResolvedValue({
					success: true,
					content: '# Test content',
				});

				await generateInlineDocuments({
					agentType: 'opencode',
					directoryPath: '/remote/path',
					projectName: 'Test Project',
					conversationHistory: [],
					mode: 'new',
					autoRunFolderPath: '/remote/path/.maestro/playbooks',
					sessionSshRemoteConfig: {
						enabled: true,
						remoteId: 'test-remote-id',
					},
				});

				// Wait for async operations
				await new Promise((resolve) => setTimeout(resolve, 50));

				// Verify readDoc was called with sshRemoteId
				expect(mockMaestro.autorun.readDoc).toHaveBeenCalledWith(
					expect.stringContaining('/remote/path/.maestro/playbooks'),
					'Phase-01-Test',
					'test-remote-id' // sshRemoteId
				);
			});
		});
	});
});
