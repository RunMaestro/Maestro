import { isWindowsPlatform } from './platformUtils';

/**
 * Compute stdin transport flags for spawning agents on Windows.
 *
 * On Windows the cmd.exe command line is limited to ~8 KB and special
 * characters cause escaping issues.  Sending the prompt via stdin
 * side-steps both problems.
 *
 * SSH sessions must NOT use these flags - they have a dedicated
 * stdin-script path handled by ChildProcessSpawner.
 *
 * Stream-json stdin is only used when images are present AND the agent
 * supports it. Text-only messages use raw stdin for efficiency (avoids
 * wrapping in API format JSON).
 */
export function getStdinFlags(opts: {
	isSshSession: boolean;
	supportsStreamJsonInput: boolean;
	hasImages?: boolean;
}): {
	sendPromptViaStdin: boolean;
	sendPromptViaStdinRaw: boolean;
} {
	const isWindows = isWindowsPlatform();
	const useStdin = isWindows && !opts.isSshSession;

	return {
		// Only use stream-json stdin when there are images AND agent supports it
		sendPromptViaStdin: useStdin && opts.supportsStreamJsonInput && !!opts.hasImages,
		// Use raw stdin for text-only messages (or for agents that don't support stream-json)
		sendPromptViaStdinRaw: useStdin && (!opts.supportsStreamJsonInput || !opts.hasImages),
	};
}
