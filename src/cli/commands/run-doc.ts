// Run-doc command
// Executes one or more raw Auto Run .md documents headlessly, without saving a
// playbook first. Mirrors `playbook <id>` (run-playbook) but builds an ephemeral
// playbook on the fly from the given document paths. Self-contained: spawns the
// target agent via batch-processor and does NOT depend on the desktop renderer,
// so it works whether or not the Maestro window is open. This is the reliable
// path for group-chat participants asked to run a document they just wrote.

import { getSessionById, resolveAgentId } from '../services/storage';
import { runPlaybook as executePlaybook } from '../services/batch-processor';
import { detectAgent } from '../services/agent-spawner';
import { getAgentDefinition } from '../../main/agents/definitions';
import { emitError } from '../output/jsonl';
import { formatRunEvent, formatError, formatInfo, RunEvent } from '../output/formatter';
import { checkAgentBusy, waitForAgentAvailable } from '../services/agent-busy';
import type { Playbook } from '../../shared/types';
import * as fs from 'fs';
import * as path from 'path';

interface RunDocOptions {
	agent: string; // required via commander
	prompt?: string;
	loop?: boolean;
	maxLoops?: string;
	resetOnCompletion?: boolean;
	dryRun?: boolean;
	history?: boolean; // --no-history => history: false
	json?: boolean;
	debug?: boolean;
	verbose?: boolean;
	synopsis?: boolean; // --no-synopsis => synopsis: false
	wait?: boolean;
}

/**
 * Resolve the given document arguments to a single Auto Run folder plus a list
 * of relative filenames (without the .md extension), which is how
 * batch-processor reads them (`${folderPath}/${filename}.md`).
 *
 * A document may be given as an absolute path, a path relative to the agent's
 * Auto Run folder, or a path relative to the current working directory. All
 * resolved documents must live in the same folder.
 * @internal
 */
function resolveDocs(
	docs: string[],
	autoRunFolderPath: string | undefined
): { folderPath: string; filenames: string[] } {
	const resolved: string[] = [];
	for (const doc of docs) {
		const candidates: string[] = [];
		if (path.isAbsolute(doc)) {
			candidates.push(doc);
		} else {
			if (autoRunFolderPath) candidates.push(path.resolve(autoRunFolderPath, doc));
			candidates.push(path.resolve(process.cwd(), doc));
		}
		const found = candidates.find((c) => fs.existsSync(c));
		if (!found) {
			throw new Error(`File not found: ${doc}`);
		}
		if (path.extname(found).toLowerCase() !== '.md') {
			throw new Error(`File must be a .md file: ${found}`);
		}
		resolved.push(found);
	}

	// Prefer the agent's Auto Run folder as the base when every document lives
	// inside it (keeps {{AUTORUN_FOLDER}} template substitution correct);
	// otherwise fall back to the documents' shared parent directory.
	let folderPath: string;
	if (
		autoRunFolderPath &&
		resolved.every((p) => !path.relative(autoRunFolderPath, p).startsWith('..'))
	) {
		folderPath = autoRunFolderPath;
	} else {
		const dirs = new Set(resolved.map((p) => path.dirname(p)));
		if (dirs.size > 1) {
			throw new Error('All documents must be in the same folder');
		}
		folderPath = resolved[0] ? path.dirname(resolved[0]) : process.cwd();
	}

	const filenames = resolved.map((p) => {
		const rel = path.relative(folderPath, p);
		return rel.replace(/\.md$/i, '');
	});

	return { folderPath, filenames };
}

export async function runDoc(docs: string[], options: RunDocOptions): Promise<void> {
	const useJson = options.json;

	try {
		if (!docs || docs.length === 0) {
			const message = 'At least one document path is required';
			if (useJson) emitError(message, 'NO_DOCUMENTS');
			else console.error(formatError(message));
			process.exit(1);
		}

		// Resolve the target agent (accepts an ID or a display name)
		let agentId: string;
		try {
			agentId = resolveAgentId(options.agent);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			if (useJson) emitError(message, 'AGENT_NOT_FOUND');
			else console.error(formatError(message));
			process.exit(1);
		}

		const agent = getSessionById(agentId)!;

		// Check if agent CLI is available
		const def = getAgentDefinition(agent.toolType);
		if (!def) {
			const message = `Agent type "${agent.toolType}" is not supported in CLI batch mode yet.`;
			if (useJson) emitError(message, 'AGENT_UNSUPPORTED');
			else console.error(formatError(message));
			process.exit(1);
		}

		const detection = await detectAgent(agent.toolType);
		if (!detection.available) {
			const errorCode = `${agent.toolType.toUpperCase().replace(/-/g, '_')}_NOT_FOUND`;
			const message = `${def.name} CLI not found. Please install ${def.name}.`;
			if (useJson) emitError(message, errorCode);
			else console.error(formatError(message));
			process.exit(1);
		}

		// Check if agent is busy (either from desktop or another CLI instance)
		const busyCheck = checkAgentBusy(agent.id);
		if (busyCheck.busy) {
			if (options.wait) {
				await waitForAgentAvailable(agent, busyCheck, { useJson });
			} else {
				const message = `Agent "${agent.name}" is busy: ${busyCheck.reason}. Use --wait to wait for availability.`;
				if (useJson) emitError(message, 'AGENT_BUSY');
				else console.error(formatError(message));
				process.exit(1);
			}
		}

		// Resolve the documents into a folder + relative filenames
		let folderPath: string;
		let filenames: string[];
		try {
			({ folderPath, filenames } = resolveDocs(docs, agent.autoRunFolderPath));
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			if (useJson) emitError(message, 'DOCUMENT_RESOLUTION_FAILED');
			else console.error(formatError(message));
			process.exit(1);
		}

		// Loop configuration
		const loopEnabled = options.loop || options.maxLoops !== undefined;
		const maxLoops =
			options.maxLoops !== undefined
				? Number.isInteger(Number(options.maxLoops)) && Number(options.maxLoops) > 0
					? Number(options.maxLoops)
					: NaN
				: undefined;
		if (maxLoops !== undefined && (isNaN(maxLoops) || maxLoops < 1)) {
			const message = '--max-loops must be a positive integer';
			if (useJson) emitError(message, 'INVALID_MAX_LOOPS');
			else console.error(formatError(message));
			process.exit(1);
		}

		// Build an ephemeral playbook. An empty prompt makes batch-processor fall
		// back to the default Auto Run prompt (PROMPT_IDS.AUTORUN_DEFAULT).
		const now = Date.now();
		const playbook: Playbook = {
			id: `run-doc-${process.pid}-${now}`,
			name: filenames.length === 1 ? filenames[0] : `${filenames.length} documents`,
			createdAt: now,
			updatedAt: now,
			documents: filenames.map((filename) => ({
				filename,
				resetOnCompletion: options.resetOnCompletion || false,
			})),
			loopEnabled,
			maxLoops,
			prompt: options.prompt || '',
		};

		// Show startup info in human-readable mode
		if (!useJson) {
			console.log(
				formatInfo(`Running document${filenames.length !== 1 ? 's' : ''}: ${filenames.join(', ')}`)
			);
			console.log(formatInfo(`Agent: ${agent.name}`));
			console.log(formatInfo(`Folder: ${folderPath}`));
			if (loopEnabled) {
				const loopInfo = maxLoops ? `max ${maxLoops}` : '∞';
				console.log(formatInfo(`Loop: enabled (${loopInfo})`));
			}
			if (options.dryRun) {
				console.log(formatInfo('Dry run mode - no changes will be made'));
			}
			console.log('');
		}

		// Execute and stream events
		const generator = executePlaybook(agent, playbook, folderPath, {
			dryRun: options.dryRun,
			writeHistory: options.history !== false,
			debug: options.debug,
			verbose: options.verbose,
			skipSynopsis: options.synopsis === false,
		});

		for await (const event of generator) {
			if (useJson) {
				console.log(JSON.stringify(event));
			} else {
				console.log(formatRunEvent(event as RunEvent, { debug: options.debug }));
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (useJson) {
			emitError(`Failed to run document: ${message}`, 'EXECUTION_ERROR');
		} else {
			console.error(formatError(`Failed to run document: ${message}`));
		}
		process.exit(1);
	}
}
