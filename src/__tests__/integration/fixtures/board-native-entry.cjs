// Runs in a NEW Electron main process. Real bootstrap, stores, source adapter and SQLite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, session, net: electronNet } = require('electron');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const phase = process.argv[3];
const checkout = path.resolve(__dirname, '../../../..');
assert.equal(checkout, manifest.checkout);
assert.equal(fs.realpathSync(process.cwd()), checkout);
assert.ok(['write', 'reopen'].includes(phase));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for (const [file, hash] of Object.entries(manifest.files))
	assert.equal(sha(path.join(checkout, file)), hash, file);
assert.equal(sha(manifest.activeAddon), manifest.addonSha256);
assert.equal(sha(process.execPath), manifest.electronSha256);
assert.equal(process.versions.modules, '145');
const admission = require(path.join(checkout, 'dist/main/board/board-isolation.js'));
const contract = admission.requireBoardIsolation({ expected: manifest.contract });
admission.readBoardIsolationRegistries(contract);
admission.assertBoardIsolationBootstrap(contract);
const record = {
	phase,
	contract,
	versions: process.versions,
	passed: false,
	networkAttempts: [],
	writes: [],
};
const report = () =>
	fs.writeFileSync(path.join(contract.root, `${phase}.json`), JSON.stringify(record, null, 2));
const fail = (error) => {
	record.error = String(error.stack ?? error);
	report();
	app.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
const deadline = setTimeout(() => fail(new Error('Native probe exceeded 100 seconds')), 100000);

// Containment instrumentation fails on actual IO attempts, without replacing backend modules.
const denyNetwork = (...args) => {
	record.networkAttempts.push(String(args[0]));
	throw new Error('Native probe forbids outgoing network');
};
require('node:net').Socket.prototype.connect = denyNetwork;
globalThis.fetch = denyNetwork;
electronNet.request = denyNetwork;
electronNet.fetch = denyNetwork;
app.on('session-created', (created) =>
	created.webRequest.onBeforeRequest(
		{ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
		(details, callback) => {
			record.networkAttempts.push(details.url);
			callback({ cancel: true });
		}
	)
);
const { realpathThroughAncestor, isPathWithin } = require(
	path.join(checkout, 'dist/main/utils/real-path-containment.js')
);
for (const api of [fs, fs.promises]) {
	for (const method of [
		'writeFile',
		'appendFile',
		'mkdir',
		'unlink',
		'rm',
		'rename',
		'copyFile',
		'writeFileSync',
		'appendFileSync',
		'mkdirSync',
		'unlinkSync',
		'rmSync',
		'renameSync',
		'copyFileSync',
	]) {
		if (!api[method]) continue;
		const original = api[method].bind(api);
		api[method] = (file, ...args) => {
			if (typeof file !== 'number') {
				const target = realpathThroughAncestor(path.resolve(String(file)));
				assert.ok(isPathWithin(target, contract.root), `Write outside fixture: ${target}`);
				record.writes.push(target);
				if (method.startsWith('rename') || method.startsWith('copyFile'))
					assert.ok(
						isPathWithin(realpathThroughAncestor(path.resolve(String(args[0]))), contract.root)
					);
			}
			return original(file, ...args);
		};
	}
}

// These guards forbid worker/timer execution while retaining the real native services.
require(path.join(checkout, 'dist/main/process-manager/index.js')).ProcessManager.prototype.spawn =
	() => {
		throw new Error('Native probe forbids real workers');
	};
require(path.join(checkout, 'dist/main/cue/cue-engine.js')).CueEngine.prototype.start = () => {
	throw new Error('Native probe forbids Cue execution');
};

// The existing bootstrap admits and configures the frozen fixture transport before index imports.
require(path.join(checkout, 'dist/main/bootstrap.js'));

(async () => {
	const stores = require(path.join(checkout, 'dist/main/stores/instances.js'));
	while (!stores.isInitialized()) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(app.getPath('userData'), contract.userData);
	assert.equal(stores.getCachedPaths().syncPath, contract.sync);
	const instances = stores.getStoreInstances();
	for (const store of Object.values(instances)) {
		assert.ok(isPathWithin(fs.realpathSync(store.path), contract.root), store.path);
	}
	assert.equal(instances.sessionsStore.path, contract.agentRegistry);
	assert.deepEqual(instances.sessionsStore.get('sessions'), []);
	assert.equal(instances.settingsStore.get('encoreFeatures').maestroCue, false);
	assert.equal(instances.settingsStore.get('encoreFeatures').pianola, false);
	if (phase === 'write') instances.settingsStore.set('boardNativeProbeIdentity', contract.identity);
	else assert.equal(instances.settingsStore.get('boardNativeProbeIdentity'), contract.identity);
	// Supply the existing explicit facade seam only AFTER native bootstrap initialized real stores.
	const { openBoardDb } = require(path.join(checkout, 'dist/main/board/board-db.js'));
	const storage = require(path.join(checkout, 'dist/main/board/board-storage.js'));
	const db = openBoardDb(contract.db);
	const requestId = `native-persistence-${contract.identity}`;
	const persistedResult = JSON.stringify({ identity: contract.identity, marker: 'native-write' });
	if (phase === 'reopen') {
		assert.deepEqual(
			db
				.prepare('SELECT principal, result_json, revision FROM commands WHERE request_id = ?')
				.get(requestId),
			{ principal: 'isolated-native-probe', result_json: persistedResult, revision: 1 }
		);
		record.boardRecordVerifiedBeforeWorkspaceInitialization = true;
	}
	const facade = new storage.BoardStorageFacade(db);
	storage.configureBoardStorage(facade);
	storage.initializeBoardWorkspace();
	const sources = require(path.join(checkout, 'dist/main/board/board-source-host.js'));
	await sources.refreshBoardSources();
	const sourceRows = db.prepare('SELECT payload_json FROM board_source_locations').all();
	assert.deepEqual(
		sourceRows.map((row) => JSON.parse(row.payload_json)),
		[{ location: { kind: 'local' }, path: manifest.repository }]
	);
	assert.equal(db.prepare('SELECT count(*) AS n FROM repositories').get().n, 1);
	assert.equal(db.prepare('SELECT count(*) AS n FROM collections').get().n, 1);
	assert.equal(db.prepare('SELECT count(*) AS n FROM cards').get().n, 0);
	assert.equal(db.prepare('SELECT count(*) AS n FROM workers').get().n, 0);
	assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
	if (phase === 'write') {
		assert.equal(
			db.prepare('SELECT count(*) AS n FROM commands WHERE request_id = ?').get(requestId).n,
			0
		);
		db.prepare(
			'INSERT INTO commands (request_id, principal, result_json, revision) VALUES (?, ?, ?, ?)'
		).run(requestId, 'isolated-native-probe', persistedResult, 1);
		record.boardRecordWritten = requestId;
	}
	// Exercise actual default transport and provider replacement denials, before any network attempt.
	await assert.rejects(sources.discoverBoardSources(facade, []), /not admitted/);
	assert.throws(() => sources.configureBoardSourceHost(() => []), /one fixture/);
	const { BridgeConnection } = require(
		path.join(checkout, 'dist/shared/maestro-lib/client/bridge-connection.js')
	);
	await assert.rejects(new BridgeConnection().connect(), /cannot connect to the desktop bridge/);
	await assert.rejects(
		new BridgeConnection({ userDataDir: contract.userData }).connect(),
		/cannot connect/
	);
	await app.whenReady();
	// index installs this listener at the end of its real asynchronous ready chain.
	while (app.listenerCount('activate') === 0) await new Promise((resolve) => setImmediate(resolve));
	session.defaultSession.webRequest.onBeforeRequest(
		{ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
		(details, callback) => {
			record.networkAttempts.push(details.url);
			callback({ cancel: true });
		}
	);
	assert.deepEqual(record.networkAttempts, []);
	record.storePaths = Object.fromEntries(
		Object.entries(instances).map(([key, store]) => [key, store.path])
	);
	record.sourceRows = sourceRows;
	record.db = db.name;
	record.denials = [
		'default transport',
		'provider replacement',
		'default bridge',
		'explicit bridge',
	];
	db.close();
	assert.equal(fs.realpathSync(contract.db), contract.db);
	record.passed = true;
	report();
	clearTimeout(deadline);
	app.exit(0);
})().catch(fail);
