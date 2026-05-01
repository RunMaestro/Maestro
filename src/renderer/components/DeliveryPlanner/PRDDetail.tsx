import { Edit3, GitBranch } from 'lucide-react';
import type { Theme } from '../../types';
import type { DeliveryPlannerPrdFields } from '../../../shared/delivery-planner-types';
import type { WorkItem } from '../../../shared/work-graph-types';
import { TagPill } from '../shared/TagPill';

const FIELD_LABELS: Array<{ key: keyof DeliveryPlannerPrdFields; label: string }> = [
	{ key: 'problem', label: 'Problem' },
	{ key: 'users', label: 'Users' },
	{ key: 'successCriteria', label: 'Success Criteria' },
	{ key: 'scope', label: 'Scope' },
	{ key: 'constraints', label: 'Constraints' },
	{ key: 'dependencies', label: 'Dependencies' },
	{ key: 'outOfScope', label: 'Out of Scope' },
];

interface PRDDetailProps {
	theme: Theme;
	prd: WorkItem;
	onEdit: () => void;
	onConvert: () => Promise<void>;
	converting: boolean;
}

export function PRDDetail({ theme, prd, onEdit, onConvert, converting }: PRDDetailProps) {
	const fields = prd.metadata?.prdFields as DeliveryPlannerPrdFields | undefined;
	const valid = Boolean(
		fields && prd.metadata?.ccpmSlug && FIELD_LABELS.every(({ key }) => fields[key]?.trim())
	);

	return (
		<div className="h-full flex flex-col">
			<div className="flex items-start justify-between gap-3 mb-4">
				<div>
					<h3 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
						{prd.title}
					</h3>
					<div className="text-xs font-mono mt-1" style={{ color: theme.colors.textDim }}>
						.claude/prds/{prd.metadata?.ccpmSlug?.toString() || 'missing-slug'}.md
					</div>
				</div>
				<div className="flex gap-2">
					<button
						onClick={onEdit}
						className="inline-flex items-center gap-2 px-3 py-2 rounded border"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						<Edit3 className="w-4 h-4" />
						Edit
					</button>
					<button
						onClick={onConvert}
						disabled={!valid || converting}
						className="inline-flex items-center gap-2 px-3 py-2 rounded disabled:opacity-50"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
					>
						<GitBranch className="w-4 h-4" />
						{converting ? 'Converting' : 'Convert to Epic'}
					</button>
				</div>
			</div>
			<div className="flex flex-wrap gap-2 mb-4">
				{prd.tags.map((tag) => (
					<TagPill key={tag} label={tag} theme={theme} />
				))}
			</div>
			{!valid && (
				<div className="mb-4 text-sm" style={{ color: theme.colors.warning }}>
					Complete all PRD fields and a valid slug before converting.
				</div>
			)}
			<div className="flex-1 overflow-y-auto space-y-4 pr-1">
				{fields ? (
					FIELD_LABELS.map(({ key, label }) => (
						<section key={key}>
							<h4 className="text-sm font-medium mb-1" style={{ color: theme.colors.textMain }}>
								{label}
							</h4>
							<p className="text-sm whitespace-pre-wrap" style={{ color: theme.colors.textDim }}>
								{fields[key]}
							</p>
						</section>
					))
				) : (
					<p className="text-sm" style={{ color: theme.colors.textDim }}>
						{prd.description}
					</p>
				)}
			</div>
		</div>
	);
}
