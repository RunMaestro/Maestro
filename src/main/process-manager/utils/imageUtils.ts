import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { parseDataUrl } from '../../../shared/maestro-lib/launch/image-refs';

// The pure half lives in maestro-lib; re-exported so existing importers keep working.
export {
	parseDataUrl,
	buildImagePromptPrefix,
} from '../../../shared/maestro-lib/launch/image-refs';

/**
 * Save a base64 data URL image to a temp file.
 * Returns the full path to the temp file, or null on failure.
 */
export function saveImageToTempFile(dataUrl: string, index: number): string | null {
	const parsed = parseDataUrl(dataUrl);
	if (!parsed) {
		logger.warn('[ProcessManager] Failed to parse data URL for temp file', 'ProcessManager');
		return null;
	}

	const ext = parsed.mediaType.split('/')[1] || 'png';
	const filename = `maestro-image-${Date.now()}-${index}.${ext}`;
	const tempPath = path.join(os.tmpdir(), filename);

	try {
		const buffer = Buffer.from(parsed.base64, 'base64');
		fs.writeFileSync(tempPath, buffer);
		logger.debug('[ProcessManager] Saved image to temp file', 'ProcessManager', {
			tempPath,
			size: buffer.length,
		});
		return tempPath;
	} catch (error) {
		void captureException(error);
		logger.error('[ProcessManager] Failed to save image to temp file', 'ProcessManager', {
			error: String(error),
		});
		return null;
	}
}

/**
 * Clean up temp image files asynchronously.
 * Fire-and-forget to avoid blocking the main thread.
 */
/**
 * Write a prompt to a unique, exclusively-created temp file for file-backed messages
 * (see `promptFileArgs`). Returns null when the write fails so the caller can
 * fall back to argv delivery. Cleaned up with the process's other temp files.
 */
export function savePromptToTempFile(prompt: string): string | null {
	for (;;) {
		const tempPath = path.join(
			os.tmpdir(),
			`maestro-prompt-${Date.now()}-${process.pid}-${randomUUID()}.md`
		);
		try {
			fs.writeFileSync(tempPath, prompt, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
			return tempPath;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
			void captureException(error);
			logger.error('[ProcessManager] Failed to save prompt to temp file', 'ProcessManager', {
				error: String(error),
			});
			return null;
		}
	}
}

export function cleanupTempFiles(files: string[]): void {
	for (const file of files) {
		fsPromises
			.unlink(file)
			.then(() => {
				logger.debug('[ProcessManager] Cleaned up temp file', 'ProcessManager', { file });
			})
			.catch((error) => {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
					logger.warn('[ProcessManager] Failed to clean up temp file', 'ProcessManager', {
						file,
						error: String(error),
					});
				}
			});
	}
}
