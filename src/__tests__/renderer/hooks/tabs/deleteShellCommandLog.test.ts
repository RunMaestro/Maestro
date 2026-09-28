/**
 * Tests for deleteShellCommandLog - removing a command-mode card from a
 * transcript, and deciding whether its recall entry goes with it.
 *
 * The reducer is pure, so these cover the rule that actually has a judgement
 * call in it: cards are per tab, recall history is per agent and deduplicated,
 * so the entry may only be pruned once no card anywhere still shows it.
 */

import { describe, expect, test } from 'vitest';
import { deleteShellCommandLog } from '../../../../renderer/hooks/tabs/internal/deleteShellCommandLog';
import type { LogEntry, Session } from '../../../../renderer/types';

function card(id: string, command: string): LogEntry {
	return {
		id,
		timestamp: 0,
		source: 'stdout',
		text: 'output',
		shellCommand: { command, cwd: '/repo', status: 'finished', exitCode: 0 },
	};
}

function message(id: string, text: string): LogEntry {
	return { id, timestamp: 0, source: 'user', text };
}

function makeSessions(tabs: { id: string; logs: LogEntry[] }[], history: string[]): Session[] {
	return [
		{
			id: 'session-1',
			aiCommandHistory: history,
			aiTabs: tabs.map((t) => ({ id: t.id, logs: t.logs })),
		} as unknown as Session,
		{ id: 'session-2', aiCommandHistory: ['!ls'], aiTabs: [] } as unknown as Session,
	];
}

const target = { sessionId: 'session-1', tabId: 'tab-1', logId: 'c1', command: 'npm test' };

describe('deleteShellCommandLog', () => {
	test('removes only the targeted card', () => {
		const sessions = makeSessions(
			[{ id: 'tab-1', logs: [message('u1', 'hi'), card('c1', 'npm test'), card('c2', 'ls')] }],
			['!npm test']
		);

		const [session] = deleteShellCommandLog(sessions, target);

		expect(session.aiTabs[0].logs.map((l) => l.id)).toEqual(['u1', 'c2']);
	});

	test('prunes the bang-prefixed recall entry when nothing else shows it', () => {
		const sessions = makeSessions(
			[{ id: 'tab-1', logs: [card('c1', 'npm test')] }],
			['!npm test', '!ls']
		);

		const [session] = deleteShellCommandLog(sessions, target);

		expect(session.aiCommandHistory).toEqual(['!ls']);
	});

	test('keeps the recall entry while a sibling card still shows the command', () => {
		const sessions = makeSessions(
			[{ id: 'tab-1', logs: [card('c1', 'npm test'), card('c2', 'npm test')] }],
			['!npm test']
		);

		const [session] = deleteShellCommandLog(sessions, target);

		expect(session.aiCommandHistory).toEqual(['!npm test']);
	});

	test('sees survivors in other tabs of the same agent', () => {
		const sessions = makeSessions(
			[
				{ id: 'tab-1', logs: [card('c1', 'npm test')] },
				{ id: 'tab-2', logs: [card('c9', 'npm test')] },
			],
			['!npm test']
		);

		const [session] = deleteShellCommandLog(sessions, target);

		expect(session.aiTabs[0].logs).toEqual([]);
		expect(session.aiCommandHistory).toEqual(['!npm test']);
	});

	test('does not treat an agent message with the same text as a survivor', () => {
		// Only a command CARD keeps the recall entry alive; a chat message that
		// happens to read "npm test" is a different kind of thing entirely.
		const sessions = makeSessions(
			[{ id: 'tab-1', logs: [card('c1', 'npm test'), message('u1', 'npm test')] }],
			['!npm test']
		);

		const [session] = deleteShellCommandLog(sessions, target);

		expect(session.aiCommandHistory).toEqual([]);
	});

	test('leaves other agents completely alone', () => {
		const sessions = makeSessions([{ id: 'tab-1', logs: [card('c1', 'npm test')] }], ['!npm test']);

		const [, untouched] = deleteShellCommandLog(sessions, target);

		expect(untouched).toBe(sessions[1]);
	});

	test('tolerates an agent that has no recall history yet', () => {
		const sessions = [
			{ id: 'session-1', aiTabs: [{ id: 'tab-1', logs: [card('c1', 'npm test')] }] },
		] as unknown as Session[];

		const [session] = deleteShellCommandLog(sessions, target);

		expect(session.aiCommandHistory).toEqual([]);
		expect(session.aiTabs[0].logs).toEqual([]);
	});
});
