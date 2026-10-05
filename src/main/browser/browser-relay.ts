import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain } from 'electron';
import type { WebContents } from 'electron';
import type {
	BrowserRelayTarget,
	BrowserRelayViewport,
	BrowserRelayInput,
	BrowserRelayAction,
	BrowserRelayRequest,
	BrowserRelayHostResult,
} from '../../shared/browserRelay';
import { HostBrowserPages } from './browser-pages';
import type { BrowserTabCreationOptions, BrowserTabCreateRequest } from '../../shared/browserPage';
import { isAllowedBrowserTabUrl } from '../app-lifecycle/guest-webview-security';

const FRAME_INTERVAL_MS = 125;
const LEASE_IDLE_MS = 15_000;

type RelayEvent = { type?: string; clientId?: string; sender?: WebContents };
interface Lease extends BrowserRelayTarget {
	clientId: string;
	lastUsed: number;
	busy: boolean;
	lastFrame: number;
	viewport: BrowserRelayViewport;
}

/** One controller per canonical tab. A lease owns only capture/input, never the host page. */
export class BrowserRelay {
	private leases = new Map<string, Lease>();
	constructor(
		private request: (
			request: Omit<BrowserRelayRequest, 'requestId'>
		) => Promise<BrowserRelayHostResult>,
		private now = Date.now
	) {}

	private get(clientId: string, id: string): Lease {
		const lease = this.leases.get(id);
		if (!lease || lease.clientId !== clientId || this.now() - lease.lastUsed > LEASE_IDLE_MS) {
			throw new Error('Browser relay lease expired or belongs to another client');
		}
		lease.lastUsed = this.now();
		return lease;
	}

	async open(
		clientId: string,
		target: BrowserRelayTarget,
		viewport: BrowserRelayViewport
	): Promise<string> {
		this.expire();
		if (
			!target ||
			typeof target.sessionId !== 'string' ||
			!target.sessionId ||
			typeof target.tabId !== 'string' ||
			!target.tabId
		)
			throw new Error('Invalid browser tab target');
		validateViewport(viewport);
		if (this.leases.size >= 10) throw new Error('Too many remote browser views');
		for (const lease of this.leases.values()) {
			if (lease.sessionId === target.sessionId && lease.tabId === target.tabId)
				throw new Error('This browser tab is already controlled by another remote view');
		}
		const id = randomUUID();
		const lease: Lease = {
			...target,
			viewport,
			clientId,
			lastUsed: this.now(),
			busy: true,
			lastFrame: -Infinity,
		};
		this.leases.set(id, lease);
		try {
			const result = await this.request({ ...target, kind: 'resolve', viewport });
			if (!result.ok) throw new Error(result.error || 'Browser tab is unavailable');
			if (!this.leases.has(id)) throw new Error('Browser client disconnected while opening view');
			return id;
		} catch (error) {
			this.close(clientId, id);
			throw error;
		} finally {
			lease.busy = false;
		}
	}

	async run(
		clientId: string,
		id: string,
		kind: 'frame' | 'resolve' | 'action',
		viewport?: BrowserRelayViewport,
		action?: BrowserRelayAction
	): Promise<BrowserRelayHostResult> {
		const lease = this.get(clientId, id);
		if (lease.busy) throw new Error('Browser relay request already in flight');
		if (viewport) {
			validateViewport(viewport);
			lease.viewport = viewport;
		}
		lease.busy = true;
		try {
			if (kind === 'frame') {
				const delay = FRAME_INTERVAL_MS - (this.now() - lease.lastFrame);
				if (delay > 0) {
					const { promise, resolve } = Promise.withResolvers<void>();
					setTimeout(resolve, delay);
					await promise;
				}
				this.get(clientId, id);
				lease.lastFrame = this.now();
			}
			const result = await this.request({
				sessionId: lease.sessionId,
				tabId: lease.tabId,
				kind,
				viewport: lease.viewport,
				action,
			});
			this.get(clientId, id);
			if (!result.ok) throw new Error(result.error || 'Browser tab is unavailable');
			return result;
		} finally {
			lease.busy = false;
		}
	}

	assertActive(clientId: string, id: string): void {
		this.get(clientId, id);
	}

	close(clientId: string, id: string): void {
		const lease = this.leases.get(id);
		if (!lease || lease.clientId !== clientId) return;
		this.leases.delete(id);
		void this.request({ sessionId: lease.sessionId, tabId: lease.tabId, kind: 'release' }).catch(
			() => {}
		);
	}
	closeClient(clientId: string): void {
		for (const [id, lease] of this.leases)
			if (lease.clientId === clientId) this.close(clientId, id);
	}
	expire(): void {
		for (const [id, lease] of this.leases)
			if (this.now() - lease.lastUsed > LEASE_IDLE_MS) this.close(lease.clientId, id);
	}
}

function validateViewport(viewport: BrowserRelayViewport): void {
	if (
		!viewport ||
		!Number.isInteger(viewport.width) ||
		!Number.isInteger(viewport.height) ||
		viewport.width < 1 ||
		viewport.height < 1 ||
		viewport.width > 2560 ||
		viewport.height > 1600
	)
		throw new Error('Invalid browser viewport (maximum 2560 × 1600)');
}

let relay: BrowserRelay | null = null;
let readyOwnerId: number | null = null;
let getOwner: (() => BrowserWindow | null) | null = null;
export function isBrowserRelayReady(): boolean {
	const win = getOwner?.();
	return (
		!!relay &&
		!!win &&
		!win.isDestroyed() &&
		!win.webContents.isDestroyed() &&
		win.webContents.id === readyOwnerId
	);
}
export function closeBrowserRelayClient(clientId: string): void {
	relay?.closeClient(clientId);
}

export function registerBrowserRelayHandlers(deps: {
	getMainWindow: () => BrowserWindow | null;
	getWindowForSession?: (sessionId: string) => BrowserWindow | null;
}): void {
	getOwner = deps.getMainWindow;
	const pending = new Map<
		string,
		{
			ownerId: number;
			resolve: (result: BrowserRelayHostResult) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	const getWindow = (sessionId: string) =>
		deps.getWindowForSession?.(sessionId) ?? deps.getMainWindow();
	const hostRequest = async (
		channel: 'browser:relayRequest' | 'browser:createTabRequest',
		payload: Omit<BrowserRelayRequest, 'requestId'> | Omit<BrowserTabCreateRequest, 'requestId'>
	): Promise<BrowserRelayHostResult> => {
		const owner = getWindow(payload.sessionId);
		if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed())
			throw new Error('Host browser renderer is unavailable');
		const { promise, resolve, reject } = Promise.withResolvers<BrowserRelayHostResult>();
		const requestId = randomUUID();
		const timer = setTimeout(() => {
			pending.delete(requestId);
			reject(new Error('Host browser renderer did not respond'));
		}, 10_000);
		pending.set(requestId, { ownerId: owner.webContents.id, resolve, reject, timer });
		try {
			owner.webContents.send(channel, { ...payload, requestId });
		} catch (error) {
			clearTimeout(timer);
			pending.delete(requestId);
			reject(error);
		}
		return promise;
	};
	const pages = new HostBrowserPages({
		getOwner: getWindow,
		input: (guest, input) => dispatchBrowserRelayInput(guest, validateInput(input)),
		resolve: async (target) => {
			const owner = getWindow(target.sessionId);
			if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed())
				throw new Error('Host browser renderer is unavailable');
			const result = await hostRequest('browser:relayRequest', { ...target, kind: 'resolve' });
			if (!result.ok || !result.partition || typeof result.initialUrl !== 'string')
				throw new Error(result.error || 'Host browser tab is not registered');
			return { owner, partition: result.partition, url: result.initialUrl };
		},
	});
	pages.registerNativeHandlers();
	const request = async (
		payload: Omit<BrowserRelayRequest, 'requestId'>
	): Promise<BrowserRelayHostResult> => {
		const target = { sessionId: payload.sessionId, tabId: payload.tabId };
		if (payload.kind === 'release') {
			pages.releaseRemote(target);
			return { ok: true };
		}
		if (payload.kind === 'resolve') {
			const state = await pages.resolveRemote(target, payload.viewport!);
			return { ok: true, target, webContentsId: state.webContentsId, state };
		}
		if (payload.kind === 'frame')
			return { ok: true, target, frame: await pages.frame(target, payload.viewport!) };
		if (!payload.action) throw new Error('Missing browser action');
		return { ok: true, target, value: await pages.action(target, payload.action) };
	};
	relay = new BrowserRelay(request);
	setInterval(() => relay?.expire(), 5000).unref();
	const client = (event: RelayEvent): string => {
		if (event.type !== 'bridge' || typeof event.clientId !== 'string' || !event.clientId)
			throw new Error('Browser relay requires an authenticated remote bridge client');
		if (!isBrowserRelayReady()) throw new Error('Host browser renderer is not ready');
		return event.clientId;
	};
	ipcMain.handle('browser:relayReady', (event, ready: boolean) => {
		const win = deps.getMainWindow();
		if (!win || event.sender !== win.webContents)
			throw new Error('Only the owning host renderer can register browser readiness');
		readyOwnerId = ready === true ? win.webContents.id : null;
		if (ready === true) win.webContents.setBackgroundThrottling(false);
	});
	ipcMain.on(
		'browser:relayResponse',
		(event, requestId: string, result: BrowserRelayHostResult) => {
			const entry = pending.get(requestId);
			if (!entry || event.sender?.id !== entry.ownerId) return;
			clearTimeout(entry.timer);
			pending.delete(requestId);
			entry.resolve(result);
		}
	);
	ipcMain.handle(
		'browser:createTab',
		async (event: RelayEvent, sessionId: string, options: BrowserTabCreationOptions = {}) => {
			client(event);
			if (
				typeof sessionId !== 'string' ||
				!sessionId ||
				!options ||
				typeof options !== 'object' ||
				Array.isArray(options)
			)
				throw new Error('Invalid browser creation request');
			if (
				options.url !== undefined &&
				(typeof options.url !== 'string' || !isAllowedBrowserTabUrl(options.url))
			)
				throw new Error('Browser navigation URL is not allowed');
			if (
				(options.title !== undefined && typeof options.title !== 'string') ||
				(options.ephemeral !== undefined && typeof options.ephemeral !== 'boolean')
			)
				throw new Error('Invalid browser creation options');
			const result = await hostRequest('browser:createTabRequest', { sessionId, options });
			if (!result.ok) throw new Error(result.error || 'Host browser tab creation failed');
			return result.value;
		}
	);
	ipcMain.handle(
		'browser:relayOpen',
		(event: RelayEvent, target: BrowserRelayTarget, viewport: BrowserRelayViewport) =>
			relay!.open(client(event), target, viewport)
	);
	ipcMain.handle(
		'browser:relayFrame',
		async (event: RelayEvent, id: string, viewport: BrowserRelayViewport) =>
			(await relay!.run(client(event), id, 'frame', viewport)).frame
	);
	ipcMain.handle(
		'browser:relayAction',
		async (event: RelayEvent, id: string, action: BrowserRelayAction) =>
			(await relay!.run(client(event), id, 'action', undefined, action)).value
	);
	ipcMain.handle('browser:relayClose', (event: RelayEvent, id: string) =>
		relay!.close(client(event), id)
	);
	ipcMain.handle(
		'browser:relayInput',
		async (event: RelayEvent, id: string, input: BrowserRelayInput) => {
			const validated = validateInput(input);
			const clientId = client(event);
			const result = await relay!.run(clientId, id, 'resolve');
			if (!result.target) throw new Error('Host browser tab is not registered');
			await pages.input(result.target, validated, () => relay!.assertActive(clientId, id));
		}
	);
}

export function validateInput(input: BrowserRelayInput): BrowserRelayInput {
	if (!input || typeof input !== 'object') throw new Error('Invalid browser input');
	if (input.type === 'text') {
		if (typeof input.text !== 'string' || input.text.length > 16_384)
			throw new Error('Invalid browser text');
		return { type: 'text', text: input.text };
	}
	const modifiers = input.modifiers ?? [];
	if (
		!Array.isArray(modifiers) ||
		modifiers.length > 4 ||
		modifiers.some((m) => !['shift', 'control', 'alt', 'meta'].includes(m))
	)
		throw new Error('Invalid browser input modifiers');
	if (input.type === 'keyDown' || input.type === 'keyUp' || input.type === 'char') {
		if (typeof input.keyCode !== 'string' || !input.keyCode || input.keyCode.length > 64)
			throw new Error('Invalid browser key');
		return { type: input.type, keyCode: input.keyCode, modifiers };
	}
	if (
		!['mouseDown', 'mouseUp', 'mouseMove', 'mouseWheel'].includes(input.type) ||
		!('x' in input) ||
		!Number.isInteger(input.x) ||
		!Number.isInteger(input.y) ||
		input.x < 0 ||
		input.y < 0 ||
		input.x > 2560 ||
		input.y > 1600
	)
		throw new Error('Invalid browser pointer');
	if (input.type === 'mouseWheel') {
		if (
			!Number.isFinite(input.deltaX) ||
			!Number.isFinite(input.deltaY) ||
			Math.abs(input.deltaX) > 10_000 ||
			Math.abs(input.deltaY) > 10_000
		)
			throw new Error('Invalid browser scroll');
		return {
			type: input.type,
			x: input.x,
			y: input.y,
			deltaX: input.deltaX,
			deltaY: input.deltaY,
			modifiers,
		};
	}
	if (input.type !== 'mouseDown' && input.type !== 'mouseUp' && input.type !== 'mouseMove')
		throw new Error('Invalid browser input');
	if (input.button && !['left', 'middle', 'right'].includes(input.button))
		throw new Error('Invalid browser button');
	if (
		input.buttons !== undefined &&
		(!Number.isInteger(input.buttons) || input.buttons < 0 || input.buttons > 7)
	)
		throw new Error('Invalid browser buttons');
	if (
		input.clickCount !== undefined &&
		(!Number.isInteger(input.clickCount) || input.clickCount < 1 || input.clickCount > 3)
	)
		throw new Error('Invalid browser click count');
	return {
		type: input.type,
		x: input.x,
		y: input.y,
		button: input.button ?? 'left',
		buttons: input.buttons ?? 0,
		clickCount: input.clickCount ?? 1,
		modifiers,
	};
}
const KEY_CODES: Record<string, number> = {
	Backspace: 8,
	Tab: 9,
	Enter: 13,
	Shift: 16,
	Control: 17,
	Alt: 18,
	Escape: 27,
	' ': 32,
	PageUp: 33,
	PageDown: 34,
	End: 35,
	Home: 36,
	ArrowLeft: 37,
	ArrowUp: 38,
	ArrowRight: 39,
	ArrowDown: 40,
	Delete: 46,
	Meta: 91,
};
const MODIFIER_BITS: Record<string, number> = { alt: 1, control: 2, meta: 4, shift: 8 };

/** Chromium input does not require focusing/unminimizing the owning desktop window. */
export async function dispatchBrowserRelayInput(
	guest: WebContents,
	input: BrowserRelayInput
): Promise<void> {
	const attachedHere = !guest.debugger.isAttached();
	if (attachedHere) guest.debugger.attach('1.3');
	try {
		if (input.type === 'mouseWheel') {
			const modifiers = (input.modifiers ?? []).reduce(
				(mask, modifier) => mask | (MODIFIER_BITS[modifier] ?? 0),
				0
			);
			await guest.debugger.sendCommand('Input.dispatchMouseEvent', {
				type: 'mouseWheel',
				x: input.x,
				y: input.y,
				deltaX: input.deltaX,
				deltaY: input.deltaY,
				modifiers,
			});
			return;
		}
		if (input.type === 'text') {
			await guest.debugger.sendCommand('Input.insertText', { text: input.text });
			return;
		}
		const modifiers = (input.modifiers ?? []).reduce(
			(mask, modifier) => mask | (MODIFIER_BITS[modifier] ?? 0),
			0
		);
		if (input.type === 'keyDown' || input.type === 'keyUp' || input.type === 'char') {
			await guest.debugger.sendCommand('Input.dispatchKeyEvent', {
				type: input.type === 'keyDown' ? 'rawKeyDown' : input.type,
				key: input.keyCode,
				text: input.type === 'char' ? input.keyCode : undefined,
				windowsVirtualKeyCode:
					KEY_CODES[input.keyCode] ??
					(input.keyCode.length === 1 ? input.keyCode.toUpperCase().charCodeAt(0) : 0),
				modifiers,
			});
		} else if ('x' in input) {
			const type =
				input.type === 'mouseDown'
					? 'mousePressed'
					: input.type === 'mouseUp'
						? 'mouseReleased'
						: 'mouseMoved';
			await guest.debugger.sendCommand('Input.dispatchMouseEvent', {
				type,
				x: input.x,
				y: input.y,
				modifiers,
				button: input.button,
				buttons: input.buttons,
				clickCount: input.clickCount,
			});
		}
	} finally {
		if (attachedHere && guest.debugger.isAttached()) guest.debugger.detach();
	}
}
