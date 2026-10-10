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
import { runGhLogin } from '../services/gh-login';
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
	type FeedbackAuthResponse,
	type FeedbackConversationSubmitPayload,
	type FeedbackGhLoginCommand,
	type FeedbackIssueMatch,
} from '../../shared/feedback';
import {
	describeFeedbackAccountStatus,
	isFeedbackAccountUsable,
	type FeedbackAccountsResponse,
} from '../../shared/feedbackAccounts';

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

type AuthResult = { success: boolean; error?: string } & Partial<FeedbackAuthResponse>;

/** Ask the app whether gh can file feedback. `fresh` skips the cached verdict. */
async function checkAuth(fresh: boolean): Promise<AuthResult> {
	return withMaestroClient((client) =>
		client.sendCommand(
			{ type: 'feedback_check_auth', ...(fresh ? { fresh: true } : {}) },
			'feedback_check_auth_result',
			GH_TIMEOUT_MS
		)
	);
}

/** Print an auth verdict: the same reason the Feedback modal shows, plus the fix. */
function printAuth(result: AuthResult): void {
	const as = result.account ? ` as ${result.account.login} @ ${result.account.host}` : '';
	if (result.authenticated) {
		console.log(`GitHub CLI is signed in${as} and can file issues. Feedback can be filed.`);
		return;
	}
	if (as) console.log(`GitHub CLI is signed in${as}.`);
	console.log(result.message || 'GitHub CLI is not ready.');
	if (result.reason === 'not-authenticated' || result.needsGhLogin) {
		if (result.login) console.log(`Sign in with:  ${result.login.display}`);
		console.log('Or run:        maestro-cli feedback login');
	}
}

interface AuthOptions extends JsonOption {
	fresh?: boolean;
}

/** `feedback auth` - can feedback be filed from this machine at all. */
export async function feedbackAuth(options: AuthOptions): Promise<void> {
	let result: AuthResult;
	try {
		result = await checkAuth(options.fresh === true);
	} catch (error) {
		failFromError(error, options);
	}
	if (!result.success) fail(result.error || 'Auth check failed', options, ExitCode.GeneralError);

	const authenticated = result.authenticated === true;
	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				authenticated,
				message: result.message,
				reason: result.reason,
				needsGhLogin: result.needsGhLogin,
				login: result.login,
				account: result.account,
			})
		);
	} else {
		printAuth(result);
	}
	if (!authenticated) exitWith(ExitCode.GeneralError);
}

/**
 * `feedback login` - sign the GitHub CLI in, the way the Feedback modal's
 * "Log in to GitHub" does: the same gh binary (a configured custom path wins)
 * and the same device-code web flow, run here with this terminal attached.
 * Re-checks afterwards, skipping the cached verdict.
 *
 * Runs even when gh already reports signed in: an organization's OAuth
 * restriction refuses a token `gh auth status` calls valid, and signing in
 * again is where the user approves the organization.
 */
export async function feedbackLogin(options: JsonOption): Promise<void> {
	let login: { success: boolean; error?: string } & Partial<FeedbackGhLoginCommand>;
	try {
		const before = await checkAuth(true);
		if (before.success && before.reason === 'not-installed') {
			fail(before.message || 'GitHub CLI (gh) is not installed.', options, ExitCode.GeneralError);
		}
		login = await withMaestroClient((client) =>
			client.sendCommand({ type: 'feedback_gh_login_command' }, 'feedback_gh_login_command_result')
		);
	} catch (error) {
		failFromError(error, options);
	}
	if (!login.success || !login.command || !login.args) {
		fail(login.error || 'Could not resolve the gh login command.', options, ExitCode.GeneralError);
	}
	const command: FeedbackGhLoginCommand = {
		command: login.command,
		args: login.args,
		display: login.display ?? login.command,
	};

	if (!options.json) console.log(`Running: ${command.display}`);
	let code: number;
	try {
		code = await runGhLogin(command, options.json === true);
	} catch (error) {
		failFromError(error, options);
	}

	let after: AuthResult;
	try {
		after = await checkAuth(true);
	} catch (error) {
		failFromError(error, options);
	}
	const authenticated = after.success && after.authenticated === true;
	if (options.json) {
		console.log(
			JSON.stringify({
				success: authenticated,
				exitCode: code,
				authenticated,
				message: after.message,
				reason: after.reason,
				account: after.account,
			})
		);
	} else {
		if (code !== 0) console.log(`gh exited with code ${code}.`);
		printAuth(after);
	}
	if (!authenticated) exitWith(ExitCode.GeneralError);
}

interface AccountsOptions extends JsonOption {
	use?: string;
	clear?: boolean;
}

/**
 * `feedback accounts` - which provider account the Feedback chat runs as. The
 * chat tries them in this order and falls through to the next when a first
 * turn fails; `--use` is the chat's account picker.
 */
export async function feedbackAccounts(options: AccountsOptions): Promise<void> {
	if (options.use !== undefined && options.clear) {
		fail('Pass --use or --clear, not both.', options, ExitCode.InvalidUsage);
	}
	const use = options.clear ? null : options.use;
	let result: { success: boolean; error?: string } & Partial<FeedbackAccountsResponse>;
	try {
		result = await withMaestroClient((client) =>
			client.sendCommand(
				{ type: 'feedback_accounts', ...(use !== undefined ? { use } : {}) },
				'feedback_accounts_result'
			)
		);
	} catch (error) {
		failFromError(error, options);
	}
	if (!result.success)
		fail(result.error || 'Listing accounts failed', options, ExitCode.GeneralError);

	const accounts = result.accounts ?? [];
	const lastWorkingKey = result.lastWorkingKey ?? null;
	const pick = accounts.find(isFeedbackAccountUsable) ?? null;
	if (options.json) {
		console.log(
			JSON.stringify({ success: true, accounts, lastWorkingKey, pickKey: pick?.key ?? null })
		);
		return;
	}
	if (accounts.length === 0) {
		console.log(
			'No Claude Code, Codex, or OpenCode account found. Install one to use the Feedback chat.'
		);
		exitWith(ExitCode.GeneralError);
	}
	for (const account of accounts) {
		const marker = account === pick ? '>' : ' ';
		const agents =
			account.agentNames.length > 0 ? ` - agents: ${account.agentNames.join(', ')}` : '';
		const detail = account.statusDetail ? ` (${account.statusDetail})` : '';
		console.log(
			`${marker} ${account.label} [${describeFeedbackAccountStatus(account)}]${detail}${agents}`
		);
		console.log(`    key: ${account.key}`);
	}
	if (!pick) exitWith(ExitCode.GeneralError);
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

	let result: { success: boolean; issueUrl?: string; error?: string };
	try {
		result = await withMaestroClient((client) =>
			client.sendCommand(
				{ type: 'feedback_submit', payload },
				'feedback_submit_result',
				SUBMIT_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options);
	}
	if (!result.success) {
		fail(result.error || 'Failed to file feedback', options, ExitCode.GeneralError);
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, issueUrl: result.issueUrl ?? null }));
	} else {
		console.log(`Feedback filed: ${result.issueUrl ?? '(GitHub did not return a URL)'}`);
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
