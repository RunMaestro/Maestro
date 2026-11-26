/**
 * How a turn's images reach a provider that has no prompt-file route, and the bounds an image
 * from another machine must meet before it gets that far.
 *
 * One rule, shared by every spawn that carries images without an explicit file route
 * (`planPipeSpawn`, and `runAgentTurn` for the headless host's chat turns):
 *
 * | Provider | Images travel as |
 * | --- | --- |
 * | Reads stream-json input (Claude Code) | one stream-json user message on stdin, `--input-format stream-json` |
 * | Has an image prompt builder (Copilot) | temp files named in the prompt |
 * | Resumes with `imageResumeMode: 'prompt-embed'` (Codex `resume`) | temp files named in the prompt |
 * | Has image arguments (Codex `-i`) | temp files, one argument each, before the prompt |
 *
 * The temp file writer is the host's (it owns the disk); `writeImageTempFile` is the default a
 * process with no Electron uses.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseBase64DataUrl } from '../../dataUrl';
import type { AgentCapabilities } from '../../types';
import { buildImagePromptPrefix, parseDataUrl } from './image-refs';
import { buildPromptArgv } from './prompt-delivery';

/** The most images one message may carry from another machine. */
export const MAX_TURN_IMAGES = 20;
/** The most decoded bytes one image from another machine may hold. */
export const MAX_TURN_IMAGE_BYTES = 20 * 1024 * 1024;
/**
 * The most decoded bytes all of one message's images may hold together. Under the host's 32 MiB
 * WebSocket frame cap once base64 is counted, so a message the frame carried is never refused
 * here for its size alone.
 */
export const MAX_TURN_IMAGE_TOTAL_BYTES = 23 * 1024 * 1024;

const IMAGE_MEDIA_TYPE = /^image\/[a-z0-9][a-z0-9.+-]*$/;

/** Decoded size of a canonical, padded base64 string, or `null` when it is not one. */
function base64ByteLength(base64: string): number | null {
	if (base64.length === 0 || base64.length % 4 !== 0) return null;
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
	const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
	return (base64.length / 4) * 3 - padding;
}

/**
 * A message's images as they arrived from another machine, admitted or refused whole. Only inline
 * `data:image/...;base64,` URLs are accepted: a `maestro-image://` ref names the SENDER's store,
 * and nothing off the wire may make this machine read its own disk. Count and bytes are bounded
 * (`MAX_TURN_IMAGES`, `MAX_TURN_IMAGE_BYTES`, `MAX_TURN_IMAGE_TOTAL_BYTES`). Absent or empty is
 * no images.
 */
export function admitTurnImages(
	raw: unknown
): { ok: true; images: string[] } | { ok: false; error: string } {
	if (raw === undefined || raw === null) return { ok: true, images: [] };
	if (!Array.isArray(raw)) return { ok: false, error: 'Images must be a list.' };
	if (raw.length > MAX_TURN_IMAGES) {
		return {
			ok: false,
			error: `A message can carry at most ${MAX_TURN_IMAGES} images. Nothing was sent.`,
		};
	}
	let total = 0;
	const images: string[] = [];
	for (const image of raw) {
		const parsed = typeof image === 'string' ? parseBase64DataUrl(image) : null;
		const bytes = parsed ? base64ByteLength(parsed.base64) : null;
		if (!parsed || !IMAGE_MEDIA_TYPE.test(parsed.mediaType) || bytes === null || bytes === 0) {
			return {
				ok: false,
				error: 'An attached image could not be read. Remove it and send again.',
			};
		}
		if (bytes > MAX_TURN_IMAGE_BYTES) {
			return {
				ok: false,
				error: `An attached image is larger than ${MAX_TURN_IMAGE_BYTES / (1024 * 1024)} MB. Nothing was sent.`,
			};
		}
		total += bytes;
		if (total > MAX_TURN_IMAGE_TOTAL_BYTES) {
			return {
				ok: false,
				error: `The attached images are larger than ${MAX_TURN_IMAGE_TOTAL_BYTES / (1024 * 1024)} MB together. Nothing was sent.`,
			};
		}
		images.push(image as string);
	}
	return { ok: true, images };
}

/**
 * Write one image to a fresh, owner-only temp file and answer its path. `null` when the value is
 * not an image this machine can read. Never overwrites: a name collision picks another name.
 * Throws when the disk refuses the write.
 */
export function writeImageTempFile(
	dataUrl: string,
	index: number,
	tempDir: string = os.tmpdir()
): string | null {
	const parsed = parseDataUrl(dataUrl);
	if (!parsed) return null;
	const ext = (parsed.mediaType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
	const buffer = Buffer.from(parsed.base64, 'base64');
	for (;;) {
		const filename = `maestro-image-${Date.now()}-${process.pid}-${randomUUID()}-${index}.${ext}`;
		const tempPath = path.join(tempDir, filename);
		try {
			fs.writeFileSync(tempPath, buffer, { mode: 0o600, flag: 'wx' });
			return tempPath;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
			throw error;
		}
	}
}

export interface ImageDeliveryInput {
	/** The arguments before the prompt. */
	args: readonly string[];
	/** The prompt the images go with. */
	prompt: string;
	images: readonly string[];
	capabilities: Pick<AgentCapabilities, 'supportsStreamJsonInput' | 'imageResumeMode'>;
	imageArgs?: (imagePath: string) => string[];
	imagePromptBuilder?: (imagePaths: string[]) => string;
	promptArgs?: (prompt: string) => string[];
	noPromptSeparator?: boolean;
	/** The prompt travels on stdin, not on the command line: it is never appended to `args`. */
	promptViaStdin: boolean;
}

export type ImageDelivery =
	/**
	 * Images and prompt travel as one stream-json message on stdin
	 * (`buildStreamJsonMessage(prompt, images)`, then a newline). `args` carry
	 * `--input-format stream-json`.
	 */
	| { via: 'stream-json'; args: string[] }
	/**
	 * The images were written to `tempFiles` (the caller removes them when the turn ends). `prompt`
	 * is the prompt as the provider gets it (with the file names in front when the provider reads
	 * them from the prompt); it is already the tail of `args` unless `promptViaStdin`. `dropped`
	 * counts images the writer could not write.
	 */
	| {
			via: 'files';
			args: string[];
			prompt: string;
			promptInArgs: boolean;
			tempFiles: string[];
			dropped: number;
	  }
	/** The provider has no way to take images. */
	| { via: 'none' };

/**
 * Decide how a turn's images reach the provider. `saveImageToTempFile` is called only for a
 * provider that reads images from files, once per image, in order.
 */
export function planImageDelivery(
	input: ImageDeliveryInput,
	saveImageToTempFile: (dataUrl: string, index: number) => string | null
): ImageDelivery {
	const { args, prompt, images, capabilities, imageArgs, imagePromptBuilder } = input;
	const appendPrompt = (base: string[], text: string): string[] =>
		input.promptViaStdin
			? base
			: [
					...base,
					...buildPromptArgv(
						{ promptArgs: input.promptArgs, noPromptSeparator: input.noPromptSeparator },
						text
					),
				];

	if (capabilities.supportsStreamJsonInput) {
		// Claude Code reads the JSON+base64 message only with this flag; without it the raw JSON
		// is taken as a plain-text prompt.
		const inputFormat = args.includes('--input-format') ? [] : ['--input-format', 'stream-json'];
		return { via: 'stream-json', args: [...args, ...inputFormat] };
	}
	if (!imageArgs && !imagePromptBuilder) return { via: 'none' };

	const tempFiles: string[] = [];
	let dropped = 0;
	images.forEach((image, index) => {
		const tempPath = saveImageToTempFile(image, index);
		if (tempPath) tempFiles.push(tempPath);
		else dropped += 1;
	});

	const isResumeWithPromptEmbed =
		capabilities.imageResumeMode === 'prompt-embed' && args.some((arg) => arg === 'resume');
	if (imagePromptBuilder || isResumeWithPromptEmbed) {
		// The provider reads the images from paths named in the prompt.
		const embedded =
			(imagePromptBuilder ? imagePromptBuilder(tempFiles) : buildImagePromptPrefix(tempFiles)) +
			prompt;
		return {
			via: 'files',
			args: appendPrompt([...args], embedded),
			prompt: embedded,
			promptInArgs: !input.promptViaStdin,
			tempFiles,
			dropped,
		};
	}
	const withImages = [...args];
	for (const tempPath of tempFiles) withImages.push(...imageArgs!(tempPath));
	return {
		via: 'files',
		args: appendPrompt(withImages, prompt),
		prompt,
		promptInArgs: !input.promptViaStdin,
		tempFiles,
		dropped,
	};
}
