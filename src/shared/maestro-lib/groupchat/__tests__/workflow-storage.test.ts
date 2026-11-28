/**
 * @file workflow-storage.test.ts
 * @description A chat's workflow run file and its handoff artifacts, through the chat store.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createGroupChatStore, sanitizeGroupChatFileName, type GroupChatStore } from '../storage';
import { createRun } from '../workflow/state';

const plan = {
	runId: 'run-1',
	title: 'Ship it',
	createdAt: 1,
	stages: [{ id: 'a', name: 'A', agents: ['Alice'], mode: 'serial' as const, instruction: 'Do A' }],
};

describe('workflow storage', () => {
	let dir: string;
	let store: GroupChatStore;
	const chatId = 'chat-1';

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'group-chat-workflow-store-'));
		store = createGroupChatStore({ groupChatsDir: () => dir });
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	const artifact = (participantName: string, content = 'output') =>
		store.writeWorkflowArtifact({
			groupChatId: chatId,
			runId: 'run-1',
			stageId: 'a',
			participantName,
			content,
		});

	it('saves, reads, and removes a run', async () => {
		expect(await store.loadWorkflowRun(chatId)).toBeNull();
		const run = createRun(plan);
		await store.saveWorkflowRun(chatId, run);
		expect(await store.loadWorkflowRun(chatId)).toEqual(run);
		await store.saveWorkflowRun(chatId, null);
		expect(await store.loadWorkflowRun(chatId)).toBeNull();
	});

	it('reads a file that is not a run as none', async () => {
		await fs.mkdir(path.join(dir, chatId), { recursive: true });
		await fs.writeFile(path.join(dir, chatId, 'workflow-run.json'), '{not json');
		expect(await store.loadWorkflowRun(chatId)).toBeNull();
		await fs.writeFile(path.join(dir, chatId, 'workflow-run.json'), '{"plan": 3}');
		expect(await store.loadWorkflowRun(chatId)).toBeNull();
	});

	it('writes artifacts under the run and stage, with names every filesystem takes', async () => {
		const written = await artifact('Release/Bot: "one"');
		expect(path.dirname(written)).toBe(path.join(dir, chatId, 'workflow-runs', 'run-1', 'a'));
		expect(path.basename(written)).toMatch(/^Release-Bot- -one--[0-9a-f]{12}\.md$/);
		expect(await fs.readFile(written, 'utf-8')).toBe('output');
	});

	it('keeps two names that sanitize alike apart, and overwrites a repeat from one name', async () => {
		const first = await artifact('a/b');
		const second = await artifact('a:b');
		expect(first).not.toBe(second);
		expect(await artifact('a/b', 'again')).toBe(first);
		expect(await fs.readFile(first, 'utf-8')).toBe('again');
	});

	it('clears one run, or every run but the one kept, and a missing folder is not an error', async () => {
		await store.clearWorkflowArtifacts(chatId, { runId: 'missing' });
		await store.clearWorkflowArtifacts(chatId);
		await artifact('Alice');
		const other = path.join(dir, chatId, 'workflow-runs', 'run-2');
		await fs.mkdir(other, { recursive: true });

		await store.clearWorkflowArtifacts(chatId, { keepRunId: 'run-1' });
		await expect(fs.stat(other)).rejects.toThrow();
		await fs.stat(path.join(dir, chatId, 'workflow-runs', 'run-1'));

		await store.clearWorkflowArtifacts(chatId, { runId: 'run-1' });
		await expect(fs.stat(path.join(dir, chatId, 'workflow-runs', 'run-1'))).rejects.toThrow();
	});

	it('sanitizes reserved and trailing-dot names', () => {
		expect(sanitizeGroupChatFileName('con')).toBe('_con');
		expect(sanitizeGroupChatFileName('name. ')).toBe('name');
		expect(sanitizeGroupChatFileName('')).toBe('participant');
	});
});
