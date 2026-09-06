/**
 * UI Components - Reusable UI primitives
 *
 * This directory contains shared UI components that encapsulate common
 * patterns used throughout the application.
 */

export { Modal, ModalFooter, ModalSubtitle } from './Modal';
export type { ModalProps, ModalFooterProps } from './Modal';

export { FormInput } from './FormInput';
export type { FormInputProps } from './FormInput';

export { FilterInput } from './FilterInput';
export type { FilterInputProps } from './FilterInput';

export { EmojiPickerField, EmojiPickerOverlay, GroupAppearancePicker } from './EmojiPickerField';
export type {
	EmojiPickerFieldProps,
	EmojiPickerOverlayProps,
	GroupAppearancePickerProps,
} from './EmojiPickerField';

export { ToggleSwitch, ToggleSwitchTrack } from './ToggleSwitch';
export type { ToggleSwitchProps, ToggleSwitchTrackProps, ToggleSwitchSize } from './ToggleSwitch';

export { ProviderAvailabilityBar, PROVIDER_BAR_NAV_EXEMPT_ATTR } from './ProviderAvailabilityBar';
export type { ProviderAvailabilityBarProps } from './ProviderAvailabilityBar';

export { CollapsedCommandsNotice } from './CollapsedCommandsNotice';
export type { CollapsedCommandsNoticeProps } from './CollapsedCommandsNotice';

export { RadioGroup } from './RadioGroup';
export type { RadioGroupProps, RadioOption } from './RadioGroup';
export { SegmentedControl } from './SegmentedControl';
export type { SegmentedControlProps, SegmentedOption } from './SegmentedControl';

export { SortableTh } from './SortableTh';
export type { SortableThProps } from './SortableTh';

export { Spinner } from './Spinner';
export type { SpinnerProps } from './Spinner';

export { Pager } from './Pager';
export type { PagerProps } from './Pager';

export { HeaderActionButton } from './HeaderActionButton';
export type { HeaderActionButtonProps } from './HeaderActionButton';

export { GhostIconButton } from './GhostIconButton';
export type { GhostIconButtonProps } from './GhostIconButton';

export { EmptyStatePlaceholder } from './EmptyStatePlaceholder';
export type { EmptyStatePlaceholderProps } from './EmptyStatePlaceholder';

export { ShortcutFilterButton } from './ShortcutFilterButton';
export type { ShortcutFilterButtonProps } from './ShortcutFilterButton';

export { WorktreePill } from './WorktreePill';

export { TurnSettingPills } from './TurnSettingPills';
export type { TurnSettingPillsProps } from './TurnSettingPills';

export { HoverTooltip } from './HoverTooltip';
export type { HoverTooltipProps } from './HoverTooltip';

export { ResizeHandles } from './ResizeHandles';

export { CalendarPicker } from './CalendarPicker';
export type { CalendarPickerProps } from './CalendarPicker';

export { EscCloseButton } from './EscCloseButton';
export type { EscCloseButtonProps } from './EscCloseButton';

export { Keycap, KeycapHint } from './Keycap';
export type { KeycapProps, KeycapHintProps, KeycapTone } from './Keycap';

export { CopyIconButton } from './CopyIconButton';
export type { CopyIconButtonProps } from './CopyIconButton';

export { FontScaleControl } from './FontScaleControl';
export type { FontScaleControlProps } from './FontScaleControl';
export { ScaleControl } from './ScaleControl';
export type { ScaleControlProps } from './ScaleControl';

export { GitChangeCounts } from './GitChangeCounts';
export type { GitChangeCountsProps } from './GitChangeCounts';

export { GitRunningBadge } from './GitRunningBadge';
export type { GitRunningBadgeProps } from './GitRunningBadge';

export { TextareaLineNumbers, lineNumberGutterMetrics } from './TextareaLineNumbers';
export type { TextareaLineNumbersProps, LineNumberGutterMetrics } from './TextareaLineNumbers';

export { CornerDot } from './CornerDot';
export type { CornerDotProps } from './CornerDot';

export { CountBadge } from './CountBadge';
export type { CountBadgeProps } from './CountBadge';

export { MiniBadge } from './MiniBadge';
export type { MiniBadgeProps } from './MiniBadge';
