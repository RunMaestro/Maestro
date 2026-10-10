import { AlertTriangle } from 'lucide-react';
import type { Theme } from '../../../types';

interface MissingDocumentsWarningProps {
	theme: Theme;
	missingDocCount: number;
}

export function MissingDocumentsWarning({ theme, missingDocCount }: MissingDocumentsWarningProps) {
	if (missingDocCount === 0) return null;

	return (
		<div
			className="mt-2 flex items-center gap-2 p-2 rounded border text-xs"
			style={{
				backgroundColor: theme.colors.warning + '10',
				borderColor: theme.colors.warning + '40',
				color: theme.colors.warning,
			}}
		>
			<AlertTriangle className="w-3.5 h-3.5 shrink-0" />
			<span>
				{missingDocCount} document{missingDocCount > 1 ? 's' : ''} no longer exist
				{missingDocCount === 1 ? 's' : ''} in the folder and will be skipped
			</span>
		</div>
	);
}
