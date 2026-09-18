import type { Theme } from '../../../types';
import { readableTextOn, transparentize } from '../../../../shared/colorContrast';
import { HoverTooltip } from '../../ui/HoverTooltip';

export interface FollowupChipProps {
	/** The agent's own short name for the action, from the directive's `[Label]`. */
	label: string;
	/** The full prompt a click sends, from the directive's `prompt=` attribute. */
	prompt: string;
	/** Agent this chip was drawn for. */
	sessionId: string;
	/** AI tab this chip was drawn in. */
	tabId: string;
	theme: Theme;
	onActivate: (mode: 'send' | 'prefill') => void;
}

/** Cap for the hover overlay, wide enough for a few sentences without becoming a page. */
const PROMPT_OVERLAY_MAX_WIDTH = 360;

/**
 * The visible, clickable form of a `:codex-followup` directive.
 *
 * Codex ends a turn by offering its next moves as directives embedded in its
 * own markdown, so the transcript used to show the wire format verbatim -
 * `:codex-followup[Design the schema]{prompt="Design the canonical schema."}` -
 * which is both unreadable and unusable. This draws the offer as one chip the
 * reader can press.
 *
 * Two things about this chip are decided by the fact that BOTH halves of it are
 * agent-authored, and they are the whole design:
 *
 * 1. **The full prompt is always one hover away.** The label is the agent's
 *    summary of its own prompt, and nothing checks that the two agree. A chip
 *    reading "Tidy the imports" over a prompt that rewrites a config file must
 *    not be able to hide that, so the prompt is on the overlay and on the
 *    `aria-label` - the overlay for a reader with a mouse, the label for a
 *    screen reader and for anyone reaching the chip by keyboard, where
 *    `HoverTooltip` never fires.
 * 2. **Alt-click prefills instead of sending.** Editing an agent-authored
 *    prompt before it runs has to be one gesture away rather than a
 *    copy-paste out of a tooltip.
 *
 * A prompt-less chip renders as plain text. A button that sends nothing is
 * worse than no button: it reads as broken, and the label is still the only
 * content the directive carried.
 *
 * Both foreground and background derive from theme colors, so the text runs
 * through `readableTextOn` - a theme whose accent sits near its background
 * would otherwise paint near-invisible text on a tinted chip. Same reasoning as
 * `MarkerPill`, which this is modeled on.
 */
export function FollowupChip({
	label,
	prompt,
	sessionId,
	tabId,
	theme,
	onActivate,
}: FollowupChipProps) {
	// Nothing to send. Render the agent's label as the prose it already was,
	// rather than offering a control with no effect behind it.
	if (!prompt) {
		return <span data-testid="codex-followup-plain">{label}</span>;
	}

	const baseColor = theme.colors.accent;
	const background = transparentize(baseColor, theme.colors.bgMain, 0.14);
	const textColor = readableTextOn(baseColor, [background, theme.colors.bgMain]);
	const borderColor = transparentize(baseColor, theme.colors.bgMain, 0.4);

	return (
		<HoverTooltip
			label={prompt}
			theme={theme}
			maxWidth={PROMPT_OVERLAY_MAX_WIDTH}
			triggerClassName="inline-flex"
			triggerStyle={{ verticalAlign: 'baseline' }}
		>
			<button
				type="button"
				data-testid="codex-followup-chip"
				data-session-id={sessionId}
				data-tab-id={tabId}
				/*
				 * The prompt rides the accessible name rather than a `title`. A
				 * native tooltip would fire underneath the overlay and show the
				 * reader two boxes at once, and it would still leave a keyboard
				 * user with no way to read what the chip is about to send.
				 */
				aria-label={`Send follow-up: ${label}. Sends the prompt: ${prompt}`}
				// Enter and Space already activate a real button, so `onClick` is
				// the whole keyboard story. `altKey` covers Option on macOS.
				onClick={(event) => onActivate(event.altKey ? 'prefill' : 'send')}
				style={{
					display: 'inline-flex',
					alignItems: 'baseline',
					gap: '0.375em',
					// `em` throughout so the chip tracks the reading pane's font
					// scale rather than staying fixed while the prose around it
					// grows.
					padding: '0.1em 0.5em',
					borderRadius: '999px',
					border: `1px solid ${borderColor}`,
					backgroundColor: background,
					color: textColor,
					fontSize: '0.8em',
					fontWeight: 600,
					lineHeight: 1.5,
					cursor: 'pointer',
					verticalAlign: 'baseline',
					// The label is a short action name; the prompt behind it is not,
					// and that is what the overlay is for.
					whiteSpace: 'nowrap',
					textAlign: 'left',
				}}
			>
				<span aria-hidden="true">➤</span>
				<span>{label}</span>
			</button>
		</HoverTooltip>
	);
}
