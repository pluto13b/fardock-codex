export type ComposerChoiceMenuKind = 'model' | 'effort';

export const COMPOSER_MODEL_MENU_WIDTH = 352;
export const COMPOSER_EFFORT_MENU_WIDTH = 228;
export const COMPOSER_MENU_VIEWPORT_GUTTER = 16;

export function getComposerChoiceMenuWidth(
    kind: ComposerChoiceMenuKind,
    viewportWidth: number,
): number {
    const target = kind === 'model'
        ? COMPOSER_MODEL_MENU_WIDTH
        : COMPOSER_EFFORT_MENU_WIDTH;
    return Math.min(target, Math.max(0, viewportWidth - COMPOSER_MENU_VIEWPORT_GUTTER));
}
