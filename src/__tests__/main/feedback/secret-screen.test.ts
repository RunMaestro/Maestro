/**
 * @file secret-screen.test.ts
 * @description Feedback is published to a public GitHub repo, so every way of
 * filing it screens for secrets first. A finding refuses the whole submit
 * BEFORE any upload (no screenshots, no package, no issue, no +1), and only an
 * explicit `allowSecrets` files it as written.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
	app: {
		isPackaged: false,
		getAppPath: () => '/mock/app',
		getVersion: () => '0.15.3',
		getPath: (name: string) => `/mock/${name}`,
	},
}));

vi.mock('fs/promises', () => {
	const mock = {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		unlink: vi.fn(),
		mkdir: vi.fn(),
		rename: vi.fn(),
		access: vi.fn(),
		readdir: vi.fn(),
	};
	return { ...mock, default: mock };
});

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/prompt-manager', () => ({
	getPrompt: vi.fn(() => ''),
}));

vi.mock('../../../main/utils/cliDetection', () => ({
	clearGhCache: vi.fn(),
	isGhInstalled: vi.fn(),
	setCachedGhStatus: vi.fn(),
	getCachedGhStatus: vi.fn(),
	getExpandedEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
	resolveGhPath: vi.fn(async (customPath?: string) => customPath ?? 'gh'),
}));

vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: vi.fn(() => ({ get: vi.fn(() => '') })),
}));

vi.mock('../../../main/stores/instances', () => ({
	isInitialized: vi.fn(() => true),
}));

vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

vi.mock('../../../main/debug-package', () => ({
	generateDebugPackage: vi.fn(),
}));

// The optional model pass is off, the shipped default: patterns decide alone.
vi.mock('../../../main/local-models/task-router', () => ({
	// Asked first: it answers `not-assigned` for any assignment but System One.
	runSystemOneTask: vi.fn(async () => ({ status: 'not-assigned' })),
	runClassifierTask: vi.fn(async () => ({ status: 'off' })),
}));

import fs from 'fs/promises';
import { execFileNoThrow } from '../../../main/utils/execFile';
import { generateDebugPackage } from '../../../main/debug-package';
import {
	submitFeedback,
	submitFeedbackConversation,
	subscribeFeedbackIssue,
} from '../../../main/feedback';

// Assembled at runtime so no token literal sits in the repository.
const ANTHROPIC_KEY = ['sk', 'ant', 'api03', 'Xy7Kq2Lm9P'.repeat(4)].join('-');
const SLACK_TOKEN = ['xoxb', '1234567890', '0987654321', 'AbCdEfGhAbCdEfGhAbCdEfGh'].join('-');

const ghOk = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' }) as any;

const conversation = (overrides: Record<string, unknown> = {}) => ({
	category: 'bug_report' as const,
	summary: 'Agent will not start',
	expectedBehavior: 'It starts',
	actualBehavior: 'It exits at once',
	...overrides,
});

const debugDeps = {} as any;

describe('feedback secret screen', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);
		vi.mocked(fs.unlink).mockResolvedValue(undefined);
		vi.mocked(execFileNoThrow).mockResolvedValue(
			ghOk('https://github.com/RunMaestro/Maestro/issues/7\n')
		);
	});

	describe('submitFeedbackConversation', () => {
		it('refuses a field holding a key, and runs no gh command at all', async () => {
			const result = await submitFeedbackConversation(
				conversation({ actualBehavior: `line one\nit logged ${ANTHROPIC_KEY}` })
			);

			expect(result).toEqual({
				success: false,
				error: 'Found 1 possible secret in the feedback. Nothing was sent.',
				code: 'SECRETS_FOUND',
				secretFindings: [
					{
						kind: 'anthropic-key',
						line: 2,
						preview: `••••••••${ANTHROPIC_KEY.slice(-4)}`,
						source: 'Actual',
					},
				],
			});
			expect(JSON.stringify(result)).not.toContain(ANTHROPIC_KEY);
			expect(execFileNoThrow).not.toHaveBeenCalled();
			expect(fs.writeFile).not.toHaveBeenCalled();
		});

		it('names the field each finding is in', async () => {
			const result = await submitFeedbackConversation(
				conversation({
					reproductionSteps: `export KEY=${ANTHROPIC_KEY}`,
					additionalContext: `webhook used ${SLACK_TOKEN}`,
				})
			);

			expect(result.secretFindings?.map((f) => [f.kind, f.source])).toEqual([
				['anthropic-key', 'Steps'],
				['slack-token', 'Context'],
			]);
		});

		it('files the same content when secrets are allowed', async () => {
			const result = await submitFeedbackConversation(
				conversation({ actualBehavior: `it logged ${ANTHROPIC_KEY}`, allowSecrets: true })
			);

			expect(result).toEqual({
				success: true,
				issueUrl: 'https://github.com/RunMaestro/Maestro/issues/7',
			});
			expect(execFileNoThrow).toHaveBeenCalledWith(
				'gh',
				expect.arrayContaining(['issue', 'create']),
				undefined,
				expect.anything()
			);
		});

		it('does not read a truthy non-boolean as consent', async () => {
			const result = await submitFeedbackConversation(
				conversation({ actualBehavior: ANTHROPIC_KEY, allowSecrets: 'true' as any })
			);
			expect(result.code).toBe('SECRETS_FOUND');
			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('files clean feedback without asking', async () => {
			const result = await submitFeedbackConversation(conversation());
			expect(result.success).toBe(true);
			expect(result.secretFindings).toBeUndefined();
		});

		describe('with a support package', () => {
			const packageFinding = {
				kind: 'github-token' as const,
				line: 40,
				preview: '••••••••abcd',
				source: 'logs.json',
			};

			it('refuses when the package holds a secret, before any upload', async () => {
				vi.mocked(generateDebugPackage).mockResolvedValue({
					success: false,
					error: 'Found 1 possible secret in the support package. Nothing was sent.',
					code: 'SECRETS_FOUND',
					secretFindings: [packageFinding],
					filesIncluded: [],
					totalSizeBytes: 0,
				});

				const result = await submitFeedbackConversation(
					conversation({
						includeDebugPackage: true,
						attachments: [{ name: 'a.png', dataUrl: 'data:image/png;base64,abc' }],
					}),
					debugDeps
				);

				expect(result).toMatchObject({
					success: false,
					code: 'SECRETS_FOUND',
					secretFindings: [packageFinding],
				});
				expect(vi.mocked(generateDebugPackage).mock.calls[0][2]).toEqual({ allowSecrets: false });
				// No screenshot upload, no zip upload, no issue.
				expect(execFileNoThrow).not.toHaveBeenCalled();
			});

			it('lists the text findings and the package findings together', async () => {
				vi.mocked(generateDebugPackage).mockResolvedValue({
					success: false,
					code: 'SECRETS_FOUND',
					secretFindings: [packageFinding],
					filesIncluded: [],
					totalSizeBytes: 0,
				});

				const result = await submitFeedbackConversation(
					conversation({ actualBehavior: ANTHROPIC_KEY, includeDebugPackage: true }),
					debugDeps
				);

				expect(result.error).toBe('Found 2 possible secrets in the feedback. Nothing was sent.');
				expect(result.secretFindings?.map((f) => f.source)).toEqual(['Actual', 'logs.json']);
			});

			it('deletes a clean package it built when the text is what gets refused', async () => {
				vi.mocked(generateDebugPackage).mockResolvedValue({
					success: true,
					path: '/tmp/maestro-debug-1.zip',
					filesIncluded: ['logs.json'],
					totalSizeBytes: 10,
				});

				const result = await submitFeedbackConversation(
					conversation({ actualBehavior: ANTHROPIC_KEY, includeDebugPackage: true }),
					debugDeps
				);

				expect(result.code).toBe('SECRETS_FOUND');
				expect(fs.unlink).toHaveBeenCalledWith('/tmp/maestro-debug-1.zip');
				expect(execFileNoThrow).not.toHaveBeenCalled();
			});

			it('hands allowSecrets to the package generator on the confirmed retry', async () => {
				vi.mocked(generateDebugPackage).mockResolvedValue({
					success: true,
					path: '/tmp/maestro-debug-2.zip',
					filesIncluded: ['logs.json'],
					totalSizeBytes: 10,
				});
				vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('zip') as any);
				vi.mocked(execFileNoThrow).mockResolvedValue(
					ghOk('{"login":"octocat","content":{"download_url":"https://example.test/p.zip"}}')
				);

				await submitFeedbackConversation(
					conversation({
						actualBehavior: ANTHROPIC_KEY,
						includeDebugPackage: true,
						allowSecrets: true,
					}),
					debugDeps
				);

				expect(vi.mocked(generateDebugPackage).mock.calls[0][2]).toEqual({ allowSecrets: true });
				expect(execFileNoThrow).toHaveBeenCalled();
				// The temp zip is removed once it has been uploaded.
				expect(fs.unlink).toHaveBeenCalledWith('/tmp/maestro-debug-2.zip');
			});
		});
	});

	describe('submitFeedback (legacy one-shot form)', () => {
		const legacy = (overrides: Record<string, unknown> = {}) => ({
			sessionId: 'session-1',
			category: 'bug_report' as const,
			summary: 'Agent will not start',
			expectedBehavior: 'It starts',
			details: 'It exits at once',
			reproductionSteps: 'Open the app',
			...overrides,
		});

		it('refuses a field holding a key before anything is uploaded', async () => {
			const result = await submitFeedback(legacy({ details: `it logged ${ANTHROPIC_KEY}` }));
			expect(result).toMatchObject({
				success: false,
				code: 'SECRETS_FOUND',
				secretFindings: [expect.objectContaining({ kind: 'anthropic-key', source: 'Actual' })],
			});
			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('files it when secrets are allowed', async () => {
			const result = await submitFeedback(
				legacy({ details: `it logged ${ANTHROPIC_KEY}`, allowSecrets: true })
			);
			expect(result.success).toBe(true);
		});
	});

	describe('subscribeFeedbackIssue', () => {
		it('refuses a comment holding a token before the +1 is added', async () => {
			const result = await subscribeFeedbackIssue({
				issueNumber: 42,
				comment: `same here, my token is ${SLACK_TOKEN}`,
			});

			expect(result).toMatchObject({
				success: false,
				error: 'Found 1 possible secret in the comment. Nothing was sent.',
				code: 'SECRETS_FOUND',
				secretFindings: [expect.objectContaining({ kind: 'slack-token', source: 'Comment' })],
			});
			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('posts the comment when secrets are allowed', async () => {
			const result = await subscribeFeedbackIssue({
				issueNumber: 42,
				comment: `my token is ${SLACK_TOKEN}`,
				allowSecrets: true,
			});

			expect(result).toEqual({ success: true });
			expect(execFileNoThrow).toHaveBeenCalledWith(
				'gh',
				expect.arrayContaining(['issue', 'comment', '42']),
				undefined,
				expect.anything()
			);
		});

		it('adds a +1 with no comment without screening anything', async () => {
			const result = await subscribeFeedbackIssue({ issueNumber: 42 });
			expect(result).toEqual({ success: true });
			expect(execFileNoThrow).toHaveBeenCalledTimes(1);
		});
	});
});
