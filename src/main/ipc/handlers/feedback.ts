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
import { generateUUID } from '../../../shared/uuid';
import { parseImageDataUrl } from '../../../shared/imageDataUrl';
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
import { atomicWriteJson, createKeyedWriteQueue } from '../../utils/atomic-json-store';
import { readKeyedJsonArray } from '../../utils/json-file-readers';

const LOG_CONTEXT = '[Feedback]';
const ATTACHMENTS_REPO = 'maestro-feedback-attachments';
const MAX_SUMMARY_LENGTH = 120;
const MAX_FEEDBACK_FIELD_LENGTH = 5000;
const MAX_DRAFTS = 30;
const MAX_DRAFT_ATTACHMENTS = 5;
const MAX_DRAFT_MESSAGES = 200;
const MAX_DRAFT_MESSAGE_LENGTH = 20000;
const DRAFTS_FILE_NAME = 'feedback-drafts.json';
const SUBMITTED_ISSUES_FILE_NAME = 'feedback-submitted-issues.json';
const MAX_SUBMITTED_ISSUES = 100;

type FeedbackCategory = 'bug_report' | 'feature_request' | 'improvement' | 'general_feedback';

interface SubmittedIssue {
	number: number;
	url: string;
	title: string;
	category: FeedbackCategory;
	submittedAt: number;
	state: 'open' | 'closed';
	lastCheckedAt: number;
}

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

export interface FeedbackDraftAttachment {
	id: string;
	name: string;
	dataUrl: string;
	sizeBytes: number;
}

export interface FeedbackDraftMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
	timestamp: number;
	confidence?: number;
	category?: FeedbackCategory;
	summary?: string;
}

export interface FeedbackDraftStructured {
	expectedBehavior: string;
	actualBehavior: string;
	reproductionSteps: string;
	additionalContext: string;
}

/**
 * The parsed assistant response captured when a draft reaches the submit-ready
 * state. Persisting it lets a resumed draft stay submittable without forcing
 * the user to send another message to regenerate the structured fields.
 */
export interface FeedbackDraftResponse {
	confidence: number;
	ready: boolean;
	message: string;
	category: FeedbackCategory;
	summary: string;
	structured: FeedbackDraftStructured;
}

export interface FeedbackDraft {
	id: string;
	suggestedName: string;
	category: FeedbackCategory;
	summary: string;
	confidence: number;
	agentType: string;
	messages: FeedbackDraftMessage[];
	attachments: FeedbackDraftAttachment[];
	inputDraft: string;
	includeDebugPackage: boolean;
	createdAt: number;
	updatedAt: number;
	lastResponse?: FeedbackDraftResponse | null;
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

function isPersistedRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasPersistedFields(
	value: Record<string, unknown>,
	stringFields: readonly string[],
	numberFields: readonly string[]
): boolean {
	return (
		stringFields.every((field) => typeof value[field] === 'string') &&
		numberFields.every((field) => typeof value[field] === 'number' && Number.isFinite(value[field]))
	);
}

function isFeedbackDraftMessage(value: unknown): boolean {
	if (!isPersistedRecord(value) || !hasPersistedFields(value, ['role', 'content'], ['timestamp'])) {
		return false;
	}
	return (
		(value.role === 'user' || value.role === 'assistant' || value.role === 'system') &&
		(value.confidence === undefined ||
			(typeof value.confidence === 'number' && Number.isFinite(value.confidence))) &&
		(value.category === undefined || isFeedbackCategory(value.category)) &&
		(value.summary === undefined || typeof value.summary === 'string')
	);
}

function isFeedbackDraftAttachment(value: unknown): boolean {
	return (
		isPersistedRecord(value) && hasPersistedFields(value, ['id', 'name', 'dataUrl'], ['sizeBytes'])
	);
}

function isFeedbackDraftResponse(value: unknown): boolean {
	if (
		!isPersistedRecord(value) ||
		!hasPersistedFields(value, ['message', 'summary'], ['confidence']) ||
		typeof value.ready !== 'boolean' ||
		!isFeedbackCategory(value.category) ||
		!isPersistedRecord(value.structured)
	) {
		return false;
	}
	return hasPersistedFields(
		value.structured,
		['expectedBehavior', 'actualBehavior', 'reproductionSteps', 'additionalContext'],
		[]
	);
}

function isFeedbackDraft(value: unknown): value is FeedbackDraft {
	if (
		!isPersistedRecord(value) ||
		!hasPersistedFields(
			value,
			['id', 'suggestedName', 'summary', 'agentType', 'inputDraft'],
			['confidence', 'createdAt', 'updatedAt']
		) ||
		!isFeedbackCategory(value.category) ||
		typeof value.includeDebugPackage !== 'boolean' ||
		!Array.isArray(value.messages) ||
		!Array.isArray(value.attachments)
	) {
		return false;
	}
	return (
		value.messages.every(isFeedbackDraftMessage) &&
		value.attachments.every(isFeedbackDraftAttachment) &&
		(value.lastResponse === undefined ||
			value.lastResponse === null ||
			isFeedbackDraftResponse(value.lastResponse))
	);
}

function isSubmittedIssue(value: unknown): value is SubmittedIssue {
	if (
		!isPersistedRecord(value) ||
		!hasPersistedFields(value, ['url', 'title'], ['number', 'submittedAt', 'lastCheckedAt']) ||
		!isFeedbackCategory(value.category)
	) {
		return false;
	}
	return value.state === 'open' || value.state === 'closed';
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

/**
 * Resolve the path to the persisted feedback drafts file (a single
 * app-global JSON document under userData, mirroring playbooks' storage).
 */
function getDraftsFilePath(): string {
	return path.join(app.getPath('userData'), DRAFTS_FILE_NAME);
}

// Serialize every read-modify-write cycle against the single drafts file so
// concurrent autosave + manual saves (and deletes) cannot interleave and
// clobber each other. Backed by the shared keyed-write-queue utility, with
// atomicWriteJson giving partial-read-safe writes (mirrors group-chat-storage).
const draftsWriteQueue = createKeyedWriteQueue();
const enqueueDraftWrite = <T>(fn: () => Promise<T>): Promise<T> =>
	draftsWriteQueue.enqueue(DRAFTS_FILE_NAME, fn);

/**
 * Read all persisted feedback drafts. Returns an empty array when the file is
 * missing or malformed, matching readPlaybooks() in playbooks.ts.
 */
async function readDrafts(): Promise<FeedbackDraft[]> {
	return (await readKeyedJsonArray(getDraftsFilePath(), 'drafts', isFeedbackDraft)) ?? [];
}

/**
 * Persist the full drafts list. Ensures the parent directory exists for parity
 * with writePlaybooks(); userData itself already exists at runtime.
 */
async function writeDrafts(drafts: FeedbackDraft[]): Promise<void> {
	const filePath = getDraftsFilePath();
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await atomicWriteJson(filePath, { drafts });
}

/** Resolve the submitted-issue history file (mirrors getDraftsFilePath). */
function getSubmittedIssuesFilePath(): string {
	return path.join(app.getPath('userData'), SUBMITTED_ISSUES_FILE_NAME);
}

// Serialize read-modify-write cycles against the single history file so a
// record-on-submit, a delete, and a state refresh cannot interleave and clobber
// each other (mirrors the drafts write queue above).
const submittedIssuesWriteQueue = createKeyedWriteQueue();
const enqueueSubmittedIssuesWrite = <T>(fn: () => Promise<T>): Promise<T> =>
	submittedIssuesWriteQueue.enqueue(SUBMITTED_ISSUES_FILE_NAME, fn);

async function readSubmittedIssues(): Promise<SubmittedIssue[]> {
	return (await readKeyedJsonArray(getSubmittedIssuesFilePath(), 'issues', isSubmittedIssue)) ?? [];
}

async function writeSubmittedIssues(issues: SubmittedIssue[]): Promise<void> {
	const filePath = getSubmittedIssuesFilePath();
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await atomicWriteJson(filePath, { issues });
}

/**
 * Record a freshly-created issue in the submitted-issue history. Best-effort: a
 * persistence failure must never fail the submit that produced it.
 */
async function recordSubmittedIssue(params: {
	issueUrl: string;
	title: string;
	category: FeedbackCategory;
}): Promise<void> {
	const match = params.issueUrl.match(/\/issues\/(\d+)/);
	if (!match) return;
	const number = Number(match[1]);
	if (!Number.isFinite(number)) return;
	try {
		await enqueueSubmittedIssuesWrite(async () => {
			const issues = await readSubmittedIssues();
			const now = Date.now();
			const idx = issues.findIndex((i) => i.number === number);
			const entry: SubmittedIssue = {
				number,
				url: params.issueUrl,
				title: params.title,
				category: params.category,
				submittedAt: idx >= 0 ? issues[idx].submittedAt : now,
				state: 'open',
				lastCheckedAt: now,
			};
			if (idx >= 0) issues[idx] = entry;
			else issues.push(entry);
			issues.sort((a, b) => b.submittedAt - a.submittedAt);
			await writeSubmittedIssues(issues.slice(0, MAX_SUBMITTED_ISSUES));
		});
	} catch (e) {
		void captureException(e);
		logger.warn(`Failed to record submitted issue: ${e}`, LOG_CONTEXT);
	}
}

/**
 * Fetch current open/closed state for the given issue numbers via a single
 * `gh api graphql` call. Returns null on any gh/network/auth failure so callers
 * can fall back to cached state.
 */
async function fetchIssueStates(numbers: number[]): Promise<Map<number, 'open' | 'closed'> | null> {
	const unique = Array.from(new Set(numbers.filter((n) => Number.isFinite(n))));
	if (unique.length === 0) return new Map();
	const fields = unique.map((n) => `i${n}: issue(number: ${n}) { number state }`).join(' ');
	const query = `query { repository(owner: "RunMaestro", name: "Maestro") { ${fields} } }`;
	const result = await execFileNoThrow(
		'gh',
		['api', 'graphql', '-f', `query=${query}`],
		undefined,
		getExpandedEnv()
	);
	if (result.exitCode !== 0) return null;
	try {
		const repo = JSON.parse(result.stdout)?.data?.repository;
		if (!repo || typeof repo !== 'object') return null;
		const states = new Map<number, 'open' | 'closed'>();
		for (const value of Object.values(repo)) {
			const issue = value as { number?: number; state?: string } | null;
			if (issue && typeof issue.number === 'number' && typeof issue.state === 'string') {
				states.set(issue.number, issue.state.toUpperCase() === 'CLOSED' ? 'closed' : 'open');
			}
		}
		return states;
	} catch {
		return null;
	}
}

/**
 * Validate + clamp a single draft attachment, dropping anything that is not a
 * base64 image data URL (reuses the submit handler's attachment filter style).
 */
function normalizeDraftAttachments(raw: unknown): FeedbackDraftAttachment[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter(
			(a): a is FeedbackDraftAttachment =>
				Boolean(a) &&
				typeof a.id === 'string' &&
				typeof a.name === 'string' &&
				typeof a.dataUrl === 'string' &&
				a.dataUrl.startsWith('data:image/') &&
				typeof a.sizeBytes === 'number'
		)
		.slice(0, MAX_DRAFT_ATTACHMENTS)
		.map((a) => ({
			id: a.id,
			name: sanitizeTextInput(a.name).slice(0, MAX_SUMMARY_LENGTH) || a.name,
			dataUrl: a.dataUrl,
			sizeBytes: a.sizeBytes,
		}));
}

/**
 * Validate + clamp a single draft message. Returns null for non-object input.
 */
function normalizeDraftMessage(raw: unknown): FeedbackDraftMessage | null {
	if (!raw || typeof raw !== 'object') return null;
	const m = raw as Record<string, unknown>;
	const role: FeedbackDraftMessage['role'] =
		m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
	const content = typeof m.content === 'string' ? m.content.slice(0, MAX_DRAFT_MESSAGE_LENGTH) : '';
	const message: FeedbackDraftMessage = {
		role,
		content,
		timestamp: typeof m.timestamp === 'number' ? m.timestamp : Date.now(),
	};
	if (typeof m.confidence === 'number') {
		message.confidence = m.confidence;
	}
	if (isFeedbackCategory(m.category)) {
		message.category = m.category;
	}
	if (typeof m.summary === 'string') {
		message.summary = m.summary.slice(0, MAX_SUMMARY_LENGTH);
	}
	return message;
}

/**
 * Validate + clamp the persisted submit-ready response. Returns null when the
 * payload is absent or malformed so a resumed draft simply behaves as not-ready.
 */
function normalizeDraftResponse(raw: unknown): FeedbackDraftResponse | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const structuredRaw =
		r.structured && typeof r.structured === 'object'
			? (r.structured as Record<string, unknown>)
			: {};
	const clampField = (value: unknown): string =>
		typeof value === 'string' ? value.slice(0, MAX_DRAFT_MESSAGE_LENGTH) : '';
	return {
		confidence:
			typeof r.confidence === 'number' ? Math.max(0, Math.min(100, Math.round(r.confidence))) : 0,
		ready: r.ready === true,
		message: typeof r.message === 'string' ? r.message.slice(0, MAX_DRAFT_MESSAGE_LENGTH) : '',
		category: isFeedbackCategory(r.category) ? r.category : 'general_feedback',
		summary: typeof r.summary === 'string' ? r.summary.slice(0, MAX_SUMMARY_LENGTH) : '',
		structured: {
			expectedBehavior: clampField(structuredRaw.expectedBehavior),
			actualBehavior: clampField(structuredRaw.actualBehavior),
			reproductionSteps: clampField(structuredRaw.reproductionSteps),
			additionalContext: clampField(structuredRaw.additionalContext),
		},
	};
}

/**
 * Sanitize an incoming draft payload into a fully-formed FeedbackDraft,
 * minting an id when one is not supplied (the renderer normally supplies it).
 */
function normalizeDraft(raw: unknown): FeedbackDraft {
	const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const now = Date.now();
	const messages = Array.isArray(d.messages)
		? (d.messages
				.map(normalizeDraftMessage)
				.filter((m): m is FeedbackDraftMessage => m !== null)
				.slice(-MAX_DRAFT_MESSAGES) as FeedbackDraftMessage[])
		: [];
	const confidence =
		typeof d.confidence === 'number' ? Math.max(0, Math.min(100, Math.round(d.confidence))) : 0;
	return {
		id: typeof d.id === 'string' && d.id ? d.id : generateUUID(),
		suggestedName:
			typeof d.suggestedName === 'string'
				? sanitizeTextInput(d.suggestedName).slice(0, MAX_SUMMARY_LENGTH)
				: '',
		category: isFeedbackCategory(d.category) ? d.category : 'general_feedback',
		summary:
			typeof d.summary === 'string'
				? sanitizeTextInput(d.summary).slice(0, MAX_SUMMARY_LENGTH)
				: '',
		confidence,
		agentType: typeof d.agentType === 'string' && d.agentType ? d.agentType : 'claude-code',
		messages,
		attachments: normalizeDraftAttachments(d.attachments),
		inputDraft:
			typeof d.inputDraft === 'string'
				? sanitizeTextInput(d.inputDraft).slice(0, MAX_DRAFT_MESSAGE_LENGTH)
				: '',
		includeDebugPackage: d.includeDebugPackage === true,
		createdAt: typeof d.createdAt === 'number' ? d.createdAt : now,
		updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : now,
		lastResponse: normalizeDraftResponse(d.lastResponse),
	};
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
	const parsed = parseImageDataUrl(attachment.dataUrl, { filename: attachment.name });
	if (!parsed) {
		throw new Error(`Unsupported image data for ${attachment.name}.`);
	}

	const hasExtension = /\.[a-zA-Z0-9]+$/.test(attachment.name);
	const filename = hasExtension ? attachment.name : `${attachment.name}.${parsed.extension}`;
	return { base64: parsed.base64, filename };
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

/**
 * Upload a local .zip (debug package or performance trace) to the public
 * attachments repo and return a markdown link, or '' on failure. Shared by the
 * support-package and performance-trace paths so the upload logic lives once.
 */
async function uploadFeedbackZip(zipPath: string, linkText: string): Promise<string> {
	const zipData = await fs.readFile(zipPath);
	const zipBase64 = zipData.toString('base64');
	const owner = await getGitHubLogin();
	await ensureAttachmentsRepo(owner);
	const zipFilename = path.basename(zipPath);
	const repoPath = `feedback/${Date.now()}-${zipFilename}`;
	const payloadPath = path.join(os.tmpdir(), `maestro-feedback-zip-${Date.now()}.json`);
	await fs.writeFile(
		payloadPath,
		JSON.stringify({
			message: `Add feedback attachment ${Date.now()}`,
			content: zipBase64,
		}),
		'utf8'
	);
	try {
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
		if (uploadResult.exitCode !== 0) {
			return '';
		}
		const uploadJson = JSON.parse(uploadResult.stdout);
		const rawUrl =
			uploadJson.content?.download_url ||
			`https://raw.githubusercontent.com/${owner}/${ATTACHMENTS_REPO}/main/${repoPath}`;
		return `[${linkText}](${rawUrl})`;
	} finally {
		await fs.unlink(payloadPath).catch(() => {});
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

				const issueUrl = issueCreate.stdout.trim();
				if (issueUrl) {
					await recordSubmittedIssue({
						issueUrl,
						title: buildIssueTitle(normalizedPayload.category, normalizedPayload.summary),
						category: normalizedPayload.category,
					});
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
				performanceTracePath?: string;
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
						const packageResult = await generateDebugPackage(os.tmpdir(), _deps.debugPackageDeps);
						if (packageResult.success && packageResult.path) {
							try {
								debugPackageMarkdown = await uploadFeedbackZip(
									packageResult.path,
									'maestro-debug-package.zip'
								);
							} finally {
								await fs.unlink(packageResult.path).catch(() => {});
							}
						}
					} catch (e) {
						void captureException(e);
						logger.warn(`Failed to generate/upload debug package: ${e}`, LOG_CONTEXT);
					}
				}

				// Upload performance trace if one was captured from the modal. The temp
				// zip is consumed here and deleted regardless of upload outcome.
				let performanceTraceMarkdown = '';
				if (typeof payload.performanceTracePath === 'string' && payload.performanceTracePath) {
					try {
						performanceTraceMarkdown = await uploadFeedbackZip(
							payload.performanceTracePath,
							'maestro-performance-trace.zip'
						);
					} catch (e) {
						void captureException(e);
						logger.warn(`Failed to upload performance trace: ${e}`, LOG_CONTEXT);
					} finally {
						await fs.unlink(payload.performanceTracePath).catch(() => {});
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
					performanceTraceMarkdown ? `## Performance Trace\n${performanceTraceMarkdown}` : null,
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
					if (issueUrl) {
						await recordSubmittedIssue({ issueUrl, title, category: payload.category });
					}
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

	// List persisted feedback drafts, most-recently-updated first so the
	// renderer can treat drafts[0] as the "most recent" draft.
	ipcMain.handle(
		'feedback:drafts:list',
		withIpcErrorLogging(
			handlerOpts('drafts-list'),
			async (): Promise<{ drafts: FeedbackDraft[] }> => {
				const drafts = await readDrafts();
				drafts.sort((a, b) => b.updatedAt - a.updatedAt);
				return { drafts };
			}
		)
	);

	// Upsert a draft by id (renderer supplies the id; a new one is minted when
	// missing), then persist the trimmed, most-recent-first list.
	ipcMain.handle(
		'feedback:drafts:save',
		withIpcErrorLogging(
			handlerOpts('drafts-save'),
			async (draft: unknown): Promise<{ draft: FeedbackDraft }> => {
				const incoming = normalizeDraft(draft);
				return enqueueDraftWrite(async () => {
					const drafts = await readDrafts();
					const now = Date.now();
					const index = drafts.findIndex((d) => d.id === incoming.id);
					let saved: FeedbackDraft;
					if (index >= 0) {
						saved = {
							...drafts[index],
							...incoming,
							createdAt: drafts[index].createdAt,
							updatedAt: now,
						};
						drafts[index] = saved;
					} else {
						saved = { ...incoming, createdAt: now, updatedAt: now };
						drafts.push(saved);
					}
					drafts.sort((a, b) => b.updatedAt - a.updatedAt);
					await writeDrafts(drafts.slice(0, MAX_DRAFTS));
					return { draft: saved };
				});
			}
		)
	);

	// Delete a draft by id, then persist the remaining list.
	ipcMain.handle(
		'feedback:drafts:delete',
		withIpcErrorLogging(
			handlerOpts('drafts-delete'),
			async (payload: { id?: string }): Promise<Record<string, never>> => {
				const id = typeof payload?.id === 'string' ? payload.id : '';
				await enqueueDraftWrite(async () => {
					const drafts = await readDrafts();
					const next = drafts.filter((d) => d.id !== id);
					await writeDrafts(next);
				});
				return {};
			}
		)
	);

	// List submitted-issue history, most-recent-first.
	ipcMain.handle(
		'feedback:issues:list',
		withIpcErrorLogging(
			handlerOpts('issues-list'),
			async (): Promise<{ issues: SubmittedIssue[] }> => {
				const issues = await readSubmittedIssues();
				issues.sort((a, b) => b.submittedAt - a.submittedAt);
				return { issues };
			}
		)
	);

	// Delete one history record locally (does not touch GitHub).
	ipcMain.handle(
		'feedback:issues:delete',
		withIpcErrorLogging(
			handlerOpts('issues-delete'),
			async (payload: { number?: number }): Promise<Record<string, never>> => {
				const number = typeof payload?.number === 'number' ? payload.number : NaN;
				await enqueueSubmittedIssuesWrite(async () => {
					const issues = await readSubmittedIssues();
					await writeSubmittedIssues(issues.filter((i) => i.number !== number));
				});
				return {};
			}
		)
	);

	// Refresh open/closed state for stored issues via one gh GraphQL call.
	// Falls back to the cached list unchanged on any gh/network/auth error.
	ipcMain.handle(
		'feedback:issues:refresh-states',
		withIpcErrorLogging(
			handlerOpts('issues-refresh-states'),
			async (): Promise<{ issues: SubmittedIssue[] }> => {
				const stored = await readSubmittedIssues();
				stored.sort((a, b) => b.submittedAt - a.submittedAt);
				if (stored.length === 0) return { issues: stored };

				const states = await fetchIssueStates(stored.map((i) => i.number));
				if (!states) return { issues: stored };

				const now = Date.now();
				const next = stored.map((issue) => {
					const state = states.get(issue.number);
					return state ? { ...issue, state, lastCheckedAt: now } : issue;
				});
				// Re-read before persisting so a concurrent delete is not clobbered.
				await enqueueSubmittedIssuesWrite(async () => {
					const current = await readSubmittedIssues();
					const byNumber = new Map(next.map((i) => [i.number, i]));
					await writeSubmittedIssues(current.map((i) => byNumber.get(i.number) ?? i));
				});
				return { issues: next };
			}
		)
	);
}
