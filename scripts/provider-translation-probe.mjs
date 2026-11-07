// Read-only native extraction probe. Reports contain counts and paths, never message content.
import { build } from 'esbuild';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function parseProbeArgs(args) {
	const options = { limit: 300, json: undefined };
	for (let index = 0; index < args.length; index++) {
		const flag = args[index];
		const value = args[++index];
		if (!['--limit', '--json'].includes(flag) || !value || value.startsWith('--')) {
			throw new Error(
				'Usage: node scripts/provider-translation-probe.mjs [--limit <n>] [--json <path>]'
			);
		}
		if (flag === '--limit') {
			if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
				throw new Error('--limit must be a positive safe integer.');
			}
			options.limit = Number(value);
		} else options.json = value;
	}
	return options;
}

/** Every output component must be a real directory under this checkout's scratch. */
export async function writeProbeScratchFile(workspace, target, content) {
	const scratch = path.join(workspace, '.maestro', 'scratch');
	const resolved = path.resolve(workspace, target);
	const relative = path.relative(scratch, resolved);
	if (
		!relative ||
		relative === '..' ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new Error('Probe output must be a file inside .maestro/scratch/.');
	}
	let directory = workspace;
	for (const part of path.relative(workspace, path.dirname(resolved)).split(path.sep)) {
		directory = path.join(directory, part);
		await mkdir(directory, { mode: 0o700 }).catch((error) => {
			if (error.code !== 'EEXIST') throw error;
		});
		const entry = await lstat(directory);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error('Probe output directories must not be symlinks.');
		}
	}
	// Do not truncate until the opened file is known to be private and regular.
	const file = await open(
		resolved,
		constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		0o600
	);
	try {
		const entry = await file.stat();
		if (!entry.isFile() || entry.nlink !== 1) {
			throw new Error('Probe output must be a regular file with no hard links.');
		}
		await file.truncate(0);
		await file.writeFile(content);
	} finally {
		await file.close();
	}
	return resolved;
}

async function entriesOrMissing(directory) {
	try {
		return await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (error.code === 'ENOENT') return [];
		throw error;
	}
}

async function discoverTranscripts(home, provider) {
	const files = [];
	async function addFile(file, accountRoot) {
		const metadata = await stat(file);
		files.push({ file, accountRoot, mtimeMs: metadata.mtimeMs });
	}
	if (provider === 'claude-code') {
		for (const account of await entriesOrMissing(home)) {
			if (account.name !== '.claude' && !account.name.startsWith('.claude-')) continue;
			if (!account.isDirectory() && !account.isSymbolicLink()) continue;
			const accountRoot = path.join(home, account.name);
			for (const project of await entriesOrMissing(path.join(accountRoot, 'projects'))) {
				if (!project.isDirectory()) continue;
				const directory = path.join(accountRoot, 'projects', project.name);
				for (const entry of await entriesOrMissing(directory)) {
					if (entry.isFile() && entry.name.endsWith('.jsonl')) {
						await addFile(path.join(directory, entry.name), accountRoot);
					}
				}
			}
		}
	} else {
		const accountRoot = path.join(home, '.codex');
		async function visit(directory) {
			for (const entry of await entriesOrMissing(directory)) {
				const file = path.join(directory, entry.name);
				if (entry.isDirectory()) await visit(file);
				else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
					await addFile(file, accountRoot);
				}
			}
		}
		await visit(path.join(accountRoot, 'sessions'));
	}
	return files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
}

export async function probeTranscripts({
	home = homedir(),
	limit = 300,
	extractNativeConversation,
	parseNativeLines,
}) {
	const report = { limit, providers: {} };
	for (const provider of ['claude-code', 'codex']) {
		const sample = (await discoverTranscripts(home, provider)).slice(0, limit);
		const result = {
			sampled: sample.length,
			clean: 0,
			blocked: 0,
			blockCodes: {},
			warningCodes: {},
			infoCodes: {},
			examples: {},
		};
		for (const { file, accountRoot } of sample) {
			let limitations;
			try {
				const bytes = await readFile(file);
				const rows = parseNativeLines(bytes.toString('utf8'));
				const metadata =
					provider === 'codex'
						? rows.find((row) => row.entry?.type === 'session_meta')?.entry?.payload
						: undefined;
				const projectRoot =
					provider === 'codex'
						? metadata?.cwd
						: rows.find((row) => typeof row.entry?.cwd === 'string')?.entry?.cwd;
				const sessionId =
					provider === 'codex'
						? metadata?.id
						: (rows.find((row) => typeof row.entry?.sessionId === 'string')?.entry?.sessionId ??
							path.basename(file, '.jsonl'));
				if (
					typeof projectRoot !== 'string' ||
					!projectRoot ||
					typeof sessionId !== 'string' ||
					!sessionId
				) {
					limitations = [{ severity: 'block', code: 'probe-missing-identity' }];
				} else {
					limitations = extractNativeConversation(
						{ provider, version: 'probe', accountRoot, projectRoot },
						'probe',
						sessionId,
						bytes
					).limitations;
				}
			} catch (error) {
				// Never print exception messages: native data can appear in parser errors.
				limitations = [
					{ severity: 'block', code: error.code ? 'probe-read-error' : 'probe-extraction-error' },
				];
			}
			const blocked = limitations.some((item) => item.severity === 'block');
			result[blocked ? 'blocked' : 'clean']++;
			for (const [severity, key] of [
				['block', 'blockCodes'],
				['warning', 'warningCodes'],
				['info', 'infoCodes'],
			]) {
				for (const code of new Set(
					limitations.filter((item) => item.severity === severity).map((item) => item.code)
				)) {
					result[key][code] = (result[key][code] ?? 0) + 1;
					if (severity === 'block') {
						const examples = (result.examples[code] ??= []);
						if (examples.length < 3) examples.push(path.join('~', path.relative(home, file)));
					}
				}
			}
		}
		report.providers[provider] = result;
	}
	return report;
}

export function formatProbeReport(report) {
	const lines = ['Native extraction probe (clean means no blocks; counts are files per code).'];
	for (const [provider, result] of Object.entries(report.providers)) {
		lines.push(
			`${provider}: sampled ${result.sampled}, clean ${result.clean}, blocked ${result.blocked}`
		);
		for (const key of ['blockCodes', 'warningCodes', 'infoCodes']) {
			lines.push(`  ${key}: ${JSON.stringify(result[key])}`);
		}
		for (const [code, examples] of Object.entries(result.examples)) {
			lines.push(`  ${code} examples: ${JSON.stringify(examples)}`);
		}
	}
	return lines.join('\n');
}

async function main() {
	const options = parseProbeArgs(process.argv.slice(2));
	const workspace = await realpath(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
	const bundle = '.maestro/scratch/provider-translation-probe/native-records.mjs';
	if (options.json && path.resolve(workspace, options.json) === path.resolve(workspace, bundle)) {
		throw new Error('The JSON report must not overwrite the extractor bundle.');
	}
	const built = await build({
		entryPoints: [path.join(workspace, 'src/shared/maestro-lib/translation/native-records.ts')],
		bundle: true,
		write: false,
		platform: 'node',
		target: 'node22',
		format: 'esm',
		packages: 'external',
	});
	const bundledPath = await writeProbeScratchFile(workspace, bundle, built.outputFiles[0].contents);
	const { extractNativeConversation, parseNativeLines } = await import(
		pathToFileURL(bundledPath).href
	);
	const report = await probeTranscripts({
		limit: options.limit,
		extractNativeConversation,
		parseNativeLines,
	});
	if (options.json)
		await writeProbeScratchFile(workspace, options.json, `${JSON.stringify(report, null, 2)}\n`);
	console.log(formatProbeReport(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().catch(() => {
		console.error(
			'Provider translation probe failed. Check arguments, read access, and output paths under .maestro/scratch/. No transcript details printed.'
		);
		process.exitCode = 1;
	});
}
