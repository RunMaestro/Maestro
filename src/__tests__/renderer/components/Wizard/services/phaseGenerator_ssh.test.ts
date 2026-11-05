/**
 * Tests for phaseGenerator.ts - SSH Remote Support
 *
 * These tests verify that SSH remote IDs are correctly propagated to file operations
 * during document generation in the phase generator.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Captured callbacks from process events
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
		onAgentError: vi.fn(() => vi.fn()),
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
		listDocs: vi.fn().mockResolvedValue({ success: true, files: [] }),
		writeDoc: vi.fn().mockResolvedValue({ success: true }),
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
function setupSpawnMock(exitDelay = 10, success?: boolean) {
	mockMaestro.process.spawn.mockImplementation(async (config: { sessionId: string }) => {
		const sid = config.sessionId;

		// Fire exit callback with the real session ID (after a delay to match async flow)
		setTimeout(() => {
			if (capturedExitCallback) {
				capturedExitCallback(sid, 0);
			}
		}, exitDelay);

		return { sessionId: sid, success };
	});
}

describe('phaseGenerator - SSH Remote Support', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		capturedDataCallback = null;
		capturedExitCallback = null;
		capturedFileChangedCallback = null;
	});

	describe('writeDoc operations', () => {
		it('should pass sshRemoteId to writeDoc when saving documents', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);

			// Setup process callbacks
			mockMaestro.process.spawn.mockImplementation(async () => {
				// Simulate agent output
				setTimeout(() => {
					if (capturedDataCallback) {
						capturedDataCallback(
							'test-session',
							`
---BEGIN DOCUMENT---
FILENAME: Phase-01-Setup.md
CONTENT:
# Phase 01: Setup
- [ ] Task 1
---END DOCUMENT---
`
						);
					}
				}, 10);

				setTimeout(() => {
					if (capturedExitCallback) {
						capturedExitCallback('test-session', 0);
					}
				}, 20);

				return { sessionId: 'test-session' };
			});

			// Use saveDocuments which calls writeDoc
			await phaseGenerator.saveDocuments(
				'/remote/path',
				[
					{
						filename: 'Phase-01-Setup.md',
						content: '# Test content',
						taskCount: 1,
					},
				],
				undefined,
				undefined,
				'test-remote-id' // sshRemoteId
			);

			// Verify writeDoc was called with sshRemoteId
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				expect.stringContaining('/remote/path'),
				'Phase-01-Setup.md',
				'# Test content',
				'test-remote-id' // sshRemoteId
			);
		});

		it('should pass undefined to writeDoc when SSH is disabled', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);

			// Use saveDocuments without sshRemoteId
			await phaseGenerator.saveDocuments('/local/path', [
				{
					filename: 'Phase-01-Setup.md',
					content: '# Test content',
					taskCount: 1,
				},
			]);

			// Verify writeDoc was called with undefined sshRemoteId
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				expect.stringContaining('/local/path'),
				'Phase-01-Setup.md',
				'# Test content',
				undefined // sshRemoteId should be undefined
			);
		});
	});

	describe('watchFolder operations', () => {
		it('should pass sshRemoteId to watchFolder when SSH is enabled', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);

			// Setup spawn mock with proper session ID handling
			setupSpawnMock();

			await phaseGenerator.generateDocuments({
				agentType: 'claude-code',
				directoryPath: '/remote/path',
				projectName: 'Test Project',
				conversationHistory: [],
				sshRemoteConfig: {
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
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);

			// Setup spawn mock with proper session ID handling
			setupSpawnMock();

			await phaseGenerator.generateDocuments({
				agentType: 'claude-code',
				directoryPath: '/local/path',
				projectName: 'Test Project',
				conversationHistory: [],
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
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);

			// Setup fs.readFile to return content
			mockMaestro.fs.readFile.mockResolvedValue('# Test content from file');

			// Keep exit under test control so the file event belongs to a live generation.
			mockMaestro.process.spawn.mockImplementation(async ({ sessionId }) => ({ sessionId }));

			const generation = phaseGenerator.generateDocuments({
				agentType: 'claude-code',
				directoryPath: '/remote/path',
				projectName: 'Test Project',
				conversationHistory: [],
				sshRemoteConfig: {
					enabled: true,
					remoteId: 'test-remote-id',
				},
			});

			await vi.waitFor(() => expect(capturedFileChangedCallback).not.toBeNull());

			// Capture the actual folder path from watchFolder call
			const watchFolderCall = mockMaestro.autorun.watchFolder.mock.calls[0];
			const actualFolderPath = (watchFolderCall?.[0] as string) || '';

			// Simulate file change event with the correct folderPath
			if (capturedFileChangedCallback) {
				capturedFileChangedCallback({
					filename: 'Phase-01-Setup',
					eventType: 'rename',
					folderPath: actualFolderPath,
				});
			}

			// Keep the watcher event inside its owned generation.
			await vi.waitFor(() => expect(mockMaestro.fs.readFile).toHaveBeenCalled());
			capturedExitCallback!(mockMaestro.process.spawn.mock.calls[0][0].sessionId, 0);
			await generation;

			// Verify readFile was called with sshRemoteId
			expect(mockMaestro.fs.readFile).toHaveBeenCalledWith(
				expect.stringContaining('Phase-01-Setup.md'),
				'test-remote-id' // sshRemoteId
			);
		});
	});

	describe('disk fallback operations', () => {
		it('should pass sshRemoteId to listDocs in disk fallback when SSH is enabled', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);

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

			// Setup spawn mock (empty output to trigger disk fallback)
			setupSpawnMock();

			await phaseGenerator.generateDocuments({
				agentType: 'claude-code',
				directoryPath: '/remote/path',
				projectName: 'Test Project',
				conversationHistory: [],
				sshRemoteConfig: {
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
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);

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

			// Setup spawn mock (empty output to trigger disk fallback)
			setupSpawnMock();

			await phaseGenerator.generateDocuments({
				agentType: 'claude-code',
				directoryPath: '/remote/path',
				projectName: 'Test Project',
				conversationHistory: [],
				sshRemoteConfig: {
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

	describe('Grok selected host generation', () => {
		beforeEach(() => {
			mockMaestro.agents.get.mockReset();
			mockMaestro.process.spawn.mockReset();
			mockMaestro.autorun.listDocs.mockReset();
			mockMaestro.autorun.readDoc.mockReset();
			mockMaestro.agents.get.mockResolvedValue({
				id: 'grok',
				available: false,
				command: 'grok',
				args: [],
			});
			mockMaestro.autorun.listDocs.mockResolvedValue({ success: true, files: ['Phase-01-Remote'] });
			mockMaestro.autorun.readDoc.mockResolvedValue({
				success: true,
				content: '# Phase 1: Remote\n## Tasks\n- [ ] Build the selected project',
			});
			setupSpawnMock(0, true);
		});

		afterEach(() => {
			phaseGenerator.abort();
			vi.restoreAllMocks();
		});

		it.each([
			[
				'account A',
				true,
				{ GROK_HOME: '/accounts/a', GROK_AUTH_PATH: '/accounts/a/auth.json' },
				undefined,
				undefined,
			],
			[
				'account B',
				true,
				{ GROK_HOME: '/accounts/b', GROK_AUTH_PATH: '/accounts/b/auth.json' },
				'grok-4.5',
				'high',
			],
			['empty env', true, {} as Record<string, string>, 'grok-4.5', undefined],
			['inherited env', true, undefined, undefined, 'high'],
			['local custom binary', false, { GROK_HOME: '/accounts/a' }, undefined, undefined],
		] as const)(
			'keeps %s and selected configuration on the generation consumer',
			async (_label, remote, env, model, effort) => {
				const remoteId = remote ? 'grok-remote' : undefined;
				const sshRemoteConfig = remote
					? {
							enabled: true,
							remoteId: 'grok-remote',
							workingDirOverride: '/remote/project',
						}
					: undefined;
				const onComplete = vi.fn();
				const result = await phaseGenerator.generateDocuments(
					{
						agentType: 'grok',
						directoryPath: '/remote/project',
						projectName: 'Remote',
						conversationHistory: [],
						subfolder: 'Initiation',
						sshRemoteConfig,
						sessionCustomPath: '/remote/bin/grok',
						sessionCustomArgs: '--no-user-rules',
						sessionCustomEnvVars: env,
						sessionCustomEffort: effort,
						model,
					},
					{ onComplete }
				);

				expect(mockMaestro.agents.get).toHaveBeenCalledExactlyOnceWith('grok');
				expect(mockMaestro.process.spawn).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({
						toolType: 'grok',
						command: 'grok',
						cwd: '/remote/project',
						args: ['--max-turns', '32', '--no-subagents'],
						permissionMode: 'full',
						sessionCustomPath: '/remote/bin/grok',
						sessionCustomArgs: '--no-user-rules',
						sessionCustomEnvVars: env,
						sessionCustomEffort: effort,
						sessionCustomModel: model,
						sessionSshRemoteConfig: sshRemoteConfig,
					})
				);
				const folder = '/remote/project/.maestro/playbooks/Initiation';
				expect(mockMaestro.autorun.watchFolder).toHaveBeenCalledWith(folder, remoteId);
				expect(mockMaestro.autorun.listDocs).toHaveBeenCalledWith(folder, remoteId);
				expect(mockMaestro.autorun.readDoc).toHaveBeenCalledWith(
					folder,
					'Phase-01-Remote',
					remoteId
				);
				expect(result).toMatchObject({
					success: true,
					documentsFromDisk: true,
					documents: [
						{
							filename: 'Phase-01-Remote.md',
							taskCount: 1,
							savedPath: `${folder}/Phase-01-Remote.md`,
						},
					],
				});
				expect(onComplete).toHaveBeenCalledExactlyOnceWith(result);
				expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();
			}
		);

		it.each([null, ''])(
			'refuses an unresolved SSH target %s before spawning locally',
			async (remoteId) => {
				const onComplete = vi.fn();
				const onError = vi.fn();
				const result = await phaseGenerator.generateDocuments(
					{
						agentType: 'grok',
						directoryPath: '/remote/project',
						projectName: 'Remote',
						conversationHistory: [],
						sessionCustomPath: '/remote/bin/grok',
						sshRemoteConfig: { enabled: true, remoteId },
					},
					{ onComplete, onError }
				);
				expect(result).toMatchObject({
					success: false,
					error: 'Select an SSH remote before generating documents.',
				});
				expect(mockMaestro.agents.get).toHaveBeenCalledExactlyOnceWith('grok');
				expect(mockMaestro.process.spawn).not.toHaveBeenCalled();
				expect(mockMaestro.autorun.watchFolder).not.toHaveBeenCalled();
				expect(mockMaestro.autorun.listDocs).not.toHaveBeenCalled();
				expect(onComplete).not.toHaveBeenCalled();
				expect(onError).toHaveBeenCalledExactlyOnceWith(result.error);
			}
		);
	});
});
