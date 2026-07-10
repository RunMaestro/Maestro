import {
	Archive,
	BookOpen,
	Briefcase,
	Calendar,
	Code2,
	Folder,
	Heart,
	Layers,
	Lightbulb,
	Palette,
	Rocket,
	Shield,
	Star,
	Target,
	Wrench,
	Zap,
	type LucideIcon,
} from 'lucide-react';

export interface GroupIconOption {
	id: string;
	label: string;
	Icon: LucideIcon;
}

export const GROUP_ICON_OPTIONS: readonly GroupIconOption[] = [
	{ id: 'folder', label: 'Folder', Icon: Folder },
	{ id: 'briefcase', label: 'Briefcase', Icon: Briefcase },
	{ id: 'rocket', label: 'Rocket', Icon: Rocket },
	{ id: 'code', label: 'Code', Icon: Code2 },
	{ id: 'star', label: 'Star', Icon: Star },
	{ id: 'heart', label: 'Heart', Icon: Heart },
	{ id: 'lightbulb', label: 'Lightbulb', Icon: Lightbulb },
	{ id: 'target', label: 'Target', Icon: Target },
	{ id: 'calendar', label: 'Calendar', Icon: Calendar },
	{ id: 'book', label: 'Book', Icon: BookOpen },
	{ id: 'layers', label: 'Layers', Icon: Layers },
	{ id: 'shield', label: 'Shield', Icon: Shield },
	{ id: 'wrench', label: 'Wrench', Icon: Wrench },
	{ id: 'palette', label: 'Palette', Icon: Palette },
	{ id: 'archive', label: 'Archive', Icon: Archive },
	{ id: 'zap', label: 'Zap', Icon: Zap },
];

export const GROUP_LABEL_COLORS = [
	{ value: '#EF4444', label: 'Red' },
	{ value: '#F97316', label: 'Orange' },
	{ value: '#EAB308', label: 'Yellow' },
	{ value: '#22C55E', label: 'Green' },
	{ value: '#14B8A6', label: 'Teal' },
	{ value: '#3B82F6', label: 'Blue' },
	{ value: '#EC4899', label: 'Pink' },
	{ value: '#A855F7', label: 'Purple' },
] as const;
