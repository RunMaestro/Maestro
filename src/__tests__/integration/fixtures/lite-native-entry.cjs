const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, session } = require('electron');
const nativeDialog = require('electron').dialog;
const realMessageBox = nativeDialog.showMessageBox.bind(nativeDialog);
const prompts = [];
let nativePromptUsed = false;
nativeDialog.showMessageBox = (parent, options) => {
	const entry = { options, completed: false };
	prompts.push(entry);
	if (process.env.MAESTRO_LITE_NATIVE_PROMPT === '1' && !nativePromptUsed) {
		nativePromptUsed = true;
		entry.native = true;
		console.log('NATIVE_PAIRING_PROMPT_READY ' + process.pid);
		return realMessageBox(parent, options).finally(() => {
			entry.completed = true;
		});
	}
	return new Promise((resolve) => {
		entry.answer = (response) => {
			entry.completed = true;
			resolve({ response, checkboxChecked: false });
		};
		const abort = () => entry.answer(0);
		if (options.signal.aborted) abort();
		else options.signal.addEventListener('abort', abort, { once: true });
	});
};

const [directory, application] = process.argv.slice(2);
assert(directory && application);
const dist = path.join(application, 'dist'),
	liteDirectory = path.join(directory, 'lite');
fs.mkdirSync(liteDirectory, { recursive: true });
app.setPath('userData', path.join(directory, 'host'));
app.setPath('sessionData', path.join(directory, 'host'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
process.argv.push('--lite-user-data', liteDirectory, '--lite');
const effects = {
	externalNetwork: 0,
	providerMutations: 0,
	multicast: 0,
	ssh: 0,
	unexpectedUrls: 0,
};
const fail = (key) => {
	effects[key]++;
	throw new Error('Forbidden isolated effect: ' + key);
};
const http = require('node:http'),
	https = require('node:https'),
	net = require('node:net');
const originalRequest = http.request,
	originalListen = net.Server.prototype.listen,
	originalConnect = net.Socket.prototype.connect;
const allowedPorts = new Set();
net.Server.prototype.listen = function (...args) {
	const host = typeof args[0] === 'object' ? args[0]?.host : args[1];
	const direct = host === HOST && args[0] === 56036;
	if (direct) args = [0, '127.0.0.1', args[2]];
	else if (host !== '127.0.0.1') return fail('externalNetwork');
	this.once('listening', () => {
		const port = this.address().port;
		allowedPorts.add(port);
		if (direct) backendPort = port;
		this.once('close', () => allowedPorts.delete(port));
	});
	return originalListen.apply(this, args);
};
net.Socket.prototype.connect = function (...args) {
	const option = Array.isArray(args[0]) ? args[0][0] : args[0];
	const host =
		typeof option === 'object' ? option.host : typeof args[1] === 'string' ? args[1] : undefined;
	if (host !== '127.0.0.1' && host !== 'localhost') return fail('externalNetwork');
	return originalConnect.apply(this, args);
};
require('node:dgram').Socket.prototype.bind = () => fail('multicast');
require('node:tls').connect = () => fail('externalNetwork');
https.request = () => fail('externalNetwork');
const HOST = '100.64.0.10',
	CLIENT = '100.64.0.20',
	origin = 'http://' + HOST + ':56036',
	CONNECT = '/.well-known/maestro/connect';
let backendPort, owner, host, lite, hostShell;
const fixture = {
	online: true,
	identity: 'host-node',
	node: 'client-node',
	remoteIdentity: 'aster-id',
	backendPort: 56036,
};
const status = (selfIsHost = false) => ({
	BackendState: fixture.online ? 'Running' : 'Stopped',
	Self: {
		ID: selfIsHost ? fixture.identity : fixture.node,
		Online: true,
		DNSName: selfIsHost ? 'aster.synthetic.ts.net' : 'lite.synthetic.ts.net',
		TailscaleIPs: [selfIsHost ? HOST : CLIENT],
	},
	CurrentTailnet: { MagicDNSSuffix: 'synthetic.ts.net' },
	Peer: {
		other: {
			ID: selfIsHost ? fixture.node : fixture.identity,
			Online: true,
			DNSName: selfIsHost ? 'lite.synthetic.ts.net' : 'aster.synthetic.ts.net',
			TailscaleIPs: [selfIsHost ? CLIENT : HOST],
		},
	},
});
const originals = Module._load;
const mocks = new Map();
mocks.set('node:os', {
	...require('node:os'),
	hostname: () => 'TEST-ONLY-LAPTOP',
	networkInterfaces: () => ({ tail: [{ address: HOST }, { address: CLIENT }] }),
});
mocks.set('node:child_process', {
	...require('node:child_process'),
	execFile: (_file, args, options, callback) => {
		const { EventEmitter } = require('node:events');
		const child = new EventEmitter();
		queueMicrotask(() => {
			if (JSON.stringify(args) === '["status","--json"]')
				callback(null, JSON.stringify(status()), '');
			else if (JSON.stringify(args) === '["service","list","--json"]') callback(null, '[]', '');
			else fail('providerMutations');
		});
		return child;
	},
});
mocks.set('node:http', {
	...http,
	request: (url, options, callback) => {
		const target = new URL(url);
		if (target.origin !== origin) return fail('externalNetwork');
		assert.equal(options.hostname, HOST);
		assert.equal(options.port, 56036);
		assert.equal(options.localAddress, CLIENT);
		// The only substituted boundary is the remote tailnet socket. Production HTTP/WS relay and headers run unchanged.
		return originalRequest(
			'http://127.0.0.1:' + backendPort + target.pathname + target.search,
			{
				...options,
				hostname: '127.0.0.1',
				port: backendPort,
				localAddress: '127.0.0.1',
				headers: { ...options.headers, host: new URL(origin).host },
			},
			callback
		);
	},
});
mocks.set(path.join(dist, 'main/lite/control-server.js'), {
	startLiteControlServer: async () => ({ close: async () => {} }),
});
mocks.set(path.join(dist, 'main/utils/ssh-config-parser.js'), {
	parseSshConfig: () => ({ hosts: [] }),
});
mocks.set(path.join(dist, 'main/lite/tunnel.js'), { openTunnel: () => fail('ssh') });
mocks.set(path.join(dist, 'main/lite/discovery/interfaces.js'), {
	availableLanInterfaces: () => [],
});
// External multicast provider is absent; direct peer discovery is real production code.
mocks.set(path.join(dist, 'main/lite/discovery/mdns.js'), {
	MdnsBrowser: class {
		async start() {}
		stop() {}
	},
});
mocks.set(path.join(dist, 'main/utils/logger.js'), {
	logger: { info() {}, warn() {}, error() {}, debug() {} },
});
mocks.set(path.join(dist, 'main/utils/sentry.js'), { captureException() {} });
mocks.set(path.join(dist, 'main/stores/getters.js'), {
	getSettingsStore: () => ({ get: (_key, fallback) => fallback }),
});
mocks.set(path.join(dist, 'main/web-server/auth/web-user-store.js'), {
	getWebUserStore: () => ({ resolveSession: () => undefined }),
});
const crypto = require('node:crypto'),
	key = crypto.randomBytes(32),
	electron = Object.create(require('electron'));
Object.defineProperty(electron, 'safeStorage', {
	value: {
		isEncryptionAvailable: () => true,
		getSelectedStorageBackend: () => 'fixture-encrypted',
		encryptString(text) {
			const iv = crypto.randomBytes(12),
				cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
			return Buffer.concat([
				iv,
				Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]),
				cipher.getAuthTag(),
			]);
		},
		decryptString(bytes) {
			const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
			decipher.setAuthTag(bytes.subarray(-16));
			return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString(
				'utf8'
			);
		},
	},
});
mocks.set('electron', electron);
Module._load = function (request, parent, isMain) {
	const target = Module._resolveFilename(request, parent, isMain);
	return mocks.has(target) ? mocks.get(target) : originals.call(this, request, parent, isMain);
};
const actualTailnet = require(path.join(dist, 'main/lite/tailnet.js'));
// Two machines share this isolated process: the host daemon snapshot is separate from the client daemon snapshot.
mocks.set(path.join(dist, 'main/lite/tailnet.js'), {
	...actualTailnet,
	readTailnet: async () => actualTailnet.parseTailnetState(JSON.stringify(status(true))),
});
const configured = new Set();
function configure(s) {
	if (configured.has(s)) return;
	configured.add(s);
	s.registerPreloadScript({
		type: 'frame',
		filePath: path.join(__dirname, 'lite-native-probe.cjs'),
	});
	s.webRequest.onBeforeRequest((details, callback) => {
		const u = new URL(details.url);
		const allowed =
			['data:', 'about:', 'devtools:'].includes(u.protocol) ||
			(['http:', 'ws:'].includes(u.protocol) &&
				u.hostname === '127.0.0.1' &&
				allowedPorts.has(Number(u.port)));
		if (!allowed) effects.unexpectedUrls++;
		callback({ cancel: !allowed });
	});
}
app.on('session-created', configure);
const cases = [],
	screens = new Set();
const check = (name) => {
	cases.push(name);
	console.log('NATIVE_CASE ' + name);
};
const js = (contents, code) => contents.executeJavaScript(code, true);
const invoke = (contents, channel, action, payload) =>
	js(
		contents,
		'window.__nativeProbe.invoke(' +
			JSON.stringify(channel) +
			',' +
			JSON.stringify(action) +
			',' +
			JSON.stringify(payload) +
			')'
	);
const click = (contents, selector) =>
	js(
		contents,
		'(() => { const selector = ' +
			JSON.stringify(selector) +
			'; const element = document.querySelector(selector); if (!element || element.disabled || element.closest("[hidden]") || !element.getClientRects().length || getComputedStyle(element).visibility === "hidden") throw new Error("Control is not actionable: " + selector); element.click(); })()'
	);
const fill = (contents, selector, value) =>
	js(
		contents,
		'document.querySelector(' + JSON.stringify(selector) + ').value=' + JSON.stringify(value)
	);
const state = async () => (await invoke(lite.webContents, 'lite:control', 'status')).value.state;
async function until(predicate, label, timeout = 18000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const result = await predicate();
		if (result) return result;
		await delay(40);
	}
	throw new Error('Timed out: ' + label + ' ' + JSON.stringify(lite ? await state() : {}));
}
async function capture(window, name) {
	if (!process.env.MAESTRO_LITE_TEST_ARTIFACTS || screens.has(name)) return;
	screens.add(name);
	window.show();
	window.focus();
	await js(
		window.webContents,
		'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'
	);
	fs.mkdirSync(process.env.MAESTRO_LITE_TEST_ARTIFACTS, { recursive: true });
	fs.writeFileSync(
		path.join(process.env.MAESTRO_LITE_TEST_ARTIFACTS, name + '.png'),
		(await window.webContents.capturePage()).toPNG()
	);
}
async function captureNarrow(window, name) {
	if (!process.env.MAESTRO_LITE_TEST_ARTIFACTS) return;
	const size = window.getContentSize();
	const zoom = window.webContents.getZoomFactor();
	try {
		window.setContentSize(680, 680);
		window.webContents.setZoomFactor(1.25);
		await capture(window, name + '-narrow-125pct');
	} finally {
		window.webContents.setZoomFactor(zoom);
		window.setContentSize(...size);
	}
}
async function approveCurrent() {
	if (host && !host.isDestroyed()) {
		await click(host.webContents, '#close');
		await until(() => host.isDestroyed(), 'closed setup before request');
	}
	const beforePrompt = prompts.length;
	const ids = new Set(hostShell.host.localRequests().map((r) => r.requestId));
	await click(lite.webContents, '[data-host-key]:not([disabled])');
	const request = await until(
		() =>
			hostShell.host
				.localRequests()
				.find((r) => r.state === 'awaiting-host' && !ids.has(r.requestId)),
		'new pairing request'
	);
	const popup = await until(() => prompts[beforePrompt], 'automatic desktop prompt');
	assert(popup.options.message.includes(require('node:os').hostname()));
	assert.equal(request.clientName, require('node:os').hostname().slice(0, 64));
	assert.equal(
		hostShell.host.localRequests().find((r) => r.requestId === request.requestId).pin,
		undefined
	);
	await until(
		async () => (await state()).discoveryPairing.pairing.phase === 'awaiting-host',
		'host-prompt wait state'
	);
	await capture(lite, '02b-waiting-for-host');
	if (popup.native) await until(() => popup.completed, 'interactive native Confirm', 90000);
	else popup.answer(1);
	await until(
		() =>
			hostShell.host
				.localRequests()
				.some((r) => r.requestId === request.requestId && r.state === 'pin-issued'),
		'confirmed code issuance'
	);
	host = await until(
		() => BrowserWindow.getAllWindows().find((w) => w !== owner && w !== lite),
		'automatically opened host code window'
	);
	await until(() => js(host.webContents, '!!window.__nativeProbe'), 'automatic host preload');
	const selector = '#requests article[data-request-id="' + request.requestId + '"]';
	const code = await until(
		() =>
			js(
				host.webContents,
				'document.querySelector(' + JSON.stringify(selector + ' pre') + ')?.textContent'
			),
		'host code'
	);
	assert.match(code, /^\d{6}$/);
	assert.equal(
		await js(
			host.webContents,
			'document.querySelector("#direct-panel").hidden && document.querySelector("#manage-page").hidden && document.querySelector("#waiting-step").hidden'
		),
		true
	);
	await capture(host, '02a-confirmed-pairing-code');
	await captureNarrow(host, '02a-confirmed-pairing-code');
	check(
		'named incoming request prompts automatically with setup closed; Confirm reveals only its code'
	);
	await until(
		async () => (await state()).discoveryPairing.pairing.phase === 'pin-issued',
		'client code field'
	);
	assert.equal(
		await js(
			lite.webContents,
			'document.querySelector("#discovery-panel").hidden && document.querySelector("#manual-connections").hidden && document.querySelector("#guide-options").hidden'
		),
		true
	);
	await capture(lite, '02c-enter-code');
	await captureNarrow(lite, '02c-enter-code');
	await fill(lite.webContents, '#pair-pin', code);
	await click(lite.webContents, '#pair-submit');
	await until(
		() =>
			hostShell.host
				.localRequests()
				.some((r) => r.requestId === request.requestId && r.state === 'awaiting-confirmation'),
		'verified proof'
	);
	await until(
		() =>
			js(
				host.webContents,
				'document.querySelector(' +
					JSON.stringify(selector + ' button[data-focus-key$=":confirm"]') +
					')?.disabled === false'
			),
		'final host consent'
	);
	await capture(host, '02-device-approval');
	await click(host.webContents, selector + ' button[data-focus-key$=":confirm"]');
}
async function main() {
	await app.whenReady();
	configure(session.defaultSession);
	const Fastify = require('fastify'),
		websocket = require('@fastify/websocket');
	const api = Fastify({ logger: false });
	await api.register(websocket);
	api.addHook('onRequest', async (request) => {
		Object.defineProperties(request.raw.socket, {
			localAddress: { get: () => HOST, configurable: true },
			remoteAddress: { get: () => CLIENT, configurable: true },
		});
	});
	const { HostPairingWindow } = require(path.join(dist, 'main/lite/pairing/host-window.js'));
	owner = new BrowserWindow({
		title: 'Isolated Maestro pairing test',
		show: false,
		webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
	});
	const options = {
		name: 'Synthetic Aster',
		appVersion: require(path.join(application, 'package.json')).version,
		backendPort: () => fixture.backendPort,
		endpoints: () => [],
		parent: () => owner,
		listenTailnet: (address) =>
			require(path.join(dist, 'main/lite/tailnet-listener.js')).listenTailnet(api, address),
	};
	hostShell = new HostPairingWindow();
	await hostShell.open(owner, 'aster-id', options);
	host = BrowserWindow.getAllWindows().find((w) => w !== owner);
	await until(() => js(host.webContents, '!!window.__nativeProbe'), 'host preload');
	require(path.join(dist, 'main/lite/pairing/routes.js')).registerPairingRoutes(
		api,
		() => hostShell.host,
		() => true,
		options.appVersion
	);
	const { ApiRoutes } = require(path.join(dist, 'main/web-server/routes/apiRoutes.js'));
	const { WsRoute } = require(path.join(dist, 'main/web-server/routes/wsRoute.js'));
	const web = path.join(directory, 'workload');
	fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
	fs.writeFileSync(
		path.join(web, 'index.html'),
		'<!doctype html><html><head><title>Isolated workload over real relay</title></head><body><h1>Paired fixture workload</h1><p id="transport">Connecting actual WebSocket…</p><script src="./assets/workload.js"></script></body></html>'
	);
	fs.writeFileSync(
		path.join(web, 'assets/workload.js'),
		'window.__MAESTRO_BRIDGE_STATE__="connecting";const socket=new WebSocket(location.origin.replace("http:","ws:")+"' +
			CONNECT +
			'/ws");socket.onopen=()=>{window.__MAESTRO_BRIDGE_STATE__="connected";document.querySelector("#transport").textContent="Actual HTTP and WebSocket through private relay";};socket.onclose=()=>window.__MAESTRO_BRIDGE_STATE__="disconnected";'
	);
	const apiRoutes = new ApiRoutes('test-legacy', {
		max: 100,
		maxPost: 100,
		enabled: false,
		timeWindow: 60000,
	});
	apiRoutes.setCallbacks({
		getSessions: () => [],
		getSessionDetail: () => null,
		getTheme: () => null,
		writeToSession: () => false,
		interruptSession: async () => false,
		getHistory: () => [],
		getLiveSessionInfo: () => undefined,
		isSessionLive: () => false,
	});
	const wsRoute = new WsRoute('test-legacy');
	wsRoute.setCallbacks({
		getBionifyReadingMode: () => false,
		getSessions: () => [],
		getTheme: () => null,
		getCustomCommands: () => [],
		getAutoRunStates: () => new Map(),
		getLiveSessionInfo: () => undefined,
		isSessionLive: () => false,
		onClientConnect() {},
		onClientDisconnect() {},
		onClientError() {},
		handleMessage() {},
	});
	require(
		path.join(dist, 'main/web-server/routes/liteConnectionRoutes.js')
	).registerLiteConnectionRoutes(api, {
		getHost: () => hostShell.host,
		webDesktopPath: web,
		webAssetsPath: web,
		apiRoutes,
		wsRoute,
		getHostStatus: async () => ({
			instanceId: fixture.remoteIdentity,
			hostName: 'Synthetic Aster',
			appVersion: options.appVersion,
			platform: process.platform,
			ready: true,
			capabilities: { sessions: true, terminal: true, files: true, browserRelay: true },
		}),
	});
	await api.listen({ port: 0, host: '127.0.0.1' });
	backendPort = api.server.address().port;
	await until(async () => {
		const v = (await invoke(host.webContents, 'litePairing:local', 'state')).value;
		return v.direct.origin;
	}, 'read-only direct readiness');
	const denied = await invoke(host.webContents, 'litePairing:local', 'enable-direct', {
		consent: false,
	});
	assert.match(denied.error, /consent/);
	assert.equal(hostShell.host, undefined);
	check('native direct access requires explicit local consent and performs no provider mutation');
	await until(
		() => js(host.webContents, '!document.querySelector("#enable-direct").disabled'),
		'actionable direct access button'
	);
	await capture(host, '00-host-access-off');
	await click(host.webContents, '#direct-consent');
	await click(host.webContents, '#enable-direct');
	await until(() => !!hostShell.host, 'direct access enabled');
	await until(
		() => js(host.webContents, '!document.querySelector("#waiting-step").hidden'),
		'guided host waiting step'
	);
	assert.equal(
		await js(
			host.webContents,
			'document.querySelector("#manage-page").hidden && document.querySelector("#attended-options").hidden && document.querySelector("#updates").hidden'
		),
		true
	);
	await capture(host, '01-direct-access-enabled');
	await click(host.webContents, '#manage-access');
	await capture(host, '01a-manage-access');
	await click(host.webContents, '#open-https');
	assert.equal(
		await js(
			host.webContents,
			'document.querySelector("#manage-page").hidden && !document.querySelector("#attended-options").hidden'
		),
		true
	);
	await click(host.webContents, '#back');
	await click(host.webContents, '#back');
	check(
		'guided host and Lite navigation show one task at a time and keep secondary settings separate'
	);
	await click(host.webContents, '#close');
	await until(() => host.isDestroyed(), 'setup close');
	assert(hostShell.host);
	await hostShell.close();
	fixture.backendPort = 54321;
	hostShell = new HostPairingWindow();
	await hostShell.initialize('aster-id', options);
	assert(hostShell.host);
	await hostShell.open(owner, 'aster-id', options);
	host = BrowserWindow.getAllWindows().find((w) => w !== owner);
	await until(() => js(host.webContents, '!!window.__nativeProbe'), 'reopened preload');
	check(
		'closing setup and restarting host module retain consent and direct access without Serve or an advertisement'
	);
	const unauthorized = await api.inject({
		url: CONNECT + '/api/lite/handshake',
		headers: { host: new URL(origin).host },
	});
	assert.equal(unauthorized.statusCode, 403);
	check('direct host rejects unpaired HTTP even though discovery is available');
	await require(path.join(dist, 'main/lite/index.js')).startLite();
	lite = BrowserWindow.getAllWindows().find((w) => w !== owner && w !== host);
	await until(() => js(lite.webContents, '!!window.__nativeProbe'), 'Lite preload');
	await capture(lite, '00-lite-find-computer');
	await click(lite.webContents, '#guide-help');
	await click(lite.webContents, '#discovery-manual');
	await fill(lite.webContents, '#url', 'https://draft.example/desktop');
	await click(lite.webContents, '#guide-back');
	await click(lite.webContents, '#discovery-manual');
	assert.equal(
		await js(lite.webContents, 'document.querySelector("#url").value'),
		'https://draft.example/desktop'
	);
	await click(lite.webContents, '#guide-back');
	await click(lite.webContents, '#guide-back');
	assert.equal(
		await js(lite.webContents, 'document.querySelector("#manual-connections").hidden'),
		true
	);
	await click(lite.webContents, '#discovery-tailnet');
	await until(
		async () =>
			(await state()).discoveryPairing.discovery.candidates.some(
				(r) => r.availability === 'ready' && r.endpoint === origin
			),
		'direct peer discovery'
	);
	assert.deepEqual((await state()).profiles, []);
	check(
		'native Lite discovers a verified direct peer without a URL, saved profile, named Service or TLS certificate'
	);
	await capture(lite, '01-discovered-computer');
	await approveCurrent();
	await until(
		async () => (await state()).status.startsWith('connected'),
		'paired workload via HTTP and WebSocket'
	);
	let remote = lite.contentView.children[0].webContents;
	assert.equal(new URL(remote.getURL()).hostname, '127.0.0.1');
	assert.equal(await js(remote, 'isSecureContext'), true);
	assert.equal(await js(remote, 'typeof require'), 'undefined');
	assert.equal(
		(await invoke(remote, 'litePairing:local', 'state')).error.includes('Host-local'),
		true
	);
	await capture(lite, '03-connected-lite');
	fs.writeFileSync(
		path.join(process.env.MAESTRO_LITE_TEST_ARTIFACTS || directory, '03-connected-workload.png'),
		(await remote.capturePage()).toPNG()
	);
	check(
		'production Lite PIN approval opens actual HTTP/WebSocket relay with a secure browser context and no account login'
	);
	const credentialPath = path.join(liteDirectory, 'lite-device-credentials.json');
	const credentialBytes = fs.readFileSync(credentialPath, 'utf8');
	assert(!credentialBytes.includes('"credential":'));
	await invoke(lite.webContents, 'lite:control', 'reconnect');
	await until(async () => (await state()).status.startsWith('connected'), 'remembered reconnect');
	assert.equal(hostShell.host.devices.list('aster-id').length, 1);
	await until(
		() => js(host.webContents, '!document.querySelector("#manage-access").hidden'),
		'pairing complete navigation'
	);
	await capture(host, '03a-pairing-complete');
	host.close();
	await until(() => host.isDestroyed(), 'finished pairing window closes');
	await hostShell.open(owner, 'aster-id', options);
	host = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Connect another device');
	await until(() => js(host.webContents, '!!window.__nativeProbe'), 'reopened host preload');
	await until(
		() => js(host.webContents, '!document.querySelector("#waiting-step").hidden'),
		'reopened guide starts a new connection, not an old completion'
	);
	assert.equal(hostShell.host.devices.list('aster-id').length, 1);
	check('reopening the completed guide waits for another device without removing existing pairing');
	await click(host.webContents, '#manage-access');
	await capture(host, '03b-paired-device-management');
	await click(host.webContents, '[data-focus-key$=":remove"]');
	await js(host.webContents, 'window.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}))');
	assert.equal(
		await js(
			host.webContents,
			'!document.querySelector("#manage-page").hidden && document.activeElement.dataset.focusKey.endsWith(":remove")'
		),
		true
	);
	assert.equal(hostShell.host.devices.list('aster-id').length, 1);
	check(
		'Escape cancels device removal, preserves pairing and returns focus without leaving management'
	);
	check('remembered device reconnects through scoped credential headers without a second code');
	await click(host.webContents, '#disable-direct');
	await until(async () => !(await state()).canReturn, 'disabled direct connection closes');
	assert.equal(hostShell.host, undefined);
	await invoke(host.webContents, 'litePairing:local', 'enable-direct', { consent: true });
	await invoke(lite.webContents, 'lite:control', 'reconnect');
	await until(
		async () => (await state()).status.startsWith('connected'),
		're-enabled remembered device'
	);
	check('explicit disable closes direct access without deleting remembered device authorization');
	const device = hostShell.host.devices.list('aster-id')[0];
	await invoke(host.webContents, 'litePairing:local', 'revoke-device', { id: device.id });
	await until(async () => !(await state()).canReturn, 'device revoke closes connection');
	await invoke(lite.webContents, 'lite:control', 'reconnect');
	await until(
		async () => (await state()).status === 'Connection failed',
		'revoked credential rejected'
	);
	check('persisted host revocation rejects remembered credentials and closes the native client');
	await invoke(lite.webContents, 'lite:control', 'pair-forget');
	await click(lite.webContents, '#discovery-start');
	await until(
		() => js(lite.webContents, '!!document.querySelector("[data-host-key]:not([disabled])")'),
		'pairable host after forgetting'
	);
	await click(lite.webContents, '[data-host-key]:not([disabled])');
	await until(
		async () => (await state()).discoveryPairing.pairing.phase === 'awaiting-host',
		'cancelable request'
	);
	await click(lite.webContents, '#pair-cancel');
	assert.equal(hostShell.host.devices.list('aster-id').length, 0);
	check('cancellation before host approval creates no persistent device');
	for (const window of [host, lite]) {
		const prefs = window.webContents.getLastWebPreferences();
		assert.equal(prefs.sandbox, true);
		assert.equal(prefs.contextIsolation, true);
		assert.equal(prefs.nodeIntegration, false);
	}
	assert((await invoke(lite.webContents, 'litePairing:local', 'state')).error);
	assert((await invoke(host.webContents, 'lite:control', 'status')).error);
	check('foreign-window IPC remains denied and local UI windows remain sandboxed');
	const { PairedDevices } = require(path.join(dist, 'main/lite/pairing/paired-devices.js'));
	const restartedDevices = new PairedDevices(path.join(directory, 'host'));
	await restartedDevices.load();
	assert.equal(restartedDevices.list('aster-id').length, 0);
	const snapshot = hostShell.host;
	fixture.online = false;
	await invoke(host.webContents, 'litePairing:local', 'inspect');
	assert.equal(hostShell.host, undefined);
	fixture.online = true;
	await invoke(host.webContents, 'litePairing:local', 'inspect');
	assert(hostShell.host);
	assert.notEqual(hostShell.host, snapshot);
	check(
		'offline provider closes access and restores only after local-daemon verification without changing Tailscale settings'
	);
	await invoke(lite.webContents, 'lite:control', 'disconnect');
	await invoke(host.webContents, 'litePairing:local', 'disable-direct');
	await hostShell.close();
	await api.close();
	assert.deepEqual(effects, {
		externalNetwork: 0,
		providerMutations: 0,
		multicast: 0,
		ssh: 0,
		unexpectedUrls: 0,
	});
	console.log(
		'LITE_NATIVE_RESULT ' +
			JSON.stringify({
				electron: process.versions.electron,
				application,
				executable: process.execPath,
				packagedRuntime: app.isPackaged,
				packageVersion: options.appVersion,
				cases,
				effects,
				transport:
					'actual isolated HTTP/WebSocket relay; external Tailscale socket and OS credential provider mocked',
				credentialsCreated: false,
			})
	);
	app.quit();
}
main().catch((error) => {
	console.error(error.stack || error);
	process.exit(1);
});
