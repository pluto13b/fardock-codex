import * as React from 'react';
import { useAllMachines, useSetting } from '@/sync/storage';
import { resolveAgentDefaultConfig, resolveCodexRemotePermissionMode } from '@/sync/agentDefaults';
import { machineSpawnNewSession, sessionSetAgentModes, type SessionAgentModesPatch } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { isMachineOnline } from '@/utils/machineUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { createWorktree } from '@/utils/worktree';
import {
    getEffortLevelsForModel,
    getHardcodedModelModes,
    getHardcodedPermissionModes,
} from '@/components/modelModeOptions';
import { Modal } from '@/modal';
import { t } from '@/text';
import { resolveMachineAgent } from '@/utils/newSessionAgentSelection';
import { delay } from '@/utils/time';
import {
    buildRigSpawnConfiguration,
    getRigMachineSessionCreation,
    resolveRigPendingRetryDelayMs,
} from '@/sync/rigSessionCreation';
import {
    buildSpawnRequestSignature,
    completeSpawnRequest,
    resolveSpawnRequestId,
} from '@/sync/spawnRequestId';
import type { NewSessionAgentType } from '@/sync/persistence';

const MAX_RIG_PENDING_RESULTS = 3;

function resolveOption<T extends { key: string }>(
    options: T[],
    preferredKeys: Array<string | null | undefined>,
): T | null {
    for (const key of preferredKeys) {
        if (!key) continue;
        const option = options.find((candidate) => candidate.key === key);
        if (option) return option;
    }
    return options[0] ?? null;
}

export function useStartSessionFromDraft() {
    const machines = useAllMachines({ includeOffline: true });
    const defaultOverrides = useSetting('agentDefaultOverrides');
    const navigateToSession = useNavigateToSession();
    const [isStarting, setIsStarting] = React.useState(false);
    const isStartingRef = React.useRef(false);
    const isMountedRef = React.useRef(true);
    React.useEffect(() => () => {
        isMountedRef.current = false;
    }, []);

    const startSession = React.useCallback(async (): Promise<boolean> => {
        if (isStartingRef.current) return false;

        const draft = useNewSessionDraft.getState();
        const machine = machines.find((candidate) => candidate.id === draft.selectedMachineId);
        if (!machine) {
            Modal.alert(t('common.error'), 'Please select a machine');
            return false;
        }
        if (!isMachineOnline(machine)) {
            Modal.alert(t('common.error'), 'Machine is offline');
            return false;
        }

        // Final creation seam: stale imported drafts must never select another
        // agent. Codex Plus fails closed when Codex is explicitly unavailable.
        const agentType = ((): NewSessionAgentType => 'codex')();
        if (machine.metadata?.cliAvailability?.codex === false) {
            Modal.alert(t('common.error'), 'Codex is not available on this Windows host');
            return false;
        }
        const agentChanged = agentType !== draft.agentType;
        const rigCreation = agentType === 'rig'
            ? getRigMachineSessionCreation(machine.metadata)
            : null;
        if (agentType === 'rig' && !rigCreation) {
            Modal.alert(t('common.error'), 'This Rig machine is not available for session creation');
            return false;
        }
        const defaults = rigCreation
            ? {
                permissionMode: rigCreation.defaultPermissionMode ?? '',
                modelMode: rigCreation.defaultModelKey ?? '',
                effortLevel: rigCreation.defaultEffortForModel(rigCreation.defaultModelKey),
            }
            : resolveAgentDefaultConfig(defaultOverrides, agentType);
        const requestedPermissionMode = agentChanged
            ? defaults.permissionMode
            : draft.permissionMode ?? defaults.permissionMode;
        const permission = resolveOption<{ key: string }>(
            (rigCreation?.permissionModes ?? getHardcodedPermissionModes(agentType, t))
                .filter((mode) => !('disabled' in mode) || !mode.disabled),
            [resolveCodexRemotePermissionMode(requestedPermissionMode)],
        );
        const model = resolveOption<{ key: string }>(
            rigCreation?.models ?? getHardcodedModelModes(agentType, t),
            agentChanged
                ? [defaults.modelMode]
                : [draft.modelMode, defaults.modelMode],
        );
        const effortDefault = rigCreation?.defaultEffortForModel(model?.key)
            ?? defaults.effortLevel;
        const effort = resolveOption<{ key: string }>(
            rigCreation
                ? rigCreation.effortsForModel(model?.key).map((key) => ({ key, name: key }))
                : getEffortLevelsForModel(agentType, model?.key ?? 'default'),
            agentChanged
                ? [effortDefault]
                : [draft.effortLevel, effortDefault],
        );
        if (!permission || !model) {
            Modal.alert(t('common.error'), 'The selected agent configuration is unavailable');
            return false;
        }

        // Preserve the exact user text. Trimming is allowed only for the UI's
        // emptiness check, never for the payload passed to the Codex Harness.
        const prompt = draft.input;
        const attachments = draft.attachments;
        const selectedPath = draft.selectedPath?.trim() || '~';
        const absolutePath = resolveAbsolutePath(selectedPath, machine.metadata?.homeDir);
        const worktreeSelection: string = '__none__';
        // Reused across every retry of this exact request so a second press of
        // Start is deduped by Rig instead of spawning a second session.
        const clientRequestId = resolveSpawnRequestId(buildSpawnRequestSignature({
            machineId: machine.id,
            agent: agentType,
            directory: selectedPath,
            worktree: worktreeSelection,
            modelKey: model.key,
            permissionMode: permission.key,
            effort: effort?.key ?? null,
        }));

        isStartingRef.current = true;
        setIsStarting(true);
        try {
            let spawnDirectory = absolutePath;
            if (worktreeSelection === '__new__') {
                const worktreeResult = await createWorktree(machine.id, absolutePath);
                if (!worktreeResult.success) {
                    Modal.alert(t('common.error'), worktreeResult.error || 'Failed to create worktree');
                    return false;
                }
                spawnDirectory = worktreeResult.worktreePath;
            } else if (worktreeSelection !== '__none__') {
                spawnDirectory = worktreeSelection;
            }

            const spawn = async (approvedNewDirectoryCreation = false): Promise<string | null> => {
                const spawnOptions = rigCreation
                    ? {
                        machineId: machine.id,
                        ...buildRigSpawnConfiguration(machine.metadata, {
                            directory: spawnDirectory,
                            clientRequestId,
                            approvedNewDirectoryCreation,
                            modelKey: model.key,
                            permissionMode: permission.key,
                            effort: effort?.key,
                        }),
                    }
                    : {
                        machineId: machine.id,
                        directory: spawnDirectory,
                        approvedNewDirectoryCreation,
                        agent: agentType,
                        permissionMode: agentType === 'codex' || permission.key !== 'default'
                            ? permission.key
                            : undefined,
                        modelMode: model.key !== 'default' ? model.key : undefined,
                        effortLevel: effort?.key,
                    };
                let result = await machineSpawnNewSession(spawnOptions);
                let pendingResults = 0;
                while (result.type === 'pending' && pendingResults < MAX_RIG_PENDING_RESULTS) {
                    pendingResults += 1;
                    await delay(resolveRigPendingRetryDelayMs(
                        result.retryAfterMs,
                        rigCreation?.pendingRetryAfterMs,
                    ));
                    if (!isMountedRef.current) return null;
                    result = await machineSpawnNewSession(spawnOptions);
                }
                if (!isMountedRef.current) return null;

                if (result.type === 'success') return result.sessionId;
                if (result.type === 'error') {
                    Modal.alert(t('common.error'), result.errorMessage);
                    return null;
                }
                if (result.type === 'pending') {
                    Modal.alert(
                        t('common.error'),
                        'Rig created the session, but it is still syncing with Happy. It should appear shortly.',
                    );
                    return null;
                }

                const approved = await Modal.confirm(
                    'Create Directory?',
                    `The directory '${result.directory}' does not exist. Would you like to create it?`,
                    { cancelText: t('common.cancel'), confirmText: t('common.create') },
                );
                return approved ? spawn(true) : null;
            };

            const sessionId = await spawn();
            if (!sessionId) return false;

            await sync.refreshSessions();

            if (!rigCreation) {
                const modesPatch: SessionAgentModesPatch = {};
                if (permission.key !== defaults.permissionMode) modesPatch.permissionMode = permission.key;
                if (model.key !== defaults.modelMode) modesPatch.modelMode = model.key;
                if ((effort?.key ?? null) !== defaults.effortLevel) modesPatch.effortLevel = effort?.key ?? null;
                if (Object.keys(modesPatch).length > 0) {
                    sessionSetAgentModes(sessionId, modesPatch);
                }
            }

            if (prompt || attachments.length > 0) {
                const queued = await sync.sendMessage(
                    sessionId,
                    prompt,
                    { source: 'new_session', attachments },
                );
                if (!queued) {
                    return false;
                }
            }

            // Retire the idempotency key and clear the caller's draft only
            // after the complete initial message is safely queued.
            completeSpawnRequest();
            draft.setInput('');
            draft.setAttachments([]);
            navigateToSession(sessionId);
            return true;
        } catch (error) {
            Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : 'Failed to start session',
            );
            return false;
        } finally {
            isStartingRef.current = false;
            if (isMountedRef.current) setIsStarting(false);
        }
    }, [defaultOverrides, machines, navigateToSession]);

    return { isStarting, startSession };
}
