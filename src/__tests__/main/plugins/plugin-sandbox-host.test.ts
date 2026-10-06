/**
 * @file plugin-sandbox-host.test.ts
 * @description invokeCommand caps the host->child payload: a non-serializable or
 * oversized args object is dropped (returns false) and never posted to the child,
 * mirroring the HostRequest size cap. A normal payload still posts and returns
 * true, and an unknown plugin returns false. electron's utilityProcess is mocked
 * so no real child is forked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { forkMock, postMessage } = vi.hoisted(() => {
	const postMessage = vi.fn();
	const proc = { postMessage, on: vi.fn(), kill: vi.fn() };
	const forkMock = vi.fn(() => proc);
	return { forkMock, postMessage };
});

vi.mock('electron', () => ({
	utilityProcess: { fork: forkMock },
}));

import { PluginSandboxHost } from '../../../main/plugins/plugin-sandbox-host';
import type { PermissionBroker } from '../../../main/plugins/permission-broker';
import type { AgentSendProgressEvent } from '../../../shared/plugins/rpc-protocol';

describe('PluginSandboxHost.invokeCommand payload cap', () => {
	let dir: string;
	let host: PluginSandboxHost;

	beforeEach(() => {
		vi.clearAllMocks();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-sbx-'));
		fs.writeFileSync(path.join(dir, 'entry.js'), '// entry', 'utf-8');
		host = new PluginSandboxHost({ broker: {} as unknown as PermissionBroker, handlers: {} });
		host.start('p', dir, 'entry.js');
		// Drop the 'init' message posted by start().
		postMessage.mockClear();
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('returns false and does not post when args exceed the size cap', () => {
		const big = { blob: 'x'.repeat(1_000_001) };
		expect(host.invokeCommand('p', 'cmd', big)).toBe(false);
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('returns false on non-serializable args without posting', () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(host.invokeCommand('p', 'cmd', circular)).toBe(false);
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('posts and returns true for a normal payload', () => {
		expect(host.invokeCommand('p', 'cmd', { ok: true })).toBe(true);
		expect(postMessage).toHaveBeenCalledTimes(1);
		expect(postMessage).toHaveBeenCalledWith({
			kind: 'invokeCommand',
			commandId: 'cmd',
			args: { ok: true },
		});
	});

	it('returns false when the plugin is not running', () => {
		expect(host.invokeCommand('not-running', 'cmd', {})).toBe(false);
		expect(postMessage).not.toHaveBeenCalled();
	});
});

describe('PluginSandboxHost agents.send progress', () => {
	it('delivers progress under the original request id and stops after the response', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-sbx-progress-'));
		try {
			fs.writeFileSync(path.join(dir, 'entry.js'), '// entry', 'utf-8');
			let report: ((event: AgentSendProgressEvent) => void) | undefined;
			let finish: ((value: string) => void) | undefined;
			const authorize = vi.fn(() => ({ allowed: true, capability: 'agents:dispatch' }));
			const host = new PluginSandboxHost({
				broker: { authorize } as unknown as PermissionBroker,
				handlers: {
					'agents.send': async (_pluginId, _params, context) => {
						report = context?.onProgress;
						return new Promise<string>((resolve) => {
							finish = resolve;
						});
					},
				},
			});
			host.start('p', dir, 'entry.js');
			const proc = forkMock.mock.results.at(-1)?.value as { on: ReturnType<typeof vi.fn> };
			const listener = proc.on.mock.calls.findLast(([name]) => name === 'message')?.[1] as (
				data: unknown
			) => void;
			postMessage.mockClear();
			listener({ id: 41, method: 'agents.send', params: { agentId: 'a', prompt: 'hi' } });
			await vi.waitFor(() => expect(report).toBeTypeOf('function'));
			const event = { type: 'activity' as const, text: 'Working', at: '2026-10-02T00:00:00.000Z' };
			report?.(event);
			expect(postMessage).toHaveBeenCalledWith({ kind: 'progress', id: 41, event });
			const action: AgentSendProgressEvent = {
				type: 'tool',
				tool: 'Read',
				status: 'started',
				summary: 'Reading file notes.md',
				at: event.at,
			};
			report?.(action);
			expect(postMessage).toHaveBeenCalledWith({ kind: 'progress', id: 41, event: action });
			report?.({ ...action, summary: 'x'.repeat(121) });
			expect(postMessage).toHaveBeenLastCalledWith({
				kind: 'progress',
				id: 41,
				event: { ...action, summary: undefined },
			});
			finish?.('done');
			await vi.waitFor(() =>
				expect(postMessage).toHaveBeenCalledWith({ id: 41, ok: true, result: 'done' })
			);
			postMessage.mockClear();
			report?.(event);
			expect(postMessage).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('PluginSandboxHost.stop onStop hook', () => {
	let dir: string;

	beforeEach(() => {
		vi.clearAllMocks();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-sbx-'));
		fs.writeFileSync(path.join(dir, 'entry.js'), '// entry', 'utf-8');
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('notifies onStop BEFORE posting shutdown, and only for running plugins', () => {
		const order: string[] = [];
		const onStop = vi.fn(() => order.push('onStop'));
		postMessage.mockImplementation((msg: { kind?: string }) => {
			if (msg?.kind === 'shutdown') order.push('shutdown');
		});
		const host = new PluginSandboxHost({
			broker: {} as unknown as PermissionBroker,
			handlers: {},
			onStop,
		});
		host.start('p', dir, 'entry.js');

		host.stop('p');
		expect(onStop).toHaveBeenCalledWith('p');
		expect(order).toEqual(['onStop', 'shutdown']);

		// Not running: no notification.
		host.stop('ghost');
		expect(onStop).toHaveBeenCalledTimes(1);
	});

	it('rejects host calls as soon as shutdown begins', async () => {
		const handler = vi.fn(async () => 'unexpected');
		const host = new PluginSandboxHost({
			broker: { authorize: vi.fn(() => ({ allowed: true })) } as unknown as PermissionBroker,
			handlers: { 'agents.send': handler },
		});
		host.start('p', dir, 'entry.js');
		const proc = forkMock.mock.results.at(-1)?.value as { on: ReturnType<typeof vi.fn> };
		const listener = proc.on.mock.calls.findLast(([name]) => name === 'message')?.[1] as (
			data: unknown
		) => void;
		postMessage.mockClear();
		host.stop('p');
		listener({ id: 42, method: 'agents.send', params: { agentId: 'a', prompt: 'hi' } });
		await vi.waitFor(() =>
			expect(postMessage).toHaveBeenCalledWith({
				id: 42,
				ok: false,
				error: 'plugin is stopping',
			})
		);
		expect(handler).not.toHaveBeenCalled();
	});
});
