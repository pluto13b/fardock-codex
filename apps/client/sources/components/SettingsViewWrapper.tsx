import * as React from 'react';
import { NativeScrollEvent, NativeSyntheticEvent, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { CodexSettingsView } from './CodexSettingsView';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
}));

export const SettingsViewWrapper = React.memo(({
    topContentInset = 0,
    bottomContentInset = 0,
    onScroll,
}: {
    topContentInset?: number;
    bottomContentInset?: number;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}) => {
    const styles = stylesheet;

    return (
        <View style={styles.container}>
            <CodexSettingsView topContentInset={topContentInset} bottomContentInset={bottomContentInset} onScroll={onScroll} />
        </View>
    );
});
