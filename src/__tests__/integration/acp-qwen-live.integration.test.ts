import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AcpServerSpawner } from '../../main/process-manager/spawners/AcpServerSpawner';
import { DataBufferManager } from '../../main/process-manager/handlers/DataBufferManager';
import type { ManagedProcess, ProcessConfig } from '../../main/process-manager/types';
import {
	HARNESS_INTERACTION_REQUEST_CHANNEL,
	harnessInteractionBroker,
	initHarnessControl,
} from '../../main/harness-control/integration';
import type { HarnessInteractionRequest } from '../../shared/harness-control/types';

const LIVE = process.env.QWEN_LIVE === '1';

describe.skipIf(!LIVE)('Qwen ACP live approval', () => {
	let workspace = '';
	const processes = new Map<string, ManagedProcess>();
	let activeProcess: ManagedProcess | undefined;
	afterEach(async () => {
		harnessInteractionBroker.closeAll();
		activeProcess?.sdkController?.kill({ sync: true });
		await activeProcess?.harnessControl?.closed;
		if (workspace) rmSync(workspace, { recursive: true, force: true });
	});

	it('runs a real ACP turn and returns a permission selection', async () => {
		workspace = mkdtempSync(join(tmpdir(), 'maestro-qwen-acp-'));
		const emitter = new EventEmitter();
		const spawner = new AcpServerSpawner(
			processes,
			emitter,
			new DataBufferManager(processes, emitter),
			() => ({ pid: -1, success: false }),
			{ clientVersion: 'live-test' }
		);
		const requests: HarnessInteractionRequest[] = [];
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
								const option = request.options.find((item) => item.kind === 'allow-once');
								if (!option) throw new Error(`No allow-once option for ${request.title}`);
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
			sessionId: 'qwen-live-acp',
			toolType: 'qwen3-coder',
			cwd: workspace,
			command: 'C:/Users/Administrator/AppData/Roaming/npm/qwen.cmd',
			runInShell: true,
			args: [],
			nativeAcpArgs: ['--acp'],
			harnessControlMode: 'native',
			permissionMode: 'standard',
			prompt: 'Use the shell tool to create out.txt containing exactly NATIVE_OK, then stop.',
			tabId: 'live-tab',
		};
		const { promise: exited, resolve: resolveExit } = Promise.withResolvers<number>();
		emitter.on('exit', (_sessionId, code) => resolveExit(code));
		const result = spawner.spawn(config);
		expect(result.success).toBe(true);
		activeProcess = processes.get('qwen-live-acp');

		// A real model/child has no deterministic clock; bound the live probe and clear its watchdog.
		const { promise: deadline, reject: rejectDeadline } = Promise.withResolvers<number>();
		const watchdog = setTimeout(
			() => rejectDeadline(new Error('Qwen ACP approval timed out')),
			180_000
		);
		watchdog.unref();
		try {
			const code = await Promise.race([exited, deadline]);
			expect({ code, agentErrors }).toEqual({ code: 0, agentErrors: [] });
		} finally {
			clearTimeout(watchdog);
		}
		expect(requests.length).toBeGreaterThan(0);
		expect(readFileSync(join(workspace, 'out.txt'), 'utf8').trim()).toBe('NATIVE_OK');
	}, 200_000);
});
