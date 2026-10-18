import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	agentsOf,
	aiTabsOf,
	groupsOf,
	readAgentConfigsStore,
	readGroupsStore,
	readMaestroStores,
	readSessionsStore,
	readSettingsStore,
	visibleAiTabsOf,
} from '../read-stores';

/** electron-store's on-disk format: tab-indented JSON, no trailing newline. */
function storeText(value: unknown): string {
	return JSON.stringify(value, undefined, '\t');
}

/**
 * A sessions file as a newer (rc) build writes it: the named fields plus keys
 * this build has never heard of, at the document, agent, tab, and log level.
 */
const RC_SESSIONS = {
	sessions: [
		{
			id: 'agent-1',
			name: 'Maestro',
			toolType: 'claude-code',
			groupId: 'group-1',
			state: 'idle',
			cwd: '/Users/someone/Projects/Maestro',
			projectRoot: '/Users/someone/Projects/Maestro',
			rcOnlyAgentField: { nested: [1, 2, { deep: true }] },
			aiTabs: [
				{
					id: 'tab-1',
					agentSessionId: null,
					name: null,
					starred: false,
					logs: [{ id: 'log-1', timestamp: 1, source: 'user', text: 'hi', rcLogField: 'x' }],
					rcOnlyTabField: 'keep me',
				},
				{ id: 'tab-2', hidden: true, consultOrigin: { sourceSessionId: 'a', sourceTabId: 'b' } },
			],
			activeTabId: 'tab-1',
			unifiedTabOrder: [{ type: 'ai', id: 'tab-1' }],
		},
		{ id: 'agent-2', name: 'Unknown provider', toolType: 'provider-from-the-future' },
	],
	activeSessionId: 'agent-1',
	rcOnlyDocumentField: 42,
};

describe('store readers', () => {
	let tempDir: string;

	function write(name: string, content: string): string {
		const file = path.join(tempDir, name);
		fs.writeFileSync(file, content);
		return file;
	}

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-lib-store-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('round-trips rc-only fields byte for byte through read then JSON.stringify', () => {
		const original = storeText(RC_SESSIONS);
		const file = write('maestro-sessions.json', original);

		const result = readSessionsStore(file);
		expect(result.status).toBe('ok');
		if (result.status !== 'ok') return;
		expect(storeText(result.data)).toBe(original);
	});

	it('hands back the original objects, so unknown keys survive on every record', () => {
		const file = write('maestro-sessions.json', storeText(RC_SESSIONS));
		const result = readSessionsStore(file);
		if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);

		const agents = agentsOf(result.data);
		expect(agents.map((a) => a.id)).toEqual(['agent-1', 'agent-2']);
		expect(agents[0]).toBe(result.data.sessions?.[0]);
		expect(agents[0].rcOnlyAgentField).toEqual({ nested: [1, 2, { deep: true }] });
		expect(agents[1].toolType).toBe('provider-from-the-future');

		const tabs = aiTabsOf(agents[0]);
		expect(tabs.map((t) => t.id)).toEqual(['tab-1', 'tab-2']);
		expect(tabs[0].rcOnlyTabField).toBe('keep me');
		expect(aiTabsOf(agents[1])).toEqual([]);
	});

	it('skips unaddressable entries without removing them from the document', () => {
		const file = write(
			'maestro-sessions.json',
			storeText({ sessions: [{ id: 'ok', name: 'A', toolType: 'codex' }, { name: 'no id' }, 7] })
		);
		const result = readSessionsStore(file);
		if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
		expect(agentsOf(result.data).map((a) => a.id)).toEqual(['ok']);
		expect(result.data.sessions).toHaveLength(3);
	});

	it('reports a torn file as corrupt, never throws, and leaves the bytes in place', () => {
		const torn = '{\n\t"sessions": [\n\t\t{ "id": "agent-1", "name": "Mae';
		const file = write('maestro-sessions.json', torn);
		const before = fs.statSync(file).mtimeMs;

		const result = readSessionsStore(file);
		expect(result.status).toBe('corrupt');
		if (result.status === 'corrupt') {
			expect(result.file).toBe(file);
			expect(result.reason).toMatch(/JSON/i);
		}

		expect(fs.readFileSync(file, 'utf-8')).toBe(torn);
		expect(fs.statSync(file).mtimeMs).toBe(before);
		// No quarantine sidecar: only the desktop may move a store file.
		expect(fs.readdirSync(tempDir)).toEqual(['maestro-sessions.json']);
	});

	it('reports JSON of the wrong shape as corrupt', () => {
		expect(readSessionsStore(write('a.json', '[]')).status).toBe('corrupt');
		expect(readSessionsStore(write('b.json', '{"sessions": {}}')).status).toBe('corrupt');
		expect(readGroupsStore(write('c.json', '{"groups": "nope"}')).status).toBe('corrupt');
		expect(readAgentConfigsStore(write('d.json', '{"configs": []}')).status).toBe('corrupt');
		expect(readSettingsStore(write('e.json', 'null')).status).toBe('corrupt');
	});

	it('reports a missing file as missing', () => {
		expect(readSessionsStore(path.join(tempDir, 'absent.json'))).toEqual({
			status: 'missing',
			file: path.join(tempDir, 'absent.json'),
		});
	});

	it('reports a failed read as unreadable rather than throwing', () => {
		const dirInTheWay = path.join(tempDir, 'maestro-groups.json');
		fs.mkdirSync(dirInTheWay);
		const result = readGroupsStore(dirInTheWay);
		expect(result.status).toBe('unreadable');
	});

	it('tolerates a byte order mark', () => {
		const file = write('maestro-groups.json', `\uFEFF${storeText({ groups: [] })}`);
		expect(readGroupsStore(file).status).toBe('ok');
	});

	it('reads groups in stored order and keeps their collapse state', () => {
		const file = write(
			'maestro-groups.json',
			storeText({
				groups: [
					{ id: 'g1', name: 'Work', emoji: '💼', collapsed: true, rcOnly: 1 },
					{ id: 'g2', name: 'Play', emoji: '🎲', collapsed: false },
					{ name: 'no id' },
				],
			})
		);
		const result = readGroupsStore(file);
		if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
		const groups = groupsOf(result.data);
		expect(groups.map((g) => [g.id, g.collapsed])).toEqual([
			['g1', true],
			['g2', false],
		]);
		expect(groups[0].rcOnly).toBe(1);
	});

	it('reads every store independently, so one corrupt file hides nothing else', () => {
		const sessionsFile = write('maestro-sessions.json', storeText(RC_SESSIONS));
		const groupsFile = write('maestro-groups.json', storeText({ groups: [] }));
		const settingsFile = write('maestro-settings.json', '{ torn');
		const agentConfigsFile = write(
			'maestro-agent-configs.json',
			storeText({ configs: { codex: { customPath: '/opt/codex' } } })
		);

		const stores = readMaestroStores({ sessionsFile, groupsFile, settingsFile, agentConfigsFile });
		expect(stores.sessions.status).toBe('ok');
		expect(stores.groups.status).toBe('ok');
		expect(stores.settings.status).toBe('corrupt');
		expect(stores.agentConfigs.status).toBe('ok');
		if (stores.agentConfigs.status === 'ok') {
			expect(stores.agentConfigs.data.configs?.codex.customPath).toBe('/opt/codex');
		}
	});

	describe('visibleAiTabsOf', () => {
		const agent = (extra: Record<string, unknown>) => ({
			id: 'a',
			name: 'A',
			toolType: 'codex',
			...extra,
		});

		it('leaves hidden consult tabs out and keeps stored order without a tab order', () => {
			const tabs = visibleAiTabsOf(
				agent({ aiTabs: [{ id: 't1' }, { id: 'consult', hidden: true }, { id: 't2' }] })
			);
			expect(tabs.map((t) => t.id)).toEqual(['t1', 't2']);
		});

		it('follows the ai entries of unifiedTabOrder and appends tabs the order omits', () => {
			const tabs = visibleAiTabsOf(
				agent({
					aiTabs: [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
					unifiedTabOrder: [
						{ type: 'file', id: 'f1' },
						{ type: 'ai', id: 't3' },
						{ type: 'ai', id: 'gone' },
						{ type: 'ai', id: 't1' },
					],
				})
			);
			expect(tabs.map((t) => t.id)).toEqual(['t3', 't1', 't2']);
		});

		it('returns no tabs for an agent without any', () => {
			expect(visibleAiTabsOf(agent({}))).toEqual([]);
		});
	});
});
