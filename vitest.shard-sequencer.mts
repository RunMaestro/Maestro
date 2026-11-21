/**
 * Splits test files across `--shard` by measured duration instead of by count.
 *
 * Vitest's default sharding hashes file paths and gives each shard the same number of
 * files. On hosted Windows that left shard 2 with almost twice the test time of shard 1,
 * so every CI run waited on it. Here each file weighs its measured hosted Windows test
 * duration (`vitest.shard-timings.json`, files of 200 ms or more) plus a fixed per-file
 * cost; unmeasured files weigh DEFAULT_MS. Files go, heaviest first, to the lightest
 * shard. The split is deterministic, so every shard computes the same assignment, and
 * each shard starts its heaviest files first.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

/** Median measured file duration; the weight of a file with no measurement. */
const DEFAULT_MS = 70;
/** Per-file worker cost beyond the test body (environment, imports, setup). */
const PER_FILE_MS = 90;

const timings: Record<string, number> = JSON.parse(
	readFileSync(new URL('./vitest.shard-timings.json', import.meta.url), 'utf8')
);

export class TimedShardSequencer extends BaseSequencer {
	override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
		const { index, count } = this.ctx.config.shard!;
		const root = this.ctx.config.root;
		const weighed = files.map((spec) => {
			const file = path.relative(root, spec.moduleId).split(path.sep).join('/');
			const key = `${file}\u0000${spec.project.name}`;
			return { spec, key, weight: (timings[file] ?? DEFAULT_MS) + PER_FILE_MS };
		});
		weighed.sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
		const loads = new Array<number>(count).fill(0);
		const mine: TestSpecification[] = [];
		for (const file of weighed) {
			let lightest = 0;
			for (let shard = 1; shard < count; shard++) {
				if (loads[shard] < loads[lightest]) lightest = shard;
			}
			loads[lightest] += file.weight;
			if (lightest === index - 1) mine.push(file.spec);
		}
		return mine;
	}
}
