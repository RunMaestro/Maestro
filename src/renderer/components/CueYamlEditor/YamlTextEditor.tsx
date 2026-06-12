/**
 * YamlTextEditor — YAML textarea with line numbers gutter and validation display.
 */

import { useCallback } from 'react';
import type { Theme } from '../../types';

interface YamlTextEditorProps {
	theme: Theme;
	yamlContent: string;
	onYamlChange: (value: string) => void;
	readOnly?: boolean;
	isValid: boolean;
	validationErrors: string[];
}

export function YamlTextEditor({
	theme,
	yamlContent,
	onYamlChange,
	readOnly,
	isValid,
	validationErrors,
}: YamlTextEditorProps) {
	// Handle Tab key in textarea for indentation
	const handleYamlKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === 'Tab') {
				e.preventDefault();
				const textarea = e.currentTarget;
				const start = textarea.selectionStart;
				const end = textarea.selectionEnd;
				const indent = '  ';
				const newValue = yamlContent.substring(0, start) + indent + yamlContent.substring(end);
				onYamlChange(newValue);
				requestAnimationFrame(() => {
					textarea.selectionStart = textarea.selectionEnd = start + indent.length;
				});
			}
		},
		[yamlContent, onYamlChange]
	);

	return (
		<div className="flex flex-col gap-3 overflow-hidden" style={{ width: '65%' }}>
			<h3
				className="text-xs font-bold uppercase tracking-wider shrink-0"
				style={{ color: theme.colors.textDim }}
			>
				YAML Configuration
			</h3>
			<div
				className="flex-1 flex rounded border overflow-hidden min-h-0"
				style={{
					borderColor: theme.colors.border,
					opacity: readOnly ? 0.5 : 1,
					pointerEvents: readOnly ? 'none' : 'auto',
				}}
			>
				{/* Line numbers gutter */}
				<div
					className="py-3 px-2 text-right select-none font-mono text-xs leading-[1.35rem] overflow-hidden"
					style={{
						backgroundColor: theme.colors.bgActivity,
						color: theme.colors.textDim,
						minWidth: 40,
					}}
					data-testid="line-numbers"
					aria-hidden="true"
				>
					{yamlContent.split('\n').map((_, i) => (
						<div key={i}>{i + 1}</div>
					))}
				</div>
				{/* Editor textarea */}
				<textarea
					value={yamlContent}
					onChange={(e) => onYamlChange(e.target.value)}
					onKeyDown={handleYamlKeyDown}
					readOnly={readOnly}
					spellCheck={false}
					className="flex-1 py-3 px-3 bg-transparent outline-none text-sm resize-none font-mono leading-[1.35rem]"
					style={{ color: theme.colors.textMain }}
					data-testid="yaml-editor"
				/>
			</div>

			{/* Validation errors */}
			{!isValid && validationErrors.length > 0 && (
				<div
					className="rounded px-3 py-2 text-xs space-y-1 shrink-0"
					style={{ backgroundColor: `${theme.colors.error}15` }}
					data-testid="validation-errors"
				>
					{validationErrors.map((err, i) => (
						<div key={i} style={{ color: theme.colors.error }}>
							{err}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
