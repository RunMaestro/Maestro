/**
 * Write-side helpers for Maestro Cue configuration files (sibling to the
 * read-side `cue-yaml-loader`). These are shared by every surface that rewrites
 * `cue.yaml` - the engine's self-destruct path (`cue-self-destruct.ts`) and the
 * CLI scheduler (`cli/commands/cue-schedule.ts`) - so the comment-preservation
 * and atomic-write logic lives in exactly one place.
 */

import * as fs from 'fs';

/**
 * Extract the leading comment block from a raw YAML file - every line at the
 * top of the file that is either blank or starts with `#`. Returns the block
 * including its trailing newline, or an empty string if none.
 *
 * Most `cue.yaml` files carry a `# Pipeline: …` header that lives only in YAML
 * comments; preserving it keeps pipeline metadata intact across a rewrite.
 */
export function extractLeadingCommentBlock(raw: string): string {
	const lines = raw.split('\n');
	const headerLines: string[] = [];
	for (const line of lines) {
		const trimmed = line.trimStart();
		if (trimmed.length === 0 || trimmed.startsWith('#')) {
			headerLines.push(line);
			continue;
		}
		break;
	}
	if (headerLines.length === 0) return '';
	return headerLines.join('\n') + '\n';
}

/**
 * Write `content` to `filePath` atomically (synchronous): write to a sibling
 * `.tmp` file, then rename over the target. A crash mid-write leaves the
 * original file intact rather than a truncated, unparseable `cue.yaml`. On
 * failure the temp file is cleaned up on a best-effort basis and the error is
 * rethrown so the caller can surface it.
 */
export function writeCueYamlAtomicSync(filePath: string, content: string): void {
	const tmpPath = filePath + '.tmp';
	try {
		fs.writeFileSync(tmpPath, content, 'utf-8');
		fs.renameSync(tmpPath, filePath);
	} catch (err) {
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			// ignore - original file is still intact
		}
		throw err;
	}
}
