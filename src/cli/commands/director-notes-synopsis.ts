// Director's Notes Synopsis command
// Generates an AI synopsis of recent activity across all agents
// Requires the Maestro desktop app to be running

import { withMaestroClient } from '../services/maestro-client';
import { readSettings } from '../services/storage';
import { formatError } from '../output/formatter';

type OutputFormat = 'json' | 'markdown' | 'text';

interface DirectorNotesSynopsisOptions {
	days?: string;
	format?: OutputFormat;
	json?: boolean;
}

interface SynopsisResult {
	type: string;
	success: boolean;
	synopsis: string;
	generatedAt?: number;
	stats?: {
		agentCount: number;
		entryCount: number;
		durationMs: number;
	};
	error?: string;
	requestId?: string;
}

function resolveFormat(options: DirectorNotesSynopsisOptions): OutputFormat {
	if (options.json) return 'json';
	return options.format || 'text';
}

function getDefaultLookbackDays(): number {
	const settings = readSettings();
	const dnSettings = settings.directorNotesSettings as { defaultLookbackDays?: number } | undefined;
	return dnSettings?.defaultLookbackDays ?? 7;
}

function getDefaultProvider(): string {
	const settings = readSettings();
	const dnSettings = settings.directorNotesSettings as { provider?: string } | undefined;
	return dnSettings?.provider ?? 'claude-code';
}

function checkEncoreFeatureEnabled(): void {
	const settings = readSettings();
	const encoreFeatures = settings.encoreFeatures as { directorNotes?: boolean } | undefined;
	if (!encoreFeatures?.directorNotes) {
		throw new Error("Director's Notes is not enabled. Enable it in Settings > Encore Features.");
	}
}

function stripMarkdownFormatting(md: string): string {
	return (
		md
			// Remove headers but keep text
			.replace(/^#{1,6}\s+/gm, '')
			// Remove bold/italic markers
			.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
			.replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
			// Remove inline code
			.replace(/`([^`]+)`/g, '$1')
			// Remove link syntax, keep text
			.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
			// Remove horizontal rules
			.replace(/^---+$/gm, '')
			// Remove bullet markers
			.replace(/^[\s]*[-*+]\s+/gm, '  ')
			// Collapse multiple blank lines
			.replace(/\n{3,}/g, '\n\n')
			.trim()
	);
}

export async function directorNotesSynopsis(options: DirectorNotesSynopsisOptions): Promise<void> {
	const format = resolveFormat(options);

	try {
		checkEncoreFeatureEnabled();

		const lookbackDays = options.days ? parseInt(options.days, 10) : getDefaultLookbackDays();
		const provider = getDefaultProvider();

		if (format !== 'json') {
			const period =
				lookbackDays > 0 ? `last ${lookbackDays} day${lookbackDays !== 1 ? 's' : ''}` : 'all time';
			process.stderr.write(
				`Generating Director's Notes synopsis (${period}, provider: ${provider})...\n`
			);
		}

		const result = await withMaestroClient(async (client) => {
			// Synopsis generation can take minutes — use a 5 minute timeout
			return client.sendCommand<SynopsisResult>(
				{
					type: 'generate_director_notes_synopsis',
					lookbackDays,
					provider,
				},
				'generate_director_notes_synopsis_result',
				300_000
			);
		});

		if (!result.success) {
			throw new Error(result.error || 'Synopsis generation failed');
		}

		if (format === 'json') {
			console.log(
				JSON.stringify(
					{
						synopsis: result.synopsis,
						generatedAt: result.generatedAt,
						date: result.generatedAt ? new Date(result.generatedAt).toISOString() : undefined,
						lookbackDays,
						provider,
						stats: result.stats,
					},
					null,
					2
				)
			);
		} else if (format === 'markdown') {
			console.log(result.synopsis);
		} else {
			// Text: strip markdown formatting for clean terminal output
			console.log(stripMarkdownFormatting(result.synopsis));

			if (result.stats) {
				const duration = result.stats.durationMs
					? `${(result.stats.durationMs / 1000).toFixed(1)}s`
					: 'unknown';
				process.stderr.write(
					`\nGenerated from ${result.stats.agentCount} agents, ${result.stats.entryCount} entries in ${duration}\n`
				);
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (format === 'json') {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(formatError(message));
		}
		process.exit(1);
	}
}
