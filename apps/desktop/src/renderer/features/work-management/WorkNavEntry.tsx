import { ListChecks } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SidebarIconButton } from '@/components/sidebar/SidebarIconButton';
import { cn } from '@/lib/utils';
import { useWorkAvailable } from './client';

export function WorkNavEntry({ compact = false }: { compact?: boolean }) {
  const available = useWorkAvailable(), navigate = useNavigate(), location = useLocation(), { t } = useTranslation();
  if (!available) return null;
  const active = location.pathname === '/work';
  if (compact) return <div className="flex justify-center"><SidebarIconButton icon={ListChecks} label={t('umedaWork.title')} active={active} onClick={() => navigate('/work')} /></div>;
  return <div className="px-3 pb-1"><button type="button" onClick={() => navigate('/work')} aria-current={active ? 'page' : undefined}
    className={cn('flex h-8 w-full items-center gap-2.5 rounded-full px-3 text-sm text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover', active && 'bg-sidebar-item-active font-medium text-sidebar-item-active-foreground hover:bg-sidebar-item-active')}>
    <ListChecks size={15} strokeWidth={1.8} aria-hidden="true" /><span>{t('umedaWork.title')}</span>
  </button></div>;
}
