/**
 * Tests for inlineWizardDocumentGeneration.ts - Playbook defaults
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_AUTORUN_SKILLS } from '../../../shared/playbookDag';

let capturedDataCallback: ((sessionId: string, data: string) => void) | null = null;
let capturedExitCallback: ((sessionId: string, code: number) => void) | null = null;

const mockMaestro = {
	agents: {
		get: vi.fn(),
	},
	process: {
		spawn: vi.fn(),
		onData: vi.fn((callback: (sessionId: string, data: string) => void) => {
			capturedDataCallback = callback;
			return vi.fn();
		}),
		onExit: vi.fn((callback: (sessionId: string, code: number) => void) => {
			capturedExitCallback = callback;
			return vi.fn();
		}),
		kill: vi.fn().mockResolvedValue(undefined),
	},
	autorun: {
		watchFolder: vi.fn().mockResolvedValue({ success: true }),
		unwatchFolder: vi.fn().mockResolvedValue({ success: true }),
		onFileChanged: vi.fn(() => vi.fn()),
		listDocs: vi.fn().mockResolvedValue({ success: true, tree: [] }),
		writeDoc: vi.fn().mockResolvedValue({ success: true }),
	},
	playbooks: {
		create: vi.fn().mockResolvedValue({
			success: true,
			playbook: { id: 'playbook-123', name: 'Token Efficiency' },
		}),
	},
};

vi.stubGlobal('window', { maestro: mockMaestro });

import { generateInlineDocuments } from '../../../renderer/services/inlineWizardDocumentGeneration';

describe('inlineWizardDocumentGeneration - Playbook defaults', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		capturedDataCallback = null;
		capturedExitCallback = null;
	});

	it('should create wizard playbooks with compact Auto Run defaults', async () => {
		mockMaestro.agents.get.mockResolvedValue({
			id: 'opencode',
			available: true,
			command: 'opencode',
			args: [],
		});
		mockMaestro.process.spawn.mockResolvedValue(undefined);

		const generationPromise = generateInlineDocuments({
			agentType: 'opencode',
			directoryPath: '/test/project',
			projectName: 'Token Efficiency',
			conversationHistory: [],
			mode: 'new',
			autoRunFolderPath: '/test/project/Auto Run Docs',
			sessionId: 'session-123',
		});

		await new Promise((resolve) => setTimeout(resolve, 10));

		const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];
		expect(spawnCall).toBeDefined();
		expect(capturedDataCallback).not.toBeNull();
		expect(capturedExitCallback).not.toBeNull();

		capturedDataCallback?.(
			spawnCall.sessionId,
			[
				'---BEGIN DOCUMENT---',
				'FILENAME: Phase-01-Implementation.md',
				'CONTENT:',
				'# Phase 01',
				'',
				'- [ ] Add compact profile support',
				'---END DOCUMENT---',
			].join('\n')
		);
		capturedExitCallback?.(spawnCall.sessionId, 0);

		const result = await generationPromise;

		expect(result.success).toBe(true);
		expect(mockMaestro.playbooks.create).toHaveBeenCalledWith(
			'session-123',
			expect.objectContaining({
				name: 'Token Efficiency',
				taskTimeoutMs: 60000,
				prompt: '',
				skills: [...DEFAULT_AUTORUN_SKILLS],
				definitionOfDone: [],
				verificationSteps: [],
				promptProfile: 'compact-code',
				documentContextMode: 'active-task-only',
				skillPromptMode: 'brief',
				agentStrategy: 'single',
			})
		);
	});
});
