/**
 * Shared contract for in-app feedback (GitHub issues filed via `gh`).
 *
 * Three callers speak it: the desktop Feedback modal (over IPC), the preload
 * bridge, and `maestro-cli feedback` (over the WS bridge). The limits live here
 * so the CLI refuses exactly what the modal refuses, instead of letting the
 * main process reject a payload the caller already spent an upload on.
 */

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

export interface FeedbackAuthResponse {
	authenticated: boolean;
	message?: string;
}

export interface FeedbackSubmitResponse {
	success: boolean;
	error?: string;
	issueUrl?: string;
	/**
	 * When filing failed: a github.com "new issue" URL prefilled with the same
	 * title and body, so the report survives a `gh` that cannot file it (expired
	 * login, missing scope, an org OAuth restriction). Opening it in a browser
	 * uses the browser's GitHub session instead of gh's.
	 */
	fallbackIssueUrl?: string;
	/**
	 * Parts of the report that were dropped so the rest could be filed - a
	 * screenshot upload or the label that `gh` refused. The issue exists; these
	 * say what is missing from it.
	 */
	warnings?: string[];
}

export const FEEDBACK_REPO = 'RunMaestro/Maestro';
export const FEEDBACK_LABEL = 'Maestro-feedback';

/**
 * GitHub answers a request line much longer than this with a 414, and browsers
 * start truncating not far past it, so the body is cut to keep the whole URL
 * under the limit.
 */
export const MAX_PREFILLED_ISSUE_URL_LENGTH = 8000;

const PREFILL_TRUNCATION_NOTE =
	'\n\n_(Truncated to fit in a URL. Paste the rest of the details as a comment.)_';

/**
 * Build a github.com "new issue" URL prefilled with `title` and `body`.
 *
 * The body is shortened (never the title) until the encoded URL fits under
 * {@link MAX_PREFILLED_ISSUE_URL_LENGTH}. Cutting is done on the raw text and
 * re-encoded each time, because a cut taken from the encoded string can split
 * a percent escape and produce a URL GitHub rejects.
 */
export function buildPrefilledIssueUrl(title: string, body: string): string {
	const build = (text: string) =>
		`https://github.com/${FEEDBACK_REPO}/issues/new?${new URLSearchParams({
			title,
			body: text,
			labels: FEEDBACK_LABEL,
		}).toString()}`;

	let url = build(body);
	if (url.length <= MAX_PREFILLED_ISSUE_URL_LENGTH) return url;

	let keep = body.length;
	while (keep > 0) {
		// Shrink proportionally to the overshoot; encoding expands text unevenly,
		// so this converges in a few passes rather than landing in one.
		const overshoot = url.length - MAX_PREFILLED_ISSUE_URL_LENGTH;
		keep = Math.max(0, keep - Math.max(overshoot, 64));
		url = build(body.slice(0, keep).trimEnd() + PREFILL_TRUNCATION_NOTE);
		if (url.length <= MAX_PREFILLED_ISSUE_URL_LENGTH) return url;
	}
	return build(PREFILL_TRUNCATION_NOTE.trim());
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
