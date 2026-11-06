// Prepare separately from execution. This probe never attaches to an installed desktop.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { once } = require('node:events');

const checkout = path.resolve(__dirname, '..');
const entry = 'src/__tests__/integration/fixtures/board-native-entry.cjs';
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git = (...args) => cp.execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

function fingerprints() {
	const source = [
		...new Set([
			...git(
				'ls-files',
				'src/main',
				'src/shared',
				'src/types',
				'tsconfig.main.json',
				'scripts/build-preload.mjs',
				'scripts/gen-build-info.mjs',
				'package.json',
				'package-lock.json'
			).split('\n'),
			'scripts/board-native-probe.cjs',
			entry,
		]),
	].sort();
	const build = ['main', 'shared', 'types']
		.filter((dir) => fs.existsSync(path.join(checkout, 'dist', dir)))
		.flatMap((dir) =>
			fs
				.readdirSync(path.join(checkout, 'dist', dir), { recursive: true, withFileTypes: true })
				.filter((item) => item.isFile())
				.map((item) => path.relative(checkout, path.join(item.parentPath, item.name)))
		)
		.sort();
	return Object.fromEntries(
		[...source, ...build].map((file) => [file, sha(path.join(checkout, file))])
	);
}

function foundation(checks) {
	const control = checks.attempts.findLast((item) => item.task === 'R14b');
	const sources = checks.attempts.findLast((item) => item.task === 'R15a');
	assert.ok(
		control?.exit === 0 &&
			control.passed === 6 &&
			control.failed === 0 &&
			control.positiveFacade === true &&
			control.positiveBundledChild === true,
		'R14b controls must pass'
	);
	assert.ok(
		sources?.exit === 0 && sources.summary.passed === 9 && sources.summary.failed === 0,
		'R15a source/transport controls must pass'
	);
	for (const head of [control.head, sources.head ?? checks.headBefore]) {
		assert.match(head, /^[a-f0-9]{40}$/);
		// A harness-only commit does not invalidate unchanged product/test qualification.
		git(
			'diff',
			'--exit-code',
			head,
			'--',
			'src/main',
			'src/shared',
			'src/types',
			'src/__tests__/main/board',
			'src/__tests__/setup.ts',
			'src/__tests__/helpers',
			'vitest.config.mts',
			'tsconfig.main.json',
			'package.json',
			'package-lock.json'
		);
	}
	return control;
}

async function main() {
	assert.equal(process.platform, 'linux', 'This bounded Xvfb launcher currently supports Linux');
	assert.equal(fs.realpathSync(checkout), checkout);
	assert.equal(fs.realpathSync(process.cwd()), checkout);
	assert.equal(git('rev-parse', '--show-toplevel'), checkout);
	const args = process.argv.slice(2);
	if (args[0] === '--prepare') {
		assert.equal(args.length, 3, 'Usage: --prepare CHECKS.json ELECTRON_ABI145.node');
		const checksPath = fs.realpathSync(path.resolve(args[1]));
		const checks = read(checksPath);
		const controls = foundation(checks);
		// Refuse shared/symlinked build output or dependencies before the existing build can write.
		for (const dir of [
			'dist',
			'dist/main',
			'dist/shared',
			'dist/types',
			'node_modules',
			'node_modules/better-sqlite3',
			'node_modules/electron',
		]) {
			const target = path.join(checkout, dir);
			if (fs.existsSync(target)) assert.equal(fs.realpathSync(target), target);
		}
		cp.execFileSync('npm', ['run', 'build:main'], {
			cwd: checkout,
			stdio: 'inherit',
			timeout: 180000,
		});
		const admission = require('../dist/main/board/board-isolation.js');
		const { isPathWithin } = require('../dist/main/utils/real-path-containment.js');
		const addon = fs.realpathSync(path.resolve(args[2]));
		const activeAddon = fs.realpathSync(
			path.join(checkout, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node')
		);
		assert.ok(isPathWithin(addon, checkout) && isPathWithin(activeAddon, checkout));
		assert.equal(sha(addon), controls.electronAddonSha256);
		assert.equal(sha(activeAddon), controls.nodeAddonSha256, 'Preserve the qualified Node binding');
		const root = path.join(checkout, 'isolated', `board-native-${crypto.randomUUID()}`);
		const env = {
			BOARD_ISOLATION_ID: path.basename(root),
			BOARD_ISOLATED_ROOT: root,
			BOARD_DB_PATH: path.join(root, 'db/board.sqlite'),
			MAESTRO_USER_DATA: path.join(root, 'userdata'),
			BOARD_SYNC_PATH: path.join(root, 'sync'),
			BOARD_AGENT_REGISTRY: path.join(root, 'registry/agents.json'),
			BOARD_SOURCE_REGISTRY: path.join(root, 'registry/sources.json'),
			BOARD_SOURCE_ROOT: path.join(root, 'sources'),
			MAESTRO_DEMO_DIR: path.join(root, 'userdata'),
			NODE_ENV: 'test',
			MAESTRO_E2E_TEST: 'true',
			MAESTRO_DISABLE_CUE_TELEMETRY: '1',
			MAESTRO_DISABLE_GROUP_CHAT_PROVIDERS: '1',
			HOME: path.join(root, 'home'),
			XDG_CONFIG_HOME: path.join(root, 'home/config'),
			XDG_CACHE_HOME: path.join(root, 'home/cache'),
			XDG_DATA_HOME: path.join(root, 'home/data'),
			TMPDIR: path.join(root, 'tmp'),
			PATH: path.join(root, 'bin'),
		};
		// Admission validates the canonical checkout/backlink and every proposed leaf before mkdir.
		const contract = admission.requireBoardIsolation({ env, worktree: checkout });
		const repository = path.join(contract.sourceRoot, 'repository');
		const registries = { sessions: [], sources: [{ id: 'native-local-source', root: repository }] };
		admission.assertBoardIsolationRegistrations(contract, registries);
		for (const directory of [
			root,
			contract.userData,
			contract.sync,
			path.dirname(contract.db),
			path.dirname(contract.agentRegistry),
			repository,
			env.HOME,
			env.XDG_CONFIG_HOME,
			env.XDG_CACHE_HOME,
			env.XDG_DATA_HOME,
			env.TMPDIR,
			env.PATH,
		])
			fs.mkdirSync(directory, { recursive: true });
		write(contract.agentRegistry, { sessions: [] });
		write(contract.sourceRegistry, { sources: registries.sources });
		admission.readBoardIsolationRegistries(contract, env);
		const { ENCORE_FEATURE_DEFAULTS } = require('../dist/shared/encoreFeatureDefaults.js');
		write(path.join(contract.sync, 'maestro-settings.json'), {
			encoreFeatures: Object.fromEntries(
				Object.keys(ENCORE_FEATURE_DEFAULTS).map((key) => [key, key === 'board'])
			),
			crashReportingEnabled: false,
			disableGpuAcceleration: true,
			wakatimeEnabled: false,
			sshRemotes: [],
			checkForUpdatesOnStartup: false,
		});
		cp.execFileSync('/usr/bin/git', ['init', '-q', repository], { env });
		fs.symlinkSync('/usr/bin/git', path.join(env.PATH, 'git'));
		const manifest = path.join(root, 'prepared.json');
		const electron = fs.realpathSync(path.join(checkout, 'node_modules/electron/dist/electron'));
		assert.ok(isPathWithin(electron, checkout));
		write(manifest, {
			schemaVersion: 1,
			head: git('rev-parse', 'HEAD'),
			checkout,
			contract,
			env,
			checksPath,
			checksSha256: sha(checksPath),
			files: fingerprints(),
			repository,
			electron,
			electronSha256: sha(electron),
			addon,
			addonSha256: sha(addon),
			activeAddon,
			nodeAddonSha256: sha(activeAddon),
			entry,
			nativeExecuted: false,
			isolationAccepted: false,
		});
		console.log(
			`Prepared only. Execute separately: timeout 300s node scripts/board-native-probe.cjs --run ${manifest}`
		);
		return;
	}
	assert.equal(
		args[0],
		'--run',
		'Use --prepare CHECKS.json ELECTRON_ABI145.node or --run prepared.json'
	);
	assert.equal(args.length, 2);
	const manifestPath = fs.realpathSync(path.resolve(args[1]));
	const manifest = read(manifestPath);
	assert.equal(manifest.checkout, checkout);
	assert.deepEqual(
		fingerprints(),
		manifest.files,
		'Source or compiled build changed; prepare again'
	);
	assert.equal(sha(manifest.checksPath), manifest.checksSha256);
	const controls = foundation(read(manifest.checksPath));
	assert.equal(
		manifest.electron,
		fs.realpathSync(path.join(checkout, 'node_modules/electron/dist/electron'))
	);
	assert.equal(
		manifest.activeAddon,
		fs.realpathSync(
			path.join(checkout, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node')
		)
	);
	assert.equal(manifest.addonSha256, controls.electronAddonSha256);
	assert.equal(manifest.nodeAddonSha256, controls.nodeAddonSha256);
	assert.equal(manifest.entry, entry);
	assert.equal(sha(manifest.electron), manifest.electronSha256);
	const admission = require('../dist/main/board/board-isolation.js');
	const contract = admission.requireBoardIsolation({
		env: manifest.env,
		expected: manifest.contract,
		worktree: checkout,
	});
	assert.equal(manifestPath, path.join(contract.root, 'prepared.json'));
	admission.readBoardIsolationRegistries(contract, manifest.env);
	assert.equal(sha(manifest.addon), manifest.addonSha256);
	assert.equal(sha(manifest.activeAddon), manifest.nodeAddonSha256);
	// node-gyp can hard-link Release to obj.target. Replace the directory entry atomically;
	// copying over that inode would also overwrite its other link (possibly outside this checkout).
	const selectAddon = (from) => {
		const temporary = `${manifest.activeAddon}.${crypto.randomUUID()}`;
		fs.copyFileSync(from, temporary, fs.constants.COPYFILE_EXCL);
		assert.equal(sha(temporary), sha(from));
		fs.renameSync(temporary, manifest.activeAddon);
	};
	const { stopProcess } = require('../dist/shared/maestro-lib/control/termination.js');
	const stop = (child) => stopProcess({ child }, { from: 'terminate', graceMs: 1000 });
	const backup = path.join(contract.root, 'node-abi137.node');
	fs.copyFileSync(manifest.activeAddon, backup, fs.constants.COPYFILE_EXCL);
	const xvfb = cp.spawn(
		'/usr/bin/Xvfb',
		['-displayfd', '3', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'],
		{ env: manifest.env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] }
	);
	let child;
	const deadline = setTimeout(() => {
		if (child) stop(child);
		stop(xvfb);
	}, 260000);
	try {
		const display = await Promise.race([
			once(xvfb.stdio[3], 'data').then(([bytes]) => String(bytes).trim()),
			once(xvfb, 'exit').then(() => {
				throw new Error('Private Xvfb exited before display allocation');
			}),
		]);
		assert.match(display, /^\d+$/);
		selectAddon(manifest.addon);
		assert.equal(sha(manifest.activeAddon), manifest.addonSha256);
		const outcomes = [];
		for (const phase of ['write', 'reopen']) {
			const log = fs.openSync(path.join(contract.root, `${phase}.log`), 'wx');
			try {
				child = cp.spawn(
					manifest.electron,
					[
						path.join(checkout, entry),
						manifestPath,
						phase,
						'--disable-background-networking',
						'--disable-component-update',
						'--disable-gpu',
						`--user-data-dir=${path.join(manifest.env.HOME, 'chromium')}`,
						'--password-store=basic',
					],
					{
						cwd: checkout,
						env: { ...manifest.env, DISPLAY: `:${display}` },
						stdio: ['ignore', log, log],
					}
				);
				const [code, signal] = await once(child, 'exit');
				outcomes.push({ phase, code, signal });
				assert.equal(code, 0, `${phase} failed; inspect ${phase}.log`);
				assert.equal(read(path.join(contract.root, `${phase}.json`)).passed, true);
			} finally {
				fs.closeSync(log);
			}
		}
		write(path.join(contract.root, 'native-result.json'), {
			head: git('rev-parse', 'HEAD'),
			files: manifest.files,
			contract,
			outcomes,
			nativeProbePassed: true,
			isolationAccepted: false,
		});
		console.log(`Native write/reopen passed: ${contract.root}/native-result.json`);
	} finally {
		clearTimeout(deadline);
		for (const owned of [child, xvfb]) {
			if (owned && owned.exitCode === null && owned.signalCode === null) {
				const exited = once(owned, 'exit');
				stop(owned);
				await exited;
			}
		}
		assert.equal(sha(backup), manifest.nodeAddonSha256);
		selectAddon(backup);
		assert.equal(sha(manifest.activeAddon), manifest.nodeAddonSha256);
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
