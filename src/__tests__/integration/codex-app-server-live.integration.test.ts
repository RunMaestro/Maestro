import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CodexAppServerSpawner } from '../../main/process-manager/spawners/CodexAppServerSpawner';
import { DataBufferManager } from '../../main/process-manager/handlers/DataBufferManager';
import type { ManagedProcess, ProcessConfig } from '../../main/process-manager/types';
import {
	HARNESS_INTERACTION_REQUEST_CHANNEL,
	harnessInteractionBroker,
	initHarnessControl,
} from '../../main/harness-control/integration';
import type { HarnessInteractionRequest } from '../../shared/harness-control/types';

const LIVE = process.env.CODEX_LIVE === '1';

describe.skipIf(!LIVE)('Codex app-server live approval', () => {
	let workspace = '';
	afterEach(() => {
		harnessInteractionBroker.closeAll();
		if (workspace) rmSync(workspace, { recursive: true, force: true });
	});

	it('pauses a real tool call and writes only after native approval', async () => {
		workspace = mkdtempSync(join(tmpdir(), 'maestro-codex-approval-'));
		const processes = new Map<string, ManagedProcess>();
		const emitter = new EventEmitter();
		const spawner = new CodexAppServerSpawner(
			processes,
			emitter,
			new DataBufferManager(processes, emitter),
			() => ({ pid: -1, success: false }),
			{ clientVersion: 'live-test' }
		);
		const requests: HarnessInteractionRequest[] = [];
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
			sessionId: 'codex-live-approval',
			toolType: 'codex',
			cwd: workspace,
			command: 'C:/Users/Administrator/AppData/Roaming/npm/codex.cmd',
			runInShell: true,
			args: ['-C', workspace, 'exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check'],
			prompt: 'Use the shell tool to create out.txt containing exactly NATIVE_OK, then stop.',
			permissionMode: 'standard',
			tabId: 'live-tab',
		};
		const { promise: exited, resolve: resolveExit } = Promise.withResolvers<number>();
		emitter.on('exit', (_sessionId, code) => resolveExit(code));

		const result = spawner.spawn(config);
		expect(result.success).toBe(true);
		// A real model/child has no deterministic clock; bound the live probe and clear its watchdog.
		const { promise: deadline, reject: rejectDeadline } = Promise.withResolvers<number>();
		const watchdog = setTimeout(
			() => rejectDeadline(new Error('Codex approval timed out')),
			180_000
		);
		watchdog.unref();
		try {
			await expect(Promise.race([exited, deadline])).resolves.toBe(0);
		} finally {
			clearTimeout(watchdog);
		}

		expect(requests.length).toBeGreaterThan(0);
		expect(readFileSync(join(workspace, 'out.txt'), 'utf8').trim()).toBe('NATIVE_OK');
	}, 200_000);
});
