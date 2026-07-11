import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test as electronTest, expect } from './fixtures/electron-app';

const GROUP_CHAT_ID = '00000000-0000-4000-8000-000000000423';
const EXPECTED_COUNTS = {
	groups: 32,
	sessions: 93,
	aiTabs: 361,
	largestGroupSessions: 17,
	participants: 8,
	messages: 423,
};

const test = electronTest.extend({
	// eslint-disable-next-line no-empty-pattern
	electronLaunchEnv: async ({}, use) => {
		await use({ MAESTRO_DISABLE_GROUP_CHAT_PROVIDERS: '1' });
	},
	// eslint-disable-next-line no-empty-pattern
	testDataDir: async ({}, use) => {
		const runtimeDir = path.join(__dirname, '../artifacts/runtime');
		fs.mkdirSync(runtimeDir, { recursive: true });
		const demoDir = fs.mkdtempSync(path.join(runtimeDir, 'maestro-group-chat-load-e2e-'));
		fs.rmSync(demoDir, { recursive: true, force: true });
		execFileSync(
			process.execPath,
			[path.join(__dirname, '../scripts/group-chat-load-demo.mjs'), '--seed-only', demoDir],
			{ cwd: path.join(__dirname, '..'), stdio: 'pipe' }
		);
		await use(demoDir);
		fs.rmSync(demoDir, { recursive: true, force: true });
	},
});

test('loads the synthetic cardinalities through real stores in an isolated demo', async ({
	electronApp,
	window,
	testDataDir,
}) => {
	const userDataPath = await electronApp.evaluate(({ app }) => app.getPath('userData'));
	expect(path.resolve(userDataPath)).toBe(path.resolve(testDataDir));

	const snapshot = await window.evaluate(async (groupChatId) => {
		const [groups, sessions, chats, messages] = await Promise.all([
			window.maestro.groups.getAll(),
			window.maestro.sessions.getAll(),
			window.maestro.groupChat.list(),
			window.maestro.groupChat.getMessages(groupChatId),
		]);
		const sessionsPerGroup = new Map(groups.map((group) => [group.id, 0]));
		for (const session of sessions) {
			sessionsPerGroup.set(session.groupId, (sessionsPerGroup.get(session.groupId) ?? 0) + 1);
		}
		const chat = chats.find((candidate) => candidate.id === groupChatId);
		return {
			groups: groups.length,
			sessions: sessions.length,
			aiTabs: sessions.reduce((total, session) => total + session.aiTabs.length, 0),
			largestGroupSessions: Math.max(...sessionsPerGroup.values()),
			participants: chat?.participants.length ?? 0,
			messages: messages.length,
			moderatorAgentId: chat?.moderatorAgentId,
		};
	}, GROUP_CHAT_ID);

	expect(snapshot).toEqual({ ...EXPECTED_COUNTS, moderatorAgentId: 'e2e-null-agent' });

	const groupChatItem = window.locator(`[data-nav-key="groupchat:${GROUP_CHAT_ID}"]`);
	await expect(groupChatItem).toBeVisible({ timeout: 30_000 });
	await groupChatItem.click();

	const input = window.locator('textarea[placeholder*="Type a message"]');
	await expect(input).toBeVisible();
	await window.waitForTimeout(300);
	const groupChatProviderProcesses = await window.evaluate(async (groupChatId) => {
		const processes = await window.maestro.process.getActiveProcesses();
		return processes.filter(
			(process) => process.toolType === 'e2e-null-agent' || process.sessionId.includes(groupChatId)
		);
	}, GROUP_CHAT_ID);
	expect(groupChatProviderProcesses).toEqual([]);
	await input.focus();
	const draft = 'Synthetic manual typing probe';
	await input.pressSequentially(draft, { delay: 5 });
	await expect(input).toHaveValue(draft);
	const disabledSendError = await window.evaluate(async (groupChatId) => {
		try {
			await window.maestro.groupChat.sendToModerator(groupChatId, 'Synthetic blocked send');
			return null;
		} catch (error) {
			return String(error);
		}
	}, GROUP_CHAT_ID);
	expect(disabledSendError).toContain('provider processes are disabled');
	const groupChatProviderProcessesAfterBlockedSend = await window.evaluate(async (groupChatId) => {
		const processes = await window.maestro.process.getActiveProcesses();
		return processes.filter(
			(process) => process.toolType === 'e2e-null-agent' || process.sessionId.includes(groupChatId)
		);
	}, GROUP_CHAT_ID);
	expect(groupChatProviderProcessesAfterBlockedSend).toEqual([]);

	// Move through the real session store and reopen the chat. The draft is
	// intentionally hot renderer state, so this proves it survives navigation
	// without requiring a disk write for every keypress.
	await window.locator('[data-nav-key^="idx:"]').first().click();
	await expect(input).toBeHidden();
	await groupChatItem.click();
	await expect(input).toHaveValue(draft);

	const messageCountAfterTyping = await window.evaluate(
		async (groupChatId) => (await window.maestro.groupChat.getMessages(groupChatId)).length,
		GROUP_CHAT_ID
	);
	expect(messageCountAfterTyping).toBe(EXPECTED_COUNTS.messages);

	const manifest = JSON.parse(
		fs.readFileSync(path.join(testDataDir, 'group-chat-load-manifest.json'), 'utf8')
	);
	expect(manifest).toMatchObject({
		kind: 'synthetic-group-chat-load',
		providerProcessesEnabled: false,
		counts: EXPECTED_COUNTS,
	});
	expect(
		fs.readFileSync(path.join(testDataDir, 'group-chats', GROUP_CHAT_ID, 'history.jsonl'), 'utf8')
	).toBe('');
});
