import { Edit, Eye } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { formatShortcutKeys } from '../../../../../utils/shortcutFormatter';
import type { DocumentEditorMode } from '../types';

interface EditorModeToggleProps {
	mode: DocumentEditorMode;
	onModeChange: (mode: DocumentEditorMode) => void;
	theme: Theme;
	isLocked: boolean;
}

export function EditorModeToggle({
	mode,
	onModeChange,
	theme,
	isLocked,
}: EditorModeToggleProps): JSX.Element {
	return (
		<div className="flex gap-2">
			<button
				onClick={() => !isLocked && onModeChange('edit')}
				disabled={isLocked}
				className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors ${
					mode === 'edit' && !isLocked ? 'font-semibold' : ''
				} ${isLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
				style={{
					backgroundColor: mode === 'edit' && !isLocked ? theme.colors.bgActivity : 'transparent',
					color: isLocked
						? theme.colors.textDim
						: mode === 'edit'
							? theme.colors.textMain
							: theme.colors.textDim,
					border: `1px solid ${
						mode === 'edit' && !isLocked ? theme.colors.accent : theme.colors.border
					}`,
				}}
				title={`Edit document (${formatShortcutKeys(['Meta', 'e'])})`}
			>
				<Edit className="w-3.5 h-3.5" />
				Edit
			</button>
			<button
				onClick={() => onModeChange('preview')}
				className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors ${
					mode === 'preview' ? 'font-semibold' : ''
				}`}
				style={{
					backgroundColor: mode === 'preview' ? theme.colors.bgActivity : 'transparent',
					color: mode === 'preview' ? theme.colors.textMain : theme.colors.textDim,
					border: `1px solid ${mode === 'preview' ? theme.colors.accent : theme.colors.border}`,
				}}
				title={`Preview document (${formatShortcutKeys(['Meta', 'e'])})`}
			>
				<Eye className="w-3.5 h-3.5" />
				Preview
			</button>
		</div>
	);
}
