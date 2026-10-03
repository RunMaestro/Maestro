/**
 * GitHub feedback service.
 *
 * Everything the Feedback modal can do, as plain functions: check `gh` auth,
 * search for duplicate issues, +1 / comment on an existing one, and file a new
 * structured issue (optionally with screenshots and a support package).
 *
 * Two transports call these: the `feedback:*` IPC handlers (the desktop modal)
 * and the WS bridge (`maestro-cli feedback ...`). Keeping the logic out of the
 * IPC registration is what lets the CLI file the identical issue the modal
 * would, instead of a second implementation that drifts.
 */

import { app } from 'electron';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { logger } from '../utils/logger';
import { getPrompt } from '../prompt-manager';
import {
	isGhInstalled,
	setCachedGhStatus,
	getCachedGhStatus,
	getExpandedEnv,
	resolveGhPath,
} from '../utils/cliDetection';
import { execFileNoThrow } from '../utils/execFile';
import {
	isGitHubAuthError,
	isGitHubMissingScopeError,
	isGitHubOAuthRestrictionError,
} from '../utils/ghErrors';
import { getSettingsStore } from '../stores/getters';
import { isInitialized } from '../stores/instances';
import { generateDebugPackage, type DebugPackageDependencies } from '../debug-package';
import { captureException } from '../utils/sentry';
import type { MaestroCliManager } from '../maestro-cli-manager';
import {
	buildPrefilledIssueUrl,
	FEEDBACK_LABEL,
	FEEDBACK_REPO,
	isFeedbackCategory,
	MAX_FEEDBACK_FIELD_LENGTH,
	MAX_FEEDBACK_SUMMARY_LENGTH as MAX_SUMMARY_LENGTH,
	type FeedbackAttachmentPayload as FeedbackAttachmentInput,
	type FeedbackAuthResponse,
	type FeedbackCategory,
	type FeedbackConversationSubmitPayload,
	type FeedbackIssueSearchResponse,
	type FeedbackSubmissionPayload as FeedbackSubmitPayload,
	type FeedbackSubmitResponse,
} from '../../shared/feedback';

const LOG_CONTEXT = '[Feedback]';
const ATTACHMENTS_REPO = 'maestro-feedback-attachments';

const GH_NOT_INSTALLED_MESSAGE =
	'GitHub CLI (gh) is not installed. Install it from https://cli.github.com';
const GH_NOT_AUTHENTICATED_MESSAGE =
	'GitHub CLI is not authenticated. Run "gh auth login" in your terminal.';

// The GitHub CLI's OAuth app. Its settings page is where a user grants (or
// requests) an organization's approval for gh.
const GH_OAUTH_APP_SETTINGS_URL =
	'https://github.com/settings/connections/applications/178c6fc778ccc68e1d6a';

/**
 * Turn a failed gh call into something the user can act on.
 *
 * gh reports auth trouble as raw API text ("HTTP 401: Bad credentials", "the
 * RunMaestro organization has enabled OAuth App access restrictions"), which
 * reads like a Maestro bug and names no fix. The up-front `gh auth status`
 * check cannot catch these: it is cached for a minute, and an org's OAuth
 * restriction refuses a token that `gh auth status` reports as valid. So every
 * failure is translated here, and anything unrecognised keeps gh's own words.
 */
export function describeGhFailure(stderr: string | undefined, fallback: string): string {
	const detail = stderr?.trim() ?? '';
	if (isGitHubOAuthRestrictionError(detail)) {
		return `GitHub refused the request because an organization restricts third-party apps and has not approved the GitHub CLI for your account. Open ${GH_OAUTH_APP_SETTINGS_URL}, grant or request access for RunMaestro, then submit again. You can also run "gh auth login" again and approve RunMaestro on the authorization page.`;
	}
	if (isGitHubAuthError(detail)) {
		return 'Your GitHub CLI login has expired or was revoked. Run "gh auth login" in a terminal, then submit again.';
	}
	if (isGitHubMissingScopeError(detail)) {
		return 'Your GitHub CLI login is missing a permission feedback needs. Run "gh auth refresh -h github.com -s repo" in a terminal, then submit again.';
	}
	return detail || fallback;
}

function getPromptPath(): string {
	if (app.isPackaged) {
		return path.join(process.resourcesPath, 'prompts', 'feedback.md');
	}

	return path.join(app.getAppPath(), 'src', 'prompts', 'feedback.md');
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

/**
 * Resolve the gh binary this handler should invoke.
 *
 * Honours the user's configured Settings > GitHub CLI (gh) Path, falling back to
 * auto-detection. Every gh call in this file must go through here: a bare 'gh'
 * literal silently ignores that setting, which is the whole reason it exists for
 * installs where gh is not on the expanded PATH.
 */
async function resolveFeedbackGhCommand(): Promise<string> {
	// Guard on the predicate rather than catching. The stores genuinely are not
	// initialised in every context (unit tests, early startup), and falling back
	// to auto-detection there is correct, but a blanket catch would also swallow
	// a real store failure and silently run some other binary.
	if (!isInitialized()) {
		return resolveGhPath();
	}

	const configured = getSettingsStore().get('ghPath');
	const customPath =
		typeof configured === 'string' && configured.trim() ? configured.trim() : undefined;
	return resolveGhPath(customPath);
}

async function getGitHubLogin(): Promise<string> {
	const result = await execFileNoThrow(
		await resolveFeedbackGhCommand(),
		['api', 'user', '--jq', '.login'],
		undefined,
		getExpandedEnv()
	);
	if (result.exitCode !== 0 || !result.stdout.trim()) {
		throw new Error(describeGhFailure(result.stderr, 'Failed to resolve GitHub login.'));
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
		await resolveFeedbackGhCommand(),
		['api', `repos/${owner}/${ATTACHMENTS_REPO}`],
		undefined,
		getExpandedEnv()
	);
	if (repoCheck.exitCode === 0) {
		return;
	}

	const repoCreate = await execFileNoThrow(
		await resolveFeedbackGhCommand(),
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
		throw new Error(
			describeGhFailure(repoCreate.stderr, 'Failed to create screenshot attachment repository.')
		);
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
			await resolveFeedbackGhCommand(),
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
			throw new Error(
				describeGhFailure(uploadResult.stderr, `Failed to upload screenshot ${attachment.name}.`)
			);
		}
		const uploadJson = JSON.parse(uploadResult.stdout);
		const rawUrl =
			uploadJson.content?.download_url ||
			`https://raw.githubusercontent.com/${owner}/${ATTACHMENTS_REPO}/main/${repoPath}`;
		uploadedMarkdown.push(`![${attachment.name}](${rawUrl})`);
	}

	return { markdown: uploadedMarkdown.join('\n\n') };
}

/**
 * Upload screenshots for an issue that is about to be filed, degrading instead
 * of failing. Hosting them takes more of `gh` than filing does (it creates a
 * public repo on the user's account), so a token that can file an issue can
 * still be refused here, and losing the whole report over a picture is worse
 * than filing it without one. A failure is recorded in `warnings` and noted in
 * the issue body, so the reader knows screenshots existed.
 */
async function uploadAttachmentsOrWarn(
	attachments: FeedbackAttachmentInput[],
	warnings: string[]
): Promise<string> {
	try {
		return (await uploadAttachments(attachments)).markdown;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		logger.warn('Feedback screenshots could not be uploaded; filing without them', LOG_CONTEXT, {
			error: reason,
		});
		const count = attachments.length;
		warnings.push(
			`${count} screenshot${count === 1 ? '' : 's'} could not be uploaded, so the issue was filed without ${count === 1 ? 'it' : 'them'}. Drag ${count === 1 ? 'it' : 'them'} into a comment on the issue to add ${count === 1 ? 'it' : 'them'}. (${reason})`
		);
		return `${count} screenshot${count === 1 ? ' was' : 's were'} attached in Maestro but could not be uploaded.`;
	}
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

/**
 * Whether the `Maestro-feedback` label exists (creating it when it does not).
 *
 * Never throws: the label is for triage, not for the reporter, and a user who
 * cannot create labels on RunMaestro/Maestro (nearly everyone) must still be
 * able to file. `false` means "file without `--label`".
 */
async function ensureFeedbackLabel(): Promise<boolean> {
	const labelCheck = await execFileNoThrow(
		await resolveFeedbackGhCommand(),
		['api', `repos/${FEEDBACK_REPO}/labels/${FEEDBACK_LABEL}`],
		undefined,
		getExpandedEnv()
	);
	if (labelCheck.exitCode === 0) {
		return true;
	}

	const labelCreate = await execFileNoThrow(
		await resolveFeedbackGhCommand(),
		[
			'label',
			'create',
			FEEDBACK_LABEL,
			'-R',
			FEEDBACK_REPO,
			'--color',
			'663579',
			'--description',
			'Feedback issues filed from the Maestro in-app feedback flow',
		],
		undefined,
		getExpandedEnv()
	);
	if (labelCreate.exitCode === 0 || labelCreate.stderr.includes('already exists')) {
		return true;
	}
	logger.warn('Maestro-feedback label unavailable; filing without it', LOG_CONTEXT, {
		error: labelCreate.stderr.trim(),
	});
	return false;
}

/**
 * File the issue with `gh issue create`, so that nothing short of gh refusing
 * the issue itself loses the report.
 *
 * The label is attached when it could be ensured, and dropped on a retry when
 * gh refuses the create over the label alone. When the create still fails, the
 * response carries the translated gh error AND a prefilled github.com URL, so
 * the user can file the identical issue from their browser.
 */
async function fileFeedbackIssue(
	title: string,
	body: string,
	warnings: string[]
): Promise<FeedbackSubmitResponse> {
	const labelled = await ensureFeedbackLabel();
	const bodyFile = path.join(os.tmpdir(), `maestro-feedback-body-${Date.now()}.md`);
	await fs.writeFile(bodyFile, body, 'utf-8');

	const create = async (withLabel: boolean) =>
		execFileNoThrow(
			await resolveFeedbackGhCommand(),
			[
				'issue',
				'create',
				'-R',
				FEEDBACK_REPO,
				'--title',
				title,
				'--body-file',
				bodyFile,
				...(withLabel ? ['--label', FEEDBACK_LABEL] : []),
			],
			undefined,
			getExpandedEnv()
		);

	try {
		let issueCreate = await create(labelled);
		if (issueCreate.exitCode !== 0 && labelled && /label/i.test(issueCreate.stderr)) {
			logger.warn('gh refused the feedback label; retrying without it', LOG_CONTEXT, {
				error: issueCreate.stderr.trim(),
			});
			issueCreate = await create(false);
		}

		if (issueCreate.exitCode !== 0) {
			return {
				success: false,
				error: describeGhFailure(issueCreate.stderr, 'Failed to create GitHub issue.'),
				fallbackIssueUrl: buildPrefilledIssueUrl(title, body),
				warnings: warnings.length > 0 ? warnings : undefined,
			};
		}

		// gh issue create prints the issue URL to stdout
		const issueUrl = issueCreate.stdout.trim();
		return {
			success: true,
			issueUrl: issueUrl || undefined,
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	} finally {
		await fs.unlink(bodyFile).catch(() => {});
	}
}

function buildIssueTitle(category: FeedbackCategory, summary: string): string {
	const compact = summary.replace(/\s+/g, ' ');
	const trimmed = compact.length > 72 ? `${compact.slice(0, 69)}...` : compact;
	return `${FEEDBACK_CATEGORY_PREFIX[category]}: ${trimmed}`;
}

/**
 * Describe the debug log for the feedback agent's environment block.
 *
 * File logging is off by default everywhere except Windows, so today's dated log
 * usually does not exist. Naming it unconditionally sends the agent to a missing
 * file and burns one of the few diagnostics it should be spending on the user's
 * actual problem, so report what is really on disk: today's log, else the most
 * recent one, else the fact that logging is disabled.
 */
async function describeDebugLog(): Promise<string> {
	const logFilePath = logger.getLogFilePath();
	const logsDir = path.dirname(logFilePath);

	try {
		await fs.access(logFilePath);
		return `- Debug log (today, live): ${logFilePath}`;
	} catch {
		// Today's log is absent - fall through and look for older ones.
	}

	try {
		const entries = await fs.readdir(logsDir);
		const logs = entries.filter((name) => name.endsWith('.log')).sort();
		const mostRecent = logs[logs.length - 1];
		if (mostRecent) {
			return `- Debug log: file logging is currently OFF, so there is no log for today. The most recent one is ${path.join(logsDir, mostRecent)} (stale - only useful if the problem is old).`;
		}
	} catch {
		// No logs directory at all.
	}

	return '- Debug log: file logging is OFF and no logs exist. Do not try to read one; rely on maestro-cli instead.';
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
 * Whether `gh` is installed and authenticated. Feedback cannot be filed
 * without it, so every caller checks this first.
 */
export async function checkFeedbackGhAuth(): Promise<FeedbackAuthResponse> {
	// A configured custom path is authoritative: it exists precisely for
	// binaries that PATH lookup cannot find. Resolve it before reading the
	// cache, because the cache is keyed by the command a verdict was reached
	// against, and the other gh callers probe the PATH-resolved binary.
	const ghCommand = await resolveFeedbackGhCommand();

	// Prefer cache when available
	const cached = getCachedGhStatus(ghCommand);
	if (cached) {
		if (!cached.installed) {
			return { authenticated: false, message: GH_NOT_INSTALLED_MESSAGE };
		}
		if (!cached.authenticated) {
			return { authenticated: false, message: GH_NOT_AUTHENTICATED_MESSAGE };
		}
		return { authenticated: true };
	}

	// Check if gh is installed. Probe a custom path directly rather than
	// asking `which` about a name it will never see.
	const env = getExpandedEnv();
	const installed =
		ghCommand === 'gh'
			? await isGhInstalled()
			: (await execFileNoThrow(ghCommand, ['--version'], undefined, env)).exitCode === 0;
	if (!installed) {
		setCachedGhStatus(ghCommand, false, false);
		return { authenticated: false, message: GH_NOT_INSTALLED_MESSAGE };
	}

	// Check auth status (command output ignored; exit code is the signal)
	const authResult = await execFileNoThrow(ghCommand, ['auth', 'status'], undefined, env);
	const authenticated = authResult.exitCode === 0;
	setCachedGhStatus(ghCommand, true, authenticated);

	if (!authenticated) {
		return { authenticated: false, message: GH_NOT_AUTHENTICATED_MESSAGE };
	}

	return { authenticated: true };
}

/**
 * Search existing GitHub issues for potential duplicates.
 * Extracts keywords from the query and runs multiple short searches to avoid
 * GitHub's strict AND matching on long phrases, then deduplicates results.
 */
export async function searchFeedbackIssues(payload: {
	query: string;
}): Promise<FeedbackIssueSearchResponse> {
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
			await resolveFeedbackGhCommand(),
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

/** Subscribe to an existing issue: add a +1 reaction and an optional comment. */
export async function subscribeFeedbackIssue(payload: {
	issueNumber: number;
	comment?: string;
}): Promise<FeedbackSubmitResponse> {
	const { issueNumber, comment } = payload;
	if (!issueNumber || typeof issueNumber !== 'number') {
		return { success: false, error: 'Invalid issue number.' };
	}

	// Add a +1 reaction to show interest
	await execFileNoThrow(
		await resolveFeedbackGhCommand(),
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
			await resolveFeedbackGhCommand(),
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
				error: describeGhFailure(commentResult.stderr, 'Failed to add comment.'),
			};
		}
	}

	return { success: true };
}

/** Legacy one-shot submit: create a structured GitHub issue directly. */
export async function submitFeedback(
	rawPayload: FeedbackSubmitPayload
): Promise<FeedbackSubmitResponse> {
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
			typeof agentProvider === 'string' ? sanitizeTextInput(agentProvider).slice(0, 80) : undefined,
		sshRemoteEnabled: typeof sshRemoteEnabled === 'boolean' ? sshRemoteEnabled : undefined,
		attachments: normalizedAttachments,
	};
	const warnings: string[] = [];
	const markdown = await uploadAttachmentsOrWarn(normalizedAttachments, warnings);
	const environment = buildEnvironmentSummary(normalizedPayload);

	return fileFeedbackIssue(
		buildIssueTitle(normalizedPayload.category, normalizedPayload.summary),
		buildIssueBody(normalizedPayload, environment, markdown),
		warnings
	);
}

/**
 * Build the system prompt for the feedback interview agent. `cliManager`
 * lets the prompt say whether maestro-cli diagnostics are actually reachable.
 */
export async function buildFeedbackConversationPrompt(
	cliManager?: MaestroCliManager
): Promise<{ prompt: string; environment: string; cwd: string }> {
	const promptTemplate = getPrompt('feedback-conversation');

	const platformLabel = getPlatformLabel(process.platform);
	const osVersion = typeof os.version === 'function' ? os.version() : '';
	const release = os.release();
	const operatingSystem = osVersion
		? `${platformLabel} (${osVersion}, ${release})`
		: `${platformLabel} (${release})`;

	const environmentLines = [
		`- Maestro version: ${app.getVersion()}`,
		`- Operating system: ${operatingSystem}`,
		`- Install source: ${inferInstallSource()}`,
		`- Maestro user data: ${app.getPath('userData')}`,
		await describeDebugLog(),
	];

	// Tell the agent whether maestro-cli is actually reachable. Advertising
	// verbs it cannot run wastes a diagnostic budget on ENOENT.
	if (cliManager) {
		try {
			const status = await cliManager.checkStatus();
			environmentLines.push(
				status.installed && status.commandPath
					? `- maestro-cli: available at ${status.commandPath}`
					: '- maestro-cli: NOT installed - skip the maestro-cli diagnostics below and read the log file instead'
			);
		} catch (error) {
			// A status probe failure is not a feedback failure. Note it and move on.
			logger.warn('Failed to probe maestro-cli status for feedback prompt', LOG_CONTEXT, {
				error: String(error),
			});
		}
	}

	const environment = environmentLines.join('\n');
	const prompt = promptTemplate.replace('{{ENVIRONMENT}}', environment);

	// Diagnostics run from the user's home directory rather than the app's
	// cwd (which is `/` for a Finder-launched .app, where nothing useful
	// resolves). Home also keeps the agent out of whatever project the user
	// happens to have open - the prompt scopes it to Maestro's own logs and
	// config, and starting it away from their source reinforces that.
	return { prompt, environment, cwd: os.homedir() };
}

/**
 * File a structured GitHub issue from the conversational form. When
 * `includeDebugPackage` is set and `debugPackageDeps` is available, a support
 * package is generated, uploaded, and linked from the issue.
 */
export async function submitFeedbackConversation(
	payload: FeedbackConversationSubmitPayload,
	debugPackageDeps?: DebugPackageDependencies
): Promise<FeedbackSubmitResponse> {
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
	// A screenshot or support-package failure drops that part and files the
	// rest; `warnings` tells the user what is missing from the issue.
	const warnings: string[] = [];
	const attachmentMarkdown = await uploadAttachmentsOrWarn(normalizedAttachments, warnings);

	// Generate and upload debug package if requested
	let debugPackageMarkdown = '';
	if (payload.includeDebugPackage && debugPackageDeps) {
		try {
			const tmpDir = os.tmpdir();
			const packageResult = await generateDebugPackage(tmpDir, debugPackageDeps);
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
					await resolveFeedbackGhCommand(),
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
		if (!debugPackageMarkdown) {
			warnings.push(
				'The support package could not be generated or uploaded, so the issue was filed without it.'
			);
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

	return fileFeedbackIssue(title, sections, warnings);
}

/** Compose the one-shot feedback prompt, uploading any screenshots first. */
export async function composeFeedbackPromptFromText(payload: {
	feedbackText: string;
	attachments?: FeedbackAttachmentInput[];
}): Promise<{ prompt: string }> {
	const { feedbackText, attachments } = payload;
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
