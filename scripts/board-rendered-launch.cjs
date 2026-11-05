// Owns one fresh fixture or its explicitly admitted second launch. Never attaches to the desktop.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { setTimeout: delay } = require('node:timers/promises');
const binding = require('./board-rendered-contract.cjs');
const checkout = path.resolve(__dirname, '..');

function system() {
	return {
		spawn: require('node:child_process').spawn,
		...require('../dist/shared/maestro-lib/control/termination.js'),
		...require('../dist/shared/maestro-lib/control/process-tree.js'),
		descendantsExited(entries) {
			const { parseProcStat } = require('../dist/shared/maestro-lib/control/process-tree.js');
			return entries.every(({ pid, startedAt }) => {
				try {
					const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
					const row = parseProcStat(stat);
					if (!row) return false;
					return (
						row.startedAt !== startedAt ||
						stat
							.slice(stat.lastIndexOf(')') + 1)
							.trim()
							.startsWith('Z ')
					);
				} catch (error) {
					if (error.code === 'ENOENT' || error.code === 'ESRCH') return true;
					throw error;
				}
			});
		},
		...require('../dist/main/utils/tcp-port.js'),
		async targets(port, signal) {
			const { fetchWithTimeout } = require('../dist/main/utils/fetchWithTimeout.js');
			const response = await fetchWithTimeout(
				`http://127.0.0.1:${port}/json/list`,
				{ signal, redirect: 'error' },
				1000
			);
			assert.ok(response.ok, 'CDP HTTP failure');
			return response.json();
		},
	};
}

function qualifyBindings(activeAddon, addon, qualificationPath) {
	assert.equal(Number(process.versions.modules), 137, 'Preparation requires Node ABI137');
	for (const file of [activeAddon, addon, qualificationPath]) {
		assert.equal(fs.realpathSync(file), file, 'Native evidence must be canonical');
		assert.ok(file.startsWith(checkout + path.sep), 'Native evidence must be checkout-local');
	}
	const evidence = JSON.parse(fs.readFileSync(qualificationPath));
	const node = evidence.attempts.findLast((item) => item.task === 'R14b');
	const electron = evidence.attempts.findLast((item) => item.task === 'R15b');
	assert.ok(node?.exit === 0 && node.passed === 6 && node.failed === 0);
	assert.ok(node.positiveFacade && node.positiveBundledChild);
	assert.ok(electron?.exit === 0 && electron.electronAbi === 145 && electron.nodeAbi === 137);
	assert.equal(electron.electron, require('../node_modules/electron/package.json').version);
	assert.equal(node.nodeAddonSha256, binding.sha(activeAddon), 'Unqualified active Node addon');
	assert.equal(electron.restoredNodeAddonSha256, node.nodeAddonSha256);
	assert.equal(node.electronAddonSha256, binding.sha(addon), 'Unqualified Electron addon');
	assert.equal(electron.electronAddonSha256, node.electronAddonSha256);
	assert.notEqual(node.nodeAddonSha256, node.electronAddonSha256);
	return { nodeSha256: node.nodeAddonSha256, electronSha256: node.electronAddonSha256 };
}

// Process/cleanup seam: tests use real admitted fixture bytes and disposable addon
// files, replacing only process and CDP operations. No test branch in the entry.
async function runRenderedLifecycle(context, io = system()) {
	const { activeAddon, nodeSha256, electronSha256, prepare } = context;
	const timeoutMs = context.timeoutMs ?? 300000;
	assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 10000 && timeoutMs <= 300000);
	const controller = new AbortController();
	const { signal } = controller;
	// Reserve ten seconds of the total budget for child cleanup and restoration.
	const timer = setTimeout(
		() => controller.abort(Error('Rendered launcher timed out')),
		timeoutMs - 10000
	);
	const interrupt = () => controller.abort(Error('Rendered launcher interrupted'));
	process.on('SIGINT', interrupt);
	process.on('SIGTERM', interrupt);
	const owned = [];
	const descriptors = [];
	const cleanupErrors = [];
	let manifestPath, manifest, root, backup, lock, receipt;
	let finishRequested = false;
	let lockAcquired = false;
	let backupVerified = false;
	let failure;
	const bounded = async (operation) => {
		signal.throwIfAborted();
		let abort;
		try {
			return await Promise.race([
				operation,
				new Promise((_, reject) => {
					abort = () => reject(signal.reason);
					signal.addEventListener('abort', abort, { once: true });
				}),
			]);
		} finally {
			signal.removeEventListener('abort', abort);
		}
	};
	const own = (label, executable, args, options) => {
		signal.throwIfAborted();
		const child = io.spawn(executable, args, { ...options, detached: true, shell: false });
		const state = { label, child, executable, args, tree: { owned: false, descendants: [] } };
		owned.push(state);
		state.closed = new Promise((resolve) => {
			child.once('error', (error) => {
				state.error = String(error);
				controller.abort(error);
				// A failed spawn has no PID. A later error on a running child
				// still requires close before its addon may be restored.
				if (!child.pid) {
					state.closeConfirmed = true;
					resolve();
				}
			});
			child.once('exit', (code, exitSignal) => {
				state.exit = { code, signal: exitSignal };
				if (label !== 'prepare' && !(label === 'electron' && finishRequested))
					controller.abort(Error(`${label} exited unexpectedly (${code}, ${exitSignal})`));
			});
			child.once('close', () => {
				state.closeConfirmed = true;
				resolve();
			});
		});
		child.once('spawn', () => {
			state.tree = io.snapshotProcessTree(child.pid);
		});
		return state;
	};
	const selectAddon = (from, expected) => {
		assert.equal(fs.realpathSync(activeAddon), activeAddon);
		assert.equal(binding.sha(from), expected);
		const temporary = `${activeAddon}.board-rendered-${process.pid}`;
		let created = false;
		try {
			// Replace the directory entry; never write through node-gyp's hard links.
			fs.copyFileSync(from, temporary, fs.constants.COPYFILE_EXCL);
			created = true;
			assert.equal(binding.sha(temporary), expected);
			fs.renameSync(temporary, activeAddon);
		} finally {
			if (created && fs.existsSync(temporary)) fs.unlinkSync(temporary);
		}
	};
	const log = (name) => {
		const fd = fs.openSync(path.join(root, name), 'wx', 0o600);
		descriptors.push(fd);
		return fd;
	};
	try {
		// The synchronous directory-lock utility cannot enclose async work. This
		// fixture-specific lease refuses contention; it never steals another run.
		lock = `${activeAddon}.board-rendered-lock`;
		fs.mkdirSync(lock, { mode: 0o700 });
		lockAcquired = true;
		assert.equal(binding.sha(activeAddon), nodeSha256, 'Active addon changed before preparation');
		manifestPath = await bounded(prepare(own, bounded));
		const admission = require('../dist/main/board/board-isolation.js');
		({ manifest } = binding.admitRenderedFixture(manifestPath, checkout, admission));
		root = binding.renderedRunRoot(manifest);
		for (const name of [
			'rendered-run.lock',
			'rendered-host.json',
			'rendered-launch.json',
			'observer-request.json',
			'observer-response.json',
		])
			assert.ok(!fs.existsSync(path.join(root, name)), `Consumed fixture: ${name}`);
		assert.equal(manifest.binaries[manifest.addon], electronSha256);
		receipt = {
			head: manifest.head,
			files: manifest.files,
			manifestPath,
			manifestSha256: binding.sha(manifestPath),
			contract: manifest.contract,
			nativeAcceptance: false,
			lifecyclePassed: false,
			addonRestored: false,
			qualified: { nodeSha256, electronSha256 },
			qualification: context.qualification,
		};
		backup = path.join(root, 'launcher-node-abi137.node');
		fs.copyFileSync(activeAddon, backup, fs.constants.COPYFILE_EXCL);
		assert.equal(binding.sha(backup), nodeSha256);
		backupVerified = true;
		const env = admission.boardIsolationChildEnv(manifest.contract, manifest.env);
		const xvfbLog = log('xvfb.log');
		const xvfb = own(
			'xvfb',
			'/usr/bin/Xvfb',
			['-displayfd', '3', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'],
			{ cwd: checkout, env, stdio: ['ignore', xvfbLog, xvfbLog, 'pipe'] }
		);
		let display = '';
		await bounded(
			new Promise((resolve, reject) => {
				xvfb.child.stdio[3].on('data', (bytes) => {
					display += bytes.toString();
					if (display.length > 32) return reject(Error('Invalid Xvfb display allocation'));
					if (display.includes('\n')) resolve();
				});
			})
		);
		assert.match(display, /^\d+\n$/);
		const childEnv = { ...env, DISPLAY: `:${display.trim()}` };
		binding.admitRenderedFixture(manifestPath, checkout, admission, childEnv);
		const port = await bounded(io.pickFreePort('127.0.0.1'));
		assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
		selectAddon(manifest.addon, electronSha256);
		const electronLog = log('electron.log');
		const args = [
			path.join(checkout, binding.entry),
			manifestPath,
			`--remote-debugging-port=${port}`,
			'--remote-debugging-address=127.0.0.1',
			'--disable-background-networking',
			'--disable-component-update',
			'--disable-gpu',
			'--password-store=basic',
		];
		const electron = own('electron', manifest.electron, args, {
			cwd: checkout,
			env: childEnv,
			stdio: ['ignore', electronLog, electronLog],
		});
		receipt.launch = {
			cwd: checkout,
			env: childEnv,
			args,
			electron: manifest.electron,
			port,
			display: childEnv.DISPLAY,
		};
		let target;
		while (!target) {
			signal.throwIfAborted();
			const hostPath = path.join(root, 'rendered-host.json');
			if (fs.existsSync(hostPath)) {
				let host;
				try {
					host = JSON.parse(fs.readFileSync(hostPath));
				} catch {
					/* writer may still be flushing */
				}
				if (host?.error) throw Error(host.error);
				if (host?.ready) {
					assert.equal(host.head, manifest.head);
					assert.deepEqual(host.contract, manifest.contract);
					let targets = [];
					try {
						targets = await bounded(io.targets(port, signal));
					} catch {
						signal.throwIfAborted();
					}
					target = targets.find(
						(item) =>
							item.type === 'page' &&
							item.url === pathToFileURL(path.join(checkout, binding.renderer)).href
					);
					if (target) {
						const ws = new URL(target.webSocketDebuggerUrl);
						assert.equal(ws.protocol, 'ws:');
						assert.equal(ws.hostname, '127.0.0.1');
						assert.equal(Number(ws.port), port);
						assert.equal(ws.pathname, `/devtools/page/${target.id}`);
					}
				}
			}
			if (!target) await delay(20, undefined, { signal });
		}
		electron.tree = io.snapshotProcessTree(electron.child.pid);
		receipt.target = target;
		let id = 0;
		const observe = async (action) => {
			assert.ok(['begin', 'end', 'finish'].includes(action));
			const request = path.join(root, 'observer-request.json');
			const temporary = `${request}.launcher`;
			fs.writeFileSync(temporary, JSON.stringify({ id: ++id, action }) + '\n', {
				flag: 'wx',
				mode: 0o600,
			});
			fs.renameSync(temporary, request);
			while (true) {
				const response = path.join(root, 'observer-response.json');
				if (fs.existsSync(response)) {
					admission.assertBoardIsolationPath(manifest.contract, response);
					const reply = JSON.parse(fs.readFileSync(response));
					if (reply.id === id) return reply;
					assert.ok(reply.id < id, 'Unexpected observer response');
				}
				assert.ok(
					!electron.exit && !electron.error,
					'Electron exited before observer acknowledgement'
				);
				await delay(20, undefined, { signal });
			}
		};
		// Further smoke/measurement tasks supply the owned CDP scenario here.
		if (context.exercise)
			await bounded(
				context.exercise({
					root,
					contract: manifest.contract,
					target,
					cdpUrl: `http://127.0.0.1:${port}`,
					observe,
					signal,
				})
			);
		electron.tree = await io.refreshProcessTree(electron.child.pid, electron.tree);
		finishRequested = true;
		await bounded(observe('finish'));
		await bounded(electron.closed);
		assert.deepEqual(electron.exit, { code: 0, signal: null }, 'Owned Electron failed');
		const host = JSON.parse(fs.readFileSync(path.join(root, 'rendered-host.json')));
		assert.equal(host.ready, true);
		assert.ok(!host.error, host.error);
		receipt.lifecyclePassed = true;
	} catch (error) {
		failure = error;
	} finally {
		clearTimeout(timer);
		// Kill only handles created by this launcher and recorded descendants.
		for (const state of owned.reverse()) {
			try {
				if (state.child.pid && !state.tree.owned && !state.closeConfirmed)
					state.tree = io.snapshotProcessTree(state.child.pid);
				state.tree = await io.refreshProcessTree(state.child.pid, state.tree);
				io.stopProcess(
					{ child: state.child },
					{ from: 'kill', graceMs: 0, immediate: true, label: `board-rendered-${state.label}` }
				);
				io.killSurvivors(state.tree.descendants, { label: `board-rendered-${state.label}` });
				let cleanupTimer;
				try {
					await Promise.race([
						state.closed,
						new Promise((_, reject) => {
							cleanupTimer = setTimeout(
								() => reject(Error(`${state.label} cleanup timed out`)),
								2000
							);
						}),
					]);
				} finally {
					clearTimeout(cleanupTimer);
				}
			} catch (error) {
				cleanupErrors.push(String(error));
			}
		}
		let childrenExited = false;
		try {
			childrenExited = owned.every(
				(state) =>
					state.closeConfirmed &&
					(!state.child.pid || (state.tree.owned && io.descendantsExited(state.tree.descendants)))
			);
			if (!childrenExited)
				cleanupErrors.push(
					'Owned child closure or descendant termination unconfirmed; lease retained'
				);
		} catch (error) {
			cleanupErrors.push(String(error));
		}
		try {
			if (childrenExited && backupVerified) selectAddon(backup, nodeSha256);
			if (receipt)
				receipt.addonRestored = childrenExited && binding.sha(activeAddon) === nodeSha256;
		} catch (error) {
			cleanupErrors.push(String(error));
		}
		for (const fd of descriptors) {
			try {
				fs.closeSync(fd);
			} catch (error) {
				cleanupErrors.push(String(error));
			}
		}
		// Only remove our own successfully acquired lease.
		if (lockAcquired && childrenExited && (!backupVerified || (receipt && receipt.addonRestored))) {
			try {
				fs.rmdirSync(lock);
			} catch (error) {
				cleanupErrors.push(String(error));
			}
		}
		process.removeListener('SIGINT', interrupt);
		process.removeListener('SIGTERM', interrupt);
		if (receipt) {
			try {
				if (childrenExited && receipt.lifecyclePassed) {
					const admission = require('../dist/main/board/board-isolation.js');
					receipt.database = binding.closedDatabaseBinding(manifest.contract, admission);
					receipt.hostSha256 = binding.sha(path.join(root, 'rendered-host.json'));
				}
			} catch (error) {
				cleanupErrors.push(String(error));
			}
			receipt.processes = owned.map(({ label, child, exit, error }) => ({
				label,
				pid: child.pid,
				exit,
				error,
			}));
			receipt.cleanupErrors = cleanupErrors;
			receipt.ownedChildrenExited = childrenExited;
			if (failure) receipt.error = String(failure.stack ?? failure);
			receipt.lifecyclePassed &&= !failure && !cleanupErrors.length && receipt.addonRestored;
			fs.writeFileSync(
				path.join(root, 'rendered-launch.json'),
				JSON.stringify(receipt, null, 2) + '\n',
				{ flag: 'wx', mode: 0o600 }
			);
		}
		if (lockAcquired && fs.existsSync(lock)) {
			fs.writeFileSync(
				path.join(lock, 'recovery.json'),
				JSON.stringify(
					{
						root,
						backup,
						activeAddon,
						nodeSha256,
						childrenExited,
						cleanupErrors,
						processes: owned.map(({ label, child, closeConfirmed, tree }) => ({
							label,
							pid: child.pid,
							closeConfirmed: Boolean(closeConfirmed),
							tree,
						})),
					},
					null,
					2
				) + '\n',
				{ mode: 0o600 }
			);
		}
	}
	if (failure || cleanupErrors.length)
		throw new AggregateError(
			[...(failure ? [failure] : []), ...cleanupErrors],
			`Rendered launcher failed: ${failure?.message ?? cleanupErrors.join('; ')}`
		);
	return receipt;
}

async function launchRendered(
	{ count, addon, qualificationPath, exercise, timeoutMs, reopen, createWorker = false },
	io = system()
) {
	assert.equal(process.platform, 'linux');
	assert.equal(fs.realpathSync(process.cwd()), checkout);
	assert.ok(reopen ? count === undefined : [0, 100, 500].includes(count));
	assert.equal(typeof createWorker, 'boolean');
	assert.ok(!createWorker || !reopen, 'Creation requires a fresh parent-owned fixture');
	const activeAddon = path.join(
		checkout,
		'node_modules/better-sqlite3/build/Release/better_sqlite3.node'
	);
	const qualified = qualifyBindings(activeAddon, addon, qualificationPath);
	return runRenderedLifecycle(
		{
			activeAddon,
			...qualified,
			qualification: { path: qualificationPath, sha256: binding.sha(qualificationPath) },
			timeoutMs,
			exercise,
			async prepare(own, bounded) {
				if (reopen) {
					assert.equal(reopen.qualified.nodeSha256, qualified.nodeSha256);
					assert.equal(reopen.qualified.electronSha256, qualified.electronSha256);
					assert.deepEqual(reopen.qualification, {
						path: qualificationPath,
						sha256: binding.sha(qualificationPath),
					});
					return binding.prepareRenderedReopen(
						reopen,
						checkout,
						require('../dist/main/board/board-isolation.js')
					);
				}
				const env = Object.fromEntries(
					['PATH', 'SystemRoot', 'WINDIR']
						.filter((key) => process.env[key])
						.map((key) => [key, process.env[key]])
				);
				const preparation = own(
					'prepare',
					process.execPath,
					[
						path.join(checkout, 'scripts/board-rendered-prepare.cjs'),
						String(count),
						addon,
						...(createWorker ? ['--create-worker'] : []),
					],
					{ cwd: checkout, env, stdio: ['ignore', 'pipe', 'pipe'] }
				);
				let stdout = '',
					stderr = '',
					overflow = false;
				preparation.child.stdout.on('data', (bytes) => {
					stdout = (stdout + bytes).slice(0, 65537);
					if (stdout.length > 65536) {
						overflow = true;
						io.stopProcess(
							{ child: preparation.child },
							{ from: 'kill', graceMs: 0, immediate: true }
						);
					}
				});
				preparation.child.stderr.on('data', (bytes) => {
					stderr = (stderr + bytes).slice(-65536);
				});
				await bounded(preparation.closed);
				assert.equal(overflow, false, 'Preparation output exceeded budget');
				assert.deepEqual(preparation.exit, { code: 0, signal: null }, stderr);
				return stdout.trim();
			},
		},
		io
	);
}

module.exports = { launchRendered, runRenderedLifecycle, qualifyBindings };
if (require.main === module) {
	assert.equal(
		process.argv.length,
		5,
		'Usage: node scripts/board-rendered-launch.cjs 0|100|500 ELECTRON_ABI145.node QUALIFIED_CHECKS.json'
	);
	launchRendered({
		count: Number(process.argv[2]),
		addon: path.resolve(process.argv[3]),
		qualificationPath: path.resolve(process.argv[4]),
	})
		.then((receipt) => console.log(path.join(receipt.contract.root, 'rendered-launch.json')))
		.catch((error) => {
			console.error(error);
			process.exitCode = 1;
		});
}
