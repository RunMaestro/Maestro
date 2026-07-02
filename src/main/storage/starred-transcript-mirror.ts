/**
 * Starred-transcript mirror.
 *
 * A starred session is one the user has explicitly told Maestro to keep. The
 * conversation transcript itself, though, lives in the provider's own directory
 * (Claude Code's `~/.claude/projects/.../<sessionId>.jsonl`, and the equivalent
 * for other agents) and is subject to the provider's retention: `/clear`, a
 * reinstall, or the provider's own cleanup can delete it out from under us. When
 * that happens the star goes dangling and the conversation is gone forever.
 *
 * This module gives Maestro its OWN copy. It mirrors a starred session's
 * transcript into `userData/starred-transcripts/` and keeps that mirror fresh at
 * the moments a session's context could be lost:
 *
 *   - on star           -> snapshot immediately (protect it right away)
 *   - on tab close       -> the session is being put away; capture its final state
 *   - on app exit        -> flush every still-open starred tab
 *
 * We deliberately do NOT watch the provider file or re-copy on every turn. A
 * provider only appends to a transcript while its session is actively open in a
 * tab, and it never deletes a session you're actively using - so snapshotting at
 * the "put away" boundaries captures the complete terminal state with no watcher
 * and no per-turn I/O. Every copy is mtime-gated, so re-snapshotting an unchanged
 * transcript is a cheap no-op.
 *
 * Restore is a rehydrate: when the provider file is missing but a mirror exists,
 * we copy the mirror back into the provider's expected path, so the session both
 * displays AND resumes natively (`--resume` reads that same file).
 *
 * Unstar deletes the mirror, so an unstarred session ages out naturally again.
 *
 * Provider-agnostic: it relies only on `getSessionPath()` (single transcript file
 * per session), which every storage implements. Remote (SSH) sessions are skipped
 * - their transcript lives on another host.
 */

import { app } from 'electron';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { getSessionStorage } from '../agents/session-storage';
import { createKeyedWriteQueue } from '../utils/atomic-json-store';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

const LOG_CONTEXT = 'StarredTranscriptMirror';

/** One mirrored transcript's metadata, keyed by `${agentId}::${sessionId}`. */
export interface MirrorIndexEntry {
	agentId: string;
	projectPath: string;
	sessionId: string;
	/** Last-known display name, so an aged-out row still renders with its name. */
	sessionName?: string;
	/** Provider file mtime at the time of the last copy (drives the mtime gate). */
	sourceMtimeMs: number;
	/** Wall-clock ms of the last copy (used as lastActivityAt for aged-out rows). */
	mirroredAtMs: number;
}

type MirrorIndex = Record<string, MirrorIndexEntry>;

// The index is a small read-modify-write JSON file; serialize all mutations to
// it so concurrent snapshot/delete calls never lose an update. The mirror data
// files are keyed per session so different sessions still copy concurrently.
const writeQueue = createKeyedWriteQueue();
const INDEX_KEY = '__index__';

/** Test seam: override the mirror root so unit tests don't touch real userData. */
let mirrorRootOverride: string | null = null;
export function setMirrorRootForTest(root: string | null): void {
	mirrorRootOverride = root;
}

function getMirrorRoot(): string {
	if (mirrorRootOverride) return mirrorRootOverride;
	return path.join(app.getPath('userData'), 'starred-transcripts');
}

function getIndexPath(): string {
	return path.join(getMirrorRoot(), 'index.json');
}

function indexKey(agentId: string, sessionId: string): string {
	return `${agentId}::${sessionId}`;
}

/**
 * On-disk filename for a session's mirrored transcript. Session ids are
 * effectively UUIDs, but sanitize anyway so a hostile id can't escape the
 * agent's mirror directory.
 */
function mirrorFilePath(agentId: string, sessionId: string): string {
	const safeAgent = agentId.replace(/[^a-zA-Z0-9._-]/g, '_');
	const safeSession = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
	return path.join(getMirrorRoot(), safeAgent, `${safeSession}.jsonl`);
}

async function readIndex(): Promise<MirrorIndex> {
	try {
		const raw = await fs.readFile(getIndexPath(), 'utf-8');
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? (parsed as MirrorIndex) : {};
	} catch {
		// Missing or unparseable index -> start empty. We never destroy mirror
		// data files on a bad index; the next successful snapshot rebuilds entries.
		return {};
	}
}

/** Atomically write raw text via temp file + rename (mirrors atomicWriteJson but for JSONL). */
async function atomicCopyFile(src: string, dest: string): Promise<void> {
	await fs.mkdir(path.dirname(dest), { recursive: true });
	const tmp = `${dest}.tmp`;
	await fs.copyFile(src, tmp);
	await fs.rename(tmp, dest);
}

async function writeIndex(index: MirrorIndex): Promise<void> {
	const indexPath = getIndexPath();
	await fs.mkdir(path.dirname(indexPath), { recursive: true });
	const tmp = `${indexPath}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(index, null, 2), 'utf-8');
	await fs.rename(tmp, indexPath);
}

/**
 * Resolve the LOCAL provider transcript path for a session, or null when the
 * agent has no storage or the session is remote (SSH) - which we never mirror.
 */
function resolveLocalSourcePath(
	agentId: string,
	projectPath: string,
	sessionId: string
): string | null {
	const storage = getSessionStorage(agentId);
	if (!storage) return null;
	// No sshConfig: only mirror local transcripts.
	return storage.getSessionPath(projectPath, sessionId);
}

/**
 * Copy a starred session's provider transcript into the mirror if it changed
 * since the last copy. No-op (cheap) when the provider file is unchanged,
 * missing, or the session is remote. Never throws - snapshotting is best-effort
 * and must not break the star toggle or tab close that triggered it.
 */
export async function snapshotStarredTranscript(args: {
	agentId: string;
	projectPath: string;
	sessionId: string;
	sessionName?: string;
}): Promise<void> {
	const { agentId, projectPath, sessionId, sessionName } = args;
	try {
		const src = resolveLocalSourcePath(agentId, projectPath, sessionId);
		if (!src) return;

		let srcMtimeMs: number;
		try {
			const stat = await fs.stat(src);
			srcMtimeMs = stat.mtimeMs;
		} catch {
			// Provider file already gone: keep whatever mirror we have, don't clobber.
			return;
		}

		await writeQueue.enqueue(INDEX_KEY, async () => {
			const index = await readIndex();
			const key = indexKey(agentId, sessionId);
			const existing = index[key];
			const unchanged =
				existing &&
				existing.sourceMtimeMs === srcMtimeMs &&
				(sessionName === undefined || existing.sessionName === sessionName);
			if (unchanged) return;

			await atomicCopyFile(src, mirrorFilePath(agentId, sessionId));
			index[key] = {
				agentId,
				projectPath,
				sessionId,
				sessionName: sessionName ?? existing?.sessionName,
				sourceMtimeMs: srcMtimeMs,
				mirroredAtMs: Date.now(),
			};
			await writeIndex(index);
			logger.info(`Mirrored starred transcript ${agentId}/${sessionId}`, LOG_CONTEXT);
		});
	} catch (err) {
		captureException(err, { extra: { context: 'snapshotStarredTranscript', agentId, sessionId } });
	}
}

/** Remove a session's mirror and its index entry (called on unstar). Best-effort. */
export async function deleteStarredMirror(args: {
	agentId: string;
	sessionId: string;
}): Promise<void> {
	const { agentId, sessionId } = args;
	try {
		await writeQueue.enqueue(INDEX_KEY, async () => {
			await fs.rm(mirrorFilePath(agentId, sessionId), { force: true });
			const index = await readIndex();
			const key = indexKey(agentId, sessionId);
			if (index[key]) {
				delete index[key];
				await writeIndex(index);
			}
		});
	} catch (err) {
		captureException(err, { extra: { context: 'deleteStarredMirror', agentId, sessionId } });
	}
}

/**
 * Rehydrate: if the provider transcript is missing but we hold a mirror, copy
 * the mirror back to the provider's expected path so the session can display and
 * resume natively. Returns true when a restore was performed. Cheap when the
 * provider file already exists (single stat, no index read).
 */
export async function restoreStarredTranscript(args: {
	agentId: string;
	projectPath: string;
	sessionId: string;
}): Promise<boolean> {
	const { agentId, projectPath, sessionId } = args;
	try {
		const dest = resolveLocalSourcePath(agentId, projectPath, sessionId);
		if (!dest) return false;

		// Provider file already present -> nothing to restore.
		try {
			await fs.stat(dest);
			return false;
		} catch {
			// fall through to restore attempt
		}

		const mirror = mirrorFilePath(agentId, sessionId);
		try {
			await fs.stat(mirror);
		} catch {
			return false; // no mirror to restore from
		}

		await atomicCopyFile(mirror, dest);
		logger.info(`Rehydrated aged-out transcript ${agentId}/${sessionId} from mirror`, LOG_CONTEXT);
		return true;
	} catch (err) {
		captureException(err, { extra: { context: 'restoreStarredTranscript', agentId, sessionId } });
		return false;
	}
}

/** All mirrored starred sessions (drives the aged-out listing fallback). */
export async function listMirroredStarredSessions(): Promise<MirrorIndexEntry[]> {
	try {
		return Object.values(await readIndex());
	} catch {
		return [];
	}
}

/**
 * Synchronous best-effort flush of every open starred tab's transcript, for the
 * app-exit path. performCleanup() runs synchronously and the process is
 * SIGKILLed shortly after, so async fire-and-forget copies could be cut off;
 * doing the copies synchronously here guarantees they finish before exit. Each
 * copy is mtime-gated, so unchanged transcripts cost only a stat.
 *
 * `sessions` is the persisted session list (StoredSession[]); we read each
 * session's aiTabs for starred tabs with an agentSessionId.
 */
export function flushStarredMirrorsSync(sessions: Array<Record<string, unknown>>): void {
	try {
		const indexPath = getIndexPath();
		let index: MirrorIndex = {};
		try {
			index = JSON.parse(fsSync.readFileSync(indexPath, 'utf-8')) as MirrorIndex;
		} catch {
			index = {};
		}

		let dirty = false;
		for (const session of sessions) {
			const agentId = (session.toolType as string) || 'claude-code';
			const projectPath = session.projectRoot as string;
			const aiTabs = session.aiTabs as Array<Record<string, unknown>> | undefined;
			if (!projectPath || !Array.isArray(aiTabs)) continue;

			for (const tab of aiTabs) {
				if (tab.starred !== true) continue;
				const sessionId = tab.agentSessionId as string | undefined;
				if (!sessionId) continue;

				const src = resolveLocalSourcePath(agentId, projectPath, sessionId);
				if (!src) continue;

				let srcMtimeMs: number;
				try {
					srcMtimeMs = fsSync.statSync(src).mtimeMs;
				} catch {
					continue; // provider file gone; keep existing mirror
				}

				const key = indexKey(agentId, sessionId);
				const existing = index[key];
				const sessionName = (tab.name as string | undefined) ?? existing?.sessionName;
				if (
					existing &&
					existing.sourceMtimeMs === srcMtimeMs &&
					existing.sessionName === sessionName
				) {
					continue; // unchanged
				}

				try {
					const dest = mirrorFilePath(agentId, sessionId);
					fsSync.mkdirSync(path.dirname(dest), { recursive: true });
					const tmp = `${dest}.tmp`;
					fsSync.copyFileSync(src, tmp);
					fsSync.renameSync(tmp, dest);
					index[key] = {
						agentId,
						projectPath,
						sessionId,
						sessionName,
						sourceMtimeMs: srcMtimeMs,
						mirroredAtMs: Date.now(),
					};
					dirty = true;
				} catch {
					// best-effort per session
				}
			}
		}

		if (dirty) {
			fsSync.mkdirSync(path.dirname(indexPath), { recursive: true });
			const tmp = `${indexPath}.tmp`;
			fsSync.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf-8');
			fsSync.renameSync(tmp, indexPath);
		}
	} catch (err) {
		logger.error(`Error flushing starred transcript mirrors on quit: ${err}`, LOG_CONTEXT);
	}
}
