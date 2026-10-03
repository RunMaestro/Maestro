/**
 * `maestro-cli feedback ...` - everything the Send Feedback modal does, for an
 * agent: check `gh`, search for duplicates, +1 an existing issue, or file a new
 * structured one with screenshots and an optional support package.
 *
 * The modal interviews the user with an agent and fills the same structured
 * fields; a CLI caller IS an agent, so it supplies those fields directly. The
 * issue is filed by the app's own feedback service (`src/main/feedback`), so it
 * is byte-for-byte what the modal would have filed.
 *
 * `feedback submit` searches for duplicates first and stops when it finds any,
 * the way the modal shows matches before it files. `--force` files anyway;
 * `feedback subscribe <n>` adds to the existing issue instead.
 */

import * as fs from 'fs';
import * as path from 'path';
import { withMaestroClient } from '../services/maestro-client';
import { ExitCode, exitCodeForError, exitWith } from '../exit-codes';
import { resolveCliPath } from '../utils/parse';
import { getImageMimeType } from '../../shared/gitUtils';
import { formatSize } from '../../shared/formatters';
import {
	FEEDBACK_CATEGORY_ALIASES,
	MAX_FEEDBACK_ATTACHMENTS,
	MAX_FEEDBACK_ATTACHMENT_BYTES,
	resolveFeedbackCategory,
	type FeedbackAttachmentPayload,
	type FeedbackConversationSubmitPayload,
	type FeedbackIssueMatch,
	type FeedbackSubmitResponse,
} from '../../shared/feedback';

/**
 * Filing uploads screenshots, may build and upload a support package, and runs
 * several `gh` calls in sequence. The default 10s command timeout is far too
 * short for that.
 */
const SUBMIT_TIMEOUT_MS = 180_000;
/** Search fans out several `gh search` calls in parallel. */
const GH_TIMEOUT_MS = 60_000;

/** Extensions the modal's drop zone advertises. */
const ATTACHMENT_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

interface JsonOption {
	json?: boolean;
}

interface SubmitOptions extends JsonOption {
	category: string;
	summary: string;
	expected: string;
	actual: string;
	steps?: string;
	context?: string;
	attach?: string[];
	supportPackage?: boolean;
	force?: boolean;
}

interface SubscribeOptions extends JsonOption {
	comment?: string;
}

/** Print a failure in the caller's format and exit with `code`. */
function fail(message: string, options: JsonOption, code: ExitCode, extra?: object): never {
	if (options.json) {
		console.log(JSON.stringify({ success: false, error: message, ...extra }));
	} else {
		console.error(`Error: ${message}`);
	}
	return exitWith(code);
}

function failFromError(error: unknown, options: JsonOption): never {
	const message = error instanceof Error ? error.message : String(error);
	return fail(message, options, exitCodeForError(error));
}

/**
 * Read `--attach` files into the data URLs the feedback service uploads.
 * Enforces the modal's limits here so a bad file fails before anything is
 * uploaded, not halfway through filing.
 */
export function readAttachments(paths: string[]): FeedbackAttachmentPayload[] {
	if (paths.length > MAX_FEEDBACK_ATTACHMENTS) {
		throw new Error(
			`At most ${MAX_FEEDBACK_ATTACHMENTS} screenshots can be attached (got ${paths.length}).`
		);
	}
	return paths.map((input) => {
		const filePath = resolveCliPath(input);
		const ext = path.extname(filePath).slice(1).toLowerCase();
		if (!ATTACHMENT_EXTENSIONS.has(ext)) {
			throw new Error(`${input}: screenshots must be PNG, JPG, GIF, or WebP.`);
		}
		let size: number;
		try {
			size = fs.statSync(filePath).size;
		} catch {
			throw new Error(`${input}: file not found.`);
		}
		if (size > MAX_FEEDBACK_ATTACHMENT_BYTES) {
			throw new Error(
				`${input}: ${formatSize(size)} exceeds the ${formatSize(MAX_FEEDBACK_ATTACHMENT_BYTES)} limit.`
			);
		}
		const base64 = fs.readFileSync(filePath).toString('base64');
		return {
			name: path.basename(filePath),
			dataUrl: `data:${getImageMimeType(ext)};base64,${base64}`,
		};
	});
}

function printIssues(issues: FeedbackIssueMatch[]): void {
	for (const issue of issues) {
		const labels = issue.labels.length > 0 ? `  [${issue.labels.join(', ')}]` : '';
		console.log(`  #${issue.number}  ${issue.state.toLowerCase()}  ${issue.title}${labels}`);
		console.log(`         ${issue.url}`);
	}
}

async function searchIssues(query: string): Promise<FeedbackIssueMatch[]> {
	const result = await withMaestroClient((client) =>
		client.sendCommand<{ success: boolean; issues?: FeedbackIssueMatch[]; error?: string }>(
			{ type: 'feedback_search', query },
			'feedback_search_result',
			GH_TIMEOUT_MS
		)
	);
	if (!result.success) throw new Error(result.error || 'Issue search failed');
	return result.issues ?? [];
}

/** `feedback auth` - can feedback be filed from this machine at all. */
export async function feedbackAuth(options: JsonOption): Promise<void> {
	let result: { success: boolean; authenticated?: boolean; message?: string; error?: string };
	try {
		result = await withMaestroClient((client) =>
			client.sendCommand(
				{ type: 'feedback_check_auth' },
				'feedback_check_auth_result',
				GH_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options);
	}
	if (!result.success) fail(result.error || 'Auth check failed', options, ExitCode.GeneralError);

	const authenticated = result.authenticated === true;
	if (options.json) {
		console.log(JSON.stringify({ success: true, authenticated, message: result.message }));
	} else if (authenticated) {
		console.log('GitHub CLI is installed and authenticated. Feedback can be filed.');
	} else {
		console.log(result.message || 'GitHub CLI is not ready.');
	}
	if (!authenticated) exitWith(ExitCode.GeneralError);
}

/** `feedback search <query>` - possible duplicates on RunMaestro/Maestro. */
export async function feedbackSearch(query: string, options: JsonOption): Promise<void> {
	if (!query.trim()) fail('A search query is required.', options, ExitCode.InvalidUsage);
	let issues: FeedbackIssueMatch[];
	try {
		issues = await searchIssues(query);
	} catch (error) {
		failFromError(error, options);
	}
	if (options.json) {
		console.log(JSON.stringify({ success: true, issues }));
		return;
	}
	if (issues.length === 0) {
		console.log('No matching issues.');
		return;
	}
	console.log(`${issues.length} possible match${issues.length === 1 ? '' : 'es'}:`);
	printIssues(issues);
}

/** `feedback submit` - file a new issue, after a duplicate check. */
export async function feedbackSubmit(options: SubmitOptions): Promise<void> {
	const category = resolveFeedbackCategory(options.category);
	if (!category) {
		fail(
			`Unknown category "${options.category}". Use one of: ${Object.keys(FEEDBACK_CATEGORY_ALIASES).join(', ')}.`,
			options,
			ExitCode.InvalidUsage
		);
	}

	let attachments: FeedbackAttachmentPayload[];
	try {
		attachments = readAttachments(options.attach ?? []);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options, ExitCode.InvalidUsage);
	}

	// Duplicate check, exactly where the modal runs it: before filing.
	if (!options.force) {
		let matches: FeedbackIssueMatch[];
		try {
			matches = await searchIssues(options.summary);
		} catch (error) {
			failFromError(error, options);
		}
		if (matches.length > 0) {
			if (options.json) {
				console.log(
					JSON.stringify({ success: false, error: 'possible_duplicates', issues: matches })
				);
			} else {
				console.log('Possible duplicates found. Nothing was filed.');
				printIssues(matches);
				console.log('');
				console.log('Add to one:  maestro-cli feedback subscribe <number> --comment "<details>"');
				console.log('File anyway: re-run with --force');
			}
			exitWith(ExitCode.GeneralError);
		}
	}

	const payload: FeedbackConversationSubmitPayload = {
		category,
		summary: options.summary,
		expectedBehavior: options.expected,
		actualBehavior: options.actual,
		reproductionSteps: options.steps,
		additionalContext: options.context,
		attachments,
		includeDebugPackage: options.supportPackage === true,
	};

	let result: FeedbackSubmitResponse;
	try {
		result = await withMaestroClient((client) =>
			client.sendCommand<FeedbackSubmitResponse>(
				{ type: 'feedback_submit', payload },
				'feedback_submit_result',
				SUBMIT_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options);
	}
	const warnings = result.warnings ?? [];
	if (!result.success) {
		const message = result.error || 'Failed to file feedback';
		if (options.json) {
			fail(message, options, ExitCode.GeneralError, {
				fallbackIssueUrl: result.fallbackIssueUrl ?? null,
				warnings,
			});
		}
		console.error(`Error: ${message}`);
		// gh could not file it, but the report is not lost: the same issue,
		// prefilled, can be filed from a browser signed in to GitHub.
		if (result.fallbackIssueUrl) {
			console.error('');
			console.error('Nothing was lost. File the same report from your browser instead:');
			console.error(`  ${result.fallbackIssueUrl}`);
		}
		exitWith(ExitCode.GeneralError);
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, issueUrl: result.issueUrl ?? null, warnings }));
	} else {
		console.log(`Feedback filed: ${result.issueUrl ?? '(GitHub did not return a URL)'}`);
		for (const warning of warnings) {
			console.log(`Warning: ${warning}`);
		}
	}
}

/** `feedback subscribe <issue>` - +1 an existing issue, optionally commenting. */
export async function feedbackSubscribe(issue: string, options: SubscribeOptions): Promise<void> {
	const issueNumber = Number(issue.replace(/^#/, ''));
	if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
		fail(`"${issue}" is not an issue number.`, options, ExitCode.InvalidUsage);
	}
	let result: { success: boolean; error?: string };
	try {
		result = await withMaestroClient((client) =>
			client.sendCommand(
				{ type: 'feedback_subscribe', issueNumber, comment: options.comment },
				'feedback_subscribe_result',
				GH_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options);
	}
	if (!result.success) {
		fail(result.error || 'Failed to subscribe to issue', options, ExitCode.GeneralError);
	}
	if (options.json) {
		console.log(JSON.stringify({ success: true, issueNumber }));
	} else {
		console.log(
			`Added +1 to #${issueNumber}${options.comment?.trim() ? ' with your comment' : ''}.`
		);
	}
}
