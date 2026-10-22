// Session-id discovery for maestro-p run mode (fresh sessions).
//
// When a brand-new claude TUI spawn happens (no `--resume`), the wrapper
// can't know the session id ahead of time - claude assigns it and writes
// the corresponding `*.jsonl` file under
// `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<session-id>.jsonl` shortly
// after startup. `discoverSessionId()` watches that directory for the
// first new `.jsonl` whose creation time is at or after the caller's
// recorded `spawnTimestamp`, then returns the basename (the session id)
// and the absolute path so the runner can hand both straight to the
// `JsonlTailer` without re-deriving.
//
// `--resume` flow does NOT use this - the path is fully determined from
// the resume id and the cwd-slug rule, so the runner can skip discovery.
//
// Polling, not fs.watch
// ---------------------
// fs.watch event semantics are inconsistent across platforms (recursive
// is unsupported on Linux until newer Node versions; events can fire
// before the file is fully visible to stat; macOS coalesces rapid
// changes). The cwd-specific projects directory may not even exist yet
// - claude creates it lazily on the first session for that cwd, which
// means we'd also have to handle the parent-dir-watch race. A short
// poll loop on readdir is simpler, deterministic, and tolerates the
// directory not existing yet.

import * as path from 'path';
import { promises as fsp } from 'fs';

export interface DiscoverSessionIdOptions {
	/** Resolved Claude config dir (caller already applied env fallback). */
	configDir: string;
	/** Absolute working directory the TUI was spawned in. */
	cwd: string;
	/** `Date.now()` captured immediately before the TUI spawn. */
	spawnTimestamp: number;
	/** Reject after this many ms with no eligible file. Default 10000. */
	timeoutMs?: number;
	/** Polling cadence. Default 75ms (matches JsonlTailer). */
	pollIntervalMs?: number;
	/**
	 * When set, the caller pre-assigned this session id to the TUI via
	 * `claude --session-id <uuid>`, so we poll for exactly `<uuid>.jsonl`
	 * instead of guessing "the earliest new file". This is RACE-FREE: when
	 * multiple fresh-session TUIs run concurrently in the same cwd, the
	 * earliest-new-file heuristic can attach one maestro-p instance to a
	 * sibling's transcript (observed cross-talk: a tab-naming turn returning
	 * another concurrent turn's answer). Watching for the known id eliminates
	 * that entirely. Falls back to earliest-new only when this is absent.
	 */
	expectSessionId?: string;
	/**
	 * Session ids the earliest-new scan must skip: transcripts this run is
	 * already tailing, when the caller is watching for a SECOND session the
	 * TUI rotated onto (`/clear`).
	 */
	excludeSessionIds?: ReadonlySet<string>;
}

export interface DiscoverSessionIdResult {
	sessionId: string;
	jsonlPath: string;
}

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 10000;
export const DEFAULT_DISCOVERY_POLL_INTERVAL_MS = 75;

/**
 * Encode `cwd` the same way claude does when naming its per-project
 * transcript directory: every non-alphanumeric character collapses to
 * `-`. The canonical implementation lives in `src/shared/pathUtils.ts`
 * as `encodeClaudeProjectPath`; we inline the rule here because the
 * maestro-p bundle is intentionally lean and the shared module pulls in
 * Electron-adjacent helpers we don't need. The duplication is kept honest by
 * a parity test in src/__tests__/maestro-p/session-watcher.test.ts that asserts
 * this function and encodeClaudeProjectPath() agree on every input - if you
 * change the rule here, change it there too or that test will tell you.
 */
export function cwdSlug(cwd: string): string {
	// Strip trailing separators first, matching the canonical helper: a cwd saved
	// as "/path/to/repo/" would otherwise slug to a directory claude never writes.
	const trimmed = cwd.replace(/[/\\]+$/, '');
	const normalized = trimmed === '' || /^[a-zA-Z]:$/.test(trimmed) ? cwd : trimmed;
	return normalized.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Where claude keeps the transcript of `sessionId` for a project rooted at `cwd`. */
export function sessionTranscriptPath(configDir: string, cwd: string, sessionId: string): string {
	return path.join(configDir, 'projects', cwdSlug(cwd), `${sessionId}.jsonl`);
}

/**
 * What `claude --print --resume <id>` says when no transcript backs the id.
 * maestro-p reuses the exact words so the desktop's `session_not_found`
 * pattern classifies a TUI turn the same way as a print turn, and its in-place
 * recovery starts a fresh session instead of reporting an anonymous failure.
 */
export function noConversationFoundMessage(sessionId: string): string {
	return `No conversation found with session ID: ${sessionId}`;
}

interface Candidate {
	sessionId: string;
	jsonlPath: string;
	createdMs: number;
}

export async function discoverSessionId(
	options: DiscoverSessionIdOptions
): Promise<DiscoverSessionIdResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_DISCOVERY_POLL_INTERVAL_MS;
	const projectsDir = path.join(options.configDir, 'projects', cwdSlug(options.cwd));
	const deadline = Date.now() + timeoutMs;

	// Scan immediately so a file already on disk (claude wrote it before
	// we started polling) is picked up without waiting a full interval.
	for (;;) {
		const candidate = options.expectSessionId
			? await findExpectedJsonl(projectsDir, options.expectSessionId)
			: await findEarliestNewJsonl(projectsDir, options.spawnTimestamp, options.excludeSessionIds);
		if (candidate) {
			return { sessionId: candidate.sessionId, jsonlPath: candidate.jsonlPath };
		}
		if (Date.now() >= deadline) {
			// Preserve the legacy wording for the earliest-new path (callers and
			// tests match on it); use a distinct message for the expected-id path.
			const detail = options.expectSessionId
				? `session ${options.expectSessionId}.jsonl did not appear`
				: 'no new .jsonl appeared';
			throw new Error(`session-watcher: ${detail} in ${projectsDir} within ${timeoutMs}ms`);
		}
		await sleep(pollIntervalMs);
	}
}

/**
 * Race-free lookup for a pre-assigned session id (`claude --session-id`).
 * Returns the candidate as soon as `<sessionId>.jsonl` exists, regardless of
 * any other transcripts being written concurrently in the same directory.
 */
async function findExpectedJsonl(
	projectsDir: string,
	sessionId: string
): Promise<Candidate | null> {
	const jsonlPath = path.join(projectsDir, `${sessionId}.jsonl`);
	try {
		const stat = await fsp.stat(jsonlPath);
		if (!stat.isFile()) return null;
	} catch (err) {
		// Not created yet (ENOENT) - keep polling. Anything else is unexpected.
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
	return { sessionId, jsonlPath, createdMs: 0 };
}

async function findEarliestNewJsonl(
	projectsDir: string,
	spawnTimestamp: number,
	exclude?: ReadonlySet<string>
): Promise<Candidate | null> {
	let entries: string[];
	try {
		entries = await fsp.readdir(projectsDir);
	} catch (err) {
		// Directory not yet created by claude - keep polling.
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}

	let best: Candidate | null = null;
	for (const name of entries) {
		if (!name.endsWith('.jsonl')) continue;
		if (exclude?.has(name.slice(0, -'.jsonl'.length))) continue;
		const fullPath = path.join(projectsDir, name);
		let stat;
		try {
			stat = await fsp.stat(fullPath);
		} catch (err) {
			// Race: file vanished between readdir and stat. Skip it.
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
			throw err;
		}
		if (!stat.isFile()) continue;
		// birthtime is unreliable on some Linux filesystems (returns 0 / epoch);
		// fall back to mtime using the same guard memory-manager.ts uses.
		const createdMs = stat.birthtimeMs && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
		if (createdMs < spawnTimestamp) continue;
		if (!best || createdMs < best.createdMs) {
			best = {
				sessionId: name.slice(0, -'.jsonl'.length),
				jsonlPath: fullPath,
				createdMs,
			};
		}
	}
	return best;
}

// A main-session transcript is `<uuid>.jsonl`; subagent and other side files
// live in subfolders or carry other names.
const SESSION_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/**
 * The session `claude --continue` would pick for `cwd`: the most recently
 * written transcript in its project folder, or null when there is none.
 * maestro-p resolves this itself because it pre-assigns `--session-id` to
 * every fresh TUI, and claude refuses `--continue` together with
 * `--session-id`.
 */
export async function findLatestSessionId(configDir: string, cwd: string): Promise<string | null> {
	const projectsDir = path.join(configDir, 'projects', cwdSlug(cwd));
	let entries: string[];
	try {
		entries = await fsp.readdir(projectsDir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
	let latest: { sessionId: string; mtimeMs: number } | null = null;
	for (const name of entries) {
		if (!SESSION_JSONL.test(name)) continue;
		let stat;
		try {
			stat = await fsp.stat(path.join(projectsDir, name));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
			throw err;
		}
		if (!stat.isFile()) continue;
		if (!latest || stat.mtimeMs > latest.mtimeMs) {
			latest = { sessionId: name.slice(0, -'.jsonl'.length), mtimeMs: stat.mtimeMs };
		}
	}
	return latest?.sessionId ?? null;
}

function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
