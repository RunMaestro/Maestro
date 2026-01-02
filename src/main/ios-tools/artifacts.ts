/**
 * iOS Tools - Artifact Management
 *
 * Functions for managing artifact directories where screenshots,
 * logs, and other captured data are stored.
 */

import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[iOS-Artifacts]';

// =============================================================================
// Artifact Directory Management
// =============================================================================

/**
 * Base directory for all iOS artifacts.
 * Default: ~/Library/Application Support/Maestro/ios-artifacts
 */
function getBaseArtifactDirectory(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'ios-artifacts');
}

/**
 * Get or create artifact directory for a session.
 * Creates a timestamped subdirectory for the session.
 *
 * @param sessionId - Session identifier (Maestro session ID)
 * @returns Path to the session's artifact directory
 */
export async function getArtifactDirectory(sessionId: string): Promise<string> {
  const baseDir = getBaseArtifactDirectory();
  const sessionDir = path.join(baseDir, sessionId);

  try {
    await fs.mkdir(sessionDir, { recursive: true });
    logger.debug(`${LOG_CONTEXT} Artifact directory ready: ${sessionDir}`);
  } catch (error) {
    logger.error(`${LOG_CONTEXT} Failed to create artifact directory: ${error}`);
    throw error;
  }

  return sessionDir;
}

/**
 * Get artifact directory for a specific snapshot.
 * Creates subdirectory: {sessionDir}/{snapshotId}/
 *
 * @param sessionId - Session identifier
 * @param snapshotId - Unique snapshot identifier
 * @returns Path to the snapshot's artifact directory
 */
export async function getSnapshotDirectory(sessionId: string, snapshotId: string): Promise<string> {
  const sessionDir = await getArtifactDirectory(sessionId);
  const snapshotDir = path.join(sessionDir, snapshotId);

  try {
    await fs.mkdir(snapshotDir, { recursive: true });
  } catch (error) {
    logger.error(`${LOG_CONTEXT} Failed to create snapshot directory: ${error}`);
    throw error;
  }

  return snapshotDir;
}

/**
 * Generate a unique snapshot ID based on timestamp.
 * Format: snapshot-YYYYMMDD-HHmmss-SSS
 *
 * @returns Unique snapshot identifier
 */
export function generateSnapshotId(): string {
  const now = new Date();
  const datePart = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const msPart = now.getMilliseconds().toString().padStart(3, '0');
  return `snapshot-${datePart}-${msPart}`;
}

/**
 * List all artifacts for a session.
 *
 * @param sessionId - Session identifier
 * @returns Array of snapshot directory names
 */
export async function listSessionArtifacts(sessionId: string): Promise<string[]> {
  const sessionDir = path.join(getBaseArtifactDirectory(), sessionId);

  try {
    const entries = await fs.readdir(sessionDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (error) {
    // Directory doesn't exist yet
    return [];
  }
}

/**
 * Clean old artifacts beyond retention limit.
 * Keeps the most recent N artifacts per session.
 *
 * @param sessionId - Session identifier
 * @param keepCount - Number of artifacts to keep (default: 50)
 */
export async function pruneSessionArtifacts(sessionId: string, keepCount: number = 50): Promise<void> {
  const sessionDir = path.join(getBaseArtifactDirectory(), sessionId);

  try {
    const entries = await fs.readdir(sessionDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    // Sort by name (which includes timestamp, so oldest first)
    dirs.sort();

    // Remove oldest entries beyond keepCount
    const toRemove = dirs.slice(0, Math.max(0, dirs.length - keepCount));

    for (const dir of toRemove) {
      const dirPath = path.join(sessionDir, dir);
      await fs.rm(dirPath, { recursive: true, force: true });
      logger.debug(`${LOG_CONTEXT} Pruned old artifact: ${dirPath}`);
    }

    if (toRemove.length > 0) {
      logger.info(`${LOG_CONTEXT} Pruned ${toRemove.length} old artifacts from session ${sessionId}`);
    }
  } catch (error) {
    logger.warn(`${LOG_CONTEXT} Could not prune artifacts: ${error}`);
  }
}

/**
 * Get total size of artifacts for a session.
 *
 * @param sessionId - Session identifier
 * @returns Total size in bytes
 */
export async function getSessionArtifactsSize(sessionId: string): Promise<number> {
  const sessionDir = path.join(getBaseArtifactDirectory(), sessionId);

  try {
    return await getDirectorySize(sessionDir);
  } catch (error) {
    return 0;
  }
}

/**
 * Recursively calculate directory size.
 */
async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        totalSize += await getDirectorySize(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        totalSize += stat.size;
      }
    }
  } catch (error) {
    // Ignore errors for individual entries
  }

  return totalSize;
}
