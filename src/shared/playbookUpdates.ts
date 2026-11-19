/**
 * Update detection for playbooks installed from the Playbook Exchange.
 *
 * An installed record carries `provenance.sourceVersion` (the manifest entry's
 * `lastUpdated` at import) and `provenance.documentHashes` (sha256 of each
 * document as fetched). The check compares the version against the current
 * manifest and the hashes against the pristine copies under
 * `.maestro-playbook/source/`. The working documents are NOT compared: a run
 * checks their boxes, so they are expected to differ.
 *
 * Node-free, so the main-process check, the renderer pills, and the CLI share
 * one set of rules. The hashing and file reads live in
 * `checkMarketplacePlaybookUpdates()` in `src/main/services/marketplace-service.ts`.
 */

import type { Playbook, PlaybookSourceProvenance } from './types';

/**
 * `locally-modified` wins over `update-available`: it is the state the user
 * must know about before an update replaces the source copy they edited.
 * `updateAvailable` stays true beside it, so the update is still offered.
 */
export type PlaybookUpdateState = 'up-to-date' | 'update-available' | 'locally-modified';

export const PLAYBOOK_UPDATE_STATES: readonly PlaybookUpdateState[] = [
	'up-to-date',
	'update-available',
	'locally-modified',
];

/** One installed Exchange playbook, as the update check sees it. */
export interface PlaybookUpdateStatus {
	/** The saved playbook record's id (not the Exchange id). */
	playbookId: string;
	/** `provenance.marketplaceId`: the Exchange entry the record came from. */
	marketplaceId: string;
	/** The record's name, for a CLI line or a toast. */
	name: string;
	/** The folder under the Auto Run folder the documents live in. */
	targetFolderName: string;
	state: PlaybookUpdateState;
	/** The manifest has a version other than the installed one. */
	updateAvailable: boolean;
	/** `provenance.sourceVersion` (absent when the entry had none at import). */
	installedVersion?: string;
	/** The manifest entry's `lastUpdated` now (absent when the entry left the catalog). */
	latestVersion?: string;
	/** Documents whose pristine copy no longer matches the hash taken at import. */
	modifiedDocuments: string[];
}

/** Statuses by saved playbook record id. */
export type PlaybookUpdateStatusMap = Record<string, PlaybookUpdateStatus>;

export interface ClassifyPlaybookUpdateInput {
	provenance: Pick<PlaybookSourceProvenance, 'sourceVersion' | 'documentHashes'>;
	/** The manifest entry's `lastUpdated` now; `undefined` when the entry is gone. */
	latestVersion: string | undefined;
	/**
	 * sha256 hex of each pristine copy on disk now, by document name. `null`
	 * (or absent) when the copy is missing or unreadable: writing it is
	 * best-effort at import, so a missing copy is not an edit.
	 */
	pristineHashes: Record<string, string | null | undefined>;
}

export function classifyPlaybookUpdate(
	input: ClassifyPlaybookUpdateInput
): Pick<PlaybookUpdateStatus, 'state' | 'updateAvailable' | 'modifiedDocuments'> {
	const { provenance, latestVersion, pristineHashes } = input;
	// A version that differs either way counts: an author can roll an entry
	// back, and the date strings are not guaranteed to sort.
	const updateAvailable =
		typeof latestVersion === 'string' && latestVersion !== provenance.sourceVersion;
	const modifiedDocuments = Object.entries(provenance.documentHashes ?? {})
		.filter(([name, installHash]) => {
			const pristineHash = pristineHashes[name];
			return typeof pristineHash === 'string' && pristineHash !== installHash;
		})
		.map(([name]) => name);
	const state: PlaybookUpdateState =
		modifiedDocuments.length > 0
			? 'locally-modified'
			: updateAvailable
				? 'update-available'
				: 'up-to-date';
	return { state, updateAvailable, modifiedDocuments };
}

/** The provenance of a record installed from the Exchange, or `null`. */
export function marketplaceProvenanceOf(
	playbook: Pick<Playbook, 'provenance'> | null | undefined
): (PlaybookSourceProvenance & { marketplaceId: string }) | null {
	const provenance = playbook?.provenance;
	if (!provenance || provenance.kind !== 'marketplace') return null;
	if (typeof provenance.marketplaceId !== 'string' || provenance.marketplaceId === '') return null;
	return provenance as PlaybookSourceProvenance & { marketplaceId: string };
}

/**
 * The record an agent already holds for an Exchange entry. An import of an
 * entry that is already installed updates this record instead of adding a
 * second one over the same files.
 */
export function findInstalledMarketplacePlaybook<T extends Pick<Playbook, 'provenance'>>(
	playbooks: readonly T[],
	marketplaceId: string
): T | undefined {
	return playbooks.find(
		(playbook) => marketplaceProvenanceOf(playbook)?.marketplaceId === marketplaceId
	);
}

/** The status of the record installed from `marketplaceId`, if any. */
export function findPlaybookUpdateStatus(
	statuses: PlaybookUpdateStatusMap | undefined,
	marketplaceId: string
): PlaybookUpdateStatus | undefined {
	if (!statuses) return undefined;
	return Object.values(statuses).find((status) => status.marketplaceId === marketplaceId);
}

/**
 * The tooltip and CLI line for a status: what changed, and what an update
 * would replace.
 */
export function describePlaybookUpdate(status: PlaybookUpdateStatus): string {
	const installed = status.installedVersion ?? 'unknown version';
	const versions =
		status.updateAvailable && status.latestVersion !== undefined
			? `${installed} -> ${status.latestVersion}`
			: installed;
	const edited =
		status.modifiedDocuments.length > 0
			? ` The source copy of ${status.modifiedDocuments.join(', ')} was edited; updating replaces it.`
			: '';
	switch (status.state) {
		case 'update-available':
			return `Update available (${versions}). Updating re-fetches the documents, which resets their tasks, and keeps your parameter answers.`;
		case 'locally-modified':
			return status.updateAvailable
				? `Update available (${versions}).${edited}`
				: `Up to date (${versions}).${edited}`;
		default:
			return `Up to date (${versions}).`;
	}
}
