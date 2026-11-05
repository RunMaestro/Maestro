// Real fixture admission/filesystem; fake Xvfb/Electron/CDP. No native acceptance.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { pathToFileURL } = require('node:url');
const binding = require('./board-rendered-contract.cjs');
const { runRenderedLifecycle, qualifyBindings } = require('./board-rendered-launch.cjs');
const { startRenderedObserver } = require('./board-rendered-observer.cjs');
const checkout = path.resolve(__dirname, '..');

function fixture(t) {
	const isolated = path.join(checkout, 'isolated');
	fs.mkdirSync(isolated, { recursive: true, mode: 0o700 });
	const directory = fs.mkdtempSync(path.join(isolated, 'board-launch-test-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const activeAddon = path.join(directory, 'active.node');
	const addon = path.join(directory, 'electron.node');
	fs.writeFileSync(activeAddon, 'disposable node binding');
	fs.writeFileSync(addon, 'disposable electron binding');
	const originalLink = path.join(directory, 'original-hardlink.node');
	fs.linkSync(activeAddon, originalLink);
	const manifestPath = cp
		.execFileSync(process.execPath, ['scripts/board-rendered-prepare.cjs', '0', addon], {
			cwd: checkout,
			env: { PATH: process.env.PATH },
			encoding: 'utf8',
			timeout: 30000,
		})
		.trim();
	const manifest = JSON.parse(fs.readFileSync(manifestPath));
	const root = manifest.contract.root;
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return {
		activeAddon,
		addon,
		originalLink,
		root,
		manifest,
		manifestPath,
		nodeSha256: binding.sha(activeAddon),
		electronSha256: binding.sha(addon),
		prepare: async () => manifestPath,
	};
}

function processes(t, context, mode) {
	let pid = 800000;
	const calls = [],
		stopped = [],
		swept = [];
	const io = {
		calls,
		stopped,
		swept,
		pickFreePort: async (host) => {
			assert.equal(host, '127.0.0.1');
			return 45678;
		},
		snapshotProcessTree: () => ({
			owned: true,
			descendants: [{ pid: 800099, startedAt: 'fixture' }],
		}),
		refreshProcessTree: async (_pid, tree) => tree,
		descendantsExited: () => mode !== 'descendant-survives',
		killSurvivors: (entries) => {
			swept.push(entries);
		},
		stopProcess: ({ child }, options) => {
			stopped.push({ child, options });
			if (mode === 'never-close' && calls[1]?.child === child) return;
			if (mode === 'late-electron-error' && calls[1]?.child === child) {
				setTimeout(() => {
					assert.equal(binding.sha(context.activeAddon), context.electronSha256);
					child.finish(null, 'SIGKILL');
				}, 20);
				return;
			}
			if (child.exitCode === null && child.signalCode === null) child.finish(null, 'SIGKILL');
		},
		targets: async () => [
			{
				type: 'page',
				id: 'owned',
				url: pathToFileURL(path.join(checkout, binding.renderer)).href,
				webSocketDebuggerUrl: `ws://${mode === 'foreign-cdp' ? 'example.invalid' : '127.0.0.1'}:45678/devtools/page/owned`,
			},
		],
		spawn(executable, args, options) {
			if (mode === 'spawn-throw') throw Error('spawn refused');
			const child = new EventEmitter();
			Object.assign(child, {
				pid: ++pid,
				exitCode: null,
				signalCode: null,
				stdio: [null, null, null, new PassThrough()],
				finish(code, signal = null) {
					child.exitCode = code;
					child.signalCode = signal;
					child.emit('exit', code, signal);
					child.emit('close', code, signal);
				},
			});
			calls.push({ executable, args, options, child });
			setImmediate(() => {
				child.emit('spawn');
				if (mode === 'spawn-error') {
					child.emit('error', Error('spawn ENOENT'));
					return;
				}
				if (executable === '/usr/bin/Xvfb') {
					child.stdio[3].write(mode === 'bad-display' ? 'wrong\n' : '12');
					if (mode !== 'bad-display') child.stdio[3].write('3\n');
					return;
				}
				if (mode === 'late-electron-error' || mode === 'never-close') {
					child.emit('error', Error('running child error'));
					return;
				}
				if (mode === 'early-exit') {
					child.finish(3);
					return;
				}
				if (mode === 'never-ready') return;
				fs.writeFileSync(
					path.join(context.root, 'rendered-run.lock'),
					context.manifest.contract.identity,
					{ flag: 'wx' }
				);
				const { DatabaseSync } = require('node:sqlite');
				const db = new DatabaseSync(context.manifest.contract.db);
				const persistence = binding.persistenceSnapshot({
					prepare: (sql) => db.prepare(sql),
					pragma: () => db.prepare('PRAGMA user_version').get().user_version,
				});
				db.close();
				const host = {
					head: context.manifest.head,
					contract: context.manifest.contract,
					ready: true,
					nativeAcceptance: false,
					persistence,
					databaseClosed: true,
				};
				fs.writeFileSync(path.join(context.root, 'rendered-host.json'), JSON.stringify(host));
				const stop = startRenderedObserver(
					context.root,
					{ begin() {}, end: () => [{ name: 'board:query', ms: 4 }] },
					(code, error) => {
						stop();
						if (error) host.error = String(error);
						fs.writeFileSync(path.join(context.root, 'rendered-host.json'), JSON.stringify(host));
						child.finish(code);
					}
				);
				t.after(stop);
			});
			return child;
		},
	};
	return io;
}

test(
	'owns exact launch, observer finish, detached cleanup and hardlink-safe addon restoration',
	{ timeout: 30000 },
	async (t) => {
		const context = fixture(t);
		const io = processes(t, context);
		const originalEnvironment = { ...process.env };
		context.exercise = async ({ root, cdpUrl, observe }) => {
			assert.equal(root, context.root);
			assert.equal(cdpUrl, 'http://127.0.0.1:45678');
			assert.equal(binding.sha(context.activeAddon), context.electronSha256);
			assert.equal(binding.sha(context.originalLink), context.nodeSha256);
			await observe('begin');
			assert.deepEqual((await observe('end')).records, [{ name: 'board:query', ms: 4 }]);
		};
		const result = await runRenderedLifecycle(context, io);
		assert.equal(result.lifecyclePassed, true);
		assert.equal(result.nativeAcceptance, false);
		assert.equal(result.addonRestored, true);
		assert.equal(result.ownedChildrenExited, true);
		assert.deepEqual(result.cleanupErrors, []);
		assert.equal(binding.sha(context.activeAddon), context.nodeSha256);
		assert.equal(binding.sha(context.originalLink), context.nodeSha256);
		assert.ok(require('node:util').isDeepStrictEqual({ ...process.env }, originalEnvironment));
		assert.equal(fs.existsSync(`${context.activeAddon}.board-rendered-lock`), false);
		assert.equal(io.calls.length, 2);
		for (const call of io.calls) {
			assert.equal(call.options.cwd, checkout);
			assert.equal(call.options.detached, true);
			assert.equal(call.options.shell, false);
			assert.equal(call.options.env.HOME, undefined);
			assert.equal(call.options.env.NODE_OPTIONS, undefined);
		}
		const electron = io.calls[1];
		assert.equal(electron.executable, context.manifest.electron);
		assert.deepEqual(electron.options.env, result.launch.env);
		assert.deepEqual(electron.args, [
			path.join(checkout, binding.entry),
			context.manifestPath,
			'--remote-debugging-port=45678',
			'--remote-debugging-address=127.0.0.1',
			'--disable-background-networking',
			'--disable-component-update',
			'--disable-gpu',
			'--password-store=basic',
		]);
		assert.equal(electron.options.env.DISPLAY, ':123');
		assert.equal(io.stopped.length, 2);
		assert.equal(io.swept.length, 2);
		assert.equal(result.processes.find((p) => p.label === 'electron').exit.code, 0);
		assert.equal(
			JSON.parse(fs.readFileSync(path.join(context.root, 'rendered-launch.json'))).lifecyclePassed,
			true
		);
	}
);

test(
	'reopens the same DB with a fresh parent identity and refuses changed bindings or competing reuse',
	{ timeout: 120000 },
	async (t) => {
		const context = fixture(t);
		const first = await runRenderedLifecycle(context, processes(t, context));
		const originalRoot = context.root;
		const admission = require('../dist/main/board/board-isolation.js');
		const prepare = (receipt = first) =>
			binding.prepareRenderedReopen(receipt, checkout, admission);
		const before = binding.sha(first.contract.db);
		for (const key of ['lifecyclePassed', 'addonRestored', 'ownedChildrenExited']) {
			const file = path.join(originalRoot, 'rendered-launch.json');
			const bytes = fs.readFileSync(file);
			fs.writeFileSync(file, JSON.stringify({ ...first, [key]: false }));
			assert.throws(() => prepare());
			fs.writeFileSync(file, bytes);
		}
		assert.throws(() =>
			prepare({ ...first, contract: { ...first.contract, root: originalRoot + '-changed' } })
		);
		assert.throws(
			() =>
				prepare({
					...first,
					contract: { ...first.contract, db: path.join(originalRoot, 'other.sqlite') },
				}),
			/parent receipt differs/
		);
		for (const file of [
			first.contract.db,
			first.contract.agentRegistry,
			first.contract.sourceRegistry,
			path.join(first.contract.sync, 'maestro-groups.json'),
			path.join(first.contract.sync, 'maestro-settings.json'),
		]) {
			fs.appendFileSync(file, '\n');
			assert.throws(() => prepare());
			fs.truncateSync(file, fs.statSync(file).size - 1);
		}
		// Equal bytes at a replaced inode do not authorize a different database.
		const displaced = first.contract.db + '.original';
		fs.renameSync(first.contract.db, displaced);
		fs.copyFileSync(displaced, first.contract.db);
		assert.throws(() => prepare(), /database changed/);
		fs.unlinkSync(first.contract.db);
		fs.renameSync(displaced, first.contract.db);
		const originalManifest = fs.readFileSync(context.manifestPath);
		const altered = structuredClone(context.manifest);
		altered.files[binding.renderer] = 'changed';
		fs.writeFileSync(context.manifestPath, JSON.stringify(altered));
		assert.throws(() => prepare(), /source\/build changed/);
		fs.writeFileSync(context.manifestPath, originalManifest);
		const secondPath = prepare();
		const second = JSON.parse(fs.readFileSync(secondPath));
		assert.notEqual(second.contract.identity, first.contract.identity);
		assert.deepEqual({ ...second.contract, identity: first.contract.identity }, first.contract);
		assert.equal(binding.sha(first.contract.db), before);
		assert.throws(() => prepare(), /EEXIST/);
		const env = admission.boardIsolationChildEnv(second.contract, second.env);
		assert.ok(binding.admitRenderedFixture(secondPath, checkout, admission, env));
		assert.throws(
			() =>
				binding.admitRenderedFixture(secondPath, checkout, admission, {
					...env,
					BOARD_ISOLATION_CONTRACT: JSON.stringify(first.contract),
				}),
			/Missing parent contract/
		);
		context.manifestPath = secondPath;
		context.manifest = second;
		context.root = binding.renderedRunRoot(second);
		context.prepare = async () => secondPath;
		const reopened = await runRenderedLifecycle(context, processes(t, context));
		assert.equal(reopened.lifecyclePassed, true);
		assert.equal(reopened.addonRestored, true);
		assert.equal(reopened.ownedChildrenExited, true);
		assert.deepEqual(reopened.database, first.database);
		await assert.rejects(runRenderedLifecycle(context, processes(t, context)), /Consumed fixture/);
		assert.equal(binding.sha(context.activeAddon), context.nodeSha256);
	}
);

for (const mode of [
	'spawn-throw',
	'spawn-error',
	'bad-display',
	'early-exit',
	'late-electron-error',
	'foreign-cdp',
	'never-ready',
	'scenario-failure',
	'active-observer',
]) {
	test(`restores and releases owned resources after ${mode}`, { timeout: 30000 }, async (t) => {
		const context = fixture(t);
		const io = processes(t, context, mode);
		if (mode === 'never-ready') context.timeoutMs = 13000;
		if (mode === 'scenario-failure')
			context.exercise = async () => {
				throw Error('scenario failed');
			};
		if (mode === 'active-observer')
			context.exercise = async ({ observe }) => {
				await observe('begin');
			};
		await assert.rejects(runRenderedLifecycle(context, io), /Rendered launcher failed/);
		assert.equal(binding.sha(context.activeAddon), context.nodeSha256);
		assert.equal(binding.sha(context.originalLink), context.nodeSha256);
		assert.equal(fs.existsSync(`${context.activeAddon}.board-rendered-lock`), false);
		assert.ok(io.calls.every(({ child }) => child.exitCode !== null || child.signalCode !== null));
		const result = JSON.parse(fs.readFileSync(path.join(context.root, 'rendered-launch.json')));
		assert.equal(result.addonRestored, true);
		assert.equal(result.lifecyclePassed, false);
		assert.equal(result.nativeAcceptance, false);
	});
}

test(
	'releases pre-launch failure lease and refuses contention or consumed manifests without addon writes',
	{ timeout: 30000 },
	async (t) => {
		const context = fixture(t);
		const io = processes(t, context);
		await assert.rejects(
			runRenderedLifecycle(
				{
					...context,
					prepare: async () => {
						throw Error('prepare failed');
					},
				},
				io
			),
			/prepare failed/
		);
		assert.equal(fs.existsSync(`${context.activeAddon}.board-rendered-lock`), false);
		const lease = `${context.activeAddon}.board-rendered-lock`;
		fs.mkdirSync(lease);
		await assert.rejects(runRenderedLifecycle(context, io), /EEXIST/);
		assert.equal(fs.existsSync(lease), true);
		fs.rmdirSync(lease);
		fs.writeFileSync(path.join(context.root, 'rendered-run.lock'), 'already consumed');
		await assert.rejects(runRenderedLifecycle(context, io), /Consumed fixture/);
		assert.equal(io.calls.length, 0);
		assert.equal(binding.sha(context.activeAddon), context.nodeSha256);
		assert.equal(fs.existsSync(lease), false);
	}
);

test(
	'fails closed on changed binding qualification, version and missing positive evidence',
	{ timeout: 30000 },
	(t) => {
		const context = fixture(t);
		const qualificationPath = path.join(path.dirname(context.activeAddon), 'checks.json');
		const evidence = {
			attempts: [
				{
					task: 'R14b',
					exit: 0,
					passed: 6,
					failed: 0,
					positiveFacade: true,
					positiveBundledChild: true,
					nodeAddonSha256: context.nodeSha256,
					electronAddonSha256: context.electronSha256,
				},
				{
					task: 'R15b',
					exit: 0,
					electronAbi: 145,
					nodeAbi: 137,
					electron: require('../node_modules/electron/package.json').version,
					restoredNodeAddonSha256: context.nodeSha256,
					electronAddonSha256: context.electronSha256,
				},
			],
		};
		const qualify = () => qualifyBindings(context.activeAddon, context.addon, qualificationPath);
		fs.writeFileSync(qualificationPath, JSON.stringify(evidence));
		assert.deepEqual(qualify(), {
			nodeSha256: context.nodeSha256,
			electronSha256: context.electronSha256,
		});
		for (const change of [
			(e) => {
				e.attempts[0].positiveFacade = false;
			},
			(e) => {
				e.attempts[0].nodeAddonSha256 = 'changed';
			},
			(e) => {
				e.attempts[1].electronAbi = 137;
			},
			(e) => {
				e.attempts[1].electron = '0.0.0';
			},
			(e) => {
				e.attempts[1].exit = 1;
			},
		]) {
			const altered = structuredClone(evidence);
			change(altered);
			fs.writeFileSync(qualificationPath, JSON.stringify(altered));
			assert.throws(qualify);
		}
	}
);

for (const mode of ['never-close', 'descendant-survives']) {
	test(`retains lease and backup when ${mode}`, { timeout: 30000 }, async (t) => {
		const context = fixture(t);
		const io = processes(t, context, mode);
		if (mode === 'descendant-survives')
			context.exercise = async () => {
				throw Error('exercise failure');
			};
		await assert.rejects(runRenderedLifecycle(context, io), /Rendered launcher failed/);
		const lease = `${context.activeAddon}.board-rendered-lock`;
		const receipt = JSON.parse(fs.readFileSync(path.join(context.root, 'rendered-launch.json')));
		assert.equal(receipt.ownedChildrenExited, false);
		assert.equal(receipt.addonRestored, false);
		assert.equal(binding.sha(context.activeAddon), context.electronSha256);
		assert.equal(
			binding.sha(path.join(context.root, 'launcher-node-abi137.node')),
			context.nodeSha256
		);
		assert.ok(fs.existsSync(path.join(lease, 'recovery.json')));
		await assert.rejects(runRenderedLifecycle(context, io), /EEXIST/);
		assert.ok(fs.existsSync(lease));
	});
}
