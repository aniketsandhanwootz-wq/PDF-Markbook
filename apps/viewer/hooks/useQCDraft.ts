'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

export type MarkStatus = 'PASS' | 'FAIL' | 'DOUBT' | '';

export type QCDraft = {
  reportTitle: string;
  entries: Record<string, string>;
  statuses: Record<string, MarkStatus>;
  currentMarkIndex: number;
  titleConfirmed: boolean;
  updatedAt: number;
};

type UseQCDraftArgs = {
  enabled: boolean;
  projectName: string;
  extId: string;
  partNumber: string;
  markSetId: string | null;
  userEmail: string | null;
  liveState: {
    reportTitle: string;
    entries: Record<string, string>;
    statuses: Record<string, MarkStatus | ''>;
    currentMarkIndex: number;
    titleConfirmed: boolean;
  };
  autosave: boolean;
};

export function useQCDraft({
  enabled,
  projectName,
  extId,
  partNumber,
  markSetId,
  userEmail,
  liveState,
  autosave,
}: UseQCDraftArgs) {
  // 🔑 Per-document + markset + user key
  const storageKey = useMemo(() => {
    if (!enabled) return null;
    if (!markSetId) return null;

    const parts = [
      'qcDraft',
      projectName || 'NA',
      extId || 'NA',
      partNumber || 'NA',
      markSetId,
      userEmail || 'anon',
    ];

    return parts.join('::');
  }, [enabled, projectName, extId, partNumber, markSetId, userEmail]);

  const [draft, setDraft] = useState<QCDraft | null>(null);

  // 🔹 Initial load from localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!storageKey) {
      setDraft(null);
      return;
    }

    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        setDraft(null);
        return;
      }

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        setDraft(null);
        return;
      }

      const draftObj: QCDraft = {
        reportTitle: typeof parsed.reportTitle === 'string' ? parsed.reportTitle : '',
        entries:
          parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {},
        statuses:
          parsed.statuses && typeof parsed.statuses === 'object'
            ? parsed.statuses
            : {},
        currentMarkIndex:
          typeof parsed.currentMarkIndex === 'number' ? parsed.currentMarkIndex : 0,
        titleConfirmed: !!parsed.titleConfirmed,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      };

      setDraft(draftObj);
    } catch (e) {
      console.warn('[useQCDraft] failed to parse draft from localStorage', e);
      setDraft(null);
    }
  }, [storageKey]);

  // 🔹 Throttled autosave to localStorage (no extra RAM copy)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!storageKey) return;
    if (!enabled || !autosave) return;

    const timeout = window.setTimeout(() => {
      try {
        const payload: QCDraft = {
          reportTitle: liveState.reportTitle || '',
          entries: liveState.entries || {},
          statuses: liveState.statuses || {},
          currentMarkIndex: liveState.currentMarkIndex ?? 0,
          titleConfirmed: !!liveState.titleConfirmed,
          updatedAt: Date.now(),
        };

        window.localStorage.setItem(storageKey, JSON.stringify(payload));
      } catch (e) {
        console.warn('[useQCDraft] failed to save draft', e);
      }
    }, 600); // small debounce – avoids spam writes

    return () => {
      window.clearTimeout(timeout);
    };
  }, [
    storageKey,
    enabled,
    autosave,
    liveState.reportTitle,
    liveState.entries,
    liveState.statuses,
    liveState.currentMarkIndex,
    liveState.titleConfirmed,
  ]);

  const clearDraft = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (!storageKey) return;
    try {
      window.localStorage.removeItem(storageKey);
    } catch (e) {
      console.warn('[useQCDraft] failed to clear draft', e);
    }
    setDraft(null);
  }, [storageKey]);

  return {
    draft,
    hasDraft: !!draft,
    clearDraft,
    storageKey,
  };
}
