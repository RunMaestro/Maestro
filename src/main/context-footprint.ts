/**
 * Collect the inventory for a context footprint audit, then audit it.
 *
 * Read only, bounded, and run once per request: no timer, no watcher, no cache,
 * nothing written. `FootprintFs` is a `Pick` of the provider translation port
 * with its read methods only, so this file cannot write through it; the one
 * other read it reaches is `listMemoryEntries()`, which stats and lists.
 *
 * It reads exactly these places and nothing else:
 *
 * - the agent's project root: `CLAUDE.md`, `AGENTS.md`, `.claude/CLAUDE.md`,
 *   `.mcp.json`, and one folder per skill under the four project skill roots;
 * - the agent's provider account dir (when the caller names one): the same two
 *   instruction file names and `skills/`;
 * - the memory store the caller resolved for this agent (`memory`).
 *
 * The caller resolves the account dir and the memory store with its own
 * resolvers (`resolveCliAgentAccountDir`, `resolveProviderMemoryLayout`), so
 * this file cannot wander into another project's memory or another account.
 * Sizes come from `stat`; only `.mcp.json` is opened, to list its server names.
 *
 * The text Maestro's settings add comes from the target and is sized as
 * configured now. This file observes no launch and keeps no record of one, so
 * it never says that any of that text reached a provider.
 *
 * Electron-free, so `maestro-cli` imports it.
 */

import * as path from 'path';
import {
	auditContextFootprint,
	type ContextFootprintAudit,
	type FootprintComponentInput,
	type FootprintNote,
	type FootprintScope,
	type ConfiguredContributionInput,
} from '../shared/contextFootprint';
import type { TranslationFs } from '../shared/maestro-lib/translation/fs-port';
import { localTranslationFs } from '../shared/maestro-lib/translation/local-fs';
import {
	INSTRUCTION_FILE_NAMES,
	PROJECT_SKILL_ROOTS,
} from '../shared/maestro-lib/translation/resources';
import {
	MCP_CONFIG_FILE,
	PROJECT_MEMORY_FILES,
	scrubMcpConfig,
} from './cue/bundle/cue-bundle-claude-assets';
import { listMemoryEntries, MEMORY_INDEX_FILE, type MemoryLayout } from './memory-manager';

/** The reads the audit makes. A type, not a promise: nothing here writes. */
export type FootprintFs = Pick<TranslationFs, 'stat' | 'readdir' | 'readFile' | 'realpath'>;

export interface FootprintLimits {
	/** Skill folders examined under one skill root. */
	skillsPerRoot: number;
	/** Memory entries counted. */
	memoryEntries: number;
	/** The largest `.mcp.json` that is opened. */
	mcpConfigBytes: number;
}

export const FOOTPRINT_LIMITS: FootprintLimits = {
	skillsPerRoot: 500,
	memoryEntries: 500,
	mcpConfigBytes: 1024 * 1024,
};

export interface FootprintTarget {
	agentId: string;
	agentName?: string;
	toolType: string;
	/** Absolute. The agent's project root. */
	projectRoot: string;
	/** Absolute provider account dir, when the provider has one. */
	accountDir?: string;
	/**
	 * The agent's memory store, resolved by the caller, or why it could not be
	 * (a provider with no store Maestro can read). Left out: no memory is read.
	 */
	memory?: MemoryLayout | { unavailable: string };
	/** The agent runs on an SSH remote, so these paths belong to another host. */
	remote?: boolean;
	newSessionMessage?: string;
	nudgeMessage?: string;
	/** The Maestro system prompt as built for this agent. `caveat` says what the build left out. */
	maestroSystemPrompt?: { text: string; caveat?: string };
}

interface Collection {
	fs: FootprintFs;
	limits: FootprintLimits;
	components: FootprintComponentInput[];
	notes: FootprintNote[];
}

const ABSENT = new Set(['ENOENT', 'ENOTDIR']);
const DENIED = new Set(['EACCES', 'EPERM']);

/** One read: undefined for a path that is not there, a note for one that cannot be read, a throw for anything else. */
async function readOrNote<T>(
	collection: Collection,
	what: string,
	read: () => Promise<T>
): Promise<T | undefined> {
	try {
		return await read();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? '';
		if (ABSENT.has(code)) return undefined;
		if (DENIED.has(code)) {
			collection.notes.push({
				code: 'unreadable',
				message: `${what} could not be read (${code}).`,
			});
			return undefined;
		}
		throw error;
	}
}

/** Instruction files by name. Names that resolve to one file (a link) are one component. */
async function addInstructionFiles(
	collection: Collection,
	scope: FootprintScope,
	root: string,
	names: readonly string[],
	labelPrefix: string
): Promise<void> {
	const byRealPath = new Map<string, FootprintComponentInput>();
	for (const name of names) {
		const label = `${labelPrefix}${name}`;
		const file = path.join(root, ...name.split('/'));
		const info = await readOrNote(collection, label, () => collection.fs.stat(file));
		if (!info || info.isDirectory()) continue;
		const real = (await readOrNote(collection, label, () => collection.fs.realpath(file))) ?? file;
		const first = byRealPath.get(real);
		if (first) {
			first.aliases = [...(first.aliases ?? []), label];
			continue;
		}
		const component: FootprintComponentInput = {
			kind: 'instruction',
			scope,
			label,
			path: file,
			discoveredBy: `${scope} instruction files`,
			bytes: info.size,
		};
		byRealPath.set(real, component);
		collection.components.push(component);
	}
}

/** One component per skill folder that holds a SKILL.md. Folders beyond the limit are not examined. */
async function addSkills(
	collection: Collection,
	scope: FootprintScope,
	root: string,
	rootLabel: string
): Promise<void> {
	const names = await readOrNote(collection, rootLabel, () => collection.fs.readdir(root));
	if (!names) return;
	// A dot folder is tooling (a provider's own `.system` skills), never one of theirs.
	const folders = names.filter((name) => !name.startsWith('.')).sort();
	const { skillsPerRoot } = collection.limits;
	if (folders.length > skillsPerRoot) {
		collection.notes.push({
			code: 'truncated',
			message: `${rootLabel} has ${folders.length} folders; only the first ${skillsPerRoot} (by name) were examined.`,
		});
	}
	for (const name of folders.slice(0, skillsPerRoot)) {
		for (const fileName of ['SKILL.md', 'skill.md']) {
			const file = path.join(root, name, fileName);
			const label = `${rootLabel}/${name}`;
			const info = await readOrNote(collection, label, () => collection.fs.stat(file));
			if (!info || info.isDirectory()) continue;
			collection.components.push({
				kind: 'skill',
				scope,
				label,
				path: file,
				discoveredBy: `${scope} skills folder ${rootLabel}`,
				bytes: info.size,
			});
			break;
		}
	}
}

/** The server names in `.mcp.json`. Their tool definitions are not in the file, so no size is claimed. */
async function addMcpServers(collection: Collection, projectRoot: string): Promise<void> {
	const file = path.join(projectRoot, MCP_CONFIG_FILE);
	const info = await readOrNote(collection, MCP_CONFIG_FILE, () => collection.fs.stat(file));
	if (!info || info.isDirectory()) return;
	if (info.size > collection.limits.mcpConfigBytes) {
		collection.notes.push({
			code: 'truncated',
			message: `${MCP_CONFIG_FILE} is larger than ${collection.limits.mcpConfigBytes} bytes, so its servers were not listed.`,
		});
		return;
	}
	const raw = await readOrNote(collection, MCP_CONFIG_FILE, () => collection.fs.readFile(file));
	if (raw === undefined) return;
	let servers: string[];
	try {
		servers = scrubMcpConfig(raw.toString('utf8')).servers;
	} catch {
		// A user's file that is not JSON is an expected failure: say so, do not guess.
		collection.notes.push({
			code: 'unreadable',
			message: `${MCP_CONFIG_FILE} is not a JSON object, so its servers were not listed.`,
		});
		return;
	}
	for (const server of servers) {
		collection.components.push({
			kind: 'mcp-server',
			scope: 'project',
			label: `${MCP_CONFIG_FILE}: ${server}`,
			path: file,
			discoveredBy: MCP_CONFIG_FILE,
			bytes: null,
		});
	}
}

async function addMemory(collection: Collection, layout: MemoryLayout): Promise<void> {
	const listing = await readOrNote(collection, 'The memory store', () => listMemoryEntries(layout));
	if (!listing) return;
	if (!listing.exists) {
		// Say where it looked: an empty memory section must not read as a healthy one.
		collection.notes.push({
			code: 'memory-missing',
			message: `No memory store exists at ${layout.directoryPath}.`,
		});
		return;
	}
	const { memoryEntries } = collection.limits;
	for (const entry of listing.entries.slice(0, memoryEntries)) {
		collection.components.push({
			kind: entry.name === MEMORY_INDEX_FILE ? 'memory-index' : 'memory',
			scope: layout.scope,
			label: `memory/${entry.name}`,
			path: path.join(layout.directoryPath, ...entry.name.split('/')),
			discoveredBy: 'memory store listing',
			bytes: entry.size,
		});
	}
	if (listing.entries.length > memoryEntries) {
		collection.notes.push({
			code: 'truncated',
			message: `The memory store has ${listing.entries.length} entries; only the first ${memoryEntries} were counted.`,
		});
	}
}

/**
 * The text Maestro's settings add, sized as configured NOW. Nothing here
 * observes a launch: a rebuilt prompt or a saved setting is a statement of what
 * would be added next, not a record of what a provider received, so the audit
 * leaves delivery and window unknown.
 */
function configuredContributions(
	target: FootprintTarget,
	notes: FootprintNote[]
): ConfiguredContributionInput[] {
	const configured: ConfiguredContributionInput[] = [];
	if (target.maestroSystemPrompt?.text) {
		configured.push({
			id: 'maestro-system-prompt',
			label: 'Maestro system prompt',
			text: target.maestroSystemPrompt.text,
			frequency: 'each-spawn',
			source: 'the Maestro system prompt builder, assembled for this agent now',
		});
		if (target.maestroSystemPrompt.caveat) {
			notes.push({ code: 'maestro-prompt-partial', message: target.maestroSystemPrompt.caveat });
		}
	} else {
		notes.push({
			code: 'maestro-prompt-unavailable',
			message: 'The Maestro system prompt was not measured.',
		});
	}
	if (target.newSessionMessage?.trim()) {
		configured.push({
			id: 'new-session-message',
			label: 'New session message',
			text: target.newSessionMessage,
			frequency: 'first-message',
			source: "the agent's New Session Message setting, as saved now",
		});
	}
	if (target.nudgeMessage?.trim()) {
		configured.push({
			id: 'nudge-message',
			label: 'Nudge message',
			text: target.nudgeMessage,
			frequency: 'every-message',
			source: "the agent's Nudge Message setting, as saved now",
		});
	}
	return configured;
}

export async function collectContextFootprint(
	target: FootprintTarget,
	options: { fs?: FootprintFs; limits?: Partial<FootprintLimits> } = {}
): Promise<ContextFootprintAudit> {
	const collection: Collection = {
		fs: options.fs ?? localTranslationFs,
		limits: { ...FOOTPRINT_LIMITS, ...options.limits },
		components: [],
		notes: [],
	};
	const { projectRoot, accountDir } = target;

	if (target.remote) {
		collection.notes.push({
			code: 'remote-agent',
			message:
				'This agent runs on an SSH remote. Its project, account and memory files are on that host, so none were read.',
		});
	} else {
		if (path.isAbsolute(projectRoot)) {
			const instructionNames = [
				...new Set<string>([...INSTRUCTION_FILE_NAMES, ...PROJECT_MEMORY_FILES]),
			];
			await addInstructionFiles(collection, 'project', projectRoot, instructionNames, '');
			for (const root of PROJECT_SKILL_ROOTS) {
				await addSkills(collection, 'project', path.join(projectRoot, ...root.split('/')), root);
			}
			await addMcpServers(collection, projectRoot);
		} else {
			collection.notes.push({
				code: 'no-project-root',
				message: 'The agent has no absolute project root, so no project files were read.',
			});
		}
		if (accountDir && path.isAbsolute(accountDir)) {
			await addInstructionFiles(
				collection,
				'account',
				accountDir,
				INSTRUCTION_FILE_NAMES,
				'<account>/'
			);
			await addSkills(collection, 'account', path.join(accountDir, 'skills'), '<account>/skills');
		}
		if (!target.memory) {
			collection.notes.push({ code: 'memory-not-read', message: 'No memory store was read.' });
		} else if ('unavailable' in target.memory) {
			collection.notes.push({
				code: 'memory-not-read',
				message: `The memory store was not read: ${target.memory.unavailable}`,
			});
		} else {
			await addMemory(collection, target.memory);
		}
		collection.notes.push({
			code: 'unaudited-scopes',
			message:
				"Only the files named in this report are read. Instruction files in parent folders or subfolders of the project, personal override files such as CLAUDE.local.md, user-level MCP servers and other providers' MCP config are not audited.",
		});
	}

	const configured = configuredContributions(target, collection.notes);
	return auditContextFootprint({
		subject: {
			agentId: target.agentId,
			...(target.agentName ? { agentName: target.agentName } : {}),
			toolType: target.toolType,
			projectRoot,
			...(accountDir ? { accountDir } : {}),
		},
		components: collection.components,
		configured,
		notes: collection.notes,
	});
}
