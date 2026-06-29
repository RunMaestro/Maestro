import type { Theme } from '../../../../../types';

interface EncoreHeaderProps {
	theme: Theme;
}

export function EncoreHeader({ theme }: EncoreHeaderProps) {
	return (
		<div>
			<h3 className="text-sm font-bold mb-2" style={{ color: theme.colors.textMain }}>
				Encore Features
			</h3>
			<p className="text-xs" style={{ color: theme.colors.textDim }}>
				Optional features that extend Maestro&apos;s capabilities. Enable the ones you want.
				Disabled features are completely hidden from shortcuts, menus, and the command palette.
				Contributors building new features should consider gating them here to keep the core
				experience focused.
			</p>
		</div>
	);
}
