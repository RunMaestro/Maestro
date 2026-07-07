/**
 * AgentRun rich-field producers (F2).
 *
 * These populate the rich fields of an AgentRun (touchedFiles, usage,
 * pullRequest, checks, reviews) from real process/git/gh state at the moment a
 * run settles. They live in `src/main/` - NEVER in `src/shared/agent-run/` -
 * so the pure core stays free of fs/electron/child_process (ISC-2.9). The
 * shell-touching producers (git diff, gh PR) run through the project's
 * `execFileNoThrow` helper, which never throws and reports failure via a
 * numeric/string exit code, so no producer can throw into the enrich path.
 *
 * The composed `buildEnrichHook()` returns the exact
 * `(run, exitCode) => Promise<Partial<AgentRun>>` hook that
 * `setupAgentRunCapture({ enrich })` expects. Every branch is wrapped so a
 * git/gh/usage failure degrades to a safe empty/undefined result and the
 * completion path stays green.
 *
 * Covers: ISC-2.1 (touchedFiles from git diff), ISC-2.2 (empty on non-repo),
 * ISC-2.3 (usage best-effort, undefined when no source), ISC-2.4 (recordCheck
 * mapper), ISC-2.5 (ingestReviewFindings mapper), ISC-2.6 (pullRequest via gh),
 * ISC-2.9 (main-only, no shared-core producer code).
 */

import type {
	AgentRun,
	AgentRunCheck,
	AgentRunMetadata,
	AgentRunPullRequest,
	AgentRunReviewFinding,
	AgentRunReviewSeverity,
} from '../../shared/agent-run';
import { AGENT_RUN_REVIEW_SEVERITIES } from '../../shared/agent-run';
import type { UsageStats } from '../../shared/types';
import { execFileNoThrow, type ExecResult } from '../utils/execFile';
import { resolveGhPath } from '../utils/cliDetection';

/** Wider than a normal git op; a cold object store on a large worktree is slow. */
const GIT_TIMEOUT_MS = 15_000;
/** gh talks to the network; keep it bounded so a slow PR lookup never stalls exit. */
const GH_TIMEOUT_MS = 20_000;

/** Fields we ask `gh pr view` for; mapped onto AgentRunPullRequest below. */
const PR_JSON_FIELDS = 'number,url,state,mergeable,headRefName,baseRefName';

// ---------------------------------------------------------------------------
// Injectable process boundary (defaults call the real helpers). Kept as deps so
// producers stay unit-testable without a live git/gh, while the exported
// signatures still work with zero extra arguments.
// ---------------------------------------------------------------------------

/** Runs `git <args>` in `cwd`; never throws (mirrors execFileNoThrow). */
export type GitRunner = (cwd: string, args: string[]) => Promise<ExecResult>;

/** Resolves + runs `gh <args>` in `cwd`; never throws. */
export interface GhRunner {
	resolveGhPath: () => Promise<string>;
	execFile: (command: string, args: string[], cwd: string) => Promise<ExecResult>;
}

const defaultGitRunner: GitRunner = (cwd, args) =>
	execFileNoThrow('git', args, cwd, { timeout: GIT_TIMEOUT_MS });

const defaultGhRunner: GhRunner = {
	resolveGhPath,
	execFile: (command, args, cwd) => execFileNoThrow(command, args, cwd, { timeout: GH_TIMEOUT_MS }),
};

// ---------------------------------------------------------------------------
// ISC-2.1 / ISC-2.2 - touched files from git diff
// ---------------------------------------------------------------------------

/**
 * Collect the files this run touched, from real git state in `cwd` (the run's
 * worktree). Unions the working-tree diff, the staged diff, and - when a
 * baseBranch is known - the committed diff of the branch since it forked from
 * baseBranch (`git diff --name-only <base>...HEAD`).
 *
 * Returns a sorted, de-duplicated list. Returns `[]` (never throws) when `cwd`
 * is not a git repository, git is missing, or there simply are no changes
 * (ISC-2.2): a git error is treated as "no files", never as a thrown failure.
 */
export async function touchedFilesFromGit(
	cwd: string,
	baseBranch?: string,
	runGit: GitRunner = defaultGitRunner
): Promise<string[]> {
	if (!cwd) return [];
	try {
		const files = new Set<string>();
		// Unstaged working-tree changes vs HEAD.
		await collectDiff(runGit, cwd, ['diff', '--name-only'], files);
		// Staged (index) changes.
		await collectDiff(runGit, cwd, ['diff', '--name-only', '--cached'], files);
		// Committed branch changes since divergence from baseBranch.
		if (baseBranch) {
			await collectDiff(runGit, cwd, ['diff', '--name-only', `${baseBranch}...HEAD`], files);
		}
		return Array.from(files).sort();
	} catch {
		// execFileNoThrow does not throw, but guard defensively so the producer
		// contract (never throw) holds even if a dep is swapped for one that does.
		return [];
	}
}

/** Run one `git diff` variant and fold its file lines into `out`; skip on failure. */
async function collectDiff(
	runGit: GitRunner,
	cwd: string,
	args: string[],
	out: Set<string>
): Promise<void> {
	const result = await runGit(cwd, args);
	// Any non-zero exit (128 = not a repo / bad ref, ENOENT = git missing) means
	// this source contributes nothing; it is not an error for the run.
	if (result.exitCode !== 0) return;
	for (const line of result.stdout.split('\n')) {
		const file = line.trim();
		if (file) out.add(file);
	}
}

// ---------------------------------------------------------------------------
// ISC-2.3 - provider token/cost usage (best-effort)
// ---------------------------------------------------------------------------

type MaybeUsage = AgentRunMetadata | UsageStats | undefined | null;

/**
 * A named provider usage source: given a run, return its token/cost usage or
 * nothing. Wired by the caller (e.g. a per-session usage accumulator or a
 * Claude usage snapshot). Kept async-friendly so a sampler that shells out can
 * back it without changing this contract.
 */
export type UsageSource = (run: AgentRun) => MaybeUsage | Promise<MaybeUsage>;

/**
 * Best-effort read of a run's provider token/cost usage. Tries the injected
 * `source` first, then any `usage` already attached to the run by an upstream
 * producer. Returns an AgentRunMetadata partial, or `undefined` when no source
 * is available (ISC-2.3 anti: absent source leaves usage undefined, never a
 * fabricated zero record). Never throws.
 */
export async function usageFromProvider(
	run: AgentRun,
	source?: UsageSource
): Promise<AgentRunMetadata | undefined> {
	try {
		if (source) {
			const fromSource = await source(run);
			const normalized = normalizeUsage(fromSource);
			if (normalized) return normalized;
		}
		return normalizeUsage(run.usage);
	} catch {
		return undefined;
	}
}

/** Drop null/undefined fields; return undefined for an empty/non-object value. */
function normalizeUsage(value: MaybeUsage): AgentRunMetadata | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const entries = Object.entries(value as Record<string, unknown>).filter(
		([, v]) => v !== undefined && v !== null
	);
	if (entries.length === 0) return undefined;
	return Object.fromEntries(entries);
}

// ---------------------------------------------------------------------------
// ISC-2.6 - pull request for the run branch (best-effort, via gh)
// ---------------------------------------------------------------------------

/** Raw `gh pr view --json` shape (only the fields we request). */
interface GhPrJson {
	number?: number;
	url?: string;
	state?: string;
	mergeable?: string;
	headRefName?: string;
	baseRefName?: string;
}

/**
 * Best-effort lookup of the open PR for `branch` via `gh pr view`, mapped to an
 * AgentRunPullRequest. Returns `undefined` when gh is missing/unauthenticated,
 * no PR exists, or the output is unparseable (ISC-2.6). Never throws.
 */
export async function pullRequestForBranch(
	cwd: string,
	branch: string,
	gh: GhRunner = defaultGhRunner
): Promise<AgentRunPullRequest | undefined> {
	if (!cwd || !branch) return undefined;
	try {
		const ghPath = await gh.resolveGhPath();
		const result = await gh.execFile(ghPath, ['pr', 'view', branch, '--json', PR_JSON_FIELDS], cwd);
		if (result.exitCode !== 0 || !result.stdout.trim()) return undefined;
		const raw = JSON.parse(result.stdout) as GhPrJson;
		return mapPullRequest(raw, branch);
	} catch {
		return undefined;
	}
}

/** Map gh's PR JSON onto our domain shape, normalizing state + mergeability. */
function mapPullRequest(raw: GhPrJson, branch: string): AgentRunPullRequest {
	const pr: AgentRunPullRequest = {};
	if (typeof raw.number === 'number') pr.number = raw.number;
	if (typeof raw.url === 'string' && raw.url) pr.url = raw.url;
	if (typeof raw.state === 'string' && raw.state) pr.state = raw.state.toLowerCase();
	// gh reports mergeable as MERGEABLE / CONFLICTING / UNKNOWN; only the first
	// two are decisive, UNKNOWN leaves the flag unset rather than guessing.
	if (raw.mergeable === 'MERGEABLE') pr.mergeable = true;
	else if (raw.mergeable === 'CONFLICTING') pr.mergeable = false;
	pr.headBranch = typeof raw.headRefName === 'string' && raw.headRefName ? raw.headRefName : branch;
	if (typeof raw.baseRefName === 'string' && raw.baseRefName) pr.baseBranch = raw.baseRefName;
	return pr;
}

// ---------------------------------------------------------------------------
// ISC-2.4 - checks (pure mapper)
// ---------------------------------------------------------------------------

/**
 * Pure upsert of a check into a run's checks list, keyed by `name`. Re-recording
 * a check by the same name replaces it in place (a check re-run updates rather
 * than duplicating); a new name appends. Returns a new array; never mutates the
 * input (ISC-2.4). Wiring of the check runner lands in a later wave.
 */
export function recordCheck(run: AgentRun, check: AgentRunCheck): AgentRunCheck[] {
	const existing = run.checks ?? [];
	const idx = existing.findIndex((c) => c.name === check.name);
	if (idx === -1) return [...existing, check];
	return existing.map((c, i) => (i === idx ? check : c));
}

// ---------------------------------------------------------------------------
// ISC-2.5 - review findings (pure mapper)
// ---------------------------------------------------------------------------

/**
 * Loose reviewer-agent output. Reviewers emit varied shapes, so common aliases
 * are accepted (path/file, description/message, type/category,
 * suggestion/fix/suggestedFix) and normalized on ingest.
 */
export interface RawReviewFinding {
	file?: string;
	path?: string;
	line?: number;
	severity?: string;
	category?: string;
	type?: string;
	message?: string;
	description?: string;
	confidence?: number;
	suggestedFix?: string;
	suggestion?: string;
	fix?: string;
	metadata?: AgentRunMetadata;
}

/**
 * Ingest raw reviewer findings into AgentRunReviewFinding records (severity,
 * category, message, status=open) and append them to the run's existing reviews.
 * Findings with no usable message are dropped. Pure: returns a new array, never
 * mutates the run (ISC-2.5). Wiring of the reviewer feed lands in a later wave.
 */
export function ingestReviewFindings(
	run: AgentRun,
	rawFindings: readonly RawReviewFinding[]
): AgentRunReviewFinding[] {
	const mapped = (rawFindings ?? [])
		.map(mapReviewFinding)
		.filter((f): f is AgentRunReviewFinding => f !== undefined);
	return [...(run.reviews ?? []), ...mapped];
}

function mapReviewFinding(raw: RawReviewFinding): AgentRunReviewFinding | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const message = firstString(raw.message, raw.description);
	if (!message) return undefined;
	const finding: AgentRunReviewFinding = {
		severity: normalizeSeverity(raw.severity),
		category: firstString(raw.category, raw.type) ?? 'general',
		message,
		status: 'open',
	};
	const file = firstString(raw.file, raw.path);
	if (file) finding.file = file;
	if (typeof raw.line === 'number') finding.line = raw.line;
	if (typeof raw.confidence === 'number') finding.confidence = raw.confidence;
	const suggestedFix = firstString(raw.suggestedFix, raw.suggestion, raw.fix);
	if (suggestedFix) finding.suggestedFix = suggestedFix;
	if (raw.metadata && typeof raw.metadata === 'object') finding.metadata = raw.metadata;
	return finding;
}

/** Coerce an arbitrary severity string to the closed set; default to 'info'. */
function normalizeSeverity(value: string | undefined): AgentRunReviewSeverity {
	if (typeof value !== 'string') return 'info';
	const lower = value.trim().toLowerCase();
	if ((AGENT_RUN_REVIEW_SEVERITIES as readonly string[]).includes(lower)) {
		return lower as AgentRunReviewSeverity;
	}
	return 'info';
}

/** First non-empty trimmed string among the candidates, or undefined. */
function firstString(...candidates: (string | undefined)[]): string | undefined {
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.trim()) return candidate;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Composed enrich hook
// ---------------------------------------------------------------------------

export interface EnrichHookOptions {
	/** Named provider usage source (ISC-2.3); when omitted usage stays undefined. */
	usageSource?: UsageSource;
	/** Override the git runner (tests / alternate transports). */
	runGit?: GitRunner;
	/** Override the gh runner (tests / alternate transports). */
	gh?: GhRunner;
	/** Optional diagnostic sink; a producer failure is degraded, not surfaced. */
	log?: (message: string, error: unknown) => void;
}

/**
 * Build the F2 enrich hook passed to `setupAgentRunCapture({ enrich })`. On
 * completion it assembles touchedFiles (git diff against baseBranch in the run
 * worktree), usage (best-effort provider read), and pullRequest (gh lookup for
 * the run branch) into a `Partial<AgentRun>`. Each producer is isolated so one
 * failing does not sink the others, and the hook never throws into the
 * completion path.
 */
export function buildEnrichHook(
	options: EnrichHookOptions = {}
): (run: AgentRun, exitCode: number) => Promise<Partial<AgentRun>> {
	const runGit = options.runGit ?? defaultGitRunner;
	const gh = options.gh ?? defaultGhRunner;

	return async (run: AgentRun, _exitCode: number): Promise<Partial<AgentRun>> => {
		const cwd = run.worktreePath ?? run.cwd ?? '';
		const [touchedFiles, usage, pullRequest] = await Promise.all([
			safe(() => touchedFilesFromGit(cwd, run.baseBranch, runGit), [], options.log),
			safe(() => usageFromProvider(run, options.usageSource), undefined, options.log),
			safe<AgentRunPullRequest | undefined>(
				() => (run.branch ? pullRequestForBranch(cwd, run.branch, gh) : undefined),
				undefined,
				options.log
			),
		]);

		const enrichment: Partial<AgentRun> = { touchedFiles };
		if (usage) enrichment.usage = usage;
		if (pullRequest) enrichment.pullRequest = pullRequest;
		return enrichment;
	};
}

/** Run a producer, degrading any failure to `fallback` (never throws upward). */
async function safe<T>(
	fn: () => Promise<T> | T,
	fallback: T,
	log?: (message: string, error: unknown) => void
): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		log?.('agent-run producer failed', error);
		return fallback;
	}
}
