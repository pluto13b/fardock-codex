import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    machineRPC: vi.fn(),
    sessionRPC: vi.fn(),
    emitWithAck: vi.fn(),
    updateSessionAgentModes: vi.fn(),
    sessions: {} as Record<string, any>,
    encryptRaw: vi.fn(async (value: unknown) => value),
    decryptRaw: vi.fn(async (value: unknown) => value),
}));

vi.mock('./apiSocket', () => ({
    apiSocket: {
        machineRPC: mocks.machineRPC,
        sessionRPC: mocks.sessionRPC,
        emitWithAck: mocks.emitWithAck,
    },
}));

vi.mock('./storage', () => ({
    storage: {
        getState: vi.fn(() => ({
            sessions: mocks.sessions,
            updateSessionAgentModes: mocks.updateSessionAgentModes,
        })),
    },
}));

vi.mock('./sync', () => ({
    sync: {
        encryption: {
            getSessionEncryption: vi.fn(() => ({
                encryptRaw: mocks.encryptRaw,
                decryptRaw: mocks.decryptRaw,
            })),
        },
    },
}));

describe('Codex remote permission operation boundaries', () => {
    beforeEach(() => {
        mocks.machineRPC.mockReset();
        mocks.sessionRPC.mockReset();
        mocks.emitWithAck.mockReset();
        mocks.updateSessionAgentModes.mockReset();
        mocks.encryptRaw.mockClear();
        mocks.decryptRaw.mockClear();
        mocks.sessions = {};
    });

    it('fails an unknown-session yolo resume closed before RPC', async () => {
        mocks.machineRPC.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
        const { machineResumeSession } = await import('./ops');

        await machineResumeSession({
            machineId: 'machine-1',
            sessionId: 'session-1',
            permissionMode: 'yolo',
        });

        expect(mocks.machineRPC).toHaveBeenCalledWith(
            'machine-1',
            'resume-happy-session',
            { sessionId: 'session-1', model: undefined, permissionMode: 'read-only' },
        );
    });

    it('rejects session-wide Codex approval without sending an RPC', async () => {
        mocks.sessions = {
            'session-1': {
                metadata: { flavor: 'codex', codexThreadId: 'thread-1' },
                agentState: { requests: { 'approval-1': { tool: 'CodexBash', arguments: {} } } },
            },
        };
        const { sessionAllow } = await import('./ops');

        await expect(sessionAllow(
            'session-1',
            'approval-1',
            'bypassPermissions',
            ['Bash(*)'],
            'approved_for_session',
        )).rejects.toThrow('must be one-time');
        expect(mocks.sessionRPC).not.toHaveBeenCalled();
    });

    it('rejects even a one-time approval when the task identity is ambiguous', async () => {
        const { sessionAllow } = await import('./ops');

        await expect(sessionAllow('missing-session', 'approval-1', undefined, undefined, 'approved'))
            .rejects.toThrow('ambiguous or unloaded');
        expect(mocks.sessionRPC).not.toHaveBeenCalled();
    });

    it('rejects a missing or cross-task Codex request id', async () => {
        mocks.sessions = {
            'session-1': {
                metadata: { flavor: 'codex', codexThreadId: 'thread-1' },
                agentState: { requests: { 'approval-real': { tool: 'CodexBash', arguments: {} } } },
            },
        };
        const { sessionAllow } = await import('./ops');

        await expect(sessionAllow('session-1', 'approval-other', undefined, undefined, 'approved'))
            .rejects.toThrow('belongs to another task');
        expect(mocks.sessionRPC).not.toHaveBeenCalled();
    });

    it('allows a one-time Codex approval', async () => {
        mocks.sessions = {
            'session-1': {
                metadata: { flavor: 'codex', codexThreadId: 'thread-1' },
                agentState: { requests: { 'approval-1': { tool: 'CodexBash', arguments: {} } } },
            },
        };
        mocks.sessionRPC.mockResolvedValue(undefined);
        const { sessionAllow } = await import('./ops');

        await sessionAllow('session-1', 'approval-1', undefined, undefined, 'approved');

        expect(mocks.sessionRPC).toHaveBeenCalledWith('session-1', 'permission', {
            id: 'approval-1',
            approved: true,
            mode: undefined,
            allowTools: undefined,
            decision: 'approved',
            updatedInput: undefined,
        });
    });

    it('clamps a stale Codex mode before optimistic metadata update', async () => {
        mocks.sessions = {
            'session-1': {
                permissionMode: 'default',
                modelMode: null,
                effortLevel: null,
                metadataVersion: 1,
                metadata: { flavor: 'codex', codexThreadId: 'thread-1', permissionMode: 'default' },
            },
        };
        mocks.emitWithAck.mockResolvedValue({ result: 'success', version: 2 });
        const { sessionSetAgentModes } = await import('./ops');

        sessionSetAgentModes('session-1', { permissionMode: 'yolo' });
        await vi.waitFor(() => {
            expect(mocks.updateSessionAgentModes).toHaveBeenCalledWith('session-1', {
                permissionMode: 'read-only',
            });
        });
    });

    it('preserves an explicit non-Codex permission mode', async () => {
        mocks.sessions = {
            'session-1': {
                permissionMode: 'default',
                modelMode: null,
                effortLevel: null,
                metadataVersion: 1,
                metadata: { flavor: 'claude', permissionMode: 'default' },
            },
        };
        mocks.emitWithAck.mockResolvedValue({ result: 'success', version: 2 });
        const { sessionSetAgentModes } = await import('./ops');

        sessionSetAgentModes('session-1', { permissionMode: 'bypassPermissions' });
        await vi.waitFor(() => {
            expect(mocks.updateSessionAgentModes).toHaveBeenCalledWith('session-1', {
                permissionMode: 'bypassPermissions',
            });
        });
    });
});
