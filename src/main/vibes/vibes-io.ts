// VIBES File I/O — Reads and writes .ai-audit/ directory files directly from Maestro.
// This is the "fast path" for annotation writing that bypasses the vibescheck binary,
// allowing Maestro to write annotations in real-time during agent sessions.
//
// Features:
// - Async write buffer batches annotation writes (flush every 2s or 20 annotations)
// - Non-blocking appendAnnotation/appendAnnotations (add to buffer, return immediately)
// - Debounced manifest writes (read-modify-write with coalescing)
// - Per-project file locking to prevent concurrent write corruption
// - Graceful error handling (log + never crash the agent session)

import { mkdir, readFile, writeFile, appendFile, access, constants, open, rename } from 'fs/promises';
import * as path from 'path';

import type {
	VibesAssuranceLevel,
	VibesConfig,
	VibesManifest,
	VibesManifestEntry,
	VibesAnnotation,
} from '../../shared/vibes-types';

// ============================================================================
// Constants
// ============================================================================

/** Name of the audit directory at the project root. */
const AUDIT_DIR = '.ai-audit';

/** Name of the blobs subdirectory for external data. */
const BLOBS_DIR = 'blobs';

/** Config file name. */
const CONFIG_FILE = 'config.json';

/** Manifest file name. */
const MANIFEST_FILE = 'manifest.json';

/** Annotations JSONL file name. */
const ANNOTATIONS_FILE = 'annotations.jsonl';

/** Maximum annotations in the write buffer before auto-flush. */
const BUFFER_FLUSH_SIZE = 20;

/** Interval in ms between automatic buffer flushes. */
const BUFFER_FLUSH_INTERVAL_MS = 2000;

/** Debounce delay in ms for manifest writes. */
const MANIFEST_DEBOUNCE_MS = 500;

// ============================================================================
// Logging
// ============================================================================

/** Logger stub — warn level so instrumentation failures are non-critical. */
function logWarn(message: string, error?: unknown): void {
	const errMsg = error instanceof Error ? error.message : String(error ?? '');
	console.warn(`[vibes-io] ${message}${errMsg ? `: ${errMsg}` : ''}`);
}

// ============================================================================
// Atomic File Writes
// ============================================================================

/**
 * Write a file atomically: write to a temp file, fsync, then rename.
 * On POSIX systems, rename() is atomic, so readers will either see the
 * old content or the new content — never a partial write.
 */
async function atomicWriteFile(filePath: string, data: string): Promise<void> {
	const tmpPath = `${filePath}.tmp`;
	const fh = await open(tmpPath, 'w');
	try {
		await fh.writeFile(data, 'utf8');
		await fh.sync();
	} finally {
		await fh.close();
	}
	await rename(tmpPath, filePath);
}

// ============================================================================
// Per-Project Mutex (In-Process Serialization)
// ============================================================================

/** In-memory promise chain per project path for serializing writes within this process. */
const projectMutexes: Map<string, Promise<void>> = new Map();

/**
 * Serialize async operations per project path.
 * Ensures only one write operation runs at a time for each project,
 * preventing corruption from concurrent read-modify-write cycles.
 * Uses promise chaining (no setTimeout) so it works with fake timers in tests.
 */
function withProjectLock(projectPath: string, fn: () => Promise<void>): Promise<void> {
	const prev = projectMutexes.get(projectPath) ?? Promise.resolve();
	const next = prev.then(fn, fn); // Run fn regardless of prev outcome
	projectMutexes.set(projectPath, next);
	// Clean up reference when done to prevent unbounded map growth
	next.then(() => {
		if (projectMutexes.get(projectPath) === next) {
			projectMutexes.delete(projectPath);
		}
	});
	return next;
}

// ============================================================================
// Write Buffer
// ============================================================================

/** Per-project annotation write buffer. */
interface ProjectBuffer {
	annotations: VibesAnnotation[];
	timer: ReturnType<typeof setTimeout> | null;
}

/** Global map of project path → annotation write buffer. */
const annotationBuffers: Map<string, ProjectBuffer> = new Map();

/** Per-project manifest debounce state. */
interface ManifestDebounce {
	pendingEntries: Map<string, VibesManifestEntry>;
	timer: ReturnType<typeof setTimeout> | null;
}

/** Global map of project path → manifest debounce state. */
const manifestDebounces: Map<string, ManifestDebounce> = new Map();

/**
 * Get or create the annotation buffer for a project.
 */
function getBuffer(projectPath: string): ProjectBuffer {
	let buf = annotationBuffers.get(projectPath);
	if (!buf) {
		buf = { annotations: [], timer: null };
		annotationBuffers.set(projectPath, buf);
	}
	return buf;
}

/**
 * Schedule an auto-flush timer for the given project buffer.
 * If a timer is already running, this is a no-op.
 */
function scheduleFlush(projectPath: string, buf: ProjectBuffer): void {
	if (buf.timer !== null) {
		return;
	}
	buf.timer = setTimeout(() => {
		buf.timer = null;
		flushAnnotationBuffer(projectPath).catch((err) => {
			logWarn('Auto-flush failed', err);
		});
	}, BUFFER_FLUSH_INTERVAL_MS);
}

/**
 * Flush the annotation write buffer for a specific project.
 * Writes all buffered annotations to disk in a single append call.
 * Serialized per project via in-memory mutex to prevent concurrent writes.
 */
async function flushAnnotationBuffer(projectPath: string): Promise<void> {
	const buf = annotationBuffers.get(projectPath);
	if (!buf || buf.annotations.length === 0) {
		return;
	}

	return withProjectLock(projectPath, async () => {
		// Re-check after acquiring lock (buffer may have been flushed by another call)
		if (buf.annotations.length === 0) {
			return;
		}

		// Drain the buffer
		const toWrite = buf.annotations.splice(0);
		if (buf.timer !== null) {
			clearTimeout(buf.timer);
			buf.timer = null;
		}

		try {
			await ensureAuditDir(projectPath);
			const annotationsPath = path.join(projectPath, AUDIT_DIR, ANNOTATIONS_FILE);
			const lines = toWrite.map((a) => JSON.stringify(a)).join('\n') + '\n';
			// appendFile is safe for concurrent appends within the same file
			await appendFile(annotationsPath, lines, 'utf8');
		} catch (err) {
			logWarn('Failed to flush annotation buffer', err);
		}
	});
}

/**
 * Flush pending manifest entries for a specific project.
 * Serialized per project via in-memory mutex to prevent concurrent writes.
 */
async function flushManifestDebounce(projectPath: string): Promise<void> {
	const state = manifestDebounces.get(projectPath);
	if (!state || state.pendingEntries.size === 0) {
		return;
	}

	return withProjectLock(projectPath, async () => {
		// Re-check after acquiring lock
		if (!state || state.pendingEntries.size === 0) {
			return;
		}

		// Drain pending entries
		const entries = new Map(state.pendingEntries);
		state.pendingEntries.clear();
		if (state.timer !== null) {
			clearTimeout(state.timer);
			state.timer = null;
		}

		try {
			await ensureAuditDir(projectPath);
			const manifest = await readVibesManifest(projectPath);

			// Version compatibility check — warn but still write (fail open).
			// readVibesManifest() already validates, but we log an extra note
			// when we're about to modify a manifest with an unexpected version.
			if (manifest.version !== '1.0') {
				logWarn(`Adding entries to manifest with version '${manifest.version}' — proceeding (forward-compat)`);
			}

			let changed = false;
			for (const [hash, entry] of entries) {
				if (!(hash in manifest.entries)) {
					manifest.entries[hash] = entry;
					changed = true;
				}
			}
			if (changed) {
				await writeVibesManifest(projectPath, manifest);
			}
		} catch (err) {
			logWarn('Failed to flush manifest debounce', err);
		}
	});
}

// ============================================================================
// Directory Management
// ============================================================================

/**
 * Ensure the .ai-audit/ and .ai-audit/blobs/ directories exist.
 * Creates them recursively if they don't exist.
 */
export async function ensureAuditDir(projectPath: string): Promise<void> {
	const auditDir = path.join(projectPath, AUDIT_DIR);
	const blobsDir = path.join(auditDir, BLOBS_DIR);

	await mkdir(auditDir, { recursive: true });
	await mkdir(blobsDir, { recursive: true });
}

// ============================================================================
// External Blob Storage
// ============================================================================

/**
 * Write reasoning data to an external blob file at `.ai-audit/blobs/{hash}.blob`.
 * Used for very large reasoning traces that exceed the external blob threshold.
 * Ensures the blobs directory exists before writing.
 *
 * Returns the relative blob path (e.g. `blobs/{hash}.blob`).
 */
export async function writeReasoningBlob(
	projectPath: string,
	hash: string,
	data: Buffer | string,
): Promise<string> {
	await ensureAuditDir(projectPath);
	const blobFileName = `${hash}.blob`;
	const blobPath = path.join(projectPath, AUDIT_DIR, BLOBS_DIR, blobFileName);
	if (typeof data === 'string') {
		await writeFile(blobPath, data, 'utf8');
	} else {
		await writeFile(blobPath, data);
	}
	return `${BLOBS_DIR}/${blobFileName}`;
}

// ============================================================================
// Config
// ============================================================================

/**
 * Read and parse the .ai-audit/config.json file.
 * Returns null if the file does not exist or cannot be parsed.
 * Validates that `standard === 'VIBES'` and `standard_version === '1.0'`.
 * Logs a warning if the version is unsupported but still returns the config (fail open).
 */
export async function readVibesConfig(projectPath: string): Promise<VibesConfig | null> {
	const configPath = path.join(projectPath, AUDIT_DIR, CONFIG_FILE);
	try {
		await access(configPath, constants.F_OK);
		const raw = await readFile(configPath, 'utf8');
		const config = JSON.parse(raw) as VibesConfig;

		// Validate standard and version — warn but don't block (fail open)
		if (config.standard !== 'VIBES') {
			logWarn(`Config has unexpected standard: '${config.standard}' (expected 'VIBES')`);
		}
		if (config.standard_version !== '1.0') {
			logWarn(`Config has unsupported standard_version: '${config.standard_version}' (expected '1.0')`);
		}

		return config;
	} catch {
		return null;
	}
}

/**
 * Write the config.json file with pretty formatting (2-tab indentation).
 * Creates the .ai-audit/ directory if it doesn't exist.
 */
export async function writeVibesConfig(projectPath: string, config: VibesConfig): Promise<void> {
	await ensureAuditDir(projectPath);
	const configPath = path.join(projectPath, AUDIT_DIR, CONFIG_FILE);
	await atomicWriteFile(configPath, JSON.stringify(config, null, '\t') + '\n');
}

// ============================================================================
// Manifest
// ============================================================================

/**
 * Read and parse the .ai-audit/manifest.json file.
 * Returns an empty manifest if the file does not exist.
 * Validates that `standard === 'VIBES'` and `version === '1.0'`.
 * Logs a warning if the version is unsupported but still returns the manifest (fail open).
 */
export async function readVibesManifest(projectPath: string): Promise<VibesManifest> {
	const manifestPath = path.join(projectPath, AUDIT_DIR, MANIFEST_FILE);
	try {
		await access(manifestPath, constants.F_OK);
		const raw = await readFile(manifestPath, 'utf8');
		const manifest = JSON.parse(raw) as VibesManifest;

		// Validate standard and version — warn but don't block (fail open)
		if (manifest.standard !== 'VIBES') {
			logWarn(`Manifest has unexpected standard: '${manifest.standard}' (expected 'VIBES')`);
		}
		if (manifest.version !== '1.0') {
			logWarn(`Manifest has unsupported version: '${manifest.version}' (expected '1.0')`);
		}

		return manifest;
	} catch {
		return { standard: 'VIBES', version: '1.0', entries: {} };
	}
}

/**
 * Write the manifest.json file with pretty formatting.
 * Creates the .ai-audit/ directory if it doesn't exist.
 */
export async function writeVibesManifest(
	projectPath: string,
	manifest: VibesManifest,
): Promise<void> {
	await ensureAuditDir(projectPath);
	const manifestPath = path.join(projectPath, AUDIT_DIR, MANIFEST_FILE);
	await atomicWriteFile(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
}

// ============================================================================
// Annotations (Immediate — for critical records)
// ============================================================================

/**
 * Append a single annotation directly to disk, bypassing the write buffer.
 * Uses the per-project lock for serialization but does NOT buffer — the
 * annotation is guaranteed on disk when the returned promise resolves.
 *
 * Use this for critical audit records (session start/end) where data loss
 * on hard crash is unacceptable. For high-frequency annotations where
 * occasional loss is tolerable, use {@link appendAnnotation} instead.
 */
export async function appendAnnotationImmediate(
	projectPath: string,
	annotation: VibesAnnotation,
): Promise<void> {
	return withProjectLock(projectPath, async () => {
		try {
			await ensureAuditDir(projectPath);
			const annotationsPath = path.join(projectPath, AUDIT_DIR, ANNOTATIONS_FILE);
			const line = JSON.stringify(annotation) + '\n';
			await appendFile(annotationsPath, line, 'utf8');
		} catch (err) {
			logWarn('Failed to write annotation immediately', err);
		}
	});
}

// ============================================================================
// Annotations (Buffered)
// ============================================================================

/**
 * Append a single annotation to the write buffer.
 * Non-blocking — adds to in-memory buffer and returns immediately.
 * The buffer auto-flushes every 2s or when 20 annotations are buffered.
 */
export async function appendAnnotation(
	projectPath: string,
	annotation: VibesAnnotation,
): Promise<void> {
	try {
		const buf = getBuffer(projectPath);
		buf.annotations.push(annotation);

		if (buf.annotations.length >= BUFFER_FLUSH_SIZE) {
			// Trigger immediate flush but don't await — keep non-blocking
			flushAnnotationBuffer(projectPath).catch((err) => {
				logWarn('Flush on size threshold failed', err);
			});
		} else {
			scheduleFlush(projectPath, buf);
		}
	} catch (err) {
		logWarn('Failed to buffer annotation', err);
	}
}

/**
 * Append multiple annotations to the write buffer.
 * Non-blocking — adds to in-memory buffer and returns immediately.
 */
export async function appendAnnotations(
	projectPath: string,
	annotations: VibesAnnotation[],
): Promise<void> {
	if (annotations.length === 0) {
		return;
	}
	try {
		const buf = getBuffer(projectPath);
		buf.annotations.push(...annotations);

		if (buf.annotations.length >= BUFFER_FLUSH_SIZE) {
			flushAnnotationBuffer(projectPath).catch((err) => {
				logWarn('Flush on size threshold failed', err);
			});
		} else {
			scheduleFlush(projectPath, buf);
		}
	} catch (err) {
		logWarn('Failed to buffer annotations', err);
	}
}

/**
 * Read and parse all annotations from the .ai-audit/annotations.jsonl file.
 * Returns an empty array if the file does not exist.
 * Skips blank lines gracefully.
 */
export async function readAnnotations(projectPath: string): Promise<VibesAnnotation[]> {
	// Flush any pending annotations first so reads are consistent
	await flushAnnotationBuffer(projectPath);

	const annotationsPath = path.join(projectPath, AUDIT_DIR, ANNOTATIONS_FILE);
	try {
		await access(annotationsPath, constants.F_OK);
		const raw = await readFile(annotationsPath, 'utf8');
		return raw
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as VibesAnnotation);
	} catch {
		return [];
	}
}

// ============================================================================
// Manifest Entry Management (Debounced)
// ============================================================================

/**
 * Add an entry to the manifest if the hash is not already present.
 * Uses debounced writes — manifest changes are coalesced within a 500ms window,
 * then flushed as a single read-modify-write operation with file locking.
 */
export async function addManifestEntry(
	projectPath: string,
	hash: string,
	entry: VibesManifestEntry,
): Promise<void> {
	try {
		let state = manifestDebounces.get(projectPath);
		if (!state) {
			state = { pendingEntries: new Map(), timer: null };
			manifestDebounces.set(projectPath, state);
		}

		state.pendingEntries.set(hash, entry);

		// Reset debounce timer
		if (state.timer !== null) {
			clearTimeout(state.timer);
		}
		state.timer = setTimeout(() => {
			state!.timer = null;
			flushManifestDebounce(projectPath).catch((err) => {
				logWarn('Manifest debounce flush failed', err);
			});
		}, MANIFEST_DEBOUNCE_MS);
	} catch (err) {
		logWarn('Failed to schedule manifest entry', err);
	}
}

// ============================================================================
// Flush All (Session End / Shutdown)
// ============================================================================

/**
 * Force-flush all pending writes across all projects.
 * Called on session end and app shutdown to ensure no data is lost.
 */
export async function flushAll(): Promise<void> {
	const flushPromises: Promise<void>[] = [];

	// Flush all annotation buffers
	for (const projectPath of annotationBuffers.keys()) {
		flushPromises.push(
			flushAnnotationBuffer(projectPath).catch((err) => {
				logWarn(`flushAll: annotation flush failed for ${projectPath}`, err);
			}),
		);
	}

	// Flush all manifest debounces
	for (const projectPath of manifestDebounces.keys()) {
		flushPromises.push(
			flushManifestDebounce(projectPath).catch((err) => {
				logWarn(`flushAll: manifest flush failed for ${projectPath}`, err);
			}),
		);
	}

	await Promise.all(flushPromises);
}

// ============================================================================
// Direct Initialization (Fallback when vibescheck binary is unavailable)
// ============================================================================

/**
 * Initialize the VIBES directory structure directly without the vibescheck binary.
 * Creates `.ai-audit/`, `.ai-audit/blobs/`, `config.json`, `manifest.json`,
 * and an empty `annotations.jsonl`. Used as a fallback when the vibescheck
 * CLI is not installed.
 *
 * Returns `{ success: true }` on success, `{ success: false, error }` on failure.
 */
export async function initVibesDirectly(
	projectPath: string,
	config: {
		projectName: string;
		assuranceLevel: VibesAssuranceLevel;
		trackedExtensions?: string[];
		excludePatterns?: string[];
	},
): Promise<{ success: boolean; error?: string }> {
	try {
		await ensureAuditDir(projectPath);

		const vibesConfig: VibesConfig = {
			standard: 'VIBES',
			standard_version: '1.0',
			assurance_level: config.assuranceLevel,
			project_name: config.projectName,
			tracked_extensions: config.trackedExtensions ?? [
				'.ts', '.tsx', '.js', '.jsx', '.py', '.rs',
				'.go', '.java', '.c', '.cpp', '.rb', '.swift', '.kt',
			],
			exclude_patterns: config.excludePatterns ?? [
				'**/node_modules/**',
				'**/vendor/**',
				'**/.venv/**',
				'**/dist/**',
				'**/target/**',
				'**/.git/**',
				'**/build/**',
			],
			compress_reasoning_threshold_bytes: 10240,
			external_blob_threshold_bytes: 102400,
		};

		await writeVibesConfig(projectPath, vibesConfig);

		// Create empty manifest if it doesn't exist
		const manifestPath = path.join(projectPath, AUDIT_DIR, MANIFEST_FILE);
		try {
			await access(manifestPath, constants.F_OK);
		} catch {
			await writeVibesManifest(projectPath, {
				standard: 'VIBES',
				version: '1.0',
				entries: {},
			});
		}

		// Create empty annotations file if it doesn't exist
		const annotationsPath = path.join(projectPath, AUDIT_DIR, ANNOTATIONS_FILE);
		try {
			await access(annotationsPath, constants.F_OK);
		} catch {
			await writeFile(annotationsPath, '', 'utf8');
		}

		return { success: true };
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		logWarn('Direct VIBES initialization failed', err);
		return { success: false, error: errMsg };
	}
}

// ============================================================================
// Buffer Inspection (Testing)
// ============================================================================

/**
 * Get the number of buffered (unflushed) annotations for a project.
 * Primarily used for testing.
 */
export function getBufferedAnnotationCount(projectPath: string): number {
	const buf = annotationBuffers.get(projectPath);
	return buf ? buf.annotations.length : 0;
}

/**
 * Get the number of pending (unflushed) manifest entries for a project.
 * Primarily used for testing.
 */
export function getPendingManifestEntryCount(projectPath: string): number {
	const state = manifestDebounces.get(projectPath);
	return state ? state.pendingEntries.size : 0;
}

/**
 * Clear all buffers and timers. Used in tests for cleanup.
 */
export function resetAllBuffers(): void {
	for (const buf of annotationBuffers.values()) {
		if (buf.timer !== null) {
			clearTimeout(buf.timer);
		}
	}
	annotationBuffers.clear();

	for (const state of manifestDebounces.values()) {
		if (state.timer !== null) {
			clearTimeout(state.timer);
		}
	}
	manifestDebounces.clear();

	projectMutexes.clear();
}
