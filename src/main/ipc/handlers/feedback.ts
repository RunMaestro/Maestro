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
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import {
	isGhInstalled,
	setCachedGhStatus,
	getCachedGhStatus,
	getExpandedEnv,
} from '../../utils/cliDetection';
import { execFileNoThrow } from '../../utils/execFile';

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

	const uploadedMarkdown = [];
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
