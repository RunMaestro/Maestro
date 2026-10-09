import type { ReactNode } from 'react';
import type { Theme } from '../../../types';
import { readableTextOn, transparentize } from '../../../../shared/colorContrast';
import { getBasename } from '../../../../shared/formatters';
import { MiniBadge } from '../../ui/MiniBadge';

export interface CodeCommentCardProps {
	/** `title=` - the agent's short label for the finding. */
	title?: string;
	/** `body=` - the one-paragraph explanation. The only attribute that
	 *  routinely carries escaped quotes. */
	body: string;
	/** `file=` - absolute, or workspace-relative so it resolves against the root. */
	file?: string;
	/** `start=` / `end=` - 1-based line numbers. `end` defaults to `start`. */
	start?: string;
	end?: string;
	/** `priority=` - `0`-`3` on the wire, 0 being the most severe. */
	priority?: string;
	theme: Theme;
	/**
	 * The surface's own `<a>` renderer, from `createMarkdownLink` - the same one
	 * a `:codex-file-citation` uses, so a click on either lands in the preview
	 * tab by the same path.
	 */
	LinkComponent: (props: Record<string, unknown>) => ReactNode;
}

/**
 * Severity colors for the documented `0`-`3` range.
 *
 * The producer emits `priority=2` beside a title reading `[P2]`, and P-numbering
 * runs the one direction everywhere it is used: P0 is the one that stops the
 * release. So 0 takes the error hue and 3 goes dim. A value outside the range
 * keeps the accent and its own text, because inventing a severity for an
 * attribute we do not recognize is how a cosmetic note gets painted as a bug.
 */
const PRIORITY_COLOR_KEYS = ['error', 'error', 'warning', 'textDim'] as const;

function priorityTint(theme: Theme, priority: string): string {
	const index = /^\d+$/.test(priority) ? Number(priority) : -1;
	const key = PRIORITY_COLOR_KEYS[index];
	return key ? theme.colors[key] : theme.colors.accent;
}

/** `src/a.ts` + `10` + `12` -> `a.ts:10-12`, and `a.ts:10` when the range is one line. */
export function codeCommentLocationLabel(file: string, start?: string, end?: string): string {
	const name = getBasename(file) || file;
	if (!start) return name;
	// `end` defaults to `start`, so a one-line range prints as one number rather
	// than as `10-10`.
	return end && end !== start ? `${name}:${start}-${end}` : `${name}:${start}`;
}

/**
 * The visible form of a `::code-comment` directive.
 *
 * Codex attaches review feedback to specific lines by writing the whole comment
 * into its own markdown, so a transcript used to carry the wire format verbatim:
 * a title, a paragraph of prose, an absolute path and two line numbers, all run
 * together inside one pair of braces. Counting the local Codex transcripts found
 * 120 of them, every one rendered as garbage.
 *
 * Drawn as a card rather than a chip because a comment is not an inline token:
 * its body is a paragraph, and the reader has to be able to read it, see which
 * lines it is about, and get to those lines. The three parts are therefore
 * stacked - severity and title, body, location - and only the location is
 * pressable, because the comment itself does nothing.
 *
 * Color follows the same five-color language as `MarkerPill`, chosen by the
 * SEVERITY the agent claimed rather than by the fact that it is a comment: a P0
 * and a P3 must not look alike in a message that holds several.
 */
export function CodeCommentCard({
	title,
	body,
	file,
	start,
	end,
	priority,
	theme,
	LinkComponent,
}: CodeCommentCardProps) {
	const tint = priority ? priorityTint(theme, priority) : theme.colors.accent;
	const background = transparentize(tint, theme.colors.bgMain, 0.1);
	const borderColor = transparentize(tint, theme.colors.bgMain, 0.35);
	const headingColor = readableTextOn(tint, [background, theme.colors.bgMain]);

	const location = file ? codeCommentLocationLabel(file, start, end) : null;

	return (
		// A `span` set to `display: block` rather than a `div`: the directive is
		// replaced inline, so the card is inside a paragraph and a block-level
		// element there is invalid markup React will complain about.
		<span
			data-testid="codex-code-comment"
			data-priority={priority}
			style={{
				display: 'block',
				// `em` throughout so the card tracks the reading pane's font scale.
				margin: '0.4em 0',
				padding: '0.5em 0.7em',
				borderRadius: '0.4em',
				border: `1px solid ${borderColor}`,
				// After the shorthand so it wins: the severity rail is the only part
				// of the card that is readable at a glance in a long message.
				borderLeft: `3px solid ${tint}`,
				backgroundColor: background,
				fontSize: '0.95em',
				lineHeight: 1.5,
			}}
		>
			<span style={{ display: 'flex', alignItems: 'center', gap: '0.5em', flexWrap: 'wrap' }}>
				{priority && (
					<MiniBadge
						label={/^\d+$/.test(priority) ? `P${priority}` : priority}
						theme={theme}
						color={tint}
						title={`Priority ${priority}`}
						testId="codex-code-comment-priority"
					/>
				)}
				{title && <span style={{ color: headingColor, fontWeight: 600 }}>{title}</span>}
			</span>
			{body && (
				<span
					data-testid="codex-code-comment-body"
					style={{
						display: 'block',
						marginTop: title || priority ? '0.3em' : 0,
						color: theme.colors.textMain,
						// The body is one authored paragraph and may hold any character,
						// including the braces and quotes the grammar escapes. It is
						// rendered as text, never as markup.
						whiteSpace: 'pre-wrap',
						wordBreak: 'break-word',
					}}
				>
					{body}
				</span>
			)}
			{file && location && (
				<span style={{ display: 'block', marginTop: '0.35em', fontSize: '0.85em' }}>
					<LinkComponent
						href={`maestro-file://${file}`}
						data-maestro-file={file}
						title={file}
						aria-label={`Open ${location}`}
					>
						{location}
					</LinkComponent>
				</span>
			)}
		</span>
	);
}
