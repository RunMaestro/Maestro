import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import net from 'net';
import { promisify } from 'util';
import type { SshRemoteConfig } from '../../../shared/types';

const mocks = vi.hoisted(() => ({
	children: [] as Array<EventEmitter & { crash(): void }>,
}));

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	const output = (values: string[]) => {
		const forward = values[values.indexOf('-L') + 1];
		const match = /^127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)$/.exec(forward)!;
		return `localforward [127.0.0.1]:${match[1]} [127.0.0.1]:${match[2]}\n`;
	};
	const execFile = (...args: unknown[]) => {
		const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
		queueMicrotask(() => callback(null, output(args[1] as string[]), ''));
		return new EventEmitter();
	};
	Object.assign(execFile, {
		[promisify.custom]: async (_file: string, values: string[]) => ({
			stdout: output(values),
			stderr: '',
		}),
	});
	return {
		...actual,
		execFile,
		spawn: (_file: string, args: string[]) => {
			const forward = args[args.indexOf('-L') + 1];
			const port = Number(/^127\.0\.0\.1:(\d+):/.exec(forward)![1]);
			const child = new EventEmitter() as EventEmitter & {
				stderr: PassThrough;
				kill(): boolean;
				crash(): void;
			};
			child.stderr = new PassThrough();
			const listener = net.createServer();
			let finished = false;
			const finish = () => {
				if (finished) return;
				finished = true;
				listener.close(() => {
					child.emit('exit', 1);
					child.emit('close');
				});
			};
			child.kill = () => {
				finish();
				return true;
			};
			child.crash = finish;
			listener.listen(port, '127.0.0.1');
			mocks.children.push(child);
			return child;
		},
	};
});

import { openTunnel } from '../../../main/lite/tunnel';

const config: SshRemoteConfig = {
	id: 'host-a',
	name: 'Host A',
	host: 'test-alias',
	port: 22,
	username: '',
	privateKeyPath: '',
	useSshConfig: true,
	enabled: true,
};
const endpoint = new URL('http://127.0.0.1:8080/token');
const controllers: AbortController[] = [];
afterEach(() => {
	for (const controller of controllers.splice(0)) controller.abort();
	for (const child of mocks.children.splice(0)) child.crash();
});

describe('Lite SSH tunnel recovery contract', () => {
	it('reports an established forwarding exit as retryable', async () => {
		const controller = new AbortController();
		controllers.push(controller);
		const onExit = vi.fn();
		const opened = await openTunnel(config, endpoint, controller.signal, onExit);
		mocks.children[0].crash();
		await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce());
		expect(onExit.mock.calls[0][0]).toMatchObject({ retryable: true });
		await opened.tunnel.stop();
	});

	it('refuses to move an established view to a fallback port', async () => {
		const controller = new AbortController();
		controllers.push(controller);
		const blocker = net.createServer();
		await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
		const port = (blocker.address() as net.AddressInfo).port;
		try {
			await expect(
				openTunnel(config, endpoint, controller.signal, vi.fn(), port, false)
			).rejects.toThrow(/EADDRINUSE/);
			expect(mocks.children).toHaveLength(0);
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});
});
