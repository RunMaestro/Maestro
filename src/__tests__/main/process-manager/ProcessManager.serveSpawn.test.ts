/**
 * The `spawn` event on the OpenCode serve transport.
 *
 * That transport reports its `exit` through the handlers every other process
 * uses, so anything that pairs a start with an end (the agent-run capture, the
 * dispatch callbacks) has to be told of the start too. This pins that the
 * process manager emits `spawn` for it exactly as it does for a CLI process:
 * once, with the config it was given, after the spawner has the process.
 */

import * as os from 'os';
import { describe, it, expect, vi } from 'vitest';

vi.mock('node-pty', () => ({
	spawn: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => '/tmp/maestro-test-coworking.sock',
}));

import { ProcessManager } from '../../../main/process-manager';
import type { ProcessConfig } from '../../../main/process-manager/types';

const SERVE_RESULT = { pid: -1, success: true };

function config(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	return {
		sessionId: 'agent-1-ai-tab-1',
		toolType: 'opencode',
		cwd: os.tmpdir(),
		command: 'opencode',
		args: [],
		prompt: 'List the files.',
		...overrides,
	} as ProcessConfig;
}

/** A manager whose serve transport is on, with the two spawners stood in for. */
function createManager(): {
	manager: ProcessManager;
	order: string[];
	serve: ReturnType<typeof vi.fn>;
	cli: ReturnType<typeof vi.fn>;
} {
	const manager = new ProcessManager(() => true);
	const order: string[] = [];
	const serve = vi.fn(() => {
		order.push('serve spawner');
		return SERVE_RESULT;
	});
	const cli = vi.fn(() => {
		order.push('cli spawner');
		return { pid: 4242, success: true };
	});
	const internals = manager as unknown as {
		opencodeServerSpawner: { spawn: typeof serve };
		childProcessSpawner: { spawn: typeof cli };
	};
	internals.opencodeServerSpawner = { spawn: serve };
	internals.childProcessSpawner = { spawn: cli };
	manager.on('spawn', () => order.push('spawn event'));
	return { manager, order, serve, cli };
}

describe('ProcessManager spawn event on the OpenCode serve transport', () => {
	it('emits spawn once, with the config, after the serve spawner has the process', () => {
		const { manager, order, serve, cli } = createManager();
		const heard: ProcessConfig[] = [];
		manager.on('spawn', (spawned: ProcessConfig) => heard.push(spawned));
		const spawned = config();

		expect(manager.spawn(spawned)).toBe(SERVE_RESULT);

		expect(serve).toHaveBeenCalledWith(spawned);
		expect(cli).not.toHaveBeenCalled();
		expect(heard).toEqual([spawned]);
		expect(heard[0]).toBe(spawned);
		expect(order).toEqual(['serve spawner', 'spawn event']);
	});

	it('does not let a listener that throws break the spawn', () => {
		const { manager } = createManager();
		manager.on('spawn', () => {
			throw new Error('A capture listener failed.');
		});

		expect(manager.spawn(config())).toBe(SERVE_RESULT);
	});

	it('emits spawn once on the CLI path too, for a turn the serve transport does not take', () => {
		const { manager, order, serve } = createManager();

		// An image keeps an OpenCode turn on the CLI path.
		manager.spawn(config({ images: ['data:image/png;base64,AAAA'] }));

		expect(serve).not.toHaveBeenCalled();
		expect(order).toEqual(['cli spawner', 'spawn event']);
	});
});
