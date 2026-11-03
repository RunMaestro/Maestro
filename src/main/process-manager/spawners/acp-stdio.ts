import type { ChildProcess } from 'child_process';

export interface AcpByteStream {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
}

/**
 * Bridge startTurn's UTF-8 Node streams to ACP's byte-oriented web streams.
 * `startTurn` calls setEncoding('utf8'), so Readable.toWeb alone would feed
 * strings into ACP's Uint8Array line buffer and fail on the first frame.
 */
export function acpStdioStream(child: ChildProcess): AcpByteStream {
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
		async write(chunk) {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			stdin.write(chunk, (error) => (error ? reject(error) : resolve()));
			await promise;
		},
		close() {
			stdin.end();
		},
		abort() {
			stdin.destroy();
		},
	});
	return { readable, writable };
}
