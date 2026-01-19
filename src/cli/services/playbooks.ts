// Playbooks service for CLI
// Reads playbook files from the Maestro config directory

import * as fs from 'fs';
import * as path from 'path';
import { getConfigDirectory } from './storage';
import type { Playbook } from '../../shared/types';

// Playbook file structure
interface PlaybooksFile {
	playbooks: Playbook[];
}

/**
 * Get the playbooks directory path
 */
function getPlaybooksDir(): string {
	return path.join(getConfigDirectory(), 'playbooks');
}

/**
 * Get the playbooks file path for a session
 */
function getPlaybooksFilePath(sessionId: string): string {
	return path.join(getPlaybooksDir(), `${sessionId}.json`);
}

/**
 * Read playbooks for a session
 * Returns empty array if no playbooks file exists
 */
export function readPlaybooks(sessionId: string): Playbook[] {
	const filePath = getPlaybooksFilePath(sessionId);

	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		const data = JSON.parse(content) as PlaybooksFile;
		return Array.isArray(data.playbooks) ? data.playbooks : [];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
}

/**
 * Get a specific playbook by ID (supports partial IDs)
 */
export function getPlaybook(sessionId: string, playbookId: string): Playbook | undefined {
	const playbooks = readPlaybooks(sessionId);

	// First try exact match
	const exact = playbooks.find((p) => p.id === playbookId);
	if (exact) return exact;

	// Try prefix match
	const matches = playbooks.filter((p) => p.id.startsWith(playbookId));
	if (matches.length === 1) {
		return matches[0];
	}

	return undefined;
}

/**
 * Resolve a playbook ID (partial or full)
 * Throws if ambiguous or not found
 */
export function resolvePlaybookId(sessionId: string, partialId: string): string {
	const playbooks = readPlaybooks(sessionId);
	const allIds = playbooks.map((p) => p.id);

	// First try exact match
	if (allIds.includes(partialId)) {
		return partialId;
	}

	// Try prefix match
	const matches = allIds.filter((id) => id.startsWith(partialId));

	if (matches.length === 1) {
		return matches[0];
	} else if (matches.length > 1) {
		const matchList = matches
			.map((id) => {
				const playbook = playbooks.find((p) => p.id === id);
				return `  ${id.slice(0, 8)}  ${playbook?.name || 'Unknown'}`;
			})
			.join('\n');
		throw new Error(`Ambiguous playbook ID '${partialId}'. Matches:\n${matchList}`);
	}

	throw new Error(`Playbook not found: ${partialId}`);
}

/**
 * Find a playbook by ID across all agents
 * Returns the playbook and its agent ID, or throws if not found/ambiguous
 */
export function findPlaybookById(partialId: string): { playbook: Playbook; agentId: string } {
	const allPlaybooks = listAllPlaybooks();

	// First try exact match
	const exactMatch = allPlaybooks.find((p) => p.id === partialId);
	if (exactMatch) {
		return { playbook: exactMatch, agentId: exactMatch.sessionId };
	}

	// Try prefix match
	const matches = allPlaybooks.filter((p) => p.id.startsWith(partialId));

	if (matches.length === 1) {
		return { playbook: matches[0], agentId: matches[0].sessionId };
	} else if (matches.length > 1) {
		const matchList = matches.map((p) => `  ${p.id.slice(0, 8)}  ${p.name}`).join('\n');
		throw new Error(`Ambiguous playbook ID '${partialId}'. Matches:\n${matchList}`);
	}

	throw new Error(`Playbook not found: ${partialId}`);
}

/**
 * List all playbooks across all sessions
 * Returns playbooks with their session IDs
 */
export function listAllPlaybooks(): Array<Playbook & { sessionId: string }> {
	const playbooksDir = getPlaybooksDir();
	const result: Array<Playbook & { sessionId: string }> = [];

	try {
		if (!fs.existsSync(playbooksDir)) {
			return result;
		}

		const files = fs.readdirSync(playbooksDir);

		for (const file of files) {
			if (!file.endsWith('.json')) continue;

			const sessionId = file.replace('.json', '');
			const playbooks = readPlaybooks(sessionId);

			for (const playbook of playbooks) {
				result.push({ ...playbook, sessionId });
			}
		}

		return result;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return result;
		}
		throw error;
	}
}
