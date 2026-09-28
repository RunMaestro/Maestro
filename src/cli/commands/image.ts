// Image commands - list and save the images a user pasted into a chat.
//
// A pasted screenshot reaches an agent as pixels in its context: it can SEE the
// image but has no path to it, so "save that screenshot to the repo" was a
// right-click the human had to perform (ImageContextMenu -> Save to Project).
// These two verbs give the agent the same reach.
//
// The bytes are read straight off disk rather than from the running app. Pasted
// images are relocated into the content-addressed store
// (`<userData>/session-images/<sha>.<ext>`, see
// src/main/storage/session-image-store.ts) and the transcript keeps a
// `maestro-image://store/...` reference, so the sessions file the CLI already
// reads is enough. That also means these work with the desktop closed. The one
// cost is the renderer's 2s persistence debounce: an image pasted and asked
// about in the same instant may not be on disk yet, which is what the
// NO_IMAGES message says out loud.
//
// After writing, `image save` nudges the desktop's Files panel for whichever
// agents own the written paths, so the new file shows up in the tree instead of
// waiting for its next timed refresh. That nudge is best-effort: the bytes are
// already on disk, so a closed desktop must not turn a good save into an error.

import * as fs from 'fs';
import * as path from 'path';
import { readSessions, resolveAgentId, getConfigDir } from '../services/storage';
import {
	configureImageStore,
	extFromMediaType,
	isImageRef,
	resolveToBytesSync,
	IMAGE_REF_PREFIX,
} from '../../main/storage/session-image-store';
import { fileTimestampSlug, formatSize, formatRelativeTime } from '../../shared/formatters';
import { nudgeFileTreeForPaths } from '../services/file-tree-refresh';
import { ExitCode, exitWith } from '../exit-codes';

export interface ImageListOptions {
	agent?: string;
	tab?: string;
	limit?: string;
	json?: boolean;
}

export interface ImageSaveOptions {
	agent?: string;
	tab?: string;
	output?: string;
	all?: boolean;
	force?: boolean;
	json?: boolean;
}

/** One image found in a transcript, in newest-first order. */
interface CollectedImage {
	/** 1-based position in the newest-first list; what `image save <n>` takes. */
	index: number;
	/** `maestro-image://store/<sha>.<ext>`, or a data URL not yet relocated. */
	ref: string;
	agentId: string;
	agentName: string;
	tabId: string;
	tabName: string;
	/** Timestamp of the message the image rode in on; absent while staged. */
	timestamp?: number;
	/** True while the image sits in the composer, pasted but not yet sent. */
	staged: boolean;
	/** First line of that message, to tell two screenshots apart. */
	message?: string;
}

/** Structural view of the parts of the sessions file that carry images. */
interface ImageBearingTab {
	id?: string;
	name?: string;
	stagedImages?: string[];
	logs?: Array<{ timestamp?: number; text?: string; images?: string[] }>;
}

function emitError(error: string, code: string, json?: boolean): never {
	if (json) console.log(JSON.stringify({ success: false, error, code }, null, 2));
	else console.error(`Error: ${error}`);
	return exitWith(code === 'INVALID_USAGE' ? ExitCode.InvalidUsage : ExitCode.GeneralError);
}

/** Short, single-line preview of the message an image was attached to. */
function messagePreview(text: string | undefined): string | undefined {
	const line = text
		?.split('\n')
		.find((l) => l.trim().length > 0)
		?.trim();
	if (!line) return undefined;
	return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/**
 * Every image in scope, newest first.
 *
 * Staged images sort ahead of everything else: they have no timestamp because
 * they have not been sent, and the thing sitting in the composer right now is
 * by definition the most recently pasted. Within one message the images are
 * reversed too, so index 1 is always the last image the user added.
 */
function collectImages(opts: { agentId?: string; tabId?: string }): CollectedImage[] {
	const staged: CollectedImage[] = [];
	const sent: CollectedImage[] = [];

	for (const session of readSessions()) {
		if (opts.agentId && session.id !== opts.agentId) continue;
		const tabs = ((session as unknown as { aiTabs?: ImageBearingTab[] }).aiTabs ??
			[]) as ImageBearingTab[];

		for (const tab of tabs) {
			if (opts.tabId && tab.id !== opts.tabId) continue;
			const base = {
				index: 0,
				agentId: session.id,
				agentName: session.name,
				tabId: tab.id ?? '',
				tabName: tab.name ?? 'Untitled',
			};

			for (const ref of [...(tab.stagedImages ?? [])].reverse()) {
				staged.push({ ...base, ref, staged: true });
			}

			for (const log of tab.logs ?? []) {
				if (!log.images?.length) continue;
				for (const ref of [...log.images].reverse()) {
					sent.push({
						...base,
						ref,
						staged: false,
						timestamp: log.timestamp,
						message: messagePreview(log.text),
					});
				}
			}
		}
	}

	sent.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
	return [...staged, ...sent].map((image, i) => ({ ...image, index: i + 1 }));
}

/** Resolve `--agent` / `--tab` into a scope, failing loudly on an unknown agent. */
function resolveScope(
	options: { agent?: string; tab?: string; json?: boolean },
	label: string
): { agentId?: string; tabId?: string } {
	let agentId: string | undefined;
	if (options.agent) {
		try {
			agentId = resolveAgentId(options.agent);
		} catch (error) {
			emitError(
				error instanceof Error ? error.message : String(error),
				'AGENT_NOT_FOUND',
				options.json
			);
		}
	}
	const tabId = options.tab?.trim() || undefined;
	if (options.tab !== undefined && !tabId) {
		emitError(`${label} --tab requires a tab id`, 'INVALID_USAGE', options.json);
	}
	return { agentId, tabId };
}

/** The `<sha>.<ext>` part of a ref, or null for an inline data URL. */
function refBasename(ref: string): string | null {
	return isImageRef(ref) ? ref.slice(IMAGE_REF_PREFIX.length) : null;
}

/** Short handle an agent can pass back to `image save`, e.g. `4c211deb`. */
function refHandle(ref: string): string {
	const basename = refBasename(ref);
	return basename ? basename.slice(0, 8) : 'inline';
}

export function imageList(options: ImageListOptions): void {
	const { agentId, tabId } = resolveScope(options, 'image list');
	const images = collectImages({ agentId, tabId });

	const parsedLimit = options.limit ? Number(options.limit) : 20;
	if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
		emitError('--limit must be a positive number', 'INVALID_USAGE', options.json);
	}
	const shown = images.slice(0, parsedLimit);

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					success: true,
					total: images.length,
					images: shown.map((image) => ({
						index: image.index,
						ref: image.ref,
						handle: refHandle(image.ref),
						agentId: image.agentId,
						agentName: image.agentName,
						tabId: image.tabId,
						tabName: image.tabName,
						staged: image.staged,
						timestamp: image.timestamp ?? null,
						message: image.message ?? null,
					})),
				},
				null,
				2
			)
		);
		return;
	}

	if (shown.length === 0) {
		console.log(
			'No pasted images found. Images are written to disk a couple of seconds after the message is sent.'
		);
		return;
	}

	// One image per line so the output greps and pipes cleanly.
	// Columns: index | handle | when | agent | tab | message.
	for (const image of shown) {
		const when = image.staged
			? 'staged'
			: image.timestamp
				? formatRelativeTime(image.timestamp)
				: 'unknown';
		const message = image.message ? `  ${image.message}` : '';
		console.log(
			`${String(image.index).padStart(3)}  ${refHandle(image.ref).padEnd(8)}  ${when.padEnd(
				12
			)}  ${image.agentName}  ${image.tabName}${message}`
		);
	}
	if (images.length > shown.length) {
		console.log(`\n${images.length - shown.length} more (raise --limit to see them).`);
	}
}

/**
 * Pick the images `image save` should write.
 *
 * `--all` takes the whole scope rather than just the newest message: an agent
 * asked to "save the screenshots" usually means the conversation, and narrowing
 * the scope with `--tab` is the way to mean less than that.
 */
function selectImages(
	images: CollectedImage[],
	target: string | undefined,
	options: ImageSaveOptions
): CollectedImage[] {
	if (options.all) return images;

	const token = target?.trim();
	if (!token || token === 'latest') return [images[0]];

	if (/^\d+$/.test(token)) {
		const picked = images[Number(token) - 1];
		if (!picked) {
			emitError(
				`No image at index ${token} (${images.length} available). Run "maestro-cli image list".`,
				'IMAGE_NOT_FOUND',
				options.json
			);
		}
		return [picked];
	}

	// A ref, a `<sha>.<ext>` basename, or a hex prefix of either.
	const needle = (isImageRef(token) ? refBasename(token)! : token).toLowerCase();
	const matches = images.filter((image) => refBasename(image.ref)?.startsWith(needle));
	const unique = matches.filter((image, i) => matches.findIndex((m) => m.ref === image.ref) === i);
	if (unique.length === 0) {
		emitError(
			`No image matching '${token}'. Run "maestro-cli image list" for handles.`,
			'IMAGE_NOT_FOUND',
			options.json
		);
	}
	if (unique.length > 1) {
		emitError(
			`'${token}' matches ${unique.length} images - pass more characters of the handle.`,
			'AMBIGUOUS_IMAGE',
			options.json
		);
	}
	return [unique[0]];
}

/** True when `--output` names a folder rather than a file to write. */
function looksLikeDirectory(output: string): boolean {
	if (output.endsWith('/') || output.endsWith(path.sep)) return true;
	try {
		return fs.statSync(output).isDirectory();
	} catch {
		return false;
	}
}

/** Force `name` to carry `ext`, so the extension never lies about the bytes. */
function forceExtension(name: string, ext: string): string {
	const dot = name.lastIndexOf('.');
	const base = dot > 0 ? name.slice(0, dot) : name;
	return `${base}.${ext}`;
}

/** `pasted-image-20260713-142530.png`, stamped with when the image was sent. */
function generatedName(image: CollectedImage, ext: string): string {
	return `pasted-image-${fileTimestampSlug(image.timestamp ?? Date.now())}.${ext}`;
}

/** First free `name`, `name-2`, `name-3`, ... in `dir`. */
function uniquePath(dir: string, name: string, ext: string): string {
	const base = name.slice(0, name.length - ext.length - 1);
	for (let n = 1; n <= 100; n++) {
		const candidate = n === 1 ? name : `${base}-${n}.${ext}`;
		const full = path.join(dir, candidate);
		if (!fs.existsSync(full)) return full;
	}
	throw new Error(`Too many files named like ${name} already exist in ${dir}`);
}

export async function imageSave(
	target: string | undefined,
	options: ImageSaveOptions
): Promise<void> {
	const { agentId, tabId } = resolveScope(options, 'image save');
	configureImageStore(getConfigDir());

	const images = collectImages({ agentId, tabId });
	if (images.length === 0) {
		emitError(
			'No pasted images found. Images are written to disk a couple of seconds after the message is sent.',
			'NO_IMAGES',
			options.json
		);
	}

	const selected = selectImages(images, target, options);

	const output = options.output?.trim();
	// `--all` writes a set, so its `--output` is always a folder to fill - even
	// one that does not exist yet, and even when the scope happens to hold a
	// single image. Deciding by image COUNT instead would make the same command
	// create `batch/` on one conversation and a file called `batch.png` on
	// another, which is the kind of surprise an agent cannot see coming.
	const outputIsDir = !output || Boolean(options.all) || looksLikeDirectory(output);
	if (output && options.all && fs.existsSync(output) && !fs.statSync(output).isDirectory()) {
		emitError(
			`--output must be a directory when --all is passed (${output} is a file)`,
			'INVALID_USAGE',
			options.json
		);
	}
	// No --output means the working directory the agent is already standing in,
	// which is what "save it to the project" means from a shell.
	const dir = outputIsDir
		? path.resolve(output || process.cwd())
		: path.dirname(path.resolve(output!));

	const saved: Array<{ path: string; bytes: number; ref: string; index: number }> = [];
	try {
		fs.mkdirSync(dir, { recursive: true });

		for (const image of selected) {
			const resolved = resolveToBytesSync(image.ref);
			if (!resolved) {
				emitError(
					`The bytes for image ${image.index} (${refHandle(image.ref)}) are missing from the store.`,
					'IMAGE_MISSING',
					options.json
				);
			}
			// The extension comes from the bytes, never from the requested name:
			// a JPEG saved as .png is a file every downstream decoder rejects.
			const ext = extFromMediaType(resolved.mediaType);

			let destination: string;
			if (outputIsDir) {
				destination = uniquePath(dir, generatedName(image, ext), ext);
			} else {
				destination = path.join(dir, forceExtension(path.basename(path.resolve(output!)), ext));
				if (fs.existsSync(destination) && !options.force) {
					emitError(
						`${destination} already exists - pass --force to overwrite it.`,
						'FILE_EXISTS',
						options.json
					);
				}
			}

			fs.writeFileSync(destination, resolved.buffer);
			saved.push({
				path: destination,
				bytes: resolved.buffer.length,
				ref: image.ref,
				index: image.index,
			});
		}
	} catch (error) {
		emitError(error instanceof Error ? error.message : String(error), 'WRITE_FAILED', options.json);
	}

	// A file just appeared in somebody's workspace. The Files panel refreshes on
	// a timer, so without this the image is invisible in the tree the user is
	// looking at and the save reads as having done nothing. Best-effort by
	// design: the bytes are already on disk, so a closed desktop must not turn a
	// successful save into a failure.
	const refreshed = await nudgeFileTreeForPaths(saved.map((file) => file.path));

	if (options.json) {
		console.log(JSON.stringify({ success: true, saved, refreshedAgents: refreshed }, null, 2));
		return;
	}
	for (const file of saved) {
		console.log(`Saved ${file.path} (${formatSize(file.bytes)})`);
	}
}
