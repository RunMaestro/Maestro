const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ensurePerformanceParent } = require('./board-performance-parent.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { admitPerformanceFixture } = require('./board-performance-admission.cjs');

test('admits only an intact prepared profile and revalidates its registry contract', (t) => {
	const checkout = path.resolve(__dirname, '..');
	ensurePerformanceParent(path.join(checkout, 'isolated'));
	const fixture = fs.mkdtempSync(path.join(checkout, 'isolated', 'admission-test-'));
	t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
	const hashes = {};
	for (const file of [
		'scripts/board-performance-prepare.cjs',
		'scripts/board-performance-parent.cjs',
		'scripts/board-performance-profiles.cjs',
		'src/main/board/board-isolation.ts',
		'src/main/board/board-db.ts',
		'src/main/board/board-storage.ts',
		'src/main/board/board-workspace-storage.ts',
		'dist/main/board/board-isolation.js',
		'dist/main/board/board-db.js',
		'dist/main/board/board-storage.js',
		'dist/main/board/board-workspace-storage.js',
	])
		hashes[file] = crypto
			.createHash('sha256')
			.update(fs.readFileSync(path.join(checkout, file)))
			.digest('hex');
	const manifest = {
		schemaVersion: 1,
		nativeExecuted: false,
		measurements: false,
		hashes,
		counts: { cards: 100, agents: 100, groups: 20, sources: 50 },
		contract: { root: fixture },
		env: { BOARD_ISOLATED_ROOT: fixture },
	};
	const file = path.join(fixture, 'prepared.json');
	const save = () => fs.writeFileSync(file, JSON.stringify(manifest));
	const admission = {
		requireBoardIsolation: ({ expected, env, worktree }) => {
			assert.equal(worktree, checkout);
			assert.equal(env.BOARD_ISOLATED_ROOT, expected.root);
			return expected;
		},
		readBoardIsolationRegistries: () => ({ checked: true }),
	};
	save();
	assert.equal(admitPerformanceFixture(file, checkout, admission).registrations.checked, true);
	manifest.hashes['scripts/board-performance-profiles.cjs'] = 'incorrect';
	save();
	assert.throws(() => admitPerformanceFixture(file, checkout, admission), /Changed dependency/);
	delete manifest.hashes['scripts/board-performance-profiles.cjs'];
	save();
	assert.throws(() => admitPerformanceFixture(file, checkout, admission));
});
