// Revalidate a prepared profile immediately before any isolated renderer launch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performanceDependencies: required } = require('./board-performance-profiles.cjs');

function admitPerformanceFixture(manifestPath, checkout, admission) {
	checkout = fs.realpathSync(checkout);
	manifestPath = fs.realpathSync(manifestPath);
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.nativeExecuted, false);
	assert.equal(manifest.measurements, false);
	assert.ok([0, 100, 500].includes(manifest.counts?.cards));
	assert.deepEqual(
		[manifest.counts.agents, manifest.counts.groups, manifest.counts.sources],
		[100, 20, 50]
	);
	assert.deepEqual(Object.keys(manifest.hashes).sort(), [...required].sort());
	for (const file of required) {
		const absolute = path.join(checkout, file);
		assert.equal(fs.realpathSync(absolute), absolute, `Noncanonical dependency: ${file}`);
		const hash = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
		assert.equal(hash, manifest.hashes[file], `Changed dependency: ${file}`);
	}
	const contract = admission.requireBoardIsolation({
		env: manifest.env,
		expected: manifest.contract,
		worktree: checkout,
	});
	assert.equal(manifestPath, path.join(contract.root, 'prepared.json'));
	const registrations = admission.readBoardIsolationRegistries(contract, manifest.env);
	return { manifest, contract, registrations };
}

module.exports = { admitPerformanceFixture };
