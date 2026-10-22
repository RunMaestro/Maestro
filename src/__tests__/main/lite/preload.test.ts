// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { connectionPage } from '../../../main/lite/ui';
import { hostPairingPage } from '../../../main/lite/pairing/host-ui';
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
let ready: EventListener | undefined;
const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const emit = () => ipc.listeners.get('lite:state')?.forEach((listener) => listener({}, state));

beforeEach(() => {
	vi.resetModules();
	ipc.listeners.clear();
	ipc.invoke.mockReset();
	documentListeners = [];
	windowListeners = [];
	ready = undefined;
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
});
afterEach(() => {
	window.dispatchEvent(new Event('unload'));
	for (const [name, handler] of documentListeners) document.removeEventListener(name, handler);
	for (const [name, handler] of windowListeners) window.removeEventListener(name, handler);
	vi.restoreAllMocks();
});

/** Mount inert page markup, import its preload and explicitly dispatch the captured DOM-ready callback. */
async function installPage(page: string, loadPreload: () => Promise<unknown>): Promise<void> {
	document.body.innerHTML = new DOMParser().parseFromString(page, 'text/html').body.innerHTML;
	await loadPreload();
	ready?.(new Event('DOMContentLoaded'));
}

/** Install the disconnected Lite picker with mocked profile-saving IPC and publish its initial state. */
async function installLitePage(): Promise<void> {
	state = { status: 'Disconnected', picker: true, profiles: [], aliases: [] };
	ipc.invoke.mockImplementation(async (_channel, name, profile) => {
		if (name === 'save') {
			state = { ...state, profiles: [profile] };
			emit();
		}
	});
	await installPage(connectionPage, () => import('../../../main/lite/preload'));
	emit();
}

describe('Lite connection first-use and recovery', () => {
	beforeEach(installLitePage);
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
	beforeEach(installLitePage);
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
	it('keeps network discovery off on boot until the user selects a search option', async () => {
		await vi.waitFor(() => expect(field('discovery-tailnet').disabled).toBe(false));
		expect(ipc.invoke.mock.calls.filter((call) => call[1] === 'discovery-start')).toEqual([
			['lite:control', 'discovery-start', { lan: false, tailscale: false, tailscalePeers: false }],
		]);
		expect(field('discovery-tailnet').getAttribute('aria-pressed')).toBe('false');
		expect(field('discovery-lan').getAttribute('aria-pressed')).toBe('false');
		expect(field('discovery-peers').checked).toBe(false);
	});
	it('offers Tailscale and local network discovery as separate visible choices', async () => {
		await vi.waitFor(() => expect(field('discovery-tailnet').disabled).toBe(false));
		expect(field('discovery-tailnet').textContent).toBe('Find over Tailscale');
		expect(field('discovery-lan').textContent).toBe('Find on local network');
		expect(field('discovery-tailnet').hidden).toBe(false);
		expect(field('discovery-lan').hidden).toBe(false);
		expect(field('discovery-lan-help').hidden).toBe(true);
	});
	it.each([
		['discovery-lan', { lan: true, tailscale: false, tailscalePeers: false }],
		['discovery-tailnet', { lan: false, tailscale: true, tailscalePeers: true }],
	] as const)(
		'retains the %s selection when refreshing or restarting a stopped search',
		async (id, options) => {
			await vi.waitFor(() => expect(field(id).disabled).toBe(false));
			discovery();
			ipc.invoke.mockClear();
			field(id).click();
			expect(ipc.invoke).toHaveBeenCalledWith('lite:control', 'discovery-start', options);
			expect(field(id).getAttribute('aria-pressed')).toBe('true');
			await vi.waitFor(() => expect(field('discovery-start').disabled).toBe(false));
			ipc.invoke.mockClear();
			field('discovery-start').click();
			expect(ipc.invoke).toHaveBeenCalledWith('lite:control', 'discovery-start', options);
			await vi.waitFor(() => expect(field('discovery-start').disabled).toBe(false));
			field('guide-help').click();
			field('open-diagnostics').click();
			field('discovery-stop').click();
			expect(ipc.invoke).toHaveBeenCalledWith('lite:control', 'discovery-stop', undefined);
			state.discoveryPairing!.discovery.running = false;
			emit();
			field('guide-back').click();
			ipc.invoke.mockClear();
			field('help-search').click();
			expect(ipc.invoke).toHaveBeenCalledWith('lite:control', 'discovery-start', {
				...options,
				tailscalePeers: false,
			});
			expect(field('discovery-lan').hidden).toBe(false);
			expect(field('discovery-tailnet').hidden).toBe(false);
		}
	);
	it('keeps advertised Tailscale discovery selected when diagnostic peer scanning is disabled', async () => {
		await vi.waitFor(() => expect(field('discovery-tailnet').disabled).toBe(false));
		field('discovery-tailnet').click();
		await vi.waitFor(() => expect(field('discovery-tailnet').disabled).toBe(false));
		field('guide-help').click();
		field('open-diagnostics').click();
		expect(field('discovery-details').hidden).toBe(false);
		expect(field('discovery-peers').checked).toBe(true);
		ipc.invoke.mockClear();
		field('discovery-peers').click();
		expect(field('discovery-peers').checked).toBe(false);
		expect(ipc.invoke).toHaveBeenCalledWith('lite:control', 'discovery-start', {
			lan: false,
			tailscale: true,
			tailscalePeers: false,
		});
		expect(field('discovery-tailnet').getAttribute('aria-pressed')).toBe('true');
		expect(field('discovery-lan').getAttribute('aria-pressed')).toBe('false');
		await vi.waitFor(() => expect(field('discovery-start').disabled).toBe(false));
		ipc.invoke.mockClear();
		field('discovery-peers').click();
		expect(field('discovery-peers').checked).toBe(true);
		expect(ipc.invoke).toHaveBeenCalledWith('lite:control', 'discovery-start', {
			lan: false,
			tailscale: true,
			tailscalePeers: true,
		});
		await vi.waitFor(() => expect(field('discovery-start').disabled).toBe(false));
		field('guide-back').click();
		expect(field('help-network').textContent).toMatch(/same Tailscale network/i);
	});
	it('switches from Tailscale to LAN and explains the local network requirements', async () => {
		await vi.waitFor(() => expect(field('discovery-tailnet').disabled).toBe(false));
		field('discovery-tailnet').click();
		await vi.waitFor(() => expect(field('discovery-lan').disabled).toBe(false));
		ipc.invoke.mockClear();
		field('discovery-lan').click();
		expect(ipc.invoke).toHaveBeenCalledWith('lite:control', 'discovery-start', {
			lan: true,
			tailscale: false,
			tailscalePeers: false,
		});
		expect(field('discovery-peers').checked).toBe(false);
		expect(field('discovery-tailnet').getAttribute('aria-pressed')).toBe('false');
		expect(field('discovery-lan-help').hidden).toBe(false);
		expect(field('discovery-lan-help').textContent).toMatch(/trusted.*network/i);
		expect(field('discovery-lan-help').textContent).toMatch(
			/not encrypted|unencrypted|plain.*text/i
		);
		field('guide-help').click();
		expect(field('help-network').textContent).toMatch(/same trusted local network/i);
	});
	it('restores the LAN search controls after going offline and coming back online', async () => {
		await vi.waitFor(() => expect(field('discovery-lan').disabled).toBe(false));
		field('discovery-lan').click();
		await vi.waitFor(() => expect(field('discovery-lan').disabled).toBe(false));
		window.dispatchEvent(new Event('offline'));
		expect(field('discovery-lan').disabled).toBe(true);
		expect(field('discovery-tailnet').disabled).toBe(true);
		window.dispatchEvent(new Event('online'));
		expect(field('discovery-lan').disabled).toBe(false);
		expect(field('discovery-tailnet').disabled).toBe(false);
		ipc.invoke.mockClear();
		field('discovery-start').click();
		expect(ipc.invoke).toHaveBeenCalledWith('lite:control', 'discovery-start', {
			lan: true,
			tailscale: false,
			tailscalePeers: false,
		});
	});
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
	beforeEach(installLitePage);
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

describe('Host connection transport controls', () => {
	const initialHostState = {
		enabled: false,
		direct: {
			enabled: false,
			ready: false,
			checking: false,
			message: 'Tailscale access is off.',
			origin: 'http://100.91.0.2:4733',
		},
		lan: {
			enabled: false,
			ready: false,
			checking: false,
			message: 'Local network access is off.',
			origin: '',
			interfaceAddress: '',
		},
		advertising: false,
		requests: [],
		devices: [],
		interfaces: [
			{ name: 'Wi-Fi', address: '192.168.50.2' },
			{ name: 'Ethernet', address: '10.0.0.2' },
			{ name: 'Link-local', address: '169.254.50.2' },
			{ name: 'Public', address: '192.0.2.2' },
		],
		lanInterfaces: [
			{ name: 'Wi-Fi', address: '192.168.50.2' },
			{ name: 'Ethernet', address: '10.0.0.2' },
		],
		endpoints: [],
		name: 'Office',
	};
	let hostState = structuredClone(initialHostState);

	beforeEach(async () => {
		hostState = structuredClone(initialHostState);
		ipc.invoke.mockImplementation(async () => hostState);
		await installPage(hostPairingPage, () => import('../../../main/lite/pairing/host-preload'));
		await vi.waitFor(() => expect(field('enable-direct').disabled).toBe(false));
	});

	it('retains private, link-local and public HTTPS discovery choices while direct LAN lists only private interfaces', () => {
		field('open-https').click();
		expect(
			Array.from(
				(field('interface') as unknown as HTMLSelectElement).options,
				(option) => option.value
			)
		).toEqual(['', '192.168.50.2', '10.0.0.2', '169.254.50.2', '192.0.2.2']);
		field('back').click();
		field('access-transport').value = 'lan';
		field('access-transport').dispatchEvent(new Event('change'));
		expect(
			Array.from(
				(field('lan-network') as unknown as HTMLSelectElement).options,
				(option) => option.value
			)
		).toEqual(['192.168.50.2', '10.0.0.2']);
	});

	it('offers LAN without Tailscale and shows the selected local interface and encryption guidance', async () => {
		expect(field('access-transport').value).toBe('tailscale');
		hostState.direct.origin = '';
		hostState.direct.message = 'Tailscale is not installed.';
		field('access-transport').value = 'lan';
		field('access-transport').dispatchEvent(new Event('change'));
		expect(field('lan-network-label').hidden).toBe(false);
		expect(field('lan-access-help').hidden).toBe(false);
		expect(field('lan-access-help').textContent).toMatch(/trusted local network/i);
		expect(field('lan-access-help').textContent).toMatch(/not encrypted/i);
		expect(field('open-tailscale').hidden).toBe(true);
		expect(field('enable-direct').disabled).toBe(false);
		expect(field('lan-network').value).toBe('192.168.50.2');
		field('lan-network').value = '10.0.0.2';
		field('lan-network').dispatchEvent(new Event('change'));
		field('direct-consent').checked = true;
		field('enable-direct').click();
		expect(ipc.invoke).toHaveBeenCalledWith('litePairing:local', 'enable-lan', {
			consent: true,
			interfaceAddress: '10.0.0.2',
		});
		expect(ipc.invoke.mock.calls.some((call) => call[1] === 'enable-direct')).toBe(false);
		await vi.waitFor(() => expect(field('enable-direct').disabled).toBe(false));
	});

	it.each(['tailscale', 'lan'])(
		'requires explicit consent before enabling %s access',
		(transport) => {
			field('access-transport').value = transport;
			field('access-transport').dispatchEvent(new Event('change'));
			ipc.invoke.mockClear();
			field('enable-direct').click();
			expect(ipc.invoke).not.toHaveBeenCalled();
			expect(field('direct-consent-error').hidden).toBe(false);
			expect(field('direct-consent').getAttribute('aria-invalid')).toBe('true');
			expect(document.activeElement).toBe(field('direct-consent'));
		}
	);

	it('clears consent whenever the user changes the transport or local interface', () => {
		field('direct-consent').checked = true;
		field('access-transport').value = 'lan';
		field('access-transport').dispatchEvent(new Event('change'));
		expect(field('direct-consent').checked).toBe(false);
		field('direct-consent').checked = true;
		field('lan-network').value = '10.0.0.2';
		field('lan-network').dispatchEvent(new Event('change'));
		expect(field('direct-consent').checked).toBe(false);
	});

	it('preserves Tailscale enablement and prevents repeated submissions while it starts', async () => {
		let finish!: () => void;
		ipc.invoke.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				})
		);
		field('direct-consent').checked = true;
		ipc.invoke.mockClear();
		field('enable-direct').click();
		field('enable-direct').click();
		expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith('litePairing:local', 'enable-direct', {
			consent: true,
		});
		expect(field('access-transport').disabled).toBe(true);
		expect(field('enable-direct').disabled).toBe(true);
		finish();
		await vi.waitFor(() => expect(field('enable-direct').disabled).toBe(false));
		expect(field('access-transport').disabled).toBe(false);
	});

	it.each(['tailscale', 'lan'])(
		'selects active %s access and blocks switching or HTTPS until it is turned off',
		async (transport) => {
			if (transport === 'lan') {
				hostState.lan = {
					...hostState.lan,
					enabled: true,
					ready: true,
					origin: 'http://10.0.0.2:4733',
					interfaceAddress: '10.0.0.2',
				};
			} else {
				hostState.direct.enabled = true;
				hostState.direct.ready = true;
			}
			field('refresh').click();
			await vi.waitFor(() => expect(field('waiting-step').hidden).toBe(false));
			expect(field('access-transport').value).toBe(transport);
			expect(field('access-transport').disabled).toBe(true);
			expect(field('direct-panel').hidden).toBe(true);
			if (transport === 'lan') {
				expect(field('lan-network').value).toBe('10.0.0.2');
				expect(field('lan-network').disabled).toBe(true);
			}
			field('manage-access').click();
			expect(field('manage-page').hidden).toBe(false);
			expect(field('access-mode').textContent).toMatch(
				transport === 'lan' ? /local network/i : /Tailscale/
			);
			expect(field('access-badge').textContent).toBe('On');
			expect(field(transport === 'lan' ? 'disable-lan' : 'disable-direct').hidden).toBe(false);
			expect(field(transport === 'lan' ? 'disable-direct' : 'disable-lan').hidden).toBe(true);
			field('open-https').click();
			expect(field('enable-https').disabled).toBe(true);
			expect(field('https-blocked').hidden).toBe(false);
			field('back').click();
			ipc.invoke.mockClear();
			field(transport === 'lan' ? 'disable-lan' : 'disable-direct').click();
			expect(ipc.invoke).toHaveBeenCalledWith(
				'litePairing:local',
				transport === 'lan' ? 'disable-lan' : 'disable-direct',
				undefined
			);
			await vi.waitFor(() => expect(field('disable-lan').disabled).toBe(false));
		}
	);

	it('returns to a local network recovery step when the enabled interface disappears', async () => {
		hostState.lan = {
			...hostState.lan,
			enabled: true,
			ready: false,
			message: 'The selected local network is unavailable.',
			interfaceAddress: '192.168.50.2',
		};
		hostState.interfaces = [];
		hostState.lanInterfaces = [];
		field('refresh').click();
		await vi.waitFor(() =>
			expect(field('access-heading').textContent).toBe('Reconnect this computer')
		);
		expect(field('waiting-step').hidden).toBe(true);
		expect(field('direct-panel').hidden).toBe(false);
		expect(field('access-transport').value).toBe('lan');
		expect(field('direct-status').textContent).toBe('The selected local network is unavailable.');
		expect(field('open-tailscale').hidden).toBe(true);
		expect(field('refresh').hidden).toBe(false);
		expect(field('enable-direct').hidden).toBe(true);
		field('manage-access').click();
		expect(field('disable-lan').hidden).toBe(false);
	});

	it('blocks LAN enablement when only HTTPS discovery interfaces are available', async () => {
		hostState.interfaces = initialHostState.interfaces.slice(2);
		hostState.lanInterfaces = [];
		field('refresh').click();
		await vi.waitFor(() => expect(field('access-transport').disabled).toBe(false));
		expect(
			Array.from(
				(field('interface') as unknown as HTMLSelectElement).options,
				(option) => option.value
			)
		).toEqual(['', '169.254.50.2', '192.0.2.2']);
		field('access-transport').value = 'lan';
		field('access-transport').dispatchEvent(new Event('change'));
		expect(field('enable-direct').disabled).toBe(true);
		expect(field('access-heading').textContent).toBe('Connect to a local network first');
		expect(field('open-tailscale').hidden).toBe(true);
		ipc.invoke.mockClear();
		field('direct-consent').checked = true;
		field('enable-direct').click();
		expect(ipc.invoke).not.toHaveBeenCalled();
	});
});
