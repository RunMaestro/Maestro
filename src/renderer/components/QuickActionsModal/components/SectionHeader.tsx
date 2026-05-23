import { memo } from 'react';

interface SectionHeaderProps {
	label: string;
	color: string;
}

export const SectionHeader = memo(function SectionHeader({ label, color }: SectionHeaderProps) {
	return (
		<div className="px-4 pt-3 pb-1 flex items-center gap-2 select-none" aria-hidden="true">
			<span className="text-[10px] font-bold tracking-[0.15em]" style={{ color }}>
				{label}
			</span>
			<div className="flex-1 border-t-2" style={{ borderColor: color, opacity: 0.4 }} />
		</div>
	);
});
