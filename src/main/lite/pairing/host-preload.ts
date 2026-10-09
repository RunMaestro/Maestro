import { ipcRenderer } from 'electron';
import type { LocalRequest } from './protocol';
import type { DirectAccessState } from './direct-tailnet';
interface State {
	enabled: boolean;
	direct: DirectAccessState;
	advertising: boolean;
	requests: LocalRequest[];
	devices: Array<{ id: string; name: string; createdAt: number }>;
	focusRequestId?: string;
	error?: string;
	interfaces: Array<{ name: string; address: string }>;
	endpoints: string[];
	name: string;
	expiresAt?: number;
	invitation?: { text: string; qr: string; expiresAt: number };
	updateStatus?: { status: string; message: string };
}

const OPEN_REQUEST_STATES = ['awaiting-host', 'pin-issued', 'awaiting-confirmation', 'approved'];

window.addEventListener('DOMContentLoaded', () => {
	const el = (id: string) => document.getElementById(id)!;
	const input = (id: string) => el(id) as HTMLInputElement;
	const button = (id: string) => el(id) as HTMLButtonElement;
	const setText = (node: HTMLElement, text: string) => {
		if (node.textContent !== text) node.textContent = text;
	};
	const clock = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
	let pending = 0,
		initialized = false,
		optionsKey = '',
		requestsKey = '',
		devicesKey = '',
		localError = '',
		removing: string | undefined,
		latest: State | undefined;
	let page: 'connect' | 'manage' | 'https' | 'updates' = 'connect';
	let selectedRequest: string | undefined;
	let lastFocusRequest: string | undefined;
	const requestStates = new Map<string, string>();

	async function action(name: string, payload?: unknown): Promise<boolean> {
		const mutation = name !== 'state' && name !== 'close';
		if (mutation) {
			if (pending) return false;
			pending++;
			localError = '';
			if (latest) render(latest);
		}
		try {
			const state = (await ipcRenderer.invoke('litePairing:local', name, payload)) as
				| State
				| undefined;
			if (state) render(state);
			return true;
		} catch (error) {
			localError = (error instanceof Error ? error.message : String(error)).replace(
				/^Error invoking remote method '[^']+': (?:Error: )?/,
				''
			);
			setText(el('error'), localError);
			el('error').focus();
			return false;
		} finally {
			if (mutation) {
				pending--;
				if (latest) render(latest);
			}
		}
	}

	function render(state: State): void {
		latest = state;
		setText(el('error'), localError || state.error || '');
		renderAccess(state);
		renderHttps(state);
		renderRequests(state);
		renderDevices(state);

		for (const control of document.querySelectorAll<HTMLButtonElement>(
			'#requests button, #paired-devices button'
		))
			control.disabled = pending > 0;
		if (state.updateStatus) {
			setText(el('update-status'), state.updateStatus.message);
			button('update-download').hidden = state.updateStatus.status !== 'available';
			button('update-install').hidden = state.updateStatus.status !== 'downloaded';
		}
	}

	function showPage(next: typeof page): void {
		page = next;
		if (latest) render(latest);
		const heading =
			next === 'manage'
				? 'manage-heading'
				: next === 'https'
					? 'https-heading'
					: next === 'updates'
						? 'updates-heading'
						: selectedRequest
							? 'request-title-' + selectedRequest
							: latest?.direct.ready || latest?.enabled
								? 'waiting-heading'
								: 'access-heading';
		el(heading)?.focus();
	}

	function renderFlow(state: State): void {
		const current = state.requests.find((row) => row.requestId === selectedRequest);
		const connecting = page === 'connect';
		const ready = state.direct.ready || (state.enabled && !state.direct.enabled);
		el('manage-page').hidden = page !== 'manage';
		el('attended-options').hidden = page !== 'https';
		el('updates').hidden = page !== 'updates';
		el('requests-section').hidden = !connecting || !current;
		el('waiting-step').hidden = !connecting || !!current || !ready;
		el('direct-panel').hidden = !connecting || !!current || ready;
		button('back').hidden = connecting;
		button('manage-access').hidden =
			!connecting || (!!current && OPEN_REQUEST_STATES.includes(current.state));
		el('flow-progress').hidden = !connecting;
		setText(el('page-title'), connecting ? 'Connect another device' : 'Device access');
		const progress =
			current?.state === 'pin-issued'
				? 'Step 3 of 4 · Enter the code'
				: current?.state === 'awaiting-confirmation' || current?.state === 'approved'
					? 'Step 4 of 4 · Allow access'
					: current?.state === 'awaiting-host'
						? 'Step 2 of 4 · Approve the request'
						: current?.state === 'paired'
							? 'Pairing complete'
							: current
								? 'Request closed'
								: ready
									? 'Step 1 of 4 · Choose this computer'
									: 'Get ready';
		setText(el('flow-progress'), progress);
		setText(el('how-to-name'), state.name);
		const others = state.requests.filter(
			(row) => OPEN_REQUEST_STATES.includes(row.state) && row.requestId !== selectedRequest
		);
		button('next-request').hidden = !connecting || others.length === 0;
		setText(button('next-request'), 'Next request (' + others.length + ')');
	}

	function renderAccess(state: State): void {
		const direct = state.direct;
		const mode = direct.enabled
			? direct.ready
				? 'on'
				: 'blocked'
			: direct.origin
				? 'off'
				: direct.checking
					? 'checking'
					: 'unavailable';
		const copy: Record<typeof mode, [string, string, string]> = {
			checking: ['Checking Tailscale on this computer…', '', ''],
			unavailable: ["Tailscale isn't ready on this computer.", 'Off', ''],
			off: [
				'Turn on access so Maestro Lite on your other devices can find this computer over Tailscale. Each new device needs a pairing code and your approval.',
				'Off',
				'',
			],
			on: [
				'On. Devices on your Tailscale network can find this computer and ask to pair.',
				'On',
				'on',
			],
			blocked: [
				"Access is on, but other devices can't reach this computer right now.",
				'Unavailable',
				'warn',
			],
		};
		const [status, badge, tone] = copy[mode];
		setText(
			el('access-heading'),
			mode === 'checking'
				? 'Checking this computer'
				: mode === 'blocked'
					? 'Reconnect this computer'
					: mode === 'unavailable'
						? 'Connect Tailscale first'
						: 'Make this computer available'
		);
		setText(el('status'), status);
		setText(el('access-badge'), badge);
		if (tone) el('access-badge').dataset.tone = tone;
		else delete el('access-badge').dataset.tone;
		const showReason = mode === 'unavailable' || mode === 'blocked';
		el('direct-status').hidden = !showReason;
		setText(el('direct-status'), showReason ? direct.message : '');
		el('direct-setup').hidden = mode !== 'off';
		button('enable-direct').hidden = mode !== 'off';
		button('enable-direct').disabled = pending > 0 || mode !== 'off';
		button('open-tailscale').hidden = !showReason;
		button('open-tailscale').classList.toggle('primary', mode === 'unavailable');
		button('refresh').hidden = !showReason;
		button('refresh').classList.toggle('primary', mode === 'blocked');
		button('disable-direct').hidden = !direct.enabled;
		button('disable-direct').disabled = pending > 0;
		el('direct-hint').hidden = mode !== 'on';

		if (direct.enabled) {
			input('direct-consent').checked = false;
			el('direct-consent-error').hidden = true;
		}
	}

	function renderHttps(state: State): void {
		if (!initialized) {
			input('name').value = state.name;
			initialized = true;
		}
		const next = JSON.stringify([state.endpoints, state.interfaces]);
		if (next !== optionsKey) {
			optionsKey = next;
			const populate = (
				id: string,
				empty: string,
				rows: Array<{ value: string; label: string }>
			) => {
				const select = el(id) as HTMLSelectElement,
					previous = select.value;
				select.replaceChildren(
					...[{ value: '', label: rows.length ? 'Choose one' : empty }, ...rows].map((row) => {
						const option = document.createElement('option');
						option.value = row.value;
						option.textContent = row.label;
						return option;
					})
				);
				if (rows.some((row) => row.value === previous)) select.value = previous;
			};
			populate(
				'endpoint',
				'None found. Enter a different address below.',
				state.endpoints.map((value) => ({ value, label: value }))
			);
			populate(
				'interface',
				'No local network found',
				state.interfaces.map((i) => ({ value: i.address, label: i.name + ' (' + i.address + ')' }))
			);
		}
		const httpsOn = state.enabled && !state.direct.enabled;
		el('https-on').hidden = !httpsOn;
		(el('enable') as HTMLFormElement).hidden = httpsOn;
		el('https-blocked').hidden = !state.direct.enabled;
		button('enable-https').disabled = state.direct.enabled || pending > 0;
		setText(el('https-badge'), httpsOn ? '(HTTPS on)' : '');
		setText(
			el('sharing-expiry'),
			httpsOn && state.expiresAt
				? 'HTTPS access is on until ' +
						clock.format(state.expiresAt) +
						', or until you close this window.'
				: ''
		);
		button('invite').disabled = !httpsOn;
		el('invitation-panel').hidden = !state.invitation;
		if (input('invitation').value !== (state.invitation?.text ?? ''))
			input('invitation').value = state.invitation?.text ?? '';
		const image = el('invitation-qr') as HTMLImageElement;
		if (state.invitation) {
			if (image.getAttribute('src') !== state.invitation.qr) image.src = state.invitation.qr;
		} else image.removeAttribute('src');
		setText(
			el('invitation-expiry'),
			state.invitation ? 'Expires at ' + clock.format(state.invitation.expiresAt) + '.' : ''
		);
	}

	function countdown(expiresAt: number): string {
		const seconds = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
		return seconds
			? 'Expires in ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
			: 'Expired';
	}

	function requestCard(row: LocalRequest): HTMLElement {
		const card = document.createElement('article'),
			title = document.createElement('h3'),
			name = row.clientName;
		card.className = 'request';
		card.dataset.requestId = row.requestId;
		card.setAttribute('aria-labelledby', 'request-title-' + row.requestId);
		title.id = 'request-title-' + row.requestId;
		title.tabIndex = -1;
		card.append(title);
		const paragraph = (text: string, className = '') => {
			const p = document.createElement('p');
			p.textContent = text;
			if (className) p.className = className;
			card.append(p);
		};
		const buttons = document.createElement('div');
		buttons.className = 'actions';
		const add = (label: string, command: string, primary = false) => {
			const b = document.createElement('button');
			b.type = 'button';
			b.textContent = label;
			b.dataset.focusKey = row.requestId + ':' + command;
			if (primary) b.className = 'primary';
			b.onclick = () => void action(command, { id: row.requestId });
			buttons.append(b);
		};
		const expiry = () => {
			const p = document.createElement('p');
			p.className = 'muted expiry';
			p.dataset.expires = String(row.expiresAt);
			p.textContent = countdown(row.expiresAt);
			card.append(p);
		};
		if (row.state === 'awaiting-host') {
			title.textContent = name + ' wants to connect';
			paragraph(
				"If you started this on that device, choose Show code. You'll approve access in a separate step."
			);
			paragraph(
				"The name comes from the device itself. If you didn't start this, choose Decline.",
				'muted'
			);
			add('Show code', 'approve', true);
			add('Decline', 'revoke');
		} else if (row.state === 'pin-issued') {
			title.textContent = 'Enter this code on ' + name;
			if (row.pin) {
				const code = document.createElement('pre'),
					spoken = document.createElement('p');
				code.className = 'code';
				code.setAttribute('aria-hidden', 'true');
				for (const part of [row.pin.slice(0, 3), row.pin.slice(3)]) {
					const span = document.createElement('span');
					span.textContent = part;
					code.append(span);
				}
				spoken.className = 'sr-only';
				spoken.textContent = 'Pairing code: ' + row.pin.split('').join(' ');
				card.append(code, spoken);
			}
			expiry();
			add('Decline', 'revoke');
		} else if (row.state === 'awaiting-confirmation') {
			card.classList.add('final');
			title.textContent = 'Allow ' + name + ' to control this computer?';
			paragraph('The code was entered correctly on ' + name + '.');
			const risk = document.createElement('p');
			risk.className = 'risk';
			risk.textContent =
				name +
				' will be able to use your chats, run agents and terminals, and read and change files on this computer. Access lasts until you remove the device under Paired devices.';
			card.append(risk);
			paragraph('Approve only if you started this request on that device.', 'muted');
			expiry();
			add('Pair device and allow control', 'confirm', true);
			add('Decline', 'revoke');
		} else if (row.state === 'paired' || ['cancelled', 'expired', 'locked'].includes(row.state)) {
			title.textContent =
				row.state === 'paired'
					? name + ' is paired'
					: row.state === 'expired'
						? 'The pairing code expired'
						: row.state === 'locked'
							? 'Too many incorrect codes'
							: 'This request was closed';
			paragraph(
				row.state === 'paired'
					? 'Continue in Lite on ' + name + '. Next time it can reconnect without a code.'
					: 'Start a new request in Lite on ' + name + ' when you are ready.'
			);
			const done = document.createElement('button');
			done.type = 'button';
			done.className = 'primary';
			done.textContent = row.state === 'paired' ? 'Done' : 'Back';
			done.onclick = () => {
				if (row.state === 'paired') void action('close');
				else {
					selectedRequest = undefined;
					showPage('connect');
				}
			};
			buttons.append(done);
		} else {
			title.textContent = 'Finishing pairing with ' + name + '…';
			paragraph(name + ' is saving its access.', 'muted');
			add('Cancel', 'revoke');
		}
		card.append(buttons);
		return card;
	}

	function renderRequests(state: State): void {
		const requestedFocus = state.requests.find((row) => row.requestId === state.focusRequestId);
		if (
			requestedFocus &&
			OPEN_REQUEST_STATES.includes(requestedFocus.state) &&
			requestedFocus.requestId !== lastFocusRequest
		) {
			lastFocusRequest = requestedFocus.requestId;
			selectedRequest = requestedFocus.requestId;
			page = 'connect';
		}
		if (selectedRequest && !state.requests.some((row) => row.requestId === selectedRequest))
			selectedRequest = undefined;
		selectedRequest ??= state.requests.find((row) =>
			OPEN_REQUEST_STATES.includes(row.state)
		)?.requestId;
		const requests = state.requests.filter((row) => row.requestId === selectedRequest);
		renderFlow(state);
		const encoded = JSON.stringify(requests);
		if (encoded !== requestsKey) {
			requestsKey = encoded;
			const active = document.activeElement as HTMLElement | null;
			const focusKey = active?.dataset.focusKey;
			const focusedRequest = active?.closest<HTMLElement>('[data-request-id]')?.dataset.requestId;
			const lostFocus = !active || active === document.body;
			el('requests').replaceChildren(...requests.map(requestCard));
			const restored = focusKey
				? el('requests').querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)
				: null;
			restored?.focus();
			const messages: string[] = [];
			for (const row of requests) {
				if (requestStates.get(row.requestId) === row.state) continue;
				requestStates.set(row.requestId, row.state);
				if (row.state === 'awaiting-host')
					messages.push('Pairing request from ' + row.clientName + '.');
				if (row.state === 'pin-issued')
					messages.push('Code ready. Enter it on ' + row.clientName + '.');
				if (row.state === 'awaiting-confirmation')
					messages.push('Code accepted. Approve or decline ' + row.clientName + '.');
				if (
					!restored &&
					(row.requestId === state.focusRequestId || row.requestId === focusedRequest || lostFocus)
				) {
					const title = document.getElementById('request-title-' + row.requestId);
					title?.scrollIntoView({ block: 'nearest' });
					title?.focus({ preventScroll: true });
				}
			}
			if (messages.length) el('announcer').textContent = messages.join(' ');
			for (const id of requestStates.keys())
				if (!requests.some((row) => row.requestId === id)) requestStates.delete(id);
		}
		for (const node of el('requests').querySelectorAll<HTMLElement>('[data-expires]'))
			setText(node, countdown(Number(node.dataset.expires)));
	}

	function renderDevices(state: State): void {
		if (removing && !state.devices.some((device) => device.id === removing)) removing = undefined;
		el('no-devices').hidden = state.devices.length > 0;
		const encoded = JSON.stringify([state.devices, removing]);
		if (encoded === devicesKey) return;
		const previous = devicesKey ? (JSON.parse(devicesKey)[0] as State['devices']) : undefined;
		devicesKey = encoded;
		const focusKey = (document.activeElement as HTMLElement | null)?.dataset.focusKey;
		el('paired-devices').replaceChildren(
			...state.devices.map((device) => {
				const item = document.createElement('li'),
					text = document.createElement('div'),
					title = document.createElement('strong'),
					meta = document.createElement('div'),
					buttons = document.createElement('div');
				title.textContent = device.name;
				meta.className = 'muted';
				meta.textContent = 'Paired ' + new Date(device.createdAt).toLocaleDateString();
				buttons.className = 'actions';
				const add = (label: string, key: string, run: () => void, className = '', aria = '') => {
					const b = document.createElement('button');
					b.type = 'button';
					b.textContent = label;
					b.dataset.focusKey = device.id + ':' + key;
					if (className) b.className = className;
					if (aria) b.setAttribute('aria-label', aria);
					b.onclick = run;
					buttons.append(b);
				};
				if (removing === device.id) {
					meta.textContent =
						'Remove ' +
						device.name +
						'? It disconnects now and needs a new pairing code to connect again.';
					meta.className = '';
					add('Remove device', 'confirm-remove', () => void removeDevice(device), 'danger');
					add('Keep', 'keep', () => cancelRemoval(device.id));
				} else
					add(
						'Remove',
						'remove',
						() => {
							removing = device.id;
							if (latest) renderDevices(latest);
							el('paired-devices')
								.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(device.id + ':keep')}"]`)
								?.focus();
						},
						'',
						'Remove ' + device.name
					);
				text.append(title, meta);
				item.append(text, buttons);
				return item;
			})
		);
		if (focusKey)
			el('paired-devices')
				.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)
				?.focus();
		const added = previous && state.devices.filter((d) => !previous.some((p) => p.id === d.id));
		if (added?.length)
			el('announcer').textContent = added.map((d) => d.name).join(', ') + ' paired.';
	}

	function cancelRemoval(id: string): void {
		removing = undefined;
		if (latest) renderDevices(latest);
		el('paired-devices')
			.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(id + ':remove')}"]`)
			?.focus();
	}

	async function removeDevice(device: { id: string; name: string }): Promise<void> {
		removing = undefined;
		if (await action('revoke-device', { id: device.id })) {
			el('announcer').textContent = device.name + ' removed.';
			el('devices-heading').focus();
		}
	}
	button('manage-access').onclick = () => showPage('manage');
	button('open-https').onclick = () => showPage('https');
	button('open-updates').onclick = () => showPage('updates');
	button('back').onclick = () => showPage(page === 'manage' ? 'connect' : 'manage');
	button('next-request').onclick = () => {
		const requests =
			latest?.requests.filter((row) => OPEN_REQUEST_STATES.includes(row.state)) ?? [];
		const index = requests.findIndex((row) => row.requestId === selectedRequest);
		selectedRequest = requests[(index + 1) % requests.length]?.requestId;
		showPage('connect');
	};
	button('enable-direct').onclick = () => {
		if (pending) return;
		if (!input('direct-consent').checked) {
			el('direct-consent-error').hidden = false;
			input('direct-consent').setAttribute('aria-invalid', 'true');
			input('direct-consent').focus();
			return;
		}
		void action('enable-direct', { consent: true });
	};
	input('direct-consent').onchange = () => {
		el('direct-consent-error').hidden = true;
		input('direct-consent').removeAttribute('aria-invalid');
	};
	button('disable-direct').onclick = () => {
		if (!pending) void action('disable-direct');
	};
	button('refresh').onclick = () => void action('inspect');
	button('open-tailscale').onclick = () => void action('open-tailscale');
	button('close').onclick = () => void action('close');
	button('stop').onclick = () => void action('stop');
	button('invite').onclick = () => void action('invite', { name: input('name').value });
	button('copy-invitation').onclick = async () => {
		if (await action('copy-invitation')) el('announcer').textContent = 'Invitation copied.';
	};
	input('advanced').onchange = () => {
		input('advanced-endpoint').hidden = !input('advanced').checked;
		if (input('advanced').checked) input('advanced-endpoint').focus();
	};
	input('lan').onchange = () => {
		el('interface-row').hidden = !input('lan').checked;
	};
	el('enable').addEventListener('submit', (event) => {
		event.preventDefault();
		if (!pending)
			void action('enable', {
				name: input('name').value,
				endpoint: input('advanced').checked
					? input('advanced-endpoint').value
					: input('endpoint').value,
				advanced: input('advanced').checked,
				consent: input('consent').checked,
				lan: input('lan').checked,
				interfaceAddress: input('interface').value,
			});
	});
	for (const step of ['check', 'download', 'install'])
		button('update-' + step).onclick = () => void action('update-' + step);
	window.addEventListener('keydown', (event) => {
		if (event.key !== 'Escape') return;
		if (removing) cancelRemoval(removing);
		else if (page !== 'connect') showPage(page === 'manage' ? 'connect' : 'manage');
		else void action('close');
	});
	void action('state');
	const timer = setInterval(() => void action('state'), 1000);
	window.addEventListener('unload', () => clearInterval(timer));
});
