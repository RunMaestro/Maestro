import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackRendererLiveState } from '../../../shared/feedbackLiveState';
import {
	formatLiveDiagnosisForIssue,
	formatLiveDiagnosisForPrompt,
} from '../../../shared/feedbackLiveState';

const windows: Array<{
	isDestroyed: () => boolean;
	webContents: { isDestroyed: () => boolean; executeJavaScript: ReturnType<typeof vi.fn> };
}> = [];

vi.mock('electron', () => ({
	BrowserWindow: { getAllWindows: () => windows },
}));

const logs: Array<{ timestamp: number; level: string; message: string; context?: string }> = [];
vi.mock('../../../main/utils/logger', () => ({
	logger: { getLogs: () => logs, warn: vi.fn() },
}));

import { captureFeedbackLiveDiagnosis } from '../../../main/feedback/live-state';

function windowReturning(state: unknown) {
	return {
		isDestroyed: () => false,
		webContents: {
			isDestroyed: () => false,
			executeJavaScript: vi.fn(() => Promise.resolve(state)),
		},
	};
}

const limitPaused: FeedbackRendererLiveState = {
	capturedAt: 1,
	agentCount: 4,
	agents: [
		{
			id: 'a1',
			name: 'Secret Project',
			provider: 'claude-code',
			state: 'error',
			sshRemote: false,
			queuedMessages: 1,
			error: {
				type: 'rate_limited',
				recoverable: true,
				paused: true,
				limit: true,
				ageMs: 3 * 60 * 60 * 1000,
				limitResetInMs: -60 * 60 * 1000,
				message: 'Limit hit, see /Users/someone/Projects/secret/log.txt',
			},
			autoRun: {
				sessionId: 'a1',
				isRunning: true,
				isStopping: false,
				documentCount: 2,
				currentDocumentIndex: 0,
				currentDocTasksTotal: 5,
				currentDocTasksCompleted: 2,
				totalTasksAcrossAllDocs: 10,
				completedTasksAcrossAllDocs: 2,
				loopEnabled: false,
				loopIteration: 0,
				worktreeActive: false,
				hasError: true,
				errorType: 'rate_limited',
				errorPaused: true,
			},
		},
	],
	autoRunSnapshots: [],
	settings: { autoResumeOnLimit: true, autoResumeCheckIntervalHours: 2, autoResumeGiveUpDays: 7 },
};

describe('captureFeedbackLiveDiagnosis', () => {
	beforeEach(() => {
		windows.length = 0;
		logs.length = 0;
	});

	it('reports the renderer as unavailable when no window answers', async () => {
		windows.push(windowReturning(null));
		const diagnosis = await captureFeedbackLiveDiagnosis();
		expect(diagnosis.rendererAvailable).toBe(false);
		expect(formatLiveDiagnosisForPrompt(diagnosis)).toMatch(/not available/i);
		expect(formatLiveDiagnosisForIssue(diagnosis)).toBe('');
	});

	it('merges windows, dedupes agents, and redacts the error message', async () => {
		windows.push(windowReturning(limitPaused), windowReturning(limitPaused));
		const diagnosis = await captureFeedbackLiveDiagnosis();
		expect(diagnosis.rendererAvailable).toBe(true);
		expect(diagnosis.agents).toHaveLength(1);
		expect(diagnosis.agentCount).toBe(4);
		expect(diagnosis.agents[0].error?.message).not.toContain('/Users/someone');
	});

	it('keeps only recent warnings and errors from the log', async () => {
		const now = Date.now();
		logs.push(
			{ timestamp: now - 1000, level: 'info', message: 'noise' },
			{ timestamp: now - 1000, level: 'error', message: 'Renderer console error: boom' },
			{ timestamp: now - 3 * 24 * 60 * 60 * 1000, level: 'error', message: 'ancient' }
		);
		const diagnosis = await captureFeedbackLiveDiagnosis();
		expect(diagnosis.recentProblems.map((l) => l.message)).toEqual([
			'Renderer console error: boom',
		]);
	});

	it('names the agent in the prompt but never in the public issue', async () => {
		windows.push(windowReturning(limitPaused));
		const diagnosis = await captureFeedbackLiveDiagnosis();

		const prompt = formatLiveDiagnosisForPrompt(diagnosis);
		expect(prompt).toContain('"Secret Project"');
		expect(prompt).toContain('PAUSED ON ERROR');
		expect(prompt).toMatch(/reset time passed/);

		const issue = formatLiveDiagnosisForIssue(diagnosis);
		expect(issue).toContain('Agent 1 (claude-code)');
		expect(issue).toContain('error=rate_limited');
		expect(issue).toContain('Auto-resume on limit: on');
		expect(issue).not.toContain('Secret Project');
		expect(issue).not.toContain('Limit hit');
	});
});
