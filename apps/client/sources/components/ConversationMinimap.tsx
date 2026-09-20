/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted by Codex Plus in 2026 from AionUi's MessageAnchorRail for React
 * Native Web. Electron, database, search, and full-history loading paths are
 * intentionally excluded.
 */

import * as React from 'react';
import {
    NativeScrollEvent,
    NativeSyntheticEvent,
    Platform,
    Pressable,
    ScrollView,
    Text,
    View,
    useWindowDimensions,
} from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ConversationMinimapAnchor } from './conversationMinimapModel';
import {
    getConversationMinimapMarkerWidth,
    getConversationMinimapScrollTop,
    getConversationMinimapStackHeight,
    getConversationMinimapStackTop,
    getConversationMinimapViewportHeight,
    MINIMAP_MARKER_HEIGHT,
    MINIMAP_MARKER_PITCH,
} from './conversationMinimapModel';

const MIN_WINDOW_WIDTH = 900;
const MIN_CONTENT_WIDTH = 800;
const RAIL_LEFT = 16;
const HIT_WIDTH = 36;
const TOOLTIP_GAP = 10;
const TOOLTIP_WIDTH = 320;
const TOOLTIP_FALLBACK_HEIGHT = 78;
const TOOLTIP_EDGE_INSET = 8;

export const ConversationMinimap = React.memo((props: {
    anchors: readonly ConversationMinimapAnchor[];
    contentWidth: number;
    topInset: number;
    bottomInset: number;
    onJump: (anchor: ConversationMinimapAnchor) => void;
}) => {
    const { theme } = useUnistyles();
    const { width: windowWidth } = useWindowDimensions();
    const scrollRef = React.useRef<ScrollView>(null);
    const pointerYRef = React.useRef<number | null>(null);
    const newestAnchorIdRef = React.useRef<string | null>(null);
    const hasPositionedRailRef = React.useRef(false);
    const [availableHeight, setAvailableHeight] = React.useState(0);
    const [scrollTop, setScrollTop] = React.useState(0);
    const [activeMessageId, setActiveMessageId] = React.useState<string | null>(null);
    const [tooltipHeight, setTooltipHeight] = React.useState(TOOLTIP_FALLBACK_HEIGHT);

    const count = props.anchors.length;
    const resolvedActiveIndex = activeMessageId === null
        ? -1
        : props.anchors.findIndex((anchor) => anchor.messageId === activeMessageId);
    const activeIndex = resolvedActiveIndex >= 0 ? resolvedActiveIndex : null;
    const viewportHeight = getConversationMinimapViewportHeight(availableHeight, count);
    const stackHeight = getConversationMinimapStackHeight(count);
    const stackTop = getConversationMinimapStackTop(availableHeight, viewportHeight);
    const scrollable = stackHeight > viewportHeight;
    const isVisible = Platform.OS === 'web'
        && windowWidth >= MIN_WINDOW_WIDTH
        && props.contentWidth >= MIN_CONTENT_WIDTH
        && count >= 2;

    React.useEffect(() => {
        setActiveMessageId((current) => current !== null
            && !props.anchors.some((anchor) => anchor.messageId === current)
            ? null
            : current);
    }, [props.anchors]);

    React.useEffect(() => {
        if (isVisible) return;
        pointerYRef.current = null;
        newestAnchorIdRef.current = null;
        hasPositionedRailRef.current = false;
        setAvailableHeight(0);
        setActiveMessageId(null);
        setScrollTop(0);
    }, [isVisible]);

    // Keep a live append reachable without snapping back when older history is
    // paged into the start of the oldest-to-newest anchor array.
    React.useEffect(() => {
        if (!isVisible) return;
        const newestAnchorId = props.anchors[count - 1]?.messageId ?? null;
        const newestChanged = newestAnchorIdRef.current !== null
            && newestAnchorIdRef.current !== newestAnchorId;
        newestAnchorIdRef.current = newestAnchorId;
        if (viewportHeight <= 0 || count === 0) return;
        if (!scrollable) {
            hasPositionedRailRef.current = true;
            return;
        }
        const shouldFollowNewest = !hasPositionedRailRef.current || newestChanged;
        hasPositionedRailRef.current = true;
        if (!shouldFollowNewest) return;
        const nextScrollTop = getConversationMinimapScrollTop(count - 1, count, viewportHeight);
        const timer = setTimeout(() => {
            scrollRef.current?.scrollTo({ y: nextScrollTop, animated: false });
            setScrollTop(nextScrollTop);
        }, 0);
        return () => clearTimeout(timer);
    }, [count, isVisible, props.anchors, scrollable, viewportHeight]);

    if (!isVisible) {
        return null;
    }

    const activeAnchor = activeIndex === null ? null : props.anchors[activeIndex] ?? null;
    const activeCenter = activeIndex === null
        ? 0
        : stackTop + activeIndex * MINIMAP_MARKER_PITCH + MINIMAP_MARKER_PITCH / 2 - scrollTop;
    const tooltipTop = Math.min(
        Math.max(activeCenter - tooltipHeight / 2, TOOLTIP_EDGE_INSET),
        Math.max(TOOLTIP_EDGE_INSET, availableHeight - tooltipHeight - TOOLTIP_EDGE_INSET),
    );

    const resolvePointerIndex = (pointerY: number, nextScrollTop: number): number => Math.max(
        0,
        Math.min(
            count - 1,
            Math.floor((pointerY + nextScrollTop) / MINIMAP_MARKER_PITCH),
        ),
    );

    const hoverHandlers = {
        onMouseMove: (event: any) => {
            const rect = event.currentTarget?.getBoundingClientRect?.();
            if (!rect || count === 0) return;
            const pointerY = event.clientY - rect.top;
            pointerYRef.current = pointerY;
            setActiveMessageId(props.anchors[resolvePointerIndex(pointerY, scrollTop)]?.messageId ?? null);
        },
        onMouseLeave: () => {
            pointerYRef.current = null;
            setActiveMessageId(null);
        },
    };

    return (
        <View
            pointerEvents="box-none"
            onLayout={(event) => setAvailableHeight(event.nativeEvent.layout.height)}
            style={{
                position: 'absolute',
                left: RAIL_LEFT,
                top: props.topInset,
                bottom: props.bottomInset,
                width: HIT_WIDTH + TOOLTIP_GAP + TOOLTIP_WIDTH,
                zIndex: 30,
            }}
            {...({ role: 'navigation', 'aria-label': '用户消息快速导航' } as any)}
        >
            {viewportHeight > 0 && (
                <View
                    {...hoverHandlers}
                    style={{
                        position: 'absolute',
                        left: 0,
                        top: stackTop,
                        width: HIT_WIDTH,
                        height: viewportHeight,
                        overflow: 'hidden',
                    }}
                >
                    <ScrollView
                        ref={scrollRef}
                        style={{
                            width: HIT_WIDTH,
                            height: viewportHeight,
                            ...(Platform.OS === 'web' ? ({ scrollbarWidth: 'none' } as any) : null),
                        }}
                        contentContainerStyle={{ height: stackHeight }}
                        scrollEnabled={scrollable}
                        nestedScrollEnabled
                        showsVerticalScrollIndicator={false}
                        scrollEventThrottle={16}
                        onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
                            const nextScrollTop = event.nativeEvent.contentOffset.y;
                            setScrollTop(nextScrollTop);
                            if (pointerYRef.current !== null) {
                                setActiveMessageId(props.anchors[
                                    resolvePointerIndex(pointerYRef.current, nextScrollTop)
                                ]?.messageId ?? null);
                            }
                        }}
                    >
                        {props.anchors.map((anchor, index) => {
                            const distance = activeIndex === null
                                ? Number.POSITIVE_INFINITY
                                : Math.abs(index - activeIndex);
                            const markerWidth = getConversationMinimapMarkerWidth(distance);
                            const isActive = activeIndex === index;
                            const markerColor = isActive
                                ? theme.dark ? '#DFDFDF' : theme.colors.text
                                : distance === 1
                                    ? theme.dark ? '#A0A0A0' : theme.colors.textSecondary
                                    : distance === 2
                                        ? theme.dark ? '#747474' : theme.colors.textSecondary
                                        : distance === 3
                                            ? theme.dark ? '#5A5A5A' : theme.colors.textSecondary
                                            : theme.dark ? '#464646' : theme.colors.textSecondary;

                            return (
                                <Pressable
                                    key={anchor.messageId}
                                    accessibilityRole="button"
                                    accessibilityLabel={`第 ${anchor.turnNumber} 条用户消息：${anchor.title}`}
                                    accessibilityState={{ selected: isActive }}
                                    onHoverIn={() => setActiveMessageId(anchor.messageId)}
                                    onFocus={() => {
                                        setActiveMessageId(anchor.messageId);
                                        if (scrollable) {
                                            scrollRef.current?.scrollTo({
                                                y: getConversationMinimapScrollTop(index, count, viewportHeight),
                                                animated: true,
                                            });
                                        }
                                    }}
                                    onBlur={() => setActiveMessageId((current) => (
                                        current === anchor.messageId ? null : current
                                    ))}
                                    onPress={() => props.onJump(anchor)}
                                    style={{
                                        width: HIT_WIDTH,
                                        height: MINIMAP_MARKER_PITCH,
                                        alignItems: 'flex-start',
                                        justifyContent: 'center',
                                        cursor: 'pointer' as any,
                                    }}
                                    {...({ 'aria-current': isActive ? 'true' : undefined } as any)}
                                >
                                    <View
                                        pointerEvents="none"
                                        style={{
                                            width: markerWidth,
                                            height: MINIMAP_MARKER_HEIGHT,
                                            borderRadius: 999,
                                            backgroundColor: markerColor,
                                            opacity: isActive ? 1 : distance <= 3 ? 0.9 : theme.dark ? 1 : 0.62,
                                            ...(Platform.OS === 'web' ? ({
                                                transitionProperty: 'width, background-color, opacity',
                                                transitionDuration: '140ms',
                                                transitionTimingFunction: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
                                            } as any) : null),
                                        }}
                                    />
                                </Pressable>
                            );
                        })}
                    </ScrollView>
                </View>
            )}

            {activeAnchor && (
                <View
                    pointerEvents="none"
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    onLayout={(event) => setTooltipHeight(event.nativeEvent.layout.height)}
                    style={{
                        position: 'absolute',
                        left: HIT_WIDTH + TOOLTIP_GAP,
                        top: tooltipTop,
                        width: TOOLTIP_WIDTH,
                        maxHeight: 100,
                        paddingHorizontal: 10,
                        paddingVertical: 10,
                        borderRadius: 12,
                        backgroundColor: theme.dark ? 'rgba(48, 48, 48, 0.88)' : theme.colors.surfaceHighest,
                        shadowColor: '#000000',
                        shadowOpacity: theme.dark ? 0.32 : 0.16,
                        shadowRadius: 20,
                        shadowOffset: { width: 0, height: 4 },
                        elevation: 8,
                        ...(Platform.OS === 'web' ? ({
                            backdropFilter: 'blur(12px)',
                            boxShadow: theme.dark
                                ? '0 4px 20px rgba(0, 0, 0, 0.32)'
                                : '0 4px 20px rgba(0, 0, 0, 0.16)',
                        } as any) : null),
                    }}
                >
                    <Text
                        numberOfLines={1}
                        style={{
                            color: theme.dark ? '#DFDFDF' : theme.colors.text,
                            fontSize: 13,
                            lineHeight: 18,
                            fontWeight: '600',
                        }}
                    >
                        {activeAnchor.title}
                    </Text>
                    {activeAnchor.body ? (
                        <Text
                            numberOfLines={3}
                            style={{
                                color: theme.dark ? '#969696' : theme.colors.textSecondary,
                                fontSize: 14,
                                lineHeight: 20,
                                marginTop: 2,
                            }}
                        >
                            {activeAnchor.body}
                        </Text>
                    ) : null}
                </View>
            )}
        </View>
    );
});

ConversationMinimap.displayName = 'ConversationMinimap';
