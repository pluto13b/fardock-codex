import { describe, expect, it } from 'vitest';
import { getDesktopSidebarWidth } from './sidebarLayout';

describe('getDesktopSidebarWidth', () => {
    it('stays compact at the desktop breakpoint', () => {
        expect(getDesktopSidebarWidth(900)).toBe(260);
        expect(getDesktopSidebarWidth(1024)).toBe(260);
    });

    it('caps wide desktop sidebars at the Codex reference width', () => {
        expect(getDesktopSidebarWidth(1920)).toBe(280);
        expect(getDesktopSidebarWidth(2560)).toBe(280);
    });
});
