import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVitest } from 'vitest/node';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const shardCount = 4;

function testKey(specification) {
	const relativePath = path.relative(rootDir, specification.moduleId).split(path.sep).join('/');
	return `${specification.project.name}:${relativePath}`;
}

const vitest = await createVitest('test', { root: rootDir, run: true, watch: false });
let allSpecifications;
let shards;

try {
	allSpecifications = await vitest.globTestSpecifications();
	const Sequencer = vitest.config.sequence.sequencer;
	const sequencer = new Sequencer(vitest);

	shards = [];
	for (let index = 1; index <= shardCount; index += 1) {
		vitest.config.shard = { index, count: shardCount };
		shards.push((await sequencer.shard(allSpecifications)).map(testKey));
	}
} finally {
	await vitest.close();
}

const allFiles = allSpecifications.map(testKey);

const expected = new Set(allFiles);
const owners = new Map();
const duplicates = [];
const unexpected = [];

for (const [index, files] of shards.entries()) {
	if (files.length === 0) {
		throw new Error(`Vitest shard ${index + 1}/${shardCount} is empty`);
	}

	for (const file of files) {
		if (!expected.has(file)) {
			unexpected.push(file);
		}

		const previousShard = owners.get(file);
		if (previousShard !== undefined) {
			duplicates.push(`${file} (shards ${previousShard} and ${index + 1})`);
		} else {
			owners.set(file, index + 1);
		}
	}
}

const missing = allFiles.filter((file) => !owners.has(file));
const errors = [
	...missing.map((file) => `missing: ${file}`),
	...duplicates.map((file) => `duplicate: ${file}`),
	...unexpected.map((file) => `unexpected: ${file}`),
];

if (errors.length > 0) {
	throw new Error(`Vitest shard coverage is invalid:\n${errors.join('\n')}`);
}

console.log(
	`Verified ${shardCount} Vitest shards cover ${allFiles.length} files exactly once ` +
		`(shard sizes: ${shards.map((files) => files.length).join(', ')}).`
);
