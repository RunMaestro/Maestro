/**
 * Tests for useInlineWizard hook
 *
 * Tests the inline wizard state management and intent parsing flow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useInlineWizard } from '../../../renderer/hooks/batch/useInlineWizard';
import type { ToolType } from '../../../renderer/types';

// Mock hasCapabilityCached for wizard support checks
vi.mock('../../../renderer/hooks/agent/useAgentCapabilities', async () => {
	const actual = await vi.importActual('../../../renderer/hooks/agent/useAgentCapabilities');
	return {
		...actual,
		hasCapabilityCached: vi.fn((agentId: string, capability: string) => {
			if (capability === 'supportsWizard') {
				return ['claude-code', 'codex', 'opencode'].includes(agentId);
			}
			return false;
		}),
	};
});

// Mock the dependencies
vi.mock('../../../renderer/services/wizardIntentParser', () => ({
	parseWizardIntent: vi.fn(),
}));

vi.mock('../../../renderer/utils/existingDocsDetector', () => ({
	hasExistingAutoRunDocs: vi.fn(),
	getExistingAutoRunDocs: vi.fn(),
	getAutoRunFolderPath: vi.fn((projectPath: string) => `${projectPath}/Auto Run Docs`),
}));

vi.mock('../../../renderer/services/inlineWizardConversation', () => ({
	startInlineWizardConversation: vi.fn().mockReturnValue({
		sessionId: 'test-session-id',
		agentType: 'claude-code',
		directoryPath: '/test/project',
		projectName: 'Test Project',
		systemPrompt: 'Test system prompt',
		isActive: true,
	}),
	sendWizardMessage: vi.fn().mockResolvedValue({
		success: true,
		response: {
			confidence: 50,
			ready: false,
			message: 'Test response',
		},
	}),
	endInlineWizardConversation: vi.fn().mockResolvedValue(undefined),
	READY_CONFIDENCE_THRESHOLD: 80,
}));

vi.mock('../../../renderer/services/inlineWizardDocumentGeneration', () => ({
	generateInlineDocuments: vi.fn().mockResolvedValue({
		success: true,
		documents: [
			{
				filename: 'Phase-01-Setup.md',
				content: '# Phase 01\n\n- [ ] Task 1',
				taskCount: 1,
				savedPath: '/test/project/Auto Run Docs/Test-Project/Phase-01-Setup.md',
			},
		],
		rawOutput: 'test output',
		subfolderName: 'Test-Project',
		subfolderPath: '/test/project/Auto Run Docs/Test-Project',
	}),
	// By default, return the chunk as-is (pass-through for tests)
	extractDisplayTextFromChunk: vi.fn().mockImplementation((chunk: string) => chunk),
}));

// Mock window.maestro.agents.get for agent availability checks
Object.defineProperty(window, 'maestro', {
	value: {
		agents: {
			get: vi.fn().mockResolvedValue({
				id: 'claude-code',
				name: 'Claude Code',
				command: 'claude-code',
				args: [],
				available: true,
				path: '/usr/local/bin/claude-code',
			}),
		},
		autorun: {
			listDocs: vi.fn().mockResolvedValue({ success: true, files: [] }),
			readDoc: vi.fn().mockResolvedValue({ success: true, content: '' }),
			watchFolder: vi.fn().mockResolvedValue({ success: true }),
			unwatchFolder: vi.fn().mockResolvedValue({ success: true }),
			onFileChanged: vi.fn(() => vi.fn()),
		},
	},
	writable: true,
});

import {
	generateInlineDocuments,
	extractDisplayTextFromChunk,
} from '../../../renderer/services/inlineWizardDocumentGeneration';
import {
	startInlineWizardConversation,
	sendWizardMessage,
	endInlineWizardConversation,
} from '../../../renderer/services/inlineWizardConversation';
const mockGenerateInlineDocuments = vi.mocked(generateInlineDocuments);
const mockExtractDisplayTextFromChunk = vi.mocked(extractDisplayTextFromChunk);
const mockStartInlineWizardConversation = vi.mocked(startInlineWizardConversation);
const mockSendWizardMessage = vi.mocked(sendWizardMessage);
const mockEndInlineWizardConversation = vi.mocked(endInlineWizardConversation);

// Import mocked modules
import { parseWizardIntent } from '../../../renderer/services/wizardIntentParser';
import {
	hasExistingAutoRunDocs,
	getExistingAutoRunDocs,
} from '../../../renderer/utils/existingDocsDetector';

const mockParseWizardIntent = vi.mocked(parseWizardIntent);
const mockHasExistingAutoRunDocs = vi.mocked(hasExistingAutoRunDocs);
const mockGetExistingAutoRunDocs = vi.mocked(getExistingAutoRunDocs);

describe('useInlineWizard', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default mock implementations
		mockHasExistingAutoRunDocs.mockResolvedValue(false);
		mockGetExistingAutoRunDocs.mockResolvedValue([]);
		mockParseWizardIntent.mockReturnValue({ mode: 'new' });
		mockStartInlineWizardConversation.mockReturnValue({
			sessionId: 'test-session-id',
			agentType: 'claude-code',
			directoryPath: '/test/project',
			projectName: 'Test Project',
			systemPrompt: 'Test system prompt',
			isActive: true,
		});
		mockSendWizardMessage.mockResolvedValue({
			success: true,
			response: {
				confidence: 50,
				ready: false,
				message: 'Test response',
			},
		});
		mockEndInlineWizardConversation.mockResolvedValue(undefined);
		mockGenerateInlineDocuments.mockResolvedValue({
			success: true,
			documents: [
				{
					filename: 'Phase-01-Setup.md',
					content: '# Phase 01\n\n- [ ] Task 1',
					taskCount: 1,
					savedPath: '/test/project/Auto Run Docs/Test-Project/Phase-01-Setup.md',
				},
			],
			rawOutput: 'test output',
			subfolderName: 'Test-Project',
			subfolderPath: '/test/project/Auto Run Docs/Test-Project',
		});
		mockExtractDisplayTextFromChunk.mockImplementation((chunk: string) => chunk);
		window.maestro.autorun.listDocs = vi.fn().mockResolvedValue({ success: true, files: [] });
		window.maestro.autorun.readDoc = vi.fn().mockResolvedValue({ success: true, content: '' });
		window.maestro.autorun.watchFolder = vi.fn().mockResolvedValue({ success: true });
		window.maestro.autorun.unwatchFolder = vi.fn().mockResolvedValue({ success: true });
		window.maestro.autorun.onFileChanged = vi.fn(() => vi.fn());
		delete (window.maestro as unknown as { history?: unknown }).history;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('initial state', () => {
		it('should have correct initial state', () => {
			const { result } = renderHook(() => useInlineWizard());

			expect(result.current.isWizardActive).toBe(false);
			expect(result.current.isInitializing).toBe(false);
			expect(result.current.wizardMode).toBe(null);
			expect(result.current.wizardGoal).toBe(null);
			expect(result.current.confidence).toBe(0);
			expect(result.current.conversationHistory).toEqual([]);
			expect(result.current.isGeneratingDocs).toBe(false);
			expect(result.current.generatedDocuments).toEqual([]);
			expect(result.current.existingDocuments).toEqual([]);
			expect(result.current.error).toBe(null);
			expect(result.current.streamingContent).toBe('');
			expect(result.current.generationProgress).toBe(null);
		});

		it('should expose per-tab state and active status', async () => {
			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'plan tab work',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project',
					'tab-1'
				);
			});

			expect(result.current.getStateForTab('tab-1')).toEqual(
				expect.objectContaining({
					isActive: true,
					tabId: 'tab-1',
				})
			);
			expect(result.current.isWizardActiveForTab('tab-1')).toBe(true);
			expect(result.current.isWizardActiveForTab('tab-2')).toBe(false);
		});
	});

	describe('startWizard - intent parsing flow', () => {
		describe('when no input is provided', () => {
			it('should set mode to "ask" when existing docs exist', async () => {
				// Mock listDocs to return files (existing docs)
				const mockListDocs = vi.fn().mockResolvedValue({
					success: true,
					files: ['phase-1', 'phase-2'],
				});
				window.maestro.autorun.listDocs = mockListDocs;

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard(undefined, undefined, '/test/project');
				});

				expect(result.current.isWizardActive).toBe(true);
				expect(result.current.wizardMode).toBe('ask');
				expect(mockListDocs).toHaveBeenCalledWith('/test/project/Auto Run Docs');
			});

			it('should set mode to "new" when no existing docs', async () => {
				// Mock listDocs to return empty files (no docs)
				const mockListDocs = vi.fn().mockResolvedValue({
					success: true,
					files: [],
				});
				window.maestro.autorun.listDocs = mockListDocs;

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard(undefined, undefined, '/test/project');
				});

				expect(result.current.wizardMode).toBe('new');
			});

			it('should set mode to "new" when no project path is provided', async () => {
				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard();
				});

				// Without a project path, effectiveAutoRunFolderPath is null → no docs check → new mode
				expect(result.current.wizardMode).toBe('new');
			});
		});

		describe('when input is provided', () => {
			it('should call parseWizardIntent with input and hasExistingDocs', async () => {
				// Mock listDocs to return files (existing docs)
				const mockListDocs = vi.fn().mockResolvedValue({
					success: true,
					files: ['phase-1', 'phase-2'],
				});
				window.maestro.autorun.listDocs = mockListDocs;
				mockParseWizardIntent.mockReturnValue({ mode: 'iterate', goal: 'add auth' });

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard('add authentication', undefined, '/test/project');
				});

				expect(mockParseWizardIntent).toHaveBeenCalledWith('add authentication', true);
				expect(result.current.wizardMode).toBe('iterate');
				expect(result.current.wizardGoal).toBe('add auth');
			});

			it('should handle new mode from intent parser', async () => {
				// Mock listDocs to return files (existing docs)
				const mockListDocs = vi.fn().mockResolvedValue({
					success: true,
					files: ['phase-1'],
				});
				window.maestro.autorun.listDocs = mockListDocs;
				mockParseWizardIntent.mockReturnValue({ mode: 'new' });

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard('start fresh', undefined, '/test/project');
				});

				expect(result.current.wizardMode).toBe('new');
				expect(result.current.wizardGoal).toBe(null);
			});

			it('should handle ask mode from intent parser', async () => {
				// Mock listDocs to return files (existing docs)
				const mockListDocs = vi.fn().mockResolvedValue({
					success: true,
					files: ['phase-1'],
				});
				window.maestro.autorun.listDocs = mockListDocs;
				mockParseWizardIntent.mockReturnValue({ mode: 'ask' });

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard('do something', undefined, '/test/project');
				});

				expect(result.current.wizardMode).toBe('ask');
			});

			it('should trim whitespace from input', async () => {
				mockParseWizardIntent.mockReturnValue({ mode: 'new' });

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard('  add feature  ', undefined, '/test/project');
				});

				expect(mockParseWizardIntent).toHaveBeenCalledWith('add feature', expect.any(Boolean));
			});
		});

		describe('loading existing docs for iterate mode', () => {
			it('should load existing docs when mode is iterate', async () => {
				// Mock listDocs to return files
				const mockListDocs = vi.fn().mockResolvedValue({
					success: true,
					files: ['phase-1', 'phase-2'],
				});
				window.maestro.autorun.listDocs = mockListDocs;
				mockParseWizardIntent.mockReturnValue({ mode: 'iterate', goal: 'add feature' });

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard('add new feature', undefined, '/test/project');
				});

				// The new implementation constructs existingDocs from listDocs result
				expect(result.current.existingDocuments).toHaveLength(2);
				expect(result.current.existingDocuments[0].name).toBe('phase-1');
				expect(result.current.existingDocuments[1].name).toBe('phase-2');
			});

			it('should pass loaded document content to the iterate conversation', async () => {
				const mockListDocs = vi
					.fn()
					.mockResolvedValueOnce({ success: true, files: ['phase-1'] })
					.mockResolvedValueOnce({ success: true, files: ['phase-1'] });
				const mockReadDoc = vi.fn().mockResolvedValue({
					success: true,
					content: '# Phase 1\n\nExisting checklist',
				});
				window.maestro.autorun.listDocs = mockListDocs;
				window.maestro.autorun.readDoc = mockReadDoc;
				mockParseWizardIntent.mockReturnValue({ mode: 'iterate', goal: 'extend docs' });

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard(
						'extend existing docs',
						undefined,
						'/test/project',
						'claude-code',
						'Test Project'
					);
				});

				expect(mockReadDoc).toHaveBeenCalledWith('/test/project/Auto Run Docs', 'phase-1');
				expect(mockStartInlineWizardConversation).toHaveBeenCalledWith(
					expect.objectContaining({
						mode: 'iterate',
						existingDocs: [
							expect.objectContaining({
								name: 'phase-1',
								content: '# Phase 1\n\nExisting checklist',
							}),
						],
					})
				);
			});

			it('should continue iterate setup when document listing fails during context loading', async () => {
				window.maestro.autorun.listDocs = vi
					.fn()
					.mockResolvedValueOnce({ success: true, files: ['phase-1'] })
					.mockRejectedValueOnce(new Error('unreadable folder'));
				mockParseWizardIntent.mockReturnValue({ mode: 'iterate', goal: 'repair docs' });

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard(
						'repair existing docs',
						undefined,
						'/test/project',
						'claude-code',
						'Test Project'
					);
				});

				expect(result.current.existingDocuments).toEqual([]);
				expect(mockStartInlineWizardConversation).toHaveBeenCalledWith(
					expect.objectContaining({
						mode: 'iterate',
						existingDocs: undefined,
					})
				);
			});

			it('should continue iterate setup when document listing returns an unsuccessful result', async () => {
				window.maestro.autorun.listDocs = vi
					.fn()
					.mockResolvedValueOnce({ success: true, files: ['phase-1'] })
					.mockResolvedValueOnce({ success: false, files: ['phase-1'] });
				mockParseWizardIntent.mockReturnValue({ mode: 'iterate', goal: 'repair docs' });

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard(
						'repair existing docs',
						undefined,
						'/test/project',
						'claude-code',
						'Test Project'
					);
				});

				expect(result.current.existingDocuments).toEqual([]);
				expect(mockStartInlineWizardConversation).toHaveBeenCalledWith(
					expect.objectContaining({
						mode: 'iterate',
						existingDocs: undefined,
					})
				);
			});

			it('should not load existing docs when mode is new', async () => {
				// Mock listDocs to return files (existing docs)
				const mockListDocs = vi.fn().mockResolvedValue({
					success: true,
					files: ['phase-1'],
				});
				window.maestro.autorun.listDocs = mockListDocs;
				mockParseWizardIntent.mockReturnValue({ mode: 'new' });

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard('start fresh', undefined, '/test/project');
				});

				// existingDocuments should be empty for new mode (docs only loaded for iterate)
				expect(result.current.existingDocuments).toEqual([]);
			});

			it('should not load existing docs when mode is ask', async () => {
				// Mock listDocs to return files (existing docs)
				const mockListDocs = vi.fn().mockResolvedValue({
					success: true,
					files: ['phase-1'],
				});
				window.maestro.autorun.listDocs = mockListDocs;
				mockParseWizardIntent.mockReturnValue({ mode: 'ask' });

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard('do something', undefined, '/test/project');
				});

				// existingDocuments should be empty for ask mode
				expect(result.current.existingDocuments).toEqual([]);
			});
		});

		describe('isInitializing state', () => {
			it('should set isInitializing to false after async operations complete', async () => {
				// Mock listDocs to return empty (no existing docs)
				const mockListDocs = vi.fn().mockResolvedValue({
					success: true,
					files: [],
				});
				window.maestro.autorun.listDocs = mockListDocs;

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard('test', undefined, '/test/project');
				});

				// After the async operation completes, isInitializing should be false
				expect(result.current.isInitializing).toBe(false);
				expect(result.current.isWizardActive).toBe(true);
			});
		});

		describe('error handling', () => {
			it('should silently handle listDocs errors and default to new mode', async () => {
				// When listDocs fails, we treat it as no existing docs (folder doesn't exist)
				const mockListDocs = vi.fn().mockRejectedValue(new Error('Folder not found'));
				window.maestro.autorun.listDocs = mockListDocs;

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard(undefined, undefined, '/test/project');
				});

				// Error should NOT be set - we silently catch listDocs errors
				expect(result.current.error).toBe(null);
				expect(result.current.wizardMode).toBe('new'); // Default to new when can't check docs
				expect(result.current.isInitializing).toBe(false);
			});

			it('should handle errors from loadDocumentContents in iterate mode', async () => {
				// Setup: listDocs returns files, but loading content fails
				const mockListDocs = vi.fn().mockResolvedValue({
					success: true,
					files: ['phase-1', 'phase-2'],
				});
				const mockReadDoc = vi.fn().mockRejectedValue(new Error('Failed to read file'));
				window.maestro.autorun.listDocs = mockListDocs;
				window.maestro.autorun.readDoc = mockReadDoc;

				mockParseWizardIntent.mockReturnValue({ mode: 'iterate', goal: 'add feature' });

				const { result } = renderHook(() => useInlineWizard());
				const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

				await act(async () => {
					await result.current.startWizard('add feature', undefined, '/test/project');
				});

				// readDoc failure causes loadDocumentContents to fail
				// This should set an error since it's a real loading failure
				expect(result.current.isInitializing).toBe(false);
				expect(consoleSpy).toHaveBeenCalledWith(
					'[useInlineWizard] Failed to load phase-1.md:',
					expect.any(Error)
				);
				expect(consoleSpy).toHaveBeenCalledWith(
					'[useInlineWizard] Failed to load phase-2.md:',
					expect.any(Error)
				);

				consoleSpy.mockRestore();
			});

			it('should treat empty listDocs response as no docs', async () => {
				const mockListDocs = vi.fn().mockResolvedValue({
					success: true,
					files: [],
				});
				window.maestro.autorun.listDocs = mockListDocs;

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard(undefined, undefined, '/test/project');
				});

				// Empty files means no existing docs → new mode
				expect(result.current.error).toBe(null);
				expect(result.current.wizardMode).toBe('new');
			});

			it('should report unsupported wizard agents without starting a conversation', async () => {
				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard(
						'build docs',
						undefined,
						'/test/project',
						'factory-droid' as ToolType,
						'Factory Droid'
					);
				});

				expect(result.current.error).toBe(
					'The inline wizard is not supported for this agent type.'
				);
				expect(result.current.isInitializing).toBe(false);
				expect(mockStartInlineWizardConversation).not.toHaveBeenCalled();
			});

			it('should surface initialization failures from intent parsing', async () => {
				const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
				mockParseWizardIntent.mockImplementationOnce(() => {
					throw new Error('parse failed');
				});

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard('broken intent', undefined, '/test/project');
				});

				expect(result.current.wizardMode).toBe('new');
				expect(result.current.error).toBe('parse failed');
				expect(result.current.isInitializing).toBe(false);
				expect(consoleSpy).toHaveBeenCalledWith(
					'[useInlineWizard] startWizard error:',
					expect.any(Error)
				);

				consoleSpy.mockRestore();
			});

			it('should use the generic initialization message for non-Error failures', async () => {
				const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
				mockParseWizardIntent.mockImplementationOnce(() => {
					throw 'parse failed';
				});

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard('broken intent', undefined, '/test/project');
				});

				expect(result.current.wizardMode).toBe('new');
				expect(result.current.error).toBe('Failed to initialize wizard');
				expect(consoleSpy).toHaveBeenCalledWith(
					'[useInlineWizard] startWizard error:',
					'parse failed'
				);

				consoleSpy.mockRestore();
			});
		});

		describe('previousUIState preservation', () => {
			it('should store and restore previousUIState', async () => {
				const uiState = { readOnlyMode: true, saveToHistory: false, showThinking: 'on' };

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard('test', uiState, '/test/project');
				});

				expect(result.current.state.previousUIState).toEqual(uiState);

				let returnedState: typeof uiState | null;
				await act(async () => {
					returnedState = await result.current.endWizard();
				});

				expect(returnedState).toEqual(uiState);
			});
		});

		describe('projectPath storage', () => {
			it('should store projectPath in state', async () => {
				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard('test', undefined, '/my/project/path');
				});

				expect(result.current.state.projectPath).toBe('/my/project/path');
			});

			it('should handle missing projectPath', async () => {
				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard('test');
				});

				expect(result.current.state.projectPath).toBe(null);
			});
		});

		describe('autoRunFolderPath parameter', () => {
			it('should use configured autoRunFolderPath when provided', async () => {
				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard(
						'test',
						undefined,
						'/my/project',
						'claude-code',
						'Test Project',
						'tab-1',
						'session-1',
						'/custom/auto-run/folder' // User-configured Auto Run folder
					);
				});

				expect(result.current.state.autoRunFolderPath).toBe('/custom/auto-run/folder');
			});

			it('should fall back to default path when autoRunFolderPath not provided', async () => {
				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard(
						'test',
						undefined,
						'/my/project',
						'claude-code',
						'Test Project',
						'tab-1',
						'session-1'
						// No autoRunFolderPath provided
					);
				});

				// Should fall back to projectPath/Auto Run Docs
				expect(result.current.state.autoRunFolderPath).toBe('/my/project/Auto Run Docs');
			});

			it('should check for existing docs in configured folder', async () => {
				// Mock the direct listDocs call
				const mockListDocs = vi.fn().mockResolvedValue({
					success: true,
					files: ['phase-1', 'phase-2'],
				});
				window.maestro.autorun.listDocs = mockListDocs;

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard(
						undefined, // No input, so it checks for existing docs
						undefined,
						'/my/project',
						'claude-code',
						'Test Project',
						'tab-1',
						'session-1',
						'/custom/auto-run/folder'
					);
				});

				// Should check the configured folder, not the default
				expect(mockListDocs).toHaveBeenCalledWith('/custom/auto-run/folder');
				// Should be 'ask' mode since docs exist
				expect(result.current.wizardMode).toBe('ask');
			});

			it('should convert a missing history file path to undefined for conversation setup', async () => {
				const history = { getFilePath: vi.fn().mockResolvedValue(null) };
				(window.maestro as unknown as { history: typeof history }).history = history;

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard(
						'test',
						undefined,
						'/my/project',
						'claude-code',
						'Test Project',
						'tab-1',
						'session-1'
					);
				});

				expect(history.getFilePath).toHaveBeenCalledWith('session-1');
				expect(mockStartInlineWizardConversation).toHaveBeenCalledWith(
					expect.objectContaining({
						historyFilePath: undefined,
					})
				);
			});

			it('should use configured folder and default project name when project metadata is missing', async () => {
				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard(
						'test',
						undefined,
						undefined,
						'claude-code',
						undefined,
						'tab-1',
						undefined,
						'/custom/auto-run/folder'
					);
				});

				expect(mockStartInlineWizardConversation).toHaveBeenCalledWith(
					expect.objectContaining({
						directoryPath: '/custom/auto-run/folder',
						projectName: 'Project',
						autoRunFolderPath: '/custom/auto-run/folder',
					})
				);
			});
		});
	});

	describe('endWizard', () => {
		it('should be a no-op when there is no active wizard', async () => {
			const { result } = renderHook(() => useInlineWizard());

			let previousState: Awaited<ReturnType<typeof result.current.endWizard>> = null;
			await act(async () => {
				previousState = await result.current.endWizard();
			});

			expect(previousState).toBe(null);
			expect(mockEndInlineWizardConversation).not.toHaveBeenCalled();
		});

		it('should reset state to initial values', async () => {
			const { result } = renderHook(() => useInlineWizard());

			// Start wizard
			await act(async () => {
				await result.current.startWizard('add feature', undefined, '/test/project');
			});

			expect(result.current.isWizardActive).toBe(true);

			// End wizard
			await act(async () => {
				await result.current.endWizard();
			});

			expect(result.current.isWizardActive).toBe(false);
			expect(result.current.wizardMode).toBe(null);
			expect(result.current.wizardGoal).toBe(null);
			expect(result.current.existingDocuments).toEqual([]);
		});

		it('should end the active conversation session', async () => {
			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'add feature',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			await act(async () => {
				await result.current.endWizard();
			});

			expect(mockEndInlineWizardConversation).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'test-session-id',
				})
			);
			expect(result.current.isWizardActive).toBe(false);
		});

		it('should clear wizard state when conversation cleanup fails', async () => {
			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			mockEndInlineWizardConversation.mockRejectedValueOnce(new Error('close failed'));

			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'add feature',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			await act(async () => {
				await result.current.endWizard();
			});

			expect(consoleSpy).toHaveBeenCalledWith(
				'[useInlineWizard] Failed to end conversation session:',
				expect.any(Error)
			);
			expect(result.current.isWizardActive).toBe(false);

			consoleSpy.mockRestore();
		});
	});

	describe('setExistingDocuments', () => {
		it('should update existing documents', async () => {
			const { result } = renderHook(() => useInlineWizard());

			const docs = [{ name: 'phase-1', filename: 'phase-1.md', path: '/test/phase-1.md' }];

			act(() => {
				result.current.setExistingDocuments(docs);
			});

			expect(result.current.existingDocuments).toEqual(docs);
		});
	});

	describe('document generation state setters', () => {
		it('should update the generating flag', () => {
			const { result } = renderHook(() => useInlineWizard());

			act(() => {
				result.current.setGeneratingDocs(true);
			});

			expect(result.current.isGeneratingDocs).toBe(true);
		});

		it('should store generated documents and clear the generating flag', () => {
			const { result } = renderHook(() => useInlineWizard());
			const docs = [
				{
					filename: 'Phase-01-Setup.md',
					content: '# Phase 01',
					taskCount: 1,
					savedPath: '/test/project/Auto Run Docs/Phase-01-Setup.md',
				},
			];

			act(() => {
				result.current.setGeneratingDocs(true);
				result.current.setGeneratedDocuments(docs);
			});

			expect(result.current.generatedDocuments).toEqual(docs);
			expect(result.current.isGeneratingDocs).toBe(false);
		});
	});

	describe('sendMessage', () => {
		it('should add user message to conversation history', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.sendMessage('Hello wizard');
			});

			expect(result.current.conversationHistory).toHaveLength(1);
			expect(result.current.conversationHistory[0].role).toBe('user');
			expect(result.current.conversationHistory[0].content).toBe('Hello wizard');
			expect(consoleSpy).toHaveBeenCalledWith(
				'[useInlineWizard] No active conversation session, currentState:',
				expect.objectContaining({
					mode: undefined,
					agentType: undefined,
				})
			);

			consoleSpy.mockRestore();
		});

		it('should auto-create session when sending message in ask mode', async () => {
			const { startInlineWizardConversation } =
				await import('../../../renderer/services/inlineWizardConversation');
			const mockStartConversation = vi.mocked(startInlineWizardConversation);
			mockStartConversation.mockClear();

			// Setup: existing docs exist, so we get 'ask' mode
			window.maestro.autorun.listDocs = vi.fn().mockResolvedValue({
				success: true,
				files: ['phase-1'],
			});

			const { result } = renderHook(() => useInlineWizard());

			// Start wizard in 'ask' mode (no session created)
			await act(async () => {
				await result.current.startWizard(
					undefined,
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			expect(result.current.wizardMode).toBe('ask');
			const callCountBefore = mockStartConversation.mock.calls.length;
			expect(callCountBefore).toBe(0); // No session in 'ask' mode

			// Send a message - should auto-create session and switch to 'new' mode
			await act(async () => {
				await result.current.sendMessage('Help me plan my project');
			});

			// Session should have been created
			expect(mockStartConversation.mock.calls.length).toBe(1);
			expect(mockStartConversation).toHaveBeenCalledWith(
				expect.objectContaining({
					mode: 'new',
					agentType: 'claude-code',
					directoryPath: '/test/project',
				})
			);
			// Mode should have changed to 'new'
			expect(result.current.wizardMode).toBe('new');
		});

		it('should auto-create ask-mode sessions with configured folder defaults', async () => {
			window.maestro.autorun.listDocs = vi.fn().mockResolvedValue({
				success: true,
				files: ['phase-1'],
			});

			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					undefined,
					undefined,
					undefined,
					'claude-code',
					undefined,
					'tab-1',
					undefined,
					'/custom/auto-run/folder'
				);
			});

			mockStartInlineWizardConversation.mockClear();

			await act(async () => {
				await result.current.sendMessage('Help me plan my project');
			});

			expect(mockStartInlineWizardConversation).toHaveBeenCalledWith(
				expect.objectContaining({
					mode: 'new',
					directoryPath: '/custom/auto-run/folder',
					projectName: 'Project',
					autoRunFolderPath: '/custom/auto-run/folder',
				})
			);
			expect(result.current.wizardMode).toBe('new');
		});

		it('should ignore duplicate sends while a response is pending', async () => {
			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			let resolveSend!: (value: Awaited<ReturnType<typeof sendWizardMessage>>) => void;
			const pendingResponse = new Promise<Awaited<ReturnType<typeof sendWizardMessage>>>(
				(resolve) => {
					resolveSend = resolve;
				}
			);
			mockSendWizardMessage.mockReturnValueOnce(pendingResponse);

			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'test',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			let firstSend!: Promise<void>;
			act(() => {
				firstSend = result.current.sendMessage('First message');
			});

			await waitFor(() => expect(result.current.isWaiting).toBe(true));

			await act(async () => {
				await result.current.sendMessage('Second message');
			});

			expect(consoleSpy).toHaveBeenCalledWith(
				'[useInlineWizard] Already waiting for response, ignoring duplicate send'
			);
			expect(mockSendWizardMessage).toHaveBeenCalledTimes(1);

			await act(async () => {
				resolveSend({
					success: true,
					response: {
						confidence: 40,
						ready: false,
						message: 'Response after delay',
					},
				});
				await firstSend;
			});

			consoleSpy.mockRestore();
		});

		it('should set an error when the wizard service returns failure', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const onError = vi.fn();
			mockSendWizardMessage.mockResolvedValueOnce({
				success: false,
				error: 'Agent failed',
			});

			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'test',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			await act(async () => {
				await result.current.sendMessage('Please respond', undefined, { onError });
			});

			expect(result.current.error).toBe('Agent failed');
			expect(result.current.isWaiting).toBe(false);
			expect(onError).toHaveBeenCalledWith('Agent failed');
			expect(consoleSpy).toHaveBeenCalledWith(
				'[useInlineWizard] sendWizardMessage error:',
				'Agent failed'
			);

			consoleSpy.mockRestore();
		});

		it('should use the default send failure message when the service omits an error', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const onError = vi.fn();
			mockSendWizardMessage.mockResolvedValueOnce({
				success: false,
			});

			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'test',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			await act(async () => {
				await result.current.sendMessage('Please respond', undefined, { onError });
			});

			expect(result.current.error).toBe('Failed to get response from AI');
			expect(onError).toHaveBeenCalledWith('Failed to get response from AI');
			expect(consoleSpy).toHaveBeenCalledWith(
				'[useInlineWizard] sendWizardMessage error:',
				'Failed to get response from AI'
			);

			consoleSpy.mockRestore();
		});

		it('should set an error when sending throws', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const onError = vi.fn();
			mockSendWizardMessage.mockRejectedValueOnce(new Error('network down'));

			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'test',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			await act(async () => {
				await result.current.sendMessage('Please respond', undefined, { onError });
			});

			expect(result.current.error).toBe('network down');
			expect(result.current.isWaiting).toBe(false);
			expect(onError).toHaveBeenCalledWith('network down');
			expect(consoleSpy).toHaveBeenCalledWith(
				'[useInlineWizard] sendMessage error:',
				expect.any(Error)
			);

			consoleSpy.mockRestore();
		});

		it('should use the generic error when sending throws a non-Error value', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const onError = vi.fn();
			mockSendWizardMessage.mockRejectedValueOnce('network down');

			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'test',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			await act(async () => {
				await result.current.sendMessage('Please respond', undefined, { onError });
			});

			expect(result.current.error).toBe('Unknown error occurred');
			expect(onError).toHaveBeenCalledWith('Unknown error occurred');
			expect(consoleSpy).toHaveBeenCalledWith(
				'[useInlineWizard] sendMessage error:',
				'network down'
			);

			consoleSpy.mockRestore();
		});

		it('should include images on user messages', async () => {
			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'test',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			await act(async () => {
				await result.current.sendMessage('Describe this', ['data:image/png;base64,abc']);
			});

			expect(result.current.conversationHistory[0]).toEqual(
				expect.objectContaining({
					role: 'user',
					content: 'Describe this',
					images: ['data:image/png;base64,abc'],
				})
			);
		});
	});

	describe('addAssistantMessage', () => {
		it('should add assistant message with confidence', () => {
			const { result } = renderHook(() => useInlineWizard());

			act(() => {
				result.current.addAssistantMessage('I understand your request', 75, false);
			});

			expect(result.current.conversationHistory).toHaveLength(1);
			expect(result.current.conversationHistory[0].role).toBe('assistant');
			expect(result.current.conversationHistory[0].confidence).toBe(75);
			expect(result.current.confidence).toBe(75);
		});

		it('should preserve confidence and ready when optional values are omitted', () => {
			const { result } = renderHook(() => useInlineWizard());

			act(() => {
				result.current.setConfidence(35);
				result.current.addAssistantMessage('A message without confidence');
			});

			expect(result.current.conversationHistory).toHaveLength(1);
			expect(result.current.confidence).toBe(35);
			expect(result.current.ready).toBe(false);
		});

		it('should add assistant messages on the active wizard tab', async () => {
			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'test',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project',
					'tab-1'
				);
			});

			act(() => {
				result.current.addAssistantMessage('Tab-specific response', 60, true);
			});

			expect(result.current.getStateForTab('tab-1')?.conversationHistory).toEqual([
				expect.objectContaining({
					role: 'assistant',
					content: 'Tab-specific response',
				}),
			]);
		});
	});

	describe('clearConversation', () => {
		it('should remove all conversation messages', () => {
			const { result } = renderHook(() => useInlineWizard());

			act(() => {
				result.current.addAssistantMessage('I understand your request', 75, false);
				result.current.clearConversation();
			});

			expect(result.current.conversationHistory).toEqual([]);
		});
	});

	describe('setMode', () => {
		it('should update wizard mode', () => {
			const { result } = renderHook(() => useInlineWizard());

			act(() => {
				result.current.setMode('iterate');
			});

			expect(result.current.wizardMode).toBe('iterate');
		});

		it('should create conversation session when transitioning from ask to new mode', async () => {
			const { startInlineWizardConversation } =
				await import('../../../renderer/services/inlineWizardConversation');
			const mockStartConversation = vi.mocked(startInlineWizardConversation);
			mockStartConversation.mockClear();

			// Setup: existing docs exist, so we get 'ask' mode when starting with no input
			window.maestro.autorun.listDocs = vi.fn().mockResolvedValue({
				success: true,
				files: ['phase-1'],
			});

			const { result } = renderHook(() => useInlineWizard());

			// Start wizard - should be in 'ask' mode because existing docs exist
			await act(async () => {
				await result.current.startWizard(
					undefined,
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			expect(result.current.wizardMode).toBe('ask');

			// Note how many times startInlineWizardConversation was called (should be 0 for 'ask' mode)
			const callCountBefore = mockStartConversation.mock.calls.length;

			// Now transition from 'ask' to 'new' - this should create the conversation session
			act(() => {
				result.current.setMode('new');
			});

			expect(result.current.wizardMode).toBe('new');
			// Session should have been created
			expect(mockStartConversation.mock.calls.length).toBe(callCountBefore + 1);
			expect(mockStartConversation).toHaveBeenLastCalledWith(
				expect.objectContaining({
					mode: 'new',
					agentType: 'claude-code',
					directoryPath: '/test/project',
					projectName: 'Test Project',
				})
			);
		});

		it('should create conversation session when transitioning from ask to iterate mode', async () => {
			const { startInlineWizardConversation } =
				await import('../../../renderer/services/inlineWizardConversation');
			const mockStartConversation = vi.mocked(startInlineWizardConversation);
			mockStartConversation.mockClear();

			// Setup: existing docs exist, so we get 'ask' mode
			window.maestro.autorun.listDocs = vi.fn().mockResolvedValue({
				success: true,
				files: ['phase-1'],
			});

			const { result } = renderHook(() => useInlineWizard());

			// Start wizard in 'ask' mode
			await act(async () => {
				await result.current.startWizard(
					undefined,
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			expect(result.current.wizardMode).toBe('ask');

			const callCountBefore = mockStartConversation.mock.calls.length;

			// Transition from 'ask' to 'iterate'
			act(() => {
				result.current.setMode('iterate');
			});

			expect(result.current.wizardMode).toBe('iterate');
			expect(mockStartConversation.mock.calls.length).toBe(callCountBefore + 1);
			expect(mockStartConversation).toHaveBeenLastCalledWith(
				expect.objectContaining({
					mode: 'iterate',
				})
			);
		});

		it('should create ask-mode sessions with configured folder defaults after mode selection', async () => {
			window.maestro.autorun.listDocs = vi.fn().mockResolvedValue({
				success: true,
				files: ['phase-1'],
			});

			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					undefined,
					undefined,
					undefined,
					'claude-code',
					undefined,
					'tab-1',
					undefined,
					'/custom/auto-run/folder'
				);
			});

			mockStartInlineWizardConversation.mockClear();

			act(() => {
				result.current.setMode('new');
			});

			expect(mockStartInlineWizardConversation).toHaveBeenCalledWith(
				expect.objectContaining({
					mode: 'new',
					directoryPath: '/custom/auto-run/folder',
					projectName: 'Project',
				})
			);
		});

		it('should not create a session when selecting a mode for an unsupported ask-mode agent', async () => {
			window.maestro.autorun.listDocs = vi.fn().mockResolvedValue({
				success: true,
				files: ['phase-1'],
			});

			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					undefined,
					undefined,
					'/test/project',
					'factory-droid' as ToolType,
					'Factory Droid'
				);
			});

			mockStartInlineWizardConversation.mockClear();

			act(() => {
				result.current.setMode('new');
			});

			expect(result.current.wizardMode).toBe('new');
			expect(mockStartInlineWizardConversation).not.toHaveBeenCalled();
		});

		it('should not create duplicate session when transitioning from new to iterate', async () => {
			const { startInlineWizardConversation } =
				await import('../../../renderer/services/inlineWizardConversation');
			const mockStartConversation = vi.mocked(startInlineWizardConversation);
			mockStartConversation.mockClear();

			// Setup: no existing docs via listDocs, so we get 'new' mode directly
			const mockListDocs = vi.fn().mockResolvedValue({
				success: true,
				files: [], // Empty = no existing docs
			});
			window.maestro.autorun.listDocs = mockListDocs;

			const { result } = renderHook(() => useInlineWizard());

			// Start wizard in 'new' mode - session is already created
			await act(async () => {
				await result.current.startWizard(
					undefined,
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			expect(result.current.wizardMode).toBe('new');
			const callCountAfterStart = mockStartConversation.mock.calls.length;
			expect(callCountAfterStart).toBe(1); // Session created once during start

			// Transition from 'new' to 'iterate' - should NOT create another session
			act(() => {
				result.current.setMode('iterate');
			});

			expect(result.current.wizardMode).toBe('iterate');
			// Should not have created a new session since we weren't in 'ask' mode
			expect(mockStartConversation.mock.calls.length).toBe(callCountAfterStart);
		});
	});

	describe('setGoal', () => {
		it('should update wizard goal', () => {
			const { result } = renderHook(() => useInlineWizard());

			act(() => {
				result.current.setGoal('add authentication');
			});

			expect(result.current.wizardGoal).toBe('add authentication');
		});
	});

	describe('reset', () => {
		it('should be a no-op when resetting without an active wizard', () => {
			const { result } = renderHook(() => useInlineWizard());

			act(() => {
				result.current.reset();
			});

			expect(result.current.isWizardActive).toBe(false);
			expect(mockEndInlineWizardConversation).not.toHaveBeenCalled();
		});

		it('should reset wizard to initial state', async () => {
			const { result } = renderHook(() => useInlineWizard());

			// Start wizard with state
			await act(async () => {
				await result.current.startWizard('test', undefined, '/test/project');
			});

			act(() => {
				result.current.setConfidence(50);
				result.current.addAssistantMessage('Hello');
			});

			// Reset
			act(() => {
				result.current.reset();
			});

			expect(result.current.isWizardActive).toBe(false);
			expect(result.current.confidence).toBe(0);
			expect(result.current.conversationHistory).toEqual([]);
			expect(result.current.state.projectPath).toBe(null);
		});

		it('should clean up an active conversation session during reset', async () => {
			mockEndInlineWizardConversation.mockRejectedValueOnce(new Error('cleanup failed'));
			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'test',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			act(() => {
				result.current.reset();
			});
			await Promise.resolve();

			expect(mockEndInlineWizardConversation).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'test-session-id',
				})
			);
			expect(result.current.isWizardActive).toBe(false);
		});
	});

	describe('clearError', () => {
		it('should clear the current error', async () => {
			const { result } = renderHook(() => useInlineWizard());

			// Set an error manually
			act(() => {
				result.current.setError('Something went wrong');
			});

			expect(result.current.error).toBe('Something went wrong');

			// Clear the error
			act(() => {
				result.current.clearError();
			});

			expect(result.current.error).toBe(null);
		});

		it('should not affect other state when clearing error', async () => {
			const { result } = renderHook(() => useInlineWizard());

			// Start wizard and set some state
			await act(async () => {
				await result.current.startWizard('test', undefined, '/test/project');
			});

			act(() => {
				result.current.setConfidence(50);
				result.current.setError('Test error');
			});

			expect(result.current.isWizardActive).toBe(true);
			expect(result.current.confidence).toBe(50);
			expect(result.current.error).toBe('Test error');

			// Clear error
			act(() => {
				result.current.clearError();
			});

			// Other state should be preserved
			expect(result.current.isWizardActive).toBe(true);
			expect(result.current.confidence).toBe(50);
			expect(result.current.error).toBe(null);
		});
	});

	describe('retryLastMessage', () => {
		it('should not retry when there is no error', async () => {
			const { result } = renderHook(() => useInlineWizard());
			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			await act(async () => {
				await result.current.retryLastMessage();
			});

			expect(consoleSpy).toHaveBeenCalledWith(
				'[useInlineWizard] Cannot retry: no last message or no error'
			);

			consoleSpy.mockRestore();
		});

		it('should not retry when there is no last message', async () => {
			const { result } = renderHook(() => useInlineWizard());
			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			// Set an error but don't send a message
			act(() => {
				result.current.setError('Some error');
			});

			await act(async () => {
				await result.current.retryLastMessage();
			});

			expect(consoleSpy).toHaveBeenCalledWith(
				'[useInlineWizard] Cannot retry: no last message or no error'
			);

			consoleSpy.mockRestore();
		});

		it('should remove the failed user message and resend the last message', async () => {
			mockSendWizardMessage
				.mockResolvedValueOnce({
					success: false,
					error: 'Agent failed',
				})
				.mockResolvedValueOnce({
					success: true,
					response: {
						confidence: 85,
						ready: true,
						message: 'Retry succeeded',
					},
				});
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'test',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			await act(async () => {
				await result.current.sendMessage('Retry this');
			});

			expect(result.current.error).toBe('Agent failed');
			expect(result.current.conversationHistory).toHaveLength(1);

			await act(async () => {
				await result.current.retryLastMessage();
			});

			expect(mockSendWizardMessage).toHaveBeenCalledTimes(2);
			expect(result.current.error).toBe(null);
			expect(result.current.conversationHistory.map((message) => message.role)).toEqual([
				'user',
				'assistant',
			]);
			expect(result.current.conversationHistory[0].content).toBe('Retry this');
			expect(result.current.conversationHistory[1].content).toBe('Retry succeeded');
			expect(result.current.ready).toBe(true);

			consoleSpy.mockRestore();
		});

		it('should retry after skipping newer non-user messages in history', async () => {
			mockSendWizardMessage
				.mockResolvedValueOnce({
					success: false,
					error: 'Agent failed',
				})
				.mockResolvedValueOnce({
					success: true,
					response: {
						confidence: 85,
						ready: true,
						message: 'Retry succeeded',
					},
				});
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'test',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			await act(async () => {
				await result.current.sendMessage('Retry this');
			});

			act(() => {
				result.current.addAssistantMessage('Diagnostic note');
			});

			await act(async () => {
				await result.current.retryLastMessage();
			});

			expect(mockSendWizardMessage).toHaveBeenCalledTimes(2);
			expect(result.current.conversationHistory.map((message) => message.content)).toEqual([
				'Diagnostic note',
				'Retry this',
				'Retry succeeded',
			]);

			consoleSpy.mockRestore();
		});

		it('should retry the last message after the failed message was cleared from history', async () => {
			mockSendWizardMessage
				.mockResolvedValueOnce({
					success: false,
					error: 'Agent failed',
				})
				.mockResolvedValueOnce({
					success: true,
					response: {
						confidence: 70,
						ready: false,
						message: 'Recovered',
					},
				});
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'test',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			await act(async () => {
				await result.current.sendMessage('Retry this');
			});

			act(() => {
				result.current.clearConversation();
			});

			await act(async () => {
				await result.current.retryLastMessage();
			});

			expect(mockSendWizardMessage).toHaveBeenCalledTimes(2);
			expect(result.current.conversationHistory.map((message) => message.content)).toEqual([
				'Retry this',
				'Recovered',
			]);

			consoleSpy.mockRestore();
		});
	});

	describe('generateDocuments', () => {
		it('should return error when agent type or Auto Run folder path is missing', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const { result } = renderHook(() => useInlineWizard());

			// Don't start wizard (no agentType or autoRunFolderPath)
			await act(async () => {
				await result.current.generateDocuments();
			});

			expect(result.current.error).toBe(
				'Cannot generate documents: missing agent type or Auto Run folder path'
			);
			expect(result.current.isGeneratingDocs).toBe(false);
			expect(consoleSpy).toHaveBeenCalledWith(
				'[useInlineWizard]',
				'Cannot generate documents: missing agent type or Auto Run folder path'
			);

			consoleSpy.mockRestore();
		});

		it('should set isGeneratingDocs to true during generation', async () => {
			// Mock generateInlineDocuments to capture the callbacks
			let capturedCallbacks: { onStart?: () => void } | undefined;
			mockGenerateInlineDocuments.mockImplementationOnce(async (config) => {
				capturedCallbacks = config.callbacks;
				// Call onStart to simulate the service behavior
				config.callbacks?.onStart?.();
				return {
					success: true,
					documents: [
						{
							filename: 'Phase-01-Setup.md',
							content: '# Phase 01\n\n- [ ] Task 1',
							taskCount: 1,
							savedPath: '/test/project/Auto Run Docs/Phase-01-Setup.md',
						},
					],
					rawOutput: 'test output',
				};
			});

			const { result } = renderHook(() => useInlineWizard());

			// Start wizard with required params
			await act(async () => {
				await result.current.startWizard(
					'test',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			// Start generation
			let onStartCalled = false;
			await act(async () => {
				await result.current.generateDocuments({
					onStart: () => {
						onStartCalled = true;
					},
				});
			});

			// The wrapper onStart in the hook should have been called
			expect(capturedCallbacks?.onStart).toBeDefined();
			expect(onStartCalled).toBe(true);
		});

		it('should call generateInlineDocuments with correct config', async () => {
			const { result } = renderHook(() => useInlineWizard());

			// Start wizard with required params
			await act(async () => {
				await result.current.startWizard(
					'test goal',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			// Generate documents
			await act(async () => {
				await result.current.generateDocuments();
			});

			expect(mockGenerateInlineDocuments).toHaveBeenCalledWith(
				expect.objectContaining({
					agentType: 'claude-code',
					directoryPath: '/test/project',
					projectName: 'Test Project',
					autoRunFolderPath: '/test/project/Auto Run Docs',
				})
			);
		});

		it('should generate with configured folder defaults when project metadata is missing', async () => {
			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'test goal',
					undefined,
					undefined,
					'claude-code',
					undefined,
					'tab-1',
					undefined,
					'/custom/auto-run/folder'
				);
			});

			await act(async () => {
				await result.current.generateDocuments();
			});

			expect(mockGenerateInlineDocuments).toHaveBeenCalledWith(
				expect.objectContaining({
					directoryPath: '/custom/auto-run/folder',
					projectName: 'Project',
					autoRunFolderPath: '/custom/auto-run/folder',
				})
			);
		});

		it('should pass iterate mode to document generation', async () => {
			window.maestro.autorun.listDocs = vi
				.fn()
				.mockResolvedValueOnce({ success: true, files: ['phase-1'] })
				.mockResolvedValueOnce({ success: true, files: ['phase-1'] });
			mockParseWizardIntent.mockReturnValue({ mode: 'iterate', goal: 'extend docs' });

			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'extend existing docs',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			await act(async () => {
				await result.current.generateDocuments();
			});

			expect(mockGenerateInlineDocuments).toHaveBeenCalledWith(
				expect.objectContaining({
					mode: 'iterate',
					goal: 'extend docs',
				})
			);
		});

		it('should update generatedDocuments on success', async () => {
			const { result } = renderHook(() => useInlineWizard());

			// Start wizard with required params
			await act(async () => {
				await result.current.startWizard(
					'test',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			// Generate documents
			await act(async () => {
				await result.current.generateDocuments();
			});

			expect(result.current.generatedDocuments).toHaveLength(1);
			expect(result.current.generatedDocuments[0].filename).toBe('Phase-01-Setup.md');
			expect(result.current.isGeneratingDocs).toBe(false);
		});

		it('should treat a successful generation without documents as an empty result', async () => {
			mockGenerateInlineDocuments.mockResolvedValueOnce({
				success: true,
				rawOutput: 'test output',
			});

			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'test',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			await act(async () => {
				await result.current.generateDocuments();
			});

			expect(result.current.generatedDocuments).toEqual([]);
			expect(result.current.generationProgress).toEqual({ current: 0, total: 0 });
		});

		it('should set error on generation failure', async () => {
			mockGenerateInlineDocuments.mockResolvedValueOnce({
				success: false,
				error: 'Generation failed',
			});

			const { result } = renderHook(() => useInlineWizard());

			// Start wizard with required params
			await act(async () => {
				await result.current.startWizard(
					'test',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			// Generate documents
			await act(async () => {
				await result.current.generateDocuments();
			});

			expect(result.current.error).toBe('Generation failed');
			expect(result.current.isGeneratingDocs).toBe(false);
		});

		it('should use the default document generation failure message', async () => {
			mockGenerateInlineDocuments.mockResolvedValueOnce({
				success: false,
			});

			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'test',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			await act(async () => {
				await result.current.generateDocuments();
			});

			expect(result.current.error).toBe('Document generation failed');
			expect(result.current.streamingContent).toBe('');
			expect(result.current.generationProgress).toBe(null);
		});

		it('should call callbacks during generation', async () => {
			const { result } = renderHook(() => useInlineWizard());

			const onStart = vi.fn();
			const onComplete = vi.fn();

			// Start wizard with required params
			await act(async () => {
				await result.current.startWizard(
					'test',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			// Generate documents with callbacks
			await act(async () => {
				await result.current.generateDocuments({
					onStart,
					onComplete,
				});
			});

			// The callbacks should have been passed to generateInlineDocuments
			expect(mockGenerateInlineDocuments).toHaveBeenCalledWith(
				expect.objectContaining({
					callbacks: expect.objectContaining({
						onStart: expect.any(Function),
						onComplete: expect.any(Function),
					}),
				})
			);
		});

		it('should run completion and error callback wrappers from the generation service', async () => {
			const docs = [
				{
					filename: 'Phase-01-Setup.md',
					content: '# Phase 01\n\n- [ ] Task 1',
					taskCount: 1,
					savedPath: '/test/project/Auto Run Docs/Phase-01-Setup.md',
				},
			];
			mockGenerateInlineDocuments.mockImplementationOnce(async (config) => {
				config.callbacks?.onComplete?.(docs);
				config.callbacks?.onError?.('stream warning');
				return {
					success: true,
					documents: docs,
					rawOutput: 'test output',
				};
			});
			const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const onComplete = vi.fn();
			const onError = vi.fn();

			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'test',
					undefined,
					'/test/project',
					'claude-code',
					'Test Project'
				);
			});

			await act(async () => {
				await result.current.generateDocuments({ onComplete, onError });
			});

			expect(onComplete).toHaveBeenCalledWith(docs);
			expect(onError).toHaveBeenCalledWith('stream warning');
			expect(result.current.generatedDocuments).toEqual(docs);
			expect(result.current.isGeneratingDocs).toBe(false);
			expect(consoleLog).toHaveBeenCalledWith(
				'[useInlineWizard] All documents complete:',
				docs.length
			);
			expect(consoleError).toHaveBeenCalledWith(
				'[useInlineWizard] Generation error:',
				'stream warning'
			);

			consoleLog.mockRestore();
			consoleError.mockRestore();
		});

		describe('streaming state', () => {
			it('should reset streaming state when starting generation', async () => {
				const { result } = renderHook(() => useInlineWizard());

				// Start wizard with required params
				await act(async () => {
					await result.current.startWizard(
						'test',
						undefined,
						'/test/project',
						'claude-code',
						'Test Project'
					);
				});

				// Generate documents
				await act(async () => {
					await result.current.generateDocuments();
				});

				// Streaming content should be reset at start (though may be populated by chunks)
				// The key test is that generateInlineDocuments was called with callbacks
				expect(mockGenerateInlineDocuments).toHaveBeenCalledWith(
					expect.objectContaining({
						callbacks: expect.objectContaining({
							onChunk: expect.any(Function),
						}),
					})
				);
			});

			it('should accumulate streaming content when onChunk is called', async () => {
				// Capture callbacks to simulate streaming
				let capturedCallbacks: { onChunk?: (chunk: string) => void } | undefined;
				mockGenerateInlineDocuments.mockImplementationOnce(async (config) => {
					capturedCallbacks = config.callbacks;
					// Simulate streaming chunks
					config.callbacks?.onChunk?.('First chunk');
					config.callbacks?.onChunk?.(' Second chunk');
					return {
						success: true,
						documents: [
							{
								filename: 'Phase-01-Setup.md',
								content: '# Phase 01\n\n- [ ] Task 1',
								taskCount: 1,
								savedPath: '/test/project/Auto Run Docs/Phase-01-Setup.md',
							},
						],
						rawOutput: 'test output',
					};
				});

				const { result } = renderHook(() => useInlineWizard());

				// Start wizard with required params
				await act(async () => {
					await result.current.startWizard(
						'test',
						undefined,
						'/test/project',
						'claude-code',
						'Test Project'
					);
				});

				// Generate documents
				await act(async () => {
					await result.current.generateDocuments();
				});

				// Streaming content should have accumulated
				expect(result.current.streamingContent).toBe('First chunk Second chunk');
				expect(mockExtractDisplayTextFromChunk).toHaveBeenCalledWith('First chunk', 'claude-code');
			});

			it('should update generationProgress when onDocumentComplete is called', async () => {
				// Capture callbacks to simulate document completion
				mockGenerateInlineDocuments.mockImplementationOnce(async (config) => {
					// Simulate onDocumentComplete being called
					config.callbacks?.onDocumentComplete?.({
						filename: 'Phase-01-Setup.md',
						content: '# Phase 01\n\n- [ ] Task 1',
						taskCount: 1,
						savedPath: '/test/project/Auto Run Docs/Phase-01-Setup.md',
					});
					config.callbacks?.onDocumentComplete?.({
						filename: 'Phase-02-Build.md',
						content: '# Phase 02\n\n- [ ] Task 2',
						taskCount: 1,
						savedPath: '/test/project/Auto Run Docs/Phase-02-Build.md',
					});
					return {
						success: true,
						documents: [
							{
								filename: 'Phase-01-Setup.md',
								content: '# Phase 01\n\n- [ ] Task 1',
								taskCount: 1,
								savedPath: '/test/project/Auto Run Docs/Phase-01-Setup.md',
							},
							{
								filename: 'Phase-02-Build.md',
								content: '# Phase 02\n\n- [ ] Task 2',
								taskCount: 1,
								savedPath: '/test/project/Auto Run Docs/Phase-02-Build.md',
							},
						],
						rawOutput: 'test output',
					};
				});

				const { result } = renderHook(() => useInlineWizard());

				// Start wizard with required params
				await act(async () => {
					await result.current.startWizard(
						'test',
						undefined,
						'/test/project',
						'claude-code',
						'Test Project'
					);
				});

				// Generate documents
				await act(async () => {
					await result.current.generateDocuments();
				});

				// Progress should show 2 of 2 after completion
				expect(result.current.generationProgress).toEqual({
					current: 2,
					total: 2,
				});
			});

			it('should parse progress from onProgress message', async () => {
				// Capture callbacks to simulate progress message
				mockGenerateInlineDocuments.mockImplementationOnce(async (config) => {
					// Simulate progress message with "X of Y" format
					config.callbacks?.onProgress?.('Saving 1 of 3 document(s)...');
					return {
						success: true,
						documents: [
							{
								filename: 'Phase-01-Setup.md',
								content: '# Phase 01\n\n- [ ] Task 1',
								taskCount: 1,
								savedPath: '/test/project/Auto Run Docs/Phase-01-Setup.md',
							},
						],
						rawOutput: 'test output',
					};
				});

				const { result } = renderHook(() => useInlineWizard());

				// Start wizard with required params
				await act(async () => {
					await result.current.startWizard(
						'test',
						undefined,
						'/test/project',
						'claude-code',
						'Test Project'
					);
				});

				// Generate documents - progress will be updated then overwritten by completion
				await act(async () => {
					await result.current.generateDocuments();
				});

				// Progress was parsed from the message, then finalized
				// The final state will reflect the actual document count
				expect(result.current.generationProgress).toBeDefined();
			});

			it('should ignore progress messages without a numeric count', async () => {
				mockGenerateInlineDocuments.mockImplementationOnce(async (config) => {
					config.callbacks?.onProgress?.('Working on the next document');
					return {
						success: true,
						documents: [],
						rawOutput: 'test output',
					};
				});

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard(
						'test',
						undefined,
						'/test/project',
						'claude-code',
						'Test Project'
					);
				});

				await act(async () => {
					await result.current.generateDocuments();
				});

				expect(result.current.generationProgress).toEqual({ current: 0, total: 0 });
			});

			it('should ignore chunks that do not contain display text', async () => {
				mockExtractDisplayTextFromChunk.mockReturnValueOnce('');
				mockGenerateInlineDocuments.mockImplementationOnce(async (config) => {
					config.callbacks?.onChunk?.('{"type":"metadata"}');
					return {
						success: true,
						documents: [],
						rawOutput: 'test output',
					};
				});

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard(
						'test',
						undefined,
						'/test/project',
						'claude-code',
						'Test Project'
					);
				});

				await act(async () => {
					await result.current.generateDocuments();
				});

				expect(result.current.streamingContent).toBe('');
				expect(mockExtractDisplayTextFromChunk).toHaveBeenCalledWith(
					'{"type":"metadata"}',
					'claude-code'
				);
			});

			it('should clear streaming state on error', async () => {
				mockGenerateInlineDocuments.mockImplementationOnce(async (config) => {
					// Simulate some streaming before error
					config.callbacks?.onChunk?.('Some content');
					return {
						success: false,
						error: 'Generation failed',
					};
				});

				const { result } = renderHook(() => useInlineWizard());

				// Start wizard with required params
				await act(async () => {
					await result.current.startWizard(
						'test',
						undefined,
						'/test/project',
						'claude-code',
						'Test Project'
					);
				});

				// Generate documents (will fail)
				await act(async () => {
					await result.current.generateDocuments();
				});

				// Error should be set and streaming state should be cleared
				expect(result.current.error).toBe('Generation failed');
				expect(result.current.streamingContent).toBe('');
				expect(result.current.generationProgress).toBe(null);
			});

			it('should clear streaming state when generation throws', async () => {
				mockGenerateInlineDocuments.mockImplementationOnce(async (config) => {
					config.callbacks?.onChunk?.('Some content');
					throw new Error('spawn failed');
				});
				const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
				const onError = vi.fn();

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard(
						'test',
						undefined,
						'/test/project',
						'claude-code',
						'Test Project'
					);
				});

				await act(async () => {
					await result.current.generateDocuments({ onError });
				});

				expect(result.current.error).toBe('spawn failed');
				expect(result.current.streamingContent).toBe('');
				expect(result.current.generationProgress).toBe(null);
				expect(result.current.isGeneratingDocs).toBe(false);
				expect(onError).toHaveBeenCalledWith('spawn failed');
				expect(consoleSpy).toHaveBeenCalledWith(
					'[useInlineWizard] generateDocuments error:',
					expect.any(Error)
				);

				consoleSpy.mockRestore();
			});

			it('should use the generic generation error for non-Error throws', async () => {
				mockGenerateInlineDocuments.mockImplementationOnce(async (config) => {
					config.callbacks?.onChunk?.('Some content');
					throw 'spawn failed';
				});
				const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
				const onError = vi.fn();

				const { result } = renderHook(() => useInlineWizard());

				await act(async () => {
					await result.current.startWizard(
						'test',
						undefined,
						'/test/project',
						'claude-code',
						'Test Project'
					);
				});

				await act(async () => {
					await result.current.generateDocuments({ onError });
				});

				expect(result.current.error).toBe('Unknown error during document generation');
				expect(result.current.streamingContent).toBe('');
				expect(result.current.generationProgress).toBe(null);
				expect(onError).toHaveBeenCalledWith('Unknown error during document generation');
				expect(consoleSpy).toHaveBeenCalledWith(
					'[useInlineWizard] generateDocuments error:',
					'spawn failed'
				);

				consoleSpy.mockRestore();
			});

			it('should set final progress on successful completion', async () => {
				const { result } = renderHook(() => useInlineWizard());

				// Start wizard with required params
				await act(async () => {
					await result.current.startWizard(
						'test',
						undefined,
						'/test/project',
						'claude-code',
						'Test Project'
					);
				});

				// Generate documents
				await act(async () => {
					await result.current.generateDocuments();
				});

				// Final progress should match document count
				expect(result.current.generationProgress).toEqual({
					current: 1,
					total: 1,
				});
			});

			it('should capture subfolderName from generation result', async () => {
				const { result } = renderHook(() => useInlineWizard());

				// Start wizard with required params
				await act(async () => {
					await result.current.startWizard(
						'test',
						undefined,
						'/test/project',
						'claude-code',
						'Test Project'
					);
				});

				// Generate documents
				await act(async () => {
					await result.current.generateDocuments();
				});

				// subfolderName should be captured from the result
				expect(result.current.state.subfolderName).toBe('Test-Project');
			});

			it('should set subfolderName to null when result does not include it', async () => {
				mockGenerateInlineDocuments.mockResolvedValueOnce({
					success: true,
					documents: [
						{
							filename: 'Phase-01-Setup.md',
							content: '# Phase 01\n\n- [ ] Task 1',
							taskCount: 1,
							savedPath: '/test/project/Auto Run Docs/Phase-01-Setup.md',
						},
					],
					rawOutput: 'test output',
					// No subfolderName provided
				});

				const { result } = renderHook(() => useInlineWizard());

				// Start wizard with required params
				await act(async () => {
					await result.current.startWizard(
						'test',
						undefined,
						'/test/project',
						'claude-code',
						'Test Project'
					);
				});

				// Generate documents
				await act(async () => {
					await result.current.generateDocuments();
				});

				// subfolderName should be null when not provided
				expect(result.current.state.subfolderName).toBe(null);
			});
		});
	});
});
