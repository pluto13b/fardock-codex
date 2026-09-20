import * as React from 'react';
import { Picker } from '@react-native-picker/picker';
import { StyleSheet, View } from 'react-native';
import type { NativeSettingsMenuProps } from './NativeSettingsMenu';

const styles = StyleSheet.create({
    container: {
        position: 'relative',
    },
    picker: {
        ...StyleSheet.absoluteFillObject,
        opacity: 0,
        cursor: 'pointer',
    },
});

export function NativeSettingsMenu({ children, style, groups, accessibilityLabel }: NativeSettingsMenuProps) {
    const group = groups[0];
    if (!group) {
        return <View style={style}>{children}</View>;
    }

    return (
        <View style={[styles.container, style]}>
            <View pointerEvents="none">{children}</View>
            <Picker
                accessibilityLabel={accessibilityLabel ?? group.title ?? group.label}
                selectedValue={group.selectedKey ?? undefined}
                onValueChange={(value) => {
                    if (typeof value === 'string' && value !== group.selectedKey) {
                        group.onSelect(value);
                    }
                }}
                prompt={group.title}
                style={styles.picker}
            >
                {group.options.map((option) => (
                    <Picker.Item
                        key={option.key}
                        label={option.label}
                        value={option.key}
                        enabled={!option.disabled}
                    />
                ))}
            </Picker>
        </View>
    );
}
