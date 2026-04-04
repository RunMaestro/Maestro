/**
 * Helpers for resolving Group Chat !autorun document references against
 * Maestro's Auto Run document list.
 */

function normalizePathSlashes(value: string): string {
	return value
		.replace(/\\/g, '/')
		.replace(/^\.\/+/, '')
		.replace(/^\/+/, '');
}

export function normalizeAutoRunTargetFilename(targetFilename: string): string {
	const trimmed = normalizePathSlashes(targetFilename.trim());
	return trimmed.replace(/\.md$/i, '');
}

export function resolveGroupChatAutoRunTarget(
	allFiles: string[],
	targetFilename?: string
):
	| { files: string[] }
	| {
			error: string;
	  } {
	if (!targetFilename) {
		return { files: allFiles };
	}

	const normalizedTarget = normalizeAutoRunTargetFilename(targetFilename);
	const exactMatch = allFiles.find((file) => file === normalizedTarget);
	if (exactMatch) {
		return { files: [exactMatch] };
	}

	const basenameMatches = allFiles.filter((file) => {
		const basename = file.split('/').pop();
		return basename === normalizedTarget;
	});

	if (basenameMatches.length === 1) {
		return { files: [basenameMatches[0]] };
	}

	if (basenameMatches.length > 1) {
		return {
			error: `Specified file "${targetFilename}" is ambiguous. Matching files: ${basenameMatches.join(', ')}`,
		};
	}

	return {
		error: `Specified file "${targetFilename}" not found. Available files: ${allFiles.join(', ')}`,
	};
}
