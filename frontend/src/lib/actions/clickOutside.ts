/** Dismiss a dropdown when interaction lands outside its container.
 *
 * Attach to the element wrapping both the toggle button and the panel, so
 * toggling never counts as "outside". Fires on `pointerdown` (covers mouse
 * and touch) in the capture phase, plus `Escape` for keyboard users.
 */
export function clickOutside(node: HTMLElement, onOutside: () => void) {
	function onPointer(e: PointerEvent) {
		if (!node.contains(e.target as Node | null)) onOutside();
	}
	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') onOutside();
	}
	document.addEventListener('pointerdown', onPointer, true);
	document.addEventListener('keydown', onKey, true);
	return {
		destroy() {
			document.removeEventListener('pointerdown', onPointer, true);
			document.removeEventListener('keydown', onKey, true);
		}
	};
}
