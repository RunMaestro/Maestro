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
 * Setup and retained stream callbacks share conservative global activity.
 * Owned stdout listeners remain active through stream close and confirmed
 * detach. SDK continuations, descendants and other registries remain uncovered.
 */
export function acpStdioStream(child: ChildProcess): AcpByteStream {
	return withWorktreeTurnActivity((_start, observe) => {
		const stdout = child.stdout;
		const stdin = child.stdin;
		if (!stdout || !stdin) throw new Error('ACP child requires piped stdin and stdout');
		const encoder = new TextEncoder();
		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				const detached = Promise.withResolvers<void>();
				observe(detached.promise);
				let registering = true;
				let detaching = false;
				let closed = false;
				const onData = (chunk: unknown) =>
					withWorktreeTurnActivity(() => {
						try {
							controller.enqueue(
								typeof chunk === 'string' ? encoder.encode(chunk) : (chunk as Uint8Array)
							);
						} catch (error) {
							controller.error(error);
						}
					}, captureException);
				const onEnd = () => withWorktreeTurnActivity(() => controller.close(), captureException);
				const onError = (error: Error) =>
					withWorktreeTurnActivity(() => controller.error(error), captureException);
				const onClose = () =>
					withWorktreeTurnActivity(() => {
						closed = true;
						detach();
					}, captureException);
				const listeners = [
					{ event: 'close', callback: onClose },
					{ event: 'data', callback: onData },
					{ event: 'end', callback: onEnd },
					{ event: 'error', callback: onError },
				];
				const pendingDetach: typeof listeners = [];
				const detach = () => {
					// EventEmitter hooks may reenter before insertion/removal completes.
					if (registering || detaching) return;
					detaching = true;
					try {
						for (const listener of pendingDetach.toReversed()) {
							stdout.removeListener(listener.event, listener.callback);
							if (stdout.listeners(listener.event).includes(listener.callback))
								throw new Error('ACP stdout listener remains attached. Retry close.');
						}
						// A later removeListener hook can reattach an earlier callback.
						for (const listener of pendingDetach) {
							if (stdout.listeners(listener.event).includes(listener.callback))
								throw new Error('ACP stdout listener remains attached. Retry close.');
						}
						pendingDetach.length = 0;
						detached.resolve();
					} finally {
						detaching = false;
					}
				};
				try {
					try {
						for (const listener of listeners) {
							// A failed insertion may already own the callback. Keep close
							// installed until all other removals are confirmed for retry.
							pendingDetach.push(listener);
							if (listener.event === 'end' || listener.event === 'error')
								stdout.once(listener.event, listener.callback);
							else stdout.on(listener.event, listener.callback);
						}
					} finally {
						registering = false;
					}
					if (closed || stdout.closed) detach();
				} catch (error) {
					try {
						detach();
					} catch (detachError) {
						observe(Promise.reject(detachError));
					}
					throw error;
				}
			},
			cancel() {
				return withWorktreeTurnActivity((_start, observe) => {
					const { promise, resolve } = Promise.withResolvers<void>();
					observe(promise);
					// Child close and destroy returning cannot prove stdout teardown.
					if (stdout.closed) resolve();
					else stdout.once('close', resolve);
					stdout.destroy();
					return promise;
				}, captureException);
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
