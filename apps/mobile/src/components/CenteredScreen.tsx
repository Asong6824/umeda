import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import { AppearanceBrand } from '@/components/AppearanceBrand';
import {
  fontWeight,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from '@/theme';
import { lineHeight, spacing, typeScale } from '@/theme/tokens';

/**
 * CenteredScreen —— 启动期全屏占位屏。
 *
 * splash 变体通过 AppearanceBrand 消费代码中的外观方案。original 继续复用
 * MobileLoginHandoffStage 的原有品牌舞台，minimal 使用文字标志。
 * 原生 starting window 仍由构建配置管理，不随此 JS 层适配改写。
 *
 * default 变体保持原样(通用 loading/占位)。
 */
export function CenteredScreen({
  title,
  subtitle,
  variant = 'default',
}: {
  title: string;
  subtitle?: string;
  variant?: 'default' | 'splash';
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();

  if (variant === 'splash') {
    return (
      <AppearanceBrand
        accessibilityLabel={title}
      />
    );
  }

  return (
    <View style={styles.root}>
      <ActivityIndicator color={colors.textSecondary} />
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    flex: 1,
    gap: spacing.sm,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  title: {
    color: colors.textPrimary,
    fontSize: typeScale.title,
    lineHeight: lineHeight.title,
    fontWeight: fontWeight.semibold,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: typeScale.body,
    lineHeight: lineHeight.body,
    textAlign: 'center',
  },
});
