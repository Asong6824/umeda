import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { resolveAppearanceScheme, type AppearanceSchemeId } from '@cindy/maker-shared/appearance-scheme';
import { Text } from '@/components/AppText';
import { MobileLoginHandoffStage } from '@/components/MobileLoginHandoffStage';
import { fontWeight, lineHeight, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

/** App-level brand surface; native launch screen and OS identity remain build-time. */
export function AppearanceBrand({ schemeId, accessibilityLabel }: {
  schemeId?: AppearanceSchemeId;
  accessibilityLabel: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const selected = resolveAppearanceScheme(schemeId);
  if (selected.brandStyle === 'illustrated') {
    return <MobileLoginHandoffStage accessibilityLabel={accessibilityLabel} testID="startup.splash" />;
  }
  return (
    <View style={styles.splash} testID="startup.splash">
      <Text accessibilityRole="header" style={styles.hero}>Umeda</Text>
      <ActivityIndicator color={colors.textSecondary} />
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg, backgroundColor: colors.surface },
  hero: { color: colors.textPrimary, fontSize: typeScale.hero, lineHeight: lineHeight.hero, fontWeight: fontWeight.medium },
});
