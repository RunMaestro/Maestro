import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readFirstJsonlLine } from '../storage/jsonl-stream';
import type { TranslationFs } from '../translation/fs-port';
import { assertTranslationTarget } from '../translation/resource-projections';

export function extractSessionIdFromFilename(filename: string): string | null {
	// Match pattern: rollout-YYYYMMDD_HHMMSS_MMM-UUID.jsonl or similar
	const match = filename.match(/rollout-[\d_]+-([a-f0-9-]+)\.jsonl$/i);
	if (match) {
		return match[1];
	}
	// Fallback: use filename without extension
	return filename.replace('.jsonl', '');
}

export async function listCodexSessionFiles(
	sessionsDir: string,
	nativeFs?: TranslationFs
): Promise<Array<{ filePath: string; filename: string }>> {
	const paths = nativeFs?.paths ?? path;
	const filesystem = nativeFs ?? fs;
	const sessionFiles: Array<{ filePath: string; filename: string }> = [];

	try {
		if (nativeFs) {
			if (!(await nativeFs.exists(sessionsDir))) return [];
		} else await fs.access(sessionsDir);
	} catch (error) {
		if (nativeFs) throw error;
		return [];
	}

	// Scan YYYY directories
	const years = await filesystem.readdir(sessionsDir);
	for (const year of years) {
		if (!/^\d{4}$/.test(year)) continue;

		const yearDir = paths.join(sessionsDir, year);
		try {
			const yearStat = await (nativeFs ? nativeFs.lstat(yearDir) : fs.stat(yearDir));
			if (!yearStat.isDirectory()) continue;
		} catch (error) {
			if (nativeFs) throw error;
			continue;
		}

		// Scan MM directories
		const months = await filesystem.readdir(yearDir);
		for (const month of months) {
			if (!/^\d{2}$/.test(month)) continue;

			const monthDir = paths.join(yearDir, month);
			try {
				const monthStat = await (nativeFs ? nativeFs.lstat(monthDir) : fs.stat(monthDir));
				if (!monthStat.isDirectory()) continue;
			} catch (error) {
				if (nativeFs) throw error;
				continue;
			}

			// Scan DD directories
			const days = await filesystem.readdir(monthDir);
			for (const day of days) {
				if (!/^\d{2}$/.test(day)) continue;

				const dayDir = paths.join(monthDir, day);
				try {
					const dayStat = await (nativeFs ? nativeFs.lstat(dayDir) : fs.stat(dayDir));
					if (!dayStat.isDirectory()) continue;

					// Find session files
					const files = await filesystem.readdir(dayDir);
					for (const file of files) {
						if (file.endsWith('.jsonl')) {
							sessionFiles.push({
								filePath: paths.join(dayDir, file),
								filename: file,
							});
						}
					}
				} catch (error) {
					if (nativeFs) throw error;
					continue;
				}
			}
		}
	}

	return sessionFiles;
}

export async function findCodexSessionFile(
	sessionId: string,
	accountRoot: string,
	nativeFs?: TranslationFs
): Promise<string | null> {
	const paths = nativeFs?.paths ?? path;
	const allFiles = await listCodexSessionFiles(paths.join(accountRoot, 'sessions'), nativeFs);

	for (const { filePath, filename } of allFiles) {
		const fileSessionId = extractSessionIdFromFilename(filename);
		if (fileSessionId === sessionId) {
			return filePath;
		}

		// Also check by reading first line for session ID
		try {
			if (nativeFs) await assertTranslationTarget(filePath, accountRoot, nativeFs);
			const firstLine = nativeFs
				? (await nativeFs.readFile(filePath)).toString('utf8').split('\n')[0]
				: await readFirstJsonlLine(filePath);
			if (firstLine) {
				const metadata = JSON.parse(firstLine) as { payload?: { id?: string }; id?: string };
				const metadataId = metadata?.payload?.id || metadata.id;
				if (metadataId === sessionId) {
					return filePath;
				}
			}
		} catch (error) {
			if (nativeFs && !(error instanceof SyntaxError)) throw error;
			// Skip malformed metadata; local History also skips unreadable files
		}
	}

	return null;
}
