// Standard input for CLI verbs, in the two ways a verb reads it.
//
// A verb that was TOLD to read standard input (`--state -`, `--input -`, a key
// piped to `s1 key set`) reads it to the end, however long that takes.
//
// A verb that reads standard input only when nothing else names its input must
// not wait for a writer that is not there. An agent's harness often leaves
// standard input open as a pipe nobody writes to, and a blocking read of that
// pipe never returns: the verb hangs until the harness kills it.

import * as fs from 'fs';

/** How long piped input gets to start arriving before a verb goes on without it. */
export const STDIN_READY_TIMEOUT_MS = 1_500;

/** True when standard input is a terminal: nothing was piped in. */
export function isStdinTerminal(): boolean {
	return Boolean(process.stdin.isTTY);
}

/** Read standard input to its end. Blocks until the writer closes it. */
export function readStdinText(): string {
	return fs.readFileSync(0, 'utf-8');
}

/**
 * Read standard input if something is piped to it, or answer `null`: it is a
 * terminal, or nothing arrived inside `timeoutMs`. Once the first bytes arrive
 * the read goes on to the end, so a slow writer is never cut short.
 */
export function readStdinIfReady(
	timeoutMs: number = STDIN_READY_TIMEOUT_MS
): Promise<string | null> {
	const stdin = process.stdin;
	if (stdin.isTTY) return Promise.resolve(null);
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let started = false;
		const finish = (text: string | null) => {
			clearTimeout(timer);
			stdin.off('data', onData);
			stdin.off('end', onEnd);
			stdin.off('error', onError);
			// A paused, unreferenced pipe does not keep the process alive.
			stdin.pause();
			stdin.unref?.();
			resolve(text);
		};
		const onData = (chunk: Buffer | string) => {
			started = true;
			chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
		};
		const onEnd = () => finish(Buffer.concat(chunks).toString('utf-8'));
		const onError = () => finish(null);
		const timer = setTimeout(() => {
			if (!started) finish(null);
		}, timeoutMs);
		stdin.on('data', onData);
		stdin.on('end', onEnd);
		stdin.on('error', onError);
	});
}
