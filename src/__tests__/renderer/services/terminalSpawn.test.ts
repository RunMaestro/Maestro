/**
 * Tests for terminalSpawn - the shared PTY spawn.
 *
 * The bug this module exists to fix: a terminal tab only ever got a shell if
 * `TerminalView` rendered it, so `open-terminal --background` produced a tab
 * with no PTY, `send-terminal` answered "has no running shell yet", and the only
 * cure was clicking the tab. The spawn had to move off the view lifecycle.
 *
 * The guard is the sharp edge. It must key on the composed process id, because
 * tab ids are only unique within an agent - keying on the bare tab id makes two
 * different agents' terminals dedupe each other and the second silently never
 * starts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const spawnTerminalTab = vi.fn();
const write = vi.fn().mockResolvedValue(undefined);

vi.stubGlobal('window', {
	maestro: { process: { spawnTerminalTab, write } },
});

import { spawnPtyForTab, isSpawnInFlight } from '../../../renderer/services/terminalSpawn';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { Session, TerminalTab } from '../../../renderer/types';

function session(overrides: Partial<Session> = {}): Session {
	return { id: 'sess-1', cwd: '/repo', projectRoot: '/repo', ...overrides } as Session;
}

function tab(overrides: Partial<TerminalTab> = {}): TerminalTab {
	return { id: 'tab-1', state: 'idle', pid: 0, ...overrides } as TerminalTab;
}

let onPid: (tabId: string, pid: number) => void;
let onSpawnFailure: (tabId: string, isPersistent: boolean, message: string) => void;

beforeEach(() => {
	vi.clearAllMocks();
	onPid = vi.fn();
	onSpawnFailure = vi.fn();
	spawnTerminalTab.mockResolvedValue({ success: true, pid: 4242 });
	useSettingsStore.setState({ defaultShell: 'zsh', shellArgs: '', shellEnvVars: {} });
});

describe('spawnPtyForTab', () => {
	it('spawns without any rendered terminal and reports the pid', async () => {
		await spawnPtyForTab({ session: session(), tab: tab(), onPid, onSpawnFailure });

		expect(spawnTerminalTab).toHaveBeenCalledTimes(1);
		expect(spawnTerminalTab.mock.calls[0][0]).toMatchObject({
			sessionId: 'sess-1-terminal-tab-1',
			cwd: '/repo',
			shell: 'zsh',
		});
		expect(onPid).toHaveBeenCalledWith('tab-1', 4242);
		expect(onSpawnFailure).not.toHaveBeenCalled();
	});

	it('runs a startup command once the shell is up', async () => {
		await spawnPtyForTab({
			session: session(),
			tab: tab({ startupCommand: 'npm run dev' }),
			onPid,
			onSpawnFailure,
		});

		expect(write).toHaveBeenCalledWith('sess-1-terminal-tab-1', 'npm run dev\n');
	});

	it('collapses concurrent spawns for the same tab into one', async () => {
		let release: (v: unknown) => void = () => {};
		spawnTerminalTab.mockReturnValue(new Promise((r) => (release = r)));

		const a = spawnPtyForTab({ session: session(), tab: tab(), onPid, onSpawnFailure });
		expect(isSpawnInFlight('sess-1', 'tab-1')).toBe(true);
		const b = spawnPtyForTab({ session: session(), tab: tab(), onPid, onSpawnFailure });

		release({ success: true, pid: 1 });
		await Promise.all([a, b]);

		// Two callers, one PTY. Without this a background spawn racing a user click
		// starts two shells and orphans one with no error anywhere.
		expect(spawnTerminalTab).toHaveBeenCalledTimes(1);
		expect(isSpawnInFlight('sess-1', 'tab-1')).toBe(false);
	});

	// The guard keys on `${sessionId}-terminal-${tabId}`, not the bare tab id.
	// Two agents can each own a tab called 'tab-1'; deduping those against each
	// other would leave the second agent's terminal permanently dead.
	it('does not dedupe the same tab id across two different agents', async () => {
		let release: (v: unknown) => void = () => {};
		spawnTerminalTab.mockReturnValue(new Promise((r) => (release = r)));

		const a = spawnPtyForTab({
			session: session({ id: 'sess-1' }),
			tab: tab(),
			onPid,
			onSpawnFailure,
		});
		const b = spawnPtyForTab({
			session: session({ id: 'sess-2' }),
			tab: tab(),
			onPid,
			onSpawnFailure,
		});

		release({ success: true, pid: 1 });
		await Promise.all([a, b]);

		expect(spawnTerminalTab).toHaveBeenCalledTimes(2);
		const ids = spawnTerminalTab.mock.calls.map((c) => c[0].sessionId).sort();
		expect(ids).toEqual(['sess-1-terminal-tab-1', 'sess-2-terminal-tab-1']);
	});

	it('reports a failed spawn as non-persistent for a scratch tab', async () => {
		spawnTerminalTab.mockResolvedValue({ success: false });

		await spawnPtyForTab({ session: session(), tab: tab(), onPid, onSpawnFailure });

		expect(onSpawnFailure).toHaveBeenCalledWith('tab-1', false, expect.stringContaining('shell'));
		expect(onPid).not.toHaveBeenCalled();
	});

	it('treats a startup-command tab as persistent so it is kept, not closed', async () => {
		spawnTerminalTab.mockResolvedValue({ success: false });

		await spawnPtyForTab({
			session: session(),
			tab: tab({ startupCommand: 'npm run dev' }),
			onPid,
			onSpawnFailure,
		});

		expect(onSpawnFailure).toHaveBeenCalledWith('tab-1', true, expect.any(String));
	});

	it('treats an SSH session tab as persistent and names SSH in the message', async () => {
		spawnTerminalTab.mockResolvedValue({ success: false });

		await spawnPtyForTab({
			session: session({ sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } as never }),
			tab: tab(),
			onPid,
			onSpawnFailure,
		});

		expect(onSpawnFailure).toHaveBeenCalledWith('tab-1', true, expect.stringContaining('SSH'));
	});

	it('releases the in-flight guard when the spawn throws', async () => {
		spawnTerminalTab.mockRejectedValue(new Error('boom'));

		await spawnPtyForTab({ session: session(), tab: tab(), onPid, onSpawnFailure });

		expect(onSpawnFailure).toHaveBeenCalledWith('tab-1', false, 'boom');
		// A stuck guard would make the tab unspawnable for the rest of the session.
		expect(isSpawnInFlight('sess-1', 'tab-1')).toBe(false);
	});
});
