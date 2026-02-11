// VIBES File I/O — Reads and writes .ai-audit/ directory files directly from Maestro.
// This is the "fast path" for annotation writing that bypasses the vibescheck binary,
// allowing Maestro to write annotations in real-time during agent sessions.

import { mkdir, readFile, writeFile, appendFile, access, constants } from 'fs/promises';
import * as path from 'path';

import type {
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
// Config
// ============================================================================

/**
 * Read and parse the .ai-audit/config.json file.
 * Returns null if the file does not exist or cannot be parsed.
 */
export async function readVibesConfig(projectPath: string): Promise<VibesConfig | null> {
	const configPath = path.join(projectPath, AUDIT_DIR, CONFIG_FILE);
	try {
		await access(configPath, constants.F_OK);
		const raw = await readFile(configPath, 'utf8');
		return JSON.parse(raw) as VibesConfig;
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
	await writeFile(configPath, JSON.stringify(config, null, '\t') + '\n', 'utf8');
}

// ============================================================================
// Manifest
// ============================================================================

/**
 * Read and parse the .ai-audit/manifest.json file.
 * Returns an empty manifest if the file does not exist.
 */
export async function readVibesManifest(projectPath: string): Promise<VibesManifest> {
	const manifestPath = path.join(projectPath, AUDIT_DIR, MANIFEST_FILE);
	try {
		await access(manifestPath, constants.F_OK);
		const raw = await readFile(manifestPath, 'utf8');
		return JSON.parse(raw) as VibesManifest;
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
	await writeFile(manifestPath, JSON.stringify(manifest, null, '\t') + '\n', 'utf8');
}

// ============================================================================
// Annotations
// ============================================================================

/**
 * Append a single annotation as a JSONL line to .ai-audit/annotations.jsonl.
 * Uses file append mode for safe concurrent writes.
 */
export async function appendAnnotation(
	projectPath: string,
	annotation: VibesAnnotation,
): Promise<void> {
	await ensureAuditDir(projectPath);
	const annotationsPath = path.join(projectPath, AUDIT_DIR, ANNOTATIONS_FILE);
	const line = JSON.stringify(annotation) + '\n';
	await appendFile(annotationsPath, line, 'utf8');
}

/**
 * Append multiple annotations as JSONL lines atomically.
 * All annotations are written in a single appendFile call to minimize
 * the window for interleaving with concurrent writes.
 */
export async function appendAnnotations(
	projectPath: string,
	annotations: VibesAnnotation[],
): Promise<void> {
	if (annotations.length === 0) {
		return;
	}
	await ensureAuditDir(projectPath);
	const annotationsPath = path.join(projectPath, AUDIT_DIR, ANNOTATIONS_FILE);
	const lines = annotations.map((a) => JSON.stringify(a)).join('\n') + '\n';
	await appendFile(annotationsPath, lines, 'utf8');
}

/**
 * Read and parse all annotations from the .ai-audit/annotations.jsonl file.
 * Returns an empty array if the file does not exist.
 * Skips blank lines gracefully.
 */
export async function readAnnotations(projectPath: string): Promise<VibesAnnotation[]> {
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
// Manifest Entry Management
// ============================================================================

/**
 * Add an entry to the manifest if the hash is not already present.
 * Reads the current manifest, adds the entry, and writes it back.
 */
export async function addManifestEntry(
	projectPath: string,
	hash: string,
	entry: VibesManifestEntry,
): Promise<void> {
	const manifest = await readVibesManifest(projectPath);
	if (!(hash in manifest.entries)) {
		manifest.entries[hash] = entry;
		await writeVibesManifest(projectPath, manifest);
	}
}
