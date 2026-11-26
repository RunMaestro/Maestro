/**
 * T5: a Move Back while the host was down leaves the host's copy behind. The next Move to Host of
 * the SAME agent replaces that copy, with a line in the plan, and keeps what was said there; a
 * different agent with the same name is still refused. The host here is a real headless runtime
 * (`maestro-cli host`), reached through the client a lift uses.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SshRemoteConfig } from '../../shared/types';
import { DEFAULT_TAB_DEFAULTS } from '../../shared/maestro-lib/agents/rules';
import type { ClientResult } from '../../shared/maestro-lib/client/types';
import { createMaestroRuntime, type MaestroRuntime } from '../../shared/maestro-lib/runtime';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import {
	formatLiftPlan,
	runLift,
	type LiftRunDeps,
} from '../../shared/maestro-lib/agents/lift-run';
import type { LiftPlan } from '../../shared/maestro-lib/agents/lift-plan';
import { withReturnedFromHost } from '../../shared/maestro-lib/agents/lift-return-record';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const PEER = 'build-box';

const remote = {
	id: 'remote-1',
	name: PEER,
	host: 'build-box',
	port: 22,
	username: 'me',
	privateKeyPath: '',
	enabled: true,
	federation: true,
} as unknown as SshRemoteConfig;

function value<T>(result: ClientResult<T>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
	return result.value;
}

const line = (id: string, text: string) => ({ id, timestamp: 1, source: 'user', text });

describe('Move to Host after an offline Move Back (T5)', () => {
	let dir: string;
	let work: string;
	let host: MaestroRuntime;

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-t5-'));
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-t5-work-'));
		// The host still holds the copy the first lift made ("host-1"), with a tab opened there.
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			JSON.stringify({
				sessions: [
					{
						id: 'host-1',
						name: 'Docs',
						toolType: 'claude-code',
						cwd: work,
						projectRoot: work,
						aiTabs: [
							{ id: 'tab-1', agentSessionId: null, name: 'Main', logs: [line('h1', 'hi')] },
							{
								id: 'tab-h',
								agentSessionId: null,
								name: 'Opened on the host',
								logs: [line('h2', 'said on the host')],
							},
						],
						activeTabId: 'tab-1',
						unifiedTabOrder: [
							{ type: 'ai', id: 'tab-1' },
							{ type: 'ai', id: 'tab-h' },
						],
					},
				],
				activeSessionId: 'host-1',
			})
		);
		let id = 0;
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'tui',
			deps: {
				pid: 100,
				now: () => T0,
				bootTime: () => T0 - 3_600_000,
				isPidAlive: (pid) => pid === 100,
				hostname: () => 'testhost',
				rules: { newId: () => `new-${++id}`, now: () => T0, random: () => 0 },
				checkCwd: () => null,
				readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
				watchDirectory: () => ({ close: () => undefined }),
				probeBinary: async () => ({ exists: true, path: '/fake/bin/claude' }),
			},
		});
		if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
		host = started.runtime;
	});

	afterEach(async () => {
		await host.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(work, { recursive: true, force: true });
	});

	/** The local SSH agent, as an offline Move Back left it (or a different one, without it). */
	function localAgent(id: string, leftOnHost: boolean): AgentRecord {
		const record: AgentRecord = {
			id,
			name: 'Docs',
			toolType: 'claude-code',
			cwd: work,
			state: 'idle',
			sessionSshRemoteConfig: { enabled: true, remoteId: remote.id, workingDirOverride: work },
			aiTabs: [{ id: 'tab-1', name: 'Main', agentSessionId: null, logs: [line('h1', 'hi')] }],
			activeTabId: 'tab-1',
		} as AgentRecord;
		return leftOnHost
			? (withReturnedFromHost(record as unknown as Record<string, unknown>, {
					tabs: [],
					leftOnHost: { peer: PEER, agentId: 'host-1', at: 1 },
				}) as unknown as AgentRecord)
			: record;
	}

	function deps(agent: AgentRecord): LiftRunDeps {
		return {
			readAgents: () => [agent],
			readRemotes: () => [remote],
			providerEnvVars: () => undefined,
			busyReason: () => undefined,
			connect: async () => ({ peer: PEER, client: host, release: async () => undefined }),
			setPointer: async () => undefined,
			now: () => T0,
		};
	}

	it('replaces the copy it left there, says so in the plan, and keeps its tabs', async () => {
		let plan: LiftPlan | undefined;
		const result = await runLift('agent-1', {}, deps(localAgent('agent-1', true)), (shown) => {
			plan = shown;
		});
		expect(plan?.summary.replaces).toBe(`${PEER}:host-1`);
		expect(formatLiftPlan(plan!.summary, false)).toContain(
			`Replaces the copy an earlier Move Back left on the host (${PEER}:host-1)`
		);

		const agents = value(await host.agents.list());
		expect(agents.map((agent) => agent.name)).toEqual(['Docs']);
		expect(agents[0].id).not.toBe('host-1');
		expect(result.target).toBe(`${PEER}:${agents[0].id}`);
		// The tab opened on the host while this machine thought the agent was back moved with it.
		const tabs = value(await host.tabs.list(agents[0].id));
		expect(tabs.map((tab) => tab.id).sort()).toEqual(['tab-1', 'tab-h']);
		const said = value(await host.tabs.transcript(agents[0].id, 'tab-h'));
		expect(said.map((entry) => entry.text)).toContain('said on the host');
	});

	it('moves the stored selection onto the new record (T5 review)', async () => {
		await runLift('agent-1', {}, deps(localAgent('agent-1', true)));
		const [agent] = value(await host.agents.list());
		await vi.waitFor(() => {
			const stored = JSON.parse(fs.readFileSync(path.join(dir, 'maestro-sessions.json'), 'utf8'));
			expect(stored.activeSessionId).toBe(agent.id);
		});
	});

	it('keeps both sides of a tab both went on in (T5 review)', async () => {
		// This machine went on in tab-1 after the move back; the host's tab-1 holds an entry it lacks.
		const local = localAgent('agent-1', true);
		local.aiTabs = [
			{
				id: 'tab-1',
				name: 'Main',
				agentSessionId: null,
				logs: [line('l1', 'said here first'), line('l2', 'said here after the move back')],
			},
		] as AgentRecord['aiTabs'];
		await runLift('agent-1', {}, deps(local));
		const [agent] = value(await host.agents.list());
		const tabs = value(await host.tabs.list(agent.id));
		expect(tabs.map((tab) => tab.id).sort()).toEqual(['tab-1', 'tab-1-host', 'tab-h']);
		const here = value(await host.tabs.transcript(agent.id, 'tab-1'));
		expect(here.map((entry) => entry.text)).toEqual([
			'said here first',
			'said here after the move back',
		]);
		const there = value(await host.tabs.transcript(agent.id, 'tab-1-host'));
		expect(there.map((entry) => entry.text)).toEqual(['hi']);
	});

	it('keeps the new host copy when this machine cannot record the move (T5 review)', async () => {
		const failing = { ...deps(localAgent('agent-1', true)) };
		failing.setPointer = async () => {
			throw new Error('disk full');
		};
		await expect(runLift('agent-1', {}, failing)).rejects.toThrow(
			/is kept: it holds tabs from its earlier copy/
		);
		const agents = value(await host.agents.list());
		expect(agents).toHaveLength(1);
		const tabs = value(await host.tabs.list(agents[0].id));
		expect(tabs.map((tab) => tab.id)).toContain('tab-h');
	});

	it('still refuses a different agent that only shares the name', async () => {
		await expect(runLift('agent-2', {}, deps(localAgent('agent-2', false)))).rejects.toThrow(
			'An agent named "Docs" already exists'
		);
		expect(value(await host.agents.list()).map((agent) => agent.id)).toEqual(['host-1']);
	});
});
