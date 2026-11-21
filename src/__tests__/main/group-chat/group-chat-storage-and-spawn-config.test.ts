// Source: src/__tests__/main/group-chat/group-chat-storage.test.ts
// Source: src/__tests__/main/group-chat/group-chat-turn-metrics.test.ts
// Source: src/__tests__/main/group-chat/group-chat-log.test.ts
// Source: src/__tests__/main/group-chat/spawn-config.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as storage from '../../../main/group-chat/group-chat-storage';
import { beginGroupChatTurn } from '../../../main/group-chat/group-chat-turn-metrics';
import { recordGroupChatTurnUsage } from '../../../main/group-chat/group-chat-turn-metrics';
import { finishGroupChatTurn } from '../../../main/group-chat/group-chat-turn-metrics';
import { resolveGroupChatTurnKey } from '../../../main/group-chat/group-chat-turn-metrics';
import { getGroupChatTurnCount } from '../../../main/group-chat/group-chat-turn-metrics';
import { resetGroupChatTurnMetricsForTests } from '../../../main/group-chat/group-chat-turn-metrics';
import type { UsageStats } from '../../../shared/types';
import { describe as __maestroMicrobenchDescribe } from 'vitest';
import * as shim from '../../../main/group-chat/group-chat-log';
import * as lib from '../../../shared/maestro-lib/groupchat/log';
import { toSpawnGroupChatAgentConfig } from '../../../main/group-chat/spawn-config';
import type { GroupChatSpawn } from '../../../shared/maestro-lib/groupchat/types';

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn((name: string) => {
			if (name === 'userData') {
				return mockUserDataPath;
			}
			throw new Error(`Unknown path name: ${name}`);
		}),
	},
}));
vi.mock('electron-store', () => {
	return {
		default: class MockStore {
			get(key: string) {
				return key === 'customSyncPath' ? mockCustomSyncPath : undefined;
			}
			set() {}
		},
	};
});
vi.mock('uuid', () => ({
	v4: vi.fn(() => `test-uuid-${++mockUuidCounter}`),
}));
let mockUserDataPath: string;
let mockCustomSyncPath: string | undefined;
let mockUuidCounter = 0;

describeSourceSuite('group-chat-storage', () => {
	describe('group-chat-storage (desktop binding)', () => {
		let testDir: string;

		beforeEach(async () => {
			testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'group-chat-storage-shim-'));
			mockUserDataPath = path.join(testDir, 'userData');
			mockCustomSyncPath = undefined;
			mockUuidCounter = 0;
		});

		afterEach(async () => {
			await fs.rm(testDir, { recursive: true, force: true });
		});

		it('roots chats under <userData>/group-chats when no custom sync path is set', async () => {
			const chat = await storage.createGroupChat('Test Chat', 'claude-code');

			const chatDir = path.join(mockUserDataPath, 'group-chats', chat.id);
			expect(storage.getGroupChatDir(chat.id)).toBe(chatDir);
			expect(chat.logPath).toBe(path.join(chatDir, 'chat.log'));
			expect(chat.imagesDir).toBe(path.join(chatDir, 'images'));
			await expect(fs.stat(path.join(chatDir, 'metadata.json'))).resolves.toBeDefined();
		});

		it('names new chats with the uuid generator the desktop uses', async () => {
			const chat = await storage.createGroupChat('Test Chat', 'claude-code');

			expect(chat.id).toBe('test-uuid-1');
		});

		it('roots chats under <customSyncPath>/group-chats when one is configured', async () => {
			mockCustomSyncPath = path.join(testDir, 'synced');

			const chat = await storage.createGroupChat('Synced Chat', 'claude-code');

			const chatDir = path.join(mockCustomSyncPath, 'group-chats', chat.id);
			expect(storage.getGroupChatDir(chat.id)).toBe(chatDir);
			await expect(fs.stat(path.join(chatDir, 'metadata.json'))).resolves.toBeDefined();
			await expect(fs.stat(path.join(mockUserDataPath, 'group-chats'))).rejects.toThrow();
		});

		it('re-reads the custom sync path on every call', async () => {
			const local = await storage.createGroupChat('Local', 'claude-code');
			mockCustomSyncPath = path.join(testDir, 'synced');
			const synced = await storage.createGroupChat('Synced', 'claude-code');

			expect((await storage.listGroupChats()).map((c) => c.id)).toEqual([synced.id]);
			mockCustomSyncPath = undefined;
			expect((await storage.listGroupChats()).map((c) => c.id)).toEqual([local.id]);
		});

		it('exports every storage function the main process imports', () => {
			for (const name of [
				'getGroupChatDir',
				'createGroupChat',
				'loadGroupChat',
				'listGroupChats',
				'deleteGroupChat',
				'updateGroupChat',
				'addParticipantToChat',
				'removeParticipantFromChat',
				'removeParticipantFromChatWithResult',
				'getParticipant',
				'updateParticipant',
				'addGroupChatHistoryEntry',
				'getGroupChatHistory',
				'deleteGroupChatHistoryEntry',
				'clearGroupChatHistory',
				'getGroupChatHistoryFilePath',
				'extractFirstSentence',
			] as const) {
				expect(typeof storage[name]).toBe('function');
			}
		});
	});
});
describeSourceSuite('group-chat-turn-metrics', () => {
	const CHAT = '550e8400-e29b-41d4-a716-446655440000';

	function usage(overrides: Partial<UsageStats> = {}): UsageStats {
		return {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0,
			contextWindow: 200000,
			...overrides,
		};
	}

	describe('group-chat-turn-metrics', () => {
		beforeEach(() => {
			resetGroupChatTurnMetricsForTests();
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		describe('resolveGroupChatTurnKey', () => {
			it('resolves a participant session', () => {
				expect(resolveGroupChatTurnKey(`group-chat-${CHAT}-participant-rc-1702934567890`)).toEqual({
					groupChatId: CHAT,
					participantName: 'rc',
				});
			});

			it('resolves a moderator session to the name the history log uses', () => {
				expect(resolveGroupChatTurnKey(`group-chat-${CHAT}-moderator-1702934567890`)).toEqual({
					groupChatId: CHAT,
					participantName: 'Moderator',
				});
			});

			it('refuses a session that is not a group chat turn', () => {
				expect(resolveGroupChatTurnKey('agent-123-ai-tab1')).toBeNull();
			});
		});

		it('reports the elapsed time of a finished turn', () => {
			beginGroupChatTurn(`group-chat-${CHAT}-participant-rc-1`);
			vi.advanceTimersByTime(90_000);

			expect(finishGroupChatTurn(CHAT, 'rc').elapsedTimeMs).toBe(90_000);
		});

		it('sums usage events into the turn that is running', () => {
			const session = `group-chat-${CHAT}-participant-rc-1`;
			beginGroupChatTurn(session);
			recordGroupChatTurnUsage(session, usage({ inputTokens: 100, outputTokens: 20 }));
			recordGroupChatTurnUsage(
				session,
				usage({ cacheReadInputTokens: 800, cacheCreationInputTokens: 80, totalCostUsd: 0.5 })
			);

			const metrics = finishGroupChatTurn(CHAT, 'rc');
			expect(metrics.tokenCount).toBe(1000);
			expect(metrics.cost).toBeCloseTo(0.5);
		});

		it('keeps parallel participants apart', () => {
			beginGroupChatTurn(`group-chat-${CHAT}-participant-rc-1`);
			beginGroupChatTurn(`group-chat-${CHAT}-participant-Maestro-2`);
			recordGroupChatTurnUsage(`group-chat-${CHAT}-participant-rc-1`, usage({ inputTokens: 500 }));
			recordGroupChatTurnUsage(
				`group-chat-${CHAT}-participant-Maestro-2`,
				usage({ inputTokens: 7 })
			);

			expect(finishGroupChatTurn(CHAT, 'rc').tokenCount).toBe(500);
			expect(finishGroupChatTurn(CHAT, 'Maestro').tokenCount).toBe(7);
		});

		it('reports nothing at all when no turn is in flight', () => {
			expect(finishGroupChatTurn(CHAT, 'rc')).toEqual({});
		});

		it('omits tokens rather than reporting a fabricated zero', () => {
			beginGroupChatTurn(`group-chat-${CHAT}-participant-rc-1`);
			const metrics = finishGroupChatTurn(CHAT, 'rc');

			expect(metrics.elapsedTimeMs).toBeDefined();
			expect(metrics.tokenCount).toBeUndefined();
			expect(metrics.cost).toBeUndefined();
		});

		it('does not carry an abandoned turn usage into its respawn', () => {
			const first = `group-chat-${CHAT}-participant-rc-1`;
			beginGroupChatTurn(first);
			recordGroupChatTurnUsage(first, usage({ inputTokens: 900 }));

			const recovery = `group-chat-${CHAT}-participant-rc-recovery-2`;
			beginGroupChatTurn(recovery);
			recordGroupChatTurnUsage(recovery, usage({ inputTokens: 5 }));

			expect(finishGroupChatTurn(CHAT, 'rc').tokenCount).toBe(5);
		});

		it('ignores a late event from an abandoned session', () => {
			const first = `group-chat-${CHAT}-participant-rc-1`;
			beginGroupChatTurn(first);
			beginGroupChatTurn(`group-chat-${CHAT}-participant-rc-recovery-2`);
			recordGroupChatTurnUsage(first, usage({ inputTokens: 900 }));

			expect(finishGroupChatTurn(CHAT, 'rc').tokenCount).toBeUndefined();
		});

		it('drops the turn once it has been claimed', () => {
			beginGroupChatTurn(`group-chat-${CHAT}-participant-rc-1`);
			expect(getGroupChatTurnCount()).toBe(1);

			finishGroupChatTurn(CHAT, 'rc');
			expect(getGroupChatTurnCount()).toBe(0);
		});

		it('ignores sessions that are not group chat turns', () => {
			beginGroupChatTurn('agent-123-ai-tab1');
			expect(getGroupChatTurnCount()).toBe(0);
		});
	});
});

__maestroMicrobenchDescribe('group-chat-log', () => {
	describe('group-chat-log (desktop shim)', () => {
		it('re-exports the library implementation', () => {
			for (const name of [
				'escapeContent',
				'unescapeContent',
				'appendToLog',
				'readLog',
				'saveImage',
			] as const) {
				expect(shim[name]).toBe(lib[name]);
			}
		});
	});
});
__maestroMicrobenchDescribe('spawn-config', () => {
	describe('toSpawnGroupChatAgentConfig', () => {
		const spawn: GroupChatSpawn = {
			processId: 'cross-agent-r1',
			providerId: 'codex',
			agent: { id: 'codex' } as never,
			command: '/opt/codex',
			remoteCommand: '/remote/codex',
			args: ['exec'],
			cwd: '/proj',
			prompt: 'hi',
			customEnvVars: { A: '1' },
			agentConfigValues: { contextWindow: 5 },
			sshRemoteConfig: { enabled: true, remoteId: 'r1' },
			tokenMode: 'api',
			maestroPPath: '/p/maestro-p.js',
			readOnlyMode: true,
			debugLabel: 'label',
			maxWaitSeconds: 600,
			acceptWorkspaceTrust: true,
		};

		it('carries every field of the library spawn across, renaming the two ids', () => {
			const processManager = { spawn: () => ({}) } as never;
			const sshStore = { getSshRemotes: () => [] } as never;

			const config = toSpawnGroupChatAgentConfig(spawn, { processManager, sshStore });

			expect(config).toEqual({
				sessionId: 'cross-agent-r1',
				agentId: 'codex',
				agent: spawn.agent,
				command: '/opt/codex',
				remoteCommand: '/remote/codex',
				args: ['exec'],
				cwd: '/proj',
				prompt: 'hi',
				customEnvVars: { A: '1' },
				agentConfigValues: { contextWindow: 5 },
				sshRemoteConfig: { enabled: true, remoteId: 'r1' },
				sshStore,
				tokenMode: 'api',
				maestroPPath: '/p/maestro-p.js',
				processManager,
				readOnlyMode: true,
				debugLabel: 'label',
				maxWaitSeconds: 600,
				acceptWorkspaceTrust: true,
			});
		});

		it('passes a missing SSH store through as null, never undefined', () => {
			const config = toSpawnGroupChatAgentConfig(spawn, {
				processManager: {} as never,
				sshStore: null,
			});
			expect(config.sshStore).toBeNull();
		});
	});
});
