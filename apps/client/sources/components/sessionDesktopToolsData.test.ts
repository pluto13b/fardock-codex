import { describe, expect, it } from 'vitest';
import {
    extractSessionSources,
    getGitChangeStats,
    getPathShortName,
    getSubagentStats,
    type SourceMessageLike,
} from './sessionDesktopToolsData';

describe('sessionDesktopToolsData', () => {
    it('gets a short name from Windows and POSIX paths', () => {
        expect(getPathShortName('C:\\Projects\\codex-plus\\')).toBe('codex-plus');
        expect(getPathShortName('/srv/codex-plus/docs/PROGRESS.md')).toBe('PROGRESS.md');
        expect(getPathShortName('C:\\')).toBe('C:\\');
        expect(getPathShortName('/')).toBe('/');
        expect(getPathShortName(null)).toBe('不可用');
    });

    it('summarizes git and subagent counters without negative values', () => {
        expect(getGitChangeStats({
            modifiedCount: 2,
            untrackedCount: 1,
            stagedCount: 3,
            linesAdded: 25,
            linesRemoved: 12,
        } as any)).toEqual({ entryCount: 6, linesAdded: 25, linesRemoved: 12 });
        expect(getGitChangeStats(null)).toBeNull();

        expect(getSubagentStats({ running: 2, queued: 1, total: 8 })).toEqual({
            running: 2,
            queued: 1,
            completed: 5,
            total: 8,
        });
        expect(getSubagentStats({ running: 2, queued: 1, total: 1 })).toEqual({
            running: 2,
            queued: 1,
            completed: 0,
            total: 3,
        });
    });

    it('extracts recent explicit file and image tool inputs only', () => {
        // Session storage exposes messages newest first.
        const messages: SourceMessageLike[] = [
            {
                kind: 'tool-call',
                tool: { name: 'view_image', input: { path: 'c:\\temp\\PREVIEW.png' } },
            },
            {
                kind: 'tool-call',
                tool: { name: 'view_image', input: { path: 'https://example.com/not-local.png' } },
            },
            {
                kind: 'tool-call',
                tool: {
                    name: 'functions.view_image',
                    input: { path: 'C:\\Temp\\preview.png' },
                },
                children: [{
                    kind: 'tool-call',
                    tool: { name: 'read_file', input: { locations: [{ path: 'README.md' }] } },
                }],
            },
            {
                kind: 'tool-call',
                tool: { name: 'Bash', input: { command: 'cat C:\\secrets.txt' } },
            },
            {
                kind: 'tool-call',
                tool: { name: 'Read', input: { file_path: 'docs/PROGRESS.md' } },
            },
        ];

        expect(extractSessionSources(messages)).toEqual([
            {
                key: 'c:/temp/preview.png',
                kind: 'image',
                label: 'PREVIEW.png',
                path: 'c:\\temp\\PREVIEW.png',
            },
            {
                key: 'readme.md',
                kind: 'file',
                label: 'README.md',
                path: 'README.md',
            },
            {
                key: 'docs/progress.md',
                kind: 'file',
                label: 'PROGRESS.md',
                path: 'docs/PROGRESS.md',
            },
        ]);
        expect(extractSessionSources(messages, 1)).toEqual([{
            key: 'c:/temp/preview.png',
            kind: 'image',
            label: 'PREVIEW.png',
            path: 'c:\\temp\\PREVIEW.png',
        }]);
        expect(extractSessionSources(messages, 0)).toEqual([]);
    });

    it('shows a local attachment name without exposing its ref or preview URI', () => {
        const messages: SourceMessageLike[] = [{
            kind: 'tool-call',
            tool: {
                name: 'file',
                input: {
                    ref: 'relay-secret-ref',
                    previewUri: 'data:image/png;base64,secret-payload',
                    name: 'codex-clipboard-example.png',
                    size: 128,
                    image: { width: 20, height: 20 },
                },
            },
        }];

        const sources = extractSessionSources(messages);
        expect(sources).toEqual([{
            key: 'codex-clipboard-example.png',
            kind: 'image',
            label: 'codex-clipboard-example.png',
            path: 'codex-clipboard-example.png',
        }]);
        expect(JSON.stringify(sources)).not.toContain('relay-secret-ref');
        expect(JSON.stringify(sources)).not.toContain('secret-payload');
    });
});
