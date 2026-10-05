// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { connectionPage } from '../../../main/lite/ui';
import type { LiteControlState } from '../../../shared/lite-control';

const ipc = vi.hoisted(() => ({
	invoke: vi.fn(),
	listeners: new Map<string, Array<(...args: unknown[]) => void>>(),
}));
vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: ipc.invoke,
		on: (name: string, listener: (...args: unknown[]) => void) => {
			ipc.listeners.set(name, [...(ipc.listeners.get(name) ?? []), listener]);
		},
	},
}));
let state: LiteControlState;
let documentListeners: Array<[string, EventListenerOrEventListenerObject]>;
let windowListeners: Array<[string, EventListenerOrEventListenerObject]>;
const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const emit = () => ipc.listeners.get('lite:state')?.forEach((listener) => listener({}, state));

beforeEach(async () => {
	vi.resetModules();
	ipc.listeners.clear();
	ipc.invoke.mockReset();
	documentListeners = [];
	windowListeners = [];
	document.body.innerHTML = new DOMParser().parseFromString(
		connectionPage,
		'text/html'
	).body.innerHTML;
	state = { status: 'Disconnected', picker: true, profiles: [], aliases: [] };
	ipc.invoke.mockImplementation(async (_channel, name, profile) => {
		if (name === 'save') {
			state = { ...state, profiles: [profile] };
			emit();
		}
	});
	let ready: EventListener | undefined;
	const addWindow = window.addEventListener.bind(window);
	vi.spyOn(window, 'addEventListener').mockImplementation((name, handler, options) => {
		if (name === 'DOMContentLoaded') ready = handler as EventListener;
		else {
			windowListeners.push([name, handler]);
			addWindow(name, handler, options);
		}
	});
	const addDocument = document.addEventListener.bind(document);
	vi.spyOn(document, 'addEventListener').mockImplementation((name, handler, options) => {
		documentListeners.push([name, handler]);
		addDocument(name, handler, options);
	});
	await import('../../../main/lite/preload');
	ready?.(new Event('DOMContentLoaded'));
	emit();
});
afterEach(() => {
	for (const [name, handler] of documentListeners) document.removeEventListener(name, handler);
	for (const [name, handler] of windowListeners) window.removeEventListener(name, handler);
	vi.restoreAllMocks();
});

describe('Lite connection first-use and recovery', () => {
	it('offers a visible return only when a remote view actually exists', () => {
		state = { ...state, selected: 'failed-host', picker: true, canReturn: false };
		emit();
		expect(field('return').hidden).toBe(true);
		state = { ...state, canReturn: true };
		emit();
		expect(field('return').hidden).toBe(false);
		field('return').click();
		expect(ipc.invoke).toHaveBeenCalledWith('lite:control', 'dismiss', undefined);
		state = { ...state, picker: false };
		emit();
		expect(field('return').hidden).toBe(true);
	});

	it('cancel and Escape do not request application close', () => {
		field('manual-new').click();
		field('name').value = 'Unsaved';
		field('cancel').click();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(field('name').value).toBe('');
		expect(ipc.invoke.mock.calls.some((call) => call[1] === 'close' || call[1] === 'dismiss')).toBe(
			false
		);
	});
	it('saves once before connecting and prevents repeated submissions', async () => {
		field('manual-new').click();
		let finishSave!: () => void;
		ipc.invoke.mockImplementation((_channel, action, profile) => {
			if (action === 'save')
				return new Promise<void>((resolve) => {
					finishSave = () => {
						state = { ...state, profiles: [profile] };
						emit();
						resolve();
					};
				});
			return Promise.resolve();
		});
		field('name').value = 'Office';
		field('url').value = 'https://host.example/token';
		const submit = () =>
			field('profile').dispatchEvent(
				new SubmitEvent('submit', { submitter: field('save-connect') })
			);
		submit();
		submit();
		expect(ipc.invoke.mock.calls.filter((call) => call[1] === 'save')).toHaveLength(1);
		expect(field('cancel').disabled).toBe(true);
		finishSave();
		await vi.waitFor(() =>
			expect(ipc.invoke.mock.calls.filter((call) => call[1] === 'connect')).toHaveLength(1)
		);
		expect(field('profile').hidden).toBe(true);
	});
	it('save for later never starts a connection', async () => {
		field('manual-new').click();
		field('name').value = 'Office';
		field('url').value = 'https://host.example/token';
		field('profile').dispatchEvent(new SubmitEvent('submit', { submitter: field('save') }));
		await vi.waitFor(() => expect(field('profile').hidden).toBe(true));
		expect(ipc.invoke.mock.calls.some((call) => call[1] === 'connect')).toBe(false);
	});
	it('a failed save keeps the form open and never connects', async () => {
		field('manual-new').click();
		ipc.invoke.mockRejectedValue(new Error('Direct connections require HTTPS.'));
		field('profile').dispatchEvent(new SubmitEvent('submit', { submitter: field('save-connect') }));
		await vi.waitFor(() => expect(field('error').textContent).toContain('HTTPS'));
		expect(field('profile').hidden).toBe(false);
		expect(field('save-connect').disabled).toBe(false);
		expect(ipc.invoke.mock.calls.some((call) => call[1] === 'connect')).toBe(false);
	});
	it('unchanged errors do not steal focus during connection-menu updates', () => {
		state = { ...state, error: 'Host unavailable' };
		emit();
		expect(document.activeElement).toBe(field('error'));
		field('palette').focus();
		emit();
		expect(document.activeElement).toBe(field('palette'));
	});
});

describe('Lite discovery-first controls', () => {
	function discovery(phase = 'idle'): void {
		state.discoveryPairing = {
			discovery: {
				running: true,
				generation: 7,
				errors: [],
				sources: {
					lan: { status: 'ready', message: 'Available' },
					tailscale: { status: 'permission-denied', message: 'Permission denied' },
					cloudflare: { status: 'invitation-required', message: 'Use an invitation' },
				},
				candidates: [
					{
						key: 'host-1',
						id: 'instance-1',
						name: '<img src=x>',
						endpoint: 'https://host.example',
						source: 'lan',
						availability: 'ready',
						expiresAt: Date.now() + 60000,
					},
				],
			},
			pairing: { phase },
		};
		emit();
	}
	it('offers cancellation until the remote view connects and retry after a failed connection', async () => {
		await Promise.resolve();
		discovery();
		document.querySelector<HTMLButtonElement>('[data-host-key="host-1"]')!.click();
		await Promise.resolve();
		state.status = 'Opening Maestro on Office';
		state.canReturn = true;
		discovery('connected');
		expect(field('pair-disconnect').hidden).toBe(true);
		expect(field('pair-cancel').hidden).toBe(false);
		state.status = 'connected · Office';
		emit();
		expect(field('pair-disconnect').hidden).toBe(false);
		expect(field('pair-cancel').hidden).toBe(true);
		state.status = 'Connection failed';
		state.error = 'Host rejected this device.';
		state.canReturn = false;
		emit();
		expect(field('pair-disconnect').hidden).toBe(true);
		expect(field('pair-retry').hidden).toBe(false);
	});
	it('does not report a forgotten pairing when credential removal fails', async () => {
		state.error =
			'Device authorization was revoked. Forget this pairing, select the host and pair again.';
		emit();
		ipc.invoke.mockRejectedValueOnce(new Error('Credential storage is unavailable.'));
		field('error-forget').click();
		await vi.waitFor(() =>
			expect(field('error').textContent).toBe('Credential storage is unavailable.')
		);
		expect(field('notice').textContent).toBe('');
	});
	it('requests a PIN from a host card once without connecting or saving', async () => {
		await Promise.resolve();
		discovery();
		expect(document.querySelector('#discovered-hosts img')).toBeNull();
		const card = document.querySelector<HTMLButtonElement>('[data-host-key="host-1"]')!;
		expect(card.disabled).toBe(false);
		let finish!: () => void;
		ipc.invoke.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				})
		);
		card.click();
		card.click();
		expect(ipc.invoke.mock.calls.filter((call) => call[1] === 'pair-request')).toHaveLength(1);

		expect(ipc.invoke.mock.calls.some((call) => ['connect', 'save'].includes(call[1]))).toBe(false);
		finish();
		await Promise.resolve();
	});
	it.each([
		'unmeasured',
		'peer-offline',
		'unreachable',
		'auth-required',
		'incompatible',
		'pairing-disabled',
	] as const)('does not offer PIN requests for %s hosts', (availability) => {
		discovery();
		state.discoveryPairing!.discovery.candidates[0].availability = availability;
		emit();
		const card = document.querySelector<HTMLButtonElement>('[data-host-key]')!;
		expect(card.disabled).toBe(true);
		card.click();
		expect(ipc.invoke.mock.calls.some((call) => call[1] === 'pair-request')).toBe(false);
	});

	it('disables host requests offline and reports the network change', () => {
		discovery();
		window.dispatchEvent(new Event('offline'));
		expect(document.querySelector<HTMLButtonElement>('[data-host-key]')!.disabled).toBe(true);
		expect(ipc.invoke).toHaveBeenCalledWith('lite:control', 'network-changed', undefined);
		window.dispatchEvent(new Event('online'));
		expect(document.querySelector<HTMLButtonElement>('[data-host-key]')!.disabled).toBe(false);
	});
	it('imports only an invitation hint without pairing, saving, or connecting', async () => {
		field('discovery-invitation').value = 'https://host.example/#maestro-invite=fixture';
		field('discovery-import').click();
		expect(ipc.invoke).toHaveBeenCalledWith(
			'lite:control',
			'discovery-import',
			field('discovery-invitation').value
		);
		expect(field('discovery-import').disabled).toBe(true);
		await vi.waitFor(() => expect(field('discovery-import').disabled).toBe(false));
		expect(
			ipc.invoke.mock.calls.some((call) => ['pair-request', 'save', 'connect'].includes(call[1]))
		).toBe(false);
	});
	it('focuses the PIN entry after consent, clears its secret and waits for confirmation', async () => {
		discovery('awaiting-host');
		expect(field('pair-pin-entry').hidden).toBe(true);
		discovery('pin-issued');
		expect(document.activeElement).toBe(field('pair-pin'));
		field('pair-pin').value = '123456';
		field('pair-pin').setSelectionRange(2, 4);
		emit();
		expect(field('pair-pin').value).toBe('123456');
		expect(document.activeElement).toBe(field('pair-pin'));
		expect(field('pair-pin').selectionStart).toBe(2);
		expect(field('pair-pin').selectionEnd).toBe(4);
		field('pair-submit').click();
		expect(ipc.invoke).toHaveBeenCalledWith('lite:control', 'pair-submit', '123456');
		expect(field('pair-pin').value).toBe('');
		expect(field('pair-submit').disabled).toBe(true);
		await Promise.resolve();
		discovery('awaiting-confirmation');
		expect(field('pair-pin-entry').hidden).toBe(true);
		expect(field('pair-read').disabled).toBe(true);
		expect(ipc.invoke.mock.calls.some((call) => call[1] === 'connect')).toBe(false);
	});
	it('keeps each connection step separate and preserves a manual draft across navigation and refresh', () => {
		discovery();
		expect(field('discovery-panel').hidden).toBe(false);
		expect(field('connection-help').hidden).toBe(true);
		expect(field('manual-connections').hidden).toBe(true);
		field('guide-help').click();
		expect(field('discovery-panel').hidden).toBe(true);
		field('discovery-manual').click();
		expect(field('connection-help').hidden).toBe(true);
		expect(field('manual-connections').hidden).toBe(false);
		field('url').value = 'https://my-computer.example/desktop';
		emit();
		expect(field('manual-connections').hidden).toBe(false);
		field('guide-back').click();
		field('discovery-manual').click();
		expect(field('url').value).toBe('https://my-computer.example/desktop');
		field('guide-back').click();
		field('guide-back').click();
		discovery('pin-issued');
		expect(field('pairing-panel').hidden).toBe(false);
		expect(field('discovery-panel').hidden).toBe(true);
		expect(field('manual-connections').hidden).toBe(true);
		expect(field('guide-options').hidden).toBe(true);
		expect(document.activeElement).toBe(field('pair-pin'));
		field('pair-cancel').click();
		discovery('cancelled');
		expect(field('pairing-panel').hidden).toBe(true);
		expect(field('discovery-panel').hidden).toBe(false);
	});
	it('disables expired proof reads and cancels active proof on Escape without closing Lite', () => {
		discovery('expired');
		expect(field('pair-read').disabled).toBe(true);
		discovery('awaiting-confirmation');
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(ipc.invoke).toHaveBeenCalledWith('lite:control', 'pair-cancel', undefined);
		expect(ipc.invoke.mock.calls.some((call) => call[1] === 'close')).toBe(false);
	});
});

describe('Lite saved connection and command recovery', () => {
	it('hands off to saved profiles without editing, trusting or connecting automatically', () => {
		state.profiles = [
			{
				id: 'saved',
				name: 'Office',
				transport: 'https',
				url: 'https://host.example/token',
				instanceId: 'verified-instance',
			},
		];
		emit();
		field('discovery-manual').click();
		expect(document.activeElement).toBe(field('profiles'));
		expect(field('profile').hidden).toBe(true);
		expect(field('identity-details').hidden).toBe(false);
		field('edit').click();
		expect(field('profile').hidden).toBe(false);
		expect(field('name').value).toBe('Office');
		field('cancel').click();
		expect(field('profile').hidden).toBe(true);
		expect(document.activeElement).toBe(field('connect'));
		expect(
			ipc.invoke.mock.calls.some((call) => ['connect', 'save', 'trust'].includes(call[1]))
		).toBe(false);
	});
	it('Escape preserves the command palette and remote-view return behavior', () => {
		state = { ...state, commandsVisible: true };
		emit();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(ipc.invoke).toHaveBeenCalledWith('lite:control', 'dismiss', undefined);
		expect(document.activeElement).toBe(field('palette'));
		ipc.invoke.mockClear();
		state = { ...state, commandsVisible: false, canReturn: true };
		emit();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(ipc.invoke).toHaveBeenCalledWith('lite:control', 'dismiss', undefined);
	});
});
