import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
	buildPluginArtifact,
	parsePluginArtifact,
	type ImmutableTrustRoot,
} from '../../src/main/omp-distribution/plugin-artifact';
import { OmpPluginTrustRootService } from '../../src/main/plugins/plugin-trust-root-service';

const FIXTURE_PRIVATE_KEY_DER = 'MC4CAQAwBQYDK2VwBCIEIATZdg3OinGZQrI/FN1Juqj8tMJ6tlO7wTo66mAwm559';
const FIXTURE_PUBLIC_KEY_DER = 'MCowBQYDK2VwAyEApeeetOdf9i8GFMKRV+II3au9y25X4c9BqobTCGJDle8=';
const FIXTURE_PRIVATE_KEY = createPrivateKey({
	key: Buffer.from(FIXTURE_PRIVATE_KEY_DER, 'base64'),
	format: 'der',
	type: 'pkcs8',
});
const FIXTURE_PUBLIC_KEY = createPublicKey({
	key: Buffer.from(FIXTURE_PUBLIC_KEY_DER, 'base64'),
	format: 'der',
	type: 'spki',
});

export const OMP_FIXTURE_TRUST_ROOT: ImmutableTrustRoot = Object.freeze({
	keyId: 'maestro-omp-fixture-root-2026-07',
	algorithm: 'ed25519',
	publicKey: FIXTURE_PUBLIC_KEY_DER,
});

const RUNTIME_SOURCE = `#!/usr/bin/env bun
import fs from 'node:fs';
import readline from 'node:readline';

const logPath = process.env.OMP_FIXTURE_JSONL;
const emit = (message) => {
	const json = JSON.stringify(message);
	process.stdout.write(json + '\\n');
	if (logPath) fs.appendFileSync(logPath, json + '\\n');
};

emit({ type: 'ready', version: '16.4.8', fixture: true });
emit({ type: 'state', state: 'idle', sessionId: 'omp-fixture-session' });
emit({ type: 'models', models: [{ id: 'fixture-16.4.8', name: 'Fixture 16.4.8' }] });

let retries = 0;
for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	let request;
	try {
		request = JSON.parse(line);
	} catch {
		emit({ type: 'error', code: 'invalid_json' });
		continue;
	}
	const command = request.command ?? request.type;
	if (command === 'get_state') {
		emit({ type: 'state', state: 'idle', sessionId: 'omp-fixture-session' });
	} else if (command === 'prompt') {
		emit({ type: 'state', state: 'streaming', sessionId: 'omp-fixture-session' });
		emit({ type: 'stream', delta: 'fixture response' });
		emit({ type: 'tool', name: 'fixture-tool', input: { attachmentCount: request.attachments?.length ?? 0 } });
		emit({ type: 'approval', id: 'fixture-approval', action: 'fixture-tool' });
	} else if (command === 'approve') {
		emit({ type: 'stream', delta: ' approved' });
		emit({ type: 'complete', sessionId: 'omp-fixture-session' });
		emit({ type: 'state', state: 'idle', sessionId: 'omp-fixture-session' });
	} else if (command === 'steer') {
		emit({ type: 'stream', delta: ' steered' });
	} else if (command === 'abort') {
		emit({ type: 'aborted', sessionId: 'omp-fixture-session' });
		emit({ type: 'state', state: 'idle', sessionId: 'omp-fixture-session' });
	} else if (command === 'retry') {
		retries += 1;
		emit({ type: 'retry', attempt: retries });
	} else if (command === 'crash') {
		emit({ type: 'crash', code: 'fixture_crash' });
		process.exit(86);
	} else {
		emit({ type: 'error', code: 'unknown_command' });
	}
}
`;

const PLUGIN_ENTRY_SOURCE = `export const fixtureRuntime = '16.4.8';\n`;

const PLUGIN_MANIFEST = JSON.stringify({
	id: 'com.maestro.omp',
	name: 'OMP Fixture',
	version: '1.0.0',
	tier: 1,
	maestro: { minHostApi: '1.0.0' },
	entry: 'index.js',
	permissions: [],
});

export interface OmpFixture {
	readonly root: string;
	readonly artifactPath: string;
	readonly runtimePath: string;
	readonly runtimeExecutable: string;
	readonly logPath: string;
	readonly sha256: string;
	readonly trustRoot: ImmutableTrustRoot;
}

export function createOmpFixture(root: string): OmpFixture {
	const fixtureRoot = path.join(root, 'omp-fixture');
	const artifactPath = path.join(fixtureRoot, 'com.maestro.omp.omp');
	const runtimePath = path.join(fixtureRoot, 'omp-fixture-runtime.mjs');
	const runtimeExecutable =
		process.platform === 'win32' ? path.join(fixtureRoot, 'omp-fixture-runtime.cmd') : runtimePath;
	const logPath = path.join(fixtureRoot, 'protocol.jsonl');
	fs.mkdirSync(fixtureRoot, { recursive: true });
	fs.writeFileSync(runtimePath, RUNTIME_SOURCE, { encoding: 'utf8', mode: 0o755 });
	if (process.platform === 'win32') {
		fs.writeFileSync(
			runtimeExecutable,
			'@echo off\r\nbun "%~dp0omp-fixture-runtime.mjs" %*\r\n',
			'utf8'
		);
	}
	const artifact = buildPluginArtifact({
		pluginId: 'com.maestro.omp',
		version: '1.0.0',
		contractSha256: 'f'.repeat(64),
		trustRoot: OMP_FIXTURE_TRUST_ROOT,
		files: [
			{ path: 'index.js', content: Buffer.from(PLUGIN_ENTRY_SOURCE) },
			{ path: 'plugin.json', content: Buffer.from(PLUGIN_MANIFEST) },
			{ path: 'runtime/omp-fixture-runtime.mjs', content: Buffer.from(RUNTIME_SOURCE) },
		],
		sign: (payload) => sign(null, payload, FIXTURE_PRIVATE_KEY).toString('base64url'),
	});
	fs.writeFileSync(artifactPath, artifact);
	return Object.freeze({
		root,
		artifactPath,
		runtimePath,
		runtimeExecutable,
		logPath,
		sha256: sha256(artifact),
		trustRoot: OMP_FIXTURE_TRUST_ROOT,
	});
}

export function installOmpFixture(fixture: OmpFixture): string {
	const pluginsDir = path.join(fixture.root, 'userData', 'plugins');
	const service = new OmpPluginTrustRootService({
		pluginsDir,
		trustRoot: fixture.trustRoot,
		verifySignature: verifyFixtureSignature,
	});
	service.installOrUpdateArchive({
		archivePath: fixture.artifactPath,
		expectedSha256: fixture.sha256,
		owner: 'bundle',
	});
	return path.join(pluginsDir, 'com.maestro.omp');
}

export function verifyOmpFixtureArtifact(fixture: OmpFixture): { valid: true } {
	const artifact = fs.readFileSync(fixture.artifactPath);
	const parsed = parsePluginArtifact(artifact, fixture.trustRoot);
	const { signature, ...unsigned } = parsed;
	const payload = Buffer.from(canonicalJson(unsigned));
	if (!verifyFixtureSignature(payload, signature, fixture.trustRoot)) {
		throw new Error('fixture artifact signature verification failed');
	}
	return { valid: true };
}

export function readFixtureJsonl(logPath: string): readonly Record<string, unknown>[] {
	if (!fs.existsSync(logPath)) return [];
	return fs
		.readFileSync(logPath, 'utf8')
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

export interface OmpFixtureProtocolResult {
	readonly exitCode: number | null;
	readonly messages: readonly Record<string, unknown>[];
}

export async function runOmpFixtureProtocol(
	fixture: OmpFixture,
	requests: readonly Record<string, unknown>[]
): Promise<OmpFixtureProtocolResult> {
	const command = process.platform === 'win32' ? fixture.runtimeExecutable : 'bun';
	const args = process.platform === 'win32' ? [] : [fixture.runtimePath];
	const child = spawn(command, args, {
		cwd: fixture.root,
		env: { ...process.env, OMP_FIXTURE_JSONL: fixture.logPath },
		shell: process.platform === 'win32',
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	let stdout = '';
	let stderr = '';
	child.stdout.on('data', (chunk: Buffer) => {
		stdout += chunk.toString('utf8');
	});
	child.stderr.on('data', (chunk: Buffer) => {
		stderr += chunk.toString('utf8');
	});
	for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
	child.stdin.end();

	const { promise, resolve, reject } = Promise.withResolvers<OmpFixtureProtocolResult>();
	child.once('error', reject);
	child.once('close', (exitCode) => {
		if (stderr.length > 0) {
			reject(new Error(`OMP fixture runtime wrote stderr: ${stderr}`));
			return;
		}
		try {
			resolve({
				exitCode,
				messages: stdout
					.split(/\r?\n/)
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Record<string, unknown>),
			});
		} catch (error) {
			reject(error);
		}
	});
	return promise;
}

function verifyFixtureSignature(
	payload: Uint8Array,
	signature: string,
	trustRoot: ImmutableTrustRoot
): boolean {
	return (
		trustRoot.keyId === OMP_FIXTURE_TRUST_ROOT.keyId &&
		trustRoot.algorithm === OMP_FIXTURE_TRUST_ROOT.algorithm &&
		trustRoot.publicKey === OMP_FIXTURE_TRUST_ROOT.publicKey &&
		verify(null, payload, FIXTURE_PUBLIC_KEY, Buffer.from(signature, 'base64url'))
	);
}

function sha256(value: Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(',')}}`;
}
