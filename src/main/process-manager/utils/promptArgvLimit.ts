/**
 * Longest prompt (in UTF-8 bytes) left in argv on Linux and macOS. Linux caps
 * a SINGLE argument at 128 KiB (MAX_ARG_STRLEN) and macOS caps argv plus the
 * environment at 1 MiB; either overrun fails the spawn with `spawn E2BIG`
 * (MAESTRO-VR, MAESTRO-RM). Same value the rc line uses.
 */
export const POSIX_PROMPT_ARGV_MAX_BYTES = 100_000;

/**
 * Whether `prompt` is too long to ride the command line of a process started
 * on Linux or macOS. Such a spawn cannot succeed, so moving the prompt to
 * stdin is never a behavior change for a turn that would have worked.
 */
export function promptExceedsPosixArgvLimit(prompt: string): boolean {
	// Cheap checks first: a UTF-8 encoding is never shorter than the code-unit
	// count, and never more than three bytes per code unit.
	if (prompt.length > POSIX_PROMPT_ARGV_MAX_BYTES) return true;
	if (prompt.length * 3 <= POSIX_PROMPT_ARGV_MAX_BYTES) return false;
	return Buffer.byteLength(prompt, 'utf8') > POSIX_PROMPT_ARGV_MAX_BYTES;
}
