// @vitest-environment node
/** Real YAML loading and timer sources; native notifications are deliberately lost. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { watch } from 'chokidar';
import { createMockSession } from './cue-test-helpers';

vi.mock('chokidar', () => ({
	watch: vi.fn(() => Object.assign(new EventEmitter(), { close: vi.fn() })),
}));
vi.mock('../../../main/cue/cue-db', () => ({ clearGitHubSeenForSubscription: vi.fn() }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import {
	createCueSessionRuntimeService,
	type CueSessionRuntimeServiceDeps,
} from '../../../main/cue/cue-session-runtime-service';
import { createCueSessionRegistry } from '../../../main/cue/cue-session-registry';
import { writeCueYamlAtomicSync } from '../../../main/cue/cue-yaml-write';

describe('shared cwd Cue health', () => {
	let root: string;
	let configPath: string;
	let runtime: ReturnType<typeof createCueSessionRuntimeService>;
	let registry: ReturnType<typeof createCueSessionRegistry>;
	let intervals: ReturnType<typeof vi.spyOn<typeof globalThis, 'setInterval'>>;
	const onLog = vi.fn();
	const dispatch = vi.fn<CueSessionRuntimeServiceDeps['dispatchSubscription']>(() => 1);
	const sessions = ['Mira', 'Claude', 'OpenCode', 'Copilot'].map((name) =>
		createMockSession({ id: name.toLowerCase(), name })
	);
	let activeSessions = sessions;
	const refresh = vi.fn((id: string, cwd: string) => runtime.refreshSession(id, cwd));

	beforeEach(() => {
		vi.useFakeTimers();
		intervals = vi.spyOn(globalThis, 'setInterval');
		fs.mkdirSync('.build', { recursive: true });
		root = fs.mkdtempSync(path.resolve('.build/cue-shared-health-'));
		fs.mkdirSync(path.join(root, '.maestro'));
		configPath = path.join(root, '.maestro/cue.yaml');
		fs.writeFileSync(configPath, 'subscriptions: []\n');
		for (const session of sessions) session.projectRoot = root;
		activeSessions = [...sessions];
		registry = createCueSessionRegistry();
		runtime = createCueSessionRuntimeService({
			enabled: () => true,
			getSessions: () => activeSessions,
			registry,
			onRefreshRequested: refresh,
			onLog,
			dispatchSubscription: dispatch,
			clearQueue: vi.fn(),
			retainQueue: vi.fn(() => 0),
			clearFanInState: vi.fn(),
		});
	});

	afterEach(() => {
		runtime.clearAll();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.clearAllMocks();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it.each([2, 4])(
		'heals repeated missed edits for %i agents without health notifications',
		(agentCount) => {
			for (const session of sessions.slice(0, agentCount)) {
				runtime.initSession(session, { reason: 'discovery' });
			}
			for (let edit = 0; edit < 2; edit++) {
				// Cross the sticky-toast bridge's five-minute coalescing window.
				vi.advanceTimersByTime(12 * 30_000);
				expect(refresh).toHaveBeenCalledTimes(edit * agentCount);
				writeCueYamlAtomicSync(configPath, `subscriptions: []\n# edit ${edit}\n`);
				vi.advanceTimersByTime(31_000);
				expect(refresh).toHaveBeenCalledTimes((edit + 1) * agentCount);
			}
			vi.advanceTimersByTime(12 * 30_000);
			expect(refresh).toHaveBeenCalledTimes(2 * agentCount);
			expect(
				onLog.mock.calls.filter(([, , data]) => data?.type === 'triggerHealthWarning')
			).toEqual([]);
		}
	);

	it('replaces real interval timers for every target and ignores late native events', () => {
		const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
		for (const minutes of [15, 20, 25]) {
			writeCueYamlAtomicSync(
				configPath,
				`subscriptions:\n${sessions
					.map(
						(session) =>
							`  - name: ${session.id}-timer\n    agent_id: ${session.id}\n    event: time.heartbeat\n    interval_minutes: ${minutes}\n    prompt: inert test\n`
					)
					.join('')}`
			);
			if (minutes === 15) {
				for (const session of sessions) runtime.initSession(session, { reason: 'discovery' });
			} else {
				vi.advanceTimersByTime(31_000);
			}
			expect(dispatch).toHaveBeenCalledTimes(((minutes - 15) / 5 + 1) * 4);
			const currentTimers = intervals.mock.calls.flatMap(([callback, delay], index) =>
				delay === minutes * 60_000 ? [{ callback, timer: intervals.mock.results[index].value }] : []
			);
			expect(currentTimers).toHaveLength(4);
			for (const session of sessions) {
				expect(registry.get(session.id)?.triggerSources).toHaveLength(1);
				const nextFire = registry.get(session.id)!.triggerSources[0].nextTriggerAt();
				expect(nextFire).toBeGreaterThan(Date.now() + (minutes - 1) * 60_000);
				expect(nextFire).toBeLessThanOrEqual(Date.now() + minutes * 60_000);
			}
			const refreshCount = refresh.mock.calls.length;
			for (const result of vi.mocked(watch).mock.results) result.value.emit('change', configPath);
			vi.advanceTimersByTime(1000 + 12 * 30_000);
			expect(refresh).toHaveBeenCalledTimes(refreshCount);
			for (const { timer } of currentTimers)
				expect(clearIntervalSpy).not.toHaveBeenCalledWith(timer);
		}
		const oldTimers = intervals.mock.calls.flatMap(([, delay], index) =>
			delay === 15 * 60_000 || delay === 20 * 60_000 ? [intervals.mock.results[index].value] : []
		);
		for (const timer of oldTimers) expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
		expect(vi.getTimerCount()).toBe(8); // Four health polls and four current intervals.
		dispatch.mockClear();
		for (const [callback, delay] of intervals.mock.calls) {
			if (delay === 25 * 60_000) (callback as () => void)();
		}
		expect(dispatch.mock.calls.map(([id]) => id)).toEqual(sessions.map((session) => session.id));
		expect(onLog.mock.calls.filter(([, , data]) => data?.type === 'triggerHealthWarning')).toEqual(
			[]
		);
	});

	it.each([
		'  - name: invalid\n    event: nonexistent.event\n    prompt: inert test\n',
		'  - name: missing-prompt\n    event: agent.completed\n    prompt_file: .maestro/prompts/missing.md\n',
		'  - name: targeted-missing-prompt\n    agent_id: claude\n    event: agent.completed\n    prompt_file: .maestro/prompts/missing.md\n',
		'  - name: targeted-invalid\n    agent_id: claude\n    event: nonexistent.event\n    prompt: inert test\n',
	])('alarms on failed subscriptions in an otherwise loadable config: %s', (subscription) => {
		for (const session of sessions) runtime.initSession(session, { reason: 'discovery' });
		writeCueYamlAtomicSync(configPath, `subscriptions:\n${subscription}`);
		vi.advanceTimersByTime(31_000);
		expect(registry.size()).toBe(4);
		expect(onLog.mock.calls.filter(([level]) => level === 'warn')).toHaveLength(4);
		expect(
			onLog.mock.calls
				.filter(([level, , data]) => level === 'warn' && data?.type === 'triggerHealthWarning')
				.map(([, , data]) => data.sessionId)
		).toEqual([subscription.includes('agent_id: claude') ? 'claude' : 'mira']);
	});

	it.each([
		'event: agent.completed\n    prompt_file: .maestro/prompts/missing.md',
		'event: agent.completed\n    prompt: inert test\n    output_prompt_file: .maestro/prompts/missing-output.md',
		'event: nonexistent.event\n    prompt: inert test',
		'agent_id: claude\n    event: agent.completed\n    prompt_file: .maestro/prompts/missing.md',
		'agent_id: claude\n    event: nonexistent.event\n    prompt: inert test',
	])('logs paused subscription problems without health notices until enabled: %s', (fields) => {
		for (const session of sessions) runtime.initSession(session, { reason: 'discovery' });
		const paused = `subscriptions:\n  - name: paused\n    enabled: false\n    ${fields}\n`;
		writeCueYamlAtomicSync(configPath, paused);
		vi.advanceTimersByTime(31_000);
		expect(registry.size()).toBe(4);
		const warnings = onLog.mock.calls.filter(([level]) => level === 'warn');
		expect(warnings).toHaveLength(4);
		expect(warnings.map(([, , data]) => data)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
		]);
		onLog.mockClear();
		vi.advanceTimersByTime(12 * 30_000);
		expect(onLog).not.toHaveBeenCalled();
		writeCueYamlAtomicSync(configPath, paused.replace('enabled: false', 'enabled: true'));
		vi.advanceTimersByTime(31_000);
		expect(
			onLog.mock.calls
				.filter(([level, , data]) => level === 'warn' && data?.type === 'triggerHealthWarning')
				.map(([, , data]) => data.sessionId)
		).toEqual([fields.includes('agent_id: claude') ? 'claude' : 'mira']);
	});

	it.each(['claude', 'Claude'])(
		'retains the configured owner %s across parse failures, recovery and owner removal',
		(owner) => {
			writeCueYamlAtomicSync(
				configPath,
				`settings:\n  owner_agent_id: ${owner}\nsubscriptions: []\n`
			);
			for (const session of sessions) runtime.initSession(session, { reason: 'system-boot' });
			onLog.mockClear();
			writeCueYamlAtomicSync(configPath, 'subscriptions: [');
			vi.advanceTimersByTime(31_000);
			expect(onLog.mock.calls.filter(([level]) => level === 'error')).toHaveLength(4);
			expect(
				onLog.mock.calls
					.filter(([, , data]) => data?.type === 'triggerHealthWarning')
					.map(([, , data]) => data.sessionId)
			).toEqual(['claude']);
			onLog.mockClear();
			vi.advanceTimersByTime(12 * 30_000);
			expect(onLog).not.toHaveBeenCalled();

			activeSessions = sessions.filter((session) => session.id !== 'claude');
			runtime.removeSession('claude');
			onLog.mockClear();
			writeCueYamlAtomicSync(configPath, 'subscriptions: [ # another invalid save');
			vi.advanceTimersByTime(31_000);
			expect(onLog.mock.calls.filter(([level]) => level === 'error')).toHaveLength(3);
			expect(
				onLog.mock.calls
					.filter(([, , data]) => data?.type === 'triggerHealthWarning')
					.map(([, , data]) => data.sessionId)
			).toEqual(['mira']);

			writeCueYamlAtomicSync(
				configPath,
				'settings:\n  owner_agent_id: copilot\nsubscriptions: []\n'
			);
			vi.advanceTimersByTime(31_000);
			onLog.mockClear();
			writeCueYamlAtomicSync(configPath, 'subscriptions: [');
			vi.advanceTimersByTime(31_000);
			expect(
				onLog.mock.calls
					.filter(([, , data]) => data?.type === 'triggerHealthWarning')
					.map(([, , data]) => data.sessionId)
			).toEqual(['copilot']);
		}
	);

	it('routes unowned warnings to the configured owner and explicit warnings to their target', () => {
		writeCueYamlAtomicSync(
			configPath,
			`settings:
  owner_agent_id: copilot
subscriptions:
  - name: unowned
    event: agent.completed
    prompt_file: .maestro/prompts/missing.md
  - name: targeted
    agent_id: claude
    event: agent.completed
    prompt_file: .maestro/prompts/missing.md
`
		);
		for (const session of sessions) runtime.initSession(session, { reason: 'system-boot' });
		expect(onLog.mock.calls.filter(([level]) => level === 'warn')).toHaveLength(8);
		expect(
			onLog.mock.calls
				.filter(([, , data]) => data?.type === 'triggerHealthWarning')
				.map(([, , data]) => data.sessionId)
		).toEqual(['claude', 'copilot']);
	});

	it('forgets the retained owner after all sessions leave the root', () => {
		writeCueYamlAtomicSync(configPath, 'settings:\n  owner_agent_id: claude\nsubscriptions: []\n');
		for (const session of sessions) runtime.initSession(session, { reason: 'discovery' });
		for (const session of sessions) runtime.removeSession(session.id);
		onLog.mockClear();
		writeCueYamlAtomicSync(configPath, 'subscriptions: [');
		for (const session of sessions) runtime.initSession(session, { reason: 'discovery' });
		expect(
			onLog.mock.calls
				.filter(([, , data]) => data?.type === 'triggerHealthWarning')
				.map(([, , data]) => data.sessionId)
		).toEqual(['mira']);
	});

	it.each(['null', '[]', 'false', '{ owner_agent_id: 42 }', '{ owner_agent_id: "" }'])(
		'keeps the last readable owner through invalid settings %s and later parse errors',
		(settings) => {
			writeCueYamlAtomicSync(
				configPath,
				'settings:\n  owner_agent_id: claude\nsubscriptions: []\n'
			);
			for (const session of sessions) runtime.initSession(session, { reason: 'discovery' });
			for (const broken of [`settings: ${settings}\nsubscriptions: []\n`, 'subscriptions: [']) {
				onLog.mockClear();
				writeCueYamlAtomicSync(configPath, broken);
				vi.advanceTimersByTime(31_000);
				expect(onLog.mock.calls.filter(([level]) => level === 'error')).toHaveLength(4);
				expect(
					onLog.mock.calls
						.filter(([, , data]) => data?.type === 'triggerHealthWarning')
						.map(([, , data]) => data.sessionId)
				).toEqual(['claude']);
			}
		}
	);

	it('retains the owner for absent invalid settings until a valid save removes ownership', () => {
		writeCueYamlAtomicSync(configPath, 'settings:\n  owner_agent_id: claude\nsubscriptions: []\n');
		for (const session of sessions) runtime.initSession(session, { reason: 'discovery' });
		for (const broken of ['subscriptions: false\n', 'subscriptions: [']) {
			onLog.mockClear();
			writeCueYamlAtomicSync(configPath, broken);
			vi.advanceTimersByTime(31_000);
			expect(onLog.mock.calls.filter(([level]) => level === 'error')).toHaveLength(4);
			expect(
				onLog.mock.calls
					.filter(([, , data]) => data?.type === 'triggerHealthWarning')
					.map(([, , data]) => data.sessionId)
			).toEqual(['claude']);
		}
		writeCueYamlAtomicSync(configPath, 'subscriptions: []\n');
		vi.advanceTimersByTime(31_000);
		onLog.mockClear();
		writeCueYamlAtomicSync(configPath, 'subscriptions: false\n');
		vi.advanceTimersByTime(31_000);
		expect(
			onLog.mock.calls
				.filter(([, , data]) => data?.type === 'triggerHealthWarning')
				.map(([, , data]) => data.sessionId)
		).toEqual(['mira']);
	});

	it('honors a readable owner when another setting is invalid', () => {
		writeCueYamlAtomicSync(
			configPath,
			'settings:\n  owner_agent_id: claude\n  timeout_minutes: 0\nsubscriptions: []\n'
		);
		for (const session of sessions) runtime.initSession(session, { reason: 'system-boot' });
		expect(onLog.mock.calls.filter(([level]) => level === 'error')).toHaveLength(4);
		expect(
			onLog.mock.calls
				.filter(([, , data]) => data?.type === 'triggerHealthWarning')
				.map(([, , data]) => data.sessionId)
		).toEqual(['claude']);
	});

	it.each([
		['subscriptions: [', 'mira'],
		['settings:\n  owner_agent_id: claude\nsubscriptions: false\n', 'claude'],
		['settings:\n  owner_agent_id: missing-agent\nsubscriptions: false\n', 'mira'],
	])('reports a broken config once on cold startup: %s', (broken, owner) => {
		writeCueYamlAtomicSync(configPath, broken);
		for (const session of sessions) runtime.initSession(session, { reason: 'system-boot' });
		expect(onLog.mock.calls.filter(([level]) => level === 'error')).toHaveLength(4);
		expect(
			onLog.mock.calls
				.filter(([, , data]) => data?.type === 'triggerHealthWarning')
				.map(([, , data]) => data.sessionId)
		).toEqual([owner]);
	});

	it.each(['subscriptions: [', 'subscriptions: false\n'])(
		'alarms on genuine YAML errors and recovers after correction: %s',
		(invalidYaml) => {
			for (const session of sessions) runtime.initSession(session, { reason: 'discovery' });
			writeCueYamlAtomicSync(configPath, invalidYaml);
			vi.advanceTimersByTime(31_000);
			expect(registry.size()).toBe(0);
			expect(onLog.mock.calls.filter(([level]) => level === 'error')).toHaveLength(4);
			expect(
				onLog.mock.calls
					.filter(([level, , data]) => level === 'error' && data?.type === 'triggerHealthWarning')
					.map(([, , data]) => data.sessionId)
			).toEqual(['mira']);
			onLog.mockClear();
			vi.advanceTimersByTime(12 * 30_000);
			expect(onLog).not.toHaveBeenCalled();
			writeCueYamlAtomicSync(configPath, 'subscriptions: []\n');
			vi.advanceTimersByTime(31_000);
			expect(registry.size()).toBe(4);
			expect(
				onLog.mock.calls.filter(([, , data]) => data?.type === 'triggerHealthWarning')
			).toEqual([]);
		}
	);
});
