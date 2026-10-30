// @vitest-environment node
import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChildProcessSpawner } from '../../../../main/process-manager/spawners/ChildProcessSpawner';
import { DataBufferManager } from '../../../../main/process-manager/handlers/DataBufferManager';
import type { ManagedProcess } from '../../../../main/process-manager/types';
import { createDesktopConsultRunner } from '../../../../main/cross-agent/consult-runner';
import type { ProcessManager } from '../../../../main/process-manager';
import type { ConsultEnd } from '../../../../shared/maestro-lib/agents/consult';
import type { GroupChatSpawn } from '../../../../shared/maestro-lib/groupchat/types';
import { stopProcess } from '../../../../shared/maestro-lib/control/termination';

vi.mock('../../../../main/group-chat/spawnGroupChatAgent', () => ({
	spawnGroupChatAgent: vi.fn().mockResolvedValue({ success: true, pid: 123 }),
}));
vi.mock('../../../../main/group-chat/spawn-config', () => ({
	toSpawnGroupChatAgentConfig: () => ({}),
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../../main/agents', () => ({ getAgentCapabilities: () => ({}) }));
vi.mock('../../../../main/agents/definitions', () => ({ getAgentDefinition: () => undefined }));
vi.mock('../../../../main/process-manager/utils/envBuilder', () => ({
	buildChildProcessEnv: () => ({ PATH: '/usr/bin:/bin' }),
	collectMaestroEnvVars: () => ({}),
}));
vi.mock('../../../../shared/plugins/headless-agent-timeouts', async (original) => ({
	...(await original<typeof import('../../../../shared/plugins/headless-agent-timeouts')>()),
	CODEX_STARTUP_TIMEOUT_MS: 700,
	HEADLESS_RUN_TIMEOUT_MS: 5_000,
	HEADLESS_IDLE_PROFILE: { warnMs: 800, idleMs: 1_200, toolMs: 2_000 },
}));

const owned: ManagedProcess[] = [];
const unrelatedChildren: ChildProcess[] = [];
afterEach(() => {
	for (const child of unrelatedChildren.splice(0))
		stopProcess({ child }, { from: 'terminate', immediate: true });
	for (const process of owned.splice(0)) {
		stopProcess({ child: process.childProcess }, { from: 'terminate', immediate: true });
	}
});

describe.skipIf(process.platform !== 'linux')('real desktop Codex auth/MCP lifecycle', () => {
	it.each(['replacement', 'interrupt'] as const)(
		'settles a timed-out resistant predecessor during %s',
		async (action) => {
			const processes = new Map<string, ManagedProcess>();
			const emitter = new EventEmitter();
			const spawner = new ChildProcessSpawner(
				processes,
				emitter,
				new DataBufferManager(processes, emitter)
			);
			const errors = vi.fn();
			emitter.on('agent-error', errors);
			const exited = new Promise<void>((resolve) => emitter.once('exit', () => resolve()));
			const failed = new Promise<void>((resolve) =>
				emitter.on('raw-stdout', (_id, text: string) => {
					if (text.includes('STOPPING')) resolve();
				})
			);
			const config = {
				sessionId: 'resistant-fixture',
				toolType: 'codex',
				cwd: process.cwd(),
				command: process.execPath,
				args: [
					resolve('src/__tests__/fixtures/process-lifecycle/codex-auth-stall.cjs'),
					'--fixture-phase=resistant',
				],
				prompt: 'fixture',
				promptAlreadyInArgs: true,
			};
			expect(spawner.spawn(config).success).toBe(true);
			const predecessor = processes.get(config.sessionId)!;
			owned.push(predecessor);
			await failed;
			if (action === 'interrupt') {
				predecessor.interrupted = true;
				stopProcess({ child: predecessor.childProcess }, { from: 'terminate', immediate: true });
				await exited;
				expect(errors).not.toHaveBeenCalled();
				await vi.waitFor(() => expect(emitter.listenerCount('exit')).toBe(0));
				return;
			}
			// Model ProcessManager.kill(): reuse the existing stop ladder and remove
			// the map entry before registering the next turn under the same id.
			stopProcess({ child: predecessor.childProcess }, { from: 'terminate', graceMs: 2_000 });
			processes.delete(config.sessionId);
			expect(
				spawner.spawn({ ...config, args: ['-e', 'setInterval(() => {}, 1000)'] }).success
			).toBe(true);
			const successor = processes.get(config.sessionId)!;
			owned.push(successor);
			await vi.waitFor(() => expect(predecessor.childProcess?.signalCode).toBe('SIGKILL'), {
				timeout: 1_000,
			});
			expect(processes.get(config.sessionId)).toBe(successor);
			expect(successor.childProcess?.exitCode).toBeNull();
			expect(successor.childProcess?.signalCode).toBeNull();
		}
	);
	it.each([
		'startup',
		'after-model',
		'mcp-tool',
		'late-output',
		'after-model-late-output',
	] as const)(
		'settles %s blockage, forwards an error and releases its own MCP child',
		async (phase) => {
			const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
				stdio: 'ignore',
			});
			unrelatedChildren.push(unrelated);
			const processes = new Map<string, ManagedProcess>();
			const emitter = new EventEmitter();
			const errors: { message: string }[] = [];
			emitter.on('agent-error', (_id, error) => errors.push(error));
			const spawner = new ChildProcessSpawner(
				processes,
				emitter,
				new DataBufferManager(processes, emitter)
			);
			const runner = createDesktopConsultRunner(emitter as ProcessManager, null);
			let consultEnd: ConsultEnd | undefined;
			const deliveryOrder: string[] = [];
			emitter.on('data', () => deliveryOrder.push('data'));
			emitter.on('agent-error', () => deliveryOrder.push('error'));
			await runner.start({ processId: 'auth-fixture', providerId: 'codex' } as GroupChatSpawn, {
				onActivity: vi.fn(),
				onSessionId: vi.fn(),
				onEnd: (end) => {
					consultEnd = end;
				},
			});
			let mcpPid = 0;
			const ready = new Promise<void>((resolve) =>
				emitter.on('raw-stdout', (_id, text: string) => {
					const match = text.match(/MCP_READY:(\d+)/);
					if (match) {
						mcpPid = Number(match[1]);
						resolve();
					}
				})
			);
			let exitCode: number | undefined;
			const exited = new Promise<void>((resolve) =>
				emitter.once('exit', (_id, code: number) => {
					exitCode = code;
					resolve();
				})
			);

			expect(
				spawner.spawn({
					sessionId: 'auth-fixture',
					toolType: 'codex',
					cwd: process.cwd(),
					command: process.execPath,
					args: [
						resolve('src/__tests__/fixtures/process-lifecycle/codex-auth-stall.cjs'),
						`--fixture-phase=${phase}`,
					],
					prompt: 'fixture',
					promptAlreadyInArgs: true,
				}).success
			).toBe(true);
			const managed = processes.get('auth-fixture')!;
			owned.push(managed);
			await ready;
			if (phase === 'after-model' || phase === 'mcp-tool' || phase === 'after-model-late-output') {
				await new Promise((resolve) => setTimeout(resolve, phase === 'mcp-tool' ? 1_500 : 900));
				expect(
					processes.has('auth-fixture'),
					'model work and a running tool disarm startup and retain their own allowance'
				).toBe(true);
				expect(errors).toHaveLength(0);
			}
			// A finite test deadline catches the pre-fix product hang without waiting
			// for a production budget or leaving an orphan on test failure.
			const settled = await Promise.race([
				exited.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4_000)),
			]);
			expect(settled, `${phase}: desktop turn must not own its queue forever`).toBe(true);
			expect(processes.has('auth-fixture')).toBe(false);
			expect(exitCode, 'ask/consult callers must see a failed exit, even with partial text').toBe(
				1
			);
			expect(errors).toHaveLength(1);
			expect(consultEnd?.error).toBe(errors[0].message);
			expect(consultEnd?.exitCode).toBe(1);
			expect(consultEnd?.readText()).toBe(
				phase === 'startup'
					? ''
					: phase === 'late-output'
						? 'Last answer'
						: phase === 'after-model-late-output'
							? 'Last answer'
							: 'Starting work'
			);
			expect(deliveryOrder).toEqual(phase === 'startup' ? ['error'] : ['data', 'error']);
			expect(errors[0].message).toMatch(
				phase === 'startup' || phase === 'late-output'
					? /Startup or authentication/
					: phase === 'mcp-tool'
						? /tool or wait budget/
						: /semantic inactivity/
			);
			await vi.waitFor(
				() => {
					let state = '';
					try {
						state = readFileSync(`/proc/${mcpPid}/stat`, 'utf8').split(') ')[1][0];
					} catch {
						/* reaped */
					}
					expect(['', 'Z']).toContain(state);
				},
				{ timeout: 2_000 }
			);
			expect(unrelated.exitCode).toBeNull();
			expect(unrelated.signalCode).toBeNull();
			expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
			// The same desktop session can run its next queued turn after the error.
			const nextExit = new Promise<void>((resolve) => emitter.once('exit', () => resolve()));
			expect(
				spawner.spawn({
					sessionId: 'auth-fixture',
					toolType: 'codex',
					cwd: process.cwd(),
					command: process.execPath,
					args: [
						'-e',
						'console.log(JSON.stringify({type:"item.completed",item:{id:"next",type:"agent_message",text:"next turn"}}))',
					],
					prompt: 'fixture',
					promptAlreadyInArgs: true,
				}).success
			).toBe(true);
			owned.push(processes.get('auth-fixture')!);
			await nextExit;
			await vi.waitFor(() => expect(emitter.listenerCount('exit')).toBe(0));
			expect(processes.has('auth-fixture')).toBe(false);
			expect(errors).toHaveLength(1);
		}
	);
});
