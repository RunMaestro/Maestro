import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeSdkSpawner } from '../../main/process-manager/spawners/ClaudeSdkSpawner';
import { DataBufferManager } from '../../main/process-manager/handlers/DataBufferManager';
import type { ManagedProcess, ProcessConfig } from '../../main/process-manager/types';
import type { SteeringResultFrame } from '../../shared/chatSteering';
import {
	HARNESS_INTERACTION_REQUEST_CHANNEL,
	harnessInteractionBroker,
	initHarnessControl,
} from '../../main/harness-control/integration';
import type { HarnessInteractionRequest } from '../../shared/harness-control/types';

const LIVE = process.env.CLAUDE_LIVE === '1';

describe.skipIf(!LIVE)('Claude Agent SDK live control', () => {
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

	it('approves tools and runs a queued steering follow-up', async () => {
		workspace = mkdtempSync(join(tmpdir(), 'maestro-claude-native-'));
		const emitter = new EventEmitter();
		const spawner = new ClaudeSdkSpawner(
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
			sessionId: 'claude-live-native',
			toolType: 'claude-code',
			cwd: workspace,
			command: 'C:/Users/Administrator/.local/bin/claude.exe',
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
					text: 'Now update second.txt so its only content is SECOND_STEER.',
				})
				.then((frame) => verdicts.push(frame))
				.finally(() => resolveSteered());
		});
		const result = spawner.spawn(config);
		expect(result.success).toBe(true);
		activeProcess = processes.get('claude-live-native');
		await Promise.race([
			steered,
			exited.then((code) => {
				throw new Error(
					`Claude exited before steering was possible (${code}): ${JSON.stringify(agentErrors)}`
				);
			}),
		]);
		const code = await exited;
		expect({ code, agentErrors }).toEqual({ code: 0, agentErrors: [] });
		expect(verdicts.some((frame) => frame.id === 'live-steer' && frame.verdict === 'queued')).toBe(
			true
		);
		expect(requests.length).toBeGreaterThan(0);
		expect(readFileSync(join(workspace, 'first.txt'), 'utf8').trim()).toBe('ONE');
		expect(readFileSync(join(workspace, 'second.txt'), 'utf8').trim()).toBe('SECOND_STEER');
	}, 200_000);
});
