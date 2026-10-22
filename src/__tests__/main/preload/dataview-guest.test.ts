// @vitest-environment jsdom

/**
 * @file dataview-guest.test.ts
 * @description The bridge-only preload of DataviewJS guests (src/main/preload/dataview-guest.ts, D4). It
 * forwards to-host envelopes from the page's own window to the host and nothing else, lets `open.link` and
 * `toggle.task` through only for a real click (one each, while its activation lasts), relays host messages
 * into the page, applies the theme in the isolated world, and exposes nothing on `window`.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import {
	SANDBOX_TO_GUEST_CHANNEL,
	SANDBOX_TO_HOST_CHANNEL,
	sandboxEnvelope,
} from '../../../shared/dataview/sandboxProtocol';
import { PANEL_THEME_CHANNEL } from '../../../shared/plugins/panel-theme';

const { sendToHost, ipcOn, exposeInMainWorld } = vi.hoisted(() => ({
	sendToHost: vi.fn(),
	ipcOn: vi.fn(),
	exposeInMainWorld: vi.fn(),
}));
vi.mock('electron', () => ({
	ipcRenderer: { sendToHost, on: ipcOn },
	contextBridge: { exposeInMainWorld },
}));

/** The preload's capture-phase click listener, called directly: jsdom cannot make a trusted event. */
let clickListener: (event: { isTrusted: boolean }) => void;
const activation = { isActive: false };

beforeAll(async () => {
	Object.defineProperty(navigator, 'userActivation', { value: activation, configurable: true });
	const addEventListener = window.addEventListener.bind(window);
	const spy = vi
		.spyOn(window, 'addEventListener')
		.mockImplementation((type: string, listener: unknown, options?: unknown) => {
			if (type === 'click') clickListener = listener as typeof clickListener;
			return addEventListener(
				type,
				listener as EventListener,
				options as AddEventListenerOptions | boolean | undefined
			);
		});
	await import('../../../main/preload/dataview-guest');
	spy.mockRestore();
});

function post(data: unknown, source: unknown = window): void {
	const event = new MessageEvent('message', { data });
	Object.defineProperty(event, 'source', { value: source });
	window.dispatchEvent(event);
}

const toHost = (message: unknown) => sandboxEnvelope(SANDBOX_TO_HOST_CHANNEL, message);
const openLink = { type: 'open.link', kind: 'url', url: 'https://example.com/', newTab: false };
const toggleTask = { type: 'toggle.task', path: 'Notes/A.md', line: 3, text: 'task' };
const renderDone = { type: 'render.done', blockId: 'b', runId: 'r', height: 10 };

beforeEach(() => {
	// Spend any click a previous test left, then start clean.
	activation.isActive = false;
	post(toHost(openLink));
	sendToHost.mockClear();
});

describe('dataview-guest preload: guest to host', () => {
	it('forwards the message of a to-host envelope from the page itself', () => {
		post(toHost(renderDone));
		expect(sendToHost).toHaveBeenCalledTimes(1);
		expect(sendToHost).toHaveBeenCalledWith(SANDBOX_TO_HOST_CHANNEL, renderDone);
	});

	it('ignores another source, another channel, a bare message, and a message that is not an object', () => {
		post(toHost(renderDone), null);
		post(toHost(renderDone), {});
		post(sandboxEnvelope(SANDBOX_TO_GUEST_CHANNEL, renderDone));
		post(renderDone);
		post({ channel: 'maestro:invokeCommand', message: renderDone });
		post(toHost('render.done'));
		post(toHost(null));
		post(null);
		expect(sendToHost).not.toHaveBeenCalled();
	});

	it('drops open.link and toggle.task that no click is behind', () => {
		activation.isActive = true;
		post(toHost(openLink));
		post(toHost(toggleTask));
		expect(sendToHost).not.toHaveBeenCalled();
	});

	it('drops them after a click a script made (not trusted)', () => {
		activation.isActive = true;
		clickListener({ isTrusted: false });
		post(toHost(openLink));
		expect(sendToHost).not.toHaveBeenCalled();
	});

	it('lets exactly one through per real click, while its activation lasts', () => {
		activation.isActive = true;
		clickListener({ isTrusted: true });
		post(toHost(renderDone));
		post(toHost(toggleTask));
		post(toHost(openLink));
		expect(sendToHost.mock.calls).toEqual([
			[SANDBOX_TO_HOST_CHANNEL, renderDone],
			[SANDBOX_TO_HOST_CHANNEL, toggleTask],
		]);

		clickListener({ isTrusted: true });
		post(toHost(openLink));
		expect(sendToHost).toHaveBeenLastCalledWith(SANDBOX_TO_HOST_CHANNEL, openLink);
	});

	it('drops them once the activation of the click has expired', () => {
		clickListener({ isTrusted: true });
		activation.isActive = false;
		post(toHost(openLink));
		expect(sendToHost).not.toHaveBeenCalled();
	});
});

describe('dataview-guest preload: host to guest', () => {
	it('relays host messages into the page as to-guest envelopes, and never back to the host', async () => {
		const relay = ipcOn.mock.calls.find((call) => call[0] === SANDBOX_TO_GUEST_CHANNEL)?.[1] as (
			event: unknown,
			message: unknown
		) => void;
		expect(relay).toBeDefined();
		const posted: unknown[] = [];
		const onMessage = (event: MessageEvent) => posted.push(event.data);
		window.addEventListener('message', onMessage);
		try {
			relay({}, { type: 'request.failed', requestId: 'q-1', message: 'no' });
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			window.removeEventListener('message', onMessage);
		}
		expect(posted).toContainEqual(
			sandboxEnvelope(SANDBOX_TO_GUEST_CHANNEL, {
				type: 'request.failed',
				requestId: 'q-1',
				message: 'no',
			})
		);
		expect(sendToHost).not.toHaveBeenCalled();
	});

	it('applies the theme to the root style', () => {
		const apply = ipcOn.mock.calls.find((call) => call[0] === PANEL_THEME_CHANNEL)?.[1] as (
			event: unknown,
			payload: unknown
		) => void;
		apply({}, { colorScheme: 'dark', colors: { '--maestro-accent': '#123456' } });
		expect(document.documentElement.style.getPropertyValue('--maestro-accent')).toBe('#123456');
		expect(document.documentElement.style.getPropertyValue('color-scheme')).toBe('dark');
	});

	it('listens on exactly the guest and theme channels, and exposes nothing to the page', () => {
		expect(ipcOn.mock.calls.map((call) => call[0]).sort()).toEqual(
			[PANEL_THEME_CHANNEL, SANDBOX_TO_GUEST_CHANNEL].sort()
		);
		expect(exposeInMainWorld).not.toHaveBeenCalled();
	});
});
