import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';

const registeredHandlers = new Map<string, Function>();
const mockProcessManager = {
	write: vi.fn(),
};

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: Function) => {
			registeredHandlers.set(channel, handler);
		}),
	},
	app: {
		isPackaged: false,
		getAppPath: () => '/mock/app',
		getVersion: () => '0.15.3',
		getPath: () => '/mock/userData',
	},
}));

vi.mock('fs/promises', () => {
	const mock = {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		unlink: vi.fn(),
		mkdir: vi.fn(),
		rename: vi.fn(),
	};
	// Provide both default (feedback.ts) and named (atomic-json-store) shapes,
	// sharing the same vi.fn instances so assertions see every write.
	return { ...mock, default: mock };
});

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../../main/utils/cliDetection', () => ({
	isGhInstalled: vi.fn(),
	setCachedGhStatus: vi.fn(),
	getCachedGhStatus: vi.fn(),
	getExpandedEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
}));

vi.mock('../../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

vi.mock('../../../../main/process-manager/utils/imageUtils', () => ({
	saveImageToTempFile: vi.fn(),
	buildImagePromptPrefix: vi.fn((paths: string[]) =>
		paths.length > 0 ? `[Attached images: ${paths.join(', ')}]\n\n` : ''
	),
	cleanupTempFiles: vi.fn(),
}));

import fs from 'fs/promises';
import {
	getCachedGhStatus,
	isGhInstalled,
	setCachedGhStatus,
} from '../../../../main/utils/cliDetection';
import { execFileNoThrow } from '../../../../main/utils/execFile';
import {
	cleanupTempFiles,
	saveImageToTempFile,
} from '../../../../main/process-manager/utils/imageUtils';
import { registerFeedbackHandlers } from '../../../../main/ipc/handlers/feedback';

describe('feedback handlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers.clear();
		mockProcessManager.write.mockReset();
		registerFeedbackHandlers({
			getProcessManager: () => mockProcessManager as any,
		});
	});

	it('registers feedback handlers', () => {
		expect(ipcMain.handle).toHaveBeenCalledWith('feedback:check-gh-auth', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('feedback:submit', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('feedback:compose-prompt', expect.any(Function));
	});

	it('returns cached gh auth result when available', async () => {
		vi.mocked(getCachedGhStatus).mockReturnValue({ installed: true, authenticated: true });

		const handler = registeredHandlers.get('feedback:check-gh-auth');
		const result = await handler!({});

		expect(result).toEqual({ authenticated: true });
		expect(isGhInstalled).not.toHaveBeenCalled();
	});

	it('creates a structured bug report issue with uploaded screenshot markdown', async () => {
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'jeffscottward',
				stderr: '',
			} as any)
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: '{}',
				stderr: '',
			} as any)
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: JSON.stringify({
					content: {
						download_url:
							'https://raw.githubusercontent.com/jeffscottward/maestro-feedback-attachments/main/feedback/example-bug.png',
					},
				}),
				stderr: '',
			} as any)
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: '',
				stderr: '',
			} as any)
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'https://github.com/RunMaestro/Maestro/issues/999',
				stderr: '',
			} as any);

		vi.mocked(fs.writeFile).mockResolvedValue(undefined);
		vi.mocked(fs.unlink).mockResolvedValue(undefined);

		const handler = registeredHandlers.get('feedback:submit');
		const result = await handler!(
			{},
			{
				sessionId: 'session-123',
				category: 'bug_report',
				summary: 'Feedback modal crashes',
				expectedBehavior: 'The issue should be created successfully.',
				details: 'The modal closes without creating a GitHub issue.',
				reproductionSteps: '1. Open Maestro\n2. Click Feedback\n3. Click Send Feedback',
				additionalContext: 'Occurs on the first submit attempt.',
				agentProvider: 'codex',
				sshRemoteEnabled: false,
				attachments: [{ name: 'bug.png', dataUrl: 'data:image/png;base64,abc123' }],
			}
		);
		const bodyWriteCall = vi
			.mocked(fs.writeFile)
			.mock.calls.find(([targetPath]) => String(targetPath).includes('maestro-feedback-body-'));
		const writtenBody = String(bodyWriteCall?.[1] ?? '');

		expect(saveImageToTempFile).not.toHaveBeenCalled();
		expect(fs.writeFile).toHaveBeenCalled();
		expect(writtenBody).toContain('## Summary\nFeedback modal crashes');
		expect(writtenBody).toContain('- Maestro version: 0.15.3');
		expect(writtenBody).toContain('- Install source: Dev build');
		expect(writtenBody).toContain('- Agent/provider involved: codex');
		expect(writtenBody).toContain('- SSH remote execution: Disabled');
		expect(writtenBody).toContain(
			'## Steps to Reproduce\n1. Open Maestro\n2. Click Feedback\n3. Click Send Feedback'
		);
		expect(writtenBody).toContain(
			'## Expected Behavior\nThe issue should be created successfully.'
		);
		expect(writtenBody).toContain(
			'## Actual Behavior\nThe modal closes without creating a GitHub issue.'
		);
		expect(writtenBody).toContain('## Additional Context\nOccurs on the first submit attempt.');
		expect(writtenBody).toContain('## Screenshots / Recordings');
		expect(execFileNoThrow).toHaveBeenLastCalledWith(
			'gh',
			expect.arrayContaining([
				'issue',
				'create',
				'--title',
				'Bug: Feedback modal crashes',
				'--label',
				'Maestro-feedback',
			]),
			undefined,
			{ PATH: '/usr/bin' }
		);
		expect(mockProcessManager.write).not.toHaveBeenCalled();
		expect(result).toEqual({ success: true });
	});

	it('creates a structured feature request issue without screenshots', async () => {
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: '',
				stderr: '',
			} as any)
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'https://github.com/RunMaestro/Maestro/issues/1000',
				stderr: '',
			} as any);

		vi.mocked(fs.writeFile).mockResolvedValue(undefined);
		vi.mocked(fs.unlink).mockResolvedValue(undefined);

		const handler = registeredHandlers.get('feedback:submit');
		const result = await handler!(
			{},
			{
				sessionId: 'session-123',
				category: 'feature_request',
				summary: 'Add a diagnostics copy action',
				expectedBehavior: 'Users should be able to copy a sanitized diagnostics block.',
				details: 'Issue reporting still requires manual environment gathering.',
				agentProvider: 'codex',
				sshRemoteEnabled: true,
			}
		);
		const bodyWriteCall = vi
			.mocked(fs.writeFile)
			.mock.calls.find(([targetPath]) => String(targetPath).includes('maestro-feedback-body-'));
		const writtenBody = String(bodyWriteCall?.[1] ?? '');

		expect(writtenBody).toContain('## Summary\nAdd a diagnostics copy action');
		expect(writtenBody).toContain(
			'## Details\nIssue reporting still requires manual environment gathering.'
		);
		expect(writtenBody).toContain(
			'## Desired Outcome\nUsers should be able to copy a sanitized diagnostics block.'
		);
		expect(writtenBody).toContain('## Screenshots / Recordings\nNot provided.');
		expect(execFileNoThrow).toHaveBeenLastCalledWith(
			'gh',
			expect.arrayContaining(['--title', 'Feature: Add a diagnostics copy action']),
			undefined,
			{ PATH: '/usr/bin' }
		);
		expect(result).toEqual({ success: true });
	});

	it('composes feedback prompts with uploaded screenshot markdown', async () => {
		vi.mocked(fs.readFile).mockResolvedValue(
			'# Feedback\n\n{{FEEDBACK}}\n\n{{ATTACHMENT_CONTEXT}}\n'
		);
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: 'jeffscottward',
				stderr: '',
			} as any)
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: '{}',
				stderr: '',
			} as any)
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: JSON.stringify({
					content: {
						download_url:
							'https://raw.githubusercontent.com/jeffscottward/maestro-feedback-attachments/main/feedback/example-bug.png',
					},
				}),
				stderr: '',
			} as any);

		const handler = registeredHandlers.get('feedback:compose-prompt');
		const result = await handler!(
			{},
			{
				feedbackText: 'Please include the screenshot.',
				attachments: [{ name: 'bug.png', dataUrl: 'data:image/png;base64,abc123' }],
			}
		);

		expect(result.prompt).toContain('Please include the screenshot.');
		expect(result.prompt).toContain(
			'![bug.png](https://raw.githubusercontent.com/jeffscottward/maestro-feedback-attachments/main/feedback/example-bug.png)'
		);
		expect(cleanupTempFiles).not.toHaveBeenCalled();
	});

	describe('feedback:search-issues', () => {
		it('returns empty issues for empty query', async () => {
			const handler = registeredHandlers.get('feedback:search-issues');
			const result = await handler!({}, { query: '' });
			expect(result).toEqual({ issues: [] });
			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('returns empty issues when query has only stop words', async () => {
			const handler = registeredHandlers.get('feedback:search-issues');
			const result = await handler!({}, { query: 'the and or but' });
			expect(result).toEqual({ issues: [] });
			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('extracts keywords and runs parallel searches', async () => {
			const mockIssue = {
				number: 42,
				title: 'Split pane layouts',
				url: 'https://github.com/RunMaestro/Maestro/issues/42',
				state: 'open',
				labels: [{ name: 'feature' }],
				createdAt: '2026-03-01T00:00:00Z',
				author: { login: 'testuser' },
			};

			vi.mocked(execFileNoThrow).mockResolvedValue({
				exitCode: 0,
				stdout: JSON.stringify([mockIssue]),
				stderr: '',
			} as any);

			const handler = registeredHandlers.get('feedback:search-issues');
			const result = await handler!(
				{},
				{ query: 'Tiled tab groups: drag-and-drop split-pane layouts with persistence' }
			);

			// Should have called gh search multiple times (keyword chunks)
			expect(execFileNoThrow).toHaveBeenCalled();
			const calls = vi.mocked(execFileNoThrow).mock.calls;
			for (const call of calls) {
				expect(call[0]).toBe('gh');
				expect(call[1]).toContain('search');
				expect(call[1]).toContain('issues');
				expect(call[1]).toContain('--repo');
				expect(call[1]).toContain('RunMaestro/Maestro');
			}

			// Should return the issue with mapped fields
			expect(result.issues).toHaveLength(1);
			expect(result.issues[0]).toEqual({
				number: 42,
				title: 'Split pane layouts',
				url: 'https://github.com/RunMaestro/Maestro/issues/42',
				state: 'open',
				labels: ['feature'],
				createdAt: '2026-03-01T00:00:00Z',
				author: 'testuser',
				commentCount: 0,
			});
		});

		it('deduplicates issues across multiple search results', async () => {
			const issue1 = {
				number: 10,
				title: 'Issue A',
				url: 'https://github.com/RunMaestro/Maestro/issues/10',
				state: 'open',
				labels: [],
				createdAt: '2026-03-01T00:00:00Z',
				author: { login: 'user1' },
			};
			const issue2 = {
				number: 20,
				title: 'Issue B',
				url: 'https://github.com/RunMaestro/Maestro/issues/20',
				state: 'closed',
				labels: [],
				createdAt: '2026-03-02T00:00:00Z',
				author: { login: 'user2' },
			};

			// First search returns both, second returns issue1 again
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({
					exitCode: 0,
					stdout: JSON.stringify([issue1, issue2]),
					stderr: '',
				} as any)
				.mockResolvedValue({
					exitCode: 0,
					stdout: JSON.stringify([issue1]),
					stderr: '',
				} as any);

			const handler = registeredHandlers.get('feedback:search-issues');
			const result = await handler!(
				{},
				{ query: 'split pane tiling drag drop layouts persistence' }
			);

			const numbers = result.issues.map((i: any) => i.number);
			expect(numbers).toContain(10);
			expect(numbers).toContain(20);
			// No duplicates
			expect(new Set(numbers).size).toBe(numbers.length);
		});

		it('handles gh search failures gracefully', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValue({
				exitCode: 1,
				stdout: '',
				stderr: 'error',
			} as any);

			const handler = registeredHandlers.get('feedback:search-issues');
			const result = await handler!({}, { query: 'split pane layouts' });
			expect(result).toEqual({ issues: [] });
		});

		it('handles invalid JSON from gh gracefully', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValue({
				exitCode: 0,
				stdout: 'not valid json',
				stderr: '',
			} as any);

			const handler = registeredHandlers.get('feedback:search-issues');
			const result = await handler!({}, { query: 'split pane layouts' });
			expect(result).toEqual({ issues: [] });
		});

		it('caps results at 10 issues', async () => {
			const issues = Array.from({ length: 5 }, (_, i) => ({
				number: i + 1,
				title: `Issue ${i + 1}`,
				url: `https://github.com/RunMaestro/Maestro/issues/${i + 1}`,
				state: 'open',
				labels: [],
				createdAt: '2026-03-01T00:00:00Z',
				author: { login: 'user' },
			}));

			// Each search returns 5 unique issues — with enough chunks this could exceed 10
			let callCount = 0;
			vi.mocked(execFileNoThrow).mockImplementation(async () => {
				const batch = issues.map((iss) => ({
					...iss,
					number: iss.number + callCount * 5,
					title: `Issue ${iss.number + callCount * 5}`,
				}));
				callCount++;
				return { exitCode: 0, stdout: JSON.stringify(batch), stderr: '' } as any;
			});

			const handler = registeredHandlers.get('feedback:search-issues');
			const result = await handler!(
				{},
				{ query: 'alpha bravo charlie delta echo foxtrot golf hotel india juliet' }
			);

			expect(result.issues.length).toBeLessThanOrEqual(10);
		});
	});

	it('revalidates gh auth when cache is empty', async () => {
		vi.mocked(getCachedGhStatus).mockReturnValue(null);
		vi.mocked(isGhInstalled).mockResolvedValue(true);
		vi.mocked(execFileNoThrow).mockResolvedValue({
			exitCode: 0,
			stdout: '',
			stderr: '',
		} as any);

		const handler = registeredHandlers.get('feedback:check-gh-auth');
		const result = await handler!({});

		expect(execFileNoThrow).toHaveBeenCalledWith('gh', ['auth', 'status'], undefined, {
			PATH: '/usr/bin',
		});
		expect(setCachedGhStatus).toHaveBeenCalledWith(true, true);
		expect(result).toEqual({ authenticated: true });
	});
});

describe('feedback drafts handlers', () => {
	const sampleDraft = {
		id: 'draft-1',
		suggestedName: 'App crashes on save',
		category: 'bug_report' as const,
		summary: 'App crashes on save',
		confidence: 80,
		agentType: 'claude-code',
		messages: [{ role: 'user' as const, content: 'It crashes when I save', timestamp: 1000 }],
		attachments: [
			{ id: 'a1', name: 'shot.png', dataUrl: 'data:image/png;base64,abc123', sizeBytes: 42 },
		],
		inputDraft: 'more details to add',
		includeDebugPackage: false,
		createdAt: 1000,
		updatedAt: 1000,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers.clear();
		registerFeedbackHandlers({
			getProcessManager: () => mockProcessManager as any,
		});
	});

	it('registers the drafts list/save/delete handlers', () => {
		expect(ipcMain.handle).toHaveBeenCalledWith('feedback:drafts:list', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('feedback:drafts:save', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('feedback:drafts:delete', expect.any(Function));
	});

	it('returns an empty list when the drafts file is missing', async () => {
		vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

		const handler = registeredHandlers.get('feedback:drafts:list');
		const result = await handler!({});

		expect(result).toEqual({ drafts: [] });
	});

	it('lists drafts sorted by updatedAt descending', async () => {
		vi.mocked(fs.readFile).mockResolvedValue(
			JSON.stringify({
				drafts: [
					{ ...sampleDraft, id: 'older', updatedAt: 100 },
					{ ...sampleDraft, id: 'newer', updatedAt: 900 },
				],
			}) as any
		);

		const handler = registeredHandlers.get('feedback:drafts:list');
		const result = await handler!({});

		expect(result.drafts.map((d: { id: string }) => d.id)).toEqual(['newer', 'older']);
	});

	it('saves a new draft and writes it with timestamps', async () => {
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ drafts: [] }) as any);
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);

		const handler = registeredHandlers.get('feedback:drafts:save');
		const result = await handler!({}, sampleDraft);

		expect(result.draft.id).toBe('draft-1');
		expect(result.draft.updatedAt).toBeGreaterThan(0);

		const writeCall = vi
			.mocked(fs.writeFile)
			.mock.calls.find(([p]) => String(p).includes('feedback-drafts.json'));
		expect(writeCall).toBeDefined();
		const written = JSON.parse(String(writeCall?.[1]));
		expect(written.drafts).toHaveLength(1);
		expect(written.drafts[0].id).toBe('draft-1');
		expect(written.drafts[0].suggestedName).toBe('App crashes on save');
		expect(written.drafts[0].attachments).toHaveLength(1);
	});

	it('upserts an existing draft instead of duplicating it', async () => {
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ drafts: [sampleDraft] }) as any);
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);

		const handler = registeredHandlers.get('feedback:drafts:save');
		await handler!({}, { ...sampleDraft, summary: 'Updated summary' });

		const writeCall = vi
			.mocked(fs.writeFile)
			.mock.calls.find(([p]) => String(p).includes('feedback-drafts.json'));
		const written = JSON.parse(String(writeCall?.[1]));
		expect(written.drafts).toHaveLength(1);
		expect(written.drafts[0].id).toBe('draft-1');
		expect(written.drafts[0].summary).toBe('Updated summary');
		expect(written.drafts[0].createdAt).toBe(1000);
	});

	it('deletes a draft by id and writes the remaining list', async () => {
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ drafts: [sampleDraft] }) as any);
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);

		const handler = registeredHandlers.get('feedback:drafts:delete');
		const result = await handler!({}, { id: 'draft-1' });

		expect(result).toEqual({});
		const writeCall = vi
			.mocked(fs.writeFile)
			.mock.calls.find(([p]) => String(p).includes('feedback-drafts.json'));
		const written = JSON.parse(String(writeCall?.[1]));
		expect(written.drafts).toEqual([]);
	});

	it('persists and clamps the submit-ready response on save', async () => {
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ drafts: [] }) as any);
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);
		vi.mocked(fs.rename).mockResolvedValue(undefined);

		const handler = registeredHandlers.get('feedback:drafts:save');
		const result = await handler!(
			{},
			{
				...sampleDraft,
				lastResponse: {
					confidence: 95,
					ready: true,
					message: 'Looks good',
					category: 'bug_report',
					summary: 'Crash on save',
					structured: {
						expectedBehavior: 'no crash',
						actualBehavior: 'crash',
						reproductionSteps: 'save',
						additionalContext: '',
					},
				},
			}
		);

		expect(result.draft.lastResponse?.ready).toBe(true);
		expect(result.draft.lastResponse?.structured.expectedBehavior).toBe('no crash');

		const writeCall = vi
			.mocked(fs.writeFile)
			.mock.calls.find(([p]) => String(p).includes('feedback-drafts.json'));
		const written = JSON.parse(String(writeCall?.[1]));
		expect(written.drafts[0].lastResponse.ready).toBe(true);
		expect(written.drafts[0].lastResponse.structured.actualBehavior).toBe('crash');
	});

	it('normalizes a malformed lastResponse to null', async () => {
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ drafts: [] }) as any);
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);
		vi.mocked(fs.rename).mockResolvedValue(undefined);

		const handler = registeredHandlers.get('feedback:drafts:save');
		const result = await handler!({}, { ...sampleDraft, lastResponse: 'not-an-object' });

		expect(result.draft.lastResponse).toBeNull();
	});

	it('serializes overlapping saves so neither draft is lost (read-modify-write race)', async () => {
		// Back the mocked fs with an in-memory file so an unserialized
		// read-modify-write would clobber: both saves would read the empty base
		// and the later write would drop the earlier draft.
		const norm = (p: unknown): string => String(p).replace(/\\/g, '/');
		const draftsFile = '/mock/userData/feedback-drafts.json';
		const files = new Map<string, string>([[draftsFile, JSON.stringify({ drafts: [] })]]);
		const tmps = new Map<string, string>();
		vi.mocked(fs.mkdir).mockResolvedValue(undefined as any);
		vi.mocked(fs.readFile).mockImplementation(async (p: any) => {
			await new Promise((r) => setTimeout(r, 0));
			const content = files.get(norm(p));
			if (content === undefined) throw new Error('ENOENT');
			return content as any;
		});
		vi.mocked(fs.writeFile).mockImplementation(async (p: any, data: any) => {
			await new Promise((r) => setTimeout(r, 0));
			tmps.set(norm(p), String(data));
			return undefined as any;
		});
		vi.mocked(fs.rename).mockImplementation(async (from: any, to: any) => {
			const content = tmps.get(norm(from));
			if (content !== undefined) files.set(norm(to), content);
			tmps.delete(norm(from));
			return undefined as any;
		});

		const save = registeredHandlers.get('feedback:drafts:save');
		await Promise.all([
			save!({}, { ...sampleDraft, id: 'first' }),
			save!({}, { ...sampleDraft, id: 'second' }),
		]);

		const ids = JSON.parse(String(files.get(draftsFile)))
			.drafts.map((d: { id: string }) => d.id)
			.sort();
		expect(ids).toEqual(['first', 'second']);
	});

	it('keeps the newest messages when trimming beyond the cap', async () => {
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ drafts: [] }) as any);
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);
		vi.mocked(fs.rename).mockResolvedValue(undefined);

		// 205 messages: only the last 200 (MAX_DRAFT_MESSAGES) survive, and they
		// must be the newest ones, not the oldest. Trimming from the front would
		// drop a user's most recent exchange on resume.
		const messages = Array.from({ length: 205 }, (_, i) => ({
			role: 'user' as const,
			content: `msg-${i}`,
			timestamp: 1000 + i,
		}));

		const handler = registeredHandlers.get('feedback:drafts:save');
		const result = await handler!({}, { ...sampleDraft, messages });

		expect(result.draft.messages).toHaveLength(200);
		// Oldest five (msg-0..msg-4) dropped; newest message survives at the end.
		expect(result.draft.messages[0].content).toBe('msg-5');
		expect(result.draft.messages[199].content).toBe('msg-204');
	});

	it('preserves long unsent composer input up to the draft message cap', async () => {
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ drafts: [] }) as any);
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);
		vi.mocked(fs.rename).mockResolvedValue(undefined);

		const handler = registeredHandlers.get('feedback:drafts:save');

		// 8000 chars exceeds the 5000 field cap but fits the 20000 message cap:
		// composer text in that range must survive a save/resume round-trip
		// instead of being silently truncated to the field limit.
		const longInput = 'a'.repeat(8000);
		const result = await handler!({}, { ...sampleDraft, inputDraft: longInput });
		expect(result.draft.inputDraft).toHaveLength(8000);

		// Beyond the message cap it is still clamped to MAX_DRAFT_MESSAGE_LENGTH.
		const hugeInput = 'a'.repeat(25000);
		const clamped = await handler!({}, { ...sampleDraft, inputDraft: hugeInput });
		expect(clamped.draft.inputDraft).toHaveLength(20000);
	});

	const sampleIssue = {
		number: 101,
		url: 'https://github.com/RunMaestro/Maestro/issues/101',
		title: 'Bug: Feedback modal crashes',
		category: 'bug_report' as const,
		submittedAt: 1000,
		state: 'open' as const,
		lastCheckedAt: 1000,
	};

	it('registers the submitted-issue history handlers', () => {
		expect(ipcMain.handle).toHaveBeenCalledWith('feedback:issues:list', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith('feedback:issues:delete', expect.any(Function));
		expect(ipcMain.handle).toHaveBeenCalledWith(
			'feedback:issues:refresh-states',
			expect.any(Function)
		);
	});

	it('returns an empty issue history when the file is missing', async () => {
		vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

		const handler = registeredHandlers.get('feedback:issues:list');
		const result = await handler!({});

		expect(result).toEqual({ issues: [] });
	});

	it('lists submitted issues sorted by submittedAt descending', async () => {
		vi.mocked(fs.readFile).mockResolvedValue(
			JSON.stringify({
				issues: [
					{ ...sampleIssue, number: 1, submittedAt: 100 },
					{ ...sampleIssue, number: 2, submittedAt: 900 },
				],
			}) as any
		);

		const handler = registeredHandlers.get('feedback:issues:list');
		const result = await handler!({});

		expect(result.issues.map((i: { number: number }) => i.number)).toEqual([2, 1]);
	});

	it('deletes a submitted issue by number and writes the remaining list', async () => {
		vi.mocked(fs.readFile).mockResolvedValue(
			JSON.stringify({ issues: [sampleIssue, { ...sampleIssue, number: 202 }] }) as any
		);
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);
		vi.mocked(fs.rename).mockResolvedValue(undefined);

		const handler = registeredHandlers.get('feedback:issues:delete');
		const result = await handler!({}, { number: 101 });

		expect(result).toEqual({});
		const writeCall = vi
			.mocked(fs.writeFile)
			.mock.calls.find(([p]) => String(p).includes('feedback-submitted-issues.json'));
		const written = JSON.parse(String(writeCall?.[1]));
		expect(written.issues.map((i: { number: number }) => i.number)).toEqual([202]);
	});

	it('refresh-states updates open/closed from a gh GraphQL response', async () => {
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ issues: [sampleIssue] }) as any);
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);
		vi.mocked(fs.rename).mockResolvedValue(undefined);
		vi.mocked(execFileNoThrow).mockResolvedValue({
			exitCode: 0,
			stdout: JSON.stringify({ data: { repository: { i101: { number: 101, state: 'CLOSED' } } } }),
			stderr: '',
		} as any);

		const handler = registeredHandlers.get('feedback:issues:refresh-states');
		const result = await handler!({});

		expect(result.issues[0].state).toBe('closed');
		const writeCall = vi
			.mocked(fs.writeFile)
			.mock.calls.find(([p]) => String(p).includes('feedback-submitted-issues.json'));
		const written = JSON.parse(String(writeCall?.[1]));
		expect(written.issues[0].state).toBe('closed');
	});

	it('refresh-states returns the cached list unchanged when gh fails', async () => {
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ issues: [sampleIssue] }) as any);
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);
		vi.mocked(execFileNoThrow).mockResolvedValue({
			exitCode: 1,
			stdout: '',
			stderr: 'gh: not authenticated',
		} as any);

		const handler = registeredHandlers.get('feedback:issues:refresh-states');
		const result = await handler!({});

		expect(result.issues[0].state).toBe('open');
		// No persistence when the refresh could not resolve any state.
		const writeCall = vi
			.mocked(fs.writeFile)
			.mock.calls.find(([p]) => String(p).includes('feedback-submitted-issues.json'));
		expect(writeCall).toBeUndefined();
	});

	it('records a submitted issue after a successful submit', async () => {
		// The issue-history file starts empty; the submit path appends to it.
		vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ issues: [] }) as any);
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);
		vi.mocked(fs.unlink).mockResolvedValue(undefined);
		vi.mocked(fs.rename).mockResolvedValue(undefined);
		// Args-aware so the test does not depend on the exact pre-create gh call
		// count: the issue-create call returns the URL, everything else succeeds.
		vi.mocked(execFileNoThrow).mockImplementation((_cmd: any, args: any) => {
			const argv: string[] = Array.isArray(args) ? args : [];
			if (argv.includes('issue') && argv.includes('create')) {
				return Promise.resolve({
					exitCode: 0,
					stdout: 'https://github.com/RunMaestro/Maestro/issues/456',
					stderr: '',
				} as any);
			}
			return Promise.resolve({ exitCode: 0, stdout: '{}', stderr: '' } as any);
		});

		const handler = registeredHandlers.get('feedback:submit');
		const result = await handler!(
			{},
			{
				sessionId: 'session-1',
				category: 'bug_report',
				summary: 'Something broke',
				expectedBehavior: 'It should work.',
				details: 'It did not work.',
				reproductionSteps: '1. Do the thing\n2. Watch it break',
			}
		);

		expect(result.success).toBe(true);
		const writeCall = vi
			.mocked(fs.writeFile)
			.mock.calls.find(([p]) => String(p).includes('feedback-submitted-issues.json'));
		expect(writeCall).toBeDefined();
		const written = JSON.parse(String(writeCall?.[1]));
		expect(written.issues).toHaveLength(1);
		expect(written.issues[0].number).toBe(456);
		expect(written.issues[0].state).toBe('open');
		expect(written.issues[0].url).toBe('https://github.com/RunMaestro/Maestro/issues/456');
	});
});
