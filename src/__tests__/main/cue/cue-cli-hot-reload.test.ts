// @vitest-environment node
/** Real CLI writer, filesystem, chokidar, runtime and heartbeat registration.
 * Only dispatch/DB and the CLI's session-store boundary are mocked. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createMockSession } from './cue-test-helpers';

const { readSessions } = vi.hoisted(() => ({ readSessions: vi.fn() }));
const { watcherReady } = vi.hoisted(() => ({ watcherReady: [] as Promise<void>[] }));
vi.mock('chokidar', async (importOriginal) => {
	const actual = await importOriginal<typeof import('chokidar')>();
	return {
		...actual,
		watch: (...args: Parameters<typeof actual.watch>) => {
			const watcher = actual.watch(...args);
			watcherReady.push(new Promise<void>((resolve) => watcher.once('ready', resolve)));
			return watcher;
		},
	};
});
vi.mock('../../../cli/services/storage', () => ({ readSessions }));
vi.mock('../../../main/cue/cue-db', () => ({ clearGitHubSeenForSubscription: vi.fn() }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { cueSchedule } from '../../../cli/commands/cue-schedule';
import {
	createCueSessionRuntimeService,
	type CueSessionRuntimeServiceDeps,
} from '../../../main/cue/cue-session-runtime-service';
import { createCueSessionRegistry } from '../../../main/cue/cue-session-registry';

describe('CLI interval hot reload in a running desktop runtime', () => {
	let root: string;
	let runtime: ReturnType<typeof createCueSessionRuntimeService>;
	let registry: ReturnType<typeof createCueSessionRegistry>;
	let intervals: ReturnType<typeof vi.spyOn<typeof globalThis, 'setInterval'>>;
	const dispatch = vi.fn<CueSessionRuntimeServiceDeps['dispatchSubscription']>(() => 1);
	const onLog = vi.fn();

	beforeEach(() => {
		watcherReady.length = 0;
		intervals = vi.spyOn(globalThis, 'setInterval');
		fs.mkdirSync('.build', { recursive: true });
		root = fs.mkdtempSync(path.resolve('.build/cue-reload-test-'));
		fs.mkdirSync(path.join(root, '.maestro'));
		fs.writeFileSync(path.join(root, '.maestro/cue.yaml'), 'subscriptions: []\n');
		// Mira's real topology: another agent precedes the explicitly targeted agent.
		const other = createMockSession({ id: 'other', projectRoot: root });
		const target = createMockSession({ id: 'target', name: 'Target', projectRoot: root });
		readSessions.mockReturnValue([other, target]);
		registry = createCueSessionRegistry();
		runtime = createCueSessionRuntimeService({
			enabled: () => true,
			getSessions: () => [other, target],
			registry,
			onRefreshRequested: (id, projectRoot) => runtime.refreshSession(id, projectRoot),
			onLog,
			dispatchSubscription: dispatch,
			clearQueue: vi.fn(),
			clearFanInState: vi.fn(),
		});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		runtime.initSession(other, { reason: 'system-boot' });
		runtime.initSession(target, { reason: 'system-boot' });
	});

	afterEach(() => {
		runtime.clearAll();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.clearAllMocks();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('registers a CLI-created interval even when atomic rewrite precedes watcher ready', async () => {
		// No ready-wait here: this is the blind spot, not a mocked change event.
		await cueSchedule({
			agent: 'target',
			every: '15m',
			prompt: 'inert test',
			name: 'completion',
			json: true,
		});
		await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1), { timeout: 4000 });
		expect(dispatch.mock.calls[0][0]).toBe('target');
		expect(registry.get('target')?.triggerSources).toHaveLength(1);
		expect(registry.get('other')?.triggerSources).toHaveLength(0);
		const source = registry.get('target')!.triggerSources[0];
		expect(source.nextTriggerAt()).toBeGreaterThan(Date.now());
		// Drive the callback of the actual registered timer without waiting 15m.
		const heartbeat = intervals.mock.calls.find(([, delay]) => delay === 15 * 60_000);
		expect(heartbeat).toBeDefined();
		(heartbeat![0] as () => void)();
		expect(dispatch).toHaveBeenCalledTimes(2);
	});

	it('picks up an atomic CLI pause after the watcher is running and never dispatches it', async () => {
		await cueSchedule({
			agent: 'target',
			every: '15m',
			prompt: 'inert test',
			name: 'completion',
			json: true,
		});
		await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1), { timeout: 4000 });
		// Wait for the real replacement watchers, without a timing assumption.
		await Promise.all(watcherReady);
		await cueSchedule({ agent: 'target', pause: 'completion', json: true });
		await vi.waitFor(() => expect(registry.get('target')?.triggerSources).toHaveLength(0), {
			timeout: 4000,
		});
		expect(registry.get('target')?.config.subscriptions[0].enabled).toBe(false);
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it('registers a CLI-created interval after the desktop watchers are ready', async () => {
		await Promise.all(watcherReady);
		await cueSchedule({
			agent: 'target',
			every: '15m',
			prompt: 'inert test',
			name: 'completion',
			json: true,
		});
		await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1), { timeout: 4000 });
		expect(dispatch.mock.calls[0][0]).toBe('target');
		expect(registry.get('target')?.triggerSources).toHaveLength(1);
		expect(registry.get('other')?.triggerSources).toHaveLength(0);
	});
});
