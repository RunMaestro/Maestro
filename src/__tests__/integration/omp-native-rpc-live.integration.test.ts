import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RpcServerSpawner } from '../../main/process-manager/spawners/RpcServerSpawner';
import { DataBufferManager } from '../../main/process-manager/handlers/DataBufferManager';
import type { ManagedProcess, ProcessConfig } from '../../main/process-manager/types';
import type { SteeringResultFrame } from '../../shared/chatSteering';
import {
	HARNESS_INTERACTION_REQUEST_CHANNEL,
	harnessInteractionBroker,
	initHarnessControl,
} from '../../main/harness-control/integration';
import type { HarnessInteractionRequest } from '../../shared/harness-control/types';

const LIVE = process.env.OMP_LIVE === '1';
async function removeWorkspace(workspace: string): Promise<void> {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			rmSync(workspace, { recursive: true, force: true });
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}
	throw new Error(`Workspace remained locked for 60 seconds: ${workspace}`);
}

describe.skipIf(!LIVE)('OMP native RPC live control', () => {
	const processes = new Map<string, ManagedProcess>();
	let activeProcess: ManagedProcess | undefined;
	let workspace = '';
	afterEach(async () => {
		harnessInteractionBroker.closeAll();
		activeProcess?.sdkController?.kill({ sync: true });
		await activeProcess?.harnessControl?.closed;
		if (workspace) await removeWorkspace(workspace);
	});

	it('absorbs a mid-run steer', async () => {
		workspace = mkdtempSync(join(tmpdir(), 'maestro-omp-rpc-'));
		const emitter = new EventEmitter();
		const spawner = new RpcServerSpawner(
			processes,
			emitter,
			new DataBufferManager(processes, emitter),
			() => ({ pid: -1, success: false })
		);
		const requests: HarnessInteractionRequest[] = [];
		const verdicts: SteeringResultFrame[] = [];
		const agentErrors: unknown[] = [];
		emitter.on('steering-verdict', (_sessionId, frame) => verdicts.push(frame));
		emitter.on('agent-error', (_sessionId, error) => agentErrors.push(error));
		const output: string[] = [];
		emitter.on('data', (_sessionId, chunk) => output.push(String(chunk)));
		initHarnessControl(
			{
				getMainWindow: () =>
					({
						isDestroyed: () => false,
						webContents: {
							isDestroyed: () => false,
							send: (channel: string, payload: unknown) => {
								if (channel !== HARNESS_INTERACTION_REQUEST_CHANNEL) return;
								const request = payload as HarnessInteractionRequest;
								requests.push(request);
								const option = request.options.find(
									(item) => item.kind === 'allow-once' || item.kind === 'choice'
								);
								if (!option) throw new Error(`No approval option for ${request.title}`);
								harnessInteractionBroker.resolve({
									requestId: request.requestId,
									outcome: 'selected',
									optionId: option.optionId,
								});
							},
						},
					}) as never,
			},
			null
		);
		const config: ProcessConfig = {
			sessionId: 'omp-live-rpc',
			toolType: 'omp',
			cwd: workspace,
			command: 'C:/Users/Administrator/AppData/Local/omp/omp.exe',
			args: [],
			nativeRpcArgs: ['--mode', 'rpc-ui'],
			nativeRpcProtocol: 'omp-rpc',
			permissionMode: 'standard',
			prompt:
				'Use shell commands, not other tools. First run a command that creates first.txt containing ONE. Only after it succeeds, run a separate command that creates second.txt containing TWO. Do not combine them into one command.',
			tabId: 'live-tab',
		};
		const { promise: exited, resolve: resolveExit } = Promise.withResolvers<number>();
		emitter.on('exit', (_sessionId, code) => resolveExit(code));
		const { promise: steered, resolve: resolveSteered } = Promise.withResolvers<void>();
		let steerStarted = false;
		emitter.on('tool-execution', () => {
			if (steerStarted) return;
			steerStarted = true;
			void processes.get('omp-live-rpc')?.harnessControl?.steer({
				id: 'live-steer',
				text: 'For second.txt, write SECOND_STEER instead of TWO. Keep every other instruction unchanged.',
			});
			resolveSteered();
		});
		const result = spawner.spawn(config);
		expect(result.success).toBe(true);
		activeProcess = processes.get('omp-live-rpc');
		const { promise: deadline, reject: rejectDeadline } = Promise.withResolvers<number>();
		const watchdog = setTimeout(
			() =>
				rejectDeadline(
					new Error(
						`OMP native RPC turn timed out: ${JSON.stringify({ requests: requests.length, verdicts, agentErrors, output: output.join('').slice(-2000) })}`
					)
				),
			60_000
		);
		watchdog.unref();
		try {
			await Promise.race([steered, exited, deadline]);
			const code = await Promise.race([exited, deadline]);
			expect({ code, agentErrors }).toEqual({ code: 0, agentErrors: [] });
		} finally {
			clearTimeout(watchdog);
		}
		expect(
			verdicts.some((frame) => frame.id === 'live-steer' && frame.verdict === 'absorbed')
		).toBe(true);
		expect(readFileSync(join(workspace, 'first.txt'), 'utf8').trim()).toBe('ONE');
		expect(readFileSync(join(workspace, 'second.txt'), 'utf8').trim()).toBe('SECOND_STEER');
	}, 80_000);
});
