/**
 * Tests for useInlineWizard hook - Session Overrides
 *
 * Tests that session overrides are correctly passed through the hook state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInlineWizard } from '../../../renderer/hooks/batch/useInlineWizard';

// Mock dependencies
vi.mock('../../../renderer/services/wizardIntentParser', () => ({
	parseWizardIntent: vi.fn(),
}));

vi.mock('../../../renderer/utils/existingDocsDetector', () => ({
	hasExistingAutoRunDocs: vi.fn(),
	getExistingAutoRunDocs: vi.fn(),
	getAutoRunFolderPath: vi.fn((projectPath: string) => `${projectPath}/Auto Run Docs`),
}));

// Mock inlineWizardConversation service
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
	generateInlineDocuments: vi.fn().mockResolvedValue({ success: true, documents: [] }),
	extractDisplayTextFromChunk: vi.fn((chunk) => chunk),
}));

// Mock window.maestro
Object.defineProperty(window, 'maestro', {
	value: {
		agents: {
			get: vi.fn().mockResolvedValue({
				id: 'claude-code',
				available: true,
				path: '/bin/claude',
			}),
		},
		autorun: {
			listDocs: vi.fn().mockResolvedValue({ success: true, files: [] }),
		},
	},
	writable: true,
});

import { startInlineWizardConversation } from '../../../renderer/services/inlineWizardConversation';
import { parseWizardIntent } from '../../../renderer/services/wizardIntentParser';

const mockStartConversation = vi.mocked(startInlineWizardConversation);
const mockParseWizardIntent = vi.mocked(parseWizardIntent);

describe('useInlineWizard - Session Overrides', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockParseWizardIntent.mockReturnValue({ mode: 'new' });
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('should store session overrides in state', async () => {
		const { result } = renderHook(() => useInlineWizard());

		const overrides = {
			customPath: '/custom/path',
			customArgs: '--arg',
			customEnvVars: { KEY: 'VAL' },
			customModel: 'model-x',
		};

		await act(async () => {
			await result.current.startWizard(
				'test',
				undefined,
				'/test/project',
				'claude-code',
				'Test Project',
				'tab-1',
				'session-1',
				'/autorun',
				undefined,
				undefined,
				overrides
			);
		});

		// Check internal state (accessible via getStateForTab or direct state access if exposed)
		// Since we can't easily access internal state directly, we verify via startConversation call
		// which happens during startWizard for 'new' mode (default mock intent)

		expect(mockStartConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionCustomPath: '/custom/path',
				sessionCustomArgs: '--arg',
				sessionCustomEnvVars: { KEY: 'VAL' },
				sessionCustomModel: 'model-x',
			})
		);
	});

	it('should pass overrides when transitioning modes', async () => {
		const { result } = renderHook(() => useInlineWizard());

		// Setup: ask mode initially (no session created yet)
		// We need existing docs for ask mode
		const mockListDocs = vi.fn().mockResolvedValue({
			success: true,
			files: ['doc1.md'],
		});
		window.maestro.autorun.listDocs = mockListDocs;
		mockParseWizardIntent.mockReturnValue({ mode: 'ask' });

		const overrides = {
			customPath: '/delayed/path',
		};

		// Start in ask mode
		await act(async () => {
			await result.current.startWizard(
				'test',
				undefined,
				'/test/project',
				'claude-code',
				'Test Project',
				'tab-1',
				'session-1',
				'/autorun',
				undefined,
				undefined,
				overrides
			);
		});

		// Verify session NOT created yet
		expect(mockStartConversation).not.toHaveBeenCalled();

		// Transition to new mode (should trigger session creation)
		await act(async () => {
			result.current.setMode('new');
		});

		// Verify session created with stored overrides
		expect(mockStartConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: 'new',
				sessionCustomPath: '/delayed/path',
			})
		);
	});
});
