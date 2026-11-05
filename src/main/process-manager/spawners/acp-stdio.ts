import type { ChildProcess } from 'child_process';
import { withWorktreeTurnActivity } from '../../git/worktreeTurnActivity';
import { captureException } from '../../../shared/maestro-lib/host';

export interface AcpByteStream {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
}

/**
 * Bridge startTurn's UTF-8 Node streams to ACP's byte-oriented web streams.
 * `startTurn` calls setEncoding('utf8'), so Readable.toWeb alone would feed
 * strings into ACP's Uint8Array line buffer and fail on the first frame.
 * Setup and retained writes share conservative global activity. Completion of
 * a write/end/destroy covers that stream operation, not the child, descendants,
 * retained read callbacks or another process hosting its own activity registry.
 */
export function acpStdioStream(child: ChildProcess): AcpByteStream {
	return withWorktreeTurnActivity(() => {
		const stdout = child.stdout;
		const stdin = child.stdin;
		if (!stdout || !stdin) throw new Error('ACP child requires piped stdin and stdout');
		const encoder = new TextEncoder();
		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				const onData = (chunk: unknown) => {
					try {
						controller.enqueue(
							typeof chunk === 'string' ? encoder.encode(chunk) : (chunk as Uint8Array)
						);
					} catch (error) {
						controller.error(error);
					}
				};
				const onEnd = () => controller.close();
				const onError = (error: Error) => controller.error(error);
				stdout.on('data', onData);
				stdout.once('end', onEnd);
				stdout.once('error', onError);
			},
			cancel() {
				stdout.destroy();
			},
		});
		const writable = new WritableStream<Uint8Array>({
			write(chunk) {
				return withWorktreeTurnActivity((_start, observe) => {
					const { promise, resolve, reject } = Promise.withResolvers<void>();
					// Observe before invoking native code. A throw does not prove that
					// the write was never queued; its callback still owns completion.
					observe(promise);
					stdin.write(chunk, (error) => (error ? reject(error) : resolve()));
					return promise;
				}, captureException);
			},
			close() {
				return withWorktreeTurnActivity((_start, observe) => {
					const { promise, resolve, reject } = Promise.withResolvers<void>();
					observe(promise);
					stdin.end((error?: Error | null) => (error ? reject(error) : resolve()));
					return promise;
				}, captureException);
			},
			abort() {
				return withWorktreeTurnActivity((_start, observe) => {
					const { promise, resolve } = Promise.withResolvers<void>();
					observe(promise);
					// destroy() returning is not proof that native teardown finished.
					if (stdin.closed) resolve();
					else stdin.once('close', resolve);
					stdin.destroy();
					return promise;
				}, captureException);
			},
		});
		return { readable, writable };
	}, captureException);
}
