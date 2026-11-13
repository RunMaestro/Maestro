const { test } = require('node:test');
const assert = require('node:assert/strict');
const { performanceProfile } = require('./board-performance-profiles.cjs');

test('profiles have unique identities and linked local registrations', () => {
	for (const count of [0, 100, 500]) {
		const profile = performanceProfile('/fixture/sources', count);
		assert.deepEqual(
			[
				profile.cards.length,
				profile.sessions.length,
				profile.groups.length,
				profile.sources.length,
			],
			[count, 100, 20, 50]
		);
		for (const entries of Object.values(profile)) {
			assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
		}
		assert.ok(
			profile.sessions.every(
				(session) =>
					profile.groups.some((group) => group.id === session.groupId) &&
					profile.sources.some(
						(source) => source.root === session.cwd && session.cwd === session.projectRoot
					)
			)
		);
	}
});

test('rejects unsupported sizes and relative roots', () => {
	assert.throws(() => performanceProfile('relative', 100));
	assert.throws(() => performanceProfile('/fixture/sources', 1));
});
