/**
 * Tests for the settings file watcher factory.
 *
 * The behaviour that matters most here is self-write suppression: the app
 * writes maestro-settings.json on every settings change (one write per
 * keystroke for text settings like the Conductor Profile), and each of those
 * writes trips the same fs.watch the CLI does. Echoing them back to the
 * renderer as "external change" makes it reload settings asynchronously and
 * clobber whatever is being typed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FSWatcher, WatchEventType } from 'fs';
import type { BrowserWindow } from 'electron';

type WatchCallback = (eventType: WatchEventType, filename: string | null) => void;

// Every fs.watch registration, in order (settings dir + agent-configs dir).
let watcherCallbacks: WatchCallback[] = [];
const mockClose = vi.fn();

const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockWatch = vi.fn((...args: unknown[]) => {
	watcherCallbacks.push(args[1] as WatchCallback);
	return {
		close: mockClose,
		on: vi.fn(),
	} as unknown as FSWatcher;
});

vi.mock('fs', () => ({
	default: {
		existsSync: (...args: unknown[]) => mockExistsSync(...args),
		mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
		watch: (...args: unknown[]) => mockWatch(...args),
	},
	existsSync: (...args: unknown[]) => mockExistsSync(...args),
	mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
	watch: (...args: unknown[]) => mockWatch(...args),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('app-lifecycle/settings-watcher', () => {
	let send: ReturnType<typeof vi.fn>;
	// rc broadcasts the reload to EVERY open window rather than just the main
	// one, so the watcher takes an enumerator instead of a getMainWindow.
	let getBroadcastWindows: () => BrowserWindow[];

	/** Fire a change event for `filename` on every registered watcher. */
	function emitChange(filename: string) {
		for (const cb of watcherCallbacks) {
			cb('change', filename);
		}
	}

	async function startWatcher(
		hooks: {
			onSettingsChangedExternally?: () => void;
			onAgentConfigsChangedExternally?: () => void;
		} = {}
	) {
		const { createSettingsWatcher } = await import('../../../main/app-lifecycle/settings-watcher');
		const watcher = createSettingsWatcher({
			getBroadcastWindows,
			getSettingsPath: () => '/test/sync',
			getAgentConfigsPath: () => '/test/sync',
			...hooks,
		});
		watcher.start();
		return watcher;
	}

	beforeEach(async () => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		watcherCallbacks = [];
		send = vi.fn();
		const win = {
			isDestroyed: () => false,
			webContents: { send, isDestroyed: () => false },
		} as unknown as BrowserWindow;
		getBroadcastWindows = () => [win];
		mockExistsSync.mockReturnValue(true);

		const { resetInternalWriteTracking } = await import('../../../main/stores/write-tracker');
		resetInternalWriteTracking();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('notifies the renderer for an external settings change', async () => {
		await startWatcher();

		emitChange('maestro-settings.json');
		vi.advanceTimersByTime(400);

		expect(send).toHaveBeenCalledWith('settings:externalChange');
	});

	it('ignores unrelated files in the watched directory', async () => {
		await startWatcher();

		emitChange('maestro-sessions.json');
		vi.advanceTimersByTime(400);

		expect(send).not.toHaveBeenCalled();
	});

	it("does not notify the renderer for the app's own settings write", async () => {
		const { markInternalWrite } = await import('../../../main/stores/write-tracker');
		await startWatcher();

		markInternalWrite('maestro-settings.json');
		emitChange('maestro-settings.json');
		vi.advanceTimersByTime(400);

		expect(send).not.toHaveBeenCalled();
	});

	it('suppresses a burst of self-writes (typing in a text setting)', async () => {
		const { markInternalWrite } = await import('../../../main/stores/write-tracker');
		await startWatcher();

		for (let i = 0; i < 20; i++) {
			markInternalWrite('maestro-settings.json');
			emitChange('maestro-settings.json');
			vi.advanceTimersByTime(120); // ~8 keystrokes/sec
		}
		vi.advanceTimersByTime(400);

		expect(send).not.toHaveBeenCalled();
	});

	it('resumes notifying once the self-write shadow has elapsed', async () => {
		const { markInternalWrite, INTERNAL_WRITE_SHADOW_MS } =
			await import('../../../main/stores/write-tracker');
		await startWatcher();

		markInternalWrite('maestro-settings.json');
		vi.advanceTimersByTime(INTERNAL_WRITE_SHADOW_MS + 1);

		emitChange('maestro-settings.json');
		vi.advanceTimersByTime(400);

		expect(send).toHaveBeenCalledWith('settings:externalChange');
	});

	it('tracks each watched file independently', async () => {
		const { markInternalWrite } = await import('../../../main/stores/write-tracker');
		await startWatcher();

		// A settings write must not mask an external agent-config change.
		markInternalWrite('maestro-settings.json');
		emitChange('maestro-agent-configs.json');
		vi.advanceTimersByTime(400);

		expect(send).toHaveBeenCalledWith('settings:externalChange');
	});

	it('tells main-process consumers about an outside agent-config write, and only that file', async () => {
		// A provider custom path set by `maestro-cli settings agent set` must reach
		// the agent detector, which holds its own copy of the paths.
		const onAgentConfigsChangedExternally = vi.fn();
		const onSettingsChangedExternally = vi.fn();
		await startWatcher({ onAgentConfigsChangedExternally, onSettingsChangedExternally });

		emitChange('maestro-agent-configs.json');
		vi.advanceTimersByTime(400);

		expect(onAgentConfigsChangedExternally).toHaveBeenCalledTimes(1);
		expect(onSettingsChangedExternally).not.toHaveBeenCalled();
	});

	it("does not reload agent configs for the app's own write", async () => {
		const { markInternalWrite } = await import('../../../main/stores/write-tracker');
		const onAgentConfigsChangedExternally = vi.fn();
		await startWatcher({ onAgentConfigsChangedExternally });

		markInternalWrite('maestro-agent-configs.json');
		emitChange('maestro-agent-configs.json');
		vi.advanceTimersByTime(400);

		expect(onAgentConfigsChangedExternally).not.toHaveBeenCalled();
	});

	it('stops watching on stop()', async () => {
		const watcher = await startWatcher();

		watcher.stop();

		expect(mockClose).toHaveBeenCalled();
	});
});
