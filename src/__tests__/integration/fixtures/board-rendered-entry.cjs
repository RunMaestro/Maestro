// Executable fixture only. Never imports the general app index, demo, Cue or providers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const checkout = path.resolve(__dirname, '../../../..');
const binding = require(path.join(checkout, 'scripts/board-rendered-contract.cjs'));
const admission = require(path.join(checkout, 'dist/main/board/board-isolation.js'));

// The parent must pass a manifest argument AND the independently bound environment.
const manifestPath = process.argv[2];
const { manifest, contract, registrations, groups } = binding.admitRenderedFixture(
	manifestPath,
	checkout,
	admission,
	process.env
);
assert.equal(fs.realpathSync(process.cwd()), checkout);
assert.equal(fs.realpathSync(process.argv[1]), path.join(checkout, binding.entry));
assert.equal(fs.realpathSync(process.execPath), manifest.electron);
const flags = process.argv.slice(3);
for (const flag of flags)
	assert.ok(
		/^--remote-debugging-port=\d+$/.test(flag) ||
			flag === '--remote-debugging-address=127.0.0.1' ||
			[
				'--disable-background-networking',
				'--disable-component-update',
				'--disable-gpu',
				'--password-store=basic',
			].includes(flag),
		`Unexpected Electron argument: ${flag}`
	);
if (flags.some((flag) => flag.startsWith('--remote-debugging-port='))) {
	assert.ok(flags.includes('--remote-debugging-address=127.0.0.1'));
	const port = Number(
		flags.find((flag) => flag.startsWith('--remote-debugging-port=')).split('=')[1]
	);
	assert.ok(port > 0 && port <= 65535);
}
assert.match(process.env.DISPLAY ?? '', /^:\d+$/);
if (process.env.XAUTHORITY) admission.assertBoardIsolationPath(contract, process.env.XAUTHORITY);
const activeAddon = path.join(
	checkout,
	'node_modules/better-sqlite3/build/Release/better_sqlite3.node'
);
assert.equal(fs.realpathSync(activeAddon), activeAddon);
assert.equal(
	binding.sha(activeAddon),
	manifest.binaries[manifest.addon],
	'Select the bound Electron addon before launch'
);
// Each parent-authorized launch consumes its own nonce, never the first run's lock.
const runRoot = binding.renderedRunRoot(manifest);
fs.writeFileSync(path.join(runRoot, 'rendered-run.lock'), contract.identity, {
	flag: 'wx',
	mode: 0o600,
});

const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;
app.setPath('userData', contract.userData);
app.setPath('sessionData', contract.userData);
app.setPath('logs', path.join(contract.root, 'logs'));
app.disableHardwareAcceleration();
for (const flag of [
	'disable-background-networking',
	'disable-component-update',
	'disable-sync',
	'no-proxy-server',
])
	app.commandLine.appendSwitch(flag);
const record = {
	head: manifest.head,
	contract,
	denied: [],
	rendererErrors: [],
	ready: false,
	nativeAcceptance: false,
};
const output = path.join(runRoot, 'rendered-host.json');
let window;
let db;
let measurement;
let stopObserver;
let finished = false;
let creationHost;
let authorityHost;
const finish = (code, error) => {
	if (finished) return;
	finished = true;
	clearTimeout(deadline);
	stopObserver?.();
	authorityHost?.dispose();
	if (error) record.error = String(error.stack ?? error);
	measurement?.dispose();
	if (db?.open) {
		record.persistence = binding.persistenceSnapshot(db);
		db.close();
		record.databaseClosed = true;
	}
	fs.writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
	app.exit(code);
};
const deadline = setTimeout(
	() => finish(1, new Error('Owned rendered fixture exceeded 240s')),
	240000
);
process.on('uncaughtException', (error) => finish(1, error));
process.on('unhandledRejection', (error) => finish(1, error));
const { installRenderedBoundary } = require(
	path.join(checkout, 'scripts/board-rendered-boundary.cjs')
);
const boundary = installRenderedBoundary(
	electron,
	(event, requireOwner = true) => {
		if (creationHost) creationHost.validate();
		else binding.assertRenderedRegistries(manifest, admission);
		assert.ok(window && !window.isDestroyed());
		if (requireOwner) {
			assert.equal(event.sender, window.webContents);
			assert.equal(event.senderFrame, window.webContents.mainFrame);
		}
	},
	record,
	{
		executable: manifest.git,
		sha256: manifest.binaries[manifest.git],
		roots: registrations.sources.map((source) => source.root),
		path: manifest.env.PATH,
		home: contract.root,
	},
	manifest.creation
		? { beforeRegister: (options) => creationHost.beforeRegister(options) }
		: undefined,
	!!manifest.authority
);
app.on('session-created', (created) => boundary.secureSession(created));

async function main() {
	admission.assertBoardIsolationBootstrap(contract);
	const stores = require(path.join(checkout, 'dist/main/stores/instances.js'));
	stores.initializeStores({ productionDataPath: contract.userData });
	const instances = stores.getStoreInstances();
	assert.equal(instances.sessionsStore.path, contract.agentRegistry);
	assert.deepEqual(instances.sessionsStore.get('sessions'), registrations.sessions);
	assert.deepEqual(instances.groupsStore.get('groups'), groups);
	const settings = instances.settingsStore.get('encoreFeatures');
	assert.ok(
		Object.entries(settings).every(
			([key, value]) =>
				value === (key === 'board' || (key === 'maestroCue' && !!manifest.authority))
		)
	);
	assert.deepEqual(instances.settingsStore.get('sshRemotes'), []);
	const sources = require(path.join(checkout, 'dist/main/board/board-source-host.js'));
	const appendAgent = sources.configureIsolatedBoardSourceHost(contract, manifest.creation);
	const storage = require(path.join(checkout, 'dist/main/board/board-storage.js'));
	const previousState = manifest.reopen
		? binding.verifiedPreviousLaunch(contract.root, checkout, admission).host.persistence
		: undefined;
	db = require(path.join(checkout, 'dist/main/board/board-db.js')).openBoardDb(contract.db);
	if (previousState) assert.deepEqual(binding.persistenceSnapshot(db), previousState);
	const facade = new storage.BoardStorageFacade(db);
	storage.configureBoardStorage(facade);
	storage.configureBoardCaptureHost(() => ({
		agents: instances.sessionsStore.get('sessions'),
		groups: instances.groupsStore.get('groups'),
	}));
	storage.configureBoardReadinessHost(() => ({ dispatchEnabled: false, agentStates: {} }));
	storage.initializeBoardWorkspace();
	await sources.refreshBoardSources();
	if (previousState) {
		assert.deepEqual(
			binding.persistenceSnapshot(db),
			previousState,
			'Reopen changed persisted data or reimported sources'
		);
		record.persistenceVerified = true;
	}
	const catalog = facade.captureCatalog();
	record.counts = {
		agents: catalog.agents.length,
		groups: catalog.groups.length,
		sources: db.prepare('SELECT count(*) AS n FROM board_source_locations').get().n,
		repositories: catalog.repositories.length,
		cards: db.prepare('SELECT count(*) AS n FROM cards').get().n,
	};
	assert.deepEqual(record.counts, {
		agents: 100,
		groups: 20,
		sources: 50,
		repositories: 50,
		cards:
			previousState?.tables.cards.length ??
			JSON.parse(fs.readFileSync(path.join(contract.root, 'prepared.json'))).counts.cards,
	});
	assert.equal(
		db.prepare('SELECT count(*) AS n FROM workers').get().n,
		previousState?.tables.workers.length ?? 0
	);
	assert.equal(
		db.prepare('SELECT count(*) AS n FROM runs').get().n,
		previousState?.tables.runs.length ?? 0
	);
	await app.whenReady();
	boundary.secureSession(electron.session.defaultSession);
	window = new BrowserWindow({
		width: 1280,
		height: 900,
		show: true,
		webPreferences: {
			preload: path.join(checkout, binding.preload),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
			spellcheck: false,
		},
	});
	window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	window.webContents.on('will-navigate', (event) => event.preventDefault());
	window.webContents.on('will-attach-webview', (event) => event.preventDefault());
	window.webContents.on('render-process-gone', (_event, details) =>
		finish(1, new Error(JSON.stringify(details)))
	);
	window.webContents.on('preload-error', (_event, file, error) =>
		finish(1, new Error(`${file}: ${error}`))
	);
	window.webContents.on('console-message', (_event, details) => {
		if (details.level === 'error') record.rendererErrors.push(details.message);
	});
	window.on('closed', () => finish(0));
	const { registerBoardHandlers } = require(path.join(checkout, 'dist/main/ipc/handlers/board.js'));
	registerBoardHandlers({ getMainWindow: () => window, getCueEngine: () => null });
	ipcMain.handle('sessions:getAll', () => instances.sessionsStore.get('sessions'));
	ipcMain.handle('groups:getAll', () => instances.groupsStore.get('groups'));
	if (manifest.creation) {
		creationHost = require(
			path.join(checkout, 'scripts/board-rendered-creation.cjs')
		).installCreationFixture({
			ipcMain,
			manifest,
			admission,
			instances,
			appendAgent,
			record,
			db,
			flushPendingSessionWritesSync: stores.flushPendingSessionWritesSync,
		});
	}
	if (manifest.authority) {
		authorityHost = await require(
			path.join(checkout, 'scripts/board-rendered-authority.cjs')
		).installAuthorityFixture({ manifest, admission, facade, instances, window, record });
	}
	const uiPreferences = {};
	ipcMain.handle('settings:getAll', () => ({ ...instances.settingsStore.store, ...uiPreferences }));
	// Only UI size preferences can be written by the fixture shell. Registry/config writes fail closed.
	ipcMain.handle('settings:set', (_event, key, value) => {
		assert.ok(
			['modalSizes', 'modalPositions'].includes(key),
			`Fixture setting is read-only: ${key}`
		);
		uiPreferences[key] = value;
	});
	ipcMain.handle('logger:log', (_event, level, message) => {
		if (level === 'error') record.rendererErrors.push(message);
	});
	ipcMain.handle('logger:getLogLevel', () => 'error');
	ipcMain.handle('logger:getMaxLogBuffer', () => 1000);
	// Keep fixture notifications inside the owned process, without host OS side effects.
	ipcMain.handle('notification:show', () => ({
		success: false,
		error: 'Fixture notifications disabled',
	}));
	storage.setBoardSavedListener((projectRoot) => {
		if (!window.isDestroyed()) window.webContents.send('board:changed', { projectRoot });
	});
	measurement = require(
		path.join(checkout, 'scripts/board-performance-host.cjs')
	).installBoardHostMeasurement(ipcMain, () => performance.now());
	// Main-process CDP/Playwright observers may read measurements; no test API is added to preload.
	process.boardRenderedFixture = { record, measurement, finish };
	stopObserver = require(
		path.join(checkout, 'scripts/board-rendered-observer.cjs')
	).startRenderedObserver(runRoot, measurement, finish);
	await window.loadFile(path.join(checkout, binding.renderer));
	record.ready = true;
	fs.writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
}

main().catch((error) => finish(1, error));
