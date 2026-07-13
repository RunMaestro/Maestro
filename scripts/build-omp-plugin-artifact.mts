import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { bundleOmpPlugin } from '../src/main/omp-distribution/bundle-plugin';
import {
	buildPluginArtifact,
	type ImmutableTrustRoot,
} from '../src/main/omp-distribution/plugin-artifact';
import { assertPackerGate } from '../src/main/omp-distribution/production-packer-gate';

interface BuiltManifestIdentity {
	id: string;
	version: string;
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const pluginRoot = resolve(requiredOption(options, 'plugin-root'));
	const trustRoot = parseTrustRoot(await readFile(requiredOption(options, 'trust-root'), 'utf8'));
	const signature = requiredOption(options, 'signature');
	const bundledOutput = resolve(requiredOption(options, 'bundled-output'));
	const installableOutput = resolve(requiredOption(options, 'installable-output'));
	const fixture = options.fixture === 'true';
	const bundle = await bundleOmpPlugin(pluginRoot);
	const manifest = parseBuiltManifest(
		bundle.files.find((file) => file.path === 'plugin.json')?.content
	);

	const artifact = buildPluginArtifact({
		pluginId: manifest.id,
		version: manifest.version,
		contractSha256: bundle.contractSha256,
		trustRoot: Object.freeze(trustRoot),
		files: bundle.files,
		sign: () => signature,
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
	const sha256 = createHash('sha256').update(artifact).digest('hex');
	assertPackerGate({
		fixture,
		trustRoot,
		signature,
		expectedSha256: options['expected-sha256'],
		actualSha256: sha256,
		outputPaths: [bundledOutput, installableOutput],
		trustRootPath: requiredOption(options, 'trust-root'),
	});
	process.stdout.write(`${JSON.stringify({ bytes: artifact.length, sha256 })}\n`);
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

function parseTrustRoot(serialized: string): ImmutableTrustRoot {
	const parsed = parseJsonObject(serialized, 'invalid trust-root metadata');
	if (
		typeof parsed.keyId !== 'string' ||
		typeof parsed.algorithm !== 'string' ||
		typeof parsed.publicKey !== 'string'
	) {
		throw new Error('trust-root metadata requires keyId, algorithm, and publicKey');
	}
	return { keyId: parsed.keyId, algorithm: parsed.algorithm, publicKey: parsed.publicKey };
}

function parseBuiltManifest(content: Uint8Array | undefined): BuiltManifestIdentity {
	if (!content) throw new Error('bundler omitted plugin.json');
	const parsed = parseJsonObject(
		Buffer.from(content).toString('utf8'),
		'invalid bundled plugin.json'
	);
	if (parsed.id !== 'com.maestro.omp' || typeof parsed.version !== 'string')
		throw new Error('bundled plugin identity is invalid');
	return { id: parsed.id, version: parsed.version };
}

function parseJsonObject(serialized: string, errorMessage: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(serialized);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
			throw new Error(errorMessage);
		return parsed as Record<string, unknown>;
	} catch {
		throw new Error(errorMessage);
	}
}

async function writeArtifact(outputPath: string, artifact: Uint8Array): Promise<void> {
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, artifact);
}

void main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
