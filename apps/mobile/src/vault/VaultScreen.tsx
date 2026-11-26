import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import * as Sharing from 'expo-sharing';
import type { VaultFile } from '@cindy/device-link';
import { Text, TextInput } from '@/components/AppText';
import { SimpleStackHeader } from '@/platform/chrome/SimpleStackHeader';
import { useSelfHostedRelayRouteGeneration } from '@/device-link/selfHostedRelay';
import { fontWeight, lineHeight, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { createMobileVaultReader, type VaultCatalog } from './client';
import { MarkdownFileReader } from '@/session/MarkdownFileReader';

export default function VaultScreen() {
  const { t } = useTranslation(), router = useRouter(), insets = useSafeAreaInsets();
  const generation = useSelfHostedRelayRouteGeneration();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const reader = useMemo(() => { try { return createMobileVaultReader(); } catch { return null; } }, [generation]);
  const [catalog, setCatalog] = useState<VaultCatalog>({ vaults: [], files: {}, updatedAt: 0 });
  const [vaultId, setVaultId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [document, setDocument] = useState<{ title: string; text?: string; markdown: boolean; uri: string } | null>(null);
  const [pending, setPending] = useState(false), [offline, setOffline] = useState(false), [error, setError] = useState(false);
  const operation = useRef(0);
  const busy = useRef(false);
  const refresh = useCallback(async () => {
    if (!reader || busy.current) return;
    busy.current = true;
    const token = ++operation.current;
    setPending(true); setError(false);
    try {
      const next = await reader.refresh();
      if (operation.current === token) { setCatalog(next); setOffline(false); }
    } catch { if (operation.current === token) setOffline(true); }
    finally { if (operation.current === token) { busy.current = false; setPending(false); } }
  }, [reader]);
  useEffect(() => {
    const token = ++operation.current;
    busy.current = false;
    setCatalog({ vaults: [], files: {}, updatedAt: 0 }); setVaultId(null); setDocument(null);
    if (reader) void reader.cached().then(cached => {
      if (operation.current !== token) return;
      setCatalog(cached); void refresh();
    }).catch(() => { if (operation.current === token) void refresh(); });
    return () => { operation.current++; };
  }, [reader, refresh]);
  useFocusEffect(useCallback(() => {
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); });
    const timer = setInterval(() => { if (AppState.currentState === 'active') void refresh(); }, 60_000);
    return () => { subscription.remove(); clearInterval(timer); };
  }, [refresh]));
  const open = async (entry: VaultFile) => {
    if (!reader || !vaultId || pending) return;
    const token = ++operation.current;
    busy.current = true;
    setPending(true); setError(false);
    try {
      const result = await reader.read(vaultId, entry);
      if (operation.current !== token) return;
      const text = result.bytes.length <= 512 * 1024 && /\.(md|txt|json|ya?ml|csv)$/i.test(entry.path)
        ? new TextDecoder().decode(result.bytes) : undefined;
      setDocument({ title: entry.path, text, markdown: /\.md$/i.test(entry.path), uri: result.uri });
    } catch { if (operation.current === token) setError(true); }
    finally { if (operation.current === token) { busy.current = false; setPending(false); } }
  };
  const back = () => {
    operation.current++; busy.current = false; setPending(false);
    if (document) setDocument(null); else if (vaultId) { setVaultId(null); setSearch(''); } else router.back();
  };
  const rows: Array<{ id: string; title: string; file: VaultFile | null }> = vaultId ? (catalog.files[vaultId] ?? []).map(file => ({ id: file.path, title: file.path, file }))
    : catalog.vaults.map(vault => ({ id: vault.id, title: vault.name, file: null }));
  return <View style={[styles.root, { paddingBottom: insets.bottom }]}>
    <SimpleStackHeader title={t('files.vault.title')} onBack={back} syncing={pending} />
    <View style={styles.toolbar}>
      <Text style={styles.status}>{t(offline ? 'files.vault.offline' : 'files.vault.cloud')}</Text>
      <Pressable accessibilityRole="button" disabled={pending} onPress={() => void refresh()} style={styles.action}>
        <Text style={styles.actionText}>{t('files.vault.refresh')}</Text>
      </Pressable>
    </View>
    {!document ? <TextInput style={styles.search} value={search} onChangeText={setSearch}
      placeholder={t('files.browser.searchPlaceholder')} placeholderTextColor={colors.textPlaceholder}
      accessibilityLabel={t('files.browser.searchPlaceholder')} /> : null}
    {error ? <Text style={styles.notice}>{t('files.vault.readError')}</Text> : null}
    {document ? <View style={styles.root}>
      <Text selectable style={styles.label}>{document.title}</Text>
      {document.text !== undefined ? document.markdown ? <MarkdownFileReader markdown={document.text} />
        : <ScrollView contentContainerStyle={styles.content}><Text selectable style={styles.body}>{document.text}</Text></ScrollView> : <Pressable
        accessibilityRole="button" style={styles.action} onPress={() => void Sharing.shareAsync(document.uri).catch(() => setError(true))}>
        <Text style={styles.actionText}>{t('files.browser.exportShare')}</Text>
      </Pressable>}
    </View> : <FlatList data={rows.filter(row => row.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()))} keyExtractor={row => row.id} contentContainerStyle={styles.content}
      ListEmptyComponent={<Text style={styles.notice}>{t('files.vault.empty')}</Text>}
      renderItem={({ item }) => <Pressable accessibilityRole="button" disabled={pending} style={styles.row}
        onPress={() => { if (item.file) void open(item.file); else { setVaultId(item.id); setSearch(''); } }}>
        <Text style={styles.label}>{item.title}</Text>
      </Pressable>} />}
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg },
  content: { padding: spacing.lg, gap: spacing.md },
  row: { minHeight: 44, justifyContent: 'center', paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  label: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium, color: colors.textPrimary },
  body: { fontSize: typeScale.bodyLarge, lineHeight: lineHeight.bodyLarge, fontWeight: fontWeight.regular, color: colors.textPrimary },
  status: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textTertiary },
  notice: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary, padding: spacing.md },
  action: { minHeight: 44, minWidth: 44, justifyContent: 'center', padding: spacing.md },
  actionText: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium, color: colors.textPrimary },
  search: { minHeight: 44, paddingHorizontal: spacing.lg, fontSize: typeScale.body, fontWeight: fontWeight.regular, color: colors.textPrimary },
});
