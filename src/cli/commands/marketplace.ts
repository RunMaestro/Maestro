/**
 * `maestro-cli marketplace list|show|import` - the Playbook Exchange, for an
 * agent: browse the official + local catalog, read a playbook's README, and
 * install one into an agent's Auto Run folder.
 *
 * Every call goes through the app's marketplace service over the WS bridge, so
 * the catalog cache, the version-compatibility gate, and the import (documents
 * plus assets, into `<Auto Run folder>/<folder>`) are the ones the modal uses.
 */

import { withMaestroClient } from '../services/maestro-client';
import { failCommand, resolveAgentOrFail } from '../services/session-command';
import { exitCodeForError, exitWith } from '../exit-codes';
import { generateDefaultFolderName } from '../../shared/marketplaceFolderName';
import type { MarketplaceManifest, MarketplacePlaybook } from '../../shared/marketplace-types';

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
}

interface ImportOptions extends JsonOption {
	agent: string;
	folder?: string;
}

function failFromError(error: unknown, json?: boolean): never {
	const message = error instanceof Error ? error.message : String(error);
	if (json) console.log(JSON.stringify({ success: false, error: message }));
	else console.error(`Error: ${message}`);
	return exitWith(exitCodeForError(error));
}

async function fetchManifest(refresh: boolean): Promise<MarketplaceManifest> {
	const reply = await withMaestroClient((client) =>
		client.sendCommand<{ success: boolean; manifest?: MarketplaceManifest; error?: string }>(
			{ type: 'marketplace_get_manifest', refresh },
			'marketplace_get_manifest_result',
			FETCH_TIMEOUT_MS
		)
	);
	if (!reply.success || !reply.manifest) {
		throw new Error(reply.error || 'Failed to load the Playbook Exchange catalog');
	}
	return reply.manifest;
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
	let playbooks: MarketplacePlaybook[];
	try {
		playbooks = filterPlaybooks((await fetchManifest(options.refresh === true)).playbooks, options);
	} catch (error) {
		failFromError(error, options.json);
	}
	if (options.json) {
		console.log(JSON.stringify(playbooks, null, 2));
		return;
	}
	if (playbooks.length === 0) {
		console.log('No playbooks match.');
		return;
	}
	for (const pb of playbooks) {
		console.log(`${pb.id}  (${pb.category}, ${pb.documents.length} docs, by ${pb.author})`);
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
	let reply: {
		success: boolean;
		error?: string;
		importedDocs?: string[];
		importedAssets?: string[];
	};
	let targetFolderName = options.folder?.trim();
	try {
		if (!targetFolderName) {
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
					targetFolderName: folder,
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
	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				sessionId,
				folder: targetFolderName,
				importedDocs: docs,
				importedAssets: reply.importedAssets ?? [],
			})
		);
		return;
	}
	console.log(
		`Imported ${id} into ${targetFolderName}/ on ${sessionId} (${docs.length} documents).`
	);
	console.log(`Run it with: maestro-cli auto-run <docs...> -a ${sessionId}`);
}
