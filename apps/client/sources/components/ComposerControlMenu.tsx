import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Platform, ScrollView, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
    Easing,
    FadeIn,
    FadeOut,
    LinearTransition,
    ReduceMotion,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { AnimatedPopup } from './AnimatedOverlay';
import { BubblePressable } from './BubblePressable';
import { MobileGlassSurface } from './MobileGlass';

export type ComposerControlMenuItem = {
    key: string;
    label: string;
    description?: string | null;
    icon?: React.ComponentProps<typeof Ionicons>['name'];
    selected?: boolean;
    disabled?: boolean;
    tone?: 'default' | 'warning';
    onPress?: () => void;
};

export type ComposerControlMenuSection = {
    key: string;
    label?: string;
    items: ComposerControlMenuItem[];
};

type ComposerControlMenuProps = {
    sections: ComposerControlMenuSection[];
    maxHeight?: number;
    style?: StyleProp<ViewStyle>;
    accessibilityLabel?: string;
    presentation?: 'default' | 'choice';
};

const enterSelection = FadeIn
    .duration(170)
    .easing(Platform.OS === 'web' ? Easing.linear : Easing.out(Easing.cubic))
    .withInitialValues({ opacity: 0, transform: [{ scale: 0.98 }] } as any)
    .reduceMotion(ReduceMotion.System);

const exitSelection = FadeOut
    .duration(120)
    .easing(Platform.OS === 'web' ? Easing.linear : Easing.in(Easing.cubic))
    .reduceMotion(ReduceMotion.System);

const selectionLayout = LinearTransition
    .duration(180)
    .easing(Platform.OS === 'web' ? Easing.linear : Easing.out(Easing.cubic))
    .reduceMotion(ReduceMotion.System);

const stylesheet = StyleSheet.create((theme) => ({
    popup: {
        width: '100%',
        borderRadius: Platform.OS === 'web' ? 18 : 22,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 10 },
        shadowRadius: 26,
        shadowOpacity: theme.dark ? 0.34 : 0.14,
        elevation: 18,
    },
    popupChoice: {
        borderRadius: 16,
        backgroundColor: theme.colors.surfaceHighest,
    },
    scroll: {
        width: '100%',
    },
    content: {
        paddingHorizontal: 8,
        paddingVertical: 8,
    },
    contentChoice: {
        paddingHorizontal: 4,
        paddingVertical: 5,
    },
    section: {
        gap: 2,
    },
    sectionChoice: {
        gap: 0,
    },
    sectionSpacing: {
        marginTop: 8,
    },
    sectionLabel: {
        paddingHorizontal: 10,
        paddingTop: 4,
        paddingBottom: 5,
        color: theme.colors.textSecondary,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    sectionLabelChoice: {
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 3,
        color: theme.colors.textSecondary,
        fontSize: 14,
        lineHeight: 20,
        ...Typography.default('semiBold'),
    },
    row: {
        minHeight: 50,
        borderRadius: 14,
        overflow: 'hidden',
        position: 'relative',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 11,
        paddingHorizontal: 11,
        paddingVertical: 8,
    },
    rowChoice: {
        minHeight: 36,
        borderRadius: 10,
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    rowChoiceWithDescription: {
        minHeight: 56,
    },
    rowPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    selection: {
        ...StyleSheet.absoluteFillObject,
        borderRadius: 14,
        backgroundColor: theme.colors.surfaceSelected,
    },
    iconSlot: {
        width: 20,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        zIndex: 1,
    },
    copy: {
        minWidth: 0,
        flex: 1,
        zIndex: 1,
    },
    label: {
        color: theme.colors.text,
        fontSize: 15,
        lineHeight: 20,
        ...Typography.default('semiBold'),
    },
    labelChoice: {
        fontSize: 14,
        lineHeight: 20,
        fontWeight: '500',
        ...Typography.default(),
    },
    description: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 17,
        marginTop: 1,
        ...Typography.default(),
    },
    descriptionChoice: {
        fontSize: 12,
        lineHeight: 18,
        marginTop: 0,
    },
    check: {
        width: 20,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1,
    },
    checkChoice: {
        width: 18,
    },
}));

const WARNING = '#F97316';

export const ComposerControlMenu = React.memo(function ComposerControlMenu({
    sections,
    maxHeight = 420,
    style,
    accessibilityLabel = 'Composer menu',
    presentation = 'default',
}: ComposerControlMenuProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const choicePresentation = presentation === 'choice';

    return (
        <AnimatedPopup style={style}>
            <MobileGlassSurface
                enabled
                nativeEffect
                material="frosted"
                intensity={88}
                accessibilityRole="menu"
                accessibilityLabel={accessibilityLabel}
                style={[styles.popup, choicePresentation && styles.popupChoice]}
            >
                <ScrollView
                    style={[styles.scroll, { maxHeight }]}
                    contentContainerStyle={[styles.content, choicePresentation && styles.contentChoice]}
                    keyboardShouldPersistTaps="always"
                    showsVerticalScrollIndicator={sections.some((section) => section.items.length > 7)}
                >
                    {sections.map((section, sectionIndex) => (
                        <View
                            key={section.key}
                            style={[
                                styles.section,
                                choicePresentation && styles.sectionChoice,
                                sectionIndex > 0 && styles.sectionSpacing,
                            ]}
                        >
                            {section.label ? (
                                <Text style={choicePresentation ? styles.sectionLabelChoice : styles.sectionLabel}>
                                    {section.label}
                                </Text>
                            ) : null}
                            {section.items.map((item) => {
                                const foreground = item.tone === 'warning' ? WARNING : theme.colors.text;
                                return (
                                    <BubblePressable
                                        key={item.key}
                                        onPress={item.onPress}
                                        disabled={item.disabled || !item.onPress}
                                        scaleFeedback={false}
                                        accessibilityRole="menuitem"
                                        accessibilityLabel={item.description
                                            ? `${item.label}，${item.description}`
                                            : item.label}
                                        accessibilityState={{
                                            selected: item.selected === true,
                                            disabled: item.disabled === true || !item.onPress,
                                        }}
                                        style={({ pressed }) => [
                                            styles.row,
                                            choicePresentation && styles.rowChoice,
                                            choicePresentation && item.description && styles.rowChoiceWithDescription,
                                            pressed && !item.selected && styles.rowPressed,
                                            (item.disabled || !item.onPress) && { opacity: 0.48 },
                                        ]}
                                    >
                                        {item.selected && !choicePresentation ? (
                                            <Animated.View
                                                entering={enterSelection}
                                                exiting={exitSelection}
                                                layout={selectionLayout}
                                                pointerEvents="none"
                                                style={styles.selection}
                                            />
                                        ) : null}
                                        {item.icon || !choicePresentation ? (
                                            <View style={styles.iconSlot}>
                                                {item.icon ? (
                                                <Ionicons name={item.icon} size={18} color={foreground} />
                                                ) : null}
                                            </View>
                                        ) : null}
                                        <View style={styles.copy}>
                                            <Text style={[
                                                styles.label,
                                                choicePresentation && styles.labelChoice,
                                                { color: foreground },
                                            ]}>{item.label}</Text>
                                            {item.description ? (
                                                <Text style={[
                                                    styles.description,
                                                    choicePresentation && styles.descriptionChoice,
                                                    item.tone === 'warning' && { color: WARNING },
                                                ]}>
                                                    {item.description}
                                                </Text>
                                            ) : null}
                                        </View>
                                        <View style={[styles.check, choicePresentation && styles.checkChoice]}>
                                            {item.selected ? (
                                                <Animated.View entering={enterSelection} exiting={exitSelection}>
                                                    <Ionicons
                                                        name="checkmark"
                                                        size={choicePresentation ? 17 : 19}
                                                        color={choicePresentation ? theme.colors.textSecondary : foreground}
                                                    />
                                                </Animated.View>
                                            ) : null}
                                        </View>
                                    </BubblePressable>
                                );
                            })}
                        </View>
                    ))}
                </ScrollView>
            </MobileGlassSurface>
        </AnimatedPopup>
    );
});
