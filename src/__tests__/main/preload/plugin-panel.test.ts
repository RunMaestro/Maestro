// @vitest-environment jsdom

/**
 * @file plugin-panel.test.ts
 * @description The broker-only panel guest preload forwards EXACTLY the
 * legacy postMessage bridge shape ({ type: 'maestro:invokeCommand',
 * commandId, args }) to the embedder via ipcRenderer.sendToHost, and ignores
 * everything else: wrong source (not the panel's own window), wrong type,
 * non-string commandId, and non-object data. Panel data is the only inbound
 * channel relayed to the page; the theme channel writes approved root styles.
 * Nothing is exposed on window.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PANEL_THEME_CHANNEL, PANEL_THEME_COLOR_TOKENS } from '../../../shared/plugins/panel-theme';

const { sendToHost, ipcOn } = vi.hoisted(() => ({ sendToHost: vi.fn(), ipcOn: vi.fn() }));
vi.mock('electron', () => ({
	ipcRenderer: { sendToHost, on: ipcOn },
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

	it('relays only the maestro:panelData channel into the page as a window message', async () => {
		// Importing the module registered exactly one inbound ipcRenderer.on for the
		// panel-data channel; nothing else is relayed and no reply channel exists.
		const dataCalls = ipcOn.mock.calls.filter((c) => c[0] === 'maestro:panelData');
		expect(dataCalls).toHaveLength(1);
		const handler = dataCalls[0][1] as (event: unknown, data: unknown) => void;

		const posted: unknown[] = [];
		const onMessage = (e: MessageEvent) => posted.push(e.data);
		window.addEventListener('message', onMessage);
		try {
			handler({}, { nodes: [1, 2, 3] });
			// jsdom dispatches window.postMessage asynchronously; wait a macrotask.
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			window.removeEventListener('message', onMessage);
		}

		expect(posted).toContainEqual({ type: 'maestro:panelData', data: { nodes: [1, 2, 3] } });
		// The inbound relay must never turn into an outbound call.
		expect(sendToHost).not.toHaveBeenCalled();
	});

	it('applies only validated theme tokens and clears invalid values on a later update', () => {
		const themeCalls = ipcOn.mock.calls.filter((c) => c[0] === PANEL_THEME_CHANNEL);
		expect(themeCalls).toHaveLength(1);
		const handler = themeCalls[0][1] as (event: unknown, data: unknown) => void;
		const style = document.documentElement.style;
		const keys = Object.keys(PANEL_THEME_COLOR_TOKENS);
		handler(
			{},
			{
				colorScheme: 'dark',
				colors: Object.fromEntries(keys.map((key) => [key, '#123456'])),
			}
		);
		for (const key of keys) expect(style.getPropertyValue(key)).toBe('#123456');
		expect(style.getPropertyValue('background-color')).toBe('rgb(18, 52, 86)');
		expect(style.getPropertyValue('color-scheme')).toBe('dark');

		handler(
			{},
			{
				colorScheme: 'light',
				colors: {
					'--maestro-bg-main': '#fafafa',
					'--maestro-accent': 'red; background: black',
					'--maestro-evil': 'red',
				},
			}
		);
		expect(style.getPropertyValue('--maestro-bg-main')).toBe('#fafafa');
		expect(style.getPropertyValue('background-color')).toBe('rgb(250, 250, 250)');
		expect(style.getPropertyValue('--maestro-accent')).toBe('');
		expect(style.getPropertyValue('--maestro-border')).toBe('');
		expect(style.getPropertyValue('--maestro-evil')).toBe('');
		expect(style.getPropertyValue('color-scheme')).toBe('light');
		expect(sendToHost).not.toHaveBeenCalled();

		handler({}, { colorScheme: 'javascript:evil', colors: { '--maestro-bg-main': 'red' } });
		expect(style.getPropertyValue('--maestro-bg-main')).toBe('#fafafa');
	});
});
