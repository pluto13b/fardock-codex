import * as React from 'react';
import {
    Keyboard,
    Modal,
    Platform,
    Pressable,
    StyleSheet as ReactNativeStyleSheet,
    Text,
    useWindowDimensions,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

type MobileBottomSheetProps = {
    visible: boolean;
    title: string;
    onClose: () => void;
    children: React.ReactNode;
    accessibilityLabel?: string;
};

/**
 * Small cross-platform sheet shell for phone-only task details.
 * Content owns its ScrollView so headers can remain fixed.
 */
export const MobileBottomSheet = React.memo(function MobileBottomSheet({
    visible,
    title,
    onClose,
    children,
    accessibilityLabel,
}: MobileBottomSheetProps) {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const windowSize = useWindowDimensions();

    React.useEffect(() => {
        if (!visible) return;
        Keyboard.dismiss();
        if (Platform.OS !== 'web') return;

        const previousFocus = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        const focusTimer = window.setTimeout(() => {
            document
                .querySelector<HTMLElement>('[data-codex-mobile-sheet-close="true"]')
                ?.focus();
        }, 0);
        const handleKeyDown = (event: KeyboardEvent) => {
            const sheet = document.querySelector<HTMLElement>('[data-codex-mobile-sheet="true"]');
            if (!sheet) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onClose();
                return;
            }
            if (event.key !== 'Tab') return;

            const focusable = Array.from(sheet.querySelectorAll<HTMLElement>(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            )).filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');
            if (focusable.length === 0) {
                event.preventDefault();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        };
        window.addEventListener('keydown', handleKeyDown, true);
        return () => {
            window.clearTimeout(focusTimer);
            window.removeEventListener('keydown', handleKeyDown, true);
            if (previousFocus?.isConnected) {
                previousFocus.focus();
            }
        };
    }, [onClose, visible]);

    const desiredHeight = windowSize.height - Math.max(72, insets.top + 56);
    const maxHeight = Math.max(
        0,
        Math.min(windowSize.height - 8, Math.max(160, desiredHeight)),
    );

    return (
        <Modal
            visible={visible}
            transparent
            animationType="slide"
            presentationStyle="overFullScreen"
            statusBarTranslucent
            navigationBarTranslucent
            onRequestClose={onClose}
        >
            <View
                style={styles.modalRoot}
                accessibilityViewIsModal
                {...({
                    role: 'dialog',
                    'aria-label': accessibilityLabel ?? title,
                    'data-codex-mobile-sheet': 'true',
                } as any)}
            >
                <Pressable
                    accessible={false}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    onPress={onClose}
                    style={styles.backdrop}
                />
                <View
                    style={[
                        styles.sheet,
                        {
                            maxHeight,
                            minHeight: Math.min(280, maxHeight),
                            paddingBottom: Math.max(8, insets.bottom),
                            backgroundColor: theme.dark ? '#2D2D2D' : theme.colors.surface,
                            borderColor: theme.dark ? '#3E3E3E' : theme.colors.divider,
                        },
                    ]}
                >
                    <View pointerEvents="none" style={styles.handleWrap}>
                        <View style={[styles.handle, { backgroundColor: theme.colors.textSecondary }]} />
                    </View>
                    <View style={styles.header}>
                        <Text accessibilityRole="header" style={[styles.title, { color: theme.colors.text }]}>{title}</Text>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="关闭环境信息"
                            focusable
                            onPress={onClose}
                            hitSlop={4}
                            {...({ 'data-codex-mobile-sheet-close': 'true' } as any)}
                            style={({ pressed }) => [
                                styles.closeButton,
                                pressed && { backgroundColor: theme.dark ? '#3D3D3D' : theme.colors.surfaceHigh },
                            ]}
                        >
                            <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                        </Pressable>
                    </View>
                    <View style={styles.body}>{children}</View>
                </View>
            </View>
        </Modal>
    );
});

const styles = StyleSheet.create(() => ({
    modalRoot: {
        flex: 1,
        justifyContent: 'flex-end',
        alignItems: 'center',
    },
    backdrop: {
        ...ReactNativeStyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0, 0, 0, 0.42)',
    },
    sheet: {
        width: '100%',
        maxWidth: 520,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        borderWidth: StyleSheet.hairlineWidth,
        overflow: 'hidden',
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: -6 },
        shadowOpacity: 0.28,
        shadowRadius: 24,
        elevation: 18,
    },
    handleWrap: {
        height: 20,
        alignItems: 'center',
        justifyContent: 'flex-end',
    },
    handle: {
        width: 36,
        height: 4,
        borderRadius: 999,
        opacity: 0.5,
    },
    header: {
        height: 52,
        paddingLeft: 16,
        paddingRight: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    title: {
        flex: 1,
        minWidth: 0,
        fontSize: 16,
        lineHeight: 22,
        fontWeight: '600',
    },
    closeButton: {
        width: 44,
        height: 44,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    body: {
        minHeight: 0,
        flexShrink: 1,
    },
}));
