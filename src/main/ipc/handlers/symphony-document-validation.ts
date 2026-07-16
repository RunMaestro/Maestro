import path from 'path';
import type { DocumentReference } from '../../../shared/symphony-types';

const GITHUB_DOCUMENT_HOSTS: Record<string, true> = {
	'github.com': true,
	'www.github.com': true,
	'raw.githubusercontent.com': true,
	'user-images.githubusercontent.com': true,
	'camo.githubusercontent.com': true,
	'objects.githubusercontent.com': true,
};

export interface ValidationResult {
	valid: boolean;
	error?: string;
}

/** Validates a GitHub repository URL before clone commands are invoked. */
export function validateGitHubUrl(url: string): ValidationResult {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:') {
			return { valid: false, error: 'Only HTTPS URLs are allowed' };
		}
		if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') {
			return { valid: false, error: 'Only GitHub repositories are allowed' };
		}
		const pathParts = parsed.pathname.split('/').filter(Boolean);
		if (pathParts.length < 2) {
			return { valid: false, error: 'Invalid repository path' };
		}
		return { valid: true };
	} catch {
		return { valid: false, error: 'Invalid URL format' };
	}
}

/** Validates repository slugs accepted by Symphony contribution flows. */
export function validateRepoSlug(slug: string): ValidationResult {
	if (!slug || typeof slug !== 'string') {
		return { valid: false, error: 'Repository slug is required' };
	}
	const parts = slug.split('/');
	if (parts.length !== 2) {
		return { valid: false, error: 'Invalid repository slug format (expected owner/repo)' };
	}
	const [owner, repo] = parts;
	if (!owner || !repo) {
		return { valid: false, error: 'Owner and repository name are required' };
	}
	if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(owner)) {
		return { valid: false, error: 'Invalid owner name' };
	}
	if (!/^[a-zA-Z0-9._-]+$/.test(repo)) {
		return { valid: false, error: 'Invalid repository name' };
	}
	return { valid: true };
}

function decodePath(pathname: string): string | undefined {
	let decoded = pathname;
	for (let index = 0; index < 3; index++) {
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) return next;
			decoded = next;
		} catch {
			return undefined;
		}
	}
	return decoded;
}

function validateRepositoryDocumentPath(documentPath: string): ValidationResult {
	const decoded = decodePath(documentPath);
	if (!decoded) {
		return { valid: false, error: `Invalid document path: ${documentPath}` };
	}

	const normalized = decoded.replace(/\\/g, '/');
	if (
		decoded.includes('..') ||
		path.isAbsolute(documentPath) ||
		path.win32.isAbsolute(documentPath) ||
		path.posix.isAbsolute(normalized) ||
		normalized.includes('\0')
	) {
		return { valid: false, error: `Invalid document path: ${documentPath}` };
	}

	return { valid: true };
}

/**
 * Validates document-reference syntax before any filesystem or network operation.
 * Repository containment and symlink resolution remain downstream authority checks.
 */
export function validateDocumentReferences(documentPaths: DocumentReference[]): ValidationResult {
	if (!Array.isArray(documentPaths)) {
		return { valid: false, error: 'Document paths are required' };
	}

	for (const document of documentPaths) {
		if (!document || typeof document.path !== 'string') {
			return { valid: false, error: 'Invalid document path' };
		}

		if (!document.isExternal) {
			const validation = validateRepositoryDocumentPath(document.path);
			if (!validation.valid) return validation;
			continue;
		}

		try {
			const parsed = new URL(document.path);
			if (parsed.protocol !== 'https:') {
				return {
					valid: false,
					error: `External document URL must use HTTPS: ${document.path}`,
				};
			}
			if (!GITHUB_DOCUMENT_HOSTS[parsed.hostname]) {
				return {
					valid: false,
					error: `External document URL must be from GitHub: ${document.path}`,
				};
			}
		} catch {
			return { valid: false, error: `Invalid external document URL: ${document.path}` };
		}
	}

	return { valid: true };
}
