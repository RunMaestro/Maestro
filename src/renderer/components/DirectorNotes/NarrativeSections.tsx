/**
 * NarrativeSections
 *
 * Renders the structured Director's Notes narrative (the qualitative half of
 * Rich Mode) as one styled `SectionCard` per section. Each section kind gets a
 * distinct accent + icon (accomplishments = green/check, challenges =
 * orange/alert, next steps = theme/arrow). Bullet items reflect their optional
 * `severity` (critical = red emphasis) and surface an `agent` tag as a small
 * pill when present.
 *
 * Presentational only: it takes the already-parsed `DirectorNotesNarrative` and
 * the active `theme` via props and reuses `SectionCard` from the shared widget
 * library. It never introduces a sixth status color - severity maps onto the
 * existing green/orange/red/theme language.
 */

import { memo } from 'react';
import { CheckCircle2, AlertTriangle, ArrowRight, type LucideIcon } from 'lucide-react';
import type { Theme } from '../../types';
import type {
	DirectorNotesNarrative,
	NarrativeItem,
	NarrativeSectionKind,
} from '../../../shared/directorNotesNarrative';
import { SectionCard } from '../widgets';

interface NarrativeSectionsProps {
	theme: Theme;
	narrative: DirectorNotesNarrative;
}

/** Per-kind icon used in the section header. Accent resolves from the theme. */
const KIND_ICON: Record<NarrativeSectionKind, LucideIcon> = {
	accomplishments: CheckCircle2,
	challenges: AlertTriangle,
	nextSteps: ArrowRight,
};

/** Resolve the accent color for a section kind from the live theme. */
function accentForKind(kind: NarrativeSectionKind, theme: Theme): string {
	switch (kind) {
		case 'accomplishments':
			return theme.colors.success;
		case 'challenges':
			return theme.colors.warning;
		case 'nextSteps':
		default:
			return theme.colors.accent;
	}
}

/**
 * Resolve the bullet/text emphasis for an item's severity. `critical` reads as
 * red emphasis; `warn` as the warning color; `info` (or absent) stays neutral
 * and inherits the section accent for its marker dot.
 */
function severityStyle(
	item: NarrativeItem,
	sectionAccent: string,
	theme: Theme
): { dotColor: string; textColor: string; bold: boolean } {
	switch (item.severity) {
		case 'critical':
			return { dotColor: theme.colors.error, textColor: theme.colors.error, bold: true };
		case 'warn':
			return { dotColor: theme.colors.warning, textColor: theme.colors.textMain, bold: false };
		case 'info':
		default:
			return { dotColor: sectionAccent, textColor: theme.colors.textMain, bold: false };
	}
}

/** A single bullet row with its severity marker, text, and optional agent pill. */
const NarrativeBullet = memo(function NarrativeBullet({
	item,
	sectionAccent,
	theme,
}: {
	item: NarrativeItem;
	sectionAccent: string;
	theme: Theme;
}) {
	const { dotColor, textColor, bold } = severityStyle(item, sectionAccent, theme);
	return (
		<li className="flex items-start gap-2.5 text-sm leading-relaxed">
			<span
				className="mt-[0.45rem] w-1.5 h-1.5 rounded-full shrink-0"
				style={{ backgroundColor: dotColor }}
				aria-hidden="true"
			/>
			<div className="flex-1 min-w-0">
				<span style={{ color: textColor, fontWeight: bold ? 600 : 400 }}>{item.text}</span>
				{item.agent && (
					<span
						className="ml-2 inline-block align-middle px-1.5 py-0.5 rounded text-[0.65rem] font-medium whitespace-nowrap"
						style={{
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textDim,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						{item.agent}
					</span>
				)}
			</div>
		</li>
	);
});

export const NarrativeSections = memo(function NarrativeSections({
	theme,
	narrative,
}: NarrativeSectionsProps) {
	return (
		<div className="flex flex-col gap-4 select-text">
			{narrative.sections.map((section, sectionIndex) => {
				const accent = accentForKind(section.kind, theme);
				const Icon = KIND_ICON[section.kind] ?? ArrowRight;
				return (
					<SectionCard
						key={`${section.kind}-${sectionIndex}`}
						theme={theme}
						title={section.title}
						icon={Icon}
						accent={accent}
						action={
							<span
								className="text-[0.65rem] font-semibold px-1.5 py-0.5 rounded"
								style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
							>
								{section.items.length}
							</span>
						}
					>
						{section.items.length === 0 ? (
							<p className="text-sm italic" style={{ color: theme.colors.textDim }}>
								Nothing to report.
							</p>
						) : (
							<ul className="flex flex-col gap-2">
								{section.items.map((item, itemIndex) => (
									<NarrativeBullet
										key={itemIndex}
										item={item}
										sectionAccent={accent}
										theme={theme}
									/>
								))}
							</ul>
						)}
					</SectionCard>
				);
			})}
		</div>
	);
});

export default NarrativeSections;
