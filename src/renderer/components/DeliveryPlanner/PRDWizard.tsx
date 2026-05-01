import React, { useMemo, useState } from 'react';
import { Save } from 'lucide-react';
import type { Theme } from '../../types';
import type {
	DeliveryPlannerPrdFields,
	DeliveryPlannerPrdSaveRequest,
} from '../../../shared/delivery-planner-types';
import type { WorkItem } from '../../../shared/work-graph-types';

const EMPTY_FIELDS: DeliveryPlannerPrdFields = {
	problem: '',
	users: '',
	successCriteria: '',
	scope: '',
	constraints: '',
	dependencies: '',
	outOfScope: '',
};

const FIELD_LABELS: Array<{ key: keyof DeliveryPlannerPrdFields; label: string }> = [
	{ key: 'problem', label: 'Problem' },
	{ key: 'users', label: 'Users' },
	{ key: 'successCriteria', label: 'Success Criteria' },
	{ key: 'scope', label: 'Scope' },
	{ key: 'constraints', label: 'Constraints' },
	{ key: 'dependencies', label: 'Dependencies' },
	{ key: 'outOfScope', label: 'Out of Scope' },
];

interface PRDWizardProps {
	theme: Theme;
	projectPath: string;
	gitPath: string;
	existingPrds: WorkItem[];
	editingPrd?: WorkItem | null;
	onSave: (request: DeliveryPlannerPrdSaveRequest) => Promise<void>;
	onCancel: () => void;
}

export function PRDWizard({
	theme,
	projectPath,
	gitPath,
	existingPrds,
	editingPrd,
	onSave,
	onCancel,
}: PRDWizardProps) {
	const editingFields = editingPrd?.metadata?.prdFields as DeliveryPlannerPrdFields | undefined;
	const [title, setTitle] = useState(editingPrd?.title ?? '');
	const [slug, setSlug] = useState(
		editingPrd?.metadata?.mirrorSlug?.toString() ?? slugify(editingPrd?.title ?? '')
	);
	const [fields, setFields] = useState<DeliveryPlannerPrdFields>(editingFields ?? EMPTY_FIELDS);
	const [tags, setTags] = useState(
		editingPrd?.tags.filter((tag) => !['delivery-planner', 'prd'].includes(tag)).join(', ') ?? ''
	);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const validationError = useMemo(() => {
		if (!title.trim()) return 'Title is required';
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return 'Slug must be kebab-case';
		const normalizedTitle = title.trim().toLowerCase();
		const duplicate = existingPrds.find(
			(item) =>
				item.id !== editingPrd?.id &&
				(item.title.trim().toLowerCase() === normalizedTitle || item.metadata?.mirrorSlug === slug)
		);
		if (duplicate) return 'A PRD with that name or slug already exists';
		const missing = FIELD_LABELS.find(({ key }) => !fields[key].trim());
		return missing ? `${missing.label} is required` : null;
	}, [editingPrd?.id, existingPrds, fields, slug, title]);

	const handleTitleChange = (value: string) => {
		setTitle(value);
		if (!editingPrd) {
			setSlug(slugify(value));
		}
	};

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (validationError) {
			setError(validationError);
			return;
		}
		setSaving(true);
		setError(null);
		try {
			await onSave({
				id: editingPrd?.id,
				title: title.trim(),
				slug,
				projectPath,
				gitPath,
				fields,
				tags: tags
					.split(',')
					.map((tag) => tag.trim())
					.filter(Boolean),
			});
		} catch (saveError) {
			setError(saveError instanceof Error ? saveError.message : String(saveError));
		} finally {
			setSaving(false);
		}
	};

	return (
		<form onSubmit={handleSubmit} className="h-full flex flex-col">
			<div className="grid grid-cols-2 gap-3 mb-4">
				<label className="flex flex-col gap-1">
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Title
					</span>
					<input
						value={title}
						onChange={(event) => handleTitleChange(event.target.value)}
						className="px-3 py-2 rounded border outline-none"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					/>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Slug
					</span>
					<input
						value={slug}
						onChange={(event) => setSlug(event.target.value)}
						className="px-3 py-2 rounded border outline-none font-mono text-sm"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					/>
				</label>
			</div>
			<label className="flex flex-col gap-1 mb-4">
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Tags
				</span>
				<input
					value={tags}
					onChange={(event) => setTags(event.target.value)}
					placeholder="frontend, planning"
					className="px-3 py-2 rounded border outline-none"
					style={{
						backgroundColor: theme.colors.bgMain,
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
				/>
			</label>
			<div className="flex-1 overflow-y-auto pr-1 space-y-3">
				{FIELD_LABELS.map(({ key, label }) => (
					<label key={key} className="flex flex-col gap-1">
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							{label}
						</span>
						<textarea
							value={fields[key]}
							onChange={(event) => setFields({ ...fields, [key]: event.target.value })}
							rows={3}
							className="px-3 py-2 rounded border outline-none resize-y"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
						/>
					</label>
				))}
			</div>
			{(error || validationError) && (
				<div className="mt-3 text-sm" style={{ color: theme.colors.error }}>
					{error ?? validationError}
				</div>
			)}
			<div className="flex justify-end gap-2 mt-4">
				<button
					type="button"
					onClick={onCancel}
					className="px-3 py-2 rounded"
					style={{ color: theme.colors.textDim }}
				>
					Cancel
				</button>
				<button
					type="submit"
					disabled={saving || Boolean(validationError)}
					className="inline-flex items-center gap-2 px-3 py-2 rounded disabled:opacity-50"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
				>
					<Save className="w-4 h-4" />
					{saving ? 'Saving' : 'Save PRD'}
				</button>
			</div>
		</form>
	);
}

function slugify(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/['"]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}
