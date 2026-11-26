import { useCallback, useDeferredValue, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { useTranslation } from 'react-i18next';
import type { WorkItem, WorkItemKind, WorkItemStatus, WorkItemSummary, WorkManagementRequest, WorkProgressRecord, WorkRecordSummary } from '@cindy/maker-shared/work-management';
import { splitWorkDescription } from '@cindy/maker-shared/work-management';
import type { WorkSyncStatus, WorkConflict } from '@cindy/maker-shared/work-replication';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowOptionButton } from '@/components/MobilePrimitives';
import { SimpleStackHeader } from '@/platform/chrome/SimpleStackHeader';
import { MarkdownFileReader } from '@/session/MarkdownFileReader';
import { getMobileAuthOwner, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { useSelfHostedRelayRouteGeneration } from '@/device-link/selfHostedRelay';
import { fontWeight, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { mobileWork, subscribeWorkChanges } from './runtime';

const kinds: WorkItemKind[] = ['task', 'project', 'goal'];
const statuses: WorkItemStatus[] = ['todo', 'doing', 'done', 'blocked', 'cancelled'];

function WorkContent() {
  const { t } = useTranslation(), router = useRouter(), styles = useThemedStyles(makeStyles), { colors } = useTheme();
  const [runtime] = useState(mobileWork), [kind, setKind] = useState<WorkItemKind>('task');
  const [query, setQuery] = useState(''), deferredQuery = useDeferredValue(query);
  const [items, setItems] = useState<WorkItemSummary[]>([]), [next, setNext] = useState<string | null>(null);
  const [version, setVersion] = useState(0), [selected, setSelected] = useState<string | null>(null), [item, setItem] = useState<WorkItem | null>(null);
  const [records, setRecords] = useState<WorkRecordSummary[]>([]), [before, setBefore] = useState<number | null>(null);
  const [sync, setSync] = useState<WorkSyncStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [form, setForm] = useState<{ kind: WorkItemKind; item?: WorkItem } | null>(null), [reading, setReading] = useState<string | null>(null);
  const alive = useRef(true), lock = useRef(false), pages = useRef(1);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => subscribeWorkChanges(() => setVersion(v => v + 1)), []);
  useEffect(() => {
    let current = true;
    if (!runtime) return;
    const load = async () => {
      const all: WorkItemSummary[] = []; let after: string | null = null;
      for (let n = 0; n < pages.current; n++) {
        const page = await runtime.execute({ operation: 'list', kind, query: deferredQuery, limit: 50, ...(after ? { after } : {}) });
        if (!current) return;
        all.push(...(page.items ?? [])); after = page.next_after ?? null; if (!after) break;
      }
      setItems(all); setNext(after);
      const status = await runtime.replica({ operation: 'status' });
      if (current) setSync(status as unknown as WorkSyncStatus);
    };
    void load().catch(() => { if (current) setError(t('umedaWork.loadFailed')); });
    return () => { current = false; };
  }, [runtime, kind, deferredQuery, version, t]);
  useEffect(() => {
    let current = true;
    setItem(null); setRecords([]); setBefore(null);
    if (runtime && selected) void runtime.execute({ operation: 'get', id: selected }).then(result => {
      if (current) { setItem(result.item ?? null); setRecords(result.records ?? []); setBefore(result.next_before_record ?? null); }
    }).catch(() => { if (current) setError(t('umedaWork.loadFailed')); });
    return () => { current = false; };
  }, [runtime, selected, version, t]);
  const perform = async (operation: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await operation(); }
    catch (failure) { if (alive.current) setError(failure instanceof Error && failure.message.includes('WORK_VERSION_CONFLICT') ? t('umedaWork.conflict') : t('umedaWork.sync.failed')); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const back = () => {
    if (reading !== null) setReading(null);
    else if (form) setForm(null);
    else if (selected) { setSelected(null); setItem(null); }
    else if (router.canGoBack()) router.back(); else router.replace('/');
  };
  const openRecord = (record: WorkProgressRecord) => setReading([record.summary, ...record.changes.map(c => `## ${c.after.title}\n\n${t('umedaWork.status')}: ${t(`umedaWork.state.${c.after.status}`)}\n\n${splitWorkDescription(c.after.description).body}`), ...record.verification.map(v => `${v.description}\n\n${v.evidence ?? ''}`)].join('\n\n'));
  return <View style={styles.root}>
    <SimpleStackHeader title={form ? t(form.item ? 'umedaWork.editItem' : 'umedaWork.newItem', { kind: t(`umedaWork.kind.${form.kind}`) }) : item?.title ?? t('umedaWork.title')} onBack={back} />
    {error ? <Text accessibilityRole="alert" style={styles.notice}>{error}</Text> : null}
    {!runtime ? <Text style={styles.notice}>{t('umedaWork.unavailable')}</Text> : reading !== null ? <MarkdownFileReader markdown={reading} /> : form ? <WorkForm key={form.item?.id ?? form.kind} kind={form.kind} item={form.item} saved={() => { setForm(null); setVersion(v => v + 1); }} /> : selected ? !item ? <ActivityIndicator color={colors.textSecondary} /> : <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>{item.title}</Text>
      <Text style={styles.metadata}>{t(`umedaWork.state.${item.status}`)}{item.progress ? ` · ${item.progress.percent}%` : ''}</Text>
      {item.progress?.basis ? <Text style={styles.body}>{item.progress.basis}</Text> : null}
      <View style={styles.actions}><MainWindowOptionButton label={t('umedaWork.edit')} onPress={() => setForm({ kind: item.kind, item })} />
        {item.kind === 'task' ? <MainWindowOptionButton disabled={busy} label={t(item.status === 'done' ? 'umedaWork.reopen' : 'umedaWork.complete')} onPress={() => void perform(() => runtime.execute({ operation: 'update', request_id: randomUUID(), summary: t(item.status === 'done' ? 'umedaWork.reopen' : 'umedaWork.complete'), changes: [{ id: item.id, expected_revision: item.revision, status: item.status === 'done' ? 'todo' : 'done' }] }))} /> : null}</View>
      {splitWorkDescription(item.description).body ? <MainWindowOptionButton label={t('umedaWork.readBody')} onPress={() => setReading(splitWorkDescription(item.description).body)} /> : null}
      {[...item.project_ids, ...item.goal_ids].map(id => <MainWindowOptionButton key={id} label={t('umedaWork.openRelated')} onPress={() => setSelected(id)} />)}
      {item.kind !== 'task' ? <MainWindowOptionButton label={t('umedaWork.relatedTasks')} onPress={() => void perform(async () => {
        const related = await runtime.execute({ operation: 'list', ...(item.kind === 'goal' ? { goal_id: item.id } : { project_id: item.id }), kind: 'task', limit: 50 });
        setReading((related.items ?? []).map(v => `- ${v.title} · ${t(`umedaWork.state.${v.status}`)}`).join('\n') || t('umedaWork.noRelatedTasks'));
      })} /> : null}
      <Text style={styles.label}>{t('umedaWork.history')}</Text>
      {records.map(record => <Pressable key={record.request_id} accessibilityRole="button" style={styles.row} onPress={() => void perform(async () => { const full = await runtime.execute({ operation: 'record', request_id: record.request_id }); if (full.record) openRecord(full.record); })}>
        <Text style={styles.body}>{record.operation === 'create' ? t('umedaWork.createdSummary', { title: record.created_title }) : record.summary}</Text><Text style={styles.metadata}>{new Date(record.created_at).toLocaleString()}</Text>
      </Pressable>)}
      {before ? <MainWindowOptionButton disabled={busy} label={t('umedaWork.more')} onPress={() => void perform(async () => {
        const page = await runtime.execute({ operation: 'get', id: item.id, before_record: before }); setRecords(v => [...v, ...(page.records ?? [])]); setBefore(page.next_before_record ?? null);
      })} /> : null}
    </ScrollView> : <>
      <View style={styles.actions}>{kinds.map(value => <MainWindowOptionButton key={value} selected={kind === value} label={t(`umedaWork.tabs.${value}`)} onPress={() => { pages.current = 1; setKind(value); }} />)}</View>
      <TextInput accessibilityLabel={t('umedaWork.search')} placeholder={t('umedaWork.search')} placeholderTextColor={colors.textPlaceholder} style={styles.input} value={query} onChangeText={value => { pages.current = 1; setQuery(value); }} maxLength={200} />
      <View style={styles.actions}><MainWindowOptionButton label={t('umedaWork.newItem', { kind: t(`umedaWork.kind.${kind}`) })} onPress={() => setForm({ kind })} />
        <MainWindowOptionButton label={t('umedaWork.retry')} onPress={() => { runtime.wake(); setVersion(v => v + 1); }} /></View>
      <FlatList data={items} keyExtractor={value => value.id} contentContainerStyle={styles.content} ListEmptyComponent={<Text style={styles.notice}>{t('umedaWork.empty', { kind: t(`umedaWork.kind.${kind}`) })}</Text>} renderItem={({ item: value }) => <Pressable accessibilityRole="button" accessibilityLabel={value.title} style={styles.row} onPress={() => setSelected(value.id)}>
        <Text style={styles.title}>{value.title}</Text><Text style={styles.metadata}>{t(`umedaWork.state.${value.status}`)}{value.progress ? ` · ${value.progress.percent}%` : ''}</Text>
      </Pressable>} ListFooterComponent={next ? <MainWindowOptionButton label={t('umedaWork.more')} onPress={() => { pages.current++; setVersion(v => v + 1); }} /> : undefined} />
    </>}
    {sync && !form && reading === null ? <ScrollView style={styles.sync}>
      {sync.error ? <Text style={styles.notice}>{t('umedaWork.sync.paused')}</Text> : null}
      <Text style={styles.notice}>{sync.conflicts.length ? t('umedaWork.sync.conflicts', { count: sync.conflicts.length }) : sync.queued ? t('umedaWork.sync.queued', { count: sync.queued }) : sync.scope ? t('umedaWork.sync.saved') : t('umedaWork.sync.local')}</Text>
      {sync.conflicts.map(conflict => <View key={conflict.request_id} style={styles.actions}>
        <MainWindowOptionButton label={t('umedaWork.sync.compare')} onPress={() => void perform(async () => { const detail = await runtime?.replica({ operation: 'conflict', request_id: conflict.request_id }) as unknown as WorkConflict; setReading(`${t('umedaWork.sync.explanation')}\n\n${(['local', 'remote'] as const).map(side => `# ${t(`umedaWork.sync.${side}Version`)}\n\n${detail[side].map(v => `## ${v.title}\n\n${t(`umedaWork.state.${v.status}`)}${v.progress ? ` · ${v.progress.percent}% · ${v.progress.basis}` : ''}\n\n${splitWorkDescription(v.description).body}`).join('\n\n')}`).join('\n\n')}`); })} />
        <MainWindowOptionButton disabled={busy} label={t('umedaWork.sync.keepLocal')} onPress={() => void perform(async () => { await runtime?.replica({ operation: 'resolve', request_id: conflict.request_id, choice: 'local', nonce: randomUUID(), now: Date.now() }); runtime?.wake(); setVersion(v => v + 1); })} />
        <MainWindowOptionButton disabled={busy} label={t('umedaWork.sync.useRemote')} onPress={() => void perform(async () => { await runtime?.replica({ operation: 'resolve', request_id: conflict.request_id, choice: 'remote', nonce: randomUUID(), now: Date.now() }); runtime?.wake(); setVersion(v => v + 1); })} />
      </View>)}
    </ScrollView> : null}
  </View>;
}

function WorkForm({ kind, item, saved }: { kind: WorkItemKind; item?: WorkItem; saved(): void }) {
  const { t } = useTranslation(), styles = useThemedStyles(makeStyles), { colors } = useTheme();
  const original = splitWorkDescription(item?.description ?? '');
  const [title, setTitle] = useState(item?.title ?? ''), [body, setBody] = useState(original.body), [status, setStatus] = useState(item?.status ?? (kind === 'task' ? 'todo' : 'doing'));
  const [percent, setPercent] = useState(item?.progress ? String(item.progress.percent) : ''), [basis, setBasis] = useState(item?.progress?.basis ?? '');
  const [goals, setGoals] = useState(item?.goal_ids ?? []), [projects, setProjects] = useState(item?.project_ids ?? []), [targets, setTargets] = useState<WorkItemSummary[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const attempt = useRef<{ payload: string; id: string } | null>(null), lock = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let current = true; const runtime = mobileWork();
    if (!runtime) return;
    void (async () => {
      const values: WorkItemSummary[] = [];
      for (const group of ['project', 'goal'] as const) {
        if (kind === 'goal' || (kind === 'project' && group === 'project')) continue;
        let after: string | null = null;
        do { const page = await runtime.execute({ operation: 'list', kind: group, limit: 50, ...(after ? { after } : {}) }); if (!current) return; values.push(...(page.items ?? [])); after = page.next_after ?? null; } while (after);
      }
      if (current) setTargets(values);
    })().catch(() => { if (current) setError(t('umedaWork.loadFailed')); });
    return () => { current = false; };
  }, [kind, t]);
  const save = useCallback(async () => {
    if (lock.current || !title.trim()) return;
    if (kind !== 'task' && percent && (!Number.isFinite(Number(percent)) || Number(percent) < 0 || Number(percent) > 100 || !basis.trim())) { setError(t('umedaWork.progressNeedsBasis')); return; }
    lock.current = true; setBusy(true); setError('');
    const fields = { title, description: body + original.metadataSuffix, project_ids: projects, goal_ids: goals };
    const content = item ? { operation: 'update' as const, summary: t('umedaWork.editedSummary', { title }), changes: [{ id: item.id, expected_revision: item.revision, ...fields, status, progress: kind === 'task' || !percent ? null : { percent: Number(percent), basis } }] } : { operation: 'create' as const, kind, ...fields };
    const serialized = JSON.stringify(content);
    if (attempt.current?.payload !== serialized) attempt.current = { payload: serialized, id: randomUUID() };
    try {
      const runtime = mobileWork(); if (!runtime) throw new Error('WORK_CONTEXT_CHANGED');
      await runtime.execute({ ...content, request_id: attempt.current.id } as WorkManagementRequest);
      if (alive.current) saved();
    } catch (failure) { if (alive.current) setError(failure instanceof Error && failure.message.includes('WORK_VERSION_CONFLICT') ? t('umedaWork.conflict') : t('umedaWork.saveFailed')); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }, [title, body, status, kind, percent, basis, projects, goals, item, original.metadataSuffix, saved, t]);
  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.root}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
    <Text style={styles.label}>{t('umedaWork.name')}</Text><TextInput accessibilityLabel={t('umedaWork.name')} value={title} onChangeText={setTitle} maxLength={300} placeholderTextColor={colors.textPlaceholder} style={styles.input} />
    <Text style={styles.label}>{t('umedaWork.description')}</Text><TextInput accessibilityLabel={t('umedaWork.description')} multiline value={body} onChangeText={setBody} maxLength={8000 - original.metadataSuffix.length} placeholderTextColor={colors.textPlaceholder} style={[styles.input, styles.multiline]} />
    {item ? <><Text style={styles.label}>{t('umedaWork.status')}</Text><View style={styles.actions}>{statuses.map(value => <MainWindowOptionButton key={value} selected={status === value} label={t(`umedaWork.state.${value}`)} onPress={() => setStatus(value)} />)}</View></> : null}
    {item && kind !== 'task' ? <><Text style={styles.label}>{t('umedaWork.progress')}</Text><TextInput accessibilityLabel={t('umedaWork.progress')} value={percent} onChangeText={setPercent} keyboardType="decimal-pad" maxLength={6} style={styles.input} /><TextInput accessibilityLabel={t('umedaWork.note')} value={basis} onChangeText={setBasis} multiline maxLength={2000} style={styles.input} /></> : null}
    {targets.length ? <><Text style={styles.label}>{t('umedaWork.linkOptional')}</Text>{targets.map(value => {
      const ids = value.kind === 'goal' ? goals : projects, set = value.kind === 'goal' ? setGoals : setProjects;
      return <MainWindowOptionButton key={value.id} selected={ids.includes(value.id)} label={value.title} onPress={() => set(current => current.includes(value.id) ? current.filter(id => id !== value.id) : [...current, value.id])} />;
    })}</> : null}
    {error ? <Text accessibilityRole="alert" style={styles.notice}>{error}</Text> : null}
    <MainWindowOptionButton label={t('umedaWork.save')} disabled={busy || !title.trim()} onPress={() => void save()} />
  </ScrollView></KeyboardAvoidingView>;
}

export default function WorkScreen() {
  const owner = useSyncExternalStore(subscribeMobileAuthOwner, getMobileAuthOwner), generation = useSelfHostedRelayRouteGeneration();
  return <WorkContent key={`${owner.accountKey}:${owner.generation}:${generation}`} />;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  title: { fontSize: typeScale.subtitle, lineHeight: lineHeight.subtitle, fontWeight: fontWeight.medium, color: colors.textPrimary },
  label: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium, color: colors.textPrimary },
  body: { fontSize: typeScale.bodyLarge, lineHeight: lineHeight.bodyLarge, fontWeight: fontWeight.regular, color: colors.textPrimary },
  metadata: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textTertiary },
  notice: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  input: { minHeight: 44, padding: spacing.md, marginHorizontal: spacing.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.control, color: colors.textPrimary, fontSize: typeScale.body, fontWeight: fontWeight.regular },
  multiline: { minHeight: 180, textAlignVertical: 'top', lineHeight: lineHeight.body },
  row: { minHeight: 44, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, padding: spacing.md },
  sync: { flexGrow: 0, maxHeight: '35%', padding: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
});
