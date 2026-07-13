import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import {
	buildPluginArtifact,
	type ImmutableTrustRoot,
} from '../src/main/omp-distribution/plugin-artifact';

interface ArtifactInputFile {
	path: string;
	source: string;
}

interface ArtifactBuildInput {
	pluginId: string;
	version: string;
	contractSha256: string;
	trustRoot: ImmutableTrustRoot;
	files: ArtifactInputFile[];
	signature: string;
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const inputPath = requiredOption(options, 'input');
	const sourceRoot = resolve(requiredOption(options, 'source-root'));
	const bundledOutput = resolve(requiredOption(options, 'bundled-output'));
	const installableOutput = resolve(requiredOption(options, 'installable-output'));
	const input = parseInput(await readFile(inputPath, 'utf8'));
	const files = await Promise.all(
		input.files.map(async (file) => ({
			path: file.path,
			content: await readArtifactSource(sourceRoot, file.source),
		}))
	);
	const artifact = buildPluginArtifact({
		pluginId: input.pluginId,
		version: input.version,
		contractSha256: input.contractSha256,
		trustRoot: Object.freeze({ ...input.trustRoot }),
		files,
		sign: () => input.signature,
	});

	await Promise.all([
		writeArtifact(bundledOutput, artifact),
		writeArtifact(installableOutput, artifact),
	]);
	const [bundled, installable] = await Promise.all([
		readFile(bundledOutput),
		readFile(installableOutput),
	]);
	if (!bundled.equals(installable))
		throw new Error('bundled and installable plugin artifacts differ');
	process.stdout.write(
		`${JSON.stringify({ bytes: artifact.length, sha256: createHash('sha256').update(artifact).digest('hex') })}\n`
	);
}

function parseOptions(args: string[]): Record<string, string> {
	const options: Record<string, string> = {};
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (!key?.startsWith('--') || !value || options[key.slice(2)] !== undefined)
			throw new Error('expected unique --key value arguments');
		options[key.slice(2)] = value;
	}
	return options;
}

function requiredOption(options: Record<string, string>, key: string): string {
	const value = options[key];
	if (!value) throw new Error(`missing --${key}`);
	return value;
}

function parseInput(serialized: string): ArtifactBuildInput {
	let parsed: unknown;
	try {
		parsed = JSON.parse(serialized);
	} catch {
		throw new Error('invalid plugin artifact input JSON');
	}
	if (!isArtifactBuildInput(parsed)) throw new Error('invalid plugin artifact input');
	return parsed;
}

function isArtifactBuildInput(value: unknown): value is ArtifactBuildInput {
	if (!isRecord(value) || !isRecord(value.trustRoot) || !Array.isArray(value.files)) return false;
	return (
		typeof value.pluginId === 'string' &&
		typeof value.version === 'string' &&
		typeof value.contractSha256 === 'string' &&
		typeof value.signature === 'string' &&
		typeof value.trustRoot.keyId === 'string' &&
		typeof value.trustRoot.algorithm === 'string' &&
		typeof value.trustRoot.publicKey === 'string' &&
		value.files.every(
			(file) => isRecord(file) && typeof file.path === 'string' && typeof file.source === 'string'
		)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readArtifactSource(sourceRoot: string, source: string): Promise<Buffer> {
	const sourcePath = resolve(sourceRoot, source);
	const sourceRelativePath = relative(sourceRoot, sourcePath);
	if (
		sourceRelativePath.length === 0 ||
		sourceRelativePath.startsWith('..') ||
		sourceRelativePath.includes('..\\')
	) {
		throw new Error(`unsafe plugin artifact source: ${source}`);
	}
	return readFile(sourcePath);
}

async function writeArtifact(outputPath: string, artifact: Uint8Array): Promise<void> {
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, artifact);
}

void main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
