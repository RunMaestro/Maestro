// Summarize captured samples without starting a Board host or changing fixtures.
// Input follows the disabled legacy harness's scenarios/queryRecords JSON shape.
const fs = require('node:fs');

function distribution(values) {
	if (!values.every((value) => Number.isFinite(value) && value >= 0)) {
		throw new Error('Timing samples must be finite nonnegative numbers');
	}
	const sorted = [...values].sort((a, b) => a - b);
	return {
		count: sorted.length,
		samplesMs: values,
		p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
	};
}

function summarize(captures) {
	const groups = new Map();
	for (const capture of captures) {
		if (!Array.isArray(capture.scenarios) || !Array.isArray(capture.queryRecords)) {
			throw new Error('Expected scenarios and queryRecords arrays');
		}
		const accepted = new Set();
		for (const scenario of capture.scenarios) {
			if (typeof scenario.label !== 'string' || scenario.failure) continue;
			if (accepted.has(scenario.label)) throw new Error('Duplicate scenario label in capture');
			accepted.add(scenario.label);
			const group = groups.get(scenario.label) ?? {
				elapsed: [],
				host: [],
				input: [],
				longTasks: [],
				queries: [],
			};
			group.elapsed.push(scenario.elapsedMs);
			group.input.push(...(scenario.renderer?.inputs ?? []));
			group.longTasks.push(...(scenario.renderer?.longtasks ?? []).map((task) => task.ms));
			group.queries.push(scenario.queryCount);
			groups.set(scenario.label, group);
		}
		for (const entry of capture.queryRecords) {
			const group = groups.get(entry.label);
			if (accepted.has(entry.label) && group)
				group.host.push(...entry.records.map((record) => record.ms));
		}
	}
	return Object.fromEntries(
		[...groups].map(([label, group]) => [
			label,
			{
				elapsed: distribution(group.elapsed),
				hostIpc: distribution(group.host),
				rendererInputToFrame: distribution(group.input),
				rendererLongTask: distribution(group.longTasks),
				workspaceQueriesPerScenario: distribution(group.queries),
			},
		])
	);
}

if (require.main === module) {
	const files = process.argv.slice(2);
	if (!files.length)
		throw new Error('Usage: node scripts/board-performance-summary.cjs capture.json [...]');
	console.log(
		JSON.stringify(
			{
				percentile: 'nearest-rank p95',
				scenarios: summarize(files.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))),
			},
			null,
			2
		)
	);
}

module.exports = { summarize };
