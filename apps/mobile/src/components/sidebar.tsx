// Native fallback - the sidebar is only used on web.
// On native, the Drawer navigator in _layout.tsx handles navigation.

export function Sidebar(_props: {
	isOpen: boolean;
	onToggle: () => void;
	isCollapsed: boolean;
	onCollapse: () => void;
}) {
	return null;
}

export function SidebarToggle(_props: { onPress: () => void }) {
	return null;
}
