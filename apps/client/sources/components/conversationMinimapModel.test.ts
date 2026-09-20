import { describe, expect, it } from 'vitest';
import type { DisplayItem } from '@/hooks/useGroupedMessages';
import {
    buildConversationMinimapAnchors,
    getConversationMinimapMarkerWidth,
    getConversationMinimapPreview,
    getConversationMinimapScrollTop,
    getConversationMinimapStackHeight,
    getConversationMinimapStackTop,
    getConversationMinimapViewportHeight,
} from './conversationMinimapModel';

function userItem(id: string, text: string, displayText?: string): DisplayItem {
    return {
        type: 'message',
        id,
        message: {
            kind: 'user-text',
            id,
            localId: null,
            createdAt: 1,
            text,
            displayText,
        },
    };
}

function agentItem(id: string): DisplayItem {
    return {
        type: 'message',
        id,
        message: {
            kind: 'agent-text',
            id,
            localId: null,
            createdAt: 1,
            text: 'assistant',
        },
    };
}

describe('conversationMinimapModel', () => {
    it('maps newest-first display items to oldest-first user anchors', () => {
        const items: DisplayItem[] = [
            userItem('newest-user', '最新问题'),
            agentItem('answer'),
            userItem('oldest-user', '最早问题'),
        ];

        expect(buildConversationMinimapAnchors(items)).toEqual([
            {
                turnNumber: 1,
                messageId: 'oldest-user',
                displayIndex: 2,
                title: '最早问题',
                body: '',
            },
            {
                turnNumber: 2,
                messageId: 'newest-user',
                displayIndex: 0,
                title: '最新问题',
                body: '',
            },
        ]);
    });

    it('uses displayText, removes invisible caveats, and keeps multiline previews', () => {
        const items: DisplayItem[] = [
            userItem('visible', 'raw text', '第一行\n第二行   保留为摘要'),
            userItem('hidden', '<local-command-caveat>hidden</local-command-caveat>'),
        ];

        expect(buildConversationMinimapAnchors(items)).toEqual([
            {
                turnNumber: 1,
                messageId: 'visible',
                displayIndex: 0,
                title: '第一行',
                body: '第二行 保留为摘要',
            },
        ]);
    });

    it('handles attachment-only and long Unicode previews without splitting pairs', () => {
        expect(getConversationMinimapPreview('   \n')).toEqual({ title: '图片或附件', body: '' });
        const preview = getConversationMinimapPreview(`${'界'.repeat(120)}\n${'🙂'.repeat(260)}`);
        expect(Array.from(preview.title)).toHaveLength(96);
        expect(preview.title.endsWith('…')).toBe(true);
        expect(Array.from(preview.body)).toHaveLength(220);
        expect(preview.body.endsWith('…')).toBe(true);
    });

    it('matches the Codex fisheye marker widths', () => {
        expect([0, 1, 2, 3, 4].map(getConversationMinimapMarkerWidth)).toEqual([26, 20, 14, 10, 6]);
    });

    it('centers a fixed-pitch rail and clamps its internal scrolling', () => {
        expect(getConversationMinimapStackHeight(31)).toBe(310);
        expect(getConversationMinimapViewportHeight(600, 31)).toBe(310);
        expect(getConversationMinimapStackTop(600, 310)).toBe(145);

        const viewport = getConversationMinimapViewportHeight(600, 80);
        expect(viewport).toBe(360);
        expect(getConversationMinimapScrollTop(0, 80, viewport)).toBe(0);
        expect(getConversationMinimapScrollTop(79, 80, viewport)).toBe(440);
    });
});
