const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const { ensurePerformanceParent } = require('./board-performance-parent.cjs');
const path = require('node:path');
const checkout = path.resolve(__dirname, '..');
ensurePerformanceParent(path.join(checkout, 'isolated'));
const runWithEnv = (env, ...args) =>
	cp.spawnSync(process.execPath, ['scripts/board-performance-prepare.cjs', ...args], {
		cwd: checkout,
		encoding: 'utf8',
		timeout: 30000,
		env: { ...process.env, ...env },
	});
const run = (...args) => runWithEnv({}, ...args);

test('prepares the three isolated profiles without workers or measurements', (t) => {
	for (const count of [0, 100, 500]) {
		const result = run(String(count));
		assert.equal(result.status, 0, result.stderr);
		const manifest = JSON.parse(fs.readFileSync(result.stdout.trim(), 'utf8'));
		t.after(() => fs.rmSync(manifest.contract.root, { recursive: true, force: true }));
		assert.equal(manifest.counts.cards, count);
		assert.deepEqual(
			[manifest.counts.agents, manifest.counts.groups, manifest.counts.sources],
			[100, 20, 50]
		);
		assert.equal(manifest.measurements, false);
		assert.equal(manifest.env.HOME, undefined);
		assert.equal(manifest.env.CODEX_HOME, undefined);
		assert.equal(JSON.parse(fs.readFileSync(manifest.contract.agentRegistry)).sessions.length, 100);
		assert.equal(JSON.parse(fs.readFileSync(manifest.contract.sourceRegistry)).sources.length, 50);
		assert.ok(manifest.contract.root.startsWith(path.join(checkout, 'isolated') + path.sep));
	}
});

test('missing Git fails before creating a fixture', (t) => {
	const directory = fs.mkdtempSync(path.join(checkout, 'isolated', 'no-git-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const before = fs.readdirSync(path.join(checkout, 'isolated')).sort();
	const result = runWithEnv({ PATH: directory }, '0');
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /not found: git/i);
	assert.deepEqual(fs.readdirSync(path.join(checkout, 'isolated')).sort(), before);
});

test(
	'uses Git resolved from PATH before restricting it',
	{ skip: process.platform === 'win32' },
	(t) => {
		const directory = fs.mkdtempSync(path.join(checkout, 'isolated', 'git-path-'));
		t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
		fs.writeFileSync(path.join(directory, 'git'), '#!/bin/sh\nprintf "fixture-head\\n"\n', {
			mode: 0o755,
		});
		const result = runWithEnv({ PATH: directory }, '0');
		assert.equal(result.status, 0, result.stderr);
		const manifest = JSON.parse(fs.readFileSync(result.stdout.trim(), 'utf8'));
		t.after(() => fs.rmSync(manifest.contract.root, { recursive: true, force: true }));
		assert.equal(manifest.head, 'fixture-head');
	}
);

test('rejects invalid sizes before creating a fixture', () => {
	assert.notEqual(run('1').status, 0);
	assert.notEqual(run().status, 0);
});

test('creates a fresh private parent and keeps fixture roots exclusive', (t) => {
	const owned = fs.mkdtempSync(path.join(checkout, 'isolated', 'parent-test-'));
	t.after(() => fs.rmSync(owned, { recursive: true, force: true }));
	const parent = path.join(owned, 'missing', 'isolated');
	ensurePerformanceParent(parent);
	if (process.platform !== 'win32') assert.equal(fs.statSync(parent).mode & 0o777, 0o700);
	const root = path.join(parent, 'fixture');
	fs.mkdirSync(root);
	assert.throws(() => fs.mkdirSync(root), { code: 'EEXIST' });
});
