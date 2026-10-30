import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createOpencodeClient, createOpencodeServer, type Event } from '@opencode-ai/sdk';
import {
	HARNESS_INTERACTION_REQUEST_CHANNEL,
	harnessInteractionBroker,
	initHarnessControl,
} from '../../main/harness-control/integration';
import type { OpencodePermissionRequest } from '../../main/opencode-server/permission-requests';
import {
	opencodePermissionOpenRequest,
	opencodePermissionResponse,
} from '../../main/opencode-server/permission-requests';
import type { HarnessInteractionRequest } from '../../shared/harness-control/types';

const LIVE = process.env.OPENCODE_LIVE === '1';

describe.skipIf(!LIVE)('OpenCode server live approval', () => {
	let workspace = '';
	afterEach(() => {
		harnessInteractionBroker.closeAll();
		if (workspace) rmSync(workspace, { recursive: true, force: true });
	});

	it('pauses a real tool call and writes only after native approval', async () => {
		workspace = mkdtempSync(join(tmpdir(), 'maestro-opencode-approval-'));
		writeFileSync(
			join(workspace, 'opencode.json'),
			JSON.stringify({ permission: { '*': 'allow', edit: 'ask', bash: 'ask' } })
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
								harnessInteractionBroker.resolve({
									requestId: request.requestId,
									outcome: 'selected',
									optionId: 'once',
								});
							},
						},
					}) as never,
			},
			null
		);
		const server = await createOpencodeServer({ hostname: '127.0.0.1', port: 0, timeout: 20_000 });
		const client = createOpencodeClient({ baseUrl: server.url });
		try {
			const created = await client.session.create({ query: { directory: workspace } });
			const sessionId = created.data?.id;
			expect(sessionId).toBeTruthy();
			const subscription = await client.event.subscribe({ query: { directory: workspace } });
			const pump = (async () => {
				for await (const event of subscription.stream as AsyncIterable<Event>) {
					const currentProtocol = (event.type as string) === 'permission.asked';
					if (currentProtocol || event.type === 'permission.updated') {
						const permission = event.properties as OpencodePermissionRequest;
						const opened = harnessInteractionBroker.open(
							opencodePermissionOpenRequest(permission, {
								sessionId: 'opencode-live-approval',
								tabId: 'live-tab',
								spawnGeneration: 1,
							})
						);
						const resolution = await opened.completion;
						const response = opencodePermissionResponse(resolution);
						if (currentProtocol) {
							const query = new URLSearchParams({ directory: workspace });
							const result = await fetch(
								`${server.url}/permission/${encodeURIComponent(permission.id)}/reply?${query}`,
								{
									method: 'POST',
									headers: { 'content-type': 'application/json' },
									body: JSON.stringify({ reply: response }),
								}
							);
							if (!result.ok) throw new Error('OpenCode rejected the live permission response');
						} else {
							const result = await client.postSessionIdPermissionsPermissionId({
								path: { id: sessionId as string, permissionID: permission.id },
								query: { directory: workspace },
								body: { response },
							});
							if (result.error || result.data === false) {
								throw new Error('OpenCode rejected the live permission response');
							}
						}
					}
					if (event.type === 'session.idle' && event.properties.sessionID === sessionId) break;
				}
			})();

			const promptResult = await client.session.promptAsync({
				path: { id: sessionId as string },
				query: { directory: workspace },
				body: {
					model: { providerID: 'opencode', modelID: 'big-pickle' },
					parts: [
						{
							type: 'text',
							text: 'Use the shell tool to create out.txt containing exactly NATIVE_OK, then stop.',
						},
					],
				},
			});
			if (promptResult.error) throw promptResult.error;

			// A real model/server has no deterministic clock; bound the probe and clear its watchdog.
			const { promise: deadline, reject: rejectDeadline } = Promise.withResolvers<void>();
			const watchdog = setTimeout(
				() => rejectDeadline(new Error('OpenCode approval timed out')),
				60_000
			);
			watchdog.unref();
			try {
				await Promise.race([pump, deadline]);
			} finally {
				clearTimeout(watchdog);
			}

			expect(requests.length).toBeGreaterThan(0);
			expect(readFileSync(join(workspace, 'out.txt'), 'utf8').trim()).toBe('NATIVE_OK');
		} finally {
			server.close();
		}
	}, 200_000);
});
