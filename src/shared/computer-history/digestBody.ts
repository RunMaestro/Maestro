/**
 * Computer History - the parts of a digest file (pure, renderer-safe).
 *
 * The scheduler writes every digest as a fixed header followed by the
 * writer's answer (`src/main/computer-history/digests.ts`):
 *
 *     # 15-minute digest <startIso> - <endIso>
 *
 *     Segment: `segments/...` (N events). Written by <writer>.
 *
 *     <summary markdown>
 *
 * A 6-hour roll-up has the same shape with a `From N 15-minute digest(s).`
 * provenance line, and ends with a `### Sources` list of the digests it was
 * written from (`formatDigestSources()` in `./digestFormat`). The header and
 * the sources are bookkeeping: the window is already known from
 * the file name, and the provenance line names the same writer on every file.
 * Search matches the SUMMARY only, or every digest would match the model's name.
 */

/** A digest body split into its header and the writer's answer. */
export interface DigestBodyParts {
	/** The `Segment: ...` / `From ...` provenance line, without markdown, or null. */
	provenance: string | null;
	/** The writer's answer: markdown, untrusted. */
	summary: string;
	/** A roll-up's source digests (store-relative paths), in time order. */
	sources: string[];
}

const PROVENANCE_RE = /^(Segment:|From \d+ )/;
const SOURCES_HEADING = '### Sources';
const SOURCE_LINE_RE = /^- `([^`]+)`$/;

/**
 * Cut the scheduler-written `### Sources` footer off a summary. Only a last
 * section whose every line is a source path counts, so a writer that uses the
 * same heading for its own text keeps it.
 */
function splitSources(summary: string): { summary: string; sources: string[] } {
	const lines = summary.split('\n');
	const at = lines.lastIndexOf(SOURCES_HEADING);
	if (at === -1) return { summary, sources: [] };
	const sources: string[] = [];
	for (const line of lines.slice(at + 1)) {
		if (line.trim() === '') continue;
		const match = SOURCE_LINE_RE.exec(line.trim());
		if (!match) return { summary, sources: [] };
		sources.push(match[1]);
	}
	return { summary: lines.slice(0, at).join('\n').trim(), sources };
}

/** Split a digest file's text. Text that lacks the header comes back whole. */
export function splitDigestBody(body: string): DigestBodyParts {
	const lines = body.replace(/\r\n/g, '\n').split('\n');
	let i = 0;
	const skipBlank = () => {
		while (i < lines.length && lines[i].trim() === '') i++;
	};
	skipBlank();
	if (i < lines.length && /^# .*digest|^# .*roll-up/i.test(lines[i])) {
		i++;
		skipBlank();
	} else {
		return { provenance: null, summary: body.trim(), sources: [] };
	}
	let provenance: string | null = null;
	if (i < lines.length && PROVENANCE_RE.test(lines[i])) {
		provenance = lines[i].replace(/`/g, '').trim();
		i++;
	}
	return { provenance, ...splitSources(lines.slice(i).join('\n').trim()) };
}
