// Fixture persistence adapter, not a production agent-management endpoint.
const assert = require('node:assert/strict');
const binding = require('./board-rendered-contract.cjs');
const { canonicalJson } = require('../dist/shared/canonicalJson.js');
const { buildNewAgentRecord } = require('../dist/shared/newAgentRecord.js');

const creationChannels = [
	'sessions:setAll',
	'sessions:setActiveSessionId',
	'agents:detect',
	'agents:get',
	'agents:getConfig',
	'agents:getMaestroPDetectedPath',
	'ssh-remote:getConfigs',
	'fs:homeDir',
	'git:isRepo',
	'stats:record-session-created',
];

function installCreationFixture({
	ipcMain,
	manifest,
	admission,
	instances,
	appendAgent,
	record,
	db,
	flushPendingSessionWritesSync,
}) {
	const { contract, creation } = manifest;
	assert.ok(creation && appendAgent);
	const baseline = canonicalJson(instances.sessionsStore.get('sessions'));
	let registries = manifest.registries;
	let created;
	let attempts = 0;
	const events = (record.creation = {
		request: creation,
		saves: [],
		registrations: [],
		providerTurns: 0,
	});
	const provider = {
		id: 'codex',
		name: 'Codex',
		available: true,
		command: 'codex',
		capabilities: {},
	};
	// Only metadata/probes are stubbed; no provider binary can be executed. The
	// renderer uses the actual canonical modal, validation, CRUD and record builder.
	ipcMain.handle('agents:detect', (_event, remote) => {
		assert.ok(!remote);
		return [provider];
	});
	ipcMain.handle('agents:get', (_event, id) => {
		assert.equal(id, 'codex');
		return provider;
	});
	ipcMain.handle('agents:getConfig', (_event, id) => {
		assert.equal(id, 'codex');
		return {};
	});
	ipcMain.handle('agents:getMaestroPDetectedPath', () => null);
	ipcMain.handle('ssh-remote:getConfigs', () => ({ success: true, configs: [] }));
	ipcMain.handle('fs:homeDir', () => contract.root);
	ipcMain.handle('git:isRepo', (_event, cwd, remote) => {
		assert.equal(cwd, creation.cwd);
		assert.ok(!remote);
		return false; // Deliberate probe stub, not a repository/provider acceptance claim.
	});
	ipcMain.handle('stats:record-session-created', (_event, event) => {
		assert.equal(event.sessionId, created?.id);
		assert.equal(event.projectPath, creation.cwd);
		events.statsEvent = event;
		return null; // No global analytics store is opened.
	});
	ipcMain.handle('sessions:setActiveSessionId', (_event, id) => {
		assert.match(id, /^[a-f0-9-]{36}$/i);
		events.activeSelection = id; // Volatile UI selection, no registry mutation.
	});
	ipcMain.handle('sessions:setAll', (_event, next, baselines) => {
		assert.equal(baselines, undefined);
		assert.ok(Array.isArray(next));
		if (created && canonicalJson(next) === canonicalJson(instances.sessionsStore.get('sessions'))) {
			events.saves.push({ agentId: created.id, duplicateFlush: true });
			return;
		}
		assert.ok(!created, 'Only one parent-authorized agent may be created');
		assert.equal(canonicalJson(next.slice(0, -1)), baseline, 'Existing agents changed');
		const candidate = next.at(-1);
		assert.ok(candidate && Number.isInteger(candidate.createdAt));
		assert.ok(Math.abs(Date.now() - candidate.createdAt) < 240000);
		assert.ok(Number.isInteger(candidate.port) && candidate.port >= 3000 && candidate.port < 3100);
		const ids = [candidate.aiTabs?.[0]?.id, candidate.shellLogs?.[0]?.id];
		assert.equal(new Set([candidate.id, ...ids]).size, 3);
		for (const id of [candidate.id, ...ids]) assert.match(id, /^[a-f0-9-]{36}$/i);
		const expected = {
			...buildNewAgentRecord(
				{
					id: candidate.id,
					name: creation.name,
					toolType: creation.toolType,
					cwd: creation.cwd,
					saveToHistory: true,
					showThinking: 'off',
				},
				{ generateId: () => ids.shift(), now: candidate.createdAt }
			),
			port: candidate.port,
			isGitRepo: false,
			sessionSshRemoteConfig: { enabled: false, remoteId: null },
			retryOnAvailabilityErrors: true,
			retryOnTokenExhaustion: true,
		};
		assert.equal(
			canonicalJson(candidate),
			canonicalJson(expected),
			'Agent differs from exact creation request'
		);
		// Validate immutable settings/groups/sources before AND after the only
		// synchronous store write. Do not bless fresh hashes of unrelated files.
		appendAgent(candidate, () => {
			instances.sessionsStore.set('sessions', next);
			flushPendingSessionWritesSync();
		});
		const after = binding.registryFingerprints(contract);
		assert.deepEqual(
			{ ...after, [contract.agentRegistry]: manifest.registries[contract.agentRegistry] },
			manifest.registries
		);
		registries = after;
		created = candidate;
		events.saves.push({ agentId: created.id, duplicateFlush: false });
		events.registryTransition = { before: manifest.registries, after };
	});
	return {
		validate() {
			binding.assertRenderedRegistries({ ...manifest, registries }, admission);
			assert.equal(instances.sessionsStore.path, contract.agentRegistry);
		},
		beforeRegister(options) {
			assert.equal(options?.agentId, created?.id);
			assert.ok(created, 'Agent must be persisted before worker registration');
			const workers = db
				.prepare('SELECT count(*) AS n FROM workers WHERE agent_id=?')
				.get(created.id).n;
			events.registrations.push({
				agentId: created.id,
				attempt: ++attempts,
				workersBefore: workers,
			});
			if (attempts === 1) {
				assert.equal(workers, 0);
				throw new Error('Injected registration failure before worker commit');
			}
			assert.equal(attempts, 2, 'Only the explicit registration retry is authorized');
			assert.equal(workers, 0);
		},
	};
}

module.exports = { creationChannels, installCreationFixture };
