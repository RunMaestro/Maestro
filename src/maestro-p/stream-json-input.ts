// stream-json-input
//
// Translates Claude's `--input-format stream-json` envelope (the same format
// `claude --print --input-format stream-json` ingests) into a plain-text TUI
// prompt with `@/path/to/image.ext` mentions for each embedded image.
//
// Maestro pipes that envelope to us whenever the user attaches an image to a
// Claude Code agent backed by `maestro-p` (see
// src/main/process-manager/spawners/ChildProcessSpawner.ts:104 and
// src/main/process-manager/utils/streamJsonBuilder.ts:27). Without this
// translation the JSON literal - including a multi-KB base64 blob - would be
// typed verbatim into the TUI by tui-driver.ts and no image would attach.
//
// Envelope shape (matches the spawner):
//   { type: 'user',
//     message: { role: 'user',
//                content: [
//                  { type: 'image', source: { type: 'base64',
//                                             media_type: 'image/png',
//                                             data: '<base64>' } },
//                  { type: 'text',  text: '<prompt text>' } ] } }
//
// Output: `@/tmp/maestro-p-image-…-0.png @/tmp/maestro-p-image-…-1.jpeg\n<text>`
// - Claude's prompt-mention parser resolves each `@path` via the Read tool
// (verified end-to-end with `claude --print` returning the OCR'd text of a
// known fixture).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SAFE_MEDIA_TYPE_RE = /^image\/[a-z0-9.+-]+$/i;

export interface TranslatedStreamJson {
	prompt: string;
	imagePaths: string[];
}

/**
 * Decode a `data:image/...;base64,...` URL OR an already-extracted base64 blob
 * paired with a media type into raw bytes plus a sane filename extension.
 * Returns null if the media type is malformed.
 */
function extToFilename(mediaType: string, index: number): string | null {
	if (!SAFE_MEDIA_TYPE_RE.test(mediaType)) return null;
	const ext = mediaType.split('/')[1].split('+')[0] || 'png';
	return `maestro-p-image-${process.pid}-${Date.now()}-${index}.${ext}`;
}

/**
 * Parse a stream-json envelope produced by Maestro's
 * `buildStreamJsonMessage()` and translate it into a TUI-ready prompt with
 * `@path` image mentions.
 *
 * Returns null when the input isn't a recognizable envelope (caller should
 * fall back to treating stdin as a plain-text prompt and warn the user).
 */
export function translateStreamJsonInput(raw: string): TranslatedStreamJson | null {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}

	if (!parsed || typeof parsed !== 'object') return null;
	const envelope = parsed as Record<string, unknown>;
	const message = envelope.message as Record<string, unknown> | undefined;
	if (!message) return null;
	const content = message.content;
	if (!Array.isArray(content)) return null;

	const tmpDir = os.tmpdir();
	const imagePaths: string[] = [];
	const textParts: string[] = [];

	for (const block of content) {
		if (!block || typeof block !== 'object') continue;
		const b = block as Record<string, unknown>;
		const type = b.type;

		if (type === 'text' && typeof b.text === 'string') {
			textParts.push(b.text);
			continue;
		}

		if (type === 'image') {
			const source = b.source as Record<string, unknown> | undefined;
			if (!source || source.type !== 'base64') continue;
			const data = source.data;
			const mediaType = source.media_type;
			if (typeof data !== 'string' || typeof mediaType !== 'string') continue;
			const filename = extToFilename(mediaType, imagePaths.length);
			if (!filename) continue;
			const fullPath = path.join(tmpDir, filename);
			try {
				fs.writeFileSync(fullPath, Buffer.from(data, 'base64'), { mode: 0o600 });
				imagePaths.push(fullPath);
			} catch (err) {
				process.stderr.write(
					`maestro-p: failed to write stream-json image to ${fullPath}: ${(err as Error).message}\n`
				);
			}
		}
	}

	// All on one line, space-separated. TuiDriver.send() submits on the
	// trailing `\r` and does not escape embedded newlines, so a `\n` between
	// the mentions and the text would submit the @paths as their own turn
	// and the text as a second, unintended turn. Multi-line `text` blocks
	// are also joined with spaces for the same reason (and because Claude's
	// envelope only emits multiple text blocks when the caller wants them
	// concatenated anyway). Mention parsing terminates at whitespace, so
	// `@path1 @path2 describe these` resolves to two attachments + prompt.
	const text = textParts.join(' ');
	const mentions = imagePaths.map((p) => `@${p}`).join(' ');
	const prompt = mentions.length > 0 ? (text.length > 0 ? `${mentions} ${text}` : mentions) : text;

	return { prompt, imagePaths };
}

/**
 * Best-effort cleanup of temp files created by translateStreamJsonInput.
 * Synchronous and swallows errors - we call this from process exit paths
 * where async cleanup would race with `process.exit()` and missing-file
 * errors don't matter (the OS will reap /tmp eventually anyway).
 */
export function cleanupStreamJsonImages(paths: readonly string[]): void {
	for (const p of paths) {
		try {
			fs.unlinkSync(p);
		} catch {
			// already gone or unwritable - fine, /tmp gets swept
		}
	}
}
