// Dedicated owned fixture controls. Never imported by the desktop or production preload.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const binding = require('./board-rendered-contract.cjs');

async function installAuthorityFixture({ manifest, admission, facade, instances, window, record }) {
	assert.deepEqual(manifest.authority, binding.authorityRequest(manifest.contract));
	assert.ok(!manifest.creation && !manifest.reopen);
	const { contract } = manifest;
	binding.assertRenderedRegistries(manifest, admission);
	const { BoardRuntime } = require('../dist/main/board/board-runtime.js');
	const { configureBoardRuntimeHost } = require('../dist/main/board/board-runtime-host.js');
	const {
		configureBoardCaptureHost,
		configureBoardReadinessHost,
	} = require('../dist/main/board/board-storage.js');
	const { BoardRegistryRevision } = require('../dist/main/board/board-registry-revision.js');
	const { acquireDataDirLock } = require('../dist/shared/maestro-lib/runtime/data-dir-lock.js');
	const { answerBoardCommand } = require('../dist/shared/board/commands.js');
	const { executeBoardCommand } = require('../dist/main/board/board-command-host.js');
	const { canonicalJson } = require('../dist/shared/canonicalJson.js');
	const {
		readBoardRunArtifact,
		prepareBoardReviewHandoff,
	} = require('../dist/main/board/board-review.js');
	const { resolveBoardLocation } = require('../dist/main/board/board-location.js');
	const lockResult = acquireDataDirLock(
		{
			userDataDir: contract.userData,
			cliServerFile: path.join(contract.userData, 'cli-server.json'),
		},
		'desktop'
	);
	assert.ok(lockResult.ok, JSON.stringify(lockResult));
	const lock = lockResult.lock;
	const originalAgents = structuredClone(instances.sessionsStore.get('sessions'));
	const groups = instances.groupsStore.get('groups');
	const workerA = originalAgents[0];
	const workerB = originalAgents.find(
		(agent) => agent.id !== workerA.id && agent.groupId === workerA.groupId
	);
	assert.ok(workerB);
	const repository = facade
		.captureCatalog()
		.repositories.find((repo) => repo.workingDirectory === workerA.cwd);
	assert.ok(repository?.validated);
	let agents = structuredClone(originalAgents);
	let reviewArtifact = null;
	const revision = new BoardRegistryRevision();
	const states = () =>
		Object.fromEntries(
			agents.map((agent) => [
				agent.id,
				{
					live: true,
					busy: false,
					location: resolveBoardLocation(agent),
				},
			])
		);
	configureBoardCaptureHost(() => ({ agents, groups }));
	configureBoardReadinessHost(() => ({ dispatchEnabled: true, agentStates: states() }));
	const events = (record.authority = {
		boundary:
			'Real owned Electron IPC, command host, runtime host and SQLite; simulated provider service and recorded membership snapshots; file transport is fixture-only',
		workerA: workerA.id,
		workerB: workerB.id,
		groupId: workerA.groupId,
		repository,
		launches: [],
		commands: [],
		providerTurns: 0,
		membershipSnapshots: [],
	});
	const pending = new Map();
	const starts = new Map();
	const changed = () => {
		if (!window.isDestroyed()) window.webContents.send('board:changed', {});
	};
	const owner = new BoardRuntime(
		facade,
		lock,
		() => ({
			registryRevision: revision.observe({
				agents,
				groups,
				workers: facade.db.prepare('SELECT * FROM workers ORDER BY agent_id').all(),
			}),
			dispatchEnabled: true,
			agentStates: states(),
			reviewArtifact,
			repository: {
				id: repository.id,
				workingDirectory: repository.workingDirectory,
				record: repository,
				location: { kind: 'local' },
				identity: fs.realpathSync(repository.workingDirectory),
			},
		}),
		{
			spawn: async (spec, hooks) => {
				assert.equal(spec.repository.workingDirectory, repository.workingDirectory);
				return new Promise((resolve) => pending.set(spec.runToken.runId, { spec, hooks, resolve }));
			},
			stop: () => {}, // Unknown simulated liveness retains capacity until explicit completion.
			probe: () => 'unknown',
		},
		() => 'unknown',
		changed
	);
	assert.deepEqual(owner.acquire(), { ok: true });
	configureBoardRuntimeHost(async (key) => {
		const card = facade.workspace
			.readCollection(key)
			?.cards.find((entry) => entry.cardId === key.cardId)?.payload;
		reviewArtifact = card?.reviewHandoff
			? await prepareBoardReviewHandoff(facade, card.reviewHandoff)
			: null;
		return owner;
	});
	const directory = path.join(contract.root, 'authority-control');
	fs.mkdirSync(directory, { mode: 0o700 });
	const seen = new Set();
	async function control(input) {
		binding.assertRenderedRegistries(manifest, admission);
		assert.equal(input.identity, contract.identity, 'Wrong parent fixture identity');
		if (input.action === 'snapshot')
			return {
				persistence: binding.persistenceSnapshot(facade.db),
				collections: facade.query().collections,
				registryRevision: owner.intakeRevision(),
				launches: events.launches,
			};
		if (input.action === 'command') {
			const result = await answerBoardCommand(input.command, executeBoardCommand);
			events.commands.push({ command: input.command, result });
			if (result.ok) changed();
			return result;
		}
		// These are parent-only simulation controls. They are deliberately absent
		// from the CLI transport, production command parser and renderer preload.
		if (input.action === 'membership') {
			assert.ok(['original', 'worker-a-out'].includes(input.state));
			agents = structuredClone(originalAgents);
			if (input.state === 'worker-a-out')
				agents[0].groupId = groups.find((group) => group.id !== workerA.groupId).id;
			const registryRevision = owner.intakeRevision();
			events.membershipSnapshots.push({
				state: input.state,
				workerAGroup: agents[0].groupId,
				registryRevision,
			});
			return { registryRevision };
		}
		if (input.action === 'foreign-approval') {
			assert.equal(input.command.action, 'control');
			assert.equal(input.command.operation, 'accept');
			const { BrowserWindow } = require('electron');
			const foreign = new BrowserWindow({
				show: false,
				webPreferences: {
					preload: path.join(manifest.checkout, binding.preload),
					contextIsolation: true,
					nodeIntegration: false,
					sandbox: true,
					webSecurity: true,
				},
			});
			try {
				await foreign.loadURL('about:blank');
				return await foreign.webContents.executeJavaScript(
					`window.maestro.board.runtimeCommand(${JSON.stringify(input.command)})`
				);
			} finally {
				foreign.destroy();
			}
		}
		if (input.action === 'claim') return owner.claim(input.command);
		if (input.action === 'start') {
			assert.ok(!starts.has(input.token.runId));
			starts.set(input.token.runId, owner.start(input.token));
			return { accepted: true };
		}
		if (input.action === 'launch') {
			const call = pending.get(input.token.runId);
			assert.ok(call && canonicalJson(call.spec.runToken) === canonicalJson(input.token));
			// The simulated service deliberately defers launch past the tick loop.
			// Recheck the exact attempt's Git handoff, rather than retaining another
			// card's last runtime-host preparation as this attempt's evidence.
			reviewArtifact = call.spec.card.reviewHandoff
				? await prepareBoardReviewHandoff(facade, call.spec.card.reviewHandoff)
				: null;
			const allowed = call.hooks.canPrepare() && call.hooks.beforeLaunch();
			if (allowed) {
				call.hooks.onStarted(undefined); // No fabricated PID or native provider claim.
				events.launches.push({ token: call.spec.runToken, worker: call.spec.workerAgentId });
				return { allowed };
			}
			call.resolve({ output: '', exitCode: null, executionStarted: false });
			return { allowed, result: await starts.get(input.token.runId) };
		}
		if (input.action === 'complete') {
			const artifactFile = path.join(contract.root, 'authority-artifact.json');
			admission.assertBoardIsolationPath(contract, artifactFile);
			const { baseCommit } = JSON.parse(fs.readFileSync(artifactFile));
			const artifact = await readBoardRunArtifact(repository.workingDirectory, baseCommit);
			assert.ok(artifact?.diff, 'Genuine clean Git artifact required');
			const result = {
				output: input.incomplete
					? '<!-- maestro:card-complete -->'
					: '<!-- maestro:card-complete | Owned fixture checks passed -->',
				exitCode: 0,
				executionStarted: true,
				terminationConfirmed: true,
				...(input.incomplete ? {} : { artifact }),
			};
			const verdict = owner.complete(input.token, result);
			const call = pending.get(input.token.runId);
			if (verdict.ok && call && canonicalJson(call.spec.runToken) === canonicalJson(input.token)) {
				call.resolve(result);
				await starts.get(input.token.runId);
				pending.delete(input.token.runId);
			}
			changed();
			return verdict;
		}
		throw new Error('Unknown parent authority action');
	}
	let busy = false;
	const timer = setInterval(async () => {
		if (busy) return;
		busy = true;
		try {
			for (const name of fs
				.readdirSync(directory)
				.filter((file) => /^request-[a-f0-9-]{36}\.json$/.test(file))
				.sort()) {
				const file = path.join(directory, name);
				admission.assertBoardIsolationPath(contract, file);
				const stat = fs.lstatSync(file);
				assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 1024 * 1024);
				const id = name.slice(8, -5);
				assert.ok(!seen.has(id), 'Replayed authority request');
				seen.add(id);
				const input = JSON.parse(fs.readFileSync(file, 'utf8'));
				let reply;
				try {
					reply = { value: await control(input) };
				} catch (error) {
					reply = { error: String(error.stack ?? error) };
				}
				fs.unlinkSync(file);
				const target = path.join(directory, `response-${id}.json`);
				fs.writeFileSync(target + '.tmp', JSON.stringify(reply) + '\n', {
					flag: 'wx',
					mode: 0o600,
				});
				fs.renameSync(target + '.tmp', target);
			}
		} finally {
			busy = false;
		}
	}, 20);
	return {
		dispose() {
			clearInterval(timer);
			configureBoardRuntimeHost(() => null);
			lock.release();
		},
	};
}

module.exports = { installAuthorityFixture };
