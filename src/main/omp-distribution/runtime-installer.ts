import { createHash } from 'crypto';

export interface RuntimeFile {
	path: string;
	content: Uint8Array;
}

export interface ManagedRuntimeRequest {
	version: string;
	executable: string;
	files: readonly RuntimeFile[];
	notices: readonly RuntimeFile[];
}

export interface RuntimeFileSystem {
	mkdir(path: string): Promise<void>;
	writeFile(path: string, content: Uint8Array): Promise<void>;
	readFile(path: string): Promise<Uint8Array>;
	exists(path: string): Promise<boolean>;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
	acquireLock(path: string): Promise<() => Promise<void>>;
}

export interface InstalledManagedRuntime {
	directory: string;
	executable: string;
}

interface RuntimeIdentity {
	version: string;
	identity: string;
}

/** Installs a verified runtime from caller-supplied files; it never discovers or executes PATH binaries. */
export async function installManagedRuntime(
	fs: RuntimeFileSystem,
	runtimeRoot: string,
	request: ManagedRuntimeRequest
): Promise<InstalledManagedRuntime> {
	validateRequest(request);
	const releaseLock = await fs.acquireLock(`${runtimeRoot}/.install.lock`);
	const identity = runtimeIdentity(request);
	const target = `${runtimeRoot}/${request.version}`;
	const staging = `${runtimeRoot}/.${request.version}.staging-${identity.slice(0, 16)}`;
	let targetCreated = false;

	try {
		await fs.mkdir(runtimeRoot);
		const current = await readCurrentIdentity(fs, `${runtimeRoot}/current.json`);
		if (current) enforceVersionPolicy(current, request.version, identity);
		if (await fs.exists(target)) {
			const existing = await readCurrentIdentity(fs, `${target}/maestro-runtime.json`);
			if (!existing || existing.identity !== identity)
				throw new Error('managed runtime equivocation detected');
			return installedRuntime(target, request.executable);
		}

		await fs.remove(staging);
		await fs.mkdir(staging);
		for (const file of request.files) await writeRuntimeFile(fs, staging, file);
		for (const notice of request.notices)
			await writeRuntimeFile(fs, `${staging}/THIRD_PARTY_NOTICES`, notice);
		await fs.writeFile(
			`${staging}/maestro-runtime.json`,
			Buffer.from(JSON.stringify({ version: request.version, identity }))
		);
		await fs.rename(staging, target);
		targetCreated = true;

		const currentStage = `${runtimeRoot}/.current-${identity.slice(0, 16)}.json`;
		await fs.writeFile(
			currentStage,
			Buffer.from(JSON.stringify({ version: request.version, identity }))
		);
		await fs.rename(currentStage, `${runtimeRoot}/current.json`);
		return installedRuntime(target, request.executable);
	} catch (error) {
		await fs.remove(staging);
		if (targetCreated) await fs.remove(target);
		throw error;
	} finally {
		await releaseLock();
	}
}

function validateRequest(request: ManagedRuntimeRequest): void {
	if (!/^\d+\.\d+\.\d+$/.test(request.version))
		throw new Error('managed runtime version is invalid');
	validateRelativePath(request.executable, 'unsafe executable');
	if (!request.files.some((file) => file.path === request.executable))
		throw new Error('managed runtime executable is absent');
	if (request.notices.length === 0) throw new Error('managed runtime has no preserved notices');
	for (const file of [...request.files, ...request.notices])
		validateRelativePath(file.path, 'unsafe runtime file');
}

function validateRelativePath(filePath: string, message: string): void {
	if (
		filePath.length === 0 ||
		filePath.startsWith('/') ||
		filePath.includes('\\') ||
		filePath.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
	) {
		throw new Error(message);
	}
}

function runtimeIdentity(request: ManagedRuntimeRequest): string {
	const digest = createHash('sha256');
	digest.update(`${request.version}\0${request.executable}\0`);
	for (const file of [...request.files].sort((left, right) =>
		left.path.localeCompare(right.path)
	)) {
		digest.update(file.path);
		digest.update('\0');
		digest.update(file.content);
		digest.update('\0');
	}
	return digest.digest('hex');
}

async function readCurrentIdentity(
	fs: RuntimeFileSystem,
	filePath: string
): Promise<RuntimeIdentity | undefined> {
	if (!(await fs.exists(filePath))) return undefined;
	try {
		const value: unknown = JSON.parse(Buffer.from(await fs.readFile(filePath)).toString('utf8'));
		if (!isRuntimeIdentity(value)) throw new Error('invalid runtime identity');
		return value;
	} catch {
		throw new Error('invalid managed runtime identity');
	}
}

function isRuntimeIdentity(value: unknown): value is RuntimeIdentity {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as RuntimeIdentity).version === 'string' &&
		typeof (value as RuntimeIdentity).identity === 'string'
	);
}

function enforceVersionPolicy(
	current: RuntimeIdentity,
	requestedVersion: string,
	requestedIdentity: string
): void {
	const comparison = compareVersions(requestedVersion, current.version);
	if (comparison < 0) throw new Error('managed runtime downgrade refused');
	if (comparison === 0 && current.identity !== requestedIdentity)
		throw new Error('managed runtime equivocation detected');
}

function compareVersions(left: string, right: string): number {
	const leftParts = left.split('.').map(Number);
	const rightParts = right.split('.').map(Number);
	for (let index = 0; index < 3; index += 1) {
		const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

async function writeRuntimeFile(
	fs: RuntimeFileSystem,
	root: string,
	file: RuntimeFile
): Promise<void> {
	const directories = file.path.split('/').slice(0, -1);
	let directory = root;
	for (const segment of directories) {
		directory = `${directory}/${segment}`;
		await fs.mkdir(directory);
	}
	await fs.writeFile(`${root}/${file.path}`, file.content);
}

function installedRuntime(directory: string, executable: string): InstalledManagedRuntime {
	return { directory, executable: `${directory}/${executable}` };
}
