/**
 * Codex desktop keeps its navigation rail compact instead of letting it take
 * 30% of a wide monitor. The clamp still leaves a little room at the 900px
 * desktop breakpoint while converging on the 280px reference width.
 */
export function getDesktopSidebarWidth(windowWidth: number): number {
    return Math.min(Math.max(Math.floor(windowWidth * 0.18), 260), 280);
}
