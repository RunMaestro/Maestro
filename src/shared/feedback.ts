/**
 * Shared contract for in-app feedback (GitHub issues filed via `gh`).
 *
 * Three callers speak it: the desktop Feedback modal (over IPC), the preload
 * bridge, and `maestro-cli feedback` (over the WS bridge). The limits live here
 * so the CLI refuses exactly what the modal refuses, instead of letting the
 * main process reject a payload the caller already spent an upload on.
 */

import type { PlaybookFailureReportInput, PlaybookFailureRepo } from './playbookFailureCore';

export type FeedbackCategory =
	| 'bug_report'
	| 'feature_request'
	| 'improvement'
	| 'general_feedback';

export const FEEDBACK_CATEGORIES: readonly FeedbackCategory[] = [
	'bug_report',
	'feature_request',
	'improvement',
	'general_feedback',
];

/** Short spellings the CLI accepts for `--category`. */
export const FEEDBACK_CATEGORY_ALIASES: Readonly<Record<string, FeedbackCategory>> = {
	bug: 'bug_report',
	feature: 'feature_request',
	improvement: 'improvement',
	general: 'general_feedback',
};

export function isFeedbackCategory(value: unknown): value is FeedbackCategory {
	return typeof value === 'string' && (FEEDBACK_CATEGORIES as readonly string[]).includes(value);
}

/** Resolve a full category id or a short alias; `null` when neither matches. */
export function resolveFeedbackCategory(value: string): FeedbackCategory | null {
	const needle = value.trim().toLowerCase();
	if (isFeedbackCategory(needle)) return needle;
	return FEEDBACK_CATEGORY_ALIASES[needle] ?? null;
}

/** Screenshot limits enforced by the modal's drop zone and the CLI's `--attach`. */
export const MAX_FEEDBACK_ATTACHMENTS = 5;
export const MAX_FEEDBACK_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Field limits enforced by the main process before anything is filed. */
export const MAX_FEEDBACK_SUMMARY_LENGTH = 120;
export const MAX_FEEDBACK_FIELD_LENGTH = 5000;

/**
 * Arguments for signing the GitHub CLI in. The device-code web flow needs no
 * typed password or token, so it works the same from the embedded terminal,
 * a plain terminal, or an agent's non-interactive shell; the host and protocol
 * flags skip the two questions gh would otherwise ask first.
 */
export const GH_LOGIN_ARGS: readonly string[] = [
	'auth',
	'login',
	'--hostname',
	'github.com',
	'--git-protocol',
	'https',
	'--web',
];

/** The gh login to run, with the gh binary Feedback actually uses. */
export interface FeedbackGhLoginCommand {
	command: string;
	args: string[];
	/** The same thing as one posix command line, for messages. */
	display: string;
}

export interface FeedbackAuthResponse {
	authenticated: boolean;
	message?: string;
	/**
	 * Why feedback cannot be filed. Absent when `authenticated`.
	 * `no-repo-access`: gh is signed in, but GitHub refused this account an issue
	 * on the feedback repo (an org's OAuth restriction, a missing scope, a token
	 * the API rejects), so the check fails up front instead of at submit.
	 */
	reason?: 'not-installed' | 'not-authenticated' | 'no-repo-access';
	/**
	 * Whether signing gh in again can fix it. Always true for
	 * `not-authenticated`; for `no-repo-access` only when the refusal is one a
	 * fresh login addresses.
	 */
	needsGhLogin?: boolean;
	/** How to sign gh in. Present whenever `needsGhLogin` is. */
	login?: FeedbackGhLoginCommand;
	/** The GitHub account gh acts as, when gh names one. Shown as a pill. */
	account?: { host: string; login: string };
}

export interface FeedbackSubmitResponse {
	success: boolean;
	error?: string;
	issueUrl?: string;
	/**
	 * Parts of the report that were dropped so the rest could be filed: a
	 * screenshot that could not be uploaded, or a support package or performance
	 * trace that could not be built. The issue exists; these say what is missing
	 * from it.
	 */
	warnings?: string[];
	/**
	 * gh refused the request in a way signing in again can fix (expired or
	 * revoked token, org OAuth restriction, missing scope).
	 */
	needsGhLogin?: boolean;
}

export interface FeedbackAttachmentPayload {
	name: string;
	/** `data:image/<type>;base64,...` */
	dataUrl: string;
}

/** Legacy one-shot form (`feedback:submit`). */
export interface FeedbackSubmissionPayload {
	sessionId: string;
	category: FeedbackCategory;
	summary: string;
	expectedBehavior: string;
	details: string;
	reproductionSteps?: string;
	additionalContext?: string;
	agentProvider?: string;
	sshRemoteEnabled?: boolean;
	attachments?: FeedbackAttachmentPayload[];
}

/** What the conversational modal and `maestro-cli feedback submit` file. */
export interface FeedbackConversationSubmitPayload {
	category: FeedbackCategory;
	summary: string;
	expectedBehavior: string;
	actualBehavior: string;
	reproductionSteps?: string;
	additionalContext?: string;
	agentProvider?: string;
	sshRemoteEnabled?: boolean;
	attachments?: FeedbackAttachmentPayload[];
	/** Generate a support package and link it from the issue. */
	includeDebugPackage?: boolean;
	/**
	 * Absolute path to a temp performance-trace .zip captured via
	 * debug:stopProfilingToFile. When present, it is uploaded and linked in the
	 * issue body, then deleted.
	 */
	performanceTracePath?: string;
	/**
	 * Identity of this report as the user last reviewed it, from
	 * `feedbackReportFingerprint()`. The service refuses to file when the
	 * payload no longer matches, so a report cannot change between review and
	 * submit. Omit it when there is no separate review step (the CLI).
	 */
	reviewedFingerprint?: string;
}

/** The part of an attachment that identifies it in a report fingerprint. */
export interface FeedbackAttachmentIdentity {
	name: string;
}

/** What identifies one structured report, as the renderer and main agree on it. */
export interface FeedbackReportFingerprintInput {
	category: FeedbackCategory;
	summary: string;
	expectedBehavior: string;
	actualBehavior: string;
	reproductionSteps?: string;
	additionalContext?: string;
	includeDebugPackage?: boolean;
	attachments?: ReadonlyArray<FeedbackAttachmentIdentity>;
}

/**
 * Canonical identity of a structured report.
 *
 * Used to refuse a report that changed after the user reviewed it, and to
 * refuse filing the same report twice. Normalizes line endings and surrounding
 * whitespace per field so the renderer and the main process agree on the same
 * report, and scopes the identity to what the user wrote: text, attachment
 * names, and the support-package choice. Temp paths (the performance trace) are
 * deliberately excluded because they change on every capture.
 */
export function feedbackReportFingerprint(input: FeedbackReportFingerprintInput): string {
	const field = (value: string | undefined) =>
		(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
	return [
		input.category,
		field(input.summary),
		field(input.expectedBehavior),
		field(input.actualBehavior),
		field(input.reproductionSteps),
		field(input.additionalContext),
		input.includeDebugPackage ? 'debug-package' : '',
		(input.attachments ?? []).map((attachment) => field(attachment.name)).join('\u0000'),
	].join('\u0001');
}

/** One possible duplicate returned by the issue search. */
export interface FeedbackIssueMatch {
	number: number;
	title: string;
	url: string;
	state: string;
	labels: string[];
	createdAt: string;
	author: string;
	commentCount: number;
}

export interface FeedbackIssueSearchResponse {
	issues: FeedbackIssueMatch[];
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

/** A persisted, resumable Send Feedback conversation. */
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

/** One issue the user filed, kept locally so the modal can list its state. */
export interface SubmittedIssue {
	number: number;
	url: string;
	title: string;
	category: FeedbackCategory;
	submittedAt: number;
	state: 'open' | 'closed';
	lastCheckedAt: number;
}

// ============================================================================
// Playbook failure reports ("Report a problem" on a finished playbook run)
// ============================================================================

/** What the completion modal sends to preview or file a playbook failure. */
export interface PlaybookFailurePreviewPayload {
	report: PlaybookFailureReportInput;
	/** The pristine copy of the failing document; null when the import kept none. */
	pristineSource?: string | null;
}

export interface PlaybookFailureSubmitPayload extends PlaybookFailurePreviewPayload {
	/** Upload a support package and link it from the issue. Off unless the user ticks it. */
	includeDebugPackage?: boolean;
}

/** The issue exactly as it would be filed: the consent surface. */
export interface PlaybookFailureIssuePreview {
	repo: PlaybookFailureRepo;
	title: string;
	body: string;
	fingerprint: string;
}

/** A prefilled GitHub new-issue page, for when gh cannot file the issue. */
export interface PrefilledIssueUrl {
	url: string;
	/**
	 * The end of the body that did not fit in the URL, for the clipboard.
	 * Null when the whole body fits.
	 */
	overflow: string | null;
}

export interface PlaybookFailureSubmitResponse extends FeedbackSubmitResponse {
	repo?: PlaybookFailureRepo;
	/**
	 * An open issue already tracked this failure: a +1 and a recurrence comment
	 * were added to it, and `issueUrl` is that issue.
	 */
	deduplicated?: boolean;
	/** gh is missing or not signed in: file it in the browser instead. */
	browserFallback?: PrefilledIssueUrl;
}

/** How long a prefilled new-issue URL may get before the body moves to the clipboard. */
export const PREFILLED_ISSUE_URL_MAX_BYTES = 6 * 1024;

/** GitHub's new-issue page for `owner/repo`, with the title and body filled in. */
export function githubNewIssueUrl(repo: string, title: string, body: string): string {
	return `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

const CLIPBOARD_CONTINUATION_NOTE =
	'_This report was too long for the link. The rest of it is on your clipboard: paste it below this line._';

/**
 * A prefilled new-issue URL no longer than `maxBytes`. A body that does not
 * fit is cut at the last line break that fits (or mid-line when no line
 * break does), a note says the rest is on the clipboard, and the rest is
 * returned as `overflow`. `trailer` (a marker comment) is kept whole after the
 * note, so a cut body still carries it.
 */
export function cappedNewIssueUrl(
	repo: string,
	title: string,
	body: string,
	options: { trailer?: string; maxBytes?: number } = {}
): PrefilledIssueUrl {
	const maxBytes = options.maxBytes ?? PREFILLED_ISSUE_URL_MAX_BYTES;
	const trailer = options.trailer ? `\n\n${options.trailer}` : '';
	const whole = githubNewIssueUrl(repo, title, `${body}${trailer}`);
	if (whole.length <= maxBytes) return { url: whole, overflow: null };

	// encodeURIComponent output is ASCII, so its length is its byte count.
	const urlFor = (prefix: string) =>
		githubNewIssueUrl(repo, title, `${prefix}\n\n${CLIPBOARD_CONTINUATION_NOTE}${trailer}`);
	const fits = (end: number) => urlFor(body.slice(0, safeCut(body, end))).length <= maxBytes;

	let low = 0;
	let high = body.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits(mid)) low = mid;
		else high = mid - 1;
	}
	let cut = safeCut(body, low);
	const lineBreak = body.lastIndexOf('\n', cut);
	if (lineBreak > 0) cut = lineBreak;
	const prefix = body.slice(0, cut).trimEnd();
	return { url: urlFor(prefix), overflow: body.slice(cut).replace(/^\n+/, '') };
}

/** `end`, moved back one when it would split a surrogate pair (which cannot be URL-encoded). */
function safeCut(text: string, end: number): number {
	if (end <= 0 || end >= text.length) return Math.max(0, Math.min(end, text.length));
	const code = text.charCodeAt(end - 1);
	return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}
