/**
 * Browser-tab logins survive an app restart (Design Mode feedback O4a).
 *
 * A login lives in the Electron session behind a browser tab's `partition`. It
 * outlives a restart only if
 *   1. the partition is persistent (`persist:`), so Electron keeps its cookies
 *      and storage on disk, and
 *   2. the restart hands the tab the SAME partition string, so Electron reopens
 *      the same on-disk session instead of an empty one.
 *
 * Each hop has its own tests: the save filter (`useDebouncedPersistence`), the
 * restore filter (`useSessionRestoration`) and the will-attach-webview gate
 * (`window-manager`). This file pins the rule itself across the pure functions
 * that make it true, so a change that quietly breaks it fails under a name that
 * says what was lost.
 */

import { describe, expect, it } from 'vitest';
import {
	isAllowedBrowserTabPartition,
	PERSISTENT_BROWSER_TAB_PARTITION_PATTERN,
} from '../../../shared/browserTabPartition';
import { createBrowserTab } from '../../../renderer/hooks/tabs/internal/browserTabHelpers';
import {
	getBrowserTabPartition,
	isEphemeralBrowserTab,
	rehydrateBrowserTab,
	sanitizeBrowserTabForPersistence,
} from '../../../renderer/utils/browserTabPersistence';
import type { BrowserTab } from '../../../renderer/types';

// Agent ids as they really arrive: a GUID, a plain slug, and the odd shapes the
// key sanitizer has to survive (it must still yield a valid partition).
const AGENT_IDS = ['42295ed3-5354-4042-bfac-fb26a59b0d3c', 'session-1', ' spaced / odd:id ', ''];

const PAGE_URL = 'https://example.com/app';

// What a caller can pass for `createBrowserTab`'s options without asking for incognito.
// A plain "new tab" click forwards `ephemeral: options?.ephemeral`, i.e. undefined.
const NOT_INCOGNITO: Array<[string, { ephemeral?: boolean } | undefined]> = [
	['no options', undefined],
	['empty options', {}],
	['ephemeral undefined', { ephemeral: undefined }],
	['ephemeral false', { ephemeral: false }],
];

// Partition values a saved store can hold that are NOT a valid persistent partition.
const DAMAGED_PARTITIONS: Array<[string, string | undefined]> = [
	['a missing partition', undefined],
	['a blank partition', ''],
	['a whitespace partition', '   '],
	['the default session', 'default'],
	['a foreign persist: partition', 'persist:evil'],
	['a persist: partition with no key', 'persist:maestro-browser-session-'],
	['a persist: partition with a bad key', 'persist:maestro-browser-session-has space'],
];

/** The tab's partition, failing loudly if a tab ever comes back without one. */
function partitionOf(tab: BrowserTab): string {
	if (typeof tab.partition !== 'string') throw new Error('browser tab has no partition');
	return tab.partition;
}

/**
 * What a quit and relaunch does to a tab: the save step shapes it, the store
 * writes it as JSON, the restore step reads it back and rehydrates it.
 */
function restart(tab: BrowserTab, agentId: string): BrowserTab {
	const onDisk: unknown = JSON.parse(
		JSON.stringify(sanitizeBrowserTabForPersistence(tab, agentId))
	);
	return rehydrateBrowserTab(onDisk as BrowserTab, agentId);
}

describe('browser tab logins across a restart', () => {
	describe('a tab opened the normal way', () => {
		it.each(AGENT_IDS)(
			'is on a persistent partition the main process accepts (agent id %j)',
			(agentId) => {
				const tab = createBrowserTab(agentId, PAGE_URL);
				const partition = partitionOf(tab);

				// `persist:` is what makes Electron keep the session on disk.
				expect(partition.startsWith('persist:')).toBe(true);
				expect(PERSISTENT_BROWSER_TAB_PARTITION_PATTERN.test(partition)).toBe(true);
				// The will-attach-webview gate agrees, so the tab can actually load.
				expect(isAllowedBrowserTabPartition(partition)).toBe(true);
				// Not incognito, so the save step keeps the tab.
				expect(tab.ephemeral).toBeUndefined();
				expect(isEphemeralBrowserTab(tab)).toBe(false);
			}
		);

		it.each(NOT_INCOGNITO)(
			'stays persistent with %s: incognito has to be asked for',
			(_name, options) => {
				const partition = partitionOf(createBrowserTab('agent-a', PAGE_URL, options));

				expect(partition.startsWith('persist:')).toBe(true);
			}
		);

		it('shares one partition across every tab of an agent, so a login in one tab covers the next', () => {
			const first = createBrowserTab('agent-a', 'https://one.example');
			const second = createBrowserTab('agent-a', 'https://two.example');

			expect(first.id).not.toBe(second.id);
			expect(partitionOf(first)).toBe(partitionOf(second));
			// A pure function of the agent id: nothing random, nothing per tab.
			expect(partitionOf(first)).toBe(getBrowserTabPartition('agent-a'));
		});
	});

	describe('a restart', () => {
		it.each(AGENT_IDS)(
			'hands the tab back the partition it had, on every restart (agent id %j)',
			(agentId) => {
				const minted = createBrowserTab(agentId, PAGE_URL);
				let tab = minted;

				for (let launch = 1; launch <= 3; launch++) {
					tab = restart(tab, agentId);
					expect(partitionOf(tab)).toBe(partitionOf(minted));
				}
			}
		);

		it('keeps the persistent partition already on the tab instead of deriving a new one', () => {
			// Restore derives a partition from the agent id only when the tab has
			// none, so the saved value (the one the login is stored under) wins.
			const saved = createBrowserTab('agent-old', PAGE_URL);

			expect(partitionOf(restart(saved, 'agent-new'))).toBe(partitionOf(saved));
			expect(partitionOf(restart(saved, 'agent-new'))).not.toBe(
				getBrowserTabPartition('agent-new')
			);
		});

		it.each(DAMAGED_PARTITIONS)(
			'gives a tab with %s the agent partition, the same one on every restart',
			(_name, damaged) => {
				const tab: BrowserTab = { ...createBrowserTab('agent-a', PAGE_URL), partition: damaged };

				const first = partitionOf(restart(tab, 'agent-a'));
				const second = partitionOf(restart(tab, 'agent-a'));

				// Never a fresh partition per restore: the repair is deterministic,
				// and it lands on a persistent partition the gate accepts.
				expect(first).toBe(getBrowserTabPartition('agent-a'));
				expect(second).toBe(first);
				expect(first.startsWith('persist:')).toBe(true);
				expect(isAllowedBrowserTabPartition(first)).toBe(true);
			}
		);
	});

	describe('incognito, the one exception', () => {
		it('is minted off the persistent partition and recognized so neither save nor restore keeps it', () => {
			const tab = createBrowserTab('agent-a', PAGE_URL, { ephemeral: true });
			const partition = partitionOf(tab);

			// In memory only: no `persist:` scheme, so Electron discards it at quit.
			expect(partition.startsWith('persist:')).toBe(false);
			expect(PERSISTENT_BROWSER_TAB_PARTITION_PATTERN.test(partition)).toBe(false);
			// It still loads: the main process allows the incognito shape too.
			expect(isAllowedBrowserTabPartition(partition)).toBe(true);
			// Both the save filter and the restore filter drop a tab on this
			// predicate (see the incognito cases in the useDebouncedPersistence
			// and useSessionRestoration tests), so it never comes back signed out
			// on a partition that no longer exists.
			expect(tab.ephemeral).toBe(true);
			expect(isEphemeralBrowserTab(tab)).toBe(true);
		});
	});
});
