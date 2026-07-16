import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import {
	MAX_FEEDBACK_GITHUB_CONTENT_BYTES,
	buildFeedbackGitHubContentRequest,
	uploadFeedbackGitHubContent,
} from '../../../../main/ipc/handlers/feedbackGithubContents';

describe('feedback GitHub contents uploads', () => {
	const tempFiles: string[] = [];

	afterEach(async () => {
		await Promise.all(tempFiles.splice(0).map((file) => fs.unlink(file).catch(() => {})));
	});

	it('builds an encoded create request with the main branch and exact Unicode bytes', () => {
		const request = buildFeedbackGitHubContentRequest({
			owner: 'octo user',
			repository: 'feedback repo',
			path: 'feedback/naïve image.png',
			message: 'Add screenshot',
			bytes: new TextEncoder().encode('こんにちは'),
			branch: 'main',
		});

		expect(request.endpoint).toBe(
			'repos/octo%20user/feedback%20repo/contents/feedback/na%C3%AFve%20image.png'
		);
		expect(request.body).toEqual({
			message: 'Add screenshot',
			content: '44GT44KT44Gr44Gh44Gv',
			branch: 'main',
		});
		expect(request.args.slice(0, 8)).toEqual([
			'api',
			'repos/octo%20user/feedback%20repo/contents/feedback/na%C3%AFve%20image.png',
			'--method',
			'PUT',
			'-H',
			'Accept: application/vnd.github+json',
			'-H',
			'X-GitHub-Api-Version: 2022-11-28',
		]);
	});

	it('includes SHA only for updates and base64-encodes binary bytes without alteration', () => {
		const request = buildFeedbackGitHubContentRequest({
			owner: 'octocat',
			repository: 'attachments',
			path: 'feedback/binary.zip',
			message: 'Replace archive',
			bytes: Uint8Array.from([0, 255, 1, 128, 64]),
			branch: 'release/candidate',
			sha: 'abc123',
		});

		expect(request.body).toEqual({
			message: 'Replace archive',
			content: 'AP8BgEA=',
			branch: 'release/candidate',
			sha: 'abc123',
		});
	});

	it('writes the exact GitHub request body, returns download_url, and removes its temp file', async () => {
		const execute = vi.fn(async (args: string[]) => {
			const inputIndex = args.indexOf('--input');
			const payloadPath = args[inputIndex + 1];
			tempFiles.push(payloadPath);
			expect(JSON.parse(await fs.readFile(payloadPath, 'utf8'))).toEqual({
				message: 'Add archive',
				content: 'AP8BgEA=',
				branch: 'main',
			});
			return {
				exitCode: 0,
				stdout: JSON.stringify({ content: { download_url: 'https://cdn.example/archive.zip' } }),
				stderr: '',
			};
		});

		const result = await uploadFeedbackGitHubContent(
			{
				owner: 'octocat',
				repository: 'attachments',
				path: 'feedback/archive.zip',
				message: 'Add archive',
				bytes: Uint8Array.from([0, 255, 1, 128, 64]),
				branch: 'main',
			},
			execute
		);

		expect(result).toEqual({ rawUrl: 'https://cdn.example/archive.zip' });
		expect(
			await Promise.all(
				tempFiles.map((file) =>
					fs
						.stat(file)
						.then(() => false)
						.catch(() => true)
				)
			)
		).toEqual([true]);
	});

	it('uses the explicit branch in the raw URL fallback and rejects malformed responses', async () => {
		const input = {
			owner: 'octocat',
			repository: 'attachments',
			path: 'feedback/image name.png',
			message: 'Add image',
			bytes: Uint8Array.of(1),
			branch: 'release/candidate',
		};

		await expect(
			uploadFeedbackGitHubContent(input, async () => ({ exitCode: 0, stdout: '{}', stderr: '' }))
		).resolves.toEqual({
			rawUrl:
				'https://raw.githubusercontent.com/octocat/attachments/release%2Fcandidate/feedback/image%20name.png',
		});
		await expect(
			uploadFeedbackGitHubContent(input, async () => ({
				exitCode: 0,
				stdout: 'not-json',
				stderr: '',
			}))
		).rejects.toThrow('GitHub returned an invalid content upload response.');
	});

	it.each([
		['401', 'gh: Bad credentials (HTTP 401)'],
		['403', 'gh: Resource not accessible by integration (HTTP 403)'],
		['404', 'gh: Not Found (HTTP 404)'],
		['409', 'gh: sha does not match (HTTP 409)'],
	])('preserves GitHub %s error envelopes', async (_status, stderr) => {
		await expect(
			uploadFeedbackGitHubContent(
				{
					owner: 'octocat',
					repository: 'attachments',
					path: 'feedback/image.png',
					message: 'Add image',
					bytes: Uint8Array.of(1),
					branch: 'main',
				},
				async () => ({ exitCode: 1, stdout: '', stderr })
			)
		).rejects.toThrow(stderr);
	});

	it('rejects paths that could change the content endpoint and payloads over GitHub limits', () => {
		expect(() =>
			buildFeedbackGitHubContentRequest({
				owner: 'octocat',
				repository: 'attachments',
				path: 'feedback/%2e%2e/secrets.txt',
				message: 'Bad path',
				bytes: Uint8Array.of(1),
				branch: 'main',
			})
		).toThrow('Feedback upload path contains an invalid segment.');
		expect(() =>
			buildFeedbackGitHubContentRequest({
				owner: 'octocat',
				repository: 'attachments',
				path: 'feedback/large.bin',
				message: 'Large payload',
				bytes: new Uint8Array(MAX_FEEDBACK_GITHUB_CONTENT_BYTES + 1),
				branch: 'main',
			})
		).toThrow(
			`Feedback upload exceeds GitHub's ${MAX_FEEDBACK_GITHUB_CONTENT_BYTES}-byte content limit.`
		);
	});
});
