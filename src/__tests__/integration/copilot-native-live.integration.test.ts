import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CopilotSdkSpawner } from '../../main/process-manager/spawners/CopilotSdkSpawner';
import { DataBufferManager } from '../../main/process-manager/handlers/DataBufferManager';
import type { ManagedProcess, ProcessConfig } from '../../main/process-manager/types';
import type { SteeringResultFrame } from '../../shared/chatSteering';
import {
	HARNESS_INTERACTION_REQUEST_CHANNEL,
	harnessInteractionBroker,
	initHarnessControl,
} from '../../main/harness-control/integration';
import type { HarnessInteractionRequest } from '../../shared/harness-control/types';

const LIVE = process.env.COPILOT_LIVE === '1';

describe.skipIf(!LIVE)('Copilot SDK live control', () => {
	const processes = new Map<string, ManagedProcess>();
	let activeProcess: ManagedProcess | undefined;
	let workspace = '';
	afterEach(async () => {
		harnessInteractionBroker.closeAll();
		activeProcess?.sdkController?.kill({ sync: true });
		await activeProcess?.harnessControl?.closed;
		if (workspace) {
			if (process.platform === 'win32') execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', workspace]);
			else rmSync(workspace, { recursive: true, force: true });
		}
	});

	it('approves tools, steers immediately, and reuses the retained session', async () => {
		workspace = mkdtempSync(join(tmpdir(), 'maestro-copilot-native-'));
		const emitter = new EventEmitter();
		const spawner = new CopilotSdkSpawner(
			processes,
			emitter,
			new DataBufferManager(processes, emitter),
			() => ({ pid: -1, success: false })
		);
		const requests: HarnessInteractionRequest[] = [];
		const verdicts: SteeringResultFrame[] = [];
		const agentErrors: unknown[] = [];
		emitter.on('agent-error', (_sessionId, error) => agentErrors.push(error));
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
								harnessInteractionBroker.resolve({
									requestId: request.requestId,
									outcome: 'selected',
									optionId: 'allow',
								});
							},
						},
					}) as never,
			},
			null
		);
		const config: ProcessConfig = {
			sessionId: 'copilot-live-native',
			toolType: 'copilot-cli',
			cwd: workspace,
			command: 'copilot',
			args: [],
			harnessControlMode: 'native',
			permissionMode: 'standard',
			prompt:
				'Use tools to create first.txt containing ONE, then second.txt containing TWO. Keep the work in this directory.',
			tabId: 'live-tab',
		};
		const { promise: exited, resolve: resolveExit } = Promise.withResolvers<number>();
		emitter.on('exit', (_sessionId, code) => resolveExit(code));
		const { promise: steered, resolve: resolveSteered } = Promise.withResolvers<void>();
		let steerStarted = false;
		emitter.on('tool-execution', () => {
			if (steerStarted) return;
			steerStarted = true;
			void activeProcess?.harnessControl
				?.steer({
					id: 'live-steer',
					text: 'For second.txt, write SECOND_STEER instead of TWO.',
				})
				.then((frame) => verdicts.push(frame))
				.finally(() => resolveSteered());
		});
		const result = spawner.spawn(config);
		expect(result.success).toBe(true);
		activeProcess = processes.get('copilot-live-native');
		await Promise.race([
			steered,
			exited.then((code) => {
				throw new Error(
					`Copilot exited before steering was possible (${code}): ${JSON.stringify(agentErrors)}`
				);
			}),
		]);
		const code = await exited;
		expect({ code, agentErrors }).toEqual({ code: 0, agentErrors: [] });
		expect(
			verdicts.some((frame) => frame.id === 'live-steer' && frame.verdict === 'delivered')
		).toBe(true);
		expect(requests.length).toBeGreaterThan(0);
		expect(readFileSync(join(workspace, 'first.txt'), 'utf8').trim()).toBe('ONE');
		expect(readFileSync(join(workspace, 'second.txt'), 'utf8').trim()).toBe('SECOND_STEER');
		const providerSessionId = activeProcess?.agentSessionId;
		expect(providerSessionId).toBeTruthy();
		const secondExit = Promise.withResolvers<number>();
		emitter.on('exit', (sessionId, code) => {
			if (sessionId === 'copilot-live-native-second') secondExit.resolve(code);
		});
		const secondResult = spawner.spawn({
			...config,
			sessionId: 'copilot-live-native-second',
			agentSessionId: providerSessionId,
			prompt: 'Use tools to create third.txt containing PERSISTED, then stop.',
		});
		expect(secondResult.success).toBe(true);
		activeProcess = processes.get('copilot-live-native-second');
		await expect(secondExit.promise).resolves.toBe(0);
		expect(readFileSync(join(workspace, 'third.txt'), 'utf8').trim()).toBe('PERSISTED');
	}, 240_000);
});
