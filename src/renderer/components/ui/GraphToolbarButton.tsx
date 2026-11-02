import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Theme } from '../../types';

interface GraphToolbarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	theme: Theme;
	icon?: ReactNode;
	active?: boolean;
}

/** The tinted controls shared by the Document and Delegation Graph headers. */
export const GraphToolbarButton = forwardRef<HTMLButtonElement, GraphToolbarButtonProps>(
	function GraphToolbarButton(
		{ theme, icon, active = false, children, className = '', ...props },
		ref
	) {
		const background = `${theme.colors.accent}${active ? '25' : '10'}`;
		return (
			<button
				{...props}
				ref={ref}
				type="button"
				className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm whitespace-nowrap shrink-0 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
				style={{
					backgroundColor: background,
					color: active ? theme.colors.accent : theme.colors.textDim,
				}}
				onMouseEnter={(event) => {
					if (!props.disabled)
						event.currentTarget.style.backgroundColor = `${theme.colors.accent}30`;
				}}
				onMouseLeave={(event) => {
					event.currentTarget.style.backgroundColor = background;
				}}
			>
				{icon && <span className="shrink-0 [&>svg]:w-4 [&>svg]:h-4">{icon}</span>}
				{children}
			</button>
		);
	}
);
