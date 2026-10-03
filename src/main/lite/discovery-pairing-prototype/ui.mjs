/* global document, setInterval */
import { demoFixtures } from './fixtures.mjs';
import { PairingClient } from './pairing.mjs';
const $ = (id) => document.getElementById(id);
const text = (tag, content, className) => {
	const node = document.createElement(tag);
	node.textContent = content;
	if (className) node.className = className;
	return node;
};
const transport = {
	lan: 'LAN DNS-SD · HTTPS',
	tailscale: 'Tailscale known peer · HTTPS',
	cloudflare: 'Cloudflare registered/invited · HTTPS',
};
const errors = {
	'wrong-pin-or-host':
		'PIN incorrect or host proof did not match. Check the HOST screen and retry.',
	expired: 'The PIN/request expired. Refresh and request a new PIN.',
	locked: 'Five guesses used. This PIN is locked; start a new host-approved request.',
	cancelled: 'Pairing cancelled. No access remains.',
	offline:
		'Host is offline in this fixture. Choose a registered alternative; no downgrade or automatic retry.',
	'host-identity-changed':
		'Host identity does not match the saved host. Discovery cannot replace it.',
	'network-changed': 'Network changed. Old requests and grants are invalid; refresh discovery.',
	'request-throttled': 'Host request limit reached. Wait a minute before requesting again.',
	'attempt-throttled': 'Host proof-attempt limit reached. Wait a minute before trying again.',
	'host-busy': 'Host already has four pending requests.',
	forbidden: 'Denied: this pairing cannot run agents or access private data.',
	'six-digits-required': 'Enter exactly six digits from the HOST screen.',
	'cancel-before-retry': 'Cancel the current request before selecting another host.',
	'invalid-state': 'That operation is not allowed in the current state.',
	'not-paired': 'No active read-only session.',
	'expired-or-revoked': 'The temporary grant expired or was revoked.',
};
let fixture,
	client,
	selected,
	connectedHost,
	viewHost,
	busy = false,
	metadata = '',
	notice = '',
	trustedKey,
	extraClients = [],
	renderedSnapshot = '';
let scenario = 'success';
const guides = {
	success: [
		'1. Request the selected LAN host.',
		'2. On HOST, approve showing a PIN.',
		'3. Type that PIN in Lite and verify.',
		'4. On HOST, confirm five-minute read-only access.',
	],
	errors: [
		'Request and approve a PIN.',
		'Enter a different six-digit value; retry remains available.',
		'Advance 121 seconds; the old PIN must fail.',
		'Refresh and retry to obtain a different request.',
	],
	network: [
		'Toggle LAN offline, then request it.',
		'Select the registered Tailscale fallback explicitly.',
		'Request and complete a fresh pairing.',
		'Change network generation; old access must be invalid.',
	],
	spoof: [
		'Add the spoofed Aster advertisement.',
		'Select its lookalike.example.test route.',
		'Check the synthetic saved Aster identity: it must reject.',
		'A bare discovery request goes to the impostor, not the legitimate HOST pane.',
	],
};
async function reset() {
	fixture = await demoFixtures();
	client = new PairingClient({ now: fixture.now });
	selected = fixture.catalog.list(fixture.now()).find((row) => row.source === 'lan').key;
	connectedHost = null;
	viewHost = fixture.aster;
	$('host-device').value = 'aster';
	metadata = '';
	notice = '';
	extraClients = [];
	trustedKey = fixture.aster.describe({
		endpoint: 'https://aster.local:8443',
		source: 'lan',
	}).hostKey;
	$('pin').value = '';
	$('error').textContent = '';
	$('trusted-status').textContent = '';
	render();
}
function route() {
	return fixture.catalog.select(selected, fixture.now());
}
function current() {
	return connectedHost ? client.view(connectedHost) : { phase: 'idle', request: null };
}
function details(target, pairs) {
	target.replaceChildren(
		...pairs.flatMap(([key, value]) => {
			const dd = text('dd', String(value ?? '—'));
			dd.dataset.field = key;
			return [text('dt', key), dd];
		})
	);
}
function snapshot() {
	return JSON.stringify([
		fixture.catalog.list(fixture.now()),
		current(),
		fixture.aster.hostScreen(),
		fixture.willow.hostScreen(),
	]);
}
function render() {
	if (!fixture) return;
	const state = current();
	if (['cancelled', 'expired', 'network-changed', 'locked'].includes(state.phase)) metadata = '';
	$('guide').replaceChildren(...guides[scenario].map((line) => text('p', line)));
	const rows = fixture.catalog.list(fixture.now());
	$('hosts').replaceChildren(
		...rows.map((row) => {
			const button = document.createElement('button');
			button.className = 'candidate';
			button.dataset.key = row.key;
			button.setAttribute('aria-pressed', String(selected === row.key));
			button.append(
				text('b', row.name),
				text('span', transport[row.source]),
				text('span', row.endpoint),
				text(
					'span',
					(fixture.offline.has(row.endpoint)
						? 'Synthetic offline'
						: row.reachability === 'peer-online'
							? 'Peer online; service unverified'
							: row.reachability) + ' · not trusted'
				)
			);
			button.onclick = () => {
				selected = row.key;
				$('error').textContent = '';
				$('trusted-status').textContent = '';
				render();
			};
			return button;
		})
	);
	$('client-status').textContent =
		notice ||
		(state.phase === 'paired'
			? 'Pairing succeeded — temporary read-only session.'
			: 'Pairing state: ' + state.phase);
	$('client-status').className = state.phase === 'paired' ? 'success' : '';
	details($('client-state'), [
		['Request', state.request?.requestId],
		['State', state.phase],
		['Scope', state.request?.scope ?? 'None'],
		['Guesses left', state.request?.guessesRemaining],
		[
			'Seconds left',
			state.request
				? Math.max(0, Math.ceil((state.request.expiresAt - fixture.now()) / 1000))
				: '—',
		],
		['Host key', state.hostKey ?? 'Unverified / not obtained'],
	]);
	$('metadata').textContent = metadata;
	const requests = viewHost.hostScreen();
	$('host-empty').hidden = requests.length > 0;
	$('host-title').textContent =
		(viewHost === fixture.aster ? 'Aster studio' : 'Willow lab') + ' approval';
	$('host-requests').replaceChildren(
		...requests.map((request) => {
			const panel = text('div', '', 'request');
			panel.append(text('h3', request.clientName));
			const fields = document.createElement('dl');
			details(fields, [
				['Request', request.requestId],
				['Route', request.endpoint],
				['State', request.state],
				['Scope', request.scope],
			]);
			panel.append(fields);
			const pin = text('div', request.pin ?? '—', 'pin');
			pin.dataset.pin = request.requestId;
			pin.setAttribute('aria-label', 'Host PIN for ' + request.clientName);
			panel.append(pin);
			const actions = text('div', '', 'actions');
			const approve = text('button', 'Approve and show PIN');
			approve.disabled = busy || request.state !== 'awaiting-host';
			approve.onclick = () => run(() => viewHost.approvePin(request.requestId));
			const confirm = text('button', 'Confirm read-only access');
			confirm.disabled = busy || request.state !== 'awaiting-confirmation';
			confirm.onclick = () =>
				run(async () => {
					viewHost.confirm(request.requestId);
					if (connectedHost === viewHost && current().request?.requestId === request.requestId) {
						await client.claim(connectedHost);
						metadata = 'Verified host: ' + (await client.read(connectedHost)).name;
					}
				});
			const cancel = text('button', 'Reject / cancel');
			cancel.onclick = () => run(() => viewHost.cancelLocally(request.requestId));
			actions.append(approve, confirm, cancel);
			panel.append(actions);
			return panel;
		})
	);
	$('request').disabled = busy || !selected;
	$('verify').disabled = busy || state.phase !== 'pin-issued';
	$('retry').disabled = busy;
	$('reset').disabled = busy;
	$('environment').textContent =
		'Network generation ' +
		fixture.catalog.epoch +
		' · all hosts and reachability fixtures are synthetic · no network access';
	renderedSnapshot = snapshot();
}
async function run(action) {
	if (busy) return;
	busy = true;
	notice = '';
	$('error').textContent = '';
	render();
	try {
		await action();
	} catch (error) {
		$('error').textContent = errors[error.code] ?? error.message;
	} finally {
		busy = false;
		render();
	}
}
async function cancel() {
	if (connectedHost) await client.cancel(connectedHost);
	metadata = '';
	$('pin').value = '';
	notice = 'Pairing cancelled. No access remains.';
	render();
}
async function request(expectedKey) {
	const selectedRoute = route();
	const host = fixture.hostFor(selectedRoute);
	const state = current();
	if (state.request && !['cancelled', 'expired', 'network-changed', 'locked'].includes(state.phase))
		throw Object.assign(new Error('cancel-before-retry'), { code: 'cancel-before-retry' });
	connectedHost = host;
	metadata = '';
	$('pin').value = '';
	await client.begin(host, selectedRoute, expectedKey);
}
$('refresh').onclick = () => run(() => fixture.refresh());
$('request').onclick = () => run(() => request());
$('cancel').onclick = () => {
	void cancel().catch((error) => {
		$('error').textContent = errors[error.code] ?? error.message;
	});
};
$('verify').onclick = () =>
	run(async () => {
		const pin = $('pin').value;
		$('pin').value = '';
		await client.attempt(connectedHost, pin);
	});
$('retry').onclick = () =>
	run(async () => {
		await cancel();
		fixture.refresh();
		client = new PairingClient({ now: fixture.now });
		notice = '';
		await request();
	});
$('expire').onclick = () => run(() => fixture.advance(121000));
$('offline').onclick = () =>
	run(() => {
		const endpoint = 'https://aster.local:8443';
		if (fixture.offline.has(endpoint)) fixture.offline.delete(endpoint);
		else fixture.offline.add(endpoint);
	});
$('network-change').onclick = () =>
	run(() => {
		fixture.networkChanged();
		metadata = '';
		$('pin').value = '';
	});
$('fallback').onclick = () =>
	run(async () => {
		await cancel();
		fixture.refresh();
		selected = fixture.catalog
			.list(fixture.now())
			.find((row) => row.source === 'tailscale' && row.id === 'aster-demo').key;
		client = new PairingClient({ now: fixture.now });
		connectedHost = null;
		notice = 'Registered Tailscale route selected. Request a NEW pairing; no PIN was forwarded.';
	});
$('spoof').onclick = () => run(() => fixture.addSpoof());
$('trusted').onclick = () =>
	run(async () => {
		const selectedRoute = route();
		const host = fixture.hostFor(selectedRoute);
		const actual = host.describe(selectedRoute).hostKey;
		if (actual !== trustedKey)
			throw Object.assign(new Error('host-identity-changed'), { code: 'host-identity-changed' });
		$('trusted-status').textContent =
			'Synthetic saved identity matches. Production saved connections still use their existing login and identity checks; this demo grants nothing.';
	});
$('second').onclick = () =>
	run(async () => {
		const other = new PairingClient({ name: 'Second demo Lite', now: fixture.now });
		const destination =
			viewHost === fixture.aster
				? { endpoint: 'https://aster.local:8443', source: 'lan' }
				: { endpoint: 'https://willow.example.test', source: 'cloudflare' };
		await other.begin(viewHost, { ...destination, epoch: fixture.catalog.epoch });
		extraClients.push(other);
	});
$('host-cancel').onclick = () =>
	run(() => {
		for (const item of viewHost.hostScreen()) viewHost.cancelLocally(item.requestId);
		metadata = '';
	});
$('host-device').onchange = () => {
	viewHost = fixture[$('host-device').value];
	render();
};
$('read').onclick = () =>
	run(async () => {
		metadata = 'Verified host: ' + (await client.read(connectedHost)).name;
	});
$('forbidden').onclick = () => run(() => client.read(connectedHost, 'agents.execute'));
$('reset').onclick = () => run(reset);
document.addEventListener('keydown', (event) => {
	if (event.key === 'Escape') {
		event.preventDefault();
		void cancel();
	}
});
for (const tab of document.querySelectorAll('[data-scenario]'))
	tab.onclick = () =>
		run(async () => {
			scenario = tab.dataset.scenario;
			for (const other of document.querySelectorAll('[data-scenario]'))
				other.setAttribute('aria-selected', String(other === tab));
			await reset();
		});
setInterval(() => {
	if (busy || !fixture) return;
	if (snapshot() !== renderedSnapshot) render();
	const request = current().request;
	const remaining = $('client-state').querySelector('[data-field="Seconds left"]');
	if (remaining)
		remaining.textContent = request
			? String(Math.max(0, Math.ceil((request.expiresAt - fixture.now()) / 1000)))
			: '—';
}, 1000);
void reset().catch((error) => {
	$('error').textContent = error.message;
});
