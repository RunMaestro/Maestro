/**
 * The performance trace a Feedback report attaches: where
 * `debug:stopProfilingToFile` writes the bundle, the name it gives it, and the
 * check a caller-supplied trace path must pass before anything reads or deletes
 * the file.
 *
 * Feedback submit uploads the file to the user's public attachments repo and
 * then deletes it, and the path reaches it from the renderer and from the web
 * bridge (`feedback_submit`, `feedback:submit-conversation`). So the path is
 * untrusted: only a bundle with the name given here, in the folder written
 * here, passes.
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { foldPathCase } from '../utils/real-path-containment';

/** `maestro-profile-<YYYY-MM-DDTHH-MM-SS>.zip`, the only name the capture writes. */
const TRACE_BUNDLE_NAME = /^maestro-profile-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.zip$/;

/** The folder trace bundles for Feedback are written to. */
function traceBundleDir(): string {
	return app.getPath('temp');
}

/**
 * Where the bundle captured at `timestamp` (`YYYY-MM-DDTHH-MM-SS`) is written.
 * Throws for any other timestamp shape, so the writer can never give a file a
 * name that `checkFeedbackTraceBundle()` refuses.
 */
export function feedbackTraceBundlePath(timestamp: string): string {
	const name = `maestro-profile-${timestamp}.zip`;
	if (!TRACE_BUNDLE_NAME.test(name)) {
		throw new Error(`Not a trace capture timestamp: ${timestamp}`);
	}
	return path.join(traceBundleDir(), name);
}

export type FeedbackTraceBundleCheck =
	/** `realPath`: the file to read and delete, so what was checked is what is touched. */
	| { ok: true; realPath: string }
	/** `reason`: why the path was refused, as a short phrase for an error message. */
	| { ok: false; reason: string };

/**
 * Whether `candidate` is a trace bundle Maestro captured: after symlinks
 * resolve, a regular file directly in the bundle folder, with the name
 * `feedbackTraceBundlePath()` gives. A symlink counts by its target, so a link
 * in the folder that points out of it is refused. Throws only when the bundle
 * folder itself cannot be resolved.
 */
export async function checkFeedbackTraceBundle(
	candidate: unknown
): Promise<FeedbackTraceBundleCheck> {
	if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
		return { ok: false, reason: 'not an absolute path' };
	}
	const realDir = await fs.promises.realpath(traceBundleDir());
	let realPath: string;
	let stats: fs.Stats;
	try {
		realPath = await fs.promises.realpath(candidate);
		stats = await fs.promises.stat(realPath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
		return { ok: false, reason: `no readable file there (${code})` };
	}
	if (foldPathCase(path.dirname(realPath)) !== foldPathCase(realDir)) {
		return { ok: false, reason: 'not in the folder Maestro writes traces to' };
	}
	if (!TRACE_BUNDLE_NAME.test(path.basename(realPath))) {
		return { ok: false, reason: 'not named like a trace Maestro captured' };
	}
	if (!stats.isFile()) {
		return { ok: false, reason: 'not a regular file' };
	}
	return { ok: true, realPath };
}
