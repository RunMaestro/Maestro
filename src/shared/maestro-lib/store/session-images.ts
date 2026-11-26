/**
 * The session image store: content-addressed files for images pasted into AI conversations, so a
 * transcript, a staged draft, or a queued message keeps a light `maestro-image://store/<sha>.<ext>`
 * reference instead of a multi-megabyte data URL.
 *
 * One implementation for every process that owns a data directory:
 *
 * - the desktop (`src/main/storage/session-image-store.ts` points one at `<syncPath>/session-images`
 *   and adds the protocol handler's thumbnails), and
 * - the headless host (`maestro-cli host`), which points one at `MaestroPaths.sessionImagesDir`,
 *   the same folder in the same data directory.
 *
 * Why it exists: a sessions store that holds images inline is rewritten whole on every write, so a
 * few screenshots make every later write serialize hundreds of megabytes (a field trace found 264 MB
 * of base64 in one 272 MB sessions file). The reference grammar lives in `src/shared/sessionImageRefs.ts`.
 *
 * Nothing is lost: a reference resolves back to its bytes or a data URL on demand (a provider spawn,
 * a wire read, an export).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

import { parseBase64DataUrl } from '../../dataUrl';
import { getImageMimeType } from '../../gitUtils';
import { SESSION_IMAGE_REF_PREFIX, sessionImageRefBasename } from '../../sessionImageRefs';
import { logger } from '../host';
import { atomicWriteFile } from './atomic-write';

const LOG_CONTEXT = 'SessionImageStore';

/**
 * mediaType (e.g. 'image/png') to the file extension the store names it with. `svg+xml` is `svg`;
 * everything else is the subtype.
 */
export function extFromMediaType(mediaType: string): string {
	const sub = mediaType.split('/')[1]?.toLowerCase() ?? 'png';
	if (sub === 'svg+xml') return 'svg';
	if (sub === 'jpeg') return 'jpeg';
	return sub;
}

/** True if `value` is an inline base64 image data URL. */
export function isInlineImageDataUrl(value: unknown): value is string {
	return typeof value === 'string' && value.startsWith('data:image/');
}

/** Parse an inline image data URL into its media type and base64 payload, or null. */
function parseImageDataUrl(dataUrl: string): { mediaType: string; base64: string } | null {
	const parsed = parseBase64DataUrl(dataUrl);
	return parsed && parsed.mediaType.startsWith('image/') ? parsed : null;
}

/** Drop a `?query` / `#fragment` suffix from a ref URL (a thumbnail request names the same file). */
function stripRefQuery(ref: string): string {
	const query = ref.indexOf('?');
	const fragment = ref.indexOf('#');
	const cut = query === -1 ? fragment : fragment === -1 ? query : Math.min(query, fragment);
	return cut === -1 ? ref : ref.slice(0, cut);
}

export interface SessionImageStore {
	/**
	 * A ref's file path, or null when it is not a ref this store could have written. The basename
	 * grammar (`sessionImageRefBasename`) is the traversal guard. A `?query` selects a rendition, not
	 * another file, so it is ignored.
	 */
	resolveToFilePath(ref: string): string | null;
	/**
	 * Store an inline image data URL and answer its ref. Anything else (a ref already, a non-image)
	 * comes back unchanged, so it is safe over a mixed array. Identical bytes store once.
	 */
	storeInlineImage(value: string): Promise<string>;
	/** A ref (or a data URL, unchanged) as a data URL; null when a ref's file is missing. */
	resolveToDataUrl(value: string): Promise<string | null>;
	/** A ref (or a data URL) as bytes and media type; null when a ref's file is missing. */
	resolveToBytesSync(value: string): { buffer: Buffer; mediaType: string } | null;
	/** The synchronous `resolveToDataUrl`. */
	resolveToDataUrlSync(value: string): string | null;
	/**
	 * Every inline image under the sessions' image fields replaced by a ref (see
	 * `relocateSessionImages` below). Reference-stable: what did not change comes back as given.
	 */
	relocateSessionImages<T>(sessions: T[]): Promise<{ sessions: T[]; relocated: number }>;
}

/**
 * A store over the directory `getDir()` answers. Asked on each use, so the desktop can configure its
 * folder after import and create it lazily.
 */
export function createSessionImageStore(getDir: () => string): SessionImageStore {
	const resolveToFilePath = (ref: string): string | null => {
		const basename = sessionImageRefBasename(stripRefQuery(ref));
		if (!basename) return null;
		return path.join(getDir(), basename);
	};

	const storeInlineImage = async (value: string): Promise<string> => {
		if (!isInlineImageDataUrl(value)) return value;
		const parsed = parseImageDataUrl(value);
		if (!parsed) return value;
		const buffer = Buffer.from(parsed.base64, 'base64');
		const sha = crypto.createHash('sha256').update(buffer).digest('hex');
		const basename = `${sha}.${extFromMediaType(parsed.mediaType)}`;
		// A media type the ref grammar cannot name would make a ref nothing can read back: keep the
		// value inline rather than lose the image.
		if (!sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${basename}`)) return value;
		const filePath = path.join(getDir(), basename);
		// Content-addressed: the same bytes always hash to the same name, so a file already there
		// is this image. Written through a temp file, so a crash never leaves a short file under a
		// name that would then never be rewritten.
		try {
			await fsPromises.access(filePath);
		} catch {
			await atomicWriteFile(filePath, buffer);
		}
		return `${SESSION_IMAGE_REF_PREFIX}${basename}`;
	};

	const resolveToDataUrl = async (value: string): Promise<string | null> => {
		if (isInlineImageDataUrl(value)) return value;
		const filePath = resolveToFilePath(value);
		if (!filePath) return null;
		try {
			const buffer = await fsPromises.readFile(filePath);
			const ext = path.extname(filePath).slice(1);
			return `data:${getImageMimeType(ext)};base64,${buffer.toString('base64')}`;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
			logger.warn(`Missing session image for ref: ${value}`, LOG_CONTEXT);
			return null;
		}
	};

	const resolveToBytesSync = (value: string): { buffer: Buffer; mediaType: string } | null => {
		if (isInlineImageDataUrl(value)) {
			const parsed = parseImageDataUrl(value);
			if (!parsed) return null;
			return { buffer: Buffer.from(parsed.base64, 'base64'), mediaType: parsed.mediaType };
		}
		const filePath = resolveToFilePath(value);
		if (!filePath) return null;
		try {
			const buffer = fs.readFileSync(filePath);
			const ext = path.extname(filePath).slice(1);
			return { buffer, mediaType: getImageMimeType(ext) };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
			logger.warn(`Missing session image for ref: ${value}`, LOG_CONTEXT);
			return null;
		}
	};

	const resolveToDataUrlSync = (value: string): string | null => {
		if (isInlineImageDataUrl(value)) return value;
		const resolved = resolveToBytesSync(value);
		if (!resolved) return null;
		return `data:${resolved.mediaType};base64,${resolved.buffer.toString('base64')}`;
	};

	return {
		resolveToFilePath,
		storeInlineImage,
		resolveToDataUrl,
		resolveToBytesSync,
		resolveToDataUrlSync,
		relocateSessionImages: (sessions) => relocateSessionImages(sessions, storeInlineImage),
	};
}

/**
 * Whether any session holds an inline image in a field `relocateSessionImages` walks. Synchronous
 * and allocation-free, so a writer can skip the relocation pass on the (usual) write with nothing to
 * move.
 */
export function hasInlineSessionImages(sessions: readonly unknown[]): boolean {
	const anyInline = (images: unknown): boolean =>
		Array.isArray(images) && images.some((image) => isInlineImageDataUrl(image));
	const tabHasInline = (tab: unknown): boolean => {
		if (!tab || typeof tab !== 'object') return false;
		const record = tab as Record<string, unknown>;
		if (Array.isArray(record.logs)) {
			for (const log of record.logs) {
				if (log && typeof log === 'object' && anyInline((log as Record<string, unknown>).images)) {
					return true;
				}
			}
		}
		if (anyInline(record.stagedImages)) return true;
		return (
			Array.isArray(record.stagedDesignPicks) &&
			record.stagedDesignPicks.some(
				(pick) =>
					!!pick &&
					typeof pick === 'object' &&
					isInlineImageDataUrl((pick as Record<string, unknown>).screenshot)
			)
		);
	};
	for (const raw of sessions) {
		if (!raw || typeof raw !== 'object') continue;
		const session = raw as Record<string, unknown>;
		if (Array.isArray(session.aiTabs) && session.aiTabs.some(tabHasInline)) return true;
		if (
			Array.isArray(session.unifiedClosedTabHistory) &&
			session.unifiedClosedTabHistory.some(
				(entry) =>
					!!entry &&
					typeof entry === 'object' &&
					(entry as Record<string, unknown>).type === 'ai' &&
					tabHasInline((entry as Record<string, unknown>).tab)
			)
		) {
			return true;
		}
		if (
			Array.isArray(session.executionQueue) &&
			session.executionQueue.some(
				(item) =>
					!!item && typeof item === 'object' && anyInline((item as Record<string, unknown>).images)
			)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Replace every inline image data URL found under the sessions' image-bearing fields with a ref,
 * storing the bytes through `store`. Only clones the parts of the tree that change, so a pass over
 * already-relocated sessions does no writes and allocates nothing new.
 *
 * Walks `aiTabs[].logs[].images`, `aiTabs[].stagedImages`, `aiTabs[].stagedDesignPicks[].screenshot`,
 * the same three fields of every closed AI tab in `unifiedClosedTabHistory`, and
 * `executionQueue[].images`. A Design Mode chip owns its screenshot (it is never copied into
 * `stagedImages`), which is why the chips get a walk of their own.
 */
async function relocateSessionImages<T>(
	sessions: T[],
	store: (value: string) => Promise<string>
): Promise<{ sessions: T[]; relocated: number }> {
	let relocated = 0;

	// Store one value if it is an inline image data URL and return its ref. Anything else comes back
	// unchanged, so callers detect a no-op by comparing against what they passed in.
	const relocateValue = async (value: unknown): Promise<unknown> => {
		if (!isInlineImageDataUrl(value)) return value;
		const ref = await store(value);
		if (ref !== value) relocated++;
		return ref;
	};

	// The same array back when nothing changed.
	const relocateArray = async (images: unknown): Promise<string[] | undefined> => {
		if (!Array.isArray(images) || images.length === 0) return images as undefined;
		let changed = false;
		const next: string[] = new Array(images.length);
		for (let i = 0; i < images.length; i++) {
			next[i] = (await relocateValue(images[i])) as string;
			if (next[i] !== images[i]) changed = true;
		}
		return changed ? next : (images as string[]);
	};

	const relocateDesignPicks = async (picks: unknown): Promise<unknown> => {
		if (!Array.isArray(picks) || picks.length === 0) return picks;
		let changed = false;
		const next = await Promise.all(
			picks.map(async (pick: unknown) => {
				if (!pick || typeof pick !== 'object') return pick;
				const chip = pick as Record<string, unknown>;
				const screenshot = await relocateValue(chip.screenshot);
				if (screenshot === chip.screenshot) return pick;
				changed = true;
				return { ...chip, screenshot };
			})
		);
		return changed ? next : picks;
	};

	// One AI tab's `logs[].images`, `stagedImages` and `stagedDesignPicks`; the same tab back when
	// nothing changed.
	const relocateTab = async (tab: Record<string, unknown>): Promise<Record<string, unknown>> => {
		let tabChanged = false;
		const tabPatch: Record<string, unknown> = {};

		const logs = tab.logs as Array<Record<string, unknown>> | undefined;
		if (Array.isArray(logs)) {
			let logsChanged = false;
			const nextLogs = await Promise.all(
				logs.map(async (log) => {
					if (!log || typeof log !== 'object') return log;
					const nextImages = await relocateArray(log.images);
					if (nextImages !== log.images) {
						logsChanged = true;
						return { ...log, images: nextImages };
					}
					return log;
				})
			);
			if (logsChanged) {
				tabPatch.logs = nextLogs;
				tabChanged = true;
			}
		}

		const nextStaged = await relocateArray(tab.stagedImages);
		if (nextStaged !== tab.stagedImages) {
			tabPatch.stagedImages = nextStaged;
			tabChanged = true;
		}

		const nextPicks = await relocateDesignPicks(tab.stagedDesignPicks);
		if (nextPicks !== tab.stagedDesignPicks) {
			tabPatch.stagedDesignPicks = nextPicks;
			tabChanged = true;
		}

		return tabChanged ? { ...tab, ...tabPatch } : tab;
	};

	const nextSessions = await Promise.all(
		sessions.map(async (rawSession) => {
			if (!rawSession || typeof rawSession !== 'object') return rawSession;
			const session = rawSession as unknown as Record<string, unknown>;
			let sessionChanged = false;
			const patch: Record<string, unknown> = {};

			const aiTabs = session.aiTabs as Array<Record<string, unknown>> | undefined;
			if (Array.isArray(aiTabs)) {
				let tabsChanged = false;
				const nextTabs = await Promise.all(
					aiTabs.map(async (tab) => {
						if (!tab || typeof tab !== 'object') return tab;
						const next = await relocateTab(tab);
						if (next !== tab) tabsChanged = true;
						return next;
					})
				);
				if (tabsChanged) {
					patch.aiTabs = nextTabs;
					sessionChanged = true;
				}
			}

			// A stored closed tab keeps its draft and, when its provider cannot give the transcript
			// back, its logs, so a pasted image there must not put base64 back into the file.
			const closedTabs = session.unifiedClosedTabHistory as
				| Array<Record<string, unknown>>
				| undefined;
			if (Array.isArray(closedTabs)) {
				let closedChanged = false;
				const nextClosed = await Promise.all(
					closedTabs.map(async (entry) => {
						if (!entry || entry.type !== 'ai' || !entry.tab || typeof entry.tab !== 'object') {
							return entry;
						}
						const tab = entry.tab as Record<string, unknown>;
						const next = await relocateTab(tab);
						if (next === tab) return entry;
						closedChanged = true;
						return { ...entry, tab: next };
					})
				);
				if (closedChanged) {
					patch.unifiedClosedTabHistory = nextClosed;
					sessionChanged = true;
				}
			}

			const queue = session.executionQueue as Array<Record<string, unknown>> | undefined;
			if (Array.isArray(queue)) {
				let queueChanged = false;
				const nextQueue = await Promise.all(
					queue.map(async (item) => {
						if (!item || typeof item !== 'object') return item;
						const nextImages = await relocateArray(item.images);
						if (nextImages !== item.images) {
							queueChanged = true;
							return { ...item, images: nextImages };
						}
						return item;
					})
				);
				if (queueChanged) {
					patch.executionQueue = nextQueue;
					sessionChanged = true;
				}
			}

			return sessionChanged ? ({ ...session, ...patch } as unknown as T) : rawSession;
		})
	);

	return { sessions: nextSessions, relocated };
}
