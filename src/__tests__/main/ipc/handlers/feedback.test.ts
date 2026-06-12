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
	},
}));

vi.mock('fs/promises', () => ({
	default: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		unlink: vi.fn(),
	},
}));

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
