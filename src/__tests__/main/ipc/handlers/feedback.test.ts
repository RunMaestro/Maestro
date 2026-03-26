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
