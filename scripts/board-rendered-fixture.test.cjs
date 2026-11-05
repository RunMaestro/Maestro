// Run after board-rendered-build.cjs. Tests prepare/admit only, never launch Electron.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const binding = require('./board-rendered-contract.cjs');
const admission = require('../dist/main/board/board-isolation.js');
const checkout = path.resolve(__dirname, '..');
const addon = path.join(checkout, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
const read = (file) => JSON.parse(fs.readFileSync(file));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const prepare = (count, ...flags) => {
	const result = cp.spawnSync(
		process.execPath,
		['scripts/board-rendered-prepare.cjs', String(count), addon, ...flags],
		{
			cwd: checkout,
			env: { PATH: process.env.PATH },
			encoding: 'utf8',
			timeout: 30000,
		}
	);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
};

test(
	'materializes 0/100/500 cards with actual catalog and migration rows in separate 0700 roots',
	{ timeout: 100000 },
	(t) => {
		for (const count of [0, 100, 500]) {
			const file = prepare(count);
			const { manifest, contract, registrations, groups } = binding.admitRenderedFixture(
				file,
				checkout,
				admission
			);
			t.after(() => fs.rmSync(contract.root, { recursive: true, force: true }));
			assert.equal(manifest.nativeExecuted, false);
			assert.equal(manifest.env.HOME, undefined);
			assert.equal(manifest.env.CODEX_HOME, undefined);
			assert.equal(registrations.sessions.length, 100);
			assert.equal(groups.length, 20);
			const { DatabaseSync } = require('node:sqlite');
			const db = new DatabaseSync(contract.db, { readOnly: true });
			try {
				for (const [table, expected] of [
					['cards', count],
					['migrations', 50],
					['repositories', 50],
					['board_source_locations', 50],
					['workers', 0],
					['runs', 0],
				]) {
					assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, expected, table);
				}
			} finally {
				db.close();
			}
			for (const source of registrations.sources) {
				assert.ok(fs.statSync(path.join(source.root, '.git')).isDirectory());
				assert.equal(
					fs.readFileSync(path.join(source.root, '.maestro/board.yaml'), 'utf8'),
					'version: 1\nboards: []\n'
				);
			}
		}
	}
);

test(
	'rejects altered build/entry/binary bindings and same-count registry replacements before opening storage',
	{ timeout: 30000 },
	(t) => {
		const file = prepare(0);
		const original = read(file);
		const contract = original.contract;
		t.after(() => fs.rmSync(contract.root, { recursive: true, force: true }));
		const admit = () => binding.admitRenderedFixture(file, checkout, admission);
		const before = binding.sha(contract.db);
		for (const change of [
			(m) => {
				m.entry = 'src/__tests__/integration/fixtures/board-native-entry.cjs';
			},
			(m) => {
				m.files[binding.preload] = 'changed';
			},
			(m) => {
				delete m.files[binding.renderer];
			},
			(m) => {
				m.binaries[m.addon] = 'changed';
			},
			(m) => {
				m.contract.root += '-other';
			},
		]) {
			const altered = structuredClone(original);
			change(altered);
			save(file, altered);
			assert.throws(admit);
		}
		save(file, original);
		assert.ok(admit());
		for (const registry of [
			contract.agentRegistry,
			contract.sourceRegistry,
			path.join(contract.sync, 'maestro-groups.json'),
		]) {
			const bytes = fs.readFileSync(registry);
			const value = read(registry);
			Object.values(value)[0][0].id += '-changed';
			save(registry, value);
			assert.throws(admit, /registry contents changed/);
			fs.writeFileSync(registry, bytes);
		}
		if (process.platform !== 'win32') {
			fs.chmodSync(contract.root, 0o750);
			assert.throws(admit, /0700/);
			fs.chmodSync(contract.root, 0o700);
		}
		assert.equal(binding.sha(contract.db), before, 'Admission failures must not mutate SQLite');
		assert.ok(admit());
	}
);

test(
	'requires parent contract, exact child environment and canonical manifest path',
	{ timeout: 30000 },
	(t) => {
		const file = prepare(0);
		const manifest = read(file);
		t.after(() => fs.rmSync(manifest.contract.root, { recursive: true, force: true }));
		const { canonicalJson } = require('../dist/shared/canonicalJson.js');
		const env = {
			...manifest.env,
			BOARD_ISOLATION_CONTRACT: canonicalJson(manifest.contract),
			DISPLAY: ':123',
		};
		assert.ok(binding.admitRenderedFixture(file, checkout, admission, env));
		assert.ok(
			binding.admitRenderedFixture(file, checkout, admission, {
				...env,
				DBUS_SESSION_BUS_ADDRESS: 'disabled:',
				CHROME_DESKTOP: 'electron.desktop',
			})
		);
		for (const changed of [
			{ ...env, BOARD_ISOLATION_CONTRACT: undefined },
			{ ...env, BOARD_DB_PATH: path.join(manifest.contract.root, 'other.sqlite') },
			{ ...env, NODE_OPTIONS: '--require=foreign.cjs' },
			{ ...env, HTTPS_PROXY: 'http://example.invalid' },
			{ ...env, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/foreign' },
			{ ...env, CHROME_DESKTOP: 'foreign.desktop' },
		])
			assert.throws(() => binding.admitRenderedFixture(file, checkout, admission, changed));
		const alias = path.join(manifest.contract.root, 'alias.json');
		fs.symlinkSync(file, alias);
		assert.throws(() => binding.admitRenderedFixture(alias, checkout, admission));
		const failedEntry = cp.spawnSync(process.execPath, [binding.entry, file], {
			cwd: checkout,
			env: manifest.env,
			encoding: 'utf8',
			timeout: 10000,
		});
		assert.notEqual(failedEntry.status, 0);
		assert.match(failedEntry.stderr, /Missing parent contract/);
		assert.equal(fs.existsSync(path.join(manifest.contract.root, 'rendered-run.lock')), false);
		const preparedPath = path.join(manifest.contract.root, 'prepared.json');
		const prepared = read(preparedPath);
		for (const change of [
			(env) => {
				env.NODE_OPTIONS = '--require=foreign.cjs';
			},
			(env) => {
				env.TMPDIR = '/tmp';
			},
			(env) => {
				env.MAESTRO_E2E_TEST = 'false';
			},
		]) {
			const altered = structuredClone(manifest);
			change(altered.env);
			save(preparedPath, { ...prepared, env: altered.env });
			altered.preparedSha256 = binding.sha(preparedPath);
			save(file, altered);
			assert.throws(() => binding.admitRenderedFixture(file, checkout, admission));
		}
	}
);

test(
	'real store bootstrap preserves bound registry bytes and exposes the fixture agents/groups',
	{ timeout: 30000 },
	(t) => {
		const file = prepare(0);
		const { manifest, contract } = binding.admitRenderedFixture(file, checkout, admission);
		t.after(() => fs.rmSync(contract.root, { recursive: true, force: true }));
		const result = cp.spawnSync(
			process.execPath,
			[
				'-e',
				`
		const assert = require('node:assert/strict');
		const manifest = JSON.parse(require('node:fs').readFileSync(process.argv[1]));
		const Module = require('node:module');
		const original = Module._load;
		Module._load = function(name, ...args) {
			if (name === 'electron') return {
				app: { getPath: () => manifest.contract.userData, getVersion: () => '1.1.1', getName: () => 'Maestro' },
				ipcMain: { on: () => {} },
			};
			return original.call(this, name, ...args);
		};
		const stores = require('./dist/main/stores/instances.js');
		stores.initializeStores({ productionDataPath: manifest.contract.userData });
		const instances = stores.getStoreInstances();
		assert.equal(instances.sessionsStore.get('sessions').length, 100);
		assert.equal(instances.groupsStore.get('groups').length, 20);
		const binding = require('./scripts/board-rendered-contract.cjs');
		binding.assertRenderedRegistries(manifest, require('./dist/main/board/board-isolation.js'));
	`,
				file,
			],
			{ cwd: checkout, env: manifest.env, encoding: 'utf8', timeout: 15000 }
		);
		assert.equal(result.status, 0, result.stderr);
	}
);

test('execution boundary refuses real process/network calls and foreign IPC senders', () => {
	// Own disposable child: patching builtins cannot affect the test runner or another agent.
	const result = cp.spawnSync(
		process.execPath,
		[
			'-e',
			`
		const assert = require('node:assert/strict');
		const handlers = new Map();
		const record = { denied: [] };
		const owner = {};
		const frame = {};
		const electron = { ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, shell: {}, net: {} };
		const { installRenderedBoundary } = require('./scripts/board-rendered-boundary.cjs');
		const boundary = installRenderedBoundary(electron, (event) => {
			assert.equal(event.sender, owner);
			assert.equal(event.senderFrame, frame);
		}, record);
		for (const run of [
			() => require('node:child_process').spawn(process.execPath, ['-e', 'process.exit(99)']),
			() => require('node:child_process').execFileSync(process.execPath, []),
			() => require('node:net').connect(1, '127.0.0.1'),
			() => require('node:http').get('http://127.0.0.1:1'),
			() => fetch('https://example.invalid'),
			() => electron.net.fetch('https://example.invalid'),
			() => electron.shell.openExternal('https://example.invalid'),
		]) assert.throws(run, /fixture denies/);
		electron.ipcMain.handle('board:initialize', () => 'real handler');
		assert.equal(handlers.get('board:initialize')({ sender: owner, senderFrame: frame }), 'real handler');
		electron.ipcMain.handle('notification:show', () => ({ success: false }));
		assert.deepEqual(handlers.get('notification:show')({ sender: owner, senderFrame: frame }), { success: false });
		assert.throws(() => handlers.get('notification:show')({ sender: {}, senderFrame: frame }));
		assert.throws(() => handlers.get('board:initialize')({ sender: {}, senderFrame: frame }));
		assert.throws(() => handlers.get('board:initialize')({ sender: owner, senderFrame: {} }));
		assert.throws(() => electron.ipcMain.handle('process:spawn', () => {}), /Unexpected fixture IPC/);
		electron.ipcMain.handle('board:runtimeCommand', () => { throw Error('runtime was invoked'); });
		assert.equal(handlers.get('board:runtimeCommand')({ sender: owner, senderFrame: frame }).error.code, 'runtime-unavailable');
		let callback;
		boundary.secureSession({ setPermissionCheckHandler: () => {}, setPermissionRequestHandler: () => {}, webRequest: { onBeforeRequest: (fn) => callback = fn } });
		for (const url of ['https://example.invalid', 'http://127.0.0.1:1', 'ws://localhost:1', 'ftp://example.invalid']) {
			callback({ url }, ({ cancel }) => assert.equal(cancel, true));
		}
		callback({ url: 'file:///fixture/index.html' }, ({ cancel }) => assert.equal(cancel, false));
	`,
		],
		{ cwd: checkout, env: {}, encoding: 'utf8', timeout: 10000 }
	);
	assert.equal(result.status, 0, result.stderr);
});

test('execution boundary permits only the admitted local Git probe', async (t) => {
	const root = fs.mkdtempSync(path.join(checkout, 'isolated/board-git-boundary-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const source = path.join(root, 'source');
	fs.mkdirSync(source);
	const git = fs.realpathSync('/usr/bin/git');
	const init = cp.spawnSync(git, ['-c', 'init.templateDir=', 'init', '-q', source], {
		encoding: 'utf8',
	});
	assert.equal(init.status, 0, init.stderr);
	const result = cp.spawnSync(
		process.execPath,
		[
			'-e',
			`
		const assert = require('node:assert/strict');
		const { promisify } = require('node:util');
		const { installRenderedBoundary } = require('./scripts/board-rendered-boundary.cjs');
		const electron = { ipcMain: { handle() {} }, shell: {}, net: {} };
		const record = { denied: [] };
		const [git, source, root] = process.argv.slice(1);
		const sha256 = require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(git)).digest('hex');
		installRenderedBoundary(electron, () => {}, record, { executable: git, sha256, roots: [source], path: root, home: root });
		const execFile = require('node:child_process').execFile;
		const options = { cwd: source, shell: false, env: { GIT_DIR: '/etc', PATH: '/tmp' } };
		(async () => {
			const output = await promisify(execFile)('git', ['rev-parse', '--show-toplevel'], options);
			assert.equal(output.stdout.trim(), source);
			const real = await require('./dist/main/utils/remote-git.js').execGitReadOnly(['rev-parse', '--show-toplevel'], source);
			assert.equal(real.exitCode, 0, real.stderr);
			assert.equal(real.stdout.trim(), source);
			for (const [command, args, opts] of [
				['git', ['status'], options], ['git', ['rev-parse', '--show-toplevel'], { ...options, cwd: root }],
				[git, ['rev-parse', '--show-toplevel'], options], ['ssh', ['host'], options],
				['git', ['rev-parse', '--show-toplevel'], { ...options, shell: true }],
			]) assert.throws(() => execFile(command, args, opts, () => {}), /fixture denies/);
		})().catch((error) => { console.error(error); process.exitCode = 1; });
	`,
			git,
			source,
			root,
		],
		{ cwd: checkout, env: {}, encoding: 'utf8', timeout: 10000 }
	);
	assert.equal(result.status, 0, result.stderr);
});

test(
	'dedicated authority capability is bound to its fresh parent and cannot compose with creation or reopen',
	{ timeout: 30000 },
	(t) => {
		const file = prepare(0, '--authority');
		const { manifest, contract, registrations } = binding.admitRenderedFixture(
			file,
			checkout,
			admission
		);
		t.after(() => fs.rmSync(contract.root, { recursive: true, force: true }));
		assert.deepEqual(manifest.authority, binding.authorityRequest(contract));
		const before = binding.sha(contract.db);
		for (const authority of [
			true,
			{},
			{ ...manifest.authority, identity: 'foreign' },
			{ ...manifest.authority, scenario: 'execute-anything' },
			{ ...manifest.authority, root: '/tmp' },
		]) {
			save(file, { ...manifest, authority });
			assert.throws(() => binding.admitRenderedFixture(file, checkout, admission));
			assert.equal(binding.sha(contract.db), before);
		}
		save(file, {
			...manifest,
			creation: binding.workerCreationRequest(contract, registrations),
		});
		assert.throws(() => binding.admitRenderedFixture(file, checkout, admission), /dedicated/);
		save(file, manifest);
		assert.ok(binding.admitRenderedFixture(file, checkout, admission));
		for (const input of [
			path.join(contract.sync, 'maestro-sessions.json'),
			path.join(contract.root, 'authority-artifact.json'),
		]) {
			const bytes = fs.readFileSync(input);
			fs.appendFileSync(input, '\n');
			assert.throws(() => binding.admitRenderedFixture(file, checkout, admission));
			assert.equal(binding.sha(contract.db), before);
			fs.writeFileSync(input, bytes);
		}
		assert.ok(binding.admitRenderedFixture(file, checkout, admission));
	}
);

test('authority Git allowance contains only the exact review reads and never a mutation or external diff helper', () => {
	const { isAuthorityGitRead } = require('./board-rendered-boundary.cjs');
	const sha = 'a'.repeat(40);
	assert.ok(isAuthorityGitRead(['status', '--porcelain', '--untracked-files=normal']));
	assert.ok(isAuthorityGitRead(['diff', '--binary', '--no-ext-diff', sha, sha, '--']));
	for (const args of [
		['reset', '--hard'],
		['push'],
		['status'],
		['diff', '--binary', '--ext-diff', sha, sha, '--'],
		['diff', '--binary', '--no-ext-diff', '--output=/tmp/x', sha, '--'],
		['diff', '--binary', '--no-ext-diff', sha, sha, '--', '/tmp'],
	])
		assert.equal(isAuthorityGitRead(args), false);
});
