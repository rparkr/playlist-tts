// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { clickOutside } from './clickOutside';

describe('clickOutside', () => {
	it('calls back on outside pointerdown, ignores inside ones', () => {
		expect.hasAssertions();
		document.body.innerHTML = '<div id="wrap"><button id="in">x</button></div><div id="out"></div>';
		const wrap = document.getElementById('wrap') as HTMLElement;
		const cb = vi.fn();
		const action = clickOutside(wrap, cb);
		document.getElementById('in')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		expect(cb).not.toHaveBeenCalled();
		document.getElementById('out')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		expect(cb).toHaveBeenCalledTimes(1);
		action.destroy();
	});

	it('calls back on Escape and stops after destroy', () => {
		expect.hasAssertions();
		document.body.innerHTML = '<div id="wrap"></div><div id="out"></div>';
		const wrap = document.getElementById('wrap') as HTMLElement;
		const cb = vi.fn();
		const action = clickOutside(wrap, cb);
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(cb).toHaveBeenCalledTimes(1);
		action.destroy();
		document.getElementById('out')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(cb).toHaveBeenCalledTimes(1);
	});
});
