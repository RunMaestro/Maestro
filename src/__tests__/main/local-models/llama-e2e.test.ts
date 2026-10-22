/**
 * @file llama-e2e.test.ts
 *
 * The llama runtime, end to end on real hardware: install the runtime and the
 * Qwen3 1.7B GGUF through the core Local Models service, run the self-test
 * against the real loader, route utterances through the local Conductor Brain
 * (`AssignedBrainProvider`) with the JSON-schema grammar, and measure load
 * time, throughput, and memory.
 *
 * Unit tests mock node-llama-cpp, so they cannot tell whether the downloaded
 * runtime actually loads, whether the prebuilt binary initializes a backend on
 * this machine, or whether the grammar path works against a real model. This
 * is the one test that can, and its numbers go into
 * `docs/architecture/local-models.md`.
 *
 * Opt-in only (about 1.1 GB of model plus 37 MB of runtime over the network on
 * the first run, then seconds of inference): SKIPPED unless
 *   MAESTRO_LOCAL_MODEL_E2E=1
 * Run with:
 *   MAESTRO_LOCAL_MODEL_E2E=1 env -u MAESTRO_USER_DATA npx vitest run src/__tests__/main/local-models/llama-e2e.test.ts
 *
 * Installs land in a scratch data dir, never the live Maestro one, and the dir
 * is kept between runs so only the first run pays the download. Override it
 * with MAESTRO_LOCAL_MODEL_E2E_DIR.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const RUN = process.env.MAESTRO_LOCAL_MODEL_E2E === '1';
const DATA_DIR =
	process.env.MAESTRO_LOCAL_MODEL_E2E_DIR ?? path.join(os.tmpdir(), 'maestro-local-model-e2e');

vi.mock('electron', () => ({
	app: { getPath: () => DATA_DIR },
}));

import {
	downloadLocalModel,
	installLocalRuntime,
	listLocalRuntimes,
	verifyLocalModel,
} from '../../../main/local-models/service';
import { runRuntimeSelfTest } from '../../../main/local-models/runtime/runtime-selftest';
import {
	__setNativeImporter,
	loadNativeRuntime,
} from '../../../main/local-models/runtime/native-loader';
import {
	LLAMA_GET_OPTIONS,
	llamaBackendLabel,
} from '../../../main/local-models/runtime/llama-options';
import { modelFilePath } from '../../../main/local-models/model-store';
import {
	AssignedBrainProvider,
	localEngineTaskRunner,
} from '../../../main/acappella/providers/local/assigned-brain';
import { LocalTextEngine } from '../../../main/local-models/text-gen';
import { QWEN3_1_7B_ID } from '../../../shared/local-models/model-catalog';
import { QWEN3_BRAIN_PROVIDER_ID } from '../../../shared/acappella/provider-catalog';
import type { RosterAgent } from '../../../shared/acappella/protocol';
import { ROUTE_TAB_ACTIONS, holdsTheFloor } from '../../../shared/acappella/route-decision';

/** Generous on a slow link: the model alone is 1.1 GB. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const INFERENCE_TIMEOUT_MS = 5 * 60_000;

const ROSTER: RosterAgent[] = [
	{
		sessionId: 'agent-backend',
		name: 'Backend',
		agentType: 'claude-code',
		cwd: '/repo/api',
		tabs: [{ id: 'tab-auth', name: 'Auth', lastActiveAt: 1 }],
	},
	{
		sessionId: 'agent-frontend',
		name: 'Frontend',
		agentType: 'claude-code',
		cwd: '/repo/web',
		tabs: [{ id: 'tab-css', name: 'Styles', lastActiveAt: 2 }],
	},
];

const MB = 1024 * 1024;

/** Measurements printed at the end, for the architecture doc. */
const results: Record<string, string | number | boolean> = {};

describe.skipIf(!RUN)('llama runtime end to end (MAESTRO_LOCAL_MODEL_E2E=1)', () => {
	beforeAll(() => {
		// `paths.ts` prefers MAESTRO_USER_DATA over Electron. An agent shell
		// exports it pointing at the LIVE data dir, so pin it to the scratch dir.
		process.env.MAESTRO_USER_DATA = DATA_DIR;
		// The loader's production importer is a `new Function` wrapper around
		// `import()`, which vitest's module VM refuses ("A dynamic import callback
		// was not specified"). A real `import()` written here gets the same entry
		// path, converted the same way, so the runtime under test is still the
		// downloaded one.
		__setNativeImporter(
			(specifier) =>
				import(
					/* @vite-ignore */ path.isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier
				)
		);
		results.dataDir = DATA_DIR;
		results.platform = `${process.platform}-${process.arch}`;
		results.totalRamMb = Math.round(os.totalmem() / MB);
	});

	afterAll(() => {
		__setNativeImporter(null);
		// Recorded rather than asserted: these are the numbers the doc records.
		// Written to a file as well as the console, because vitest swallows the
		// console output of a passing suite.
		const report = JSON.stringify(results, null, 2);
		writeFileSync(path.join(DATA_DIR, 'llama-e2e-results.json'), `${report}\n`);
		console.log(`[llama-e2e] results\n${report}`);
	});

	it(
		'installs the llama runtime through the core service',
		async () => {
			const before = (await listLocalRuntimes()).find((runtime) => runtime.id === 'llama')!;
			expect(before.downloadable).toBe(true);

			const started = Date.now();
			if (!before.installed || before.stale) await installLocalRuntime('llama');
			results.runtimeInstallMs = Date.now() - started;
			results.runtimeBytes = before.bytes;

			const after = (await listLocalRuntimes()).find((runtime) => runtime.id === 'llama')!;
			expect(after.installed).toBe(true);
			expect(after.stale).toBe(false);
		},
		DOWNLOAD_TIMEOUT_MS
	);

	it(
		'downloads and verifies the Qwen3 1.7B model through the core service',
		async () => {
			const started = Date.now();
			if (!(await verifyLocalModel(QWEN3_1_7B_ID)).ok) {
				const download = await downloadLocalModel(QWEN3_1_7B_ID);
				expect(download.error ?? null).toBeNull();
				expect(download.status).toBe('complete');
			}
			results.modelDownloadMs = Date.now() - started;

			expect((await verifyLocalModel(QWEN3_1_7B_ID)).ok).toBe(true);
		},
		DOWNLOAD_TIMEOUT_MS
	);

	it('passes the runtime self-test with a real backend', async () => {
		const report = await runRuntimeSelfTest();
		const llama = report.entries.find((entry) => entry.runtimeId === 'llama')!;

		results.selfTest = `${llama.status} in ${llama.durationMs} ms: ${llama.detail}`;
		expect(llama.status).toBe('pass');
		expect(llama.detail).toMatch(/^llama\.cpp backend: /);
	}, 60_000);

	it(
		'routes utterances through the local Conductor Brain with the grammar',
		async () => {
			// The real engine (real runtime loader, real installed-model check), just
			// never idle-unloaded mid-test. In the app the Brain reaches it through
			// the task router and the `voice-routing` assignment; there is no settings
			// store here, so the turns run on the engine directly.
			const engine = new LocalTextEngine({ idleUnloadMs: 0 });
			const brain = new AssignedBrainProvider({
				id: QWEN3_BRAIN_PROVIDER_ID,
				runTask: localEngineTaskRunner(engine, QWEN3_1_7B_ID),
			});
			try {
				const context = { roster: ROSTER, scope: { kind: 'conductor' as const } };

				// The first turn pays the model load; the second is the warm cost
				// every later utterance in a conversation pays.
				let started = Date.now();
				const cold = await brain.route(
					'tell the frontend agent to fix the navbar padding',
					context
				);
				results.routeColdMs = Date.now() - started;

				started = Date.now();
				const warm = await brain.route('ask backend to add rate limiting to login', context);
				results.routeWarmMs = Date.now() - started;

				results.coldDecision = JSON.stringify(cold);
				results.warmDecision = JSON.stringify(warm);

				// What this proves is the grammar path: every turn came back as a
				// structurally valid decision aimed at the Conductor or a roster agent,
				// never free text. Routing ACCURACY is recorded, not asserted: the
				// 1.7B model sends an utterance that names an agent to the Conductor
				// (see docs/architecture/local-models.md), which is why no local model
				// is offered in the Conductor Brain picker yet.
				const rosterIds = ROSTER.map((agent) => agent.sessionId);
				for (const decision of [cold, warm]) {
					if (decision.target !== 'conductor') {
						expect(rosterIds).toContain(decision.target.sessionId);
					}
					expect(ROUTE_TAB_ACTIONS).toContain(decision.tabAction);
					expect(decision.confidence).toBeGreaterThanOrEqual(0);
					expect(decision.confidence).toBeLessThanOrEqual(1);
					expect(decision.prompt.length).toBeGreaterThan(0);
				}
				results.routedToNamedAgent = [cold, warm].filter(
					(decision) => decision.target !== 'conductor'
				).length;
				// With the grammar schema the optional fields may be null, so a
				// decision is no longer forced to carry a clarifying question.
				results.heldTheFloor = [cold, warm].filter(holdsTheFloor).length;
			} finally {
				await engine.unload();
			}
		},
		INFERENCE_TIMEOUT_MS
	);

	it(
		'measures load time, throughput, and memory on the raw runtime',
		async () => {
			// Throughput needs a token count, which the provider does not expose, so
			// this drives node-llama-cpp directly with the same backend options.
			interface Llama {
				gpu: unknown;
				buildType: unknown;
				loadModel(options: { modelPath: string }): Promise<Model>;
				getVramState(): Promise<{ total: number; used: number; unifiedSize?: number }>;
				dispose(): Promise<void>;
			}
			interface Model {
				tokenize(text: string): readonly unknown[];
				createContext(options: { contextSize: number }): Promise<Context>;
				dispose(): Promise<void>;
			}
			interface Context {
				getSequence(): unknown;
				dispose(): Promise<void>;
			}
			const module = await loadNativeRuntime<{
				getLlama(options: Record<string, unknown>): Promise<Llama>;
				LlamaChatSession: new (options: Record<string, unknown>) => {
					prompt(text: string, options: Record<string, unknown>): Promise<string>;
				};
			}>('llama');

			const rssBefore = process.memoryUsage().rss;
			let started = Date.now();
			const llama = await module.getLlama({ ...LLAMA_GET_OPTIONS });
			results.backendInitMs = Date.now() - started;
			results.backend = llamaBackendLabel(llama);
			results.buildType = String(llama.buildType);

			started = Date.now();
			const model = await llama.loadModel({
				modelPath: modelFilePath(QWEN3_1_7B_ID, 'Qwen3-1.7B-Q4_K_M.gguf'),
			});
			const context = await model.createContext({ contextSize: 4096 });
			results.modelLoadMs = Date.now() - started;

			try {
				const session = new module.LlamaChatSession({ contextSequence: context.getSequence() });
				started = Date.now();
				const text = await session.prompt(
					'Explain in one paragraph why a build cache speeds up CI. /no_think',
					{ temperature: 0, maxTokens: 200 }
				);
				const genMs = Date.now() - started;
				const tokens = model.tokenize(text).length;

				results.genTokens = tokens;
				results.genMs = genMs;
				results.tokensPerSecond = Math.round((tokens / genMs) * 1000 * 10) / 10;
				results.rssDeltaMb = Math.round((process.memoryUsage().rss - rssBefore) / MB);
				const vram = await llama.getVramState();
				results.vramUsedMb = Math.round(vram.used / MB);
				results.unifiedMemory = (vram.unifiedSize ?? 0) > 0;

				expect(tokens).toBeGreaterThan(0);
			} finally {
				await context.dispose();
				await model.dispose();
				await llama.dispose();
			}
		},
		INFERENCE_TIMEOUT_MS
	);
});
