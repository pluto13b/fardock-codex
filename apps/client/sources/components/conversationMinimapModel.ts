/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted by Codex Plus in 2026 from AionUi's MessageAnchorRail geometry and
 * anchor model for a React Native Web inverted FlatList.
 */

import type { DisplayItem } from '@/hooks/useGroupedMessages';
import { parseLocalCommandMessage } from './parseLocalCommandMessage';

export type ConversationMinimapAnchor = {
    /** Oldest-to-newest, one based. */
    turnNumber: number;
    messageId: string;
    /** The real index in the newest-first FlatList data. */
    displayIndex: number;
    title: string;
    body: string;
};

export const MINIMAP_MARKER_HEIGHT = 2;
export const MINIMAP_MARKER_PITCH = 10;
export const MINIMAP_MAX_VISIBLE_MARKERS = 36;
export const MINIMAP_MAX_MARKER_WIDTH = 26;

const EMPTY_MESSAGE_TITLE = '图片或附件';
const TITLE_MAX_CHARS = 96;
const BODY_MAX_CHARS = 220;

function truncateText(value: string, maxChars: number): string {
    const characters = Array.from(value);
    if (characters.length <= maxChars) return value;
    return `${characters.slice(0, Math.max(0, maxChars - 1)).join('')}…`;
}

function normalizeLine(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

export function getConversationMinimapPreview(value: string): { title: string; body: string } {
    const lines = value
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(normalizeLine)
        .filter(Boolean);

    if (lines.length === 0) {
        return { title: EMPTY_MESSAGE_TITLE, body: '' };
    }

    return {
        title: truncateText(lines[0], TITLE_MAX_CHARS),
        body: truncateText(lines.slice(1).join(' '), BODY_MAX_CHARS),
    };
}

/**
 * Build oldest-to-newest anchors while retaining indexes into the inverted,
 * newest-first display list. Group rows never become anchors.
 */
export function buildConversationMinimapAnchors(
    displayItems: readonly DisplayItem[],
): ConversationMinimapAnchor[] {
    const anchors: ConversationMinimapAnchor[] = [];

    for (let displayIndex = displayItems.length - 1; displayIndex >= 0; displayIndex -= 1) {
        const item = displayItems[displayIndex];
        if (item.type !== 'message' || item.message.kind !== 'user-text') continue;

        const visibleText = item.message.displayText ?? item.message.text;
        const parsed = parseLocalCommandMessage(visibleText);
        if (parsed.kind === 'caveat' || parsed.kind === 'goal-confirmation') continue;

        const preview = getConversationMinimapPreview(visibleText);
        anchors.push({
            turnNumber: anchors.length + 1,
            messageId: item.message.id,
            displayIndex,
            ...preview,
        });
    }

    return anchors;
}

/** Codex-style left-aligned fisheye expansion around the hovered marker. */
export function getConversationMinimapMarkerWidth(distance: number): number {
    if (distance <= 0) return 26;
    if (distance === 1) return 20;
    if (distance === 2) return 14;
    if (distance === 3) return 10;
    return 6;
}

export function getConversationMinimapStackHeight(count: number): number {
    return Math.max(0, count) * MINIMAP_MARKER_PITCH;
}

export function getConversationMinimapViewportHeight(availableHeight: number, count: number): number {
    const visibleCount = Math.min(Math.max(0, count), MINIMAP_MAX_VISIBLE_MARKERS);
    return Math.min(Math.max(0, availableHeight), getConversationMinimapStackHeight(visibleCount));
}

export function getConversationMinimapStackTop(
    availableHeight: number,
    viewportHeight: number,
): number {
    return Math.max(0, (availableHeight - viewportHeight) / 2);
}

export function getConversationMinimapScrollTop(
    index: number,
    count: number,
    viewportHeight: number,
): number {
    const maxScroll = Math.max(0, getConversationMinimapStackHeight(count) - viewportHeight);
    const centered = index * MINIMAP_MARKER_PITCH
        + MINIMAP_MARKER_PITCH / 2
        - viewportHeight / 2;
    return Math.min(maxScroll, Math.max(0, centered));
}
