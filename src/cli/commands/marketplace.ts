/**
 * `maestro-cli marketplace list|show|import|updates` - the Playbook Exchange,
 * for an agent: browse the official + local catalog, read a playbook's README,
 * install one into an agent's Auto Run folder, and see which installed ones
 * have an update (`import --update` applies it).
 *
 * Every call goes through the app's marketplace service over the WS bridge, so
 * the catalog cache, the version-compatibility gate, and the import (documents
 * plus assets, into `<Auto Run folder>/<folder>`) are the ones the modal uses.
 */

import { withMaestroClient } from '../services/maestro-client';
import { failCommand, failFromError, resolveAgentOrFail } from '../services/session-command';
import { generateDefaultFolderName } from '../../shared/marketplaceFolderName';
import {
	describeMarketplaceImportFailures,
	type MarketplaceImportPlaybookResult,
	type MarketplaceManifest,
	type MarketplacePlaybook,
} from '../../shared/marketplace-types';
import {
	isPlaybookBrowseSort,
	isPlaybookRecentlyBroken,
	PLAYBOOK_BROWSE_SORTS,
	selectMostPopularPlaybookIds,
	sortPlaybooksByHealth,
	type PlaybookHealthMap,
} from '../../shared/playbookHealth';
import {
	describePlaybookUpdate,
	type PlaybookUpdateStatus,
	type PlaybookUpdateStatusMap,
} from '../../shared/playbookUpdates';

/** A cold catalog fetch goes to GitHub; an import downloads every document. */
const FETCH_TIMEOUT_MS = 60_000;
const IMPORT_TIMEOUT_MS = 180_000;

interface JsonOption {
	json?: boolean;
}

interface ListOptions extends JsonOption {
	category?: string;
	search?: string;
	refresh?: boolean;
	sort?: string;
}

interface ImportOptions extends JsonOption {
	agent: string;
	folder?: string;
	/** Update the record the agent already holds for the entry, in its own folder. */
	update?: boolean;
}

interface UpdatesOptions extends JsonOption {
	agent: string;
}

interface CatalogReply {
	manifest: MarketplaceManifest;
	/** Popularity and reliability figures by playbook id; empty when the server has none. */
	health: PlaybookHealthMap;
}

async function fetchCatalog(refresh: boolean): Promise<CatalogReply> {
	const reply = await withMaestroClient((client) =>
		client.sendCommand<{
			success: boolean;
			manifest?: MarketplaceManifest;
			health?: PlaybookHealthMap;
			error?: string;
		}>(
			{ type: 'marketplace_get_manifest', refresh },
			'marketplace_get_manifest_result',
			FETCH_TIMEOUT_MS
		)
	);
	if (!reply.success || !reply.manifest) {
		throw new Error(reply.error || 'Failed to load the Playbook Exchange catalog');
	}
	return { manifest: reply.manifest, health: reply.health ?? {} };
}

async function fetchManifest(refresh: boolean): Promise<MarketplaceManifest> {
	return (await fetchCatalog(refresh)).manifest;
}

/**
 * The badges the Exchange modal draws on a tile, as text: "Most popular" and
 * "Recently broken", from the same shared rules.
 */
export function playbookHealthLabels(
	id: string,
	health: PlaybookHealthMap,
	mostPopularIds: ReadonlySet<string>
): string[] {
	const labels: string[] = [];
	if (mostPopularIds.has(id)) labels.push('Most popular');
	if (isPlaybookRecentlyBroken(health[id])) labels.push('Recently broken');
	return labels;
}

/** Case-insensitive match on id, title, description, and tags. */
export function filterPlaybooks(
	playbooks: MarketplacePlaybook[],
	options: { category?: string; search?: string }
): MarketplacePlaybook[] {
	const category = options.category?.trim().toLowerCase();
	const needle = options.search?.trim().toLowerCase();
	return playbooks.filter((pb) => {
		if (category && pb.category.toLowerCase() !== category) return false;
		if (!needle) return true;
		return [pb.id, pb.title, pb.description, ...(pb.tags ?? [])].some((field) =>
			field.toLowerCase().includes(needle)
		);
	});
}

function findPlaybook(manifest: MarketplaceManifest, id: string): MarketplacePlaybook {
	const playbook = manifest.playbooks.find((pb) => pb.id === id);
	if (!playbook) {
		throw new Error(`No playbook "${id}" in the Playbook Exchange. Run \`marketplace list\`.`);
	}
	return playbook;
}

export async function marketplaceList(options: ListOptions): Promise<void> {
	const sort = options.sort ?? 'default';
	if (!isPlaybookBrowseSort(sort)) {
		failCommand(
			`Unknown --sort "${sort}". Use one of: ${PLAYBOOK_BROWSE_SORTS.join(', ')}.`,
			options.json
		);
	}
	let playbooks: MarketplacePlaybook[];
	let health: PlaybookHealthMap;
	let mostPopularIds: Set<string>;
	try {
		const catalog = await fetchCatalog(options.refresh === true);
		health = catalog.health;
		// Ranked over the whole catalog, as the modal does, so a filter cannot
		// hand the badge to the most popular of a narrow match.
		mostPopularIds = selectMostPopularPlaybookIds(
			health,
			catalog.manifest.playbooks.map((pb) => pb.id)
		);
		playbooks = sortPlaybooksByHealth(
			filterPlaybooks(catalog.manifest.playbooks, options),
			sort,
			health
		);
	} catch (error) {
		failFromError(error, options.json);
	}
	if (options.json) {
		console.log(
			JSON.stringify(
				playbooks.map((pb) => ({
					...pb,
					health: health[pb.id] ?? null,
					badges: playbookHealthLabels(pb.id, health, mostPopularIds),
				})),
				null,
				2
			)
		);
		return;
	}
	if (playbooks.length === 0) {
		console.log('No playbooks match.');
		return;
	}
	for (const pb of playbooks) {
		const labels = playbookHealthLabels(pb.id, health, mostPopularIds);
		const badgeText = labels.length > 0 ? `  [${labels.join(', ')}]` : '';
		console.log(
			`${pb.id}  (${pb.category}, ${pb.documents.length} docs, by ${pb.author})${badgeText}`
		);
		console.log(`    ${pb.title}: ${pb.description}`);
	}
}

export async function marketplaceShow(id: string, options: JsonOption): Promise<void> {
	let playbook: MarketplacePlaybook;
	let readme: string | null = null;
	try {
		playbook = findPlaybook(await fetchManifest(false), id);
		const reply = await withMaestroClient((client) =>
			client.sendCommand<{ success: boolean; content?: string | null; error?: string }>(
				{ type: 'marketplace_get_readme', playbookPath: playbook.path },
				'marketplace_get_readme_result',
				FETCH_TIMEOUT_MS
			)
		);
		if (!reply.success) throw new Error(reply.error || 'Failed to load the README');
		readme = reply.content ?? null;
	} catch (error) {
		failFromError(error, options.json);
	}
	if (options.json) {
		console.log(JSON.stringify({ ...playbook, readme }, null, 2));
		return;
	}
	console.log(`${playbook.title}  [${playbook.id}]`);
	console.log(
		`${playbook.category}${playbook.subcategory ? ` / ${playbook.subcategory}` : ''}, by ${playbook.author}, updated ${playbook.lastUpdated}`
	);
	console.log(playbook.description);
	console.log('');
	console.log('Documents:');
	for (const doc of playbook.documents) console.log(`  - ${doc.filename}`);
	if (readme) {
		console.log('');
		console.log(readme);
	}
}

export async function marketplaceImport(id: string, options: ImportOptions): Promise<void> {
	const sessionId = resolveAgentOrFail(options.agent, options.json);
	const update = options.update === true;
	if (update && options.folder) {
		failCommand(
			'--update re-fetches into the folder the playbook is installed in; drop --folder.',
			options.json
		);
	}
	let reply: MarketplaceImportPlaybookResult;
	let targetFolderName = options.folder?.trim();
	try {
		if (!targetFolderName && !update) {
			// Same default the modal proposes, so a CLI import and a click import
			// of the same playbook land in the same place.
			targetFolderName = generateDefaultFolderName(
				findPlaybook(await fetchManifest(false), id).title
			);
		}
		const folder = targetFolderName;
		reply = await withMaestroClient((client) =>
			client.sendCommand(
				{
					type: 'marketplace_import_playbook',
					sessionId,
					playbookId: id,
					...(update ? { update: true } : { targetFolderName: folder }),
				},
				'marketplace_import_playbook_result',
				IMPORT_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}
	if (!reply.success) failCommand(reply.error || 'Import failed', options.json);

	const docs = reply.importedDocs ?? [];
	// An update reports the folder the record already lived in.
	if (update) targetFolderName = reply.playbook?.provenance?.targetFolderName;
	// The import wrote a saved playbook record. Running that record (not the
	// bare documents) is what applies its parameters and ends with its report.
	const savedPlaybookId = reply.playbook?.id ?? null;
	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				sessionId,
				playbookId: savedPlaybookId,
				updated: update,
				folder: targetFolderName,
				importedDocs: docs,
				importedAssets: reply.importedAssets ?? [],
				failedDocs: reply.failedDocs ?? [],
				failedAssets: reply.failedAssets ?? [],
			})
		);
		return;
	}
	console.log(
		`${update ? 'Updated' : 'Imported'} ${id} ${update ? 'in' : 'into'} ${targetFolderName}/ on ${sessionId} (${docs.length} documents).`
	);
	const failures = describeMarketplaceImportFailures(reply);
	if (failures) console.error(`Warning: partial import. ${failures}`);
	if (savedPlaybookId) {
		console.log(`Saved as playbook ${savedPlaybookId}.`);
		console.log(`Run it with: maestro-cli playbook ${savedPlaybookId}`);
		console.log(`See its parameters with: maestro-cli playbook configure ${savedPlaybookId}`);
	} else {
		console.log(`Run it with: maestro-cli auto-run <docs...> -a ${sessionId}`);
	}
}

/** One line per installed playbook: the record, its Exchange entry, and its state. */
export function formatPlaybookUpdateLine(status: PlaybookUpdateStatus): string {
	return `${status.playbookId}  ${status.marketplaceId} in ${status.targetFolderName}/  [${status.state}]  ${describePlaybookUpdate(status)}`;
}

export async function marketplaceUpdates(options: UpdatesOptions): Promise<void> {
	const sessionId = resolveAgentOrFail(options.agent, options.json);
	let updates: PlaybookUpdateStatusMap;
	try {
		const reply = await withMaestroClient((client) =>
			client.sendCommand<{ success: boolean; updates?: PlaybookUpdateStatusMap; error?: string }>(
				{ type: 'marketplace_check_updates', sessionId },
				'marketplace_check_updates_result',
				FETCH_TIMEOUT_MS
			)
		);
		if (!reply.success) throw new Error(reply.error || 'Update check failed');
		updates = reply.updates ?? {};
	} catch (error) {
		failFromError(error, options.json);
	}
	const statuses = Object.values(updates).sort((a, b) => a.name.localeCompare(b.name));
	if (options.json) {
		console.log(JSON.stringify(statuses, null, 2));
		return;
	}
	if (statuses.length === 0) {
		console.log(`No Playbook Exchange playbooks are installed on ${sessionId}.`);
		return;
	}
	for (const status of statuses) console.log(formatPlaybookUpdateLine(status));
	if (statuses.some((status) => status.updateAvailable)) {
		console.log('');
		console.log(
			`Update one with: maestro-cli marketplace import <playbook-id> --update -a ${sessionId}`
		);
	}
}
