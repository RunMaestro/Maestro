/** Production handler + admission journal + native transport composition. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { handleNewAITabWithPrompt } from '../../../main/web-server/handlers/messageHandlers/tabs';
import { hostCallerRuns } from '../../../main/agent-run/caller-identity';
import { pianolaNewTabSpawns } from '../../../main/pianola/pianola-new-tab-dispatch';
import * as store from '../../../main/pianola/pianola-store-main';
import { generateUUID } from '../../../shared/uuid';
import type {
	MessageHandlerContext,
	WebClient,
} from '../../../main/web-server/handlers/messageHandlers/types';
import type { NewAITabWithPromptCallback } from '../../../shared/pianola/pianola-dispatch';

vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }));
vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: () => ({ pianola: true }) }),
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
const directories: string[] = [];
let previousDataDir: string | undefined;
afterEach(() => {
	vi.restoreAllMocks();
	if (previousDataDir === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = previousDataDir;
	for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	previousDataDir = process.env.MAESTRO_USER_DATA;
	const root = path.resolve('.maestro/pianola-agent-supervision-20261104/Working');
	fs.mkdirSync(root, { recursive: true });
	const dir = fs.mkdtempSync(path.join(root, 'handler-'));
	directories.push(dir);
	process.env.MAESTRO_USER_DATA = dir;
	const scopeId = generateUUID();
	store.writeSupervisorTargets([
		{
			id: scopeId,
			kind: 'watch-scope',
			enabled: true,
			createdAt: 1,
			managerAgentId: 'manager',
			selection: {
				label: 'Workers',
				mode: 'agents-and-groups',
				agentIds: ['worker'],
				groupIds: [],
				excludedAgentIds: [],
			},
		},
	]);
	const owner = {
		id: 'worker',
		cwd: process.cwd(),
		parentSessionId: null,
		groupId: null,
		isPianola: false,
		remote: false,
	};
	const snapshot = {
		supervisionVersion: 1,
		complete: true,
		capturedAt: 100,
		owners: [owner],
		sessions: [] as object[],
	};
	const client = {} as WebClient;
	const controller = new AbortController();
	vi.spyOn(hostCallerRuns, 'resolve').mockImplementation((c) =>
		c === client
			? {
					run: { agentId: 'manager', tabId: 'caller-tab', spawnGeneration: 'caller-run' },
					signal: controller.signal,
					unattended: true,
					assertActive() {},
				}
			: undefined
	);
	const newTab = vi.fn<NewAITabWithPromptCallback>(
		async (_agent, _prompt, _background, _hidden, _routing, control) => {
			if (!control) return { success: true, tabId: 'ordinary-tab' };
			if (control.phase === 'prepare') {
				snapshot.sessions = [
					{
						agentId: 'worker',
						tabId: control.tabId,
						createdAt: 99,
						supervision: {
							...owner,
							ancestors: [],
							lineageComplete: true,
							paused: false,
							busy: false,
							consult: false,
							ephemeral: false,
							cursorAvailable: true,
							cursor: null,
						},
					},
				];
			} else {
				expect(store.readScopeCheckpoint(scopeId)?.tabs[0].tabId).toBe(control.tabId);
				pianolaNewTabSpawns.claim(`worker-ai-${control.tabId}`)();
				pianolaNewTabSpawns.started(`worker-ai-${control.tabId}`, 'native-run');
			}
			return { success: true, tabId: control.tabId };
		}
	);
	const send = vi.fn();
	const ctx = {
		callbacks: {
			getSessions: () => [{ id: 'worker' }],
			listDesktopSessions: () => snapshot,
			newAITabWithPrompt: newTab,
		},
		send,
		sendError: vi.fn(),
	} as unknown as MessageHandlerContext;
	return { ctx, client, newTab, send };
}
describe('production new-tab handler supervision wiring', () => {
	it('refuses a revoked previously bound caller instead of falling back to a human send', async () => {
		const f = fixture();
		vi.mocked(hostCallerRuns.resolve).mockReturnValue(undefined);
		vi.spyOn(hostCallerRuns, 'isRunClient').mockReturnValue(true);
		handleNewAITabWithPrompt(f.ctx, f.client, {
			type: 'new_ai_tab_with_prompt',
			sessionId: 'worker',
			prompt: 'Hello',
			dispatchId: generateUUID(),
		});
		await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
		expect(f.send.mock.calls[0][1]).toMatchObject({
			success: false,
			error: 'CallerRunUnavailable',
		});
		expect(f.newTab).not.toHaveBeenCalled();
	});

	it('consumes verified caller authority and returns the exact durable receipt, then only reads it on repeat', async () => {
		const f = fixture();
		const message = {
			type: 'new_ai_tab_with_prompt',
			sessionId: 'worker',
			prompt: 'Implement it',
			background: true,
			dispatchId: generateUUID(),
		};
		handleNewAITabWithPrompt(f.ctx, f.client, message);
		await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
		expect(f.send.mock.calls[0][1]).toMatchObject({
			success: true,
			dispatchId: message.dispatchId,
			admission: {
				outcome: 'accepted',
				supervision: 'enrolled',
				targetTabId: message.dispatchId,
				runId: 'native-run',
			},
		});
		handleNewAITabWithPrompt(f.ctx, f.client, message);
		await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
		expect(f.newTab).toHaveBeenCalledTimes(2);
	});
	it('does not grant supervision from forged public caller or callback fields', async () => {
		const f = fixture();
		handleNewAITabWithPrompt(f.ctx, {} as WebClient, {
			type: 'new_ai_tab_with_prompt',
			sessionId: 'worker',
			prompt: 'Hello',
			fromSessionId: 'manager',
			fromTabId: 'caller-tab',
			dispatchId: generateUUID(),
		});
		await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
		expect(f.newTab.mock.calls[0]).toHaveLength(5);
		expect(f.send.mock.calls[0][1].admission).toBeUndefined();
	});
});
