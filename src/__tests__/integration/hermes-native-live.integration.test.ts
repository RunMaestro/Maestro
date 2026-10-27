import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HermesApiSpawner } from '../../main/process-manager/spawners/HermesApiSpawner';
import { DataBufferManager } from '../../main/process-manager/handlers/DataBufferManager';
import type { ManagedProcess, ProcessConfig } from '../../main/process-manager/types';
import type { SteeringResultFrame } from '../../shared/chatSteering';
import {
	HARNESS_INTERACTION_REQUEST_CHANNEL,
	harnessInteractionBroker,
	initHarnessControl,
} from '../../main/harness-control/integration';
import type { HarnessInteractionRequest } from '../../shared/harness-control/types';

const LIVE = process.env.HERMES_LIVE === '1';

describe.skipIf(!LIVE)('Hermes native gateway live control', () => {
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

	it('answers interactions and accepts a mid-run steer', async () => {
		workspace = mkdtempSync(join(tmpdir(), 'maestro-hermes-native-'));
		const emitter = new EventEmitter();
		const spawner = new HermesApiSpawner(
			processes,
			emitter,
			new DataBufferManager(processes, emitter),
			() => ({ pid: -1, success: false })
		);
		const requests: HarnessInteractionRequest[] = [];
		const verdicts: SteeringResultFrame[] = [];
		const agentErrors: unknown[] = [];
		let transcript = '';
		emitter.on('data', (_sessionId, chunk) => {
			transcript += String(chunk);
		});
		emitter.on('steering-verdict', (_sessionId, frame) => verdicts.push(frame));
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
								startSteer();
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
			sessionId: 'hermes-live-native',
			toolType: 'hermes',
			cwd: workspace,
			command: 'C:/Users/Administrator/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe',
			args: ['-m', 'tui_gateway.entry'],
			customEnvVars: {
				PYTHONPATH: 'C:/Users/Administrator/AppData/Local/hermes/hermes-agent',
				HERMES_HOME: 'C:/Users/Administrator/AppData/Local/hermes/hermes-agent',
			},
			harnessControlMode: 'native',
			permissionMode: 'standard',
			prompt:
				'Before doing anything else, use the clarify tool exactly once to ask “Continue?” with options “Yes” and “No”. After the answer, respond with exactly ORIGINAL.',
			tabId: 'live-tab',
		};
		const { promise: exited, resolve: resolveExit } = Promise.withResolvers<number>();
		emitter.on('exit', (_sessionId, code) => resolveExit(code));
		const { promise: steered, resolve: resolveSteered } = Promise.withResolvers<void>();
		let steerStarted = false;
		const startSteer = () => {
			if (steerStarted) return;
			steerStarted = true;
			void activeProcess?.harnessControl
				?.steer({
					id: 'live-steer',
					text: 'Instead of ORIGINAL, respond with exactly SECOND_STEER.',
				})
				.then((frame) => verdicts.push(frame))
				.finally(() => resolveSteered());
		};
		const result = spawner.spawn(config);
		expect(result.success).toBe(true);
		activeProcess = processes.get('hermes-live-native');
		await steered;

		const { promise: deadline, reject: rejectDeadline } = Promise.withResolvers<number>();
		const watchdog = setTimeout(
			() => rejectDeadline(new Error('Hermes native turn timed out')),
			90_000
		);
		watchdog.unref();
		try {
			const code = await Promise.race([exited, deadline]);
			expect({ code, agentErrors }).toEqual({ code: 0, agentErrors: [] });
		} finally {
			clearTimeout(watchdog);
		}
		expect(verdicts.some((frame) => frame.id === 'live-steer' && frame.verdict === 'queued')).toBe(
			true
		);
		expect(requests.some((request) => request.kind === 'question')).toBe(true);
		expect(transcript).toContain('SECOND_STEER');
	}, 110_000);
});
