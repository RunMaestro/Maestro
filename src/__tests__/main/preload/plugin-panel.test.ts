// @vitest-environment jsdom

/**
 * @file plugin-panel.test.ts
 * @description The broker-only panel guest preload forwards EXACTLY the
 * legacy postMessage bridge shape ({ type: 'maestro:invokeCommand',
 * commandId, args }) to the embedder via ipcRenderer.sendToHost, and ignores
 * everything else: wrong source (not the panel's own window), wrong type,
 * non-string commandId, and non-object data. Nothing is exposed on window.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendToHost } = vi.hoisted(() => ({ sendToHost: vi.fn() }));
vi.mock('electron', () => ({
	ipcRenderer: { sendToHost },
	contextBridge: { exposeInMainWorld: vi.fn() },
}));

// Importing the module registers the window message listener (jsdom window).
import '../../../main/preload/plugin-panel';

function dispatchMessage(data: unknown, source: unknown = window): void {
	const event = new MessageEvent('message', { data });
	Object.defineProperty(event, 'source', { value: source });
	window.dispatchEvent(event);
}

beforeEach(() => sendToHost.mockClear());

describe('plugin-panel preload bridge', () => {
	it('forwards the bridge shape from the panel document to the embedder', () => {
		dispatchMessage({ type: 'maestro:invokeCommand', commandId: 'open', args: { n: 1 } });
		expect(sendToHost).toHaveBeenCalledTimes(1);
		expect(sendToHost).toHaveBeenCalledWith('maestro:invokeCommand', {
			commandId: 'open',
			args: { n: 1 },
		});
	});

	it('forwards a commandId without args (args undefined)', () => {
		dispatchMessage({ type: 'maestro:invokeCommand', commandId: 'ping' });
		expect(sendToHost).toHaveBeenCalledWith('maestro:invokeCommand', {
			commandId: 'ping',
			args: undefined,
		});
	});

	it('ignores messages whose source is not the panel window itself', () => {
		dispatchMessage({ type: 'maestro:invokeCommand', commandId: 'open' }, null);
		dispatchMessage({ type: 'maestro:invokeCommand', commandId: 'open' }, {});
		expect(sendToHost).not.toHaveBeenCalled();
	});

	it('ignores wrong type, missing/non-string commandId, and non-object data', () => {
		dispatchMessage({ type: 'other', commandId: 'open' });
		dispatchMessage({ type: 'maestro:invokeCommand' });
		dispatchMessage({ type: 'maestro:invokeCommand', commandId: 42 });
		dispatchMessage('maestro:invokeCommand');
		dispatchMessage(null);
		expect(sendToHost).not.toHaveBeenCalled();
	});
});
