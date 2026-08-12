/**
 * Shared YAML frontmatter parser used by both the Fast tier
 * (`markdownFast/frontmatter.ts`) and the Rich tier (`remarkFrontmatterTable.ts`).
 *
 * Intentionally minimal - handles only what a "Document metadata" table needs:
 *   - top-level `key: value` pairs
 *   - matching single/double quote stripping
 *   - blank lines and `#` comments
 *   - literal (`|`) and folded (`>`) block scalars, with optional chomping
 *     indicators (`-` / `+`), captured as multi-line values
 *
 * Indented continuation lines that are NOT part of a block scalar are skipped
 * so a stray `key:` inside indented prose can't masquerade as a new entry.
 */

export interface FrontmatterEntry {
	key: string;
	value: string;
}

const BLOCK_SCALAR_RE = /^([|>])([+-]?)\s*$/;

function leadingSpaces(line: string): number {
	let i = 0;
	while (i < line.length && line[i] === ' ') i++;
	return i;
}

function stripMatchingQuotes(value: string): string {
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'")))
	) {
		return value.slice(1, -1);
	}
	return value;
}

export function parseYamlKeyValues(yaml: string): FrontmatterEntry[] {
	const entries: FrontmatterEntry[] = [];
	const lines = yaml.split('\n');

	let i = 0;
	while (i < lines.length) {
		const raw = lines[i];
		const trimmed = raw.trim();

		if (!trimmed || trimmed.startsWith('#')) {
			i++;
			continue;
		}

		const indent = leadingSpaces(raw);
		// Only top-level keys count - indented lines are continuation/nesting we
		// don't model, so skip them rather than mis-parsing as new entries.
		if (indent > 0) {
			i++;
			continue;
		}

		const colon = trimmed.indexOf(':');
		if (colon <= 0) {
			i++;
			continue;
		}

		const key = trimmed.slice(0, colon).trim();
		const rawValue = trimmed.slice(colon + 1).trim();
		i++;

		const blockMatch = rawValue.match(BLOCK_SCALAR_RE);
		if (blockMatch) {
			const folded = blockMatch[1] === '>';
			const chomp = blockMatch[2]; // '', '-', or '+'
			const collected: string[] = [];
			while (i < lines.length) {
				const next = lines[i];
				if (next.trim() === '') {
					collected.push('');
					i++;
					continue;
				}
				if (leadingSpaces(next) > indent) {
					collected.push(next.replace(/^ +/, ''));
					i++;
					continue;
				}
				break;
			}
			// Default chomp: keep a single trailing newline (drop trailing blanks).
			// '-' strip: drop all trailing blanks. '+' keep: preserve trailing blanks.
			if (chomp !== '+') {
				while (collected.length && collected[collected.length - 1] === '') {
					collected.pop();
				}
			}
			let value: string;
			if (folded) {
				// Folded: collapse runs of non-empty lines into a single space,
				// keep blank lines as paragraph breaks.
				const out: string[] = [];
				let buf = '';
				for (const line of collected) {
					if (line === '') {
						if (buf) {
							out.push(buf);
							buf = '';
						}
						out.push('');
					} else {
						buf = buf ? `${buf} ${line}` : line;
					}
				}
				if (buf) out.push(buf);
				value = out.join('\n');
			} else {
				value = collected.join('\n');
			}
			entries.push({ key, value });
			continue;
		}

		entries.push({ key, value: stripMatchingQuotes(rawValue) });
	}

	return entries;
}
