import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export const MAX_FEEDBACK_GITHUB_CONTENT_BYTES = 1024 * 1024;

export interface FeedbackGitHubContentUpload {
	owner: string;
	repository: string;
	path: string;
	message: string;
	bytes: Uint8Array;
	branch: string;
	sha?: string;
}

export interface GitHubCliResult {
	exitCode: number | string;
	stdout: string;
	stderr: string;
}

export interface FeedbackGitHubContentRequest {
	endpoint: string;
	args: string[];
	body: {
		message: string;
		content: string;
		branch: string;
		sha?: string;
	};
	rawUrl: string;
}

function encodeRepositoryPath(repositoryPath: string): string {
	if (!repositoryPath || repositoryPath.startsWith('/') || repositoryPath.includes('\\')) {
		throw new Error('Feedback upload path is invalid.');
	}

	return repositoryPath
		.split('/')
		.map((segment) => {
			let decoded: string;
			try {
				decoded = decodeURIComponent(segment);
			} catch {
				throw new Error('Feedback upload path contains an invalid segment.');
			}
			if (
				!decoded ||
				decoded === '.' ||
				decoded === '..' ||
				decoded.includes('/') ||
				decoded.includes('\\')
			) {
				throw new Error('Feedback upload path contains an invalid segment.');
			}
			return encodeURIComponent(segment);
		})
		.join('/');
}

function validateUpload(upload: FeedbackGitHubContentUpload): void {
	if (!upload.owner || !upload.repository) {
		throw new Error('Feedback upload repository is invalid.');
	}
	if (!upload.message) {
		throw new Error('Feedback upload commit message is required.');
	}
	if (!upload.branch) {
		throw new Error('Feedback upload branch is required.');
	}
	if (upload.sha !== undefined && !upload.sha) {
		throw new Error('Feedback upload SHA cannot be empty.');
	}
	if (upload.bytes.byteLength > MAX_FEEDBACK_GITHUB_CONTENT_BYTES) {
		throw new Error(
			`Feedback upload exceeds GitHub's ${MAX_FEEDBACK_GITHUB_CONTENT_BYTES}-byte content limit.`
		);
	}
}
function getDownloadUrl(response: unknown): string | undefined {
	if (
		typeof response !== 'object' ||
		response === null ||
		!('content' in response) ||
		typeof response.content !== 'object' ||
		response.content === null ||
		!('download_url' in response.content) ||
		typeof response.content.download_url !== 'string'
	) {
		return undefined;
	}
	return response.content.download_url;
}

export function buildFeedbackGitHubContentRequest(
	upload: FeedbackGitHubContentUpload
): FeedbackGitHubContentRequest {
	validateUpload(upload);
	const encodedPath = encodeRepositoryPath(upload.path);
	const encodedOwner = encodeURIComponent(upload.owner);
	const encodedRepository = encodeURIComponent(upload.repository);
	const endpoint = `repos/${encodedOwner}/${encodedRepository}/contents/${encodedPath}`;
	const body: FeedbackGitHubContentRequest['body'] = {
		message: upload.message,
		content: Buffer.from(upload.bytes).toString('base64'),
		branch: upload.branch,
	};
	if (upload.sha !== undefined) {
		body.sha = upload.sha;
	}

	return {
		endpoint,
		args: [
			'api',
			endpoint,
			'--method',
			'PUT',
			'-H',
			'Accept: application/vnd.github+json',
			'-H',
			'X-GitHub-Api-Version: 2022-11-28',
		],
		body,
		rawUrl: `https://raw.githubusercontent.com/${encodedOwner}/${encodedRepository}/${encodeURIComponent(
			upload.branch
		)}/${encodedPath}`,
	};
}

export async function uploadFeedbackGitHubContent(
	upload: FeedbackGitHubContentUpload,
	execute: (args: string[]) => Promise<GitHubCliResult>
): Promise<{ rawUrl: string }> {
	const request = buildFeedbackGitHubContentRequest(upload);
	const payloadPath = path.join(os.tmpdir(), `maestro-feedback-content-${Date.now()}.json`);
	await fs.writeFile(payloadPath, JSON.stringify(request.body), 'utf8');

	try {
		const result = await execute([...request.args, '--input', payloadPath]);
		if (result.exitCode !== 0) {
			throw new Error(result.stderr || 'Failed to upload feedback content.');
		}

		let response: unknown;
		try {
			response = JSON.parse(result.stdout);
		} catch {
			throw new Error('GitHub returned an invalid content upload response.');
		}
		const downloadUrl = getDownloadUrl(response) ?? request.rawUrl;
		return { rawUrl: downloadUrl };
	} finally {
		await fs.unlink(payloadPath).catch(() => {});
	}
}
