/**
 * The shared new-agent skeleton. The desktop treats an agent with no tabs of
 * any kind as corrupted on restore, so every record this builds must carry
 * exactly one AI tab that the active tab and the unified tab order agree on.
 */

import { describe, it, expect } from 'vitest';
import { buildNewAgentRecord, newAgentClaudeInteractive } from '../../shared/newAgentRecord';

function idSource() {
	let n = 0;
	return () => `id-${++n}`;
}

describe('buildNewAgentRecord', () => {
	it('starts with one idle AI tab that the active tab and the tab order point at', () => {
		const record = buildNewAgentRecord(
			{ id: 'agent-1', name: 'Alpha', toolType: 'codex', cwd: '/work/proj' },
			{ generateId: idSource(), now: 1000 }
		);
		expect(record.aiTabs).toHaveLength(1);
		const [tab] = record.aiTabs;
		expect(tab).toMatchObject({ agentSessionId: null, state: 'idle', createdAt: 1000 });
		expect(record.activeTabId).toBe(tab.id);
		expect(record.unifiedTabOrder).toEqual([{ type: 'ai', id: tab.id }]);
	});

	it('roots the agent, its shell and its Auto Run folder at cwd', () => {
		const record = buildNewAgentRecord(
			{ id: 'a', name: 'A', toolType: 'claude-code', cwd: '/work/proj' },
			{ generateId: idSource() }
		);
		expect(record).toMatchObject({
			id: 'a',
			cwd: '/work/proj',
			fullPath: '/work/proj',
			projectRoot: '/work/proj',
			shellCwd: '/work/proj',
			autoRunFolderPath: '/work/proj/.maestro/playbooks',
			inputMode: 'ai',
			fileTreeAutoRefreshInterval: 180,
			aiPid: 0,
		});
	});

	it('takes an explicit Auto Run folder, group and tab defaults', () => {
		const record = buildNewAgentRecord(
			{
				id: 'a',
				name: 'A',
				toolType: 'codex',
				cwd: '/p',
				autoRunFolderPath: '/p/docs/runs',
				groupId: 'g1',
				saveToHistory: false,
				showThinking: 'sticky',
			},
			{ generateId: idSource() }
		);
		expect(record.autoRunFolderPath).toBe('/p/docs/runs');
		expect(record.groupId).toBe('g1');
		expect(record.aiTabs[0]).toMatchObject({ saveToHistory: false, showThinking: 'sticky' });
	});

	it('leaves the tab defaults unset when the caller has none', () => {
		const record = buildNewAgentRecord(
			{ id: 'a', name: 'A', toolType: 'codex', cwd: '/p' },
			{ generateId: idSource() }
		);
		expect('saveToHistory' in record.aiTabs[0]).toBe(false);
		expect('showThinking' in record.aiTabs[0]).toBe(false);
	});

	it('opens a terminal agent in terminal mode', () => {
		const record = buildNewAgentRecord(
			{ id: 'a', name: 'A', toolType: 'terminal', cwd: '/p' },
			{ generateId: idSource() }
		);
		expect(record.inputMode).toBe('terminal');
	});
});

describe('newAgentClaudeInteractive', () => {
	it('starts Claude Code in automatic API mode and leaves other providers unset', () => {
		expect(newAgentClaudeInteractive('claude-code')).toEqual({ mode: 'api', modeReason: 'auto' });
		expect(newAgentClaudeInteractive('codex')).toBeUndefined();
	});
});
