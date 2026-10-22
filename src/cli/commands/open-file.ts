// Open file command - open a file as a preview tab in the Maestro desktop app.
//
// Focuses by default, as it always has. Two different opt-outs, deliberately
// NOT merged - folding one into the other would silently change behaviour for
// anyone already passing `--no-switch`:
//
//   --no-switch   stay on the current agent, but still activate the tab in the
//                 target agent. If you are already on that agent your view
//                 still changes, which is why the name over-promises.
//   --background  change nothing that is currently rendered, on any agent.
//                 Strictly stronger, so it wins when both are passed.
//
// `--queue` is for audio/video only: it adds the file to the floating media
// player's queue WITHOUT starting playback, and shows the player. With nothing
// loaded, the file loads paused so the user presses play themselves; with
// something already loaded, it lines up behind it and nothing is interrupted.
// It never switches agents - the player is app-wide, so there is nowhere to go.
//
// An http(s) URL instead of a path streams it in the media player: progressive
// MP4 (H.264/AAC) and plain audio files over HTTP. It never becomes a tab and
// never switches agents. The agent it is filed under is `--agent`, else the
// agent owning the shell's cwd.

import * as fs from 'fs';
import * as path from 'path';
import { withMaestroClient } from '../services/maestro-client';
import { getSessionById } from '../services/storage';
import { resolveBackgroundFlag } from '../../shared/focusPlacement';
import {
	getRemoteMediaName,
	isMediaFile,
	isRemoteMediaUrl,
	type MediaOpenMode,
} from '../../shared/mediaTypes';
import { resolveOwningAgent } from '../utils/owning-agent';
import { ExitCode, exitWith, exitCodeForError } from '../exit-codes';
import { exitIfMaestroNotRunning } from '../services/session-command';

interface OpenFileOptions {
	agent?: string;
	/** commander sets this false for `--no-switch`. Distinct from `background`. */
	switch?: boolean;
	background?: boolean;
	focus?: boolean;
	/** Add audio/video to the player's queue without starting playback. */
	queue?: boolean;
	json?: boolean;
}

interface ResolvedTarget {
	sessionId: string;
	absolutePath: string;
}

export async function openFile(filePath: string, options: OpenFileOptions): Promise<void> {
	const remote = isRemoteMediaUrl(filePath);
	const target = remote ? resolveUrlTarget(filePath, options) : resolveTarget(filePath, options);

	if (!remote && !fs.existsSync(target.absolutePath)) {
		console.error(`Error: File not found: ${target.absolutePath}`);
		exitWith(ExitCode.GeneralError);
	}

	if (options.queue && !remote && !isMediaFile(target.absolutePath)) {
		const error = `--queue only applies to audio and video files: ${target.absolutePath}`;
		if (options.json) console.log(JSON.stringify({ success: false, error }));
		else console.error(`Error: ${error}`);
		exitWith(ExitCode.GeneralError);
	}
	const mediaMode: MediaOpenMode = options.queue ? 'queue' : 'play';
	const displayName = remote
		? getRemoteMediaName(target.absolutePath)
		: path.basename(target.absolutePath);

	const background = resolveBackgroundFlag(options, 'open-file');
	// `--background` is strictly stronger, so it implies the weaker ask too and
	// there is no combination that has to be rejected.
	const switchToAgent = options.switch !== false;

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{ type: string; success: boolean; error?: string }>(
				{
					type: 'open_file_tab',
					sessionId: target.sessionId,
					filePath: target.absolutePath,
					background,
					switchToAgent,
					mediaMode,
				},
				'open_file_tab_result'
			);
		});

		if (result.success) {
			if (options.json)
				console.log(
					JSON.stringify({
						success: true,
						sessionId: target.sessionId,
						path: target.absolutePath,
						background,
						switchToAgent,
						mediaMode,
					})
				);
			else if (mediaMode === 'queue')
				console.log(`Queued ${displayName} in the media player (not playing)`);
			else if (remote) console.log(`Streaming ${displayName} in the media player`);
			else console.log(`Opened ${displayName} in Maestro${background ? ' (background tab)' : ''}`);
		} else {
			const error = result.error || 'Failed to open file';
			if (options.json) console.log(JSON.stringify({ success: false, error }));
			else console.error(`Error: ${error}`);
			exitWith(ExitCode.GeneralError);
		}
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: options.json });
		const msg = error instanceof Error ? error.message : String(error);
		if (options.json) console.log(JSON.stringify({ success: false, error: msg }));
		else console.error(`Error: ${msg}`);
		exitWith(exitCodeForError(error));
	}
}

/**
 * Validate a remote media URL and pick the agent to file it under.
 *
 * A URL lives in no agent's working directory, so ownership falls back to the
 * shell's cwd: an agent calling this from its own workspace files the stream
 * under itself without having to pass `--agent`.
 */
function resolveUrlTarget(url: string, options: OpenFileOptions): ResolvedTarget {
	try {
		new URL(url);
	} catch {
		console.error(`Error: Not a valid URL: ${url}`);
		exitWith(ExitCode.GeneralError);
	}

	if (options.agent) {
		const session = getSessionById(options.agent);
		if (!session) {
			console.error(`Error: Agent not found: ${options.agent}`);
			exitWith(ExitCode.GeneralError);
		}
		return { sessionId: session.id, absolutePath: url };
	}

	const owned = resolveOwningAgent(process.cwd());
	if (!owned) {
		console.error(
			`Error: the current directory is not inside any agent's working directory. Pick an agent with --agent <id>.`
		);
		exitWith(ExitCode.GeneralError);
	}
	return { sessionId: owned.agent.id, absolutePath: url };
}

/**
 * Resolve the file path and the target agent.
 *
 * - Relative paths are resolved against the shell's CWD (process.cwd()).
 * - With `--agent`, the file opens in that agent regardless of where it lives -
 *   the explicit flag means the user is asserting which agent they want.
 * - Without `--agent`, we auto-detect the owning agent by longest cwd-prefix
 *   match. On tie, we pick the most-recently-active candidate by history-file
 *   mtime. With zero owners, we error and tell the user to pass `--agent`.
 */
function resolveTarget(filePath: string, options: OpenFileOptions): ResolvedTarget {
	const absolutePath = path.isAbsolute(filePath)
		? path.resolve(filePath)
		: path.resolve(process.cwd(), filePath);

	if (options.agent) {
		const session = getSessionById(options.agent);
		if (!session) {
			console.error(`Error: Agent not found: ${options.agent}`);
			exitWith(ExitCode.GeneralError);
		}
		return { sessionId: session.id, absolutePath };
	}

	const owned = resolveOwningAgent(absolutePath);

	if (!owned) {
		console.error(
			`Error: ${absolutePath} is not inside any agent's working directory. Pick an agent with --agent <id>.`
		);
		exitWith(ExitCode.GeneralError);
	}

	if (owned.others.length > 0) {
		const others = owned.others.map((s) => s.name);
		console.error(
			`Note: ${owned.others.length + 1} agents own this path; opened in ${owned.agent.name}. Other candidates: ${others.join(', ')}. Use --agent to override.`
		);
	}
	return { sessionId: owned.agent.id, absolutePath };
}
