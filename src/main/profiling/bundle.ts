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
 * @returns absolute path + compressed size of the written .zip.
 */
export function writeProfileBundle(
	tracePath: string,
	meta: ProfileMetadata,
	outputPath: string
): Promise<{ path: string; sizeBytes: number }> {
	return new Promise((resolve, reject) => {
		const output = fs.createWriteStream(outputPath);
		const archive = archiver('zip', { zlib: { level: 9 } });

		output.on('close', () => {
			logger.info(`${LOG_CONTEXT} Bundle written: ${outputPath} (${archive.pointer()} bytes)`);
			resolve({ path: outputPath, sizeBytes: archive.pointer() });
		});
		archive.on('error', (err) => reject(err));

		archive.pipe(output);
		archive.append(JSON.stringify(meta, null, 2), { name: 'metadata.json' });
		archive.append(readme(meta), { name: 'README.md' });
		// Stream the trace from disk rather than buffering it.
		archive.file(tracePath, { name: 'trace.json' });

		archive.finalize();
	});
}
