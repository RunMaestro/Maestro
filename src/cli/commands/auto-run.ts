// Auto-run command - configure and optionally launch an auto-run session in Maestro

import * as fs from 'fs';
import * as path from 'path';
import { withMaestroClient, resolveSessionId } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';

interface AutoRunOptions {
	agent?: string;
	session?: string;
	prompt?: string;
	loop?: boolean;
	maxLoops?: string;
	saveAs?: string;
	launch?: boolean;
	resetOnCompletion?: boolean;
	worktree?: boolean;
	branch?: string;
	worktreePath?: string;
	createPr?: boolean;
	prTargetBranch?: string;
}

export async function autoRun(docs: string[], options: AutoRunOptions): Promise<void> {
	if (!docs || docs.length === 0) {
		console.error('Error: At least one document path is required');
		process.exit(1);
	}

	// Resolve and validate each document path
	const resolvedPaths: string[] = [];
	for (const doc of docs) {
		const absolutePath = path.resolve(doc);

		if (!fs.existsSync(absolutePath)) {
			console.error(`Error: File not found: ${absolutePath}`);
			process.exit(1);
		}

		if (path.extname(absolutePath).toLowerCase() !== '.md') {
			console.error(`Error: File must be a .md file: ${absolutePath}`);
			process.exit(1);
		}

		resolvedPaths.push(absolutePath);
	}

	if (options.session) {
		console.warn('Warning: --session is deprecated for auto-run, use --agent instead');
	}

	let sessionId: string;
	const agentId = options.agent || options.session;
	if (agentId) {
		try {
			sessionId = resolveAgentId(agentId);
		} catch (error) {
			console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
			return process.exit(1);
		}
	} else {
		sessionId = resolveSessionId({});
	}

	const documents = resolvedPaths.map((d) => ({
		filename: d,
		resetOnCompletion: options.resetOnCompletion || false,
	}));

	const loopEnabled = options.loop || options.maxLoops !== undefined;
	const maxLoops =
		options.maxLoops !== undefined
			? Number.isInteger(Number(options.maxLoops)) && Number(options.maxLoops) > 0
				? Number(options.maxLoops)
				: NaN
			: undefined;

	if (maxLoops !== undefined && (isNaN(maxLoops) || maxLoops < 1)) {
		console.error('Error: --max-loops must be a positive integer');
		process.exit(1);
	}

	// Worktree configuration: requires --launch and --branch.
	// The desktop app handles worktree creation, branch checkout, and (optionally)
	// PR creation on completion via the same code path used by the Auto Run UI.
	let worktree:
		| {
				enabled: boolean;
				path: string;
				branchName: string;
				createPROnCompletion: boolean;
				prTargetBranch: string;
		  }
		| undefined;
	if (options.worktree) {
		if (!options.launch) {
			console.error('Error: --worktree requires --launch');
			process.exit(1);
		} else if (!options.branch || options.branch.trim() === '') {
			console.error('Error: --worktree requires --branch <name>');
			process.exit(1);
		} else if (!options.worktreePath || options.worktreePath.trim() === '') {
			console.error('Error: --worktree requires --worktree-path <path>');
			process.exit(1);
		} else {
			worktree = {
				enabled: true,
				path: path.resolve(options.worktreePath),
				branchName: options.branch.trim(),
				createPROnCompletion: options.createPr || false,
				prTargetBranch: options.prTargetBranch?.trim() || '',
			};
		}
	} else if (options.branch || options.worktreePath || options.createPr || options.prTargetBranch) {
		console.error(
			'Error: --branch, --worktree-path, --create-pr, and --pr-target-branch require --worktree'
		);
		process.exit(1);
	}

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{
				type: string;
				success: boolean;
				playbookId?: string;
				error?: string;
			}>(
				{
					type: 'configure_auto_run',
					sessionId,
					documents,
					prompt: options.prompt,
					loopEnabled: loopEnabled || undefined,
					maxLoops,
					saveAsPlaybook: options.saveAs,
					launch: options.launch,
					worktree,
				},
				'configure_auto_run_result'
			);
		});

		if (result.success) {
			if (options.saveAs) {
				console.log(
					`Playbook '${options.saveAs}' saved${result.playbookId ? ` (ID: ${result.playbookId})` : ''}`
				);
			} else if (options.launch) {
				console.log(
					`Auto-run launched with ${documents.length} document${documents.length !== 1 ? 's' : ''}`
				);
			} else {
				console.log(
					`Auto-run configured with ${documents.length} document${documents.length !== 1 ? 's' : ''}`
				);
			}
		} else {
			console.error(`Error: ${result.error || 'Failed to configure auto-run'}`);
			process.exit(1);
		}
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
