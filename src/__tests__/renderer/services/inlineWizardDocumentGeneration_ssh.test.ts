/**
 * Tests for inlineWizardDocumentGeneration.ts - SSH Remote Support
 *
 * These tests verify that SSH remote IDs are correctly propagated to file operations
 * during document generation.
 *
 * Key mock strategy: The function generates a dynamic session ID internally
 * (`inline-wizard-gen-${Date.now()}-...`), so we capture it from the spawn call
 * and use it when firing onData/onExit callbacks to match the internal guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captured callbacks from onData/onExit registration
let capturedDataCallback: ((sessionId: string, data: string) => void) | null = null;
let capturedExitCallback: ((sessionId: string, code: number) => void) | null = null;

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
	beforeEach(() => {
		vi.clearAllMocks();
		capturedDataCallback = null;
		capturedExitCallback = null;
	});

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
			autoRunFolderPath: '/remote/path/Auto Run Docs',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'test-remote-id',
			},
		});

		// Verify writeDoc was called with sshRemoteId
		expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
			expect.stringContaining('/remote/path/Auto Run Docs'), // folder path
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
