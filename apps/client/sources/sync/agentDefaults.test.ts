import { describe, expect, it } from 'vitest';
import {
    getAgentDefaultOverride,
    isExplicitCodexSessionMetadata,
    resolveAgentDefaultConfig,
    resolveCodexRemotePermissionMode,
    setAgentDefaultOverride,
    shouldGuardCodexRemotePermissions,
} from './agentDefaults';

describe('Codex agent permission defaults', () => {
    it.each(['yolo', 'safe-yolo', 'bypassPermissions', 'unexpected-mode'])(
        'fails unsafe or unknown %s values closed to read-only',
        (permissionMode) => {
            expect(resolveCodexRemotePermissionMode(permissionMode)).toBe('read-only');
        },
    );

    it('normalizes a persisted unsafe Codex override before it becomes an effective default', () => {
        const persistedOverrides = {
            codex: {
                permissionMode: 'yolo',
                modelMode: 'gpt-5.5',
                effortLevel: 'high',
            },
        };

        expect(getAgentDefaultOverride(persistedOverrides, 'codex')).toEqual({
            permissionMode: 'read-only',
            modelMode: 'gpt-5.5',
            effortLevel: 'high',
        });
        expect(resolveAgentDefaultConfig(persistedOverrides, 'codex')).toEqual({
            permissionMode: 'read-only',
            modelMode: 'gpt-5.5',
            effortLevel: 'high',
        });
    });

    it('stores an unsafe Codex permission override as read-only', () => {
        expect(setAgentDefaultOverride({}, 'codex', 'permissionMode', 'yolo')).toEqual({
            codex: { permissionMode: 'read-only' },
        });
    });

    it('leaves non-Codex permission defaults unchanged', () => {
        expect(setAgentDefaultOverride({}, 'claude', 'permissionMode', 'bypassPermissions')).toEqual({
            claude: { permissionMode: 'bypassPermissions' },
        });
    });

    it('guards Codex and ambiguous legacy tasks but preserves explicit non-Codex tasks', () => {
        expect(shouldGuardCodexRemotePermissions(undefined)).toBe(true);
        expect(shouldGuardCodexRemotePermissions({ flavor: 'codex' })).toBe(true);
        expect(shouldGuardCodexRemotePermissions({ flavor: 'claude', codexThreadId: 'thread-1' })).toBe(true);
        expect(shouldGuardCodexRemotePermissions({ flavor: 'claude' })).toBe(false);
        expect(shouldGuardCodexRemotePermissions({ flavor: 'future-agent' })).toBe(true);
        expect(shouldGuardCodexRemotePermissions({ flavor: 'codex', client: { id: 'rig' } })).toBe(false);
        expect(isExplicitCodexSessionMetadata(undefined)).toBe(false);
        expect(isExplicitCodexSessionMetadata({ flavor: 'codex' })).toBe(true);
        expect(isExplicitCodexSessionMetadata({ flavor: 'claude', codexThreadId: 'thread-1' })).toBe(true);
        expect(isExplicitCodexSessionMetadata({ flavor: 'codex', client: { id: 'rig' } })).toBe(false);
    });
});
