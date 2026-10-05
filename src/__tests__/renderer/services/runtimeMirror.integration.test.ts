/**
 * The renderer mirror against a REAL runtime and the real desktop binding (no mocked IPC bodies): a
 * window's agentOps commands go through the binding into a runtime on a temp data directory, and the
 * window's store ends up where the runtime's documents are. This is the contract check between the three
 * layers, and the place a revision, a stamp, or a hold that does not line up would show.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../main/storage/session-image-store', () => ({
	relocateSessionImages: async (sessions: unknown[]) => ({ sessions, relocated: 0 }),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../renderer/stores/notificationStore', async () => {
	const actual = await vi.importActual('../../../renderer/stores/notificationStore');
	return { ...actual, notifyToast: vi.fn() };
});
vi.mock('../../../renderer/services/libraryRuntime', () => ({
	isLibraryRuntimeHosting: vi.fn(() => true),
	loadLibraryRuntimeStatus: vi.fn(async () => ({ hosting: true })),
}));

import { DEFAULT_TAB_DEFAULTS } from '../../../shared/maestro-lib/agents/rules';
import { createMaestroRuntime, type MaestroRuntime } from '../../../shared/maestro-lib/runtime';
import {
	createDesktopBinding,
	type DesktopBinding,
	type DesktopRuntime,
} from '../../../main/library-runtime/desktop-binding';
import * as ops from '../../../renderer/services/agentOps';
import {
	buildRuntimeFold,
	markRuntimeMirrorLoaded,
	resetRuntimeMirror,
	seedRuntimeMirror,
	sendRuntimeFold,
	setRuntimeMirrorHost,
	startRuntimeEventStream,
} from '../../../renderer/services/runtimeMirror';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import type { Session } from '../../../renderer/types';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const confText = (doc: unknown) => JSON.stringify(doc, null, '\t');

const seedAgent = (id: string, name: string) => ({
	id,
	name,
	toolType: 'claude-code',
	cwd: `/work/${id}`,
	fullPath: `/work/${id}`,
	projectRoot: `/work/${id}`,
	inputMode: 'ai',
	aiTabs: [{ id: `${id}-t1`, agentSessionId: null, name: null, starred: false, logs: [] }],
	activeTabId: `${id}-t1`,
	unifiedTabOrder: [{ type: 'ai', id: `${id}-t1` }],
});

const store = () => useSessionStore.getState();

describe('the renderer mirror over a real runtime', () => {
	let dir: string;
	let runtime: MaestroRuntime;
	let desktop: DesktopRuntime['desktop'];
	let binding: DesktopBinding;
	let stopStream: () => void;

	beforeEach(async () => {
		resetRuntimeMirror();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-mirror-int-'));
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			confText({
				sessions: [seedAgent('a1', 'Alpha'), seedAgent('a2', 'Beta')],
				activeSessionId: 'a1',
			})
		);
		let id = 0;
		let now = 1_000;
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'desktop',
			deps: {
				pid: 100,
				now: () => T0,
				bootTime: () => T0 - 3_600_000,
				isPidAlive: () => true,
				hostname: () => 'testhost',
				rules: { newId: () => `id-${++id}`, now: () => ++now, random: () => 0 },
				checkCwd: () => null,
				readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
				watchDirectory: () => ({ close: () => undefined }),
			},
		});
		if (!started.ok) throw new Error(started.refusal.message);
		runtime = started.runtime;
		desktop = (runtime as DesktopRuntime).desktop;
		binding = createDesktopBinding(runtime as DesktopRuntime);

		(window as any).maestro = {
			libraryRuntime: {
				command: (request: any) => binding.command(request),
				fold: (fold: any) => binding.fold(fold),
				onEvent: (listener: any) => binding.onEvent(listener),
			},
			sessions: {
				getDeferredContent: vi.fn().mockRejectedValue(new Error('none')),
				setActiveSessionId: vi.fn(),
			},
		};
		setRuntimeMirrorHost({ restoreSession: async (s) => s });
		stopStream = startRuntimeEventStream();
		const snapshot = await binding.loadSnapshot();
		seedRuntimeMirror(snapshot);
		store().setSessions(snapshot.agents as unknown as Session[]);
		store().setGroups(snapshot.groups as any);
		markRuntimeMirrorLoaded();
		vi.mocked(notifyToast).mockClear();
	});

	afterEach(async () => {
		stopStream();
		binding.dispose();
		await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
		resetRuntimeMirror();
		(window as any).maestro = {};
	});

	const stored = () => desktop.documents().sessions.sessions as Array<Record<string, any>>;

	it('starts from the runtime snapshot', () => {
		expect(store().sessions.map((s) => s.name)).toEqual(['Alpha', 'Beta']);
	});

	it('renames an agent through the runtime and shows the runtime result, with no echo churn', async () => {
		const before = store().sessions[1];
		const result = await ops.renameAgent('a1', '  Renamed ');
		expect(result.ok).toBe(true);
		expect(store().sessions[0].name).toBe('Renamed');
		expect(stored()[0].name).toBe('Renamed');
		// The broadcast copy of the same revision is skipped: the other agent is untouched.
		await vi.waitFor(() => expect(store().sessions[1]).toBe(before));
	});

	it('shows the runtime message and changes nothing when a command is refused', async () => {
		const result = await ops.renameAgent('a1', 'Beta');
		expect(result.ok).toBe(false);
		expect(store().sessions[0].name).toBe('Alpha');
		expect(notifyToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Rename Failed' }));
	});

	it("creates an agent under the client ids and keeps the window's own copy of it", async () => {
		const local = {
			...seedAgent('mine', 'Mine'),
			fileExplorerScrollPos: 9,
			aiTabs: [
				{
					id: 'mine-tab',
					agentSessionId: null,
					name: null,
					starred: false,
					logs: [],
					inputValue: '',
					stagedImages: [],
				},
			],
		} as unknown as Session;
		const result = await ops.createAgent(
			{ id: 'mine', tabId: 'mine-tab', name: 'Mine', provider: 'claude-code', cwd: '/work/mine' },
			local
		);
		expect(result).toEqual({ ok: true, value: { agentId: 'mine' } });
		const added = store().sessions.find((s) => s.id === 'mine')!;
		expect((added as any).fileExplorerScrollPos).toBe(9);
		expect(added.aiTabs[0].id).toBe('mine-tab');
		expect(stored().map((a) => a.id)).toEqual(['a1', 'a2', 'mine']);
		expect(stored()[2].aiTabs[0].id).toBe('mine-tab');
	});

	it('creates, renames, restyles, and removes a group, and moves an agent in and out of it', async () => {
		const created = await ops.createGroup({ id: 'g1', name: 'team', emoji: 'F' });
		expect(created).toEqual({ ok: true, value: { groupId: 'g1' } });
		expect(store().groups).toMatchObject([{ id: 'g1', name: 'TEAM', collapsed: false }]);

		await ops.updateGroup('g1', { name: 'Squad', color: '#aabbcc' });
		expect(store().groups[0]).toMatchObject({ name: 'SQUAD', color: '#AABBCC' });

		await ops.moveAgentToGroup('a1', 'g1');
		expect(store().sessions[0].groupId).toBe('g1');
		expect(stored()[0].groupId).toBe('g1');

		await ops.removeGroup('g1');
		expect(store().groups).toEqual([]);
		expect(store().sessions[0].groupId).toBeUndefined();
		expect(stored()[0]).not.toHaveProperty('groupId');
	});

	it('bookmarks an agent', async () => {
		await ops.setAgentBookmarked('a2', true);
		expect(store().sessions[1].bookmarked).toBe(true);
		expect(stored()[1].bookmarked).toBe(true);
	});

	it('removes an agent in the runtime and from the store, and re-points the active agent', async () => {
		store().setActiveSessionId('a1');
		const result = await ops.removeAgent('a1');
		expect(result.ok).toBe(true);
		expect(store().sessions.map((s) => s.id)).toEqual(['a2']);
		expect(store().activeSessionId).toBe('a2');
		expect(stored().map((a) => a.id)).toEqual(['a2']);
	});

	it('shows a change another client made through the runtime directly', async () => {
		await runtime.agents.rename('a2', 'From the TUI');
		await vi.waitFor(() => expect(store().sessions[1].name).toBe('From the TUI'));
		const created = await runtime.agents.create({
			name: 'Remote',
			provider: 'claude-code',
			cwd: '/work/remote',
		});
		expect(created.ok).toBe(true);
		await vi.waitFor(() => expect(store().sessions.map((s) => s.name)).toContain('Remote'));
	});

	it("folds this window's view state without moving a domain key, and drops a stale domain edit", async () => {
		// A remote rename lands first; this window then folds from a copy that has not seen it.
		const staleBefore = store().sessions[0];
		await runtime.agents.rename('a1', 'Newer');
		await vi.waitFor(() => expect(store().sessions[0].name).toBe('Newer'));
		const stale = { ...staleBefore, name: 'Stale local edit', inputMode: 'terminal' } as Session;
		// The mirror already moved to the newer revision, so a fold built from it names the new baseRev:
		// build the stale case by naming the revision the snapshot had (0: the agent had never changed).
		const fold = buildRuntimeFold({ sessions: [stale] });
		expect(fold.agents[0].baseRev).toBe(1);
		fold.agents[0].baseRev = 0;
		await sendRuntimeFold(fold);
		expect(stored()[0].name).toBe('Newer');
		expect(stored()[0].inputMode).toBe('terminal');
	});

	it('adopts an agent created by a site that is not a command yet, and tombstones one removed without a command', async () => {
		const adopted = { ...seedAgent('wiz', 'Wizard') } as unknown as Session;
		await sendRuntimeFold(buildRuntimeFold({ sessions: [adopted] }));
		expect(stored().map((a) => a.id)).toEqual(['a1', 'a2', 'wiz']);
		await vi.waitFor(() => expect(desktop.revisionOf('wiz')).toBeGreaterThan(0));

		// Remove it without a command, then try to bring it back with a stale copy.
		store().setSessions([...store().sessions, adopted]);
		await vi.waitFor(() => expect(store().sessions.some((s) => s.id === 'wiz')).toBe(true));
		await sendRuntimeFold({ agents: [], removeAgents: ['wiz'] });
		expect(stored().map((a) => a.id)).toEqual(['a1', 'a2']);
		await binding.foldLegacySessions([seedAgent('wiz', 'Wizard')]);
		expect(stored().map((a) => a.id)).toEqual(['a1', 'a2']);
	});
});
