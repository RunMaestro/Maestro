// Materialize a fresh fixture and bind it to the current executable build. No native launch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const binding = require('./board-rendered-contract.cjs');
const checkout = path.resolve(__dirname, '..');

function main() {
	assert.equal(fs.realpathSync(process.cwd()), checkout);
	assert.ok(process.argv.length === 4 || process.argv.length === 5);
	if (process.argv.length === 5)
		assert.ok(['--create-worker', '--authority'].includes(process.argv[4]));
	assert.ok(['0', '100', '500'].includes(process.argv[2]));
	const buildPath = path.join(checkout, 'dist/board-rendered-build.json');
	const build = JSON.parse(fs.readFileSync(buildPath));
	assert.deepEqual(
		binding.renderedFingerprints(checkout),
		build.files,
		'Source/build changed; build first'
	);
	const addon = path.resolve(process.argv[3]);
	assert.equal(fs.realpathSync(addon), addon);
	assert.ok(addon.startsWith(checkout + path.sep), 'Addon must belong to this checkout');
	const electron = fs.realpathSync(
		path.join(
			checkout,
			'node_modules/electron/dist',
			process.platform === 'win32' ? 'electron.exe' : 'electron'
		)
	);
	assert.equal(process.platform, 'linux', 'Rendered Git probe currently supports Linux only');
	const git = fs.realpathSync('/usr/bin/git');
	const parentEnv = Object.fromEntries(
		['PATH', 'SystemRoot', 'WINDIR']
			.filter((key) => process.env[key])
			.map((key) => [key, process.env[key]])
	);
	process.umask(0o077);
	const isolatedParent = path.join(checkout, 'isolated');
	if (!fs.existsSync(isolatedParent)) fs.mkdirSync(isolatedParent, { mode: 0o700 });
	assert.equal(fs.realpathSync(isolatedParent), isolatedParent);
	const preparedPath = cp
		.execFileSync(process.execPath, ['scripts/board-performance-prepare.cjs', process.argv[2]], {
			cwd: checkout,
			env: parentEnv,
			encoding: 'utf8',
			timeout: 30000,
		})
		.trim();
	const prepared = JSON.parse(fs.readFileSync(preparedPath));
	const { contract } = prepared;
	binding.assertPrivateRoot(contract.root);
	const env = {
		...prepared.env,
		XDG_CACHE_HOME: path.join(contract.root, 'xdg/cache'),
		XDG_DATA_HOME: path.join(contract.root, 'xdg/data'),
	};
	for (const key of ['XDG_CACHE_HOME', 'XDG_DATA_HOME'])
		fs.mkdirSync(env[key], { recursive: true });
	Object.assign(process.env, env);
	// Match real Store defaults before binding bytes, so native initialization cannot
	// silently add settings keys and invalidate the immutable catalog contract.
	const settingsFile = path.join(contract.sync, 'maestro-settings.json');
	const { SETTINGS_DEFAULTS } = require('../dist/main/stores/defaults.js');
	const settings = { ...SETTINGS_DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile)) };
	if (process.argv[4] === '--authority')
		settings.encoreFeatures = { ...settings.encoreFeatures, maestroCue: true };
	fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
	const admission = require('../dist/main/board/board-isolation.js');
	admission.requireBoardIsolation({ expected: contract });
	const { sessions, sources } = admission.readBoardIsolationRegistries(contract);
	const { openBoardDb } = require('../dist/main/board/board-db.js');
	const storage = require('../dist/main/board/board-storage.js');
	const {
		planBoardMigration,
		applyBoardMigration,
		boardMigrationSourceKey,
	} = require('../dist/main/board/board-migration.js');
	const { BOARD_CONFIG_PATH } = require('../dist/shared/maestro-paths.js');
	const db = openBoardDb(contract.db);
	try {
		for (const source of sources) {
			cp.execFileSync(git, ['-c', 'init.templateDir=', 'init', '-q', source.root], {
				cwd: checkout,
				env: parentEnv,
				timeout: 5000,
			});
			const file = path.join(source.root, BOARD_CONFIG_PATH);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const boardBytes = Buffer.from('version: 1\nboards: []\n');
			fs.writeFileSync(file, boardBytes, { flag: 'wx' });
			const identity = { location: { kind: 'local' }, path: source.root };
			applyBoardMigration(
				db,
				planBoardMigration({
					source: identity,
					repository: {
						id: `source:${boardMigrationSourceKey(identity)}`,
						workingDirectory: source.root,
						validated: true,
						location: identity.location,
					},
					boardBytes,
					profileBytes: null,
					workers: [],
				})
			);
		}
		const groups = JSON.parse(
			fs.readFileSync(path.join(contract.sync, 'maestro-groups.json'))
		).groups;
		storage.configureBoardCaptureHost(() => ({ agents: sessions, groups }));
		const facade = new storage.BoardStorageFacade(db);
		const catalog = facade.captureCatalog();
		assert.deepEqual(
			[catalog.agents.length, catalog.groups.length, catalog.repositories.length],
			[100, 20, 50]
		);
		assert.equal(db.prepare('SELECT count(*) AS n FROM migrations').get().n, 50);
		assert.equal(db.prepare('SELECT count(*) AS n FROM board_source_locations').get().n, 50);
		assert.equal(db.prepare('SELECT count(*) AS n FROM cards').get().n, prepared.counts.cards);
		assert.equal(db.prepare('SELECT count(*) AS n FROM workers').get().n, 0);
		assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
	} finally {
		db.close();
	}
	if (process.argv[4] === '--authority') {
		fs.copyFileSync(
			contract.agentRegistry,
			path.join(contract.sync, 'maestro-sessions.json'),
			fs.constants.COPYFILE_EXCL
		);
		const cwd = sources[0].root;
		const gitRun = (...args) =>
			cp.execFileSync(git, args, {
				cwd,
				env: parentEnv,
				timeout: 5000,
				encoding: 'utf8',
			});
		gitRun('add', '--', '.maestro/board.yaml');
		gitRun(
			'-c',
			'user.name=Fixture',
			'-c',
			'user.email=fixture@example.invalid',
			'-c',
			'core.hooksPath=/dev/null',
			'commit',
			'-qm',
			'Fixture baseline'
		);
		const baseCommit = gitRun('rev-parse', 'HEAD').trim();
		fs.writeFileSync(path.join(cwd, 'authority.txt'), 'Owned authority fixture change\n', {
			flag: 'wx',
		});
		gitRun('add', '--', 'authority.txt');
		gitRun(
			'-c',
			'user.name=Fixture',
			'-c',
			'user.email=fixture@example.invalid',
			'-c',
			'core.hooksPath=/dev/null',
			'commit',
			'-qm',
			'Fixture work artifact'
		);
		fs.writeFileSync(
			path.join(contract.root, 'authority-artifact.json'),
			JSON.stringify({ baseCommit }) + '\n',
			{ flag: 'wx', mode: 0o600 }
		);
	}
	// Bind the final env as well as the exact registry bytes (not just path/count claims).
	prepared.env = env;
	fs.writeFileSync(preparedPath, JSON.stringify(prepared, null, 2) + '\n');
	const manifestPath = path.join(contract.root, 'rendered.json');
	fs.writeFileSync(
		manifestPath,
		JSON.stringify(
			{
				schemaVersion: 1,
				checkout,
				head: build.head,
				...(process.argv[4] === '--create-worker' && {
					creation: binding.workerCreationRequest(contract, { sources }),
				}),
				...(process.argv[4] === '--authority' && { authority: binding.authorityRequest(contract) }),
				contract,
				env,
				entry: binding.entry,
				renderer: binding.renderer,
				preload: binding.preload,
				files: build.files,
				preparedSha256: binding.sha(preparedPath),
				databaseSha256: binding.sha(contract.db),
				registries: binding.registryFingerprints(contract),
				electron,
				addon,
				git,
				binaries: {
					[electron]: binding.sha(electron),
					[addon]: binding.sha(addon),
					[git]: binding.sha(git),
				},
				nativeExecuted: false,
			},
			null,
			2
		) + '\n',
		{ flag: 'wx' }
	);
	binding.admitRenderedFixture(manifestPath, checkout, admission);
	console.log(manifestPath);
}

try {
	main();
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}
