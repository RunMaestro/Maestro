// Pure fixture descriptions. Callers must admit every path before writing or launching.
const path = require('node:path');

const performanceDependencies = Object.freeze([
	'scripts/board-performance-prepare.cjs',
	'scripts/board-performance-profiles.cjs',
	'src/main/board/board-isolation.ts',
	'src/main/board/board-db.ts',
	'src/main/board/board-storage.ts',
	'src/main/board/board-workspace-storage.ts',
	'dist/main/board/board-isolation.js',
	'dist/main/board/board-db.js',
	'dist/main/board/board-storage.js',
	'dist/main/board/board-workspace-storage.js',
]);

function performanceProfile(sourceRoot, cardCount) {
	if (!path.isAbsolute(sourceRoot) || ![0, 100, 500].includes(cardCount)) {
		throw new Error('Expected an absolute source root and 0, 100, or 500 cards');
	}
	const groups = Array.from({ length: 20 }, (_, i) => ({
		id: `fixture-group-${i}`,
		name: `Fixture group ${i}`,
		emoji: '📁',
		collapsed: false,
	}));
	const sources = Array.from({ length: 50 }, (_, i) => ({
		id: `fixture-source-${i}`,
		root: path.join(sourceRoot, `source-${i}`),
	}));
	const sessions = Array.from({ length: 100 }, (_, i) => ({
		id: `fixture-agent-${i}`,
		name: `Fixture agent ${i}`,
		toolType: 'codex',
		groupId: groups[i % groups.length].id,
		cwd: sources[i % sources.length].root,
		projectRoot: sources[i % sources.length].root,
	}));
	const cards = Array.from({ length: cardCount }, (_, i) => ({
		id: `fixture-card-${i}`,
		title: `Fixture card ${i}`,
		body: '',
		parents: [],
		status: 'todo',
		createdAt: '',
		updatedAt: '',
	}));
	return { groups, sources, sessions, cards };
}
module.exports = { performanceProfile, performanceDependencies };
