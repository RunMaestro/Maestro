/**
 * Playbook update detection: the classification rules, finding an installed
 * record, and the line a pill or the CLI shows.
 */

import { describe, it, expect } from 'vitest';
import {
	classifyPlaybookUpdate,
	describePlaybookUpdate,
	findInstalledMarketplacePlaybook,
	findPlaybookUpdateStatus,
	marketplaceProvenanceOf,
	type PlaybookUpdateStatus,
} from '../../shared/playbookUpdates';
import type { PlaybookSourceProvenance } from '../../shared/types';

const HASHES = { 'phase-1': 'aaa', 'phase-2': 'bbb' };

function provenance(overrides: Partial<PlaybookSourceProvenance> = {}): PlaybookSourceProvenance {
	return {
		kind: 'marketplace',
		marketplaceId: 'dev-security',
		sourceVersion: '2026-08-01',
		sourceChannel: 'official',
		targetFolderName: 'Dev Security',
		importedAt: 1,
		documentHashes: HASHES,
		...overrides,
	};
}

function status(overrides: Partial<PlaybookUpdateStatus> = {}): PlaybookUpdateStatus {
	return {
		playbookId: 'record-1',
		marketplaceId: 'dev-security',
		name: 'Dev Security',
		targetFolderName: 'Dev Security',
		state: 'up-to-date',
		updateAvailable: false,
		installedVersion: '2026-08-01',
		latestVersion: '2026-08-01',
		modifiedDocuments: [],
		...overrides,
	};
}

describe('classifyPlaybookUpdate', () => {
	it('is up to date when the version matches and the pristine copies are untouched', () => {
		expect(
			classifyPlaybookUpdate({
				provenance: provenance(),
				latestVersion: '2026-08-01',
				pristineHashes: HASHES,
			})
		).toEqual({ state: 'up-to-date', updateAvailable: false, modifiedDocuments: [] });
	});

	it('offers an update when the manifest version differs, newer or older', () => {
		for (const latestVersion of ['2026-09-01', '2026-07-01']) {
			expect(
				classifyPlaybookUpdate({ provenance: provenance(), latestVersion, pristineHashes: HASHES })
			).toEqual({ state: 'update-available', updateAvailable: true, modifiedDocuments: [] });
		}
	});

	it('offers an update when the entry gained a version it did not have at import', () => {
		const result = classifyPlaybookUpdate({
			provenance: provenance({ sourceVersion: undefined }),
			latestVersion: '2026-09-01',
			pristineHashes: HASHES,
		});
		expect(result.state).toBe('update-available');
	});

	it('is up to date when the entry left the catalog', () => {
		expect(
			classifyPlaybookUpdate({
				provenance: provenance(),
				latestVersion: undefined,
				pristineHashes: HASHES,
			}).state
		).toBe('up-to-date');
	});

	it('names each document whose pristine copy no longer matches the install hash', () => {
		expect(
			classifyPlaybookUpdate({
				provenance: provenance(),
				latestVersion: '2026-08-01',
				pristineHashes: { 'phase-1': 'aaa', 'phase-2': 'edited' },
			})
		).toEqual({
			state: 'locally-modified',
			updateAvailable: false,
			modifiedDocuments: ['phase-2'],
		});
	});

	it('reports locally-modified over update-available, and still offers the update', () => {
		expect(
			classifyPlaybookUpdate({
				provenance: provenance(),
				latestVersion: '2026-09-01',
				pristineHashes: { 'phase-1': 'edited', 'phase-2': 'bbb' },
			})
		).toEqual({
			state: 'locally-modified',
			updateAvailable: true,
			modifiedDocuments: ['phase-1'],
		});
	});

	it('does not count a missing or unreadable pristine copy as an edit', () => {
		expect(
			classifyPlaybookUpdate({
				provenance: provenance(),
				latestVersion: '2026-08-01',
				pristineHashes: { 'phase-1': null },
			}).state
		).toBe('up-to-date');
	});

	it('never compares the working documents, only the hashes it is given', () => {
		// A run checks boxes in the working copy; only pristine hashes come in.
		expect(
			classifyPlaybookUpdate({
				provenance: provenance({ documentHashes: {} }),
				latestVersion: '2026-08-01',
				pristineHashes: { 'phase-1': 'anything' },
			}).state
		).toBe('up-to-date');
	});
});

describe('marketplaceProvenanceOf', () => {
	it('returns the provenance of an Exchange install', () => {
		expect(marketplaceProvenanceOf({ provenance: provenance() })?.marketplaceId).toBe(
			'dev-security'
		);
	});

	it('returns null for a ZIP or local import, a record without provenance, or no id', () => {
		expect(marketplaceProvenanceOf({ provenance: provenance({ kind: 'zip' }) })).toBeNull();
		expect(marketplaceProvenanceOf({ provenance: provenance({ kind: 'local' }) })).toBeNull();
		expect(marketplaceProvenanceOf({})).toBeNull();
		expect(marketplaceProvenanceOf(null)).toBeNull();
		expect(marketplaceProvenanceOf({ provenance: provenance({ marketplaceId: '' }) })).toBeNull();
	});
});

describe('findInstalledMarketplacePlaybook', () => {
	const records = [
		{ id: 'zip', provenance: provenance({ kind: 'zip', marketplaceId: 'dev-security' }) },
		{ id: 'hand-made' },
		{ id: 'installed', provenance: provenance() },
	];

	it('finds the Exchange record for the entry, ignoring other import kinds', () => {
		expect(findInstalledMarketplacePlaybook(records, 'dev-security')?.id).toBe('installed');
	});

	it('returns undefined when the entry is not installed', () => {
		expect(findInstalledMarketplacePlaybook(records, 'other')).toBeUndefined();
	});
});

describe('findPlaybookUpdateStatus', () => {
	it('finds a status by Exchange id', () => {
		const statuses = { 'record-1': status() };
		expect(findPlaybookUpdateStatus(statuses, 'dev-security')?.playbookId).toBe('record-1');
		expect(findPlaybookUpdateStatus(statuses, 'other')).toBeUndefined();
		expect(findPlaybookUpdateStatus(undefined, 'dev-security')).toBeUndefined();
	});
});

describe('describePlaybookUpdate', () => {
	it('says an update is available, from which version to which', () => {
		const text = describePlaybookUpdate(
			status({ state: 'update-available', updateAvailable: true, latestVersion: '2026-09-01' })
		);
		expect(text).toContain('Update available (2026-08-01 -> 2026-09-01)');
		expect(text).toContain('keeps your parameter answers');
	});

	it('warns that an update replaces an edited source copy', () => {
		const text = describePlaybookUpdate(
			status({
				state: 'locally-modified',
				updateAvailable: true,
				latestVersion: '2026-09-01',
				modifiedDocuments: ['phase-2'],
			})
		);
		expect(text).toContain('Update available (2026-08-01 -> 2026-09-01)');
		expect(text).toContain('phase-2 was edited; updating replaces it');
	});

	it('names an edited copy on an up-to-date playbook without an arrow', () => {
		expect(
			describePlaybookUpdate(status({ state: 'locally-modified', modifiedDocuments: ['phase-1'] }))
		).toBe('Up to date (2026-08-01). The source copy of phase-1 was edited; updating replaces it.');
	});

	it('says up to date, with an unknown version when none was recorded', () => {
		expect(describePlaybookUpdate(status())).toBe('Up to date (2026-08-01).');
		expect(describePlaybookUpdate(status({ installedVersion: undefined }))).toBe(
			'Up to date (unknown version).'
		);
	});
});
