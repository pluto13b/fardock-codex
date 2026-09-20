import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    machines: [] as Array<{
        id: string;
        online: boolean;
        metadata?: any;
    }>,
    defaultOverrides: {},
    draft: null as any,
    navigateToSession: vi.fn(),
    machineSpawnNewSession: vi.fn(),
    sessionSetAgentModes: vi.fn(),
    refreshSessions: vi.fn(),
    sendMessage: vi.fn(),
    createWorktree: vi.fn(),
    alert: vi.fn(),
    confirm: vi.fn(),
    delay: vi.fn(),
    uuidCount: 0,
}));

// Keep spawn request IDs deterministic without coupling the tests to UUIDs.
vi.mock('expo-crypto', () => ({ randomUUID: () => `spawn-request-${++mocks.uuidCount}` }));

vi.mock('react', () => ({
    useState: <T,>(value: T) => [value, vi.fn()] as const,
    useRef: <T,>(value: T) => ({ current: value }),
    useCallback: <T,>(callback: T) => callback,
    useEffect: (effect: () => void | (() => void)) => { effect(); },
}));

vi.mock('@/sync/storage', () => ({
    useAllMachines: () => mocks.machines,
    useSetting: () => mocks.defaultOverrides,
}));

vi.mock('@/sync/agentDefaults', () => ({
    resolveAgentDefaultConfig: (
        overrides: Record<string, unknown>,
        agentType: string,
    ) => overrides[agentType] ?? ({
        permissionMode: 'default',
        modelMode: 'default',
        effortLevel: null,
    }),
    resolveCodexRemotePermissionMode: (permissionMode: unknown) => {
        if (permissionMode === null || permissionMode === undefined || permissionMode === '') return 'default';
        return permissionMode === 'default' || permissionMode === 'read-only'
            ? permissionMode
            : 'read-only';
    },
}));

vi.mock('@/sync/ops', () => ({
    machineSpawnNewSession: mocks.machineSpawnNewSession,
    sessionSetAgentModes: mocks.sessionSetAgentModes,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        refreshSessions: mocks.refreshSessions,
        sendMessage: mocks.sendMessage,
    },
}));

vi.mock('@/hooks/useNewSessionDraft', () => ({
    useNewSessionDraft: {
        getState: () => mocks.draft,
    },
}));

vi.mock('@/hooks/useNavigateToSession', () => ({
    useNavigateToSession: () => mocks.navigateToSession,
}));

vi.mock('@/utils/machineUtils', () => ({
    isMachineOnline: (machine: { online: boolean }) => machine.online,
}));

vi.mock('@/utils/pathUtils', () => ({
    resolveAbsolutePath: (path: string) => `/absolute/${path.replace(/^~\/?/, '')}`,
}));

vi.mock('@/utils/worktree', () => ({
    createWorktree: mocks.createWorktree,
}));

vi.mock('@/utils/time', () => ({ delay: mocks.delay }));

vi.mock('@/components/modelModeOptions', () => ({
    getHardcodedPermissionModes: () => [
        { key: 'default', name: 'Default' },
        { key: 'read-only', name: 'Read only' },
        { key: 'safe-yolo', name: 'Safe YOLO', disabled: true },
        { key: 'yolo', name: 'YOLO', disabled: true },
    ],
    getHardcodedModelModes: () => [
        { key: 'default', name: 'Default' },
        { key: 'opus', name: 'Opus' },
    ],
    getEffortLevelsForModel: () => [
        { key: 'medium', name: 'Medium' },
    ],
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: mocks.alert,
        confirm: mocks.confirm,
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

import { completeSpawnRequest } from '@/sync/spawnRequestId';
import { useStartSessionFromDraft } from './useStartSessionFromDraft';

function createDraft(overrides: Record<string, unknown> = {}) {
    return {
        input: ' Start the implementation ',
        attachments: [{ uri: 'file:///image.jpg' }],
        selectedMachineId: 'machine-1',
        selectedPath: '~/project',
        agentType: 'codex',
        permissionMode: null,
        modelMode: null,
        effortLevel: null,
        sessionType: 'simple',
        worktreeKey: null,
        setInput: vi.fn(),
        setAttachments: vi.fn(),
        ...overrides,
    };
}

describe('useStartSessionFromDraft', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.uuidCount = 0;
        completeSpawnRequest();
        mocks.defaultOverrides = {};
        mocks.machines = [{ id: 'machine-1', online: true, metadata: { homeDir: '/Users/dev' } }];
        mocks.draft = createDraft();
        mocks.machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
        mocks.refreshSessions.mockResolvedValue(undefined);
        mocks.sendMessage.mockResolvedValue(true);
        mocks.confirm.mockResolvedValue(false);
    });

    it('creates a Codex session and sends the original prompt text unchanged', async () => {
        const { startSession } = useStartSessionFromDraft();

        await expect(startSession()).resolves.toBe(true);

        expect(mocks.machineSpawnNewSession).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/absolute/project',
            approvedNewDirectoryCreation: false,
            agent: 'codex',
            permissionMode: 'default',
            modelMode: undefined,
            effortLevel: 'medium',
        });
        expect(mocks.refreshSessions).toHaveBeenCalledOnce();
        expect(mocks.draft.setInput).toHaveBeenCalledWith('');
        expect(mocks.draft.setAttachments).toHaveBeenCalledWith([]);
        expect(mocks.navigateToSession).toHaveBeenCalledWith('session-1');
        expect(mocks.sendMessage).toHaveBeenCalledWith(
            'session-1',
            ' Start the implementation ',
            { source: 'new_session', attachments: mocks.draft.attachments },
        );
        expect(mocks.sendMessage.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.navigateToSession.mock.invocationCallOrder[0]);
    });

    it.each(['claude', 'gemini', 'openclaw', 'agy', 'rig'])(
        'normalizes a stale %s draft to Codex defaults without carrying elevated options',
        async (staleAgent) => {
            mocks.defaultOverrides = {
                codex: {
                    permissionMode: 'default',
                    modelMode: 'default',
                    effortLevel: 'medium',
                },
            };
            mocks.machines = [{
                id: 'machine-1',
                online: true,
                metadata: {
                    homeDir: '/Users/dev',
                    cliAvailability: {
                        claude: false,
                        codex: true,
                        gemini: false,
                        openclaw: false,
                    },
                },
            }];
            mocks.draft = createDraft({
                agentType: staleAgent,
                permissionMode: 'yolo',
                modelMode: 'opus',
                effortLevel: 'high',
            });

            const { startSession } = useStartSessionFromDraft();

            await expect(startSession()).resolves.toBe(true);

            expect(mocks.machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
                agent: 'codex',
                permissionMode: 'default',
                modelMode: undefined,
                effortLevel: 'medium',
            }));
            const spawnOptions = mocks.machineSpawnNewSession.mock.calls[0][0];
            expect(spawnOptions.permissionMode).not.toBe('yolo');
            expect(spawnOptions.modelMode).not.toBe('opus');
            expect(mocks.sessionSetAgentModes).not.toHaveBeenCalled();
        },
    );

    it('fails a yolo Codex draft closed to read-only at session creation', async () => {
        mocks.draft = createDraft({ permissionMode: 'yolo' });

        const { startSession } = useStartSessionFromDraft();

        await expect(startSession()).resolves.toBe(true);

        expect(mocks.machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'codex',
            permissionMode: 'read-only',
        }));
    });

    it('retries creation after the user approves a new directory', async () => {
        mocks.machineSpawnNewSession
            .mockResolvedValueOnce({ type: 'requestToApproveDirectoryCreation', directory: '/absolute/project' })
            .mockResolvedValueOnce({ type: 'success', sessionId: 'session-2' });
        mocks.confirm.mockResolvedValue(true);

        const { startSession } = useStartSessionFromDraft();

        await expect(startSession()).resolves.toBe(true);

        expect(mocks.machineSpawnNewSession).toHaveBeenNthCalledWith(1, expect.objectContaining({
            approvedNewDirectoryCreation: false,
        }));
        expect(mocks.machineSpawnNewSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
            approvedNewDirectoryCreation: true,
        }));
        expect(mocks.navigateToSession).toHaveBeenCalledWith('session-2');
    });

    it('ignores a stale worktree selection and always spawns in the selected project', async () => {
        mocks.draft = createDraft({
            sessionType: 'worktree',
            worktreeKey: '/tmp/stale-worktree',
        });

        const { startSession } = useStartSessionFromDraft();

        await expect(startSession()).resolves.toBe(true);

        expect(mocks.machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'codex',
            directory: '/absolute/project',
        }));
        const spawnOptions = mocks.machineSpawnNewSession.mock.calls[0][0];
        expect(spawnOptions).not.toHaveProperty('worktree');
        expect(mocks.createWorktree).not.toHaveBeenCalled();
    });

    it('keeps the draft in place when creation fails', async () => {
        mocks.machineSpawnNewSession.mockResolvedValue({ type: 'error', errorMessage: 'Machine rejected the request' });

        const { startSession } = useStartSessionFromDraft();

        await expect(startSession()).resolves.toBe(false);

        expect(mocks.alert).toHaveBeenCalledWith('common.error', 'Machine rejected the request');
        expect(mocks.draft.setInput).not.toHaveBeenCalled();
        expect(mocks.draft.setAttachments).not.toHaveBeenCalled();
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('keeps the draft and attachments when the initial message does not queue', async () => {
        mocks.sendMessage.mockResolvedValue(false);

        const { startSession } = useStartSessionFromDraft();

        await expect(startSession()).resolves.toBe(false);

        expect(mocks.draft.setInput).not.toHaveBeenCalled();
        expect(mocks.draft.setAttachments).not.toHaveBeenCalled();
        expect(mocks.navigateToSession).not.toHaveBeenCalled();
    });
});
