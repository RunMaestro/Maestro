import * as fs from 'fs/promises';
import * as path from 'path';
import type { MemoryTarget } from '../../shared/agentMemory';
import type { MemoryLayout } from '../memory-manager';
import { normalizeRootRelativePath } from '../../shared/pathContainment';
import { isPathAtOrUnderRoot } from '../../shared/worktreePaths';

import type { CodexMemorySourceRef } from '../../shared/codexMemory';
export type { CodexMemorySourceRef } from '../../shared/codexMemory';

export interface CodexMemorySource {
	sourceAgentId: string;
	codexHome: string;
	remoteId?: string | null;
}

/** Resolve the same account, SSH and translated-memory rules as the Memory Viewer. */
export function createCodexMemorySourceResolver(
	getSession: (id: string) => { toolType: string; projectRoot?: string; cwd: string } | undefined,
	resolveLayout: (target: MemoryTarget) => Promise<MemoryLayout>
) {
	return async (sourceAgentId: string): Promise<CodexMemorySource> => {
		const session = typeof sourceAgentId === 'string' && getSession(sourceAgentId);
		if (!session || session.toolType !== 'codex') throw new Error('Codex source agent not found');
		const layout = await resolveLayout({
			agentId: sourceAgentId,
			toolType: 'codex',
			projectPath: session.projectRoot || session.cwd,
		});
		if (layout.scope !== 'account') throw new Error('Codex account memory required');
		return { sourceAgentId, codexHome: path.dirname(layout.directoryPath) };
	};
}

function sourceHome(source: CodexMemorySource): string {
	if (source.remoteId !== undefined) throw new Error('Remote Codex memory resolution unavailable');
	return path.resolve(source.codexHome);
}

function ref(
	source: CodexMemorySource,
	home: string,
	root: string,
	relativePath: string
): CodexMemorySourceRef {
	return {
		sourceAgentId: source.sourceAgentId,
		provider: 'codex',
		location: { kind: 'local' },
		codexHome: home,
		memoryRoot: root,
		relativePath,
	};
}

async function resolveRoot(home: string): Promise<string> {
	return fs.realpath(path.join(home, 'memories'));
}

function validateRelative(relativePath: string): void {
	if (
		!relativePath ||
		normalizeRootRelativePath(relativePath) !== relativePath ||
		!relativePath.toLowerCase().endsWith('.md')
	)
		throw new Error('Unsafe Codex memory path');
}

async function resolveFile(source: CodexMemorySource, relativePath: string) {
	validateRelative(relativePath);
	const home = sourceHome(source);
	const root = await resolveRoot(home);
	const resolved = await fs.realpath(path.join(root, relativePath));
	if (!isPathAtOrUnderRoot(resolved, root)) throw new Error('Codex memory path escapes root');
	if (!(await fs.stat(resolved)).isFile()) throw new Error('Codex memory is not a file');
	return { resolved, sourceRef: ref(source, home, root, relativePath) };
}

/** Revalidate a displayed source against the effective home without rereading its text. */
export async function resolveCodexMemorySourceRef(source: CodexMemorySource, relativePath: string) {
	return (await resolveFile(source, relativePath)).sourceRef;
}

export async function readCodexMemory(source: CodexMemorySource, relativePath: string) {
	const { resolved, sourceRef } = await resolveFile(source, relativePath);
	return { content: await fs.readFile(resolved, 'utf8'), sourceRef };
}
