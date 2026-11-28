/**
 * T1: the History USER entry of a hosted turn names its tab as a local and an SSH entry do.
 *
 * A local or SSH tab is named on the desktop as its message is sent, and the exit listener reads
 * the name with `historyEntryTabName()`. A hosted tab is named by its client once the host took
 * the message, so the name can reach the host while the turn or its synopsis runs. The host's
 * synopsis reads the tab's name when it writes the entry, so the chip reads the tab's name and
 * not the session id ("00726F18") in all three modes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

import {
	CAPTURED_RECORDINGS,
	CAPTURED_CLAUDE_CODE_SESSION_ID,
} from '../main/process-manager/recordings/captured';
import {
	FAKE_AGENT_PATH,
	fakeTurnFromRecording,
	writeFakeTurn,
} from '../shared/maestro-lib/run/fakeAgent';
import { DEFAULT_TAB_DEFAULTS } from '../../shared/maestro-lib/agents/rules';
import type { ClientResult } from '../../shared/maestro-lib/client/types';
import { readHistory } from '../../shared/maestro-lib/store/read-history';
import { formatSessionId, historyEntryTabName } from '../../shared/maestro-lib/store/tab-display';
import { runAgentTurn } from '../../shared/maestro-lib/turns/run-agent-turn';
import {
	createMaestroRuntime,
	type MaestroRuntime,
	type RuntimeDeps,
} from '../../shared/maestro-lib/runtime';
import { AGENT_MODES, createModeSession, type AgentMode } from '../helpers/mockSession';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.parse('2026-10-04T12:00:00Z');
const BUNDLED_PROMPTS = path.resolve(__dirname, '../../prompts');
const TAB_NAME = 'Fix the login form';

function value<T>(result: ClientResult<T>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
	return result.value;
}

describe('the History entry of a turn names its tab (T1)', () => {
	let dir: string;
	let work: string;
	let recording: string;
	/** Runs once the synopsis turn has started: after the turn's own entry was built. */
	let duringSynopsis: (() => Promise<void>) | undefined;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-t1-'));
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-t1-work-'));
		recording = writeFakeTurn(
			work,
			fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-claude-code-normal'])
		);
		duringSynopsis = undefined;
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(work, { recursive: true, force: true });
	});

	async function startRuntime(): Promise<MaestroRuntime> {
		let turns = 0;
		const fakeProvider: RuntimeDeps['turns']['runAgentTurn'] = async (turn, options) => {
			turns += 1;
			// The second provider turn is the synopsis: the turn's own entry is already built.
			if (turns === 2 && duringSynopsis) await duringSynopsis();
			return runAgentTurn(
				{
					...turn,
					launch: {
						...turn.launch,
						command: process.execPath,
						args: [FAKE_AGENT_PATH, ...turn.launch.args],
						sessionCustomEnvVars: {
							...turn.launch.sessionCustomEnvVars,
							FAKE_AGENT_RECORDING: recording,
						},
					},
				},
				{ ...options, stopGraceMs: 200 }
			);
		};
		let id = 0;
		let now = 1_000;
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			JSON.stringify(
				{
					sessions: [
						{
							id: 'a1',
							name: 'Hosted',
							toolType: 'claude-code',
							cwd: work,
							projectRoot: work,
							aiTabs: [{ id: 't1', agentSessionId: null, name: null, logs: [] }],
							activeTabId: 't1',
							unifiedTabOrder: [{ type: 'ai', id: 't1' }],
						},
					],
					activeSessionId: 'a1',
				},
				null,
				'\t'
			)
		);
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'tui',
			deps: {
				pid: 100,
				now: () => T0,
				bootTime: () => T0 - 3_600_000,
				isPidAlive: (pid) => pid === 100,
				hostname: () => 'testhost',
				rules: { newId: () => `id-${++id}`, now: () => ++now, random: () => 0 },
				checkCwd: () => null,
				readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
				watchDirectory: () => ({ close: () => undefined }),
				probeBinary: async () => ({ exists: true, path: '/fake/bin/claude' }),
				turns: { runAgentTurn: fakeProvider },
			},
			turns: { bundledPromptsDir: BUNDLED_PROMPTS },
		});
		if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
		return started.runtime;
	}

	/** The chip a History entry of the turn draws, in one agent mode. */
	async function chipOf(mode: AgentMode): Promise<string | undefined> {
		if (mode !== 'hosted') {
			// The desktop names the tab as the message is sent and reads it at exit.
			const session = createModeSession(mode);
			const tab = { ...session.aiTabs[0], name: TAB_NAME };
			return historyEntryTabName(tab, CAPTURED_CLAUDE_CODE_SESSION_ID);
		}
		const runtime = await startRuntime();
		try {
			// The client's auto name lands on the host while the synopsis runs.
			duringSynopsis = async () => {
				value(await runtime.tabs.rename('a1', 't1', TAB_NAME));
			};
			value(await runtime.turns.send('a1', 't1', { text: 'fix the login form' }));
			let entries: Array<{ sessionName?: string }> = [];
			await vi.waitFor(
				() => {
					const history = readHistory(runtime.paths, 'a1');
					entries = history.status === 'ok' ? history.entries : [];
					expect(entries).toHaveLength(1);
				},
				{ timeout: 8_000 }
			);
			return entries[0].sessionName;
		} finally {
			await runtime.connection.close();
		}
	}

	it('reads the tab name, not the session id, in all three modes', async () => {
		const chips: Array<string | undefined> = [];
		for (const mode of AGENT_MODES) chips.push(await chipOf(mode));
		expect(chips).toEqual([TAB_NAME, TAB_NAME, TAB_NAME]);
		expect(chips[2]).not.toBe(formatSessionId(CAPTURED_CLAUDE_CODE_SESSION_ID));
	});

	it('an unnamed tab records the short session id in every mode', () => {
		expect(historyEntryTabName({ name: null }, CAPTURED_CLAUDE_CODE_SESSION_ID)).toBe(
			formatSessionId(CAPTURED_CLAUDE_CODE_SESSION_ID)
		);
		expect(historyEntryTabName({ name: '' }, undefined)).toBeUndefined();
		expect(historyEntryTabName(undefined, null)).toBeUndefined();
	});
});
