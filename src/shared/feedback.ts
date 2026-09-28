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
