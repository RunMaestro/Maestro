/**
 * Bundles a capture into a single .zip: the raw trace, the capture metadata,
 * and a short README pointing at the offline-analysis workflow. The trace is
 * streamed straight from disk into the archive so a large trace never lands in
 * memory, and zlib level 9 squeezes the (highly repetitive) trace JSON by ~90%.
 */

import fs from 'fs';
import archiver from 'archiver';
import { logger } from '../utils/logger';
import type { ProfileMetadata } from './types';

const LOG_CONTEXT = '[Profiling]';

function readme(meta: ProfileMetadata): string {
	return [
		'# Maestro Performance Profile bundle',
		'',
		`Captured ${meta.capturedAt} from Maestro v${meta.appVersion} (${meta.platform} ${meta.arch}).`,
		`Recording ran for ${(meta.profilingDurationMs / 1000).toFixed(1)}s.`,
		'',
		'## Contents',
		'',
		'- `trace.json` - the full Chromium trace (Trace Event format).',
		'- `metadata.json` - capture context (versions, hardware, categories, duration).',
		'',
		'## How to analyze',
		'',
		'This is a development-time artifact. Two options:',
		'',
		'1. Load `trace.json` into https://ui.perfetto.dev (or `chrome://tracing`) for the',
		'   full flame chart.',
		'2. Run the repo dev script for a text summary of long tasks / self-time:',
		'   `node scripts/analyze-perf-trace.mjs <this-bundle>.zip`',
		'',
		'See CLAUDE-PERFORMANCE.md ("Field performance traces") for how to feed this to',
		'an optimizing agent.',
		'',
		'## Privacy note',
		'',
		'A Chromium trace can contain script URLs and file paths. Review before sharing',
		'outside your team.',
		'',
	].join('\n');
}

/**
 * Compression is the slow part of a capture (a large trace can take tens of
 * seconds at zlib level 9), so `onProgress` reports 0-100 as bytes are read off
 * disk into the archive. The trace dominates the byte count, so its read
 * progress is a faithful proxy for the whole bundle.
 *
 * @returns absolute path + compressed size of the written .zip.
 */
export function writeProfileBundle(
	tracePath: string,
	meta: ProfileMetadata,
	outputPath: string,
	onProgress?: (percent: number, bytesProcessed: number, totalBytes: number) => void
): Promise<{ path: string; sizeBytes: number }> {
	return new Promise((resolve, reject) => {
		const output = fs.createWriteStream(outputPath);
		const archive = archiver('zip', { zlib: { level: 9 } });

		output.on('close', () => {
			logger.info(`${LOG_CONTEXT} Bundle written: ${outputPath} (${archive.pointer()} bytes)`);
			resolve({ path: outputPath, sizeBytes: archive.pointer() });
		});
		archive.on('error', (err) => reject(err));

		if (onProgress) {
			// archiver reports cumulative bytes read from the source files. The
			// trace is the overwhelming majority, so use the known trace size as the
			// denominator and cap at 99 - the final 1% is the flush/close.
			const total = meta.traceSizeBytes || 0;
			archive.on('progress', (data) => {
				const processed = data?.fs?.processedBytes ?? 0;
				const percent = total > 0 ? Math.min(99, Math.round((processed / total) * 100)) : 0;
				onProgress(percent, processed, total);
			});
		}

		archive.pipe(output);
		archive.append(JSON.stringify(meta, null, 2), { name: 'metadata.json' });
		archive.append(readme(meta), { name: 'README.md' });
		// Stream the trace from disk rather than buffering it.
		archive.file(tracePath, { name: 'trace.json' });

		archive.finalize();
	});
}
