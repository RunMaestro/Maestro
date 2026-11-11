/**
 * Tests for useInlineWizard hook - Session Overrides
 *
 * Tests that session overrides are correctly passed through the hook state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInlineWizard } from '../../../renderer/hooks/batch/useInlineWizard';

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

// Mock dependencies
vi.mock('../../../renderer/services/wizardIntentParser', () => ({
	parseWizardIntent: vi.fn(),
}));

vi.mock('../../../renderer/utils/existingDocsDetector', () => ({
	hasExistingAutoRunDocs: vi.fn(),
	getExistingAutoRunDocs: vi.fn(),
	getAutoRunFolderPath: vi.fn((projectPath: string) => `${projectPath}/.maestro/playbooks`),
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

import {
	startInlineWizardConversation,
	sendWizardMessage,
} from '../../../renderer/services/inlineWizardConversation';
import { hasCapabilityCached } from '../../../renderer/hooks/agent/useAgentCapabilities';
import { parseWizardIntent } from '../../../renderer/services/wizardIntentParser';

const mockStartConversation = vi.mocked(startInlineWizardConversation);
const mockParseWizardIntent = vi.mocked(parseWizardIntent);

describe('useInlineWizard - Session Overrides', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockParseWizardIntent.mockReturnValue({ mode: 'new' });
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: true, files: [] });
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

	it.each([
		['direct', 'account-a', false, 'grok-code-fast-1', 'high'],
		['direct', 'account-b', true, undefined, undefined],
		['select', 'account-b', true, undefined, undefined],
		['select', 'account-a', false, 'grok-code-fast-1', 'high'],
		['message', 'account-a', true, 'grok-code-fast-1', 'low'],
		['message', 'account-b', false, undefined, undefined],
	] as const)(
		'forwards Grok configuration through the %s constructor and replays follow-on history',
		async (entry, account, remote, model, effort) => {
			// Exercise the caller contract behind the still-disabled production capability.
			vi.mocked(hasCapabilityCached).mockReturnValueOnce(true);
			const actual = await vi.importActual<
				typeof import('../../../renderer/services/inlineWizardConversation')
			>('../../../renderer/services/inlineWizardConversation');
			mockStartConversation.mockImplementationOnce(actual.startInlineWizardConversation);
			mockParseWizardIntent.mockReturnValue({ mode: entry === 'direct' ? 'new' : 'ask' });
			const ssh = remote
				? { enabled: true, remoteId: 'test-host', workingDirOverride: '/remote/project' }
				: undefined;
			const overrides = {
				customPath: '/custom/grok',
				customArgs: '--max-turns 4',
				customEnvVars: {
					GROK_HOME: `/fixtures/${account}`,
					GROK_AUTH_PATH: `/fixtures/${account}/auth.json`,
				},
				customModel: model,
				customEffort: effort,
			};
			const original = structuredClone(overrides);
			const { result } = renderHook(() => useInlineWizard());
			await act(async () => {
				await result.current.startWizard(
					'Plan a project',
					undefined,
					'/test/project',
					'grok',
					'Grok Project',
					'grok-tab',
					'grok-agent',
					'/autorun',
					ssh,
					'Profile',
					overrides
				);
			});
			if (entry !== 'direct') expect(mockStartConversation).not.toHaveBeenCalled();
			if (entry === 'select') act(() => result.current.setMode('new'));
			// The service withholds unbound native IDs; callers must not substitute its process ID.
			vi.mocked(sendWizardMessage).mockResolvedValueOnce({
				success: true,
				response: { confidence: 50, ready: false, message: 'Need more detail' },
				rawOutput: '{"session_id":"unbound-native-session"}',
			});
			await act(async () => {
				await result.current.sendMessage('First goal');
			});
			expect(mockStartConversation).toHaveBeenCalledTimes(1);
			const forwarded = {
				agentType: 'grok',
				directoryPath: '/test/project',
				sessionSshRemoteConfig: ssh,
				sessionCustomPath: overrides.customPath,
				sessionCustomArgs: overrides.customArgs,
				sessionCustomEnvVars: original.customEnvVars,
				sessionCustomModel: model,
				sessionCustomEffort: effort,
			};
			expect(mockStartConversation).toHaveBeenCalledWith(expect.objectContaining(forwarded));
			const conversation = mockStartConversation.mock.results[0].value;
			expect(conversation).toEqual(expect.objectContaining(forwarded));
			const history = result.current.conversationHistory;
			expect(history.map(({ role, content }) => ({ role, content }))).toEqual([
				{ role: 'user', content: 'First goal' },
				{ role: 'assistant', content: 'Need more detail' },
			]);
			await act(async () => {
				await result.current.sendMessage('Refine the plan');
			});
			expect(sendWizardMessage).toHaveBeenNthCalledWith(
				2,
				conversation,
				'Refine the plan',
				history,
				undefined
			);
			expect(result.current.agentSessionId).toBeNull();
			expect(conversation.sessionId).not.toBe('unbound-native-session');
			expect(overrides).toEqual(original);
			await act(async () => {
				await result.current.endWizard('grok-tab');
			});
		}
	);
});
