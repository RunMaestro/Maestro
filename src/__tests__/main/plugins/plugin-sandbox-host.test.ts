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

	it('accepts an args JSON value exactly at the UTF-8 byte limit', () => {
		const args = 'x'.repeat(999_998); // JSON string quotes consume the remaining two bytes.

		expect(host.invokeCommand('p', 'cmd', args)).toBe(true);
		expect(postMessage).toHaveBeenCalledTimes(1);
	});

	it('rejects multibyte and nested payloads that exceed the UTF-8 byte limit', () => {
		const multibyte = '💣'.repeat(250_000);

		expect(host.invokeCommand('p', 'cmd', multibyte)).toBe(false);
		expect(host.invokeCommand('p', 'cmd', { nested: { multibyte } })).toBe(false);
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('treats base64 as serialized JSON bytes, not decoded bytes', () => {
		const base64 = Buffer.alloc(750_000).toString('base64');

		expect(host.invokeCommand('p', 'cmd', base64)).toBe(false);
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('rejects oversized event payloads before forwarding', () => {
		expect(
			host.pushEvent('p', {
				topic: 'plugin.event',
				at: new Date(0).toISOString(),
				payload: { nested: '💣'.repeat(250_000) },
			})
		).toBe(false);
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('returns false when the plugin is not running', () => {
		expect(host.invokeCommand('not-running', 'cmd', {})).toBe(false);
		expect(postMessage).not.toHaveBeenCalled();
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
});
