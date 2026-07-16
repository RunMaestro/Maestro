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
 * Electron-adjacent helpers we don't need.
 */
export function cwdSlug(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, '-');
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
			: await findEarliestNewJsonl(projectsDir, options.spawnTimestamp);
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
	spawnTimestamp: number
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

function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
