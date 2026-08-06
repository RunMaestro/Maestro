/**
 * Transcript mirror.
 *
 * A session's conversation transcript lives in the provider's own directory
 * (Claude Code's `~/.claude/projects/.../<sessionId>.jsonl`, and the equivalent
 * for other agents) and is subject to the provider's retention: `/clear`, a
 * reinstall, or the provider's own cleanup can delete it out from under us. When
 * that happens the conversation is gone forever.
 *
 * This module gives Maestro its OWN copy for sessions the user has signalled
 * they want kept. It mirrors the transcript into `userData/starred-transcripts/`
 * and refreshes that mirror at the moments a session's context could be lost:
 *
 *   - on star            -> snapshot immediately (protect it right away)
 *   - on snooze          -> the tab is being put away, possibly for months
 *   - on tab close       -> the session is being put away; capture its final state
 *   - on app exit        -> flush every still-open starred tab and every snoozed tab
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
 * RETENTION REASONS. A mirror can be held for more than one reason at a time -
 * a tab may be starred, snoozed, or both - so each index entry records WHY it is
 * kept and the mirror is deleted only once every reason has been released.
 * Without this, unstarring a session that is also snoozed for three weeks would
 * delete the very copy the snooze depends on. Releasing the snooze reason
 * rehydrates first (see {@link releaseSnoozedTranscriptMirror}), so letting go of
 * a snooze can never be the thing that loses a conversation.
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

/**
 * Why a mirror is being kept.
 *
 * - `starred` - the user starred the session.
 * - `snoozed` - the session's tab is snoozed and will return later. Snoozes can
 *   run for months, well past the point a provider would age the transcript out.
 */
export type MirrorRetainReason = 'starred' | 'snoozed';

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
	/**
	 * Reasons this mirror is held. Deleted only when the last one is released.
	 * Absent on entries written before snooze retention existed - every one of
	 * those was created by starring, so a missing value reads as `['starred']`.
	 */
	retain?: MirrorRetainReason[];
}

type MirrorIndex = Record<string, MirrorIndexEntry>;

/**
 * Retention reasons for an entry, defaulting legacy entries (written before
 * retention reasons existed) to `starred`. Single place that migration lives.
 */
function getRetainReasons(entry: MirrorIndexEntry | undefined): MirrorRetainReason[] {
	if (!entry) return [];
	return entry.retain && entry.retain.length > 0 ? entry.retain : ['starred'];
}

/** Add a reason to an entry's retention set, preserving any already present. */
function withReason(
	entry: MirrorIndexEntry | undefined,
	reason: MirrorRetainReason
): MirrorRetainReason[] {
	const current = getRetainReasons(entry);
	return current.includes(reason) ? current : [...current, reason];
}

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
 * Copy a session's provider transcript into the mirror if it changed since the
 * last copy, and record `reason` as one of the reasons the mirror is held.
 * No-op (cheap) when the provider file is unchanged, missing, or the session is
 * remote. Never throws - snapshotting is best-effort and must not break the star
 * toggle, snooze, or tab close that triggered it.
 *
 * @param args.reason - Why the mirror is being kept. Defaults to `'starred'`.
 */
export async function snapshotStarredTranscript(args: {
	agentId: string;
	projectPath: string;
	sessionId: string;
	sessionName?: string;
	reason?: MirrorRetainReason;
}): Promise<void> {
	const { agentId, projectPath, sessionId, sessionName, reason = 'starred' } = args;
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
			const retain = withReason(existing, reason);
			// Nothing to do only when the bytes, the name, AND the retention set are
			// all already current - a newly-snoozed starred tab has an unchanged
			// transcript but still needs its new reason recorded.
			const unchanged =
				existing &&
				existing.sourceMtimeMs === srcMtimeMs &&
				(sessionName === undefined || existing.sessionName === sessionName) &&
				retain.length === getRetainReasons(existing).length;
			if (unchanged) return;

			// Skip the copy when the provider bytes are unchanged; we may be here
			// purely to widen the retention set.
			if (!existing || existing.sourceMtimeMs !== srcMtimeMs) {
				await atomicCopyFile(src, mirrorFilePath(agentId, sessionId));
			}
			index[key] = {
				agentId,
				projectPath,
				sessionId,
				sessionName: sessionName ?? existing?.sessionName,
				sourceMtimeMs: srcMtimeMs,
				mirroredAtMs: Date.now(),
				retain,
			};
			await writeIndex(index);
			logger.info(`Mirrored transcript ${agentId}/${sessionId} (${retain.join('+')})`, LOG_CONTEXT);
		});
	} catch (err) {
		captureException(err, { extra: { context: 'snapshotStarredTranscript', agentId, sessionId } });
	}
}

/**
 * Release one retention reason. The mirror file and index entry are removed only
 * when no reason remains - so unstarring a session that is still snoozed keeps
 * the copy the snooze depends on. Best-effort; never throws.
 *
 * @param args.reason - Reason to release. Defaults to `'starred'` (unstar).
 */
export async function releaseTranscriptMirror(args: {
	agentId: string;
	sessionId: string;
	reason?: MirrorRetainReason;
}): Promise<void> {
	const { agentId, sessionId, reason = 'starred' } = args;
	try {
		await writeQueue.enqueue(INDEX_KEY, async () => {
			const index = await readIndex();
			const key = indexKey(agentId, sessionId);
			const existing = index[key];

			// No index entry: nothing is claiming this mirror, so drop any stray file.
			if (!existing) {
				await fs.rm(mirrorFilePath(agentId, sessionId), { force: true });
				return;
			}

			const remaining = getRetainReasons(existing).filter((r) => r !== reason);
			if (remaining.length > 0) {
				index[key] = { ...existing, retain: remaining };
				await writeIndex(index);
				logger.info(
					`Released '${reason}' on transcript mirror ${agentId}/${sessionId}; still held by ${remaining.join('+')}`,
					LOG_CONTEXT
				);
				return;
			}

			await fs.rm(mirrorFilePath(agentId, sessionId), { force: true });
			delete index[key];
			await writeIndex(index);
		});
	} catch (err) {
		captureException(err, { extra: { context: 'releaseTranscriptMirror', agentId, sessionId } });
	}
}

/**
 * Release a snooze's hold on a mirror, rehydrating first.
 *
 * Called when a snoozed tab wakes or is dismissed. The restore runs BEFORE the
 * release so that if the provider aged the transcript out during the snooze, the
 * conversation is put back on disk while we still hold the only copy. Releasing
 * a snooze must never be the operation that loses a conversation.
 */
export async function releaseSnoozedTranscriptMirror(args: {
	agentId: string;
	projectPath: string;
	sessionId: string;
}): Promise<void> {
	const { agentId, projectPath, sessionId } = args;
	await restoreStarredTranscript({ agentId, projectPath, sessionId });
	await releaseTranscriptMirror({ agentId, sessionId, reason: 'snoozed' });
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

/**
 * Mirrored sessions held because they are STARRED (drives the aged-out listing
 * fallback, which renders every row it returns as starred).
 *
 * Filtered by retention reason on purpose: a mirror kept only because its tab is
 * snoozed is not a starred session, and surfacing it here would invent a star the
 * user never set. Snoozed-only sessions need no listing fallback - they come back
 * as a real tab when they wake, and rehydrate through `agentSessions:read`.
 */
export async function listMirroredStarredSessions(): Promise<MirrorIndexEntry[]> {
	try {
		return Object.values(await readIndex()).filter((entry) =>
			getRetainReasons(entry).includes('starred')
		);
	} catch {
		return [];
	}
}

/** One session's transcript to flush at quit, with the reasons it's retained. */
interface PendingFlush {
	agentId: string;
	projectPath: string;
	sessionId: string;
	sessionName?: string;
	reasons: MirrorRetainReason[];
}

/**
 * Collect every transcript worth flushing at quit: starred open tabs, plus every
 * snoozed tab regardless of star. A tab that is both is collected once with both
 * reasons, so the retention set written at quit matches reality.
 */
function collectPendingFlushes(
	sessions: Array<Record<string, unknown>>
): Map<string, PendingFlush> {
	const pending = new Map<string, PendingFlush>();

	const add = (
		agentId: string,
		projectPath: string,
		tab: Record<string, unknown> | undefined,
		reason: MirrorRetainReason
	) => {
		const sessionId = tab?.agentSessionId as string | undefined;
		if (!sessionId) return;
		const key = indexKey(agentId, sessionId);
		const existing = pending.get(key);
		if (existing) {
			if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
			return;
		}
		pending.set(key, {
			agentId,
			projectPath,
			sessionId,
			sessionName: tab?.name as string | undefined,
			reasons: [reason],
		});
	};

	for (const session of sessions) {
		const agentId = (session.toolType as string) || 'claude-code';
		const projectPath = session.projectRoot as string;
		if (!projectPath) continue;

		const aiTabs = session.aiTabs as Array<Record<string, unknown>> | undefined;
		if (Array.isArray(aiTabs)) {
			for (const tab of aiTabs) {
				if (tab.starred === true) add(agentId, projectPath, tab, 'starred');
			}
		}

		// Snoozed tabs are NOT in aiTabs - they live in their own list until they
		// wake, which is exactly why they need flushing here: a months-long snooze
		// far outlives a provider's retention window.
		const snoozedTabs = session.snoozedTabs as Array<Record<string, unknown>> | undefined;
		if (Array.isArray(snoozedTabs)) {
			for (const entry of snoozedTabs) {
				const tab = entry?.tab as Record<string, unknown> | undefined;
				add(agentId, projectPath, tab, 'snoozed');
				if (tab?.starred === true) add(agentId, projectPath, tab, 'starred');
			}
		}
	}

	return pending;
}

/**
 * Synchronous best-effort flush of every retained transcript, for the app-exit
 * path: open starred tabs and every snoozed tab. performCleanup() runs
 * synchronously and the process is SIGKILLed shortly after, so async
 * fire-and-forget copies could be cut off; doing the copies synchronously here
 * guarantees they finish before exit. Each copy is mtime-gated, so unchanged
 * transcripts cost only a stat.
 *
 * `sessions` is the persisted session list (StoredSession[]).
 */
export function flushTranscriptMirrorsSync(sessions: Array<Record<string, unknown>>): void {
	try {
		const indexPath = getIndexPath();
		let index: MirrorIndex = {};
		try {
			index = JSON.parse(fsSync.readFileSync(indexPath, 'utf-8')) as MirrorIndex;
		} catch {
			index = {};
		}

		let dirty = false;
		for (const [key, item] of collectPendingFlushes(sessions)) {
			const { agentId, projectPath, sessionId } = item;
			const src = resolveLocalSourcePath(agentId, projectPath, sessionId);
			if (!src) continue;

			let srcMtimeMs: number;
			try {
				srcMtimeMs = fsSync.statSync(src).mtimeMs;
			} catch {
				continue; // provider file gone; keep existing mirror
			}

			const existing = index[key];
			const sessionName = item.sessionName ?? existing?.sessionName;
			const retain = item.reasons.reduce<MirrorRetainReason[]>(
				(acc, reason) => (acc.includes(reason) ? acc : [...acc, reason]),
				getRetainReasons(existing).filter((r) => item.reasons.includes(r))
			);
			if (
				existing &&
				existing.sourceMtimeMs === srcMtimeMs &&
				existing.sessionName === sessionName &&
				retain.length === getRetainReasons(existing).length
			) {
				continue; // unchanged
			}

			try {
				if (!existing || existing.sourceMtimeMs !== srcMtimeMs) {
					const dest = mirrorFilePath(agentId, sessionId);
					fsSync.mkdirSync(path.dirname(dest), { recursive: true });
					const tmp = `${dest}.tmp`;
					fsSync.copyFileSync(src, tmp);
					fsSync.renameSync(tmp, dest);
				}
				index[key] = {
					agentId,
					projectPath,
					sessionId,
					sessionName,
					sourceMtimeMs: srcMtimeMs,
					mirroredAtMs: Date.now(),
					retain,
				};
				dirty = true;
			} catch {
				// best-effort per session
			}
		}

		if (dirty) {
			fsSync.mkdirSync(path.dirname(indexPath), { recursive: true });
			const tmp = `${indexPath}.tmp`;
			fsSync.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf-8');
			fsSync.renameSync(tmp, indexPath);
		}
	} catch (err) {
		logger.error(`Error flushing transcript mirrors on quit: ${err}`, LOG_CONTEXT);
	}
}
