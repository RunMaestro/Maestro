/**
 * Compute stdin transport flags for spawning agents on Windows.
 *
 * On Windows the cmd.exe command line is limited to ~8 KB and special
 * characters cause escaping issues.  Sending the prompt via stdin
 * side-steps both problems.
 *
 * SSH sessions must NOT use these flags — they have a dedicated
 * stdin-script path handled by ChildProcessSpawner.
 */
export function getStdinFlags(opts: { isSshSession: boolean; supportsStreamJsonInput: boolean }): {
	sendPromptViaStdin: boolean;
	sendPromptViaStdinRaw: boolean;
} {
	const isWindows = navigator.platform.toLowerCase().includes('win');
	const useStdin = isWindows && !opts.isSshSession;

	return {
		sendPromptViaStdin: useStdin && opts.supportsStreamJsonInput,
		sendPromptViaStdinRaw: useStdin && !opts.supportsStreamJsonInput,
	};
}
