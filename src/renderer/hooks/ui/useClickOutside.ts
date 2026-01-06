/**
 * useClickOutside - Reusable hook for detecting clicks outside of an element
 *
 * This hook encapsulates the common pattern of closing menus, dropdowns, overlays,
 * and other UI elements when clicking outside of them. It handles:
 * - Event listener registration/cleanup
 * - Optional conditional activation (only active when enabled)
 * - Optional delayed activation (to avoid immediate trigger from opening click)
 * - Multiple excluded refs (e.g., exclude both dropdown and trigger button)
 *
 * Usage:
 * ```tsx
 * // Basic usage - always active
 * const menuRef = useRef<HTMLDivElement>(null);
 * useClickOutside(menuRef, () => setOpen(false));
 *
 * // Conditional - only active when dropdown is open
 * useClickOutside(menuRef, () => setOpen(false), isOpen);
 *
 * // With options - delayed to avoid immediate trigger
 * useClickOutside(menuRef, () => setOpen(false), isOpen, { delay: true });
 *
 * // Multiple excluded refs - exclude both menu and trigger button
 * useClickOutside([menuRef, buttonRef], () => setOpen(false), isOpen);
 * ```
 */

import { useEffect, RefObject } from 'react';

export interface UseClickOutsideOptions {
  /**
   * Event type to listen for. Defaults to 'mousedown'.
   * Use 'click' if you need the click to complete (e.g., for button toggles).
   */
  eventType?: 'mousedown' | 'click';

  /**
   * Whether to delay adding the event listener using setTimeout(0).
   * This prevents the click that opened the element from immediately closing it.
   * Useful when the element is shown in response to a click event.
   */
  delay?: boolean;
}

/**
 * Detect clicks outside of one or more elements
 *
 * @param ref - Single ref or array of refs to element(s) to exclude from click detection
 * @param onClickOutside - Callback when a click occurs outside all excluded elements
 * @param enabled - Whether the detection is active (defaults to true)
 * @param options - Additional options for event handling
 *
 * @example
 * // Simple dropdown
 * const dropdownRef = useRef<HTMLDivElement>(null);
 * useClickOutside(dropdownRef, closeDropdown, isOpen);
 *
 * @example
 * // With delayed activation (for click-triggered menus)
 * useClickOutside(menuRef, closeMenu, isOpen, { delay: true, eventType: 'click' });
 *
 * @example
 * // Multiple excluded elements (dropdown + trigger)
 * useClickOutside(
 *   [dropdownRef, triggerButtonRef],
 *   closeDropdown,
 *   isOpen
 * );
 */
export function useClickOutside<T extends HTMLElement = HTMLElement>(
  ref: RefObject<T | null> | RefObject<T | null>[],
  onClickOutside: () => void,
  enabled: boolean = true,
  options: UseClickOutsideOptions = {}
): void {
  const { eventType = 'mousedown', delay = false } = options;

  useEffect(() => {
    if (!enabled) return;

    const handleClickOutside = (e: Event) => {
      const refs = Array.isArray(ref) ? ref : [ref];
      const target = e.target as Node;

      // Check if click is inside any of the excluded elements
      const isInside = refs.some(
        (r) => r.current && r.current.contains(target)
      );

      if (!isInside) {
        onClickOutside();
      }
    };

    if (delay) {
      // Use setTimeout to avoid immediate trigger from the click that opened it
      const timeoutId = setTimeout(() => {
        document.addEventListener(eventType, handleClickOutside);
      }, 0);

      return () => {
        clearTimeout(timeoutId);
        document.removeEventListener(eventType, handleClickOutside);
      };
    } else {
      document.addEventListener(eventType, handleClickOutside);
      return () => document.removeEventListener(eventType, handleClickOutside);
    }
    // Note: ref is intentionally excluded from dependencies.
    // Refs are stable across renders by design, and including them
    // causes unnecessary listener re-registration when parent re-renders.
  }, [onClickOutside, enabled, eventType, delay]);
}
