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
	clearGhCache,
	isGhInstalled,
	setCachedGhStatus,
	getCachedGhStatus,
	getExpandedEnv,
	resolveGhPath,
} from '../utils/cliDetection';
import { execFileNoThrow } from '../utils/execFile';
import {
	parseGhActiveAccount,
	type GhAccount,
	isGitHubAuthError,
	isGitHubMissingScopeError,
	isGitHubOAuthRestrictionError,
} from '../utils/ghErrors';
import { getSettingsStore } from '../stores/getters';
import { isInitialized } from '../stores/instances';
import { generateDebugPackage, type DebugPackageDependencies } from '../debug-package';
import { captureException, captureMessage } from '../utils/sentry';
import { isMacOS, isWindows } from '../../shared/platformDetection';
import type { MaestroCliManager } from '../maestro-cli-manager';
import {
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
	type FeedbackGhLoginCommand,
	GH_LOGIN_ARGS,
} from '../../shared/feedback';
import { formatAgentLoginCommand } from '../../shared/agentMetadata';

const LOG_CONTEXT = '[Feedback]';
// The repo feedback issues are filed on, and how long the up-front write
// probe against it may take before it is treated as inconclusive.
const FEEDBACK_REPO = 'RunMaestro/Maestro';
const REPO_PROBE_TIMEOUT_MS = 15_000;
const ATTACHMENTS_REPO = 'maestro-feedback-attachments';

/** How to install gh here, by the package manager this platform ships or favors. */
function ghNotInstalledMessage(): string {
	const how = isMacOS()
		? 'Install it with "brew install gh" or from https://cli.github.com'
		: isWindows()
			? 'Install it with "winget install --id GitHub.cli" or from https://cli.github.com'
			: 'Install it from https://cli.github.com';
	return `GitHub CLI (gh) is not installed. ${how}, then Check Again.`;
}
const GH_NOT_AUTHENTICATED_MESSAGE =
	'GitHub CLI (gh) is not signed in to GitHub, so feedback cannot be filed.';

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
	return classifyGhFailure(stderr, fallback).message;
}

/**
 * {@link describeGhFailure}, plus whether signing gh in again can fix it, so
 * the Feedback chat can offer its embedded login instead of only naming one.
 */
export function classifyGhFailure(
	stderr: string | undefined,
	fallback: string
): { message: string; needsGhLogin: boolean } {
	const message = describeGhFailureText(stderr, fallback);
	const detail = stderr?.trim() ?? '';
	const needsGhLogin =
		isGitHubOAuthRestrictionError(detail) ||
		isGitHubAuthError(detail) ||
		isGitHubMissingScopeError(detail);
	return { message, needsGhLogin };
}

/** A gh call failed. Carries whether a fresh login can fix it. */
export class GhCommandError extends Error {
	readonly needsGhLogin: boolean;
	constructor(stderr: string | undefined, fallback: string) {
		const { message, needsGhLogin } = classifyGhFailure(stderr, fallback);
		super(message);
		this.name = 'GhCommandError';
		this.needsGhLogin = needsGhLogin;
	}
}

/** The failure half of a feedback result for a gh call that failed. */
function ghFailureResult(
	stderr: string | undefined,
	fallback: string
): { success: false; error: string; needsGhLogin: boolean } {
	const { message, needsGhLogin } = classifyGhFailure(stderr, fallback);
	return { success: false, error: message, needsGhLogin };
}

function describeGhFailureText(stderr: string | undefined, fallback: string): string {
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
		throw new GhCommandError(result.stderr, 'Failed to resolve GitHub login.');
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
		throw new GhCommandError(
			repoCreate.stderr,
			'Failed to create screenshot attachment repository.'
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
			throw new GhCommandError(
				uploadResult.stderr,
				`Failed to upload screenshot ${attachment.name}.`
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
		await resolveFeedbackGhCommand(),
		['api', 'repos/RunMaestro/Maestro/labels/Maestro-feedback'],
		undefined,
		getExpandedEnv()
	);
	if (labelCheck.exitCode === 0) {
		return;
	}

	const labelCreate = await execFileNoThrow(
		await resolveFeedbackGhCommand(),
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
		throw new GhCommandError(labelCreate.stderr, 'Failed to ensure Maestro-feedback label exists.');
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
export async function checkFeedbackGhAuth(
	options: { fresh?: boolean } = {}
): Promise<FeedbackAuthResponse> {
	// A fresh check is what "Check again" and the end of an embedded login ask
	// for: the cached verdict is the very answer the user just changed.
	if (options.fresh) {
		clearGhCache();
		clearFeedbackRepoVerdicts();
	}

	// A configured custom path is authoritative: it exists precisely for
	// binaries that PATH lookup cannot find. Resolve it before reading the
	// cache, because the cache is keyed by the command a verdict was reached
	// against, and the other gh callers probe the PATH-resolved binary.
	const ghCommand = await resolveFeedbackGhCommand();
	const notInstalled: FeedbackAuthResponse = {
		authenticated: false,
		reason: 'not-installed',
		message: ghNotInstalledMessage(),
	};
	const notAuthenticated = (account?: GhAccount): FeedbackAuthResponse => ({
		authenticated: false,
		reason: 'not-authenticated',
		message: GH_NOT_AUTHENTICATED_MESSAGE,
		needsGhLogin: true,
		login: ghLoginCommandFor(ghCommand),
		...(account ? { account } : {}),
	});

	// Prefer cache when available. The shared gh status cache answers
	// "installed?" and "signed in?"; whether THIS account may file on the
	// feedback repo is feedback's own question and lives in `repoVerdicts`.
	const cached = getCachedGhStatus(ghCommand);
	if (cached && !cached.installed) return notInstalled;
	if (cached && !cached.authenticated) return notAuthenticated();
	const remembered = readRepoVerdict(ghCommand);
	if (cached && remembered) return remembered;

	const env = getExpandedEnv();
	if (!cached) {
		// Check if gh is installed. Probe a custom path directly rather than
		// asking `which` about a name it will never see.
		const installed =
			ghCommand === 'gh'
				? await isGhInstalled()
				: (await execFileNoThrow(ghCommand, ['--version'], undefined, env)).exitCode === 0;
		if (!installed) {
			setCachedGhStatus(ghCommand, false, false);
			return notInstalled;
		}
	}

	// The exit code says signed in or not; the text names the account.
	const authResult = await execFileNoThrow(ghCommand, ['auth', 'status'], undefined, env);
	const authenticated = authResult.exitCode === 0;
	setCachedGhStatus(ghCommand, true, authenticated);
	const account = parseGhActiveAccount(`${authResult.stdout}\n${authResult.stderr}`);

	if (!authenticated) return notAuthenticated(account);

	const verdict = await probeFeedbackRepoAccess(ghCommand, env, account);
	rememberRepoVerdict(ghCommand, verdict);
	return verdict;
}

/**
 * Whether gh may file an issue on the feedback repo, cached per gh binary for
 * the same minute as gh's own status. Kept apart from the shared gh status
 * cache on purpose: Symphony and Create PR read that one, and a refusal from
 * RunMaestro's org says nothing about whether gh works for the user's repos.
 */
const REPO_VERDICT_TTL_MS = 60_000;
const repoVerdicts = new Map<string, { verdict: FeedbackAuthResponse; at: number }>();

function readRepoVerdict(ghCommand: string): FeedbackAuthResponse | undefined {
	const entry = repoVerdicts.get(ghCommand);
	if (!entry) return undefined;
	if (Date.now() - entry.at >= REPO_VERDICT_TTL_MS) {
		repoVerdicts.delete(ghCommand);
		return undefined;
	}
	return entry.verdict;
}

function rememberRepoVerdict(ghCommand: string, verdict: FeedbackAuthResponse): void {
	repoVerdicts.set(ghCommand, { verdict, at: Date.now() });
}

/** Forget every remembered repo verdict, so the next check probes again. */
export function clearFeedbackRepoVerdicts(): void {
	repoVerdicts.clear();
}

/**
 * Prove gh can file an issue on the feedback repo before the user writes one.
 *
 * `gh auth status` only proves the token is valid. What fails at submit is a
 * WRITE: an organization's OAuth App restriction refuses the GitHub CLI's token
 * on RunMaestro while allowing every public read, so a GET probe passes for
 * exactly the users it is meant to catch. Instead this POSTs an empty issue.
 * GitHub authorizes the request first and only then validates it, so an
 * account that may file gets 422 ("title" wasn't supplied) and nothing is
 * created, while a refused one gets the same 401/403 a real submit would.
 *
 * Only a proven refusal blocks. A network failure or a 5xx says nothing about
 * the account, so it passes and the submit path reports whatever happens.
 */
async function probeFeedbackRepoAccess(
	ghCommand: string,
	env: NodeJS.ProcessEnv,
	account: GhAccount | undefined
): Promise<FeedbackAuthResponse> {
	const withAccount = account ? { account } : {};
	const result = await execFileNoThrow(
		ghCommand,
		['api', `repos/${FEEDBACK_REPO}/issues`, '--method', 'POST', '--input', '-'],
		undefined,
		{ env, input: '{}', timeout: REPO_PROBE_TIMEOUT_MS }
	);
	const stderr = result.stderr ?? '';

	if (result.exitCode === 0) {
		// GitHub requires a title, so this should be impossible. If it ever
		// happens a blank issue now exists on a public repo: make it loud.
		void captureMessage('Feedback repo probe created an issue', 'warning', {
			stdout: result.stdout.slice(0, 500),
		});
		return { authenticated: true, ...withAccount };
	}
	if (/\bHTTP 422\b/.test(stderr)) return { authenticated: true, ...withAccount };

	const { message, needsGhLogin } = classifyGhFailure(
		stderr,
		`GitHub refused this account an issue on ${FEEDBACK_REPO}. ${stderr.trim()}`.trim()
	);
	if (needsGhLogin || /\bHTTP (?:403|404)\b/.test(stderr)) {
		return {
			authenticated: false,
			reason: 'no-repo-access',
			message,
			needsGhLogin,
			...(needsGhLogin ? { login: ghLoginCommandFor(ghCommand) } : {}),
			...withAccount,
		};
	}
	logger.warn(`Feedback repo probe was inconclusive: ${stderr.trim()}`, LOG_CONTEXT);
	return { authenticated: true, ...withAccount };
}

function ghLoginCommandFor(ghCommand: string): FeedbackGhLoginCommand {
	const args = [...GH_LOGIN_ARGS];
	return {
		command: ghCommand,
		args,
		display: formatAgentLoginCommand({ binary: ghCommand, args: args.join(' ') }),
	};
}

/**
 * The gh login the Feedback chat's "Log in to GitHub" runs, and that
 * `maestro-cli feedback login` runs, with the gh binary feedback itself uses
 * (a configured custom path wins).
 */
export async function getFeedbackGhLoginCommand(): Promise<FeedbackGhLoginCommand> {
	return ghLoginCommandFor(await resolveFeedbackGhCommand());
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
			return ghFailureResult(commentResult.stderr, 'Failed to add comment.');
		}
	}

	return { success: true };
}

/** Legacy one-shot submit: create a structured GitHub issue directly. */
export async function submitFeedback(
	rawPayload: FeedbackSubmitPayload
): Promise<{ success: boolean; error?: string }> {
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
	const { markdown } = await uploadAttachments(normalizedAttachments);
	await ensureFeedbackLabel();
	const environment = buildEnvironmentSummary(normalizedPayload);

	const bodyPath = path.join(os.tmpdir(), `maestro-feedback-body-${Date.now()}.md`);
	await fs.writeFile(bodyPath, buildIssueBody(normalizedPayload, environment, markdown), 'utf8');
	const issueCreate = await execFileNoThrow(
		await resolveFeedbackGhCommand(),
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
		return ghFailureResult(issueCreate.stderr, 'Failed to create GitHub issue.');
	}

	return { success: true };
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
	// An upload failure is reported as a result, not thrown: a throw crosses IPC
	// as "Error invoking remote method ...", burying the gh guidance it carries.
	let attachmentMarkdown: string;
	try {
		({ markdown: attachmentMarkdown } = await uploadAttachments(normalizedAttachments));
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : 'Failed to upload screenshots.',
			needsGhLogin: error instanceof GhCommandError && error.needsGhLogin,
		};
	}

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
			await resolveFeedbackGhCommand(),
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
			return ghFailureResult(issueCreate.stderr, 'Failed to create GitHub issue.');
		}

		// gh issue create prints the issue URL to stdout
		const issueUrl = issueCreate.stdout.trim();
		return { success: true, issueUrl: issueUrl || undefined };
	} finally {
		await fs.unlink(bodyFile).catch(() => {});
	}
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
