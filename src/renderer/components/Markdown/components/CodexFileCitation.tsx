import type { ReactNode } from 'react';
import type { Theme } from '../../../types';
import { readableTextOn, transparentize } from '../../../../shared/colorContrast';
import { getBasename } from '../../../../shared/formatters';
import { getFileCategory, type FileCategory } from '../../../../shared/fileCategories';

/**
 * Which way the file moved. `output` is a file the agent WROTE during the turn;
 * `source` is one it read to answer. Anything else on the wire is read as a
 * source, because a citation that cannot be proven to be an output must not
 * claim the agent changed the user's file.
 */
export type CodexCitationPurpose = 'source' | 'output';

export interface CodexFileCitationProps {
	/** Absolute path from the directive's `path=` attribute. */
	path: string;
	purpose: CodexCitationPurpose;
	/** Optional `artifact_kind=`, shown on hover rather than in the line. */
	artifactKind?: string;
	/** Optional `page_number=`, kept as written since the wire carries a string. */
	pageNumber?: string;
	theme: Theme;
	/**
	 * The surface's own `<a>` renderer, from `createMarkdownLink`. Passed in
	 * rather than built here so a citation click goes down the SAME path as every
	 * other file link in the message - preview tab, media player, SSH remote, and
	 * the right-click Copy/Save menu all come with it.
	 */
	LinkComponent: (props: Record<string, unknown>) => ReactNode;
}

/** One glyph per file category, so a citation reads as a file at a glance. */
const CATEGORY_GLYPHS: Record<FileCategory, string> = {
	code: '{ }',
	docs: '¶',
	data: '▤',
	media: '▶',
	other: '•',
};

/**
 * The visible form of a `:codex-file-citation` directive.
 *
 * Codex cites the files behind an answer inline, so a transcript used to carry
 * `:codex-file-citation{path="/a/b.ts" purpose="source"}` as literal text - an
 * absolute path in the middle of a sentence, and no way to open it.
 *
 * Three things are decided here and nothing else is:
 *
 * 1. **The link text is the BASE NAME, the full path is on hover.** A cited
 *    path is routinely sixty characters of directory nobody is reading, and it
 *    lands mid-sentence. The path stays reachable on the `title` and on the
 *    accessible name, where a keyboard user gets it too.
 * 2. **An output does not look like a source.** An output is a file the agent
 *    just CHANGED, which is the one thing in a citation a reader may need to
 *    act on, so it carries the theme's success hue and says so on hover; a
 *    source stays dim and out of the way.
 * 3. **The click is not ours.** The anchor comes from the surface's own
 *    `createMarkdownLink`, so this component owns the chrome and none of the
 *    behavior.
 */
export function CodexFileCitation({
	path,
	purpose,
	artifactKind,
	pageNumber,
	theme,
	LinkComponent,
}: CodexFileCitationProps) {
	const name = getBasename(path) || path;
	const isOutput = purpose === 'output';
	const baseColor = isOutput ? theme.colors.success : theme.colors.textDim;
	const background = transparentize(baseColor, theme.colors.bgMain, 0.12);
	const borderColor = transparentize(baseColor, theme.colors.bgMain, 0.35);
	const glyphColor = readableTextOn(baseColor, [background, theme.colors.bgMain]);
	const glyph = CATEGORY_GLYPHS[getFileCategory(path) ?? 'other'];

	const provenance = isOutput ? 'Written by the agent' : 'Read by the agent';
	const title = [provenance, path, artifactKind ? `Kind: ${artifactKind}` : undefined]
		.filter(Boolean)
		.join('\n');

	return (
		<span
			data-testid="codex-file-citation"
			data-citation-purpose={purpose}
			style={{
				display: 'inline-flex',
				alignItems: 'baseline',
				gap: '0.3em',
				// `em` throughout so the chip tracks the reading pane's font scale
				// rather than staying fixed while the prose around it grows.
				padding: '0.05em 0.4em',
				borderRadius: '0.35em',
				border: `1px solid ${borderColor}`,
				backgroundColor: background,
				fontSize: '0.9em',
				lineHeight: 1.5,
				verticalAlign: 'baseline',
				maxWidth: '100%',
			}}
		>
			<span aria-hidden="true" style={{ color: glyphColor, fontSize: '0.85em' }}>
				{glyph}
			</span>
			<LinkComponent
				// Both halves of the pair `remarkFileLinks` emits, for the two
				// different reasons it emits them. The `href` is what makes the
				// anchor a LINK - focusable, announced as one, and reachable by
				// keyboard - and `data-maestro-file` is what survives the rehype
				// sanitizer, which strips the custom protocol.
				href={`maestro-file://${path}`}
				data-maestro-file={path}
				title={title}
				aria-label={`${provenance}: ${path}${pageNumber ? `, page ${pageNumber}` : ''}`}
			>
				{name}
			</LinkComponent>
			{pageNumber && (
				<span style={{ color: theme.colors.textDim, fontSize: '0.85em' }}>p. {pageNumber}</span>
			)}
		</span>
	);
}
