// Admission shared by the source-only checks and the owned Electron entrypoint.
// No Electron, store, SQLite connection, network or process is opened here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { admitPerformanceFixture } = require('./board-performance-admission.cjs');

const entry = 'src/__tests__/integration/fixtures/board-rendered-entry.cjs';
const renderer = 'dist/board-rendered/index.html';
const preload = 'dist/main/preload.js';
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function filesUnder(checkout, relative) {
	const absolute = path.join(checkout, relative);
	assert.equal(fs.realpathSync(absolute), absolute, `Noncanonical artifact: ${relative}`);
	const stat = fs.lstatSync(absolute);
	if (stat.isFile()) return [relative];
	assert.ok(stat.isDirectory());
	return fs
		.readdirSync(absolute)
		.sort()
		.flatMap((name) => filesUnder(checkout, path.join(relative, name)));
}

function renderedFingerprints(checkout) {
	const roots = [
		'src/main',
		'src/shared',
		'src/types',
		'src/renderer',
		'src/__tests__/integration/fixtures',
		'dist/main',
		'dist/shared',
		...(fs.existsSync(path.join(checkout, 'dist/types')) ? ['dist/types'] : []),
		'dist/board-rendered',
		'package.json',
		'package-lock.json',
		'tsconfig.main.json',
		'vite.config.mts',
		'tailwind.config.mjs',
		'postcss.config.mjs',
		'scripts/build-preload.mjs',
		'scripts/gen-build-info.mjs',
		'scripts/clean-tsc-output.mjs',
		...fs
			.readdirSync(path.join(checkout, 'scripts'))
			.filter((name) => /^board-(rendered|performance)-.*\.cjs$/.test(name))
			.map((name) => path.join('scripts', name)),
	];
	return Object.fromEntries(
		[...new Set(roots.flatMap((root) => filesUnder(checkout, root)))]
			.sort()
			.map((file) => [file, sha(path.join(checkout, file))])
	);
}

function assertPrivateRoot(root) {
	assert.equal(fs.realpathSync(root), root);
	if (process.platform !== 'win32')
		assert.equal(fs.statSync(root).mode & 0o777, 0o700, 'Fixture root must be 0700');
}

function registryFingerprints(contract) {
	return Object.fromEntries(
		[
			contract.agentRegistry,
			contract.sourceRegistry,
			path.join(contract.sync, 'maestro-groups.json'),
			path.join(contract.sync, 'maestro-settings.json'),
		].map((file) => {
			assert.equal(fs.realpathSync(file), file);
			assert.equal(fs.statSync(file).nlink, 1);
			return [file, sha(file)];
		})
	);
}

// Fixed opt-in scenario, bound in the manifest by the preparing parent. No
// renderer-supplied root, provider, group or generic registry write permission.
function workerCreationRequest(contract, registrations) {
	return {
		identity: contract.identity,
		name: 'Fixture created worker',
		toolType: 'codex',
		cwd: registrations.sources[0].root,
	};
}

function authorityRequest(contract) {
	const cliRegistry = path.join(contract.sync, 'maestro-sessions.json');
	const artifact = path.join(contract.root, 'authority-artifact.json');
	assert.equal(fs.realpathSync(artifact), artifact);
	assert.equal(fs.statSync(artifact).nlink, 1);
	assert.equal(fs.realpathSync(cliRegistry), cliRegistry);
	assert.equal(fs.statSync(cliRegistry).nlink, 1);
	assert.equal(
		sha(cliRegistry),
		sha(contract.agentRegistry),
		'CLI and host agent snapshots differ'
	);
	return {
		identity: contract.identity,
		scenario: 'host-authority-v1',
		cliRegistrySha256: sha(cliRegistry),
		artifactBaseSha256: sha(artifact),
	};
}

function renderedRunRoot(manifest) {
	if (!manifest.reopen) return manifest.contract.root;
	assert.match(manifest.contract.identity, /^board-reopen-[a-f0-9-]{36}$/);
	return path.join(manifest.contract.root, manifest.contract.identity);
}

// Persist exact payload/history bytes as well as identities and migration ledgers.
// Both native launches use the same SQLite adapter and deterministic row order.
function persistenceSnapshot(db) {
	const tables = {};
	for (const { name } of db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
		)
		.all()) {
		assert.match(name, /^[a-z_]+$/);
		tables[name] = db
			.prepare(`SELECT * FROM ${name} ORDER BY rowid`)
			.all()
			.map((row) =>
				Object.fromEntries(
					Object.entries(row).map(([key, value]) => [
						key,
						value instanceof Uint8Array ? { hex: Buffer.from(value).toString('hex') } : value,
					])
				)
			);
	}
	return { schemaVersion: db.pragma('user_version', { simple: true }), tables };
}

function closedDatabaseBinding(contract, admission) {
	admission.assertBoardIsolationPath(contract, contract.db);
	assertPrivateRoot(contract.root);
	for (const suffix of ['-wal', '-shm'])
		assert.ok(!fs.existsSync(contract.db + suffix), 'Database still has SQLite sidecars');
	const identity = (file) => {
		const stat = fs.statSync(file);
		return { dev: stat.dev, ino: stat.ino };
	};
	return { root: identity(contract.root), db: identity(contract.db), sha256: sha(contract.db) };
}

function verifiedPreviousLaunch(root, checkout, admission) {
	assertPrivateRoot(root);
	const previousPath = path.join(root, 'rendered.json');
	assert.equal(fs.realpathSync(previousPath), previousPath);
	const previous = JSON.parse(fs.readFileSync(previousPath));
	assert.ok(!previous.reopen, 'Reopen requires the original owned launch');
	assert.equal(previous.contract.root, root);
	admission.requireBoardIsolation({
		env: previous.env,
		expected: previous.contract,
		worktree: checkout,
	});
	assert.deepEqual(previous.files, renderedFingerprints(checkout), 'Previous source/build changed');
	assert.deepEqual(
		previous.registries,
		registryFingerprints(previous.contract),
		'Previous registry changed'
	);
	const receiptPath = path.join(root, 'rendered-launch.json');
	assert.equal(fs.realpathSync(receiptPath), receiptPath);
	const receipt = JSON.parse(fs.readFileSync(receiptPath));
	assert.equal(receipt.manifestPath, previousPath);
	assert.equal(receipt.manifestSha256, sha(previousPath));
	assert.deepEqual(receipt.contract, previous.contract);
	assert.deepEqual(receipt.files, previous.files);
	assert.equal(receipt.lifecyclePassed, true, 'Previous launch failed');
	assert.equal(receipt.addonRestored, true, 'Previous addon was not restored');
	assert.equal(receipt.ownedChildrenExited, true, 'Previous children did not close');
	assert.deepEqual(receipt.cleanupErrors, []);
	assert.ok(!receipt.error);
	assert.deepEqual(receipt.processes.find((item) => item.label === 'electron')?.exit, {
		code: 0,
		signal: null,
	});
	const hostPath = path.join(root, 'rendered-host.json');
	admission.assertBoardIsolationPath(previous.contract, hostPath);
	assert.equal(receipt.hostSha256, sha(hostPath));
	const host = JSON.parse(fs.readFileSync(hostPath));
	assert.equal(host.ready, true);
	assert.equal(host.databaseClosed, true, 'Previous database closure unconfirmed');
	assert.ok(!host.error);
	assert.deepEqual(host.contract, previous.contract);
	assert.ok(host.persistence?.tables.cards && host.persistence.tables.runs);
	assert.deepEqual(
		receipt.database,
		closedDatabaseBinding(previous.contract, admission),
		'Previous database changed'
	);
	admission.assertBoardIsolationPath(previous.contract, path.join(root, 'rendered-run.lock'));
	assert.equal(
		fs.readFileSync(path.join(root, 'rendered-run.lock'), 'utf8'),
		previous.contract.identity
	);
	return {
		previous,
		receipt,
		host,
		receiptSha256: sha(receiptPath),
		manifestSha256: sha(previousPath),
	};
}

function prepareRenderedReopen(previousReceipt, checkout, admission) {
	const verified = verifiedPreviousLaunch(previousReceipt.contract.root, checkout, admission);
	const { canonicalJson } = require('../dist/shared/canonicalJson.js');
	assert.ok(
		canonicalJson(previousReceipt) === canonicalJson(verified.receipt),
		'Previous parent receipt differs'
	);
	const identity = `board-reopen-${crypto.randomUUID()}`;
	const manifest = {
		...verified.previous,
		contract: { ...verified.previous.contract, identity },
		env: { ...verified.previous.env, BOARD_ISOLATION_ID: identity },
		databaseSha256: verified.receipt.database.sha256,
		reopen: {
			previousReceiptSha256: verified.receiptSha256,
			previousManifestSha256: verified.manifestSha256,
		},
	};
	// One second-launch authorization per original root. Never clear this claim or
	// reuse either process's consumed nonce, including after a failed second run.
	fs.writeFileSync(path.join(manifest.contract.root, 'rendered-reopen.lock'), identity, {
		flag: 'wx',
		mode: 0o600,
	});
	const runRoot = renderedRunRoot(manifest);
	fs.mkdirSync(runRoot, { mode: 0o700 });
	const manifestPath = path.join(runRoot, 'rendered.json');
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', {
		flag: 'wx',
		mode: 0o600,
	});
	admitRenderedFixture(manifestPath, checkout, admission);
	return manifestPath;
}

function admitRenderedFixture(manifestPath, checkout, admission, env) {
	assert.equal(fs.realpathSync(checkout), checkout);
	assert.equal(fs.realpathSync(manifestPath), manifestPath);
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.nativeExecuted, false);
	assert.equal(manifest.checkout, checkout);
	assert.equal(manifest.entry, entry);
	assert.equal(manifest.renderer, renderer);
	assert.equal(manifest.preload, preload);
	assert.deepEqual(
		manifest.files,
		renderedFingerprints(checkout),
		'Source/build changed; rebuild and prepare again'
	);
	const preparedPath = path.join(manifest.contract.root, 'prepared.json');
	assert.equal(sha(preparedPath), manifest.preparedSha256);
	const {
		contract: preparedContract,
		registrations,
		manifest: prepared,
	} = admitPerformanceFixture(preparedPath, checkout, admission);
	const contract = manifest.reopen
		? admission.requireBoardIsolation({
				env: manifest.env,
				expected: manifest.contract,
				worktree: checkout,
			})
		: preparedContract;
	assert.deepEqual(manifest.contract, contract);
	assert.equal(manifestPath, path.join(renderedRunRoot(manifest), 'rendered.json'));
	assertPrivateRoot(contract.root);
	assert.equal(sha(contract.db), manifest.databaseSha256, 'Prepared SQLite contents changed');
	assert.deepEqual(manifest.env, {
		...prepared.env,
		...(manifest.reopen ? { BOARD_ISOLATION_ID: contract.identity } : {}),
	});
	if (manifest.reopen) {
		assert.deepEqual({ ...contract, identity: preparedContract.identity }, preparedContract);
		assert.notEqual(contract.identity, preparedContract.identity);
		const verified = verifiedPreviousLaunch(contract.root, checkout, admission);
		assert.deepEqual(manifest.reopen, {
			previousReceiptSha256: verified.receiptSha256,
			previousManifestSha256: verified.manifestSha256,
		});
		assert.deepEqual(manifest.binaries, verified.previous.binaries);
		assert.equal(manifest.head, verified.previous.head);
		assert.equal(
			fs.readFileSync(path.join(contract.root, 'rendered-reopen.lock'), 'utf8'),
			contract.identity
		);
	}
	// A manifest cannot authorize arbitrary inherited variables, even if its own
	// prepared.json hash was refreshed. Keep this host's input surface explicit.
	assert.deepEqual(
		Object.keys(manifest.env).sort(),
		[
			'BOARD_ISOLATION_ID',
			'BOARD_ISOLATED_ROOT',
			'BOARD_DB_PATH',
			'MAESTRO_USER_DATA',
			'BOARD_SYNC_PATH',
			'BOARD_AGENT_REGISTRY',
			'BOARD_SOURCE_REGISTRY',
			'BOARD_SOURCE_ROOT',
			'MAESTRO_DEMO_DIR',
			'NODE_ENV',
			'MAESTRO_E2E_TEST',
			'MAESTRO_DISABLE_CUE_TELEMETRY',
			'MAESTRO_DISABLE_GROUP_CHAT_PROVIDERS',
			'TMPDIR',
			'PATH',
			'XDG_CACHE_HOME',
			'XDG_DATA_HOME',
		].sort(),
		'Unexpected fixture environment variable'
	);
	for (const [key, value] of Object.entries({
		NODE_ENV: 'test',
		MAESTRO_E2E_TEST: 'true',
		MAESTRO_DISABLE_CUE_TELEMETRY: '1',
		MAESTRO_DISABLE_GROUP_CHAT_PROVIDERS: '1',
	})) {
		assert.equal(manifest.env[key], value);
	}
	for (const [key, relative] of Object.entries({
		TMPDIR: 'tmp',
		PATH: 'bin',
		XDG_CACHE_HOME: 'xdg/cache',
		XDG_DATA_HOME: 'xdg/data',
	})) {
		assert.equal(manifest.env[key], path.join(contract.root, relative));
		admission.assertBoardIsolationPath(contract, manifest.env[key], 'directory');
	}
	assert.deepEqual(
		manifest.registries,
		registryFingerprints(contract),
		'Fixture registry contents changed'
	);
	assert.equal(registrations.sessions.length, 100);
	assert.equal(registrations.sources.length, 50);
	if (manifest.creation !== undefined) {
		assert.ok(!manifest.reopen, 'Creation scenario cannot reuse a consumed registry');
		assert.deepEqual(manifest.creation, workerCreationRequest(contract, registrations));
	}
	if (manifest.authority !== undefined) {
		assert.equal(prepared.counts.cards, 0, 'Authority requires the empty fixture');
		assert.ok(
			!manifest.reopen && !manifest.creation,
			'Authority requires a fresh dedicated fixture'
		);
		assert.deepEqual(manifest.authority, authorityRequest(contract));
	}
	const groups = JSON.parse(
		fs.readFileSync(path.join(contract.sync, 'maestro-groups.json'))
	).groups;
	assert.equal(groups.length, 20);
	assert.equal(new Set(groups.map((group) => group.id)).size, 20);
	assert.ok(
		registrations.sessions.every((agent) => groups.some((group) => group.id === agent.groupId))
	);
	assert.equal(
		manifest.electron,
		fs.realpathSync(
			path.join(
				checkout,
				'node_modules/electron/dist',
				process.platform === 'win32' ? 'electron.exe' : 'electron'
			)
		)
	);
	for (const file of [manifest.electron, manifest.addon]) {
		assert.ok(file.startsWith(checkout + path.sep));
		assert.equal(fs.realpathSync(file), file);
		assert.equal(sha(file), manifest.binaries[file]);
	}
	assert.equal(process.platform, 'linux');
	assert.equal(manifest.git, fs.realpathSync('/usr/bin/git'));
	assert.equal(sha(manifest.git), manifest.binaries[manifest.git]);
	assert.deepEqual(
		Object.keys(manifest.binaries).sort(),
		[manifest.electron, manifest.addon, manifest.git].sort()
	);
	if (env) {
		for (const [key, value] of Object.entries(manifest.env))
			assert.equal(env[key], value, `Changed environment: ${key}`);
		const { canonicalJson } = require('../dist/shared/canonicalJson.js');
		assert.equal(env.BOARD_ISOLATION_CONTRACT, canonicalJson(contract), 'Missing parent contract');
		// Electron itself supplies these on Linux after the parent's clean spawn.
		for (const [key, value] of Object.entries({
			DBUS_SESSION_BUS_ADDRESS: 'disabled:',
			CHROME_DESKTOP: 'electron.desktop',
		})) {
			if (key in env) assert.equal(env[key], value, `Unexpected Electron environment: ${key}`);
		}
		const extras = [
			'BOARD_ISOLATION_CONTRACT',
			'DISPLAY',
			'XAUTHORITY',
			'DBUS_SESSION_BUS_ADDRESS',
			'CHROME_DESKTOP',
		];
		assert.ok(
			Object.keys(env).every((key) => key in manifest.env || extras.includes(key)),
			'Unexpected child environment'
		);
		admission.requireBoardIsolation({ expected: contract, env });
	}
	return { manifest, contract, registrations, groups };
}

/** Re-read mutable catalogs before each IPC call, without hashing renderer assets on its hot path. */
function assertRenderedRegistries(manifest, admission) {
	assertPrivateRoot(manifest.contract.root);
	admission.requireBoardIsolation({ expected: manifest.contract });
	admission.readBoardIsolationRegistries(manifest.contract);
	if (manifest.authority) assert.deepEqual(manifest.authority, authorityRequest(manifest.contract));
	assert.deepEqual(
		registryFingerprints(manifest.contract),
		manifest.registries,
		'Fixture registry contents changed'
	);
}

module.exports = {
	entry,
	renderer,
	preload,
	sha,
	filesUnder,
	renderedFingerprints,
	registryFingerprints,
	workerCreationRequest,
	authorityRequest,
	renderedRunRoot,
	persistenceSnapshot,
	closedDatabaseBinding,
	verifiedPreviousLaunch,
	prepareRenderedReopen,
	assertPrivateRoot,
	admitRenderedFixture,
	assertRenderedRegistries,
};

if (require.main === module) {
	try {
		assert.equal(
			process.argv.length,
			3,
			'Usage: node scripts/board-rendered-contract.cjs ABSOLUTE_RENDERED.json'
		);
		const checkout = path.resolve(__dirname, '..');
		assert.equal(fs.realpathSync(process.cwd()), checkout);
		const admission = require('../dist/main/board/board-isolation.js');
		const { contract } = admitRenderedFixture(process.argv[2], checkout, admission);
		console.log(`Admitted build and registries (no native execution): ${contract.root}`);
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	}
}
