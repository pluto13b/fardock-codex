import { createReducer } from '@/sync/reducer/reducer';
import { storage } from '@/sync/storage';
import type { Machine, Session } from '@/sync/storageTypes';
import type { Message, ToolCall } from '@/sync/typesMessage';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
import { frontendPreviewEnabled } from './previewFlag';
import { createFrontendPreviewUserMessages } from './frontendPreviewMessage';

export { frontendPreviewEnabled } from './previewFlag';

export const FRONTEND_PREVIEW_SESSION_IDS = {
    running: 'preview-running',
    approval: 'preview-approval',
    completed: 'preview-completed',
    offline: 'preview-offline',
} as const;

let seeded = false;

function tool(
    name: string,
    state: ToolCall['state'],
    input: unknown,
    result?: unknown,
    permission?: ToolCall['permission'],
): ToolCall {
    const now = Date.now();
    return {
        name,
        state,
        input,
        result,
        permission,
        createdAt: now - 20_000,
        startedAt: now - 18_000,
        completedAt: state === 'running' ? null : now - 12_000,
        description: null,
    };
}

function session(
    id: string,
    name: string,
    path: string,
    options: {
        active: boolean;
        thinking?: boolean;
        updatedOffset: number;
        agentState?: Session['agentState'];
    },
): Session {
    const now = Date.now();
    return {
        id,
        seq: 1,
        createdAt: now - options.updatedOffset - 120_000,
        updatedAt: now - options.updatedOffset,
        active: options.active,
        activeAt: now - options.updatedOffset,
        metadata: {
            path,
            host: 'DESKTOP-CODEX',
            homeDir: 'D:\\Users\\demo',
            machineId: 'preview-machine',
            name,
            summary: {
                text: name,
                updatedAt: now - options.updatedOffset,
            },
            version: 'preview',
            flavor: 'codex',
            codexThreadId: `thread-${id}`,
            permissionMode: 'default',
            modelMode: 'gpt-5.6-sol',
            effortLevel: 'xhigh',
            models: [
                { code: 'gpt-5.6-sol', value: '5.6 Sol' },
                { code: 'gpt-5.6-terra', value: '5.6 Terra' },
                { code: 'gpt-5.6-luna', value: '5.6 Luna' },
                { code: 'gpt-5.5', value: '5.5' },
                { code: 'gpt-5.4', value: '5.4' },
                { code: 'gpt-5.4-mini', value: '5.4 Mini' },
                { code: 'gpt-5.3-codex-spark', value: '5.3 Codex Spark' },
            ],
            currentModelCode: 'gpt-5.6-sol',
            thoughtLevels: [
                { code: 'low', value: '轻度' },
                { code: 'medium', value: '中' },
                { code: 'high', value: '高' },
                { code: 'xhigh', value: '极高' },
                { code: 'max', value: '最高' },
                { code: 'ultra', value: '极高', description: '更快消耗使用额度' },
            ],
            currentThoughtLevelCode: 'xhigh',
            gitBranch: 'main',
            activity: {
                subagents: { running: 0, queued: 0, total: 3 },
                workflows: { running: 0, total: 0 },
                processes: { running: options.active ? 1 : 0 },
                tasks: { pending: 0, inProgress: 0, completed: 3, total: 3 },
            },
            client: {
                id: 'codex_plus',
                name: 'Codex Plus',
                version: 'preview',
            },
            capabilities: {
                abort: true,
                attachments: {
                    enabled: true,
                    maxBytes: 20 * 1024 * 1024,
                    mediaTypes: ['image/png', 'image/jpeg', 'application/pdf'],
                },
                files: {
                    browse: true,
                    read: true,
                    search: true,
                    write: false,
                },
                modelSelection: true,
                reasoningSelection: true,
                permissionModeSelection: false,
                resume: true,
                rpcMethods: [],
                shell: true,
                steering: true,
            },
        },
        metadataVersion: 1,
        agentState: options.agentState ?? null,
        agentStateVersion: options.agentState ? 1 : 0,
        thinking: options.thinking ?? false,
        thinkingAt: options.thinking ? now - 8_000 : 0,
        presence: options.active ? 'online' : now - options.updatedOffset,
        permissionMode: 'default',
        modelMode: 'gpt-5.6-sol',
        effortLevel: 'xhigh',
    };
}

function previewMessages(now: number): Record<string, Message[]> {
    const runningHistoryPrompts = [
        '先梳理手机端任务列表的信息层级。',
        '把任务按工作区文件夹分组展示。',
        '检查深色主题的主画布和侧栏色号。',
        '让普通任务只显示文字，选中项再出现圆角底板。',
        '对照 Codex 收紧桌面对话正文宽度。',
        '统一任务首页、新建任务和对话输入器。',
        '检查权限菜单必须保持远程失败关闭。',
        '完善模型与推理强度的紧凑菜单。',
        '把任务标题移动到详情区左上角。',
        '补齐右上环境信息与文件侧栏控件。',
    ];
    const runningHistoryMessages: Message[] = Array.from({ length: 30 }, (_, index) => {
        const age = 120_000 + index * 75_000;
        const prompt = runningHistoryPrompts[index % runningHistoryPrompts.length];
        const turnNumber = 30 - index;
        return [
            {
                id: `running-history-agent-${turnNumber}`,
                localId: null,
                createdAt: now - age,
                kind: 'agent-text' as const,
                text: `已完成第 ${turnNumber} 轮前端检查，并把结果同步到本地预览。`,
            },
            {
                id: `running-history-user-${turnNumber}`,
                localId: null,
                createdAt: now - age - 25_000,
                kind: 'user-text' as const,
                text: `第 ${turnNumber} 轮\n${prompt}`,
                meta: { sentFrom: 'codex_plus' as const },
            },
        ];
    }).flat();

    return {
        [FRONTEND_PREVIEW_SESSION_IDS.running]: [
            {
                id: 'running-tool',
                localId: null,
                createdAt: now - 5_000,
                kind: 'tool-call',
                tool: tool('CodexBash', 'running', {
                    command: 'pnpm test',
                    parsed_cmd: [{ type: 'bash', cmd: 'pnpm test' }],
                    description: '运行前端测试',
                }),
                children: [],
            },
            {
                id: 'running-agent',
                localId: null,
                createdAt: now - 20_000,
                kind: 'agent-text',
                text: '我已经完成移动端布局检查，正在运行类型检查与测试。接下来会核对 360px 视口下的输入器、工具卡片和审批面板。',
            },
            {
                id: 'running-user',
                localId: null,
                createdAt: now - 45_000,
                kind: 'user-text',
                text: '继续完善前端，重点检查手机上的任务列表和对话输入。',
                meta: { sentFrom: 'codex_plus' },
            },
            ...runningHistoryMessages,
        ],
        [FRONTEND_PREVIEW_SESSION_IDS.approval]: [
            {
                id: 'approval-tool',
                localId: null,
                createdAt: now - 12_000,
                kind: 'tool-call',
                tool: tool(
                    'CodexBash',
                    'running',
                    {
                        command: 'pnpm install --frozen-lockfile',
                        parsed_cmd: [{ type: 'bash', cmd: 'pnpm install --frozen-lockfile' }],
                        description: '安装锁定依赖',
                    },
                    undefined,
                    { id: 'approval-install', status: 'pending' },
                ),
                children: [],
            },
            {
                id: 'approval-agent',
                localId: null,
                createdAt: now - 25_000,
                kind: 'agent-text',
                text: '依赖安装需要一次明确批准。前端预览不会真正执行命令。',
            },
            {
                id: 'approval-user',
                localId: null,
                createdAt: now - 40_000,
                kind: 'user-text',
                text: '检查依赖并构建项目。',
            },
        ],
        [FRONTEND_PREVIEW_SESSION_IDS.completed]: [
            {
                id: 'completed-agent',
                localId: null,
                createdAt: now - 60_000,
                kind: 'agent-text',
                text: `前端构建已经通过：\n\n- TypeScript 无错误\n- 自动测试通过\n- 360 / 393 / 412px 视口无横向滚动\n\n关键修改保留在 [README.md](README.md) 与进度文档中。`,
            },
            {
                id: 'completed-patch',
                localId: null,
                createdAt: now - 78_000,
                kind: 'tool-call',
                tool: tool('CodexPatch', 'completed', {
                    auto_approved: false,
                    changes: {
                        'apps/client/sources/components/MainView.tsx': {
                            modify: {
                                old_content: "type ActiveTab = 'inbox' | 'sessions' | 'settings';",
                                new_content: "type ActiveTab = 'sessions' | 'settings';",
                            },
                        },
                    },
                    fileChanges: {
                        'apps/client/sources/components/MainView.tsx': {
                            modify: {
                                old_content: "type ActiveTab = 'inbox' | 'sessions' | 'settings';",
                                new_content: "type ActiveTab = 'sessions' | 'settings';",
                            },
                        },
                    },
                }, 'Applied patch to 1 file'),
                children: [],
            },
            {
                id: 'completed-edit',
                localId: null,
                createdAt: now - 90_000,
                kind: 'tool-call',
                tool: tool('Edit', 'completed', {
                    file_path: 'apps/client/sources/components/MainView.tsx',
                    old_string: "type ActiveTab = 'inbox' | 'sessions' | 'settings';",
                    new_string: "type ActiveTab = 'sessions' | 'settings';",
                }, '文件已更新'),
                children: [],
            },
            {
                id: 'completed-command',
                localId: null,
                createdAt: now - 120_000,
                kind: 'tool-call',
                tool: tool('CodexBash', 'completed', {
                    command: 'pnpm typecheck',
                    parsed_cmd: [{ type: 'bash', cmd: 'pnpm typecheck' }],
                }, 'TypeScript check passed'),
                children: [],
            },
            {
                id: 'completed-user',
                localId: null,
                createdAt: now - 150_000,
                kind: 'user-text',
                text: '把前端整体做好，并保持 Codex 风格。',
            },
        ],
        [FRONTEND_PREVIEW_SESSION_IDS.offline]: [
            {
                id: 'offline-agent',
                localId: null,
                createdAt: now - 3_600_000,
                kind: 'agent-text',
                text: '这是 Windows 主机离线前保存的最后一份任务快照。重新连接前只能查看，草稿会保留在当前设备。',
            },
            {
                id: 'offline-user',
                localId: null,
                createdAt: now - 3_700_000,
                kind: 'user-text',
                text: '查看上次构建结果。',
            },
        ],
    };
}

export function seedFrontendPreview(): void {
    if (!frontendPreviewEnabled || seeded) {
        return;
    }
    seeded = true;

    const now = Date.now();
    const machine: Machine = {
        id: 'preview-machine',
        seq: 1,
        createdAt: now - 86_400_000,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: {
            host: 'DESKTOP-CODEX',
            displayName: '工作电脑',
            platform: 'win32',
            arch: 'x64',
            username: 'demo',
            happyCliVersion: 'preview',
            happyHomeDir: 'D:\\CodexPlus',
            homeDir: 'D:\\Users\\demo',
            cliAvailability: {
                claude: false,
                codex: true,
                gemini: false,
                openclaw: false,
                agy: false,
                rig: false,
                detectedAt: now,
            },
            capabilities: {
                newSession: true,
                resume: true,
                worktrees: false,
            },
            client: {
                id: 'codex_plus',
                name: 'Codex Plus',
                version: 'preview',
            },
        },
        metadataVersion: 1,
        daemonState: { status: 'running' },
        daemonStateVersion: 1,
    };

    const sessions = [
        session(
            FRONTEND_PREVIEW_SESSION_IDS.running,
            '完善 Codex Plus 手机前端',
            'C:\\Projects\\codex-plus',
            { active: true, thinking: true, updatedOffset: 5_000 },
        ),
        session(
            FRONTEND_PREVIEW_SESSION_IDS.approval,
            '检查依赖与构建',
            'D:\\Projects\\web-client',
            {
                active: true,
                updatedOffset: 12_000,
                agentState: {
                    requests: {
                        'approval-install': {
                            tool: 'CodexBash',
                            arguments: { command: 'pnpm install --frozen-lockfile' },
                            createdAt: now - 12_000,
                            toolUseId: 'approval-install',
                        },
                    },
                    communications: {
                        'preview-question': {
                            kind: 'form',
                            createdAt: now - 10_000,
                            title: '选择验收重点',
                            form: {
                                questions: [{
                                    id: 'preview-priority',
                                    header: '验收重点',
                                    question: '下一步优先检查哪个手机端状态？',
                                    multiSelect: false,
                                    allowCustom: true,
                                    options: [
                                        { label: '审批流程', description: '核对一次性批准与拒绝' },
                                        { label: '附件发送', description: '核对图片与文件状态' },
                                        { label: '断线恢复', description: '核对只读与草稿保留' },
                                    ],
                                }],
                            },
                        },
                    },
                },
            },
        ),
        session(
            FRONTEND_PREVIEW_SESSION_IDS.completed,
            '前端构建与移动端验收',
            'C:\\Projects\\codex-plus',
            { active: true, updatedOffset: 60_000 },
        ),
        session(
            FRONTEND_PREVIEW_SESSION_IDS.offline,
            '上次离线任务',
            'D:\\Projects\\offline-demo',
            { active: false, updatedOffset: 3_600_000 },
        ),
    ];

    storage.getState().applyMachines([machine], true);
    storage.getState().applySessions(sessions);
    const runningPathKey = storage.getState().getSessionPathKey(FRONTEND_PREVIEW_SESSION_IDS.running);
    if (runningPathKey) {
        storage.getState().applyGitStatus(runningPathKey, {
            branch: 'main',
            isDirty: true,
            modifiedCount: 4,
            untrackedCount: 0,
            stagedCount: 0,
            lastUpdatedAt: now,
            stagedLinesAdded: 0,
            stagedLinesRemoved: 0,
            unstagedLinesAdded: 341,
            unstagedLinesRemoved: 201,
            linesAdded: 341,
            linesRemoved: 201,
            linesChanged: 542,
            upstreamBranch: 'origin/main',
            aheadCount: 0,
            behindCount: 0,
            stashCount: 0,
        });
        const previewFiles = [
            'apps/client/sources/components/ChatHeaderView.tsx',
            'apps/client/sources/components/SessionDesktopTools.tsx',
            'apps/client/sources/-session/SessionView.tsx',
            'docs/PROGRESS.md',
        ].map((fullPath, index) => {
            const segments = fullPath.split('/');
            return {
                fileName: segments[segments.length - 1] ?? fullPath,
                filePath: segments.slice(0, -1).join('/'),
                fullPath,
                status: 'modified' as const,
                isStaged: false,
                linesAdded: [81, 132, 73, 55][index] ?? 0,
                linesRemoved: [42, 68, 57, 34][index] ?? 0,
            };
        });
        storage.getState().applyGitStatusFiles(runningPathKey, {
            stagedFiles: [],
            unstagedFiles: previewFiles,
            branch: 'main',
            totalStaged: 0,
            totalUnstaged: previewFiles.length,
        });
        storage.getState().applyProjectFiles(runningPathKey, {
            files: previewFiles.map(({ fileName, filePath, fullPath }) => ({ fileName, filePath, fullPath })),
            fetchedAt: now,
        });
    }
    storage.getState().applySettingsLocal({
        experiments: true,
        expImageUpload: true,
        sessionStatusBarDisplay: 'hidden',
        reviewPromptAnswered: true,
        preferredLanguage: 'zh-Hans',
    });
    storage.getState().setSocketStatus('connected');
    storage.getState().applyReady();

    const allMessages = previewMessages(now);
    storage.setState((state) => ({
        ...state,
        sessionMessages: Object.fromEntries(
            Object.entries(allMessages).map(([sessionId, messages]) => {
                const reducerState = createReducer();
                if (sessionId === FRONTEND_PREVIEW_SESSION_IDS.approval) {
                    reducerState.toolIdToMessageId.set('approval-install', 'approval-tool');
                }
                return [sessionId, {
                    messages: [...messages].sort((a, b) => b.createdAt - a.createdAt),
                    messagesMap: Object.fromEntries(messages.map((message) => [message.id, message])),
                    reducerState,
                    isLoaded: true,
                    hasMoreOlder: false,
                    isLoadingOlder: false,
                }];
            }),
        ),
    }));
}

export function appendFrontendPreviewMessage(
    sessionId: string,
    text: string,
    attachments: readonly AttachmentPreview[] = [],
): void {
    if (!frontendPreviewEnabled) {
        return;
    }
    const messages = createFrontendPreviewUserMessages(text, attachments);
    if (messages.length === 0) {
        return;
    }
    storage.setState((state) => {
        const current = state.sessionMessages[sessionId];
        if (!current) {
            return state;
        }
        return {
            ...state,
            sessionMessages: {
                ...state.sessionMessages,
                [sessionId]: {
                    ...current,
                    messages: [...messages, ...current.messages],
                    messagesMap: {
                        ...current.messagesMap,
                        ...Object.fromEntries(messages.map((message) => [message.id, message])),
                    },
                },
            },
        };
    });
}

export function stopFrontendPreviewSession(sessionId: string): void {
    if (!frontendPreviewEnabled) {
        return;
    }
    storage.setState((state) => {
        const current = state.sessions[sessionId];
        if (!current) {
            return state;
        }
        return {
            ...state,
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...current,
                    thinking: false,
                    thinkingAt: 0,
                    updatedAt: Date.now(),
                },
            },
        };
    });
}

export function decideFrontendPreviewPermission(
    sessionId: string,
    permissionId: string,
    decision: 'approved' | 'abort',
): void {
    if (!frontendPreviewEnabled) {
        return;
    }
    storage.setState((state) => {
        const currentMessages = state.sessionMessages[sessionId];
        const currentSession = state.sessions[sessionId];
        if (!currentMessages || !currentSession) {
            return state;
        }

        const nextMessages = currentMessages.messages.map((message) => {
            if (
                message.kind !== 'tool-call'
                || message.tool.permission?.id !== permissionId
            ) {
                return message;
            }
            return {
                ...message,
                tool: {
                    ...message.tool,
                    state: decision === 'approved' ? message.tool.state : 'error',
                    permission: {
                        ...message.tool.permission,
                        status: decision === 'approved' ? 'approved' : 'denied',
                        decision,
                    },
                },
            } as Message;
        });
        const requests = { ...(currentSession.agentState?.requests ?? {}) };
        delete requests[permissionId];

        return {
            ...state,
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...currentSession,
                    agentState: currentSession.agentState
                        ? { ...currentSession.agentState, requests }
                        : currentSession.agentState,
                    agentStateVersion: currentSession.agentStateVersion + 1,
                    updatedAt: Date.now(),
                },
            },
            sessionMessages: {
                ...state.sessionMessages,
                [sessionId]: {
                    ...currentMessages,
                    messages: nextMessages,
                    messagesMap: Object.fromEntries(nextMessages.map((message) => [message.id, message])),
                },
            },
        };
    });
}

export function decideFrontendPreviewCommunication(
    sessionId: string,
    communicationId: string,
    status: 'answered' | 'cancelled',
    answers?: Record<string, { options: string[]; custom?: string | null }>,
): void {
    if (!frontendPreviewEnabled) {
        return;
    }
    storage.setState((state) => {
        const currentSession = state.sessions[sessionId];
        const communication = currentSession?.agentState?.communications?.[communicationId];
        if (!currentSession || !currentSession.agentState || !communication) {
            return state;
        }
        const communications = { ...(currentSession.agentState.communications ?? {}) };
        delete communications[communicationId];
        const completedCommunications = {
            ...(currentSession.agentState.completedCommunications ?? {}),
            [communicationId]: {
                ...communication,
                completedAt: Date.now(),
                status,
                answers: status === 'answered' ? answers : undefined,
            },
        };
        return {
            ...state,
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...currentSession,
                    agentState: {
                        ...currentSession.agentState,
                        communications,
                        completedCommunications,
                    },
                    agentStateVersion: currentSession.agentStateVersion + 1,
                    updatedAt: Date.now(),
                },
            },
        };
    });
}
