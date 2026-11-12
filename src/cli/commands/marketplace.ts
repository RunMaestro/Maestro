/**
 * `maestro-cli marketplace list|show|import|launch|launches|launch-status` - the
 * Playbook Exchange, for an agent: browse the official + local catalog, read a
 * playbook's README, install one into an agent's Auto Run folder, or Launch one
 * (import with answers, run, clean up, outro).
 *
 * Every call goes through the app's marketplace service over the WS bridge, so
 * the catalog cache, the version-compatibility gate, the import (documents
 * plus assets, into `<Auto Run folder>/<folder>`) and the launch flow are the
 * ones the modal uses.
 */

import { withMaestroClient } from '../services/maestro-client';
import { failCommand, failFromError, resolveAgentOrFail } from '../services/session-command';
import { readSessions } from '../services/storage';
import { CREATE_AGENT_TYPES, sendCreateSession } from './create-agent';
import { resolveAgentCwdArg } from '../utils/parse';
import {
	collectLaunchAnswers,
	describeLaunchSpec,
	formatFieldErrors,
	formatLaunchStatus,
} from '../utils/launchInputs';
import { generateDefaultFolderName } from '../../shared/marketplaceFolderName';
import { readCallerIdentity } from '../../shared/agentDelegation';
import { resolveLaunchValues, validateLaunchValues } from '../../shared/playbookLaunch';
import type {
	MarketplaceManifest,
	MarketplacePlaybook,
	PlaybookLaunchRecord,
	PlaybookLaunchSpec,
} from '../../shared/marketplace-types';
import type { TemplateSessionInfo } from '../../shared/templateVariables';

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
	console.log('');
	for (const line of describeLaunchSpec(playbook.launch)) console.log(line);
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

// ============================================================================
// Playbook Launch
// ============================================================================

/** `launch` imports the documents and starts the run; the same work as an import plus a run start. */
const LAUNCH_TIMEOUT_MS = 180_000;
/** How often `--wait` asks for the launch record. */
export const LAUNCH_POLL_INTERVAL_MS = 3_000;

interface LaunchOptions extends JsonOption {
	input?: string[];
	inputFile?: string;
	agent?: string;
	keepPlaybook?: boolean;
	confirm?: boolean;
	wait?: boolean;
	newAgent?: boolean;
	provider?: string;
	cwd?: string;
	name?: string;
	model?: string;
	effort?: string;
	sshRemote?: string;
}

interface LaunchesOptions extends JsonOption {
	agent?: string;
}

/** The playbook's launch block, or an error that says the playbook is download only. */
function requireLaunchSpec(playbook: MarketplacePlaybook): PlaybookLaunchSpec {
	if (!playbook.launch) {
		throw new Error(
			`"${playbook.id}" is download only: it has no launch support. Use \`marketplace import\`.`
		);
	}
	return playbook.launch;
}

/**
 * The launch's answers, resolved and checked with the rules the modal uses. Every failing input is
 * listed, so one run shows all of them.
 *
 * @returns the values to launch with; the process exits first when any is refused
 */
function resolveCheckedValues(
	spec: PlaybookLaunchSpec,
	options: LaunchOptions
): ReturnType<typeof resolveLaunchValues> {
	let values: ReturnType<typeof resolveLaunchValues>;
	try {
		values = resolveLaunchValues(spec, collectLaunchAnswers(spec, options));
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
	const fieldErrors = validateLaunchValues(spec, values);
	if (Object.keys(fieldErrors).length > 0) {
		const lines = formatFieldErrors(spec, fieldErrors);
		if (options.json) {
			console.log(
				JSON.stringify({ success: false, error: 'Launch values are not valid', fieldErrors })
			);
			process.exit(1);
		}
		return failCommand(`Launch values are not valid:\n  ${lines.join('\n  ')}`, false);
	}
	return values;
}

/** The checkbox the launch modal asks for, as a flag: refuse to go on without `--confirm`. */
function requireConfirmation(spec: PlaybookLaunchSpec, options: LaunchOptions): void {
	const text = spec.preconditions?.confirm;
	if (text && !options.confirm) {
		failCommand(
			`This playbook needs your confirmation. Re-run with --confirm.\n  ${text}`,
			options.json
		);
	}
}

/** The agent a launch runs on: `--agent`, else the agent whose shell this is. */
function resolveLaunchAgent(options: LaunchOptions): string {
	const agent = options.agent ?? readCallerIdentity(process.env)?.agentId;
	if (!agent) {
		return failCommand(
			'Pass --agent <id> (or --new-agent --provider <id> --cwd <path>); no calling agent was found',
			options.json
		);
	}
	return resolveAgentOrFail(agent, options.json);
}

/** The new-agent flags, checked before anything is created. */
function requireNewAgentFlags(options: LaunchOptions): { provider: string; cwd: string } {
	if (options.agent) {
		failCommand('--new-agent and --agent cannot be used together', options.json);
	}
	if (!options.provider || !options.cwd) {
		failCommand('--new-agent needs --provider <id> and --cwd <path>', options.json);
	}
	if (!CREATE_AGENT_TYPES.includes(options.provider)) {
		failCommand(
			`Invalid provider "${options.provider}". Must be one of: ${CREATE_AGENT_TYPES.join(', ')}`,
			options.json
		);
	}
	return { provider: options.provider, cwd: options.cwd };
}

/**
 * Create the agent a new-agent launch runs on, through the request `create-agent` sends. Created in
 * the background so the launch does not move the Left Bar selection.
 */
async function createLaunchAgent(
	playbook: MarketplacePlaybook,
	flags: { provider: string; cwd: string },
	options: LaunchOptions
): Promise<string> {
	const payload: Record<string, unknown> = {
		name: options.name?.trim() || playbook.title,
		toolType: flags.provider,
		cwd: resolveAgentCwdArg(flags.cwd),
		background: true,
	};
	if (options.model) payload.customModel = options.model;
	if (options.effort) payload.customEffort = options.effort;
	if (options.sshRemote) {
		payload.sessionSshRemoteConfig = { enabled: true, remoteId: options.sshRemote };
	}
	const reply = await sendCreateSession(payload);
	if (!reply.success || !reply.sessionId) {
		throw new Error(reply.error || 'Failed to create the agent');
	}
	return reply.sessionId;
}

/** Read one launch record. */
async function fetchLaunch(launchId: string): Promise<PlaybookLaunchRecord> {
	const reply = await withMaestroClient((client) =>
		client.sendCommand<{ success: boolean; launch?: PlaybookLaunchRecord; error?: string }>(
			{ type: 'marketplace_get_launch', launchId },
			'marketplace_get_launch_result'
		)
	);
	if (!reply.success || !reply.launch) {
		throw new Error(reply.error || `No launch "${launchId}"`);
	}
	return reply.launch;
}

/** The agent a launch ran on, for the built-ins that name it. Absent when it is gone. */
function launchAgent(launch: PlaybookLaunchRecord): TemplateSessionInfo | undefined {
	return readSessions().find((session) => session.id === launch.sessionId);
}

function printLaunchStatus(launch: PlaybookLaunchRecord, json?: boolean): void {
	if (json) {
		console.log(JSON.stringify({ success: true, launch }));
		return;
	}
	for (const line of formatLaunchStatus(launch, launchAgent(launch))) console.log(line);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Ask for the launch until its run is no longer running. */
async function waitForLaunch(launchId: string): Promise<PlaybookLaunchRecord> {
	for (;;) {
		const launch = await fetchLaunch(launchId);
		if (launch.status !== 'running') return launch;
		await sleep(LAUNCH_POLL_INTERVAL_MS);
	}
}

/**
 * `marketplace launch <id>`: import a playbook with the answers filled in and start its Auto Run,
 * on an agent or on a new one. Everything is checked before anything is created or imported.
 */
export async function marketplaceLaunch(id: string, options: LaunchOptions): Promise<void> {
	let playbook: MarketplacePlaybook;
	let spec: PlaybookLaunchSpec;
	try {
		playbook = findPlaybook(await fetchManifest(false), id);
		spec = requireLaunchSpec(playbook);
	} catch (error) {
		failFromError(error, options.json);
	}
	const values = resolveCheckedValues(spec, options);
	requireConfirmation(spec, options);
	const newAgentFlags = options.newAgent ? requireNewAgentFlags(options) : undefined;
	let sessionId = newAgentFlags ? undefined : resolveLaunchAgent(options);

	let reply: {
		success: boolean;
		error?: string;
		launchId?: string;
		folderRelativePath?: string;
	};
	let launch: PlaybookLaunchRecord | undefined;
	try {
		if (newAgentFlags) sessionId = await createLaunchAgent(playbook, newAgentFlags, options);
		const agentId = sessionId;
		reply = await withMaestroClient((client) =>
			client.sendCommand(
				{
					type: 'marketplace_launch',
					sessionId: agentId,
					playbookId: id,
					values,
					keepSavedPlaybook: options.keepPlaybook === true,
				},
				'marketplace_launch_result',
				LAUNCH_TIMEOUT_MS
			)
		);
		if (reply.success && reply.launchId && options.wait) {
			launch = await waitForLaunch(reply.launchId);
		}
	} catch (error) {
		// A launch that fails after the agent was created keeps the agent, as the modal does.
		if (newAgentFlags && sessionId && !options.json) {
			console.error(`The new agent ${sessionId} was created and kept.`);
		}
		failFromError(error, options.json);
	}
	if (!reply.success || !reply.launchId) {
		const note =
			newAgentFlags && sessionId ? ` (the new agent ${sessionId} was created and kept)` : '';
		failCommand(`${reply.error || 'Launch failed'}${note}`, options.json);
	}

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				sessionId,
				launchId: reply.launchId,
				folder: reply.folderRelativePath,
				...(launch ? { launch } : {}),
			})
		);
	} else if (launch) {
		printLaunchStatus(launch);
	} else {
		console.log(`Launched ${id} on ${sessionId} (launch ${reply.launchId}).`);
		console.log(`Check it with: maestro-cli marketplace launch-status ${reply.launchId}`);
	}
	// A run that did not finish is a failure for a script waiting on it.
	if (launch && launch.status !== 'completed') process.exit(1);
}

/** `marketplace launches`: launch records, newest first. */
export async function marketplaceLaunches(options: LaunchesOptions): Promise<void> {
	const sessionId = options.agent ? resolveAgentOrFail(options.agent, options.json) : undefined;
	let launches: PlaybookLaunchRecord[];
	try {
		const reply = await withMaestroClient((client) =>
			client.sendCommand<{ success: boolean; launches?: PlaybookLaunchRecord[]; error?: string }>(
				{ type: 'marketplace_list_launches', ...(sessionId ? { sessionId } : {}) },
				'marketplace_list_launches_result'
			)
		);
		if (!reply.success || !reply.launches) {
			throw new Error(reply.error || 'Failed to list launches');
		}
		launches = reply.launches;
	} catch (error) {
		failFromError(error, options.json);
	}
	if (options.json) {
		console.log(JSON.stringify(launches, null, 2));
		return;
	}
	if (launches.length === 0) {
		console.log('No launches.');
		return;
	}
	for (const launch of launches) {
		console.log(
			`${launch.launchId}  ${launch.status}  ${launch.playbookId}  agent ${launch.sessionId}  ${new Date(launch.startedAt).toISOString()}`
		);
	}
}

/** `marketplace launch-status <launch-id>`: the record and the rendered outro. */
export async function marketplaceLaunchStatus(
	launchId: string,
	options: JsonOption
): Promise<void> {
	let launch: PlaybookLaunchRecord;
	try {
		launch = await fetchLaunch(launchId);
	} catch (error) {
		failFromError(error, options.json);
	}
	printLaunchStatus(launch, options.json);
}
