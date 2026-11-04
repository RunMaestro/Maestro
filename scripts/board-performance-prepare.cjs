// Isolated fixture preparation only; this process starts no desktop, Cue, or worker.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { performanceProfile, performanceDependencies } = require('./board-performance-profiles.cjs');
const which = require('which');
const checkout = path.resolve(__dirname, '..');
const admission = require('../dist/main/board/board-isolation.js');
const { openBoardDb } = require('../dist/main/board/board-db.js');
const { BoardStorageFacade } = require('../dist/main/board/board-storage.js');
const { ENCORE_FEATURE_DEFAULTS } = require('../dist/shared/encoreFeatureDefaults.js');
const count = Number(process.argv[2]);
assert.ok(
	['0', '100', '500'].includes(process.argv[2]) && process.argv.length === 3,
	'Usage: node scripts/board-performance-prepare.cjs 0|100|500'
);
assert.equal(fs.realpathSync(process.cwd()), checkout);
// Resolve and query before creating any fixture or restricting PATH.
const git = which.sync('git');
const head = cp
	.execFileSync(git, ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' })
	.trim();
const root = path.join(checkout, 'isolated', `board-performance-${crypto.randomUUID()}`);
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
	TMPDIR: path.join(root, 'tmp'),
	PATH: path.join(root, 'bin'),
};
const contract = admission.requireBoardIsolation({ env, worktree: checkout });
const profile = performanceProfile(contract.sourceRoot, count);
admission.assertBoardIsolationRegistrations(contract, {
	sessions: profile.sessions,
	sources: profile.sources,
});
// Exclusive root creation prevents reuse of an existing fixture.
fs.mkdirSync(root);
for (const dir of [
	contract.userData,
	contract.sync,
	path.dirname(contract.db),
	path.dirname(contract.agentRegistry),
	...profile.sources.map((s) => s.root),
	env.TMPDIR,
	env.PATH,
])
	fs.mkdirSync(dir, { recursive: true });
const write = (file, value) =>
	fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
write(contract.agentRegistry, { sessions: profile.sessions });
write(contract.sourceRegistry, { sources: profile.sources });
write(path.join(contract.sync, 'maestro-groups.json'), { groups: profile.groups });
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
admission.readBoardIsolationRegistries(contract, env);
Object.assign(process.env, env);
admission.requireBoardIsolation({ expected: contract });
const db = openBoardDb(contract.db);
try {
	const facade = new BoardStorageFacade(db);
	const board = facade.ensureGlobalBoard();
	if (count)
		facade.workspace.writeCollection({
			sourceKey: board.storage.sourceKey,
			collectionKey: board.storage.collectionKey,
			expectedRevision: board.storage.expectedRevision,
			cards: profile.cards.map(({ id, ...set }) => ({ cardId: id, expectedRevision: null, set })),
		});
	assert.equal(db.prepare('SELECT count(*) AS n FROM cards').get().n, count);
	assert.equal(db.prepare('SELECT count(*) AS n FROM workers').get().n, 0);
	assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
} finally {
	db.close();
}
const hashes = Object.fromEntries(
	performanceDependencies.map((file) => [
		file,
		crypto
			.createHash('sha256')
			.update(fs.readFileSync(path.join(checkout, file)))
			.digest('hex'),
	])
);
write(path.join(root, 'prepared.json'), {
	schemaVersion: 1,
	head,
	hashes,
	contract,
	env,
	counts: { cards: count, agents: 100, groups: 20, sources: 50 },
	nativeExecuted: false,
	measurements: false,
});
console.log(path.join(root, 'prepared.json'));
