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
 * provenance line. The header is bookkeeping: the window is already known from
 * the file name, and the provenance line names the same writer on every file.
 * Search matches the SUMMARY only, or every digest would match the model's name.
 */

/** A digest body split into its header and the writer's answer. */
export interface DigestBodyParts {
	/** The `Segment: ...` / `From ...` provenance line, without markdown, or null. */
	provenance: string | null;
	/** The writer's answer: markdown, untrusted. */
	summary: string;
}

const PROVENANCE_RE = /^(Segment:|From \d+ )/;

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
		return { provenance: null, summary: body.trim() };
	}
	let provenance: string | null = null;
	if (i < lines.length && PROVENANCE_RE.test(lines[i])) {
		provenance = lines[i].replace(/`/g, '').trim();
		i++;
	}
	return { provenance, summary: lines.slice(i).join('\n').trim() };
}
