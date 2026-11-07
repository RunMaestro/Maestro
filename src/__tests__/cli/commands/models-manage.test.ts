/**
 * @file models-manage.test.ts
 * @description Tests for `maestro-cli models list|install|pause|cancel|remove|verify|add-hf|remove-hf`:
 * ids are checked against the catalog before the bridge is opened, every verb
 * crosses the WS bridge in the shape the desktop handler expects, a pending
 * model is never offered for download, removing a model a task runs on is
 * refused until `--force`, naming the tasks, the list groups the way the
 * Library does and judges fit with the same rule, and a model added from
 * Hugging Face prints its license and is labeled as not verified.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({
	readLocalModelAssignments: vi.fn(() => ({})),
	readSettingValue: vi.fn(),
}));

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import {
	modelsAddHf,
	modelsCancel,
	modelsInstall,
	modelsList,
	modelsPause,
	modelsRemove,
	modelsRemoveHf,
	modelsVerify,
} from '../../../cli/commands/models-manage';
import { readLocalModelAssignments, readSettingValue } from '../../../cli/services/storage';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import {
	BGE_SMALL_EN_ID,
	getLocalModel,
	GPT_OSS_120B_ID,
	GPT_OSS_20B_ID,
	LOCAL_MODEL_CATALOG,
	PROMPT_GUARD_2_22M_ID,
	QWEN3_1_7B_ID,
	setUserLocalModels,
} from '../../../shared/local-models/model-catalog';
import type { HardwareProfile } from '../../../shared/local-models/model-fit';
import type { LocalModelEntry } from '../../../shared/local-models/types';
import {
	USER_MODEL_UNVERIFIED_LABEL,
	userLocalModelEntry,
} from '../../../shared/local-models/user-models';
import type { LocalModelListing } from '../../../main/local-models/service';
import { formatError } from '../../../cli/output/formatter';

/** A model the user added from Hugging Face, as the desktop lists it. */
const USER_ENTRY = userLocalModelEntry({
	id: 'hf-unsloth-qwen3.5-2b-q4_k_m',
	displayName: 'Qwen3.5-2B-Q4_K_M',
	repo: 'unsloth/Qwen3.5-2B-GGUF',
	revision: 'f6d5376be1edb4d416d56da11e5397a961aca8ae',
	license: { spdx: 'apache-2.0', url: 'https://huggingface.co/Qwen/Qwen3.5-2B/blob/main/LICENSE' },
	files: [{ path: 'Qwen3.5-2B-Q4_K_M.gguf', sha256: 'a'.repeat(64), bytes: 1_280_835_840 }],
	parametersB: 1.88,
	contextLength: 262_144,
	addedAt: 0,
});

const MAC_32GB: HardwareProfile = {
	platform: 'darwin',
	arch: 'arm64',
	totalMemoryBytes: 32 * 1024 ** 3,
	unifiedMemory: true,
	gpus: [],
};

function mockSend(reply: Record<string, unknown>) {
	const captured: { payload?: Record<string, unknown>; responseType?: string; timeout?: number } =
		{};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi
				.fn()
				.mockImplementation((payload: Record<string, unknown>, rt: string, timeout?: number) => {
					captured.payload = payload;
					captured.responseType = rt;
					captured.timeout = timeout;
					return Promise.resolve(reply);
				}),
		} as never)
	);
	return captured;
}

function listing(
	id: string,
	status: 'installed' | 'not-installed' | 'corrupt',
	entry: LocalModelEntry = getLocalModel(id)!
): LocalModelListing {
	return {
		entry,
		status: {
			id,
			status,
			manifest: null,
			bytesOnDisk: status === 'installed' ? entry.bytes : 0,
			...(status === 'corrupt' ? { detail: 'Hash mismatch' } : {}),
		},
		installPaths: [],
	};
}

const PENDING = LOCAL_MODEL_CATALOG.find((entry) => entry.pending);

describe('models list|install|pause|cancel|remove|verify commands', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(readSettingValue).mockReturnValue(undefined);
		vi.mocked(readLocalModelAssignments).mockReturnValue({});
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	describe('list', () => {
		it('lists the Library in its groups with status, footprint, and task usage', async () => {
			vi.mocked(readLocalModelAssignments).mockReturnValue({
				'semantic-search': { type: 'local', modelId: BGE_SMALL_EN_ID },
			});
			const captured = mockSend({
				success: true,
				listings: [
					listing(BGE_SMALL_EN_ID, 'installed'),
					listing(PROMPT_GUARD_2_22M_ID, 'corrupt'),
				],
				footprint: { bytes: 1024 * 1024 * 130, models: [] },
			});

			await modelsList({});

			expect(captured.payload).toEqual({ type: 'local_models_list' });
			expect(captured.responseType).toBe('local_models_list_result');
			const output = logSpy.mock.calls[0][0] as string;
			expect(output).toMatch(/LOCAL MODELS/);
			expect(output).toMatch(/Embeddings/);
			expect(output).toMatch(/Classifiers/);
			expect(output).toMatch(new RegExp(`${BGE_SMALL_EN_ID}\\s+installed`));
			expect(output).toMatch(new RegExp(`${PROMPT_GUARD_2_22M_ID}\\s+corrupt`));
			expect(output).toMatch(/Hash mismatch/);
			expect(output).toMatch(/in use by: Semantic search/);
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('groups text models by role, says what each is good at, and labels a user model', async () => {
			mockSend({
				success: true,
				listings: [
					listing(QWEN3_1_7B_ID, 'not-installed'),
					listing(GPT_OSS_20B_ID, 'not-installed'),
					listing(USER_ENTRY.id, 'not-installed', USER_ENTRY),
				],
				footprint: { bytes: 0, models: [] },
			});

			await modelsList({});

			const output = logSpy.mock.calls[0][0] as string;
			// Group order is the Library's: agent models, then housekeeping (a judge
			// is a housekeeping model with a Judge badge), then the user's own.
			const at = (text: string) => output.indexOf(text);
			expect(at('Agent Models')).toBeGreaterThan(-1);
			expect(at('Agent Models')).toBeLessThan(at('Housekeeping'));
			expect(at('Housekeeping')).toBeLessThan(at('Added from Hugging Face'));
			expect(output).not.toMatch(/Text generation/);
			expect(output).toContain(`good at: ${getLocalModel(GPT_OSS_20B_ID)!.goodAt}`);
			expect(output).toContain('[Agent-ready: Claude Code, Codex]');
			expect(output).toContain(`[${USER_MODEL_UNVERIFIED_LABEL}]`);
			expect(output).toMatch(/Cloud only: .*DeepSeek V4.*GLM-5\.3/);
			// No fit was asked for, so none is claimed.
			expect(output).not.toMatch(/Fits|Too large|This computer/);
		});

		it('judges each model against the hardware the app reports with --fit', async () => {
			const captured = mockSend({
				success: true,
				listings: [
					listing(QWEN3_1_7B_ID, 'not-installed'),
					listing(GPT_OSS_120B_ID, 'not-installed'),
				],
				footprint: { bytes: 0, models: [] },
				hardware: MAC_32GB,
			});

			await modelsList({ fit: true });

			expect(captured.payload).toEqual({ type: 'local_models_list', fit: true });
			const output = logSpy.mock.calls[0][0] as string;
			expect(output).toContain('This computer: 32.0 GB of unified memory (Apple Silicon)');
			expect(output).toMatch(/Fits: Needs /);
			expect(output).toMatch(/Too large: Needs .*more than 90% of this Mac/);
		});

		it('puts the fit, its reason and the hardware in the JSON', async () => {
			mockSend({
				success: true,
				listings: [
					listing(GPT_OSS_120B_ID, 'not-installed'),
					listing(USER_ENTRY.id, 'not-installed', USER_ENTRY),
				],
				footprint: { bytes: 0, models: [] },
				hardware: {
					...MAC_32GB,
					platform: 'win32',
					unifiedMemory: false,
					gpus: [{ name: 'NVIDIA GeForce RTX 4060', vramBytes: null, source: 'electron' }],
				},
			});

			await modelsList({ fit: true, json: true });

			const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
			expect(parsed.hardwareSummary).toContain('memory not reported');
			expect(parsed.fitCaveat).toContain('model server engine');
			expect(parsed.models[0]).toMatchObject({
				id: GPT_OSS_120B_ID,
				group: 'agent',
				section: 'agents',
				roles: ['agent', 'housekeeping'],
				agentHarnesses: ['claude-code', 'codex'],
				fit: 'too-large',
			});
			expect(parsed.models[0].fitReason).toMatch(/\.$/);
			expect(parsed.models[0].userAdded).toBeUndefined();
			expect(parsed.models[1]).toMatchObject({
				id: USER_ENTRY.id,
				group: 'user',
				section: 'custom',
				userAdded: true,
				verifiedByMaestro: false,
				roles: [],
			});
		});

		it('fails by name when the app sends no hardware for --fit', async () => {
			mockSend({ success: true, listings: [], footprint: { bytes: 0, models: [] } });
			await expect(modelsList({ fit: true })).rejects.toThrow('__exit__');
			expect(errorSpy.mock.calls[0][0]).toMatch(/hardware/);
		});

		it('filters by kind and prints JSON for scripts', async () => {
			mockSend({
				success: true,
				listings: [
					listing(BGE_SMALL_EN_ID, 'installed'),
					listing(PROMPT_GUARD_2_22M_ID, 'not-installed'),
				],
				footprint: { bytes: 42, models: [] },
			});

			await modelsList({ kind: 'embedding', json: true });

			const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
			expect(parsed.success).toBe(true);
			expect(parsed.footprintBytes).toBe(42);
			expect(parsed.models.map((model: { id: string }) => model.id)).toEqual([BGE_SMALL_EN_ID]);
			expect(parsed.models[0]).toMatchObject({ kind: 'embedding', status: 'installed' });
		});

		it('refuses an unknown kind before opening the bridge', async () => {
			await expect(modelsList({ kind: 'vision' })).rejects.toThrow('__exit__');

			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
			expect(errorSpy.mock.calls[0][0]).toMatch(/--kind must be one of/);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});

	describe('install', () => {
		it('downloads through the bridge with a long wait and reports success', async () => {
			const captured = mockSend({
				success: true,
				result: { modelId: BGE_SMALL_EN_ID, status: 'complete' },
			});

			await modelsInstall(BGE_SMALL_EN_ID, {});

			expect(captured.payload).toEqual({ type: 'local_models_download', modelId: BGE_SMALL_EN_ID });
			expect(captured.responseType).toBe('local_models_download_result');
			expect(captured.timeout).toBeGreaterThan(60 * 60 * 1000);
			expect(logSpy.mock.calls.at(-1)?.[0]).toMatch(/Installed BGE Small/);
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('says when the engine was installed with the model, and when it could not be', async () => {
			mockSend({
				success: true,
				result: {
					modelId: QWEN3_1_7B_ID,
					status: 'complete',
					runtime: { runtimeId: 'llama', status: 'installed' },
				},
			});
			await modelsInstall(QWEN3_1_7B_ID, {});
			let printed = logSpy.mock.calls.map(([line]) => String(line)).join('\n');
			expect(printed).toMatch(/Installed Qwen3/);
			expect(printed).toMatch(/Installed its engine too \(llama\)/);

			logSpy.mockClear();
			mockSend({
				success: true,
				result: {
					modelId: QWEN3_1_7B_ID,
					status: 'complete',
					runtime: { runtimeId: 'llama', status: 'failed', error: 'hash mismatch' },
				},
			});
			await modelsInstall(QWEN3_1_7B_ID, {});
			printed = logSpy.mock.calls.map(([line]) => String(line)).join('\n');
			// The weights arrived, so this is not a failed install, but a model that
			// cannot run must not be reported as simply installed.
			expect(printed).toMatch(/did not install: hash mismatch/);
			expect(printed).toMatch(/maestro-cli models runtimes install llama/);
			expect(exitSpy).not.toHaveBeenCalled();

			logSpy.mockClear();
			mockSend({
				success: true,
				result: {
					modelId: QWEN3_1_7B_ID,
					status: 'complete',
					runtime: { runtimeId: 'llama', status: 'unavailable' },
				},
			});
			await modelsInstall(QWEN3_1_7B_ID, { json: true });
			expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
				success: true,
				status: 'complete',
				runtime: { runtimeId: 'llama', status: 'unavailable' },
			});
		});

		it('exits non-zero with the hash mismatch when the download fails', async () => {
			mockSend({
				success: true,
				result: {
					modelId: BGE_SMALL_EN_ID,
					status: 'error',
					error: 'Hash mismatch',
					mismatch: { path: 'model.onnx', expected: 'aa', actual: 'bb' },
				},
			});

			await expect(modelsInstall(BGE_SMALL_EN_ID, {})).rejects.toThrow('__exit__');

			expect(errorSpy.mock.calls[0][0]).toMatch(
				/Hash mismatch \(model\.onnx: expected aa, got bb\)/
			);
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		});

		it.skipIf(!PENDING)('refuses a pending model without opening the bridge', async () => {
			await expect(modelsInstall(PENDING!.id, {})).rejects.toThrow('__exit__');

			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
			expect(errorSpy.mock.calls[0][0]).toMatch(/not offered for download/);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('refuses an unknown model id without opening the bridge', async () => {
			await expect(modelsInstall('gpt-17', {})).rejects.toThrow('__exit__');

			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
			expect(errorSpy.mock.calls[0][0]).toMatch(/Unknown model "gpt-17"/);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});

	describe('pause', () => {
		it('pauses through the bridge and names the command that resumes', async () => {
			const captured = mockSend({ success: true, paused: true });

			await modelsPause(BGE_SMALL_EN_ID, {});

			expect(captured.payload).toEqual({ type: 'local_models_pause', modelId: BGE_SMALL_EN_ID });
			expect(captured.responseType).toBe('local_models_pause_result');
			const output = logSpy.mock.calls.map((call) => call[0] as string).join('\n');
			expect(output).toMatch(/Paused/);
			expect(output).toContain(`maestro-cli models install ${BGE_SMALL_EN_ID}`);
		});

		it('reports a model that was not downloading as an answer, not a failure', async () => {
			mockSend({ success: true, paused: false });

			await modelsPause(BGE_SMALL_EN_ID, { json: true });

			expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
				success: true,
				modelId: BGE_SMALL_EN_ID,
				paused: false,
			});
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('refuses an unknown model id without opening the bridge', async () => {
			await expect(modelsPause('nope', {})).rejects.toThrow('__exit__');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});

	describe('cancel', () => {
		it('cancels through the bridge and reports whether a download was running', async () => {
			const captured = mockSend({ success: true, cancelled: true });

			await modelsCancel(BGE_SMALL_EN_ID, { json: true });

			expect(captured.payload).toEqual({ type: 'local_models_cancel', modelId: BGE_SMALL_EN_ID });
			expect(captured.responseType).toBe('local_models_cancel_result');
			expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
				success: true,
				modelId: BGE_SMALL_EN_ID,
				cancelled: true,
			});
		});

		it('says so when nothing was downloading', async () => {
			mockSend({ success: true, cancelled: false });

			await modelsCancel(BGE_SMALL_EN_ID, {});

			expect(logSpy.mock.calls[0][0] as string).toMatch(/was not downloading/);
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('reports a refused request from the app', async () => {
			mockSend({ success: false, error: 'UnknownLocalModel: nope' });

			await expect(modelsCancel(BGE_SMALL_EN_ID, {})).rejects.toThrow('__exit__');
			expect(errorSpy.mock.calls[0][0] as string).toContain('UnknownLocalModel');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		});
	});

	describe('remove', () => {
		it('includes inherited utility tasks in the in-use guard', async () => {
			vi.mocked(readSettingValue).mockReturnValue({ type: 'local', modelId: QWEN3_1_7B_ID });
			await expect(modelsRemove(QWEN3_1_7B_ID, {})).rejects.toThrow('__exit__');
			expect(errorSpy.mock.calls[0][0]).toMatch(
				/assigned to Tab naming, Summaries, AI command mode/
			);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('removes an unassigned model and reports the bytes reclaimed', async () => {
			const captured = mockSend({ success: true, bytes: 2048 });

			await modelsRemove(BGE_SMALL_EN_ID, { json: true });

			expect(captured.payload).toEqual({ type: 'local_models_remove', modelId: BGE_SMALL_EN_ID });
			expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
				success: true,
				modelId: BGE_SMALL_EN_ID,
				bytesReclaimed: 2048,
				tasks: [],
			});
		});

		it('refuses a model a task is assigned to, naming the task, until --force', async () => {
			vi.mocked(readLocalModelAssignments).mockReturnValue({
				'semantic-search': { type: 'local', modelId: BGE_SMALL_EN_ID },
			});

			await expect(modelsRemove(BGE_SMALL_EN_ID, {})).rejects.toThrow('__exit__');

			expect(errorSpy.mock.calls[0][0]).toMatch(/assigned to Semantic search/);
			expect(errorSpy.mock.calls[0][0]).toMatch(/--force/);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('removes an assigned model with --force and names what became unavailable', async () => {
			vi.mocked(readLocalModelAssignments).mockReturnValue({
				'semantic-search': { type: 'local', modelId: BGE_SMALL_EN_ID },
			});
			mockSend({ success: true, bytes: 2048 });

			await modelsRemove(BGE_SMALL_EN_ID, { force: true });

			const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
			expect(output).toMatch(/Removed BGE Small/);
			expect(output).toMatch(/Now unavailable: Semantic search/);
			expect(exitSpy).not.toHaveBeenCalled();
		});
	});

	describe('verify', () => {
		it('reports a verified model', async () => {
			const captured = mockSend({
				success: true,
				result: { id: BGE_SMALL_EN_ID, ok: true, status: 'installed' },
			});

			await modelsVerify(BGE_SMALL_EN_ID, {});

			expect(captured.payload).toEqual({ type: 'local_models_verify', modelId: BGE_SMALL_EN_ID });
			expect(captured.responseType).toBe('local_models_verify_result');
			expect(logSpy.mock.calls[0][0]).toMatch(/BGE Small \(English\) verified/);
		});

		it('exits non-zero for a corrupt model with JSON success false', async () => {
			mockSend({
				success: true,
				result: { id: BGE_SMALL_EN_ID, ok: false, status: 'corrupt', detail: 'Hash mismatch' },
			});

			await expect(modelsVerify(BGE_SMALL_EN_ID, { json: true })).rejects.toThrow('__exit__');

			expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
				success: false,
				status: 'corrupt',
			});
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		});

		it('reports a refused request from the app', async () => {
			mockSend({ success: false, error: 'UnknownLocalModel' });

			await expect(modelsVerify(BGE_SMALL_EN_ID, {})).rejects.toThrow('__exit__');

			expect(errorSpy).toHaveBeenCalledWith(formatError('UnknownLocalModel'));
		});
	});

	describe('add-hf', () => {
		it('adds through the bridge and prints the license, the label, and the next step', async () => {
			const captured = mockSend({ success: true, entry: USER_ENTRY, added: true });

			await modelsAddHf('unsloth/Qwen3.5-2B-GGUF', 'Qwen3.5-2B-Q4_K_M.gguf', {});

			expect(captured.payload).toEqual({
				type: 'local_models_hf_add',
				repo: 'unsloth/Qwen3.5-2B-GGUF',
				file: 'Qwen3.5-2B-Q4_K_M.gguf',
			});
			expect(captured.responseType).toBe('local_models_hf_add_result');
			const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
			expect(output).toMatch(/Added Qwen3\.5-2B-Q4_K_M to the Library/);
			expect(output).toContain(`Id:       ${USER_ENTRY.id}`);
			expect(output).toContain(
				'License:  apache-2.0 (https://huggingface.co/Qwen/Qwen3.5-2B/blob/main/LICENSE)'
			);
			expect(output).toContain('unsloth/Qwen3.5-2B-GGUF@f6d5376');
			expect(output).toContain(USER_MODEL_UNVERIFIED_LABEL);
			expect(output).toContain(`maestro-cli models install ${USER_ENTRY.id}`);
		});

		it('describes the model without adding it with --dry-run', async () => {
			const captured = mockSend({ success: true, entry: USER_ENTRY, added: false, dryRun: true });

			await modelsAddHf('unsloth/Qwen3.5-2B-GGUF', 'Qwen3.5-2B-Q4_K_M.gguf', { dryRun: true });

			expect(captured.payload).toMatchObject({ dryRun: true });
			const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
			expect(output).toContain('not added: --dry-run');
			expect(output).toContain('License:  apache-2.0');
			expect(output).not.toContain('models install');
		});

		it('says when the model was already there, and prints JSON for scripts', async () => {
			mockSend({ success: true, entry: USER_ENTRY, added: false });
			await modelsAddHf('unsloth/Qwen3.5-2B-GGUF', 'Qwen3.5-2B-Q4_K_M.gguf', {});
			expect(logSpy.mock.calls[0][0]).toMatch(/already in the Library/);

			logSpy.mockClear();
			mockSend({ success: true, entry: USER_ENTRY, added: true });
			await modelsAddHf('unsloth/Qwen3.5-2B-GGUF', 'Qwen3.5-2B-Q4_K_M.gguf', { json: true });
			expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
				success: true,
				added: true,
				id: USER_ENTRY.id,
				displayName: 'Qwen3.5-2B-Q4_K_M',
				repo: 'unsloth/Qwen3.5-2B-GGUF',
				revision: 'f6d5376be1edb4d416d56da11e5397a961aca8ae',
				license: 'apache-2.0',
				licenseUrl: 'https://huggingface.co/Qwen/Qwen3.5-2B/blob/main/LICENSE',
				bytes: 1_280_835_840,
				files: [{ path: 'Qwen3.5-2B-Q4_K_M.gguf', sha256: 'a'.repeat(64), bytes: 1_280_835_840 }],
				verifiedByMaestro: false,
			});
		});

		it('reports a refusal from Hugging Face with its message', async () => {
			mockSend({ success: false, error: 'owner/repo is gated on Hugging Face.' });
			await expect(modelsAddHf('owner/repo', 'model.gguf', {})).rejects.toThrow('__exit__');
			expect(errorSpy.mock.calls[0][0]).toMatch(/gated on Hugging Face/);
		});
	});

	describe('remove-hf', () => {
		it('removes through the bridge and reports the bytes reclaimed', async () => {
			const captured = mockSend({
				success: true,
				id: USER_ENTRY.id,
				displayName: USER_ENTRY.displayName,
				bytes: 1024 * 1024 * 5,
			});

			await modelsRemoveHf(USER_ENTRY.id, {});

			expect(captured.payload).toEqual({ type: 'local_models_hf_remove', modelId: USER_ENTRY.id });
			expect(logSpy.mock.calls[0][0]).toMatch(
				/Removed Qwen3\.5-2B-Q4_K_M from the Library \(5\.0 MB reclaimed\)/
			);
		});

		it('refuses a model a task is assigned to, naming it, until --force', async () => {
			setUserLocalModels([USER_ENTRY]);
			vi.mocked(readLocalModelAssignments).mockReturnValue({
				'tab-naming': { type: 'local', modelId: USER_ENTRY.id },
			});

			await expect(modelsRemoveHf(USER_ENTRY.id, {})).rejects.toThrow('__exit__');
			expect(errorSpy.mock.calls[0][0]).toMatch(/Qwen3\.5-2B-Q4_K_M is assigned to Tab naming/);
			expect(withMaestroClient).not.toHaveBeenCalled();

			mockSend({ success: true, id: USER_ENTRY.id, displayName: 'Qwen3.5-2B-Q4_K_M', bytes: 0 });
			await modelsRemoveHf(USER_ENTRY.id, { force: true, json: true });
			expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
				success: true,
				modelId: USER_ENTRY.id,
				bytesReclaimed: 0,
				tasks: ['Tab naming'],
			});
			setUserLocalModels([]);
		});

		it('lets the app refuse a curated or unknown id', async () => {
			mockSend({ success: false, error: 'No model you added has the id "hf-nope".' });
			await expect(modelsRemoveHf('hf-nope', {})).rejects.toThrow('__exit__');
			expect(errorSpy.mock.calls[0][0]).toMatch(/No model you added/);
		});
	});

	describe('a model the user added', () => {
		it('installs and removes by id like any other once the catalog knows it', async () => {
			// Unknown until the CLI has read the user models file.
			await expect(modelsInstall(USER_ENTRY.id, {})).rejects.toThrow('__exit__');
			expect(withMaestroClient).not.toHaveBeenCalled();

			setUserLocalModels([USER_ENTRY]);
			const captured = mockSend({ success: true, result: { status: 'complete' } });
			await modelsInstall(USER_ENTRY.id, {});
			expect(captured.payload).toEqual({ type: 'local_models_download', modelId: USER_ENTRY.id });
			setUserLocalModels([]);
		});
	});
});
