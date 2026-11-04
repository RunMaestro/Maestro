/**
 * Offline scope benchmark: production cycle/store, synthetic fleet, no desktop or provider calls.
 * Run from the checkout root (output stays in the ignored scratch directory):
 *   node_modules/.bin/esbuild scripts/bench-pianola-scope.ts --bundle --platform=node --format=esm --outfile=.maestro/pianola-scope-benchmark/run.mjs
 *   node .maestro/pianola-scope-benchmark/run.mjs .maestro/pianola-scope-benchmark
 * Repeat with a second filename argument, e.g. AFTER.json, to retain the baseline.
 * CPU/RSS/loop delays include injected transport serialization and share one process.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isPathInsideRoot } from '../src/shared/pathContainment';
import type { PianolaMessage } from '../src/shared/pianola/types';
import { createPianolaFsStore } from '../src/shared/pianola/fs-store';
import {
	runPianolaScopeCycle,
	type PianolaScopeSnapshot,
	type PianolaScopeCycleDeps,
} from '../src/shared/pianola/pianola-scope-cycle';

// Bundle with esbuild (platform=node, format=esm), then pass a workspace output directory.
const root = path.resolve(process.argv[2] ?? '.maestro/pianola-scope-benchmark');
assert.ok(
	isPathInsideRoot(path.relative(process.cwd(), root)),
	'Output must be inside this checkout'
);
fs.mkdirSync(root, { recursive: true });
assert.ok(
	isPathInsideRoot(path.relative(fs.realpathSync(process.cwd()), fs.realpathSync(root))),
	'Output resolves outside this checkout'
);
const output = path.join(root, process.argv[3] ?? 'BASELINE.json');
assert.equal(
	path.dirname(output),
	root,
	'Output filename must stay inside the benchmark directory'
);
const cases = [];
for (const [name, fleet, changed, length, busy] of [
	['idle-fleet', 500, 0, 1, false],
	['few-active', 500, 3, 10, false],
	['completion-burst', 500, 45, 10, false],
	['long-turn', 500, 1, 2000, false],
	['busy-question', 500, 1, 10, true],
] as const) {
	const dir = fs.mkdtempSync(path.join(root, 'baseline-fixture-'));
	try {
		const store = createPianolaFsStore({ resolveDir: () => dir, indent: 2, trailingNewline: true });
		const id = '11111111-1111-4111-8111-111111111111';
		store.writeSupervisorTargets([
			{
				id,
				kind: 'watch-scope',
				enabled: true,
				createdAt: 1,
				managerAgentId: 'manager',
				selection: {
					label: 'Synthetic',
					mode: 'agents-and-groups',
					agentIds: ['worker'],
					groupIds: [],
					excludedAgentIds: [],
				},
			},
		]);
		const snapshot: PianolaScopeSnapshot = {
			capturedAt: 100,
			complete: true,
			owners: [
				{
					id: 'worker',
					cwd: dir,
					groupId: null,
					parentSessionId: null,
					isPianola: false,
					remote: false,
				},
			],
			tabs: [],
		};
		const histories = new Map<string, PianolaMessage[]>();
		for (let n = 0; n < fleet; n++)
			snapshot.tabs.push({
				agentId: 'worker',
				tabId: `tab-${n}`,
				createdAt: 50,
				paused: false,
				consult: false,
				ephemeral: false,
				busy: false,
				cursorAvailable: true,
				cursor: null,
			});
		let counts!: {
			snapshots: number;
			snapshotBytes: number;
			transcripts: number;
			transcriptBytes: number;
			checkpointWrites: number;
			checkpointBytes: number;
			decisionReads: number;
			dispatches: number;
			judgments: number;
			issues: number;
		};
		const seen = new Set<string>();
		const reset = () =>
			(counts = {
				snapshots: 0,
				snapshotBytes: 0,
				transcripts: 0,
				transcriptBytes: 0,
				checkpointWrites: 0,
				checkpointBytes: 0,
				decisionReads: 0,
				dispatches: 0,
				judgments: 0,
				issues: 0,
			});
		reset();
		const deps: PianolaScopeCycleDeps = {
			store: {
				...store,
				readDecisions: () => {
					counts.decisionReads++;
					return store.readDecisions();
				},
				writeScopeCheckpoint: (c) => {
					counts.checkpointWrites++;
					counts.checkpointBytes += Buffer.byteLength(JSON.stringify(c, null, 2) + '\n');
					store.writeScopeCheckpoint(c);
				},
			},
			readSnapshot: async () => {
				counts.snapshots++;
				counts.snapshotBytes += Buffer.byteLength(JSON.stringify(snapshot));
				return structuredClone(snapshot);
			},
			readTranscript: async (t) => {
				const r = { agentId: t.agentId, tabId: t.tabId, messages: histories.get(t.tabId) ?? [] };
				seen.add(t.tabId);
				counts.transcripts++;
				counts.transcriptBytes += Buffer.byteLength(JSON.stringify(r));
				return structuredClone(r);
			},
			watch: {
				readRules: () => [],
				recordDecision: (r) => store.appendDecision(r),
				now: () => new Date().toISOString(),
				genId: () => randomUUID(),
				log: () => {},
				notify: () => {},
			},
			dispatch: async () => {
				counts.dispatches++;
				return { status: 'accepted' };
			},
			requestJudgment: async () => {
				counts.judgments++;
				return { status: 'accepted' };
			},
		};
		await runPianolaScopeCycle(id, deps, { dryRun: false, maxTabs: 20 });
		for (let n = 0; n < changed; n++) {
			const messages: PianolaMessage[] = Array.from({ length }, (_, i) => ({
				id: `m-${i}`,
				role: i === 0 ? 'user' : 'assistant',
				source: i === 0 ? 'user' : 'ai',
				content:
					i === length - 1
						? 'Should I name it count or total?'
						: 'Investigate the naming convention. '.repeat(30),
				timestamp: '2026-11-04T00:00:00.000Z',
			}));
			histories.set(`tab-${n}`, messages);
			snapshot.tabs[n].cursor = {
				id: messages.at(-1)!.id,
				count: length,
				textLength: messages.at(-1)!.content.length,
			};
			snapshot.tabs[n].busy = busy;
		}
		reset();
		seen.clear();
		const delay = monitorEventLoopDelay({ resolution: 1 });
		delay.enable();
		await new Promise((r) => setTimeout(r, 5));
		const cpu = process.cpuUsage(),
			rss = process.memoryUsage().rss,
			start = performance.now();
		const cycles = [];
		for (let i = 0; i < 5; i++) {
			snapshot.capturedAt += 10;
			const t = performance.now();
			const result = await runPianolaScopeCycle(id, deps, { dryRun: false, maxTabs: 20 });
			counts.issues += result.issues.length;
			cycles.push(performance.now() - t);
			await new Promise((r) => setImmediate(r));
		}
		const elapsed = performance.now() - start,
			cpuUsed = process.cpuUsage(cpu);
		await new Promise((r) => setTimeout(r, 5));
		delay.disable();
		assert.equal(counts.issues, 0);
		assert.equal(counts.judgments, 0);
		assert.equal(counts.dispatches, 0);
		if (changed === 0) assert.equal(counts.transcripts, 0);
		else if (!busy) assert.equal(seen.size, changed);
		const sorted = [...cycles].sort((a, b) => a - b);
		cases.push({
			name,
			fleet,
			changed,
			historyMessages: length,
			busy,
			cycles: 5,
			...counts,
			uniqueTranscripts: seen.size,
			modelInvocations: 0,
			cycleMs: cycles,
			p50CycleMs: sorted[2],
			p95CycleMs: sorted[4],
			elapsedMs: elapsed,
			cpuUserMicros: cpuUsed.user,
			cpuSystemMicros: cpuUsed.system,
			rssBefore: rss,
			rssAfter: process.memoryUsage().rss,
			eventLoopMaxMs: delay.max / 1e6,
			eventLoopP95Ms: delay.percentile(95) / 1e6,
			fixtureProcesses: 1,
			agentProcesses: 0,
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
fs.writeFileSync(
	output,
	JSON.stringify(
		{
			schema: 1,
			created: new Date().toISOString(),
			head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
			branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
			node: process.version,
			platform: process.platform,
			arch: process.arch,
			limits: [
				'Real production cycle and atomic filesystem store; injected native snapshots and transcripts, not Electron/WebSocket.',
				'Byte counters measure JSON payload equivalents, not actual network traffic or disk blocks.',
				'No rules/profile; model and dispatch hooks forbidden by assertions; real provider invocations not performed.',
				'Five serial cycles per case; no polling sleeps. CPU/RSS/eventloop are shared-process diagnostic observations, not UI or fleet forecasts.',
				'Baseline enrollment excluded. Model callback latency and real detection/response latency unmeasured.',
			],
			cases,
		},
		null,
		2
	) + '\n'
);
console.log(
	JSON.stringify(
		cases.map((c) => ({
			name: c.name,
			transcripts: c.transcripts,
			writes: c.checkpointWrites,
			bytes: c.checkpointBytes,
			p95: c.p95CycleMs,
		}))
	)
);
