/**
 * NarrativeSections
 *
 * Renders the structured Director's Notes narrative (the qualitative half of
 * Rich Mode) as one styled `SectionCard` per section. Each section kind gets a
 * distinct accent + icon (accomplishments = green/check, challenges =
 * orange/alert, next steps = theme/arrow, progress = theme/target). Bullet items
 * reflect their optional `severity` (critical = red emphasis) and surface an
 * `agent` tag as a small pill when present.
 *
 * Within a section the bullets are bucketed by `bucketNarrativeItems`: by the
 * agent's GROUP when Maestro knows one, by the agent otherwise. A flat
 * twenty-plus-bullet section makes the reader re-derive ownership on every
 * line. The agent pill survives only inside a GROUP bucket, where it still
 * carries information (which member did it); under an agent header it would
 * just repeat the header. Headers are drawn only when a section has more than
 * one bucket.
 *
 * Presentational only: it takes the already-parsed `DirectorNotesNarrative` and
 * the active `theme` via props and reuses `SectionCard` from the shared widget
 * library. It never introduces a sixth status color - severity maps onto the
 * existing green/orange/red/theme language.
 */

import { memo } from 'react';
import { CheckCircle2, AlertTriangle, ArrowRight, Target, type LucideIcon } from 'lucide-react';
import type { Theme } from '../../types';
import type {
	DirectorNotesNarrative,
	NarrativeItem,
	NarrativeSectionKind,
} from '../../../shared/directorNotesNarrative';
import {
	bucketNarrativeItems,
	shouldRenderBuckets,
	type NarrativeBucket,
	type NarrativeGroupLookup,
} from '../../../shared/directorNotesGrouping';
import { SectionCard } from '../widgets';

interface NarrativeSectionsProps {
	theme: Theme;
	narrative: DirectorNotesNarrative;
	/**
	 * Resolves an agent name to its Left Bar group. Omit it and every bullet
	 * buckets by agent, which is the correct fallback for a caller with no
	 * session state (tests, the CLI-shaped paths).
	 */
	groupLookup?: NarrativeGroupLookup | null;
}

/** Per-kind icon used in the section header. Accent resolves from the theme. */
const KIND_ICON: Record<NarrativeSectionKind, LucideIcon> = {
	accomplishments: CheckCircle2,
	challenges: AlertTriangle,
	nextSteps: ArrowRight,
	progress: Target,
};

/** Resolve the accent color for a section kind from the live theme. */
function accentForKind(kind: NarrativeSectionKind, theme: Theme): string {
	switch (kind) {
		case 'accomplishments':
			return theme.colors.success;
		case 'challenges':
			return theme.colors.warning;
		case 'progress':
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
	showAgentPill = true,
}: {
	item: NarrativeItem;
	sectionAccent: string;
	theme: Theme;
	/** False under an agent header, where the pill would repeat the header. */
	showAgentPill?: boolean;
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
				{showAgentPill && item.agent && (
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

/**
 * One bucket: a header naming the group (or agent) followed by its bullets.
 * The header sizes one step below the section title - it is subordinate to the
 * card heading it sits under, the same rule `HeaderActionButton` follows.
 */
const NarrativeBucketBlock = memo(function NarrativeBucketBlock({
	bucket,
	sectionAccent,
	theme,
}: {
	bucket: NarrativeBucket;
	sectionAccent: string;
	theme: Theme;
}) {
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<span
					className="text-xs font-semibold uppercase tracking-wide"
					style={{ color: bucket.isUnattributed ? theme.colors.textDim : theme.colors.textMain }}
				>
					{bucket.emoji ? `${bucket.emoji} ` : ''}
					{bucket.label}
				</span>
				<span
					className="flex-1 h-px"
					style={{ backgroundColor: theme.colors.border }}
					aria-hidden="true"
				/>
			</div>
			<ul className="flex flex-col gap-2 pl-1">
				{bucket.items.map((item, itemIndex) => (
					<NarrativeBullet
						key={itemIndex}
						item={item}
						sectionAccent={sectionAccent}
						theme={theme}
						// Inside a group the pill still names which member did it;
						// under an agent header it would just repeat the header.
						showAgentPill={bucket.isGroup}
					/>
				))}
			</ul>
		</div>
	);
});

export const NarrativeSections = memo(function NarrativeSections({
	theme,
	narrative,
	groupLookup,
}: NarrativeSectionsProps) {
	return (
		<div className="flex flex-col gap-4 select-text">
			{narrative.sections.map((section, sectionIndex) => {
				const accent = accentForKind(section.kind, theme);
				const Icon = KIND_ICON[section.kind] ?? ArrowRight;
				const buckets = bucketNarrativeItems(section.items, groupLookup);
				const grouped = shouldRenderBuckets(buckets);
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
						) : grouped ? (
							<div className="flex flex-col gap-4">
								{buckets.map((bucket, bucketIndex) => (
									<NarrativeBucketBlock
										key={`${bucket.label}-${bucketIndex}`}
										bucket={bucket}
										sectionAccent={accent}
										theme={theme}
									/>
								))}
							</div>
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
