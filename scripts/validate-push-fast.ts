import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ZERO_SHA = '0000000000000000000000000000000000000000';
const MAX_ARGS_PER_BATCH = 80;
const prettierExtensions = new Set([
	'.css',
	'.cts',
	'.html',
	'.js',
	'.json',
	'.jsx',
	'.less',
	'.md',
	'.mjs',
	'.mts',
	'.scss',
	'.svg',
	'.ts',
	'.tsx',
	'.yaml',
	'.yml',
]);
const eslintExtensions = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);

type RefUpdate = {
	localRef: string;
	localSha: string;
	remoteRef: string;
	remoteSha: string;
};

function runCapture(command: string, args: string[]): string | null {
	const result = spawnSync(command, args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	if (result.status !== 0) {
		return null;
	}

	return result.stdout.trim();
}

function runInherited(command: string, args: string[]): number {
	const result = spawnSync(command, args, { stdio: 'inherit' });
	return result.status ?? 1;
}

function runBunx(args: string[]): number {
	const executable = process.platform === 'win32' ? 'bunx.cmd' : 'bunx';
	return runInherited(executable, args);
}

function splitLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) {
		return '';
	}

	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
}

function parseRefUpdates(stdin: string): RefUpdate[] {
	return splitLines(stdin).flatMap((line) => {
		const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
		if (!localRef || !localSha || !remoteRef || !remoteSha) {
			return [];
		}
		return [{ localRef, localSha, remoteRef, remoteSha }];
	});
}

function gitDiffNames(base: string, head: string): string[] {
	const output = runCapture('git', ['diff', '--name-only', '--diff-filter=ACMR', base, head]);
	return output ? splitLines(output) : [];
}

function mergeBase(head: string, ref: string): string | null {
	return runCapture('git', ['merge-base', head, ref]);
}

function baseForUpdate(update: RefUpdate): string | null {
	if (update.remoteSha && update.remoteSha !== ZERO_SHA) {
		return update.remoteSha;
	}

	return (
		mergeBase(update.localSha, 'origin/rc') ??
		mergeBase(update.localSha, 'origin/main') ??
		runCapture('git', ['rev-parse', `${update.localSha}^`])
	);
}

function changedFilesFromPrePush(updates: RefUpdate[]): string[] {
	const files = new Set<string>();

	for (const update of updates) {
		if (!update.localSha || update.localSha === ZERO_SHA) {
			continue;
		}

		const base = baseForUpdate(update);
		if (!base) {
			console.error(
				`[validate:push:fast] Could not find a comparison base for ${update.localRef}.`
			);
			process.exitCode = 1;
			continue;
		}

		for (const file of gitDiffNames(base, update.localSha)) {
			files.add(file);
		}
	}

	return [...files];
}

function changedFilesFromWorkingTree(): string[] {
	const upstream = runCapture('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
	const baseRange = upstream ? `${upstream}...HEAD` : 'origin/rc...HEAD';
	const committed = runCapture('git', ['diff', '--name-only', '--diff-filter=ACMR', baseRange]);
	const unstaged = runCapture('git', ['diff', '--name-only', '--diff-filter=ACMR']);
	const staged = runCapture('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
	const untracked = runCapture('git', ['ls-files', '--others', '--exclude-standard']);

	return [
		...new Set([
			...splitLines(committed ?? ''),
			...splitLines(unstaged ?? ''),
			...splitLines(staged ?? ''),
			...splitLines(untracked ?? ''),
		]),
	];
}

function existingFiles(files: string[]): string[] {
	const repoRoot = runCapture('git', ['rev-parse', '--show-toplevel']) ?? process.cwd();
	return files.filter((file) => existsSync(path.resolve(repoRoot, file)));
}

function hasExtension(file: string, extensions: Set<string>): boolean {
	return extensions.has(path.extname(file).toLowerCase());
}

function batched(files: string[]): string[][] {
	const batches: string[][] = [];
	for (let index = 0; index < files.length; index += MAX_ARGS_PER_BATCH) {
		batches.push(files.slice(index, index + MAX_ARGS_PER_BATCH));
	}
	return batches;
}

function runBatches(label: string, baseArgs: string[], files: string[]): boolean {
	if (files.length === 0) {
		console.log(`[validate:push:fast] ${label}: no matching changed files.`);
		return true;
	}

	console.log(`[validate:push:fast] ${label}: checking ${files.length} changed file(s).`);
	for (const batch of batched(files)) {
		const status = runBunx([...baseArgs, ...batch]);
		if (status !== 0) {
			return false;
		}
	}

	return true;
}

const stdin = await readStdin();
const updates = parseRefUpdates(stdin);
const changedFiles = existingFiles(
	updates.length > 0 ? changedFilesFromPrePush(updates) : changedFilesFromWorkingTree()
);
const prettierFiles = changedFiles.filter((file) => hasExtension(file, prettierExtensions));
const eslintFiles = changedFiles.filter(
	(file) => file.startsWith('src/') && hasExtension(file, eslintExtensions)
);

console.log(`[validate:push:fast] Changed files detected: ${changedFiles.length}.`);

const prettierPassed = runBatches(
	'Prettier',
	['prettier', '--check', '--ignore-unknown'],
	prettierFiles
);
const eslintPassed = runBatches('ESLint', ['eslint'], eslintFiles);

if (!prettierPassed || !eslintPassed || process.exitCode) {
	process.exit(process.exitCode ?? 1);
}

console.log('[validate:push:fast] Fast push validation passed.');
console.log(
	'[validate:push:fast] Run `bun run validate:push:full` for repo-wide format, typecheck, ESLint, and tests.'
);
