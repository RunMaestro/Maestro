import { ipcRenderer } from 'electron';
import type { ClientState, DiscoveryPairingState } from '../../../shared/lite-discovery';
import type { LiteControlState } from '../../../shared/lite-control';

const availabilityLabels: Record<string, string> = {
	unmeasured: 'Checking…',
	ready: 'Available',
	'peer-offline': 'Offline',
	unreachable: "Can't be reached",
	'auth-required': 'Needs sign-in. Use a manual connection.',
	incompatible: 'Needs a Maestro update',
	'pairing-disabled': 'Not accepting new devices',
};
const sourceLabels: Record<string, string> = {
	lan: 'Local network',
	tailscale: 'Tailscale',
	cloudflare: 'Invitation',
};
const unreachable = "Couldn't reach the host. Check that it's awake and Maestro is open.";
const unexpected = 'The host sent an unexpected response, so pairing stopped. Try again.';
const wrongCode = "That code didn't match. Check the code on the host and try again.";
const errorCopy: Record<string, string> = {
	'wrong-pin-or-host': wrongCode,
	'invalid-proof': wrongCode,
	'six-digits-and-host-approval-required': 'Enter all 6 digits of the pairing code.',
	'operation-in-progress': 'Still working on the last step. Try again in a moment.',
	'attempt-in-progress': 'Still checking the last code. Try again in a moment.',
	'cancel-before-retry': 'Cancel the current request before starting another.',
	'incompatible-host':
		"This host runs a Maestro version that can't pair with this one. Update Maestro on both computers.",
	'host-identity-changed':
		"This host's identity changed since you last connected. Make sure it's the right computer before pairing.",
	'channel-mismatch': unexpected,
	'invalid-host-response': unexpected,
	'response-too-large': unexpected,
	'request-too-large': unexpected,
	'route-mismatch': unexpected,
	replay: unexpected,
	'invalid-request': unexpected,
	'invalid-capability': unexpected,
	'unknown-request': 'The host no longer has this request. Try again.',
	'authentication-required-use-manual':
		'This host requires a sign-in. Use a saved connection or sign in manually.',
	'private-route-required':
		'This host accepts pairing only over its private connection. Search again and choose its Tailscale or local network entry.',
	'tailnet-connection-failed':
		"Couldn't reach the host over Tailscale. Check that Tailscale is connected on both computers.",
	'tls-or-connection-failed': unreachable,
	'connection-timeout': unreachable,
	'connection-lost': unreachable,
	'pairing-unavailable': "The host isn't accepting pairing requests right now.",
	'pairing-disabled':
		'Access for other devices is off on the host. Turn it on in Connect another device.',
	'direct-tailnet-policy-required': "The host isn't accepting pairing requests right now.",
	'host-busy': 'The host is handling another pairing request. Try again in a minute.',
	'request-throttled': 'Too many requests in a short time. Wait a minute, then try again.',
	'attempt-throttled': 'Too many code attempts. Wait a minute, then try again.',
	locked: 'Too many incorrect codes. Start a new request.',
	expired: 'The request expired. Start a new request.',
	'not-paired': "Pairing isn't finished yet.",
};
const WORKING_PHASES = [
	'requesting',
	'awaiting-host',
	'pin-issued',
	'awaiting-confirmation',
	'paired',
];

/** User-facing text for Lite IPC failures, including pairing protocol error codes. */
export function readableError(error: unknown): string {
	const message = (error instanceof Error ? error.message : String(error ?? ''))
		.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
		.trim();
	if (!message || message === 'cancelled') return '';
	return (
		errorCopy[message] ??
		(/^[a-z0-9-]+$/.test(message) ? `Pairing stopped (${message}). Try again.` : message)
	);
}

interface PairingView {
	kind: 'hidden' | 'working' | 'connected' | 'ended';
	phase: string;
	heading: string;
	status: string;
}

export function installDiscoveryControls(report: (error: unknown) => void): {
	escape(): boolean;
	showHosts(focus?: boolean): void;
	showManual(): void;
} {
	const el = (id: string) => document.getElementById(id)!;
	const input = (id: string) => el(id) as HTMLInputElement;
	const button = (id: string) => el(id) as HTMLButtonElement;
	const setText = (node: HTMLElement, text: string) => {
		if (node.textContent !== text) node.textContent = text;
	};
	let page: 'hosts' | 'help' | 'manual' | 'invitation' | 'diagnostics' = 'hosts';
	let state: DiscoveryPairingState | undefined;
	let connection: LiteControlState | undefined;
	let rows = '';
	let sources = '';
	let shownView = '';
	let dismissed = '';
	let localError = '';
	let pinError = '';
	let target: { key: string; name: string } | undefined;
	let cancelledHere = false;
	let requesting = false;
	let pending = false;
	let starting = false;
	let importing = false;
	let offline = !navigator.onLine;
	for (const step of ['check', 'download', 'install']) {
		button('connection-update-' + step).onclick = async () => {
			try {
				const result = await ipcRenderer.invoke('lite:connection-update', step);
				setText(el('connection-update-status'), result.message);
				button('connection-update-download').hidden = result.status !== 'available';
				button('connection-update-install').hidden = result.status !== 'downloaded';
			} catch (error) {
				report(error);
			}
		};
	}

	async function action(name: string, payload?: unknown): Promise<void> {
		try {
			await ipcRenderer.invoke('lite:control', name, payload);
		} catch (error) {
			report(error);
		}
	}

	function pairingView(): PairingView {
		const pairing: ClientState = state?.pairing ?? { phase: 'idle' };
		const phase = pairing.phase;
		const host =
			target?.name ??
			state?.discovery.candidates.find((row) => row.id === pairing.instanceId)?.name ??
			'the host';
		const error = readableError(pairing.error) || localError;
		const view = (kind: PairingView['kind'], heading = '', status = ''): PairingView => ({
			kind,
			phase,
			heading,
			status,
		});
		const contacting = view('working', `Contacting ${host}…`, 'Sending a pairing request.');
		if (requesting && !WORKING_PHASES.slice(1).includes(phase) && phase !== 'connected')
			return contacting;
		switch (phase) {
			case 'requesting':
				return error ? view('ended', `Couldn't reach ${host}`, error) : contacting;
			case 'awaiting-host':
				return view(
					'working',
					`Approve on ${host}`,
					`${host} is showing your request. Choose Show code there.`
				);
			case 'pin-issued':
				return view('working', 'Enter the pairing code', `Type the 6-digit code shown on ${host}.`);
			case 'awaiting-confirmation':
				return view(
					'working',
					`Finish on ${host}`,
					`The code matched. Choose Pair device on ${host} to finish.`
				);
			case 'paired':
				return view(
					'working',
					'Finishing pairing…',
					`Saving this device so it can reconnect to ${host} without a code.`
				);
			case 'connected':
				if (connection?.error)
					return view(
						'ended',
						`Couldn't connect to ${host}`,
						'Check the connection message above, then try again.'
					);
				if (!connection?.canReturn || !connection.status.startsWith('connected'))
					return view(
						'working',
						`Opening Maestro on ${host}…`,
						'Pairing is saved. Waiting for the host connection.'
					);
				return view(
					'connected',
					`Connected to ${host}`,
					'This device is paired and reconnects without a code.'
				);
			case 'cancelled':
				if (error) return view('ended', "Pairing didn't finish", error);
				return cancelledHere
					? view('hidden')
					: view(
							'ended',
							'Request declined',
							`${host} declined the request, or it was cancelled there.`
						);
			case 'expired':
				return view(
					'ended',
					'Request expired',
					'Pairing codes last 2 minutes. Try again to get a new code.'
				);
			case 'locked':
				return view(
					'ended',
					'Too many incorrect codes',
					`This request is closed. Try again, and check the code on ${host} carefully.`
				);
			case 'connection-lost':
				return view(
					'ended',
					`Lost connection to ${host}`,
					'Check that both computers are online, then try again.'
				);
			case 'network-changed':
				return view('ended', 'Your network changed', 'Search again, then choose the host.');
			case 'idle':
				return localError ? view('ended', "Couldn't start pairing", localError) : view('hidden');
			default:
				return view('ended', "Pairing didn't finish", error || 'Try again.');
		}
	}

	function showPage(next: typeof page, focus = true): void {
		page = next;
		render();
		if (focus)
			el(
				next === 'hosts'
					? el('pairing-panel').hidden
						? 'discovery-heading'
						: 'pair-heading'
					: next === 'help'
						? 'help-heading'
						: next === 'manual'
							? 'manual-heading'
							: next === 'invitation'
								? 'invitation-heading'
								: 'diagnostics-heading'
			).focus();
	}

	function render(): void {
		const discovery = state?.discovery;
		const pairing = state?.pairing;
		const view = pairingView();
		const viewKey = [view.phase, view.heading, view.status].join('|');
		const visible = view.kind !== 'hidden' && !(view.kind === 'ended' && dismissed === viewKey);
		const busy = view.kind === 'working' || view.kind === 'connected';

		const inFlow = page === 'hosts';
		el('pairing-panel').hidden = !inFlow || !visible;
		el('pairing-panel').classList.toggle('quiet', view.kind === 'connected');
		el('discovery-panel').hidden = !inFlow || visible;
		el('connection-help').hidden = page !== 'help';
		el('manual-connections').hidden = page !== 'manual';
		el('invitation-page').hidden = page !== 'invitation';
		el('discovery-details').hidden = page !== 'diagnostics';
		button('guide-back').hidden = inFlow;
		el('guide-options').hidden = !inFlow || visible;
		el('flow-progress').hidden = !inFlow;
		setText(
			el('flow-progress'),
			!visible
				? 'Step 1 of 4 · Choose a computer'
				: view.kind === 'connected'
					? 'Connected'
					: view.kind === 'ended'
						? 'Connection stopped'
						: view.phase === 'pin-issued'
							? 'Step 3 of 4 · Enter the code'
							: ['awaiting-confirmation', 'paired', 'connected'].includes(view.phase)
								? 'Step 4 of 4 · Allow access'
								: 'Step 2 of 4 · Approve the request'
		);
		setText(el('pair-heading'), view.heading);
		setText(el('pair-status'), view.status);
		const enteringCode = view.kind === 'working' && view.phase === 'pin-issued';
		el('pair-pin-entry').hidden = !enteringCode;
		button('pair-submit').disabled = pending || pairing?.phase !== 'pin-issued';
		setText(
			el('pair-error'),
			pinError || (view.kind === 'working' ? readableError(pairing?.error) || localError : '')
		);
		button('pair-retry').hidden = !(
			view.kind === 'ended' &&
			target &&
			view.phase !== 'network-changed'
		);
		button('pair-dismiss').hidden = view.kind !== 'ended';
		setText(
			button('pair-dismiss'),
			view.phase === 'network-changed' ? 'Search again' : 'Back to hosts'
		);
		button('pair-cancel').hidden = view.kind !== 'working';
		button('pair-disconnect').hidden = view.kind !== 'connected';
		button('pair-return').hidden = view.kind !== 'connected';
		el('pair-proof').hidden = !pairing?.hostKey && pairing?.phase !== 'connected';
		button('pair-read').disabled = pending || pairing?.phase !== 'paired';
		setText(
			el('pair-identity'),
			pairing?.hostKey
				? `Host ID: ${pairing.instanceId ?? 'not verified yet'}. Host key: ${pairing.hostKey}`
				: ''
		);
		setText(
			el('pair-metadata'),
			pairing?.metadata ? `Verified host name: ${pairing.metadata.name}.` : ''
		);

		const nextShown = visible ? view.kind + ':' + view.phase : '';
		if (nextShown !== shownView) {
			const active = document.activeElement;
			const movable =
				!active ||
				active === document.body ||
				el('pairing-panel').contains(active) ||
				el('discovery-panel').contains(active);
			if (inFlow && enteringCode) input('pair-pin').focus();
			else if (inFlow && visible && view.kind !== 'connected' && movable)
				el('pair-heading').focus();
			else if (inFlow && !visible && shownView && movable) el('discovery-heading').focus();
			shownView = nextShown;
		}

		button('discovery-start').disabled = starting;
		button('discovery-tailnet').disabled = starting || offline || busy;
		button('discovery-tailnet').hidden = input('discovery-peers').checked;
		input('discovery-peers').disabled = starting || offline || busy || requesting || pending;
		button('discovery-stop').disabled = starting || !discovery?.running;
		button('discovery-import').disabled = importing;
		const readyCount =
			discovery?.candidates.filter((row) => row.availability === 'ready').length ?? 0;
		button('discovery-start').hidden = !input('discovery-peers').checked && !readyCount;
		el('discovery-intro').hidden = !!readyCount || input('discovery-peers').checked;
		el('discovery-status').hidden = !offline && !input('discovery-peers').checked && !readyCount;
		const blocked = Object.entries(discovery?.sources ?? {})
			.filter(([source]) => source !== 'cloudflare')
			.every(([, result]) =>
				['offline', 'permission-denied', 'unavailable', 'stopped'].includes(result.status)
			);
		setText(
			el('discovery-status'),
			offline
				? 'This computer is offline. Reconnect to a network to search for hosts.'
				: starting
					? 'Searching…'
					: readyCount
						? readyCount + (readyCount === 1 ? ' host available' : ' hosts available')
						: !discovery?.running
							? 'Search stopped. Choose Search again to look for hosts.'
							: blocked
								? "Automatic search isn't available on this network. Use an invitation or a manual connection."
								: 'Searching…'
		);
		el('discovered-hosts').setAttribute(
			'aria-busy',
			String(starting || !!discovery?.candidates.some((row) => row.availability === 'unmeasured'))
		);
		const sourceRows = Object.entries(discovery?.sources ?? {})
			.filter(
				([source, result]) => source !== 'cloudflare' || result.status !== 'invitation-required'
			)
			.map(([source, result]) => [
				result.status,
				`${sourceLabels[source] ?? source}: ${result.message}`,
			]);
		if (discovery?.errors.length) sourceRows.push(['error', discovery.errors.join(' · ')]);
		const encodedSources = JSON.stringify(sourceRows);
		if (encodedSources !== sources) {
			sources = encodedSources;
			el('discovery-sources').replaceChildren(
				...sourceRows.map(([status, text]) => {
					const item = document.createElement('li');
					item.dataset.sourceStatus = status;
					item.textContent = text;
					return item;
				})
			);
		}
		const encoded = JSON.stringify([
			discovery?.candidates ?? [],
			pending,
			requesting,
			busy,
			offline,
		]);
		if (encoded !== rows) {
			rows = encoded;
			const focused = (document.activeElement as HTMLElement | null)?.dataset.hostKey;
			el('discovered-hosts').replaceChildren(
				...(discovery?.candidates ?? []).map((row) => {
					const card = document.createElement('button');
					card.type = 'button';
					card.className = 'host-card';
					card.dataset.hostKey = row.key;
					card.disabled = offline || pending || requesting || busy || row.availability !== 'ready';
					const name = document.createElement('strong');
					name.textContent = row.name;
					const path = document.createElement('span');
					path.className = 'hint';
					path.textContent = (row.sources ?? [row.source])
						.map((source) => sourceLabels[source])
						.join(' · ');
					const status = document.createElement('span');
					status.dataset.availability = row.availability;
					status.textContent = availabilityLabels[row.availability] ?? 'Checking…';
					card.append(name, path, status);
					if (row.detail && row.availability !== 'ready') {
						const detail = document.createElement('span');
						detail.className = 'hint';
						detail.textContent = row.detail;
						card.append(detail);
					}
					card.onclick = () => void request(row.key, row.name);
					return card;
				})
			);
			if (focused)
				Array.from(el('discovered-hosts').querySelectorAll<HTMLButtonElement>('button'))
					.find((card) => card.dataset.hostKey === focused)
					?.focus();
		}
		el('discovery-empty').hidden =
			!!discovery?.candidates.length || offline || starting || !input('discovery-peers').checked;
		setText(
			el('discovery-empty'),
			'No computers found yet. Keep Maestro open on your other computer.'
		);
	}

	async function request(key: string, name: string): Promise<void> {
		if (requesting || pending || !state) return;
		const row = state.discovery.candidates.find((candidate) => candidate.key === key);
		page = 'hosts';
		target = { key, name };
		cancelledHere = false;
		pinError = '';
		dismissed = '';
		if (!row || row.availability !== 'ready') {
			localError = `${name} isn't available right now. Search again, then choose it.`;
			render();
			return;
		}
		localError = '';
		requesting = true;
		render();
		try {
			await ipcRenderer.invoke('lite:control', 'pair-request', {
				key,
				generation: state.discovery.generation,
			});
		} catch (error) {
			localError = readableError(error);
		} finally {
			requesting = false;
			render();
		}
	}

	function cancel(): void {
		cancelledHere = true;
		localError = '';
		pinError = '';
		render();
		void action('pair-cancel');
	}

	function dismiss(): void {
		const view = pairingView();
		dismissed = [view.phase, view.heading, view.status].join('|');
		localError = '';
		render();
		if (view.phase === 'network-changed') void start();
	}

	async function start(peers = input('discovery-peers').checked): Promise<void> {
		if (starting) return;
		starting = true;
		render();
		try {
			await action('discovery-start', peers ? { tailscalePeers: true } : {});
		} finally {
			starting = false;
			render();
		}
	}
	ipcRenderer.on('lite:discover', () => {
		showPage('hosts');
	});
	ipcRenderer.on('lite:state', (_event, next: LiteControlState) => {
		connection = next;
		const previousPhase = state?.pairing.phase;
		state = next.discoveryPairing;
		if (state?.pairing.phase !== previousPhase) pinError = '';
		render();
		if (state?.pairing.phase !== 'pin-issued') input('pair-pin').value = '';
	});
	button('guide-help').onclick = () => showPage('help');
	button('guide-back').onclick = () => showPage(page === 'help' ? 'hosts' : 'help');
	button('help-search').onclick = () => {
		showPage('hosts');
		void start();
	};
	button('open-invitation').onclick = () => showPage('invitation');
	button('open-diagnostics').onclick = () => showPage('diagnostics');
	button('discovery-tailnet').onclick = () => {
		input('discovery-peers').checked = true;
		void start();
	};
	button('pair-return').onclick = () => void action('dismiss');
	button('discovery-start').onclick = () => void start();
	input('discovery-peers').onchange = () => void start();
	button('discovery-stop').onclick = () => {
		input('discovery-peers').checked = false;
		void action('discovery-stop');
	};
	button('discovery-import').onclick = async () => {
		if (importing) return;
		importing = true;
		render();
		try {
			await ipcRenderer.invoke(
				'lite:control',
				'discovery-import',
				input('discovery-invitation').value
			);
			showPage('hosts');
		} catch (error) {
			report(error);
		} finally {
			importing = false;
			render();
		}
	};
	input('pair-pin').addEventListener('input', () => {
		const digits = input('pair-pin').value.replace(/\D/g, '').slice(0, 6);
		if (input('pair-pin').value !== digits) input('pair-pin').value = digits;
		if (pinError) {
			pinError = '';
			render();
		}
	});
	button('pair-submit').onclick = async () => {
		if (pending || state?.pairing.phase !== 'pin-issued') return;
		const pin = input('pair-pin').value.replace(/\D/g, '');
		if (pin.length !== 6) {
			pinError = 'Enter all 6 digits of the pairing code.';
			render();
			input('pair-pin').focus();
			return;
		}
		pending = true;
		pinError = '';
		input('pair-pin').value = '';
		render();
		try {
			await ipcRenderer.invoke('lite:control', 'pair-submit', pin);
		} catch (error) {
			pinError = readableError(error);
		} finally {
			pending = false;
			render();
			if (state?.pairing.phase === 'pin-issued') input('pair-pin').focus();
		}
	};
	input('pair-pin').addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			button('pair-submit').click();
		}
	});
	button('pair-read').onclick = async () => {
		if (pending || state?.pairing.phase !== 'paired') return;
		pending = true;
		render();
		try {
			await ipcRenderer.invoke('lite:control', 'pair-read');
		} catch (error) {
			localError = readableError(error);
		} finally {
			pending = false;
			render();
		}
	};
	button('pair-cancel').onclick = cancel;
	button('pair-dismiss').onclick = dismiss;
	button('pair-retry').onclick = () => {
		if (target) void request(target.key, target.name);
	};
	button('pair-disconnect').onclick = () => void action('disconnect');
	button('pair-forget').onclick = () => {
		cancelledHere = true;
		void action('pair-forget');
	};
	el('discovery-manual').onclick = () => {
		showPage('manual');
		const saved = el('profiles') as HTMLSelectElement;
		if (saved.options.length) {
			el('profile').hidden = true;
			el('saved').hidden = false;
			saved.focus();
		} else if (input('name').value || input('url').value) {
			el('profile').hidden = false;
			input('url').focus();
		} else {
			el('new').click();
			input('url').focus();
		}
	};
	for (const name of ['offline', 'online'])
		window.addEventListener(name, () => {
			offline = name === 'offline';
			render();
			void action('network-changed');
			input('discovery-peers').checked = false;
		});
	void start();
	return {
		showHosts(focus = true): void {
			showPage('hosts', focus);
		},
		showManual(): void {
			showPage('manual');
		},
		escape(): boolean {
			if (page !== 'hosts') {
				showPage(page === 'help' ? 'hosts' : 'help');
				return true;
			}
			const kind = el('pairing-panel').hidden ? 'hidden' : pairingView().kind;
			if (kind === 'working') cancel();
			else if (kind === 'ended') dismiss();
			return kind === 'working' || kind === 'ended';
		},
	};
}
