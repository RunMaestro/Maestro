/**
 * @file workflow-artifacts.ts
 * @description Run-scoped filesystem storage for large Group Chat workflow handoffs.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Dirent } from 'fs';
import { getGroupChatDir, getGroupChatsDir, sanitizeGroupChatFileName } from './group-chat-storage';

const WORKFLOW_RUNS_DIR = 'workflow-runs';

export interface WriteStageArtifactOptions {
	groupChatId: string;
	runId: string;
	stageId: string;
	participantName: string;
	content: string;
}

/** Return the absolute directory for one in-memory workflow run. */
export function getWorkflowRunDir(groupChatId: string, runId: string): string {
	return path.join(getGroupChatDir(groupChatId), WORKFLOW_RUNS_DIR, runId);
}

/** Create and return the absolute directory for one workflow run. */
export async function ensureWorkflowRunDir(groupChatId: string, runId: string): Promise<string> {
	const runDir = getWorkflowRunDir(groupChatId, runId);
	await fs.mkdir(runDir, { recursive: true });
	return runDir;
}

/** Persist a participant's full stage output and return its absolute path. */
export async function writeStageArtifact({
	groupChatId,
	runId,
	stageId,
	participantName,
	content,
}: WriteStageArtifactOptions): Promise<string> {
	const runDir = await ensureWorkflowRunDir(groupChatId, runId);
	const stageDir = path.join(runDir, stageId);
	await fs.mkdir(stageDir, { recursive: true });

	const artifactPath = path.join(stageDir, `${sanitizeGroupChatFileName(participantName)}.md`);
	await fs.writeFile(artifactPath, content, 'utf-8');
	return artifactPath;
}

/** Remove one workflow run, succeeding when the directory is already absent. */
export async function clearWorkflowRunDir(groupChatId: string, runId: string): Promise<void> {
	await fs.rm(getWorkflowRunDir(groupChatId, runId), { recursive: true, force: true });
}

/** Remove orphaned workflow-run directories left beneath every stored group chat. */
export async function sweepWorkflowRunDirs(): Promise<void> {
	let entries: Dirent<string>[];
	try {
		entries = await fs.readdir(getGroupChatsDir(), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw error;
	}

	await Promise.all(
		entries
			.filter((entry) => entry.isDirectory())
			.map((entry) =>
				fs.rm(path.join(getGroupChatsDir(), entry.name, WORKFLOW_RUNS_DIR), {
					recursive: true,
					force: true,
				})
			)
	);
}
