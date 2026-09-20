import { describe, expect, it } from 'vitest';
import {
    COMPOSER_EFFORT_MENU_WIDTH,
    COMPOSER_MODEL_MENU_WIDTH,
    getComposerChoiceMenuWidth,
} from './composerControlMenuLayout';

describe('getComposerChoiceMenuWidth', () => {
    it('uses the Codex reference widths on roomy viewports', () => {
        expect(getComposerChoiceMenuWidth('model', 1440)).toBe(COMPOSER_MODEL_MENU_WIDTH);
        expect(getComposerChoiceMenuWidth('effort', 1440)).toBe(COMPOSER_EFFORT_MENU_WIDTH);
    });

    it('keeps the model menu inside a 360px phone viewport', () => {
        expect(getComposerChoiceMenuWidth('model', 360)).toBe(344);
        expect(getComposerChoiceMenuWidth('effort', 360)).toBe(COMPOSER_EFFORT_MENU_WIDTH);
    });
});
