/**
 * @file models-assign.test.ts
 * @description Tests for `maestro-cli models assign` and `models tasks`:
 * assign validates and stores through the same shared helpers as the Settings
 * picker (wrong kind refused, endpoint named by id prefix or name stored by
 * full id, the default removes the entry), and tasks lists every assignment
 * with readiness when the desktop answers and without it when it does not.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({
	readLocalModelAssignments: vi.fn(() => ({})),
	writeLocalModelAssignments: vi.fn(),
	readLocalModelEndpoints: vi.fn(() => []),
}));

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import { modelsAssign, modelsTasks } from '../../../cli/commands/models-assign';
import {
	readLocalModelAssignments,
	readLocalModelEndpoints,
	writeLocalModelAssignments,
} from '../../../cli/services/storage';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import { BGE_SMALL_EN_ID, QWEN3_1_7B_ID } from '../../../shared/local-models/model-catalog';
import { LOCAL_MODEL_TASK_IDS } from '../../../shared/local-models/tasks';
import type { LocalModelEndpoint } from '../../../shared/local-models/endpoints';
import type { LocalModelTaskReadiness } from '../../../shared/local-models/task-readiness';

const ollama: LocalModelEndpoint = {
	id: 'aaaa-1111-2222',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};

const UNAVAILABLE: LocalModelTaskReadiness = {
	taskId: 'semantic-search',
	label: 'Semantic search',
	needs: 'embedding',
	assignment: { type: 'local', modelId: BGE_SMALL_EN_ID },
	state: 'unavailable',
	reason: 'model-not-installed',
	detail: 'BGE Small (English) is not downloaded.',
	suggestedAction: 'Download it in Settings.',
};

describe('models assign / tasks commands', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(readLocalModelAssignments).mockReturnValue({});
		vi.mocked(readLocalModelEndpoints).mockReturnValue([ollama]);
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	describe('assign', () => {
		it('stores a local model of the right kind', () => {
			modelsAssign('semantic-search', `local:${BGE_SMALL_EN_ID}`, {});

			expect(writeLocalModelAssignments).toHaveBeenCalledWith({
				'semantic-search': { type: 'local', modelId: BGE_SMALL_EN_ID },
			});
			expect(logSpy.mock.calls[0][0]).toMatch(/Semantic search -> local:bge-small-en-v1\.5/);
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('stores a model the task does not recommend, and says why', () => {
			modelsAssign('voice-routing', `local:${QWEN3_1_7B_ID}`, {});

			// A caution, not a refusal: the picker would not have offered it, so the
			// reason it would not is printed beside the result.
			expect(writeLocalModelAssignments).toHaveBeenCalledWith({
				'voice-routing': { type: 'local', modelId: QWEN3_1_7B_ID },
			});
			const printed = logSpy.mock.calls.map(([line]) => String(line)).join('\n');
			expect(printed).toMatch(/Not recommended for this task/);
			expect(printed).toMatch(/Conductor/);
			expect(exitSpy).not.toHaveBeenCalled();

			logSpy.mockClear();
			modelsAssign('voice-routing', `local:${QWEN3_1_7B_ID}`, { json: true });
			expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
				success: true,
				caution: expect.stringMatching(/Conductor/),
			});

			logSpy.mockClear();
			modelsAssign('tab-naming', `local:${QWEN3_1_7B_ID}`, { json: true });
			expect(JSON.parse(String(logSpy.mock.calls[0][0]))).not.toHaveProperty('caution');
		});

		it('refuses a model of the wrong kind without writing', () => {
			expect(() => modelsAssign('tab-naming', `local:${BGE_SMALL_EN_ID}`, {})).toThrow('__exit__');

			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
			expect(errorSpy.mock.calls[0][0]).toMatch(/needs a text-gen model/);
			expect(writeLocalModelAssignments).not.toHaveBeenCalled();
		});

		it('resolves an endpoint named by name and stores its full id, keeping a tagged model intact', () => {
			modelsAssign('tab-naming', 'endpoint:ollama:qwen3:latest', { json: true });

			expect(writeLocalModelAssignments).toHaveBeenCalledWith({
				'tab-naming': { type: 'endpoint', endpointId: ollama.id, model: 'qwen3:latest' },
			});
			expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
				success: true,
				taskId: 'tab-naming',
				spec: `endpoint:${ollama.id}:qwen3:latest`,
			});
		});

		it('refuses an endpoint that is not configured', () => {
			expect(() => modelsAssign('tab-naming', 'endpoint:lmstudio:qwen3', {})).toThrow('__exit__');

			expect(errorSpy.mock.calls[0][0]).toMatch(/No endpoint matches "lmstudio"/);
			expect(writeLocalModelAssignments).not.toHaveBeenCalled();
		});

		it('refuses an endpoint for a need no server serves', () => {
			expect(() => modelsAssign('injection-screen', `endpoint:${ollama.id}:guard`, {})).toThrow(
				'__exit__'
			);

			expect(errorSpy.mock.calls[0][0]).toMatch(/which an endpoint cannot serve/);
			expect(writeLocalModelAssignments).not.toHaveBeenCalled();
		});

		it('removes the entry when a task is set back to its default', () => {
			vi.mocked(readLocalModelAssignments).mockReturnValue({
				'tab-naming': { type: 'off' },
			});

			modelsAssign('tab-naming', 'utility-agent', {});

			expect(writeLocalModelAssignments).toHaveBeenCalledWith({});
		});

		it('assigns a task with typed questions to System One, and says where its engine is chosen', () => {
			modelsAssign('cue-gate', 'system-one', {});

			expect(writeLocalModelAssignments).toHaveBeenCalledWith({
				'cue-gate': { type: 'system-one' },
			});
			const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
			expect(printed).toMatch(/Cue gate -> system-one/);
			expect(printed).toMatch(/maestro-cli s1 status/);
			expect(printed).toMatch(/maestro-cli models status cue-gate/);
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('refuses System One for a task with no typed questions, without writing', () => {
			expect(() => modelsAssign('tab-naming', 'system-one', {})).toThrow('__exit__');
			expect(errorSpy.mock.calls[0][0]).toMatch(/Tab naming cannot run on System One/);
			expect(() => modelsAssign('local-judge', 'system-one', { json: true })).toThrow('__exit__');
			expect(JSON.parse(logSpy.mock.calls[0][0])).toMatchObject({
				success: false,
				error: expect.stringContaining('Local judge cannot run on System One'),
			});
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
			expect(writeLocalModelAssignments).not.toHaveBeenCalled();
		});

		it('refuses a malformed spec and an unknown task as usage errors', () => {
			expect(() => modelsAssign('tab-naming', 'ollama/qwen3', {})).toThrow('__exit__');
			expect(errorSpy.mock.calls[0][0]).toMatch(
				/Assignment must be off, utility-agent, system-one, local:<model-id>, or endpoint/
			);

			expect(() => modelsAssign('tab-nameing', 'off', {})).toThrow('__exit__');
			expect(errorSpy.mock.calls[1][0]).toMatch(/Unknown task "tab-nameing"/);
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
			expect(writeLocalModelAssignments).not.toHaveBeenCalled();
		});
	});

	describe('tasks', () => {
		it('lists every task with its assignment and readiness from the desktop', async () => {
			vi.mocked(readLocalModelAssignments).mockReturnValue({
				'semantic-search': { type: 'local', modelId: BGE_SMALL_EN_ID },
			});
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({
					sendCommand: vi.fn().mockResolvedValue({ success: true, readiness: [UNAVAILABLE] }),
				} as never)
			);

			await modelsTasks({});

			const output = logSpy.mock.calls[0][0] as string;
			expect(output).toMatch(/LOCAL MODEL TASKS/);
			expect(output).toMatch(/semantic-search\s+local:bge-small-en-v1\.5\s+unavailable/);
			expect(output).toMatch(/\[model-not-installed\]/);
			expect(output).toMatch(/-> Download it in Settings\./);
			expect(output).toMatch(/tab-naming\s+utility-agent/);
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('still lists assignments as JSON when the desktop is not running', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro is not running'));

			await modelsTasks({ json: true });

			const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
			expect(parsed.success).toBe(true);
			expect(parsed.readinessError).toBe('Maestro is not running');
			expect(parsed.tasks).toHaveLength(LOCAL_MODEL_TASK_IDS.length);
			expect(parsed.tasks[0]).toMatchObject({ taskId: 'tab-naming', spec: 'utility-agent' });
			expect(parsed.tasks[0].readiness).toBeUndefined();
			expect(exitSpy).not.toHaveBeenCalled();
		});
	});
});
