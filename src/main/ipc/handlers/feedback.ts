/**
 * Feedback IPC Handlers
 *
 * This module handles:
 * - Checking GitHub CLI availability and authentication
 * - Creating structured GitHub issues from in-app feedback
 */

import { ipcMain, app } from 'electron';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { logger } from '../../utils/logger';
import { getPrompt } from '../../prompt-manager';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import {
	isGhInstalled,
	setCachedGhStatus,
	getCachedGhStatus,
	getExpandedEnv,
} from '../../utils/cliDetection';
import { execFileNoThrow } from '../../utils/execFile';
import { generateDebugPackage, type DebugPackageDependencies } from '../../debug-package';
import { captureException } from '../../utils/sentry';

const LOG_CONTEXT = '[Feedback]';
const ATTACHMENTS_REPO = 'maestro-feedback-attachments';
const MAX_SUMMARY_LENGTH = 120;
const MAX_FEEDBACK_FIELD_LENGTH = 5000;

type FeedbackCategory = 'bug_report' | 'feature_request' | 'improvement' | 'general_feedback';

const GH_NOT_INSTALLED_MESSAGE =
	'GitHub CLI (gh) is not installed. Install it from https://cli.github.com';
const GH_NOT_AUTHENTICATED_MESSAGE =
	'GitHub CLI is not authenticated. Run "gh auth login" in your terminal.';

function getPromptPath(): string {
	if (app.isPackaged) {
		return path.join(process.resourcesPath, 'prompts', 'feedback.md');
	}

	return path.join(app.getAppPath(), 'src', 'prompts', 'feedback.md');
}

/**
 * Helper to create handler options with consistent context
 */
const handlerOpts = (
	operation: string,
	extra?: Partial<CreateHandlerOptions>
): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
	...extra,
});

/**
 * Dependencies required for feedback handler registration
 */
export interface FeedbackHandlerDependencies {
	getProcessManager: () => unknown;
	debugPackageDeps?: DebugPackageDependencies;
}

export interface FeedbackAttachmentInput {
	name: string;
	dataUrl: string;
}

interface FeedbackSubmitPayload {
	sessionId: string;
	category: FeedbackCategory;
	summary: string;
	expectedBehavior: string;
	details: string;
	reproductionSteps?: string;
	additionalContext?: string;
	agentProvider?: string;
	sshRemoteEnabled?: boolean;
	attachments?: FeedbackAttachmentInput[];
}

interface FeedbackEnvironmentSummary {
	maestroVersion: string;
	operatingSystem: string;
	installSource: string;
	agentProvider: string;
	sshRemoteExecution: string;
}

const FEEDBACK_CATEGORY_PREFIX: Record<FeedbackCategory, string> = {
	bug_report: 'Bug',
	feature_request: 'Feature',
	improvement: 'Improvement',
	general_feedback: 'Feedback',
};

function isFeedbackCategory(value: unknown): value is FeedbackCategory {
	return (
		value === 'bug_report' ||
		value === 'feature_request' ||
		value === 'improvement' ||
		value === 'general_feedback'
	);
}

function sanitizeTextInput(value: string): string {
	return value
		.replace(/\r\n/g, '\n')
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
		.replace(/\n{4,}/g, '\n\n\n')
		.trim();
}

function readRequiredField(
	value: unknown,
	fieldLabel: string,
	maxLength: number
): { value?: string; error?: string } {
	if (typeof value !== 'string') {
		return { error: `${fieldLabel} is required.` };
	}

	const sanitized = sanitizeTextInput(value);
	if (!sanitized) {
		return { error: `${fieldLabel} is required.` };
	}
	if (sanitized.length > maxLength) {
		return { error: `${fieldLabel} exceeds the maximum length (${maxLength}).` };
	}

	return { value: sanitized };
}

function readOptionalField(
	value: unknown,
	fieldLabel: string,
	maxLength: number
): { value?: string; error?: string } {
	if (value == null || value === '') {
		return {};
	}
	if (typeof value !== 'string') {
		return { error: `${fieldLabel} must be plain text.` };
	}

	const sanitized = sanitizeTextInput(value);
	if (!sanitized) {
		return {};
	}
	if (sanitized.length > maxLength) {
		return { error: `${fieldLabel} exceeds the maximum length (${maxLength}).` };
	}

	return { value: sanitized };
}

function getPlatformLabel(platform: NodeJS.Platform): string {
	switch (platform) {
		case 'darwin':
			return 'macOS';
		case 'win32':
			return 'Windows';
		case 'linux':
			return 'Linux';
		default:
			return platform;
	}
}

function inferInstallSource(): string {
	if (!app.isPackaged) {
		return 'Dev build';
	}

	const execPath = process.execPath.toLowerCase();
	if (execPath.includes('electron')) {
		return 'Packaged locally';
	}

	return 'Packaged build (release build or locally packaged)';
}

function buildEnvironmentSummary(payload: FeedbackSubmitPayload): FeedbackEnvironmentSummary {
	const platformLabel = getPlatformLabel(process.platform);
	const osVersion = typeof os.version === 'function' ? os.version() : '';
	const release = os.release();
	const operatingSystem = osVersion
		? `${platformLabel} (${osVersion}, ${release})`
		: `${platformLabel} (${release})`;

	return {
		maestroVersion: app.getVersion(),
		operatingSystem,
		installSource: inferInstallSource(),
		agentProvider: payload.agentProvider?.trim() || 'Not provided',
		sshRemoteExecution:
			typeof payload.sshRemoteEnabled === 'boolean'
				? payload.sshRemoteEnabled
					? 'Enabled'
					: 'Disabled'
				: 'Not provided',
	};
}

async function getGitHubLogin(): Promise<string> {
	const result = await execFileNoThrow(
		'gh',
		['api', 'user', '--jq', '.login'],
		undefined,
		getExpandedEnv()
	);
	if (result.exitCode !== 0 || !result.stdout.trim()) {
		throw new Error(result.stderr || 'Failed to resolve GitHub login.');
	}
	return result.stdout.trim();
}

function parseAttachmentDataUrl(attachment: FeedbackAttachmentInput): {
	base64: string;
	filename: string;
} {
	const match = attachment.dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/);
	if (!match) {
		throw new Error(`Unsupported image data for ${attachment.name}.`);
	}

	const extension = match[1].replace('jpeg', 'jpg');
	const hasExtension = /\.[a-zA-Z0-9]+$/.test(attachment.name);
	const filename = hasExtension ? attachment.name : `${attachment.name}.${extension}`;
	return { base64: match[2], filename };
}

async function ensureAttachmentsRepo(owner: string): Promise<void> {
	const repoCheck = await execFileNoThrow(
		'gh',
		['api', `repos/${owner}/${ATTACHMENTS_REPO}`],
		undefined,
		getExpandedEnv()
	);
	if (repoCheck.exitCode === 0) {
		return;
	}

	const repoCreate = await execFileNoThrow(
		'gh',
		[
			'api',
			'user/repos',
			'--method',
			'POST',
			'-f',
			`name=${ATTACHMENTS_REPO}`,
			'-F',
			'private=false',
			'-F',
			'has_issues=false',
			'-f',
			'description=Public image host for Maestro feedback issue attachments',
		],
		undefined,
		getExpandedEnv()
	);
	if (repoCreate.exitCode !== 0 && !repoCreate.stderr.includes('name already exists')) {
		throw new Error(repoCreate.stderr || 'Failed to create screenshot attachment repository.');
	}
}

async function uploadAttachments(
	attachments: FeedbackAttachmentInput[]
): Promise<{ markdown: string }> {
	if (attachments.length === 0) {
		return { markdown: 'None' };
	}

	const owner = await getGitHubLogin();
	await ensureAttachmentsRepo(owner);

	const uploadedMarkdown: string[] = [];
	for (let index = 0; index < attachments.length; index += 1) {
		const attachment = attachments[index];
		const { base64, filename } = parseAttachmentDataUrl(attachment);
		const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '-');
		const repoPath = `feedback/${Date.now()}-${index}-${safeFilename}`;
		const payloadPath = path.join(
			os.tmpdir(),
			`maestro-feedback-upload-${Date.now()}-${index}.json`
		);
		await fs.writeFile(
			payloadPath,
			JSON.stringify({
				message: `Add feedback screenshot ${Date.now()}-${index}`,
				content: base64,
			}),
			'utf8'
		);
		const uploadResult = await execFileNoThrow(
			'gh',
			[
				'api',
				`repos/${owner}/${ATTACHMENTS_REPO}/contents/${repoPath}`,
				'--method',
				'PUT',
				'--input',
				payloadPath,
			],
			undefined,
			getExpandedEnv()
		);
		await fs.unlink(payloadPath).catch(() => {});
		if (uploadResult.exitCode !== 0) {
			throw new Error(uploadResult.stderr || `Failed to upload screenshot ${attachment.name}.`);
		}
		const uploadJson = JSON.parse(uploadResult.stdout);
		const rawUrl =
			uploadJson.content?.download_url ||
			`https://raw.githubusercontent.com/${owner}/${ATTACHMENTS_REPO}/main/${repoPath}`;
		uploadedMarkdown.push(`![${attachment.name}](${rawUrl})`);
	}

	return { markdown: uploadedMarkdown.join('\n\n') };
}

async function composeFeedbackPrompt(
	feedbackText: string,
	attachments: FeedbackAttachmentInput[]
): Promise<{ prompt: string }> {
	const { markdown } = await uploadAttachments(attachments);
	const promptTemplate = await fs.readFile(getPromptPath(), 'utf-8');
	const prompt = promptTemplate
		.replace('{{FEEDBACK}}', feedbackText)
		.replace('{{ATTACHMENT_CONTEXT}}', markdown);
	return { prompt };
}

async function ensureFeedbackLabel(): Promise<void> {
	const labelCheck = await execFileNoThrow(
		'gh',
		['api', 'repos/RunMaestro/Maestro/labels/Maestro-feedback'],
		undefined,
		getExpandedEnv()
	);
	if (labelCheck.exitCode === 0) {
		return;
	}

	const labelCreate = await execFileNoThrow(
		'gh',
		[
			'label',
			'create',
			'Maestro-feedback',
			'-R',
			'RunMaestro/Maestro',
			'--color',
			'663579',
			'--description',
			'Feedback issues filed from the Maestro in-app feedback flow',
		],
		undefined,
		getExpandedEnv()
	);
	if (labelCreate.exitCode !== 0 && !labelCreate.stderr.includes('already exists')) {
		throw new Error(labelCreate.stderr || 'Failed to ensure Maestro-feedback label exists.');
	}
}

function buildIssueTitle(category: FeedbackCategory, summary: string): string {
	const compact = summary.replace(/\s+/g, ' ');
	const trimmed = compact.length > 72 ? `${compact.slice(0, 69)}...` : compact;
	return `${FEEDBACK_CATEGORY_PREFIX[category]}: ${trimmed}`;
}

function buildEnvironmentSection(environment: FeedbackEnvironmentSummary): string {
	return [
		'## Environment',
		`- Maestro version: ${environment.maestroVersion}`,
		`- Operating system: ${environment.operatingSystem}`,
		`- Install source: ${environment.installSource}`,
		`- Agent/provider involved: ${environment.agentProvider}`,
		`- SSH remote execution: ${environment.sshRemoteExecution}`,
	].join('\n');
}

function buildIssueBody(
	payload: FeedbackSubmitPayload,
	environment: FeedbackEnvironmentSummary,
	attachmentMarkdown: string
): string {
	const sections = [`## Summary\n${payload.summary}`, buildEnvironmentSection(environment)];

	if (payload.category === 'bug_report') {
		sections.push(`## Steps to Reproduce\n${payload.reproductionSteps || 'Not provided.'}`);
		sections.push(`## Expected Behavior\n${payload.expectedBehavior}`);
		sections.push(`## Actual Behavior\n${payload.details}`);
	} else {
		sections.push(`## Details\n${payload.details}`);
		sections.push(`## Desired Outcome\n${payload.expectedBehavior}`);
	}

	sections.push(`## Additional Context\n${payload.additionalContext || 'Not provided.'}`);
	sections.push(
		`## Screenshots / Recordings\n${attachmentMarkdown !== 'None' ? attachmentMarkdown : 'Not provided.'}`
	);
	return sections.join('\n\n');
}

/**
 * Register feedback IPC handlers.
 */
export function registerFeedbackHandlers(_deps: FeedbackHandlerDependencies): void {
	logger.info('Registering feedback IPC handlers', LOG_CONTEXT);

	// Check if GitHub CLI is installed and authenticated
	ipcMain.handle(
		'feedback:check-gh-auth',
		withIpcErrorLogging(
			handlerOpts('check-gh-auth'),
			async (): Promise<{ authenticated: boolean; message?: string }> => {
				// Prefer cache when available
				const cached = getCachedGhStatus();
				if (cached) {
					if (!cached.installed) {
						return { authenticated: false, message: GH_NOT_INSTALLED_MESSAGE };
					}
					if (!cached.authenticated) {
						return { authenticated: false, message: GH_NOT_AUTHENTICATED_MESSAGE };
					}
					return { authenticated: true };
				}

				// Check if gh is installed
				const installed = await isGhInstalled();
				if (!installed) {
					setCachedGhStatus(false, false);
					return { authenticated: false, message: GH_NOT_INSTALLED_MESSAGE };
				}

				// Check auth status (command output ignored; exit code is the signal)
				const authResult = await execFileNoThrow(
					'gh',
					['auth', 'status'],
					undefined,
					getExpandedEnv()
				);
				const authenticated = authResult.exitCode === 0;
				setCachedGhStatus(true, authenticated);

				if (!authenticated) {
					return { authenticated: false, message: GH_NOT_AUTHENTICATED_MESSAGE };
				}

				return { authenticated: true };
			}
		)
	);

	// Search existing GitHub issues for potential duplicates.
	// Extracts keywords from the query and runs multiple short searches to avoid
	// GitHub's strict AND matching on long phrases, then deduplicates results.
	ipcMain.handle(
		'feedback:search-issues',
		withIpcErrorLogging(
			handlerOpts('search-issues'),
			async (payload: {
				query: string;
			}): Promise<{
				issues: Array<{
					number: number;
					title: string;
					url: string;
					state: string;
					labels: string[];
					createdAt: string;
					author: string;
					commentCount: number;
				}>;
			}> => {
				const query = typeof payload?.query === 'string' ? payload.query.trim() : '';
				if (!query) {
					return { issues: [] };
				}

				// Extract meaningful keywords (drop short words, punctuation, duplicates)
				const stopWords = new Set([
					'a',
					'an',
					'the',
					'and',
					'or',
					'but',
					'in',
					'on',
					'at',
					'to',
					'for',
					'of',
					'with',
					'by',
					'from',
					'is',
					'it',
					'as',
					'be',
					'was',
					'are',
					'that',
					'this',
					'not',
					'can',
					'has',
					'have',
					'do',
					'does',
					'will',
				]);
				const keywords = query
					.replace(/[^a-zA-Z0-9\s-]/g, ' ')
					.split(/\s+/)
					.map((w) => w.toLowerCase())
					.filter((w) => w.length >= 3 && !stopWords.has(w));
				const uniqueKeywords = [...new Set(keywords)];

				if (uniqueKeywords.length === 0) {
					return { issues: [] };
				}

				// Build 2-3 keyword search queries (overlapping windows for coverage)
				const chunkSize = 3;
				const searchQueries: string[] = [];
				for (let i = 0; i < uniqueKeywords.length && searchQueries.length < 3; i += 2) {
					const chunk = uniqueKeywords.slice(i, i + chunkSize).join(' ');
					if (chunk) searchQueries.push(chunk);
				}
				// Also add the full query (truncated) as a final attempt
				if (uniqueKeywords.length > chunkSize) {
					searchQueries.push(uniqueKeywords.slice(0, 5).join(' '));
				}

				// Run searches in parallel
				type RawIssue = {
					number: number;
					title: string;
					url: string;
					state: string;
					labels: Array<{ name: string }>;
					createdAt: string;
					author: { login: string };
				};

				const searchPromises = searchQueries.map(async (q) => {
					const result = await execFileNoThrow(
						'gh',
						[
							'search',
							'issues',
							q,
							'--repo',
							'RunMaestro/Maestro',
							'--limit',
							'5',
							'--json',
							'number,title,url,state,labels,createdAt,author',
						],
						undefined,
						getExpandedEnv()
					);
					if (result.exitCode !== 0 || !result.stdout.trim()) return [];
					try {
						return JSON.parse(result.stdout) as RawIssue[];
					} catch {
						return [];
					}
				});

				const allResults = (await Promise.all(searchPromises)).flat();

				// Deduplicate by issue number, preserve first occurrence order
				const seen = new Set<number>();
				const deduped = allResults.filter((issue) => {
					if (seen.has(issue.number)) return false;
					seen.add(issue.number);
					return true;
				});

				return {
					issues: deduped.slice(0, 10).map((issue) => ({
						number: issue.number,
						title: issue.title,
						url: issue.url,
						state: issue.state,
						labels: issue.labels?.map((l) => l.name) ?? [],
						createdAt: issue.createdAt,
						author: issue.author?.login ?? 'unknown',
						commentCount: 0,
					})),
				};
			}
		)
	);

	// Subscribe to an existing issue (add a thumbs-up reaction + optional comment)
	ipcMain.handle(
		'feedback:subscribe-issue',
		withIpcErrorLogging(
			handlerOpts('subscribe-issue'),
			async (payload: {
				issueNumber: number;
				comment?: string;
			}): Promise<{ success: boolean; error?: string }> => {
				const { issueNumber, comment } = payload;
				if (!issueNumber || typeof issueNumber !== 'number') {
					return { success: false, error: 'Invalid issue number.' };
				}

				// Add a +1 reaction to show interest
				await execFileNoThrow(
					'gh',
					[
						'api',
						`repos/RunMaestro/Maestro/issues/${issueNumber}/reactions`,
						'--method',
						'POST',
						'-f',
						'content=+1',
					],
					undefined,
					getExpandedEnv()
				);

				// Add a comment if provided
				if (comment && comment.trim()) {
					const commentResult = await execFileNoThrow(
						'gh',
						[
							'issue',
							'comment',
							String(issueNumber),
							'-R',
							'RunMaestro/Maestro',
							'--body',
							comment.trim(),
						],
						undefined,
						getExpandedEnv()
					);

					if (commentResult.exitCode !== 0) {
						return {
							success: false,
							error: commentResult.stderr || 'Failed to add comment.',
						};
					}
				}

				return { success: true };
			}
		)
	);

	// Submit feedback by creating a structured GitHub issue directly
	ipcMain.handle(
		'feedback:submit',
		withIpcErrorLogging(
			handlerOpts('submit'),
			async (rawPayload: FeedbackSubmitPayload): Promise<{ success: boolean; error?: string }> => {
				if (!rawPayload || typeof rawPayload !== 'object') {
					return { success: false, error: 'Feedback payload is missing.' };
				}

				const { sessionId, category, agentProvider, sshRemoteEnabled, attachments } = rawPayload;
				if (!sessionId || typeof sessionId !== 'string') {
					return { success: false, error: 'No target agent was selected.' };
				}
				if (!isFeedbackCategory(category)) {
					return { success: false, error: 'Feedback type is invalid.' };
				}

				const summaryResult = readRequiredField(rawPayload.summary, 'Summary', MAX_SUMMARY_LENGTH);
				if (summaryResult.error) {
					return { success: false, error: summaryResult.error };
				}

				const expectedBehaviorResult = readRequiredField(
					rawPayload.expectedBehavior,
					category === 'bug_report' ? 'Expected behavior' : 'Desired outcome',
					MAX_FEEDBACK_FIELD_LENGTH
				);
				if (expectedBehaviorResult.error) {
					return { success: false, error: expectedBehaviorResult.error };
				}

				const detailsResult = readRequiredField(
					rawPayload.details,
					category === 'bug_report' ? 'Actual behavior' : 'Details',
					MAX_FEEDBACK_FIELD_LENGTH
				);
				if (detailsResult.error) {
					return { success: false, error: detailsResult.error };
				}

				const reproductionStepsResult =
					category === 'bug_report'
						? readRequiredField(
								rawPayload.reproductionSteps,
								'Steps to reproduce',
								MAX_FEEDBACK_FIELD_LENGTH
							)
						: readOptionalField(
								rawPayload.reproductionSteps,
								'Steps to reproduce',
								MAX_FEEDBACK_FIELD_LENGTH
							);
				if (reproductionStepsResult.error) {
					return { success: false, error: reproductionStepsResult.error };
				}

				const additionalContextResult = readOptionalField(
					rawPayload.additionalContext,
					'Additional context',
					MAX_FEEDBACK_FIELD_LENGTH
				);
				if (additionalContextResult.error) {
					return { success: false, error: additionalContextResult.error };
				}

				const normalizedAttachments = Array.isArray(attachments)
					? attachments.filter(
							(attachment): attachment is FeedbackAttachmentInput =>
								Boolean(attachment) &&
								typeof attachment.name === 'string' &&
								typeof attachment.dataUrl === 'string' &&
								attachment.dataUrl.startsWith('data:image/')
						)
					: [];
				const normalizedPayload: FeedbackSubmitPayload = {
					sessionId,
					category,
					summary: summaryResult.value!,
					expectedBehavior: expectedBehaviorResult.value!,
					details: detailsResult.value!,
					reproductionSteps: reproductionStepsResult.value,
					additionalContext: additionalContextResult.value,
					agentProvider:
						typeof agentProvider === 'string'
							? sanitizeTextInput(agentProvider).slice(0, 80)
							: undefined,
					sshRemoteEnabled: typeof sshRemoteEnabled === 'boolean' ? sshRemoteEnabled : undefined,
					attachments: normalizedAttachments,
				};
				const { markdown } = await uploadAttachments(normalizedAttachments);
				await ensureFeedbackLabel();
				const environment = buildEnvironmentSummary(normalizedPayload);

				const bodyPath = path.join(os.tmpdir(), `maestro-feedback-body-${Date.now()}.md`);
				await fs.writeFile(
					bodyPath,
					buildIssueBody(normalizedPayload, environment, markdown),
					'utf8'
				);
				const issueCreate = await execFileNoThrow(
					'gh',
					[
						'issue',
						'create',
						'-R',
						'RunMaestro/Maestro',
						'--title',
						buildIssueTitle(normalizedPayload.category, normalizedPayload.summary),
						'--body-file',
						bodyPath,
						'--label',
						'Maestro-feedback',
					],
					undefined,
					getExpandedEnv()
				);
				await fs.unlink(bodyPath).catch(() => {});
				if (issueCreate.exitCode !== 0) {
					return { success: false, error: issueCreate.stderr || 'Failed to create GitHub issue.' };
				}

				return { success: true };
			}
		)
	);

	// Get the conversation system prompt for the feedback chat interface
	ipcMain.handle(
		'feedback:get-conversation-prompt',
		withIpcErrorLogging(
			handlerOpts('get-conversation-prompt'),
			async (): Promise<{ prompt: string; environment: string }> => {
				const promptTemplate = getPrompt('feedback-conversation');

				const platformLabel = getPlatformLabel(process.platform);
				const osVersion = typeof os.version === 'function' ? os.version() : '';
				const release = os.release();
				const operatingSystem = osVersion
					? `${platformLabel} (${osVersion}, ${release})`
					: `${platformLabel} (${release})`;

				const environment = [
					`- Maestro version: ${app.getVersion()}`,
					`- Operating system: ${operatingSystem}`,
					`- Install source: ${inferInstallSource()}`,
				].join('\n');

				const prompt = promptTemplate.replace('{{ENVIRONMENT}}', environment);

				return { prompt, environment };
			}
		)
	);

	// Submit structured feedback by creating a GitHub issue from conversational data
	ipcMain.handle(
		'feedback:submit-conversation',
		withIpcErrorLogging(
			handlerOpts('submit-conversation'),
			async (payload: {
				category: FeedbackCategory;
				summary: string;
				expectedBehavior: string;
				actualBehavior: string;
				reproductionSteps?: string;
				additionalContext?: string;
				agentProvider?: string;
				sshRemoteEnabled?: boolean;
				attachments?: FeedbackAttachmentInput[];
				includeDebugPackage?: boolean;
			}): Promise<{ success: boolean; error?: string; issueUrl?: string }> => {
				if (!isFeedbackCategory(payload.category)) {
					return { success: false, error: 'Invalid feedback category.' };
				}

				const summaryField = readRequiredField(payload.summary, 'Summary', MAX_SUMMARY_LENGTH);
				if (summaryField.error) return { success: false, error: summaryField.error };

				const expectedField = readRequiredField(
					payload.expectedBehavior,
					'Expected Behavior',
					MAX_FEEDBACK_FIELD_LENGTH
				);
				if (expectedField.error) return { success: false, error: expectedField.error };

				const actualField = readRequiredField(
					payload.actualBehavior,
					'Actual Behavior',
					MAX_FEEDBACK_FIELD_LENGTH
				);
				if (actualField.error) return { success: false, error: actualField.error };

				const reproField = readOptionalField(
					payload.reproductionSteps,
					'Reproduction Steps',
					MAX_FEEDBACK_FIELD_LENGTH
				);
				if (reproField.error) return { success: false, error: reproField.error };

				const contextField = readOptionalField(
					payload.additionalContext,
					'Additional Context',
					MAX_FEEDBACK_FIELD_LENGTH
				);
				if (contextField.error) return { success: false, error: contextField.error };

				const environment = buildEnvironmentSummary({
					sessionId: 'conversation',
					category: payload.category,
					summary: summaryField.value!,
					expectedBehavior: expectedField.value!,
					details: actualField.value!,
					agentProvider: payload.agentProvider,
					sshRemoteEnabled: payload.sshRemoteEnabled,
				});

				// Upload attachments
				const normalizedAttachments = Array.isArray(payload.attachments)
					? payload.attachments.filter(
							(a): a is FeedbackAttachmentInput =>
								Boolean(a) &&
								typeof a.name === 'string' &&
								typeof a.dataUrl === 'string' &&
								a.dataUrl.startsWith('data:image/')
						)
					: [];
				const { markdown: attachmentMarkdown } = await uploadAttachments(normalizedAttachments);

				// Generate and upload debug package if requested
				let debugPackageMarkdown = '';
				if (payload.includeDebugPackage && _deps.debugPackageDeps) {
					try {
						const tmpDir = os.tmpdir();
						const packageResult = await generateDebugPackage(tmpDir, _deps.debugPackageDeps);
						if (packageResult.success && packageResult.path) {
							const zipData = await fs.readFile(packageResult.path);
							const zipBase64 = zipData.toString('base64');
							const owner = await getGitHubLogin();
							await ensureAttachmentsRepo(owner);
							const zipFilename = path.basename(packageResult.path);
							const repoPath = `feedback/${Date.now()}-${zipFilename}`;
							const payloadPath = path.join(tmpDir, `maestro-feedback-debug-${Date.now()}.json`);
							await fs.writeFile(
								payloadPath,
								JSON.stringify({
									message: `Add feedback debug package ${Date.now()}`,
									content: zipBase64,
								}),
								'utf8'
							);
							const uploadResult = await execFileNoThrow(
								'gh',
								[
									'api',
									`repos/${owner}/${ATTACHMENTS_REPO}/contents/${repoPath}`,
									'--method',
									'PUT',
									'--input',
									payloadPath,
								],
								undefined,
								getExpandedEnv()
							);
							await fs.unlink(payloadPath).catch(() => {});
							await fs.unlink(packageResult.path).catch(() => {});
							if (uploadResult.exitCode === 0) {
								const uploadJson = JSON.parse(uploadResult.stdout);
								const rawUrl =
									uploadJson.content?.download_url ||
									`https://raw.githubusercontent.com/${owner}/${ATTACHMENTS_REPO}/main/${repoPath}`;
								debugPackageMarkdown = `[maestro-debug-package.zip](${rawUrl})`;
							}
						}
					} catch (e) {
						void captureException(e);
						logger.warn(`Failed to generate/upload debug package: ${e}`, LOG_CONTEXT);
					}
				}

				// Build issue body
				const title = buildIssueTitle(payload.category, summaryField.value!);
				const isBug = payload.category === 'bug_report';
				const sections = [
					`## Summary\n${summaryField.value!}`,
					buildEnvironmentSection(environment),
					isBug ? `## Steps to Reproduce\n${reproField.value || 'Not provided.'}` : null,
					`## ${isBug ? 'Expected Behavior' : 'Desired Outcome'}\n${expectedField.value!}`,
					`## ${isBug ? 'Actual Behavior' : 'Details'}\n${actualField.value!}`,
					contextField.value ? `## Additional Context\n${contextField.value}` : null,
					attachmentMarkdown ? `## Screenshots / Recordings\n${attachmentMarkdown}` : null,
					debugPackageMarkdown ? `## Support Package\n${debugPackageMarkdown}` : null,
				]
					.filter(Boolean)
					.join('\n\n');

				// Ensure label and create issue
				try {
					await ensureFeedbackLabel();
				} catch {
					// Continue without label
				}

				const bodyFile = path.join(os.tmpdir(), `maestro-feedback-${Date.now()}.md`);
				await fs.writeFile(bodyFile, sections, 'utf-8');

				try {
					const issueCreate = await execFileNoThrow(
						'gh',
						[
							'issue',
							'create',
							'-R',
							'RunMaestro/Maestro',
							'--title',
							title,
							'--body-file',
							bodyFile,
							'--label',
							'Maestro-feedback',
						],
						undefined,
						getExpandedEnv()
					);

					if (issueCreate.exitCode !== 0) {
						return {
							success: false,
							error: issueCreate.stderr || 'Failed to create GitHub issue.',
						};
					}

					// gh issue create prints the issue URL to stdout
					const issueUrl = issueCreate.stdout.trim();
					return { success: true, issueUrl: issueUrl || undefined };
				} finally {
					await fs.unlink(bodyFile).catch(() => {});
				}
			}
		)
	);

	ipcMain.handle(
		'feedback:compose-prompt',
		withIpcErrorLogging(
			handlerOpts('compose-prompt'),
			async ({
				feedbackText,
				attachments,
			}: {
				feedbackText: string;
				attachments?: FeedbackAttachmentInput[];
			}): Promise<{ prompt: string }> => {
				const trimmedFeedback = typeof feedbackText === 'string' ? feedbackText.trim() : '';
				if (!trimmedFeedback) {
					throw new Error('Feedback cannot be empty.');
				}
				if (trimmedFeedback.length > 5000) {
					throw new Error('Feedback exceeds the maximum length (5000).');
				}

				const normalizedAttachments = Array.isArray(attachments)
					? attachments.filter(
							(attachment): attachment is FeedbackAttachmentInput =>
								Boolean(attachment) &&
								typeof attachment.name === 'string' &&
								typeof attachment.dataUrl === 'string' &&
								attachment.dataUrl.startsWith('data:image/')
						)
					: [];

				const { prompt } = await composeFeedbackPrompt(trimmedFeedback, normalizedAttachments);

				return { prompt };
			}
		)
	);
}
