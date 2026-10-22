/**
 * @file models-server.test.ts
 * @description Tests for `maestro-cli models server status|start|stop|set|key`:
 * each request crosses the WS bridge in the shape the desktop handler expects,
 * flags are validated before anything is sent, the report is printed as a
 * person reads it (and whole as JSON), and `status` exits non-zero only for a
 * server that failed.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import {
	modelsServerKey,
	modelsServerSet,
	modelsServerStart,
	modelsServerStatus,
	modelsServerStop,
} from '../../../cli/commands/models-server';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import type { ModelServerReport } from '../../../shared/local-models/model-server';
import { formatError } from '../../../cli/output/formatter';

function mockSend(reply: Record<string, unknown>) {
	const captured: { payload?: Record<string, unknown>; responseType?: string } = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>, rt: string) => {
				captured.payload = payload;
				captured.responseType = rt;
				return Promise.resolve(reply);
			}),
		} as never)
	);
	return captured;
}

const RUNNING: ModelServerReport = {
	status: {
		state: 'running',
		port: 47811,
		bind: 'local',
		host: '127.0.0.1',
		baseUrl: 'http://127.0.0.1:47811',
		maxModels: 1,
		pid: 4242,
		startedAt: Date.now() - 60_000,
		restarts: 0,
		lastError: null,
		models: ['qwen3-1.7b-instruct-q4km'],
		loadedModels: ['qwen3-1.7b-instruct-q4km'],
		keyStorage: 'os',
		logPath: '/data/logs/model-server.log',
	},
	engine: {
		installed: true,
		stale: false,
		release: 'b11559',
		choice: 'default',
		label: 'Metal',
		kind: 'metal',
		accelerator: {
			checkedAt: 1,
			status: 'gpu',
			label: 'Metal (Apple M5 Max)',
			devices: [],
			problem: null,
			detail: null,
			offerCpuBuild: false,
		},
		bytes: 40 * 1024 * 1024,
		builds: [{ choice: 'default', label: 'Metal', kind: 'metal', downloadBytes: 12_100_000 }],
	},
	loaded: [
		{ id: 'qwen3-1.7b-instruct-q4km', displayName: 'Qwen3 1.7B', approxBytes: 1_107_409_472 },
	],
	installing: null,
};

const NO_ENGINE: ModelServerReport = {
	...RUNNING,
	status: {
		...RUNNING.status,
		state: 'stopped',
		port: null,
		baseUrl: null,
		pid: null,
		startedAt: null,
		models: [],
		loadedModels: [],
		keyStorage: null,
	},
	engine: {
		...RUNNING.engine,
		installed: false,
		release: null,
		choice: null,
		label: null,
		kind: null,
		accelerator: null,
		bytes: 0,
	},
	loaded: [],
};

let logSpy: MockInstance;
let errorSpy: MockInstance;
let exitSpy: MockInstance;

beforeEach(() => {
	vi.clearAllMocks();
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
		throw new Error('__exit__');
	});
});

describe('models server status', () => {
	it('asks the app for the report and prints state, address, engine and loaded models', async () => {
		const captured = mockSend({ success: true, report: RUNNING });

		await modelsServerStatus({});

		expect(captured.payload).toEqual({ type: 'local_models_server_status' });
		expect(captured.responseType).toBe('local_models_server_status_result');
		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toMatch(/MAESTRO MODEL SERVER/);
		expect(output).toMatch(/running/);
		expect(output).toMatch(/http:\/\/127\.0\.0\.1:47811/);
		expect(output).toMatch(/Local only \(127\.0\.0\.1\)/);
		expect(output).toMatch(/Metal build, b11559/);
		expect(output).toMatch(/Metal \(Apple M5 Max\)/);
		expect(output).toMatch(/Qwen3 1\.7B \(about/);
		expect(output).toMatch(/sealed by the OS key store/);
		expect(output).toContain('/data/logs/model-server.log');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('says what a Linux machine with no Vulkan loader and no keyring needs to know', async () => {
		mockSend({
			success: true,
			report: {
				...RUNNING,
				status: { ...RUNNING.status, state: 'stopped', pid: null, keyStorage: 'obscured' },
				engine: {
					...RUNNING.engine,
					label: 'Vulkan',
					kind: 'vulkan',
					accelerator: {
						checkedAt: 1,
						status: 'failed',
						label: 'Unavailable',
						devices: [],
						problem: 'vulkan-loader-missing',
						detail: 'libvulkan.so.1: cannot open shared object file',
						offerCpuBuild: true,
					},
					builds: [
						{ choice: 'default', label: 'Vulkan', kind: 'vulkan', downloadBytes: 30_280_639 },
						{ choice: 'cpu', label: 'CPU', kind: 'cpu', downloadBytes: 17_717_780 },
					],
				},
			},
		});

		await modelsServerStatus({});

		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toMatch(/Unavailable/);
		expect(output).toMatch(/could not start because the Vulkan loader is missing/);
		expect(output).toMatch(/You can install the CPU build instead/);
		// The build that answers the offer is in the same report.
		expect(output).toMatch(/cpu \(CPU, /);
		expect(output).toMatch(/obscured \(this system has no OS key store\)/);
		expect(output).not.toMatch(/sealed by the OS key store/);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('says how to install the engine when it is missing, and exits 0', async () => {
		mockSend({ success: true, report: NO_ENGINE });

		await modelsServerStatus({});

		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toMatch(/not installed/);
		expect(output).toMatch(/maestro-cli models server set --build default/);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('prints the whole report as JSON', async () => {
		mockSend({ success: true, report: RUNNING });

		await modelsServerStatus({ json: true });

		const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
		expect(parsed.success).toBe(true);
		expect(parsed.status.baseUrl).toBe('http://127.0.0.1:47811');
		expect(parsed.engine.accelerator.label).toBe('Metal (Apple M5 Max)');
	});

	it('exits non-zero when the server failed, showing why', async () => {
		mockSend({
			success: true,
			report: {
				...RUNNING,
				status: { ...RUNNING.status, state: 'failed', lastError: 'It crashed 3 times.' },
			},
		});

		await expect(modelsServerStatus({})).rejects.toThrow('__exit__');
		expect(logSpy.mock.calls[0][0]).toContain('It crashed 3 times.');
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
	});

	it('reports a failed round trip', async () => {
		mockSend({ success: false, error: 'boom' });

		await expect(modelsServerStatus({})).rejects.toThrow('__exit__');
		expect(errorSpy).toHaveBeenCalledWith(formatError('boom'));
	});
});

describe('models server start and stop', () => {
	it('starts it and prints the address', async () => {
		const captured = mockSend({ success: true, report: RUNNING });

		await modelsServerStart({});

		expect(captured.payload).toEqual({ type: 'local_models_server_start' });
		expect(captured.responseType).toBe('local_models_server_start_result');
		expect(logSpy.mock.calls.flat().join('\n')).toMatch(/listening at http:\/\/127\.0\.0\.1:47811/);
	});

	it('passes a start that failed through with its reason', async () => {
		mockSend({ success: false, error: 'Another program is using 127.0.0.1:47811.' });

		await expect(modelsServerStart({ json: true })).rejects.toThrow('__exit__');
		const parsed = JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
		expect(parsed).toEqual({ success: false, error: 'Another program is using 127.0.0.1:47811.' });
	});

	it('stops it', async () => {
		const captured = mockSend({ success: true, report: NO_ENGINE });

		await modelsServerStop({});

		expect(captured.payload).toEqual({ type: 'local_models_server_stop' });
		expect(logSpy.mock.calls.flat().join('\n')).toMatch(/is stopped/);
	});
});

describe('models server set', () => {
	it('sends the bind mode, model count, key rotation and build together', async () => {
		const captured = mockSend({ success: true, report: RUNNING });

		await modelsServerSet({ bind: 'network', maxModels: '2', rotateKey: true, build: 'cpu' });

		expect(captured.payload).toEqual({
			type: 'local_models_server_set',
			bind: 'network',
			maxModels: 2,
			rotateKey: true,
			build: 'cpu',
		});
		expect(captured.responseType).toBe('local_models_server_set_result');
		expect(logSpy.mock.calls.flat().join('\n')).toMatch(/old key no longer works/);
	});

	it.each([
		[{ bind: 'everywhere' }, /not a bind mode/],
		[{ maxModels: '0' }, /--max-models must be a whole number from 1 to 16/],
		[{ maxModels: 'two' }, /--max-models must be a whole number/],
		[{ build: 'metal' }, /not a build\. Use default, cpu, cuda, rocm/],
		[{}, /Nothing to change/],
	])('refuses %o before sending anything', async (options, message) => {
		mockSend({ success: true, report: RUNNING });

		await expect(modelsServerSet(options)).rejects.toThrow('__exit__');
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(errorSpy.mock.calls[0][0]).toMatch(message);
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
	});
});

describe('models server key', () => {
	it('prints the key alone, for a shell to capture', async () => {
		const captured = mockSend({ success: true, key: 'sk-maestro-abc' });

		await modelsServerKey({});

		expect(captured.payload).toEqual({ type: 'local_models_server_key' });
		expect(logSpy).toHaveBeenCalledWith('sk-maestro-abc');
	});

	it('prints it as JSON', async () => {
		mockSend({ success: true, key: 'sk-maestro-abc' });

		await modelsServerKey({ json: true });

		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
			success: true,
			key: 'sk-maestro-abc',
		});
	});
});
