/**
 * Tests for inlineWizardDocumentGeneration.ts - SSH Remote Support
 *
 * These tests verify that SSH remote IDs are correctly propagated to file operations
 * during document generation.
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
	},
	autorun: {
		watchFolder: vi.fn().mockResolvedValue({ success: true }),
		unwatchFolder: vi.fn().mockResolvedValue({ success: true }),
		onFileChanged: vi.fn(() => vi.fn()),
		listDocs: vi.fn().mockResolvedValue({ success: true, tree: [] }),
		writeDoc: vi.fn().mockResolvedValue({ success: true }),
	},
};

vi.stubGlobal('window', { maestro: mockMaestro });

// Import after mocking
import { generateInlineDocuments } from '../../../renderer/services/inlineWizardDocumentGeneration';

describe('inlineWizardDocumentGeneration - SSH Remote Support', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should pass sshRemoteId to writeDoc when saving documents', async () => {
		// Setup mock agent
		const mockAgent = {
			id: 'opencode',
			available: true,
			command: 'opencode',
			args: [],
		};
		mockMaestro.agents.get.mockResolvedValue(mockAgent);

		// Mock process spawn to succeed immediately with output
		mockMaestro.process.spawn.mockResolvedValue(undefined);
		mockMaestro.process.onExit.mockImplementation((callback) => {
			setTimeout(() => callback('test-session', 0), 10);
			return vi.fn();
		});

		// Mock generated output
		const mockOutput = `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Test.md
CONTENT:
# Test Phase
- [ ] Task 1
---END DOCUMENT---
`;

		// Mock process data to return output
		mockMaestro.process.onData.mockImplementation((callback) => {
			setTimeout(() => callback('test-session', mockOutput), 5);
			return vi.fn();
		});

		// Start generation with SSH config
		const generationPromise = generateInlineDocuments({
			agentType: 'opencode',
			directoryPath: '/remote/path',
			projectName: 'Test Project',
			conversationHistory: [],
			mode: 'new',
			autoRunFolderPath: '/remote/path/Auto Run Docs',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'test-remote-id',
			},
		});

		await generationPromise;

		// Verify writeDoc was called with sshRemoteId
		expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
			expect.stringContaining('/remote/path/Auto Run Docs'), // folder path
			'Phase-01-Test.md', // filename
			expect.stringContaining('# Test Phase'), // content
			'test-remote-id' // sshRemoteId (CRITICAL CHECK)
		);
	});

	it('should NOT pass sshRemoteId when SSH is disabled', async () => {
		// Setup mock agent
		const mockAgent = {
			id: 'opencode',
			available: true,
			command: 'opencode',
			args: [],
		};
		mockMaestro.agents.get.mockResolvedValue(mockAgent);

		// Mock process spawn/exit
		mockMaestro.process.spawn.mockResolvedValue(undefined);
		mockMaestro.process.onExit.mockImplementation((callback) => {
			setTimeout(() => callback('test-session', 0), 10);
			return vi.fn();
		});

		// Mock output
		const mockOutput = `
---BEGIN DOCUMENT---
FILENAME: Phase-01-Test.md
CONTENT:
# Test
---END DOCUMENT---
`;
		mockMaestro.process.onData.mockImplementation((callback) => {
			setTimeout(() => callback('test-session', mockOutput), 5);
			return vi.fn();
		});

		// Start generation WITHOUT SSH config
		await generateInlineDocuments({
			agentType: 'opencode',
			directoryPath: '/local/path',
			projectName: 'Test Project',
			conversationHistory: [],
			mode: 'new',
			autoRunFolderPath: '/local/path/Auto Run Docs',
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
