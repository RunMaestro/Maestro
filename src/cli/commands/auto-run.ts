// Auto-run command - configure and optionally launch an auto-run session in Maestro

import * as fs from 'fs';
import * as path from 'path';
import { withMaestroClient, resolveTargetSessionId } from '../services/maestro-client';
import { failCommand, failFromError } from '../services/session-command';

interface AutoRunOptions {
	agent?: string;
	prompt?: string;
	loop?: boolean;
	maxLoops?: string;
	saveAs?: string;
	launch?: boolean;
	resetOnCompletion?: boolean;
	worktree?: boolean;
	branch?: string;
	baseBranch?: string;
	worktreePath?: string;
	createPr?: boolean;
	prTargetBranch?: string;
	// Run-scoped overrides: they win over the agent's configured model/effort for
	// this run only and are never written back to the session.
	model?: string;
	effort?: string;
	/** Skip the documents' MAESTRO:MODEL markers for this run (--ignore-model-hints). */
	ignoreModelHints?: boolean;
	json?: boolean;
}

export async function autoRun(docs: string[], options: AutoRunOptions): Promise<void> {
	if (!docs || docs.length === 0) {
		failCommand('At least one document path is required', options.json);
	}

	// Resolve and validate each document path
	const resolvedPaths: string[] = [];
	for (const doc of docs) {
		const absolutePath = path.resolve(doc);

		if (!fs.existsSync(absolutePath)) {
			failCommand(`File not found: ${absolutePath}`, options.json);
		}

		if (path.extname(absolutePath).toLowerCase() !== '.md') {
			failCommand(`File must be a .md file: ${absolutePath}`, options.json);
		}

		resolvedPaths.push(absolutePath);
	}

	const sessionId = resolveTargetSessionId(options.agent);

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
		failCommand('--max-loops must be a positive integer', options.json);
	}

	// Worktree configuration: requires --launch and --branch.
	// The desktop app handles worktree creation, branch checkout, and (optionally)
	// PR creation on completion via the same code path used by the Auto Run UI.
	let worktree:
		| {
				enabled: boolean;
				path: string;
				branchName: string;
				baseBranch: string;
				createPROnCompletion: boolean;
				prTargetBranch: string;
		  }
		| undefined;
	if (options.worktree) {
		if (!options.launch) {
			failCommand('--worktree requires --launch', options.json);
		} else if (!options.branch || options.branch.trim() === '') {
			failCommand('--worktree requires --branch <name>', options.json);
		} else if (!options.worktreePath || options.worktreePath.trim() === '') {
			failCommand('--worktree requires --worktree-path <path>', options.json);
		} else {
			worktree = {
				enabled: true,
				path: path.resolve(options.worktreePath),
				branchName: options.branch.trim(),
				baseBranch: options.baseBranch?.trim() || '',
				createPROnCompletion: options.createPr || false,
				prTargetBranch: options.prTargetBranch?.trim() || '',
			};
		}
	} else if (
		options.branch ||
		options.baseBranch ||
		options.worktreePath ||
		options.createPr ||
		options.prTargetBranch
	) {
		failCommand(
			'--branch, --base-branch, --worktree-path, --create-pr, and --pr-target-branch require --worktree',
			options.json
		);
	}

	// Run-scoped model/effort overrides. Sent only when set so an omitted flag
	// leaves the agent's configured default untouched.
	const runModel = options.model?.trim() || undefined;
	const runEffort = options.effort?.trim() || undefined;

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
					...(runModel && { model: runModel }),
					...(runEffort && { effort: runEffort }),
					...(options.ignoreModelHints && { ignoreModelHints: true }),
				},
				'configure_auto_run_result'
			);
		});

		if (result.success) {
			if (options.json) {
				console.log(
					JSON.stringify({
						success: true,
						documents: documents.length,
						launched: Boolean(options.launch),
						...(result.playbookId ? { playbookId: result.playbookId } : {}),
						...(options.saveAs ? { savedAs: options.saveAs } : {}),
					})
				);
			} else if (options.saveAs) {
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
			failCommand(result.error || 'Failed to configure auto-run', options.json);
		}
	} catch (error) {
		failFromError(error, options.json);
	}
}
