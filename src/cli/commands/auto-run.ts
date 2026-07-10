// Auto-run command - configure and optionally launch an auto-run session in Maestro

import * as fs from 'fs';
import * as path from 'path';
import { withMaestroClient, resolveTargetSessionId } from '../services/maestro-client';
import { getSessionById } from '../services/storage';

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
}

interface ConfigureAutoRunResult {
	type: 'configure_auto_run_result';
	success: boolean;
	playbookId?: string;
	error?: string;
}

function getAutoRunDocumentFilename(documentPath: string, autoRunFolderPath: string): string {
	const resolvedDocumentPath = path.resolve(documentPath);
	const relativePath = path.relative(autoRunFolderPath, resolvedDocumentPath);
	if (
		relativePath === '' ||
		relativePath.startsWith('..' + path.sep) ||
		relativePath === '..' ||
		path.isAbsolute(relativePath)
	) {
		throw new Error(
			`Document must be in the session Auto Run folder: ${autoRunFolderPath}. Received: ${resolvedDocumentPath}`
		);
	}

	return relativePath.split(path.sep).join(path.posix.sep);
}

export async function autoRun(docs: string[], options: AutoRunOptions): Promise<void> {
	if (!docs || docs.length === 0) {
		console.error('Error: At least one document path is required');
		process.exit(1);
		return;
	}

	// Resolve and validate each document path
	const resolvedPaths: string[] = [];
	for (const doc of docs) {
		const absolutePath = path.resolve(doc);

		if (!fs.existsSync(absolutePath)) {
			console.error(`Error: File not found: ${absolutePath}`);
			process.exit(1);
			return;
		}

		const stats = fs.statSync(absolutePath);
		if (!stats.isFile()) {
			console.error(`Error: Document is not a file: ${absolutePath}`);
			process.exit(1);
			return;
		}

		if (path.extname(absolutePath).toLowerCase() !== '.md') {
			console.error(`Error: File must be a .md file: ${absolutePath}`);
			process.exit(1);
			return;
		}

		resolvedPaths.push(absolutePath);
	}

	const sessionId = resolveTargetSessionId(options.agent);
	const session = getSessionById(sessionId);
	if (!session) {
		console.error(`Error: Session not found: ${sessionId}`);
		process.exit(1);
		return;
	}
	if (!session.autoRunFolderPath) {
		console.error(`Error: Session has no Auto Run folder configured: ${sessionId}`);
		process.exit(1);
		return;
	}
	const autoRunFolderPath = path.resolve(session.autoRunFolderPath);

	let documents: Array<{ filename: string; resetOnCompletion: boolean }>;
	try {
		documents = resolvedPaths.map((d) => ({
			filename: getAutoRunDocumentFilename(d, autoRunFolderPath),
			resetOnCompletion: options.resetOnCompletion || false,
		}));
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
		return;
	}

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
		return;
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
			console.error('Error: --worktree requires --launch');
			process.exit(1);
			return;
		} else if (!options.branch || options.branch.trim() === '') {
			console.error('Error: --worktree requires --branch <name>');
			process.exit(1);
			return;
		} else if (!options.worktreePath || options.worktreePath.trim() === '') {
			console.error('Error: --worktree requires --worktree-path <path>');
			process.exit(1);
			return;
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
		console.error(
			'Error: --branch, --base-branch, --worktree-path, --create-pr, and --pr-target-branch require --worktree'
		);
		process.exit(1);
		return;
	}

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<ConfigureAutoRunResult>(
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

		if (!result.success) {
			console.error(`Error: ${result.error || 'Failed to configure auto-run'}`);
			process.exit(1);
			return;
		}

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
		}
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
		return;
	}
}
