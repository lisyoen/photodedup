import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import { HelpView } from "./HelpView";
import { useT } from "./i18n";
import { LANGUAGES } from "./i18n/languages";
import {
  calculateReclaimableBytes,
  formatBytes,
  syncGroupState
} from "./lib/groupState";
import {
  EngineConnectionError,
  createDataSource,
  isElectronRuntime,
  placeholderFor,
  type CleanupStatus,
  type DataSource,
  type GroupListOptions,
  type GroupSortFilter,
  type GroupStatusFilter,
  type Settings,
  type ScanStatus
} from "./lib/api";
import {
  BACKGROUND_SCAN_INTERVAL_OPTIONS,
  loadBackgroundScanIntervalHours,
  loadBackgroundScanLastStartedAt,
  loadThumbnailZoom,
  loadQuickSelectEnabled,
  describeAddScanFolder,
  loadScanFolders,
  loadScanFoldersUpdatedAt,
  normalizeScanFolders,
  removeScanFolder,
  saveBackgroundScanIntervalHours,
  saveBackgroundScanLastStartedAt,
  saveThumbnailZoom,
  saveQuickSelectEnabled,
  saveScanFolders,
  type BackgroundScanIntervalHours,
  type Language
} from "./lib/settings";
import { MOCK_SCAN_ROOT } from "./mocks/scanRoot";
import type { ApplyMode, GroupAction, GroupDetail, Image, ImageMark, SelectionState } from "./types";
import { useGroupShortcuts } from "./useGroupShortcuts";
import { classifiedGroupIds, isClassifiedGroup, markedCount, unclassifiedGroupCount } from "./lib/groupClassification";

const TERMINAL_SCAN_STATES = new Set(["done", "error", "cancelled"]);
const TERMINAL_CLEANUP_STATES = new Set(["done", "error", "cancelled"]);
const CLEANUP_POLL_INTERVAL_MS = 500;
const CLEANUP_TIMEOUT_MS = 120_000;
const INFO_TOAST_TIMEOUT_MS = 2500;
const ERROR_TOAST_TIMEOUT_MS = 5000;
const HOURS_TO_MS = 60 * 60 * 1000;
const SHORTCUT_PRESS_MS = 150;
const THUMBNAIL_ZOOM_STEP = 1.15;

export default function App() {
  const { t } = useT();
  const [dataSourceState] = useState<{
    dataSource: DataSource | null;
    engineConnectionFailed: boolean;
  }>(() => {
    try {
      return { dataSource: createDataSource(), engineConnectionFailed: false };
    } catch (error) {
      if (error instanceof EngineConnectionError) {
        return { dataSource: null, engineConnectionFailed: true };
      }
      throw error;
    }
  });

  if (dataSourceState.engineConnectionFailed || !dataSourceState.dataSource) {
    return <EngineConnectionErrorView message={t("engine.connectionFailed")} />;
  }

  return <AppContent dataSource={dataSourceState.dataSource} />;
}

function AppContent({ dataSource }: { dataSource: DataSource }) {
  const { language, setLanguage, t } = useT();
  const showPreviewBanner = dataSource.kind === "mock" && !isElectronRuntime();
  const [groups, setGroups] = useState<GroupDetail[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const [groupStatusFilter, setGroupStatusFilter] = useState<GroupStatusFilter>("unresolved");
  const [groupSortFilter, setGroupSortFilter] = useState<GroupSortFilter>("savings");
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null);
  const [activeScanId, setActiveScanId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [applyMode, setApplyMode] = useState<ApplyMode>("trash");
  const [scanFolders, setScanFolders] = useState<string[]>(() => loadScanFolders());
  const [backgroundScanIntervalHours, setBackgroundScanIntervalHours] = useState<BackgroundScanIntervalHours>(
    () => loadBackgroundScanIntervalHours()
  );
  const [quickSelectEnabled, setQuickSelectEnabled] = useState(() => loadQuickSelectEnabled());
  const [thumbnailZoom, setThumbnailZoom] = useState(() => loadThumbnailZoom());
  const [scanFolderDraft, setScanFolderDraft] = useState("");
  const [engineSettings, setEngineSettings] = useState<Settings | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [thresholdDraft, setThresholdDraft] = useState(90);
  const [includeOnlineOnlyDraft, setIncludeOnlineOnlyDraft] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [pressedGroupAction, setPressedGroupAction] = useState<GroupAction | null>(null);
  const [selectedImageIds, setSelectedImageIds] = useState<number[]>([]);
  const initialLoadDone = useRef(false);
  const toastTimer = useRef<number | undefined>();
  const shortcutPressTimer = useRef<number | undefined>();
  const groupCardRefs = useRef(new Map<number, HTMLButtonElement>());
  const photoGridRef = useRef<HTMLDivElement | null>(null);
  const applyTriggerButtonRef = useRef<HTMLButtonElement | null>(null);
  const applyConfirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const applyModalRef = useRef<HTMLDivElement | null>(null);
  const settingsModalRef = useRef<HTMLDivElement | null>(null);
  const settingsOpenScanFolders = useRef<string[]>(scanFolders);
  const activeScanIdRef = useRef<string | null>(null);
  const settingsSyncReady = useRef(false);

  const selected = groups.find(({ group }) => group.id === selectedGroupId) ?? groups[0] ?? null;
  const scanRootLabel = scanFolders.length === 0
    ? null
    : scanFolders.length === 1
      ? scanFolders[0]
      : `${scanFolders[0]} ${t("scan.moreFolders", { count: scanFolders.length - 1 })}`;
  const groupsEmptyMessage = scanFolders.length > 0 && groupStatusFilter === "unresolved"
    ? t("groups.emptyUnresolved")
    : t("groups.empty");
  const duplicateFolder = scanFolders.includes(scanFolderDraft.trim());
  const canAddFolder = scanFolderDraft.trim().length > 0 && !duplicateFolder;
  const canSelectSettingsFolders = Boolean(window.shell?.selectFolders);
  const scanRunning = scanStatus ? !TERMINAL_SCAN_STATES.has(scanStatus.status) : false;
  const canReview = selected !== null;
  const groupActionsDisabled = selected === null || busy;
  const selectedImages = selected
    ? selected.images.filter((image) => selectedImageIds.includes(image.id))
    : [];
  const compareImages = useMemo(() => selected ? selectCompareImages(selected, selectedImageIds) : [], [selected, selectedImageIds]);
  const compareSelectionLimited = selectedImageIds.length > 4;
  const applyScope = useMemo(() => {
    const ids = classifiedGroupIds(groups);
    const scopedGroups = groups.filter(({ group }) => ids.includes(group.id));
    const images = scopedGroups.flatMap((group) => group.images);
    const deleteImages = images.filter((image) => image.mark === "delete");
    return {
      groupIds: ids,
      excludedGroupCount: unclassifiedGroupCount(groups),
      deleteCount: deleteImages.length,
      deleteBytes: calculateReclaimableBytes(images),
      groupCount: scopedGroups.filter((group) => group.images.some((image) => image.mark === "delete")).length,
      untouchedCount: images.filter((image) => image.mark !== "delete").length
    };
  }, [groups]);
  const applyDisabled = applyScope.groupIds.length === 0;

  const updateThumbnailZoom = useCallback((updater: (current: number) => number) => {
    setThumbnailZoom((current) => {
      const next = roundZoom(clampThumbnailZoom(updater(current)));
      saveThumbnailZoom(next);
      return next;
    });
  }, []);

  useEffect(() => () => dataSource.disposeThumbs(), [dataSource]);

  useEffect(() => {
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      if (shortcutPressTimer.current) window.clearTimeout(shortcutPressTimer.current);
    };
  }, []);

  function showToast(message: string, options: { error?: boolean } = {}) {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(
      () => setToast(null),
      options.error ? ERROR_TOAST_TIMEOUT_MS : INFO_TOAST_TIMEOUT_MS
    );
  }

  function updateActiveScanId(scanId: string | null) {
    activeScanIdRef.current = scanId;
    setActiveScanId(scanId);
  }

  const startBackgroundScan = useCallback(async (source: "periodic" | "tray") => {
    if (!settingsLoaded) {
      console.info(`background scan skipped: settings not loaded (${source})`);
      return;
    }
    if (scanRunning) {
      console.info(`background scan skipped: scan already running (${source})`);
      return;
    }
    if (scanFolders.length === 0) {
      console.info(`background scan skipped: no scan folders (${source})`);
      return;
    }

    saveBackgroundScanLastStartedAt(Date.now());
    setScanStatus(null);
    try {
      const scan = await dataSource.startScan({ roots: scanFolders });
      updateActiveScanId(scan.scan_id);
      setScanStatus(initialScanStatus(scan));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { error: true });
    }
  }, [dataSource, scanFolders, scanRunning, settingsLoaded]);

  async function handleStartScan() {
    if (scanFolders.length === 0) {
      showToast(t("toast.scanFolderRequired"), { error: true });
      return;
    }

    setBusy(true);
    setToast(null);
    setScanStatus(null);
    saveBackgroundScanLastStartedAt(Date.now());
    try {
      const scan = await dataSource.startScan({ roots: scanFolders });
      updateActiveScanId(scan.scan_id);
      setScanStatus(initialScanStatus(scan));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { error: true });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    try {
      window.localStorage.removeItem("pdd.settings." + "last" + "Root");
    } catch {
      // Ignore storage access failures; the legacy key is not used as state.
    }
  }, []);

  useEffect(() => {
    if (!helpOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setHelpOpen(false);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [helpOpen]);

  useEffect(() => {
    if (!compareOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setCompareOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [compareOpen]);

  useEffect(() => {
    const element = photoGridRef.current;
    if (!element) return;

    function handleWheel(event: globalThis.WheelEvent) {
      if (!event.ctrlKey) return;
      event.preventDefault();
      updateThumbnailZoom((current) => event.deltaY < 0
        ? current * THUMBNAIL_ZOOM_STEP
        : current / THUMBNAIL_ZOOM_STEP
      );
    }

    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, [selected?.group.id, updateThumbnailZoom]);

  useEffect(() => {
    if (!applyOpen) return;
    applyConfirmButtonRef.current?.focus();
  }, [applyOpen]);

  useLayoutEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey && !event.altKey && !event.metaKey) {
        if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") {
          event.preventDefault();
          updateThumbnailZoom((current) => current * THUMBNAIL_ZOOM_STEP);
          return;
        }
        if (event.key === "-" || event.code === "NumpadSubtract") {
          event.preventDefault();
          updateThumbnailZoom((current) => current / THUMBNAIL_ZOOM_STEP);
          return;
        }
        if (event.key === "0" || event.code === "Digit0" || event.code === "Numpad0") {
          event.preventDefault();
          updateThumbnailZoom(() => 1);
          return;
        }
      }

      if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.isComposing || event.repeat) {
        return;
      }
      if (isPrimaryShortcutKey(event)) {
        if (isModalOpenOutsideTarget(event.target, [
          applyOpen ? applyModalRef.current : null,
          settingsOpen ? settingsModalRef.current : null,
        ])) {
          event.preventDefault();
          runPrimaryKeyboardAction();
          return;
        }
        if (isDefaultActionGuardedTarget(event.target)) return;
        event.preventDefault();
        runPrimaryKeyboardAction();
        return;
      }
      if (event.key === "Escape") {
        runCancelKeyboardAction();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    applyDisabled,
    applyOpen,
    compareOpen,
    groupActionsDisabled,
    helpOpen,
    settingsOpen,
    settingsSaving,
    updateThumbnailZoom,
  ]);

  useEffect(() => {
    if (backgroundScanIntervalHours === 0) return;

    let cancelled = false;
    let timer: number | undefined;
    const intervalMs = backgroundScanIntervalHours * HOURS_TO_MS;

    function schedule(delayMs: number) {
      timer = window.setTimeout(() => {
        if (cancelled) return;
        void startBackgroundScan("periodic").finally(() => {
          if (!cancelled) schedule(intervalMs);
        });
      }, delayMs);
    }

    const lastStartedAt = loadBackgroundScanLastStartedAt() ?? Date.now();
    schedule(Math.max(0, lastStartedAt + intervalMs - Date.now()));

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [backgroundScanIntervalHours, startBackgroundScan]);

  useEffect(() => {
    return window.shell?.onTrayScanNow(() => {
      void startBackgroundScan("tray");
    });
  }, [startBackgroundScan]);

  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      try {
        const settings = await dataSource.getSettings();
        if (cancelled) return;
        setEngineSettings(settings);
        setThresholdDraft(settings.threshold);
        setIncludeOnlineOnlyDraft(settings.include_online_only ?? false);
        const storedFolders = loadScanFolders();
        const storedFoldersUpdatedAt = loadScanFoldersUpdatedAt();
        const engineFolders = normalizeScanFolders(settings.scan_folders ?? []);
        const nextFolders = shouldUseStoredScanFolders(storedFolders, storedFoldersUpdatedAt, settings)
          ? storedFolders
          : engineFolders;
        saveScanFolders(nextFolders);
        setScanFolders(nextFolders);
        settingsOpenScanFolders.current = nextFolders;
        settingsSyncReady.current = true;
        if (!sameScanFolders(nextFolders, engineFolders)) {
          const synced = await dataSource.putSettings(buildSettings(settings, nextFolders));
          if (cancelled) return;
          setEngineSettings(synced);
          setIncludeOnlineOnlyDraft(synced.include_online_only ?? false);
        }
      } catch (error) {
        if (!cancelled) showToast(error instanceof Error ? error.message : String(error), { error: true });
      } finally {
        if (!cancelled) setSettingsLoaded(true);
      }
    }

    void loadSettings();

    return () => {
      cancelled = true;
    };
  }, [dataSource]);

  useEffect(() => {
    if (!settingsOpen) return;

    let cancelled = false;

    async function refreshSettings() {
      try {
        const settings = await dataSource.getSettings();
        if (cancelled) return;
        setEngineSettings(settings);
        setThresholdDraft(settings.threshold);
        setIncludeOnlineOnlyDraft(settings.include_online_only ?? false);
      } catch (error) {
        if (!cancelled) showToast(error instanceof Error ? error.message : String(error), { error: true });
      }
    }

    void refreshSettings();

    return () => {
      cancelled = true;
    };
  }, [dataSource, settingsOpen]);

  useEffect(() => {
    if (!settingsLoaded) return;

    let cancelled = false;

    async function loadSavedScanFolders() {
      if (scanFolders.length === 0 && dataSource.kind === "mock") {
        initialLoadDone.current = true;
        setGroups([]);
        setSelectedGroupId(null);
        return;
      }

      setToast(null);

      try {
        if (scanFolders.length === 0) {
          setGroups([]);
          setSelectedGroupId(null);
          initialLoadDone.current = true;
          return;
        }

        const activeRoots = scanFolders;
        if (groupStatusFilter === "unresolved" && groupSortFilter === "savings") {
          const snapshot = await dataSource.loadGroupSnapshot(activeRoots);
          if (!cancelled && snapshot) {
            setGroups(snapshot.items);
            setSelectedGroupId(snapshot.items[0]?.group.id ?? null);
          }
        }

        const details = await loadGroups(dataSource, setGroups, setSelectedGroupId, scanFolders, {
          status: groupStatusFilter,
          sort: groupSortFilter,
        });
        if (cancelled) return;

        if (!initialLoadDone.current && details.length === 0 && scanFolders.length > 0) {
          const health = await dataSource.getHealth();
          if (cancelled) return;
          if (health.images > 0) {
            initialLoadDone.current = true;
            return;
          }
          setBusy(true);
          saveBackgroundScanLastStartedAt(Date.now());
          setScanStatus(null);
          const scan = await dataSource.startScan({ roots: scanFolders });
          if (cancelled) return;
          updateActiveScanId(scan.scan_id);
          setScanStatus(initialScanStatus(scan));
        }

        initialLoadDone.current = true;
      } catch (error) {
        if (!cancelled) showToast(error instanceof Error ? error.message : String(error), { error: true });
      } finally {
        if (!cancelled) setBusy(false);
      }
    }

    void loadSavedScanFolders();

    return () => {
      cancelled = true;
    };
  }, [dataSource, scanFolders, settingsLoaded, groupStatusFilter, groupSortFilter]);

  useEffect(() => {
    if (!activeScanId) return;

    let cancelled = false;
    let timer: number | undefined;

    async function poll() {
      const pollingScanId = activeScanId!;
      try {
        const next = await dataSource.getScan(pollingScanId);
        if (cancelled) return;
        if (activeScanIdRef.current !== pollingScanId) return;
        setScanStatus(next);

        if (next.status === "done") {
          await loadGroups(dataSource, setGroups, setSelectedGroupId, scanFolders, {
            status: groupStatusFilter,
            sort: groupSortFilter,
          });
          updateActiveScanId(null);
          return;
        }

        if (TERMINAL_SCAN_STATES.has(next.status)) {
          updateActiveScanId(null);
          return;
        }

        timer = window.setTimeout(poll, 1000);
      } catch (error) {
        if (!cancelled) {
          showToast(error instanceof Error ? error.message : String(error), { error: true });
          updateActiveScanId(null);
        }
      }
    }

    timer = window.setTimeout(poll, dataSource.kind === "mock" ? 0 : 1000);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [activeScanId, dataSource, scanFolders, groupStatusFilter, groupSortFilter]);

  async function handleSelectFolder() {
    setBusy(true);
    setToast(null);
    try {
      const root = window.shell ? await window.shell.selectFolder() : MOCK_SCAN_ROOT;
      if (!root) return;

      const result = describeAddScanFolder(scanFolders, root);
      if (result.coveredByParent) {
        showToast(t("toast.scanFolderCoveredByParent"));
        return;
      }
      if (!result.added) return;

      const nextScanFolders = result.folders;
      saveScanFolders(nextScanFolders);
      setScanFolders(nextScanFolders);
      setScanStatus(null);
      saveBackgroundScanLastStartedAt(Date.now());
      const scan = await dataSource.startScan({ roots: nextScanFolders });
      updateActiveScanId(scan.scan_id);
      setScanStatus(initialScanStatus(scan));
      if (result.removedChildCount > 0) {
        showToast(t("toast.scanFolderChildrenRemoved", { count: result.removedChildCount }));
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { error: true });
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelScan() {
    if (!activeScanId) return;
    setBusy(true);
    try {
      await dataSource.cancelScan(activeScanId);
      const next = await dataSource.getScan(activeScanId);
      setScanStatus(next);
      updateActiveScanId(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { error: true });
    } finally {
      setBusy(false);
    }
  }

  function updateGroup(groupId: number, images: Image[]) {
    setGroups((current) =>
      current.map((detail) =>
        detail.group.id === groupId
          ? { group: syncGroupState(detail.group, images), images }
          : detail
      )
    );
  }

  async function handleGroupAction(action: GroupAction) {
    if (!selected || groupActionsDisabled) return;
    const groupId = selected.group.id;
    if (selectedImages.length > 0) {
      const previous = selected.images;
      const selectedIdSet = new Set(selectedImages.map((image) => image.id));
      const next = previous.map((image) =>
        selectedIdSet.has(image.id) ? { ...image, mark: markForSelectedAction(image, action) } : image
      );
      updateGroup(groupId, next);

      try {
        const updatedImages = await Promise.all(
          next
            .filter((image) => selectedIdSet.has(image.id))
            .map((image) => dataSource.updateImage(image.id, image.mark))
        );
        const updatedById = new Map(updatedImages.map((image) => [image.id, image]));
        updateGroup(groupId, next.map((image) => updatedById.get(image.id) ?? image));
        advanceAfterGroupAction(groupId);
      } catch (error) {
        updateGroup(groupId, previous);
        showToast(error instanceof Error ? error.message : String(error), { error: true });
      }
      return;
    }

    try {
      const updated = await dataSource.applyGroupAction(groupId, action);
      setGroups((current) => current.map((detail) => detail.group.id === updated.group.id ? updated : detail));
      advanceAfterGroupAction(groupId);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { error: true });
    }
  }

  function advanceAfterGroupAction(groupId: number) {
    if (!quickSelectEnabled) return;
    const currentIndex = groups.findIndex(({ group }) => group.id === groupId);
    if (currentIndex < 0 || currentIndex >= groups.length - 1) return;
    const nextId = groups[currentIndex + 1].group.id;
    setSelectedGroupId(nextId);
    window.requestAnimationFrame(() => {
      groupCardRefs.current.get(nextId)?.scrollIntoView?.({ block: "nearest" });
    });
  }

  const triggerGroupAction = useCallback((action: GroupAction, source: "button" | "shortcut" = "button") => {
    if (source === "shortcut") {
      if (shortcutPressTimer.current) window.clearTimeout(shortcutPressTimer.current);
      setPressedGroupAction(action);
      shortcutPressTimer.current = window.setTimeout(() => setPressedGroupAction(null), SHORTCUT_PRESS_MS);
    }

    void handleGroupAction(action);
  }, [handleGroupAction]);

  function toggleImageSelection(imageId: number) {
    setSelectedImageIds((current) =>
      current.includes(imageId)
        ? current.filter((id) => id !== imageId)
        : [...current, imageId]
    );
  }

  function toggleImageKeepMark(image: Image) {
    void handleImageMark(image.id, image.mark === "keep" ? "none" : "keep");
  }

  function handlePhotoCardClick(event: ReactMouseEvent<HTMLElement>, image: Image) {
    if (event.ctrlKey || event.metaKey) {
      toggleImageSelection(image.id);
      return;
    }

    toggleImageKeepMark(image);
  }

  function handlePhotoCardKeyDown(event: ReactKeyboardEvent<HTMLElement>, image: Image) {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();

    if (event.ctrlKey || event.metaKey) {
      toggleImageSelection(image.id);
      return;
    }

    toggleImageKeepMark(image);
  }

  const navigateGroup = useCallback((direction: "previous" | "next") => {
    if (groups.length === 0) return;
    const currentIndex = Math.max(0, groups.findIndex(({ group }) => group.id === selected?.group.id));
    const nextIndex = direction === "previous" ? currentIndex - 1 : currentIndex + 1;
    if (nextIndex < 0 || nextIndex >= groups.length) return;
    const nextId = groups[nextIndex].group.id;
    setSelectedGroupId(nextId);
    window.requestAnimationFrame(() => {
      groupCardRefs.current.get(nextId)?.scrollIntoView?.({ block: "nearest" });
    });
  }, [groups, selected?.group.id]);

  useGroupShortcuts({
    disabled: groupActionsDisabled,
    modalOpen: applyOpen || settingsOpen || helpOpen || compareOpen,
    onAction: (action) => triggerGroupAction(action, "shortcut"),
    onCompare: () => setCompareOpen(true),
    onNavigate: navigateGroup,
  });

  async function handleImageMark(imageId: number, mark: ImageMark) {
    if (!selected) return;
    const previous = selected.images;
    const next = previous.map((image) => image.id === imageId ? { ...image, mark } : image);
    updateGroup(selected.group.id, next);

    try {
      const image = await dataSource.updateImage(imageId, mark);
      updateGroup(selected.group.id, next.map((item) => item.id === image.id ? image : item));
    } catch (error) {
      updateGroup(selected.group.id, previous);
      showToast(error instanceof Error ? error.message : String(error), { error: true });
    }
  }

  async function handleApplyConfirm() {
    setBusy(true);
    try {
      const started = await dataSource.applyMarkedDeletes(applyMode, applyScope.groupIds);
      const cleanup = await waitForCleanup(dataSource, started.job_id);
      const summary = cleanup.summary ?? {};
      const deleted = Number(summary.deleted ?? applyScope.deleteCount);
      const failed = Number(summary.failed ?? 0);
      const modeLabel = t(applyMode === "trash" ? "apply.mode.trash" : "apply.mode.permanent");
      setApplyOpen(false);
      await loadGroups(dataSource, setGroups, setSelectedGroupId, scanFolders, {
        status: groupStatusFilter,
        sort: groupSortFilter,
      });
      const scopeSummary = t("toast.applyScope", {
        applied: applyScope.groupIds.length,
        excluded: applyScope.excludedGroupCount
      });
      if (deleted + failed === 0) {
        showToast(`${t("toast.applyNoTargets")} ${scopeSummary}`);
      } else {
        showToast(
          `${t("toast.applyComplete", {
            mode: modeLabel,
            count: deleted,
            failed,
            size: formatBytes(applyScope.deleteBytes),
            untouched: applyScope.untouchedCount
          })} ${scopeSummary}`
        );
      }
    } catch (error) {
      await loadGroups(dataSource, setGroups, setSelectedGroupId, scanFolders, {
        status: groupStatusFilter,
        sort: groupSortFilter,
      }).catch(() => undefined);
      setApplyOpen(false);
      showToast(error instanceof Error ? error.message : String(error), { error: true });
    } finally {
      setBusy(false);
    }
  }

  function handleLanguageChange(nextLanguage: Language) {
    setLanguage(nextLanguage);
  }

  function handleBackgroundScanIntervalChange(nextInterval: BackgroundScanIntervalHours) {
    saveBackgroundScanIntervalHours(nextInterval);
    setBackgroundScanIntervalHours(nextInterval);
  }

  function handleQuickSelectChange(enabled: boolean) {
    saveQuickSelectEnabled(enabled);
    setQuickSelectEnabled(enabled);
  }

  function runPrimaryKeyboardAction() {
    if (compareOpen || helpOpen) return;
    if (applyOpen) {
      if (!applyDisabled) void handleApplyConfirm();
      return;
    }
    if (settingsOpen) {
      if (!settingsSaving) void handleSaveSettings();
      return;
    }
    if (!groupActionsDisabled) {
      triggerGroupAction("apply_recommended", "shortcut");
    }
  }

  function runCancelKeyboardAction() {
    if (compareOpen) {
      setCompareOpen(false);
      return;
    }
    if (helpOpen) {
      setHelpOpen(false);
      return;
    }
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    if (applyOpen) {
      closeApplyModal({ restoreFocus: true });
    }
  }

  function closeApplyModal({ restoreFocus }: { restoreFocus: boolean }) {
    setApplyOpen(false);
    if (restoreFocus) {
      applyTriggerButtonRef.current?.focus();
    }
  }

  async function syncScanFolders(nextScanFolders: string[]) {
    if (!settingsSyncReady.current) return;
    const saved = await dataSource.putSettings(buildSettings(engineSettings, nextScanFolders, thresholdDraft, includeOnlineOnlyDraft));
    setEngineSettings(saved);
  }

  function addScanFolderPaths(paths: string[]): boolean {
    let nextScanFolders = scanFolders;
    let removedChildCount = 0;
    let coveredByParent = false;
    let added = false;

    for (const path of paths) {
      const result = describeAddScanFolder(nextScanFolders, path);
      if (result.coveredByParent) {
        coveredByParent = true;
        continue;
      }
      if (!result.added) continue;
      nextScanFolders = result.folders;
      removedChildCount += result.removedChildCount;
      added = true;
    }

    if (coveredByParent) {
      showToast(t("toast.scanFolderCoveredByParent"));
    }
    if (!added) return false;

    saveScanFolders(nextScanFolders);
    setScanFolders(nextScanFolders);
    void syncScanFolders(nextScanFolders).catch((error) => {
      showToast(error instanceof Error ? error.message : String(error), { error: true });
    });
    if (removedChildCount > 0) {
      showToast(t("toast.scanFolderChildrenRemoved", { count: removedChildCount }));
    }
    return true;
  }

  function handleAddScanFolder() {
    if (!addScanFolderPaths([scanFolderDraft])) return;
    setScanFolderDraft("");
  }

  async function handleSelectSettingsFolders() {
    if (!window.shell?.selectFolders) return;
    setSettingsSaving(true);
    setToast(null);
    try {
      const paths = await window.shell.selectFolders();
      addScanFolderPaths(paths);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { error: true });
    } finally {
      setSettingsSaving(false);
    }
  }

  function handleRemoveScanFolder(path: string) {
    setScanFolders((current) => {
      const next = removeScanFolder(current, path);
      saveScanFolders(next);
      void syncScanFolders(next).catch((error) => {
        showToast(error instanceof Error ? error.message : String(error), { error: true });
      });
      return next;
    });
  }

  async function handleSaveSettings() {
    const previousThreshold = engineSettings?.threshold ?? 90;
    const rootsChanged = !sameScanFolders(settingsOpenScanFolders.current, scanFolders);
    const nextSettings = buildSettings(engineSettings, scanFolders, thresholdDraft, includeOnlineOnlyDraft);

    setSettingsSaving(true);
    setToast(null);
    try {
      const saved = await dataSource.putSettings(nextSettings);
      setEngineSettings(saved);
      setThresholdDraft(saved.threshold);
      setIncludeOnlineOnlyDraft(saved.include_online_only ?? false);
      setSettingsOpen(false);

      if ((saved.threshold !== previousThreshold || rootsChanged) && scanFolders.length > 0) {
        if (scanRunning && activeScanId) {
          try {
            await dataSource.cancelScan(activeScanId);
          } catch (error) {
            console.warn("scan cancel before rescan failed", error);
          }
        }

        setScanStatus(null);
        saveBackgroundScanLastStartedAt(Date.now());
        const scan = await dataSource.startScan({ roots: scanFolders });
        updateActiveScanId(scan.scan_id);
        setScanStatus(initialScanStatus(scan));
        showToast(t("toast.rescanStarted"));
      } else {
        showToast(t("toast.settingsSaved"));
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { error: true });
    } finally {
      setSettingsSaving(false);
    }
  }

  return (
    <main className="app-shell">
      {showPreviewBanner && (
        <div className="preview-banner" role="status">
          {t("preview.mockBanner")}
        </div>
      )}
      <nav className="topbar">
        <div>
          <p className="eyebrow">{t("app.product")} · {dataSource.kind === "http" ? "Sidecar" : "Mock"}</p>
          <h1>{t("app.title")}</h1>
        </div>
        <div className="topbar-actions">
          <button className="folder-button" onClick={handleSelectFolder} disabled={busy || scanRunning}>
            {t("app.selectFolder")}
          </button>
              <button
                className="icon-button"
                onClick={() => {
                  settingsOpenScanFolders.current = scanFolders;
                  setSettingsOpen(true);
                }}
                aria-label={t("settings.open")}
            title={t("settings.open")}
          >
            ⚙
          </button>
          <button
            className="icon-button"
            onClick={() => setHelpOpen(true)}
            aria-label={t("help.open")}
            title={t("help.open")}
          >
            ?
          </button>
          <button
            ref={applyTriggerButtonRef}
            className="apply-button"
            onClick={() => setApplyOpen(true)}
            disabled={applyDisabled}
          >
            {t("app.applyAll")} <span>{applyScope.groupIds.length}</span>
          </button>
        </div>
      </nav>

      <ScanPanel
        rootLabel={scanRootLabel}
        status={scanStatus}
        busy={busy}
        canStart={scanFolders.length > 0}
        running={scanRunning}
        onStart={handleStartScan}
        onCancel={handleCancelScan}
        t={t}
      />

      <section className="review-layout">
        <aside className="group-list" aria-label={t("groups.label")}>
          <div className="filters">
            <select
              aria-label={t("filters.status")}
              value={groupStatusFilter}
              onChange={(event) => setGroupStatusFilter(event.currentTarget.value as GroupStatusFilter)}
            >
              <option value="unresolved">{t("filters.status.unresolved")}</option>
              <option value="processed">{t("filters.status.processed")}</option>
              <option value="all">{t("filters.status.all")}</option>
            </select>
            <select
              aria-label={t("filters.sort")}
              value={groupSortFilter}
              onChange={(event) => setGroupSortFilter(event.currentTarget.value as GroupSortFilter)}
            >
              <option value="savings">{t("filters.sort.savings")}</option>
              <option value="similarity">{t("filters.sort.similarity")}</option>
              <option value="quality">{t("filters.sort.quality")}</option>
            </select>
          </div>
          {groups.length === 0 ? (
            <p className="empty-note">{groupsEmptyMessage}</p>
          ) : groups.map((detail) => (
            <button
              key={detail.group.id}
              ref={(element) => {
                if (element) groupCardRefs.current.set(detail.group.id, element);
                else groupCardRefs.current.delete(detail.group.id);
              }}
              className={`group-card ${detail.group.id === selected?.group.id ? "active" : ""} ${isClassifiedGroup(detail) ? "classified" : ""}`}
              onClick={() => setSelectedGroupId(detail.group.id)}
            >
              <GroupCover dataSource={dataSource} detail={detail} />
              <span className="group-title">#{detail.group.id}</span>
              <span>{t("groups.photoCount", { count: detail.group.member_count })}</span>
              <span className="group-mark-count">{markedCount(detail.images)}/{detail.images.length}</span>
              {isClassifiedGroup(detail) && <span className="group-complete-badge">{t("groups.classified")}</span>}
              <strong>{formatBytes(calculateReclaimableBytes(detail.images))}</strong>
            </button>
          ))}
        </aside>

        <section className="detail-pane">
          {selected ? (
            <>
              <header className="group-header">
                <div>
                  <p className="eyebrow">{t("group.title", { id: selected.group.id })}</p>
                  <h2>
                    {t("group.summary", {
                      count: selected.group.member_count,
                      similarity: selected.group.max_similarity?.toFixed(1) ?? "-",
                      size: formatBytes(calculateReclaimableBytes(selected.images))
                    })}
                  </h2>
                  <p className="derived">
                    {t("group.derived", { state: stateLabel(selected.group.selection_state, t) })}
                  </p>
                </div>
                <div className="actions">
                  <ActionButton
                    active={selected.group.selection_state === "recommended_applied"}
                    disabled={groupActionsDisabled}
                    label={`👍 ${t("action.applyRecommended")}`}
                    shortcut="A"
                    shortcutPressed={pressedGroupAction === "apply_recommended"}
                    onClick={() => triggerGroupAction("apply_recommended")}
                  />
                  <ActionButton
                    active={selected.group.selection_state === "keep_all"}
                    disabled={groupActionsDisabled}
                    label={`🔒 ${t("action.keepAll")}`}
                    shortcut="S"
                    shortcutPressed={pressedGroupAction === "keep_all"}
                    onClick={() => triggerGroupAction("keep_all")}
                  />
                  <ActionButton
                    active={selected.group.selection_state === "delete_all"}
                    disabled={groupActionsDisabled}
                    label={`🗑 ${t("action.deleteAll")}`}
                    shortcut="D"
                    shortcutPressed={pressedGroupAction === "delete_all"}
                    onClick={() => triggerGroupAction("delete_all")}
                  />
                  <ActionButton
                    active={compareOpen}
                    disabled={groupActionsDisabled}
                    label={t("compare.open")}
                    shortcut="C"
                    shortcutPressed={false}
                    onClick={() => setCompareOpen(true)}
                  />
                </div>
              </header>

              <div
                className="photo-grid"
                ref={photoGridRef}
                style={{ "--thumbnail-zoom": thumbnailZoom } as CSSProperties}
              >
                {selected.images.map((image) => (
                  <article
                    className={`photo-card ${selectedImageIds.includes(image.id) ? "selected" : ""}`}
                    key={image.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selectedImageIds.includes(image.id)}
                    onClick={(event) => handlePhotoCardClick(event, image)}
                    onKeyDown={(event) => handlePhotoCardKeyDown(event, image)}
                  >
                    <PhotoImage dataSource={dataSource} image={image} />
                    <div className="photo-meta">
                      <div>
                        <strong>{fileName(image.path)}</strong>
                        <span>{image.width}x{image.height} · {formatBytes(image.size_bytes)}</span>
                        <span>{t("photo.quality", { score: image.quality_score?.toFixed(1) ?? "-" })}</span>
                      </div>
                      {image.recommended_keep && <b>{t("photo.recommended")}</b>}
                    </div>
                    <div className="mark-row" aria-label={t("mark.aria", { fileName: fileName(image.path) })}>
                      <MarkBox
                        checked={image.mark === "keep"}
                        icon="🔒"
                        label={t("mark.keep")}
                        onChange={() => void handleImageMark(image.id, image.mark === "keep" ? "none" : "keep")}
                      />
                      <MarkBox
                        checked={image.mark === "delete"}
                        icon="🗑"
                        label={t("mark.delete")}
                        onChange={() => void handleImageMark(image.id, image.mark === "delete" ? "none" : "delete")}
                      />
                      <span className={`mark-chip ${image.mark}`}>{t(markKey(image.mark))}</span>
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <div className="empty-review">{t("groups.noneLoaded")}</div>
          )}
        </section>
      </section>

      {compareOpen && selected && (
        <CompareModal
          dataSource={dataSource}
          images={compareImages}
          limited={compareSelectionLimited}
          t={t}
          onClose={() => setCompareOpen(false)}
          onMark={(imageId, mark) => void handleImageMark(imageId, mark)}
        />
      )}

      {applyOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="apply-title">
          <div className="modal" ref={applyModalRef}>
            <h2 id="apply-title">{t("apply.title")}</h2>
            <dl className="summary">
              <div><dt>{t("apply.deleteMarkedPhotos")}</dt><dd>{applyScope.deleteCount}</dd></div>
              <div><dt>{t("apply.groupsAffected")}</dt><dd>{applyScope.groupCount}</dd></div>
              <div><dt>{t("apply.excludedGroups")}</dt><dd>{applyScope.excludedGroupCount}</dd></div>
              <div><dt>{t("apply.estimatedSavings")}</dt><dd>{formatBytes(applyScope.deleteBytes)}</dd></div>
            </dl>
            <fieldset>
              <legend>{t("apply.mode")}</legend>
              <label>
                <input
                  type="radio"
                  checked={applyMode === "trash"}
                  onChange={() => setApplyMode("trash")}
                />
                {t("apply.mode.trash")}
              </label>
              <label>
                <input
                  type="radio"
                  checked={applyMode === "permanent"}
                  onChange={() => setApplyMode("permanent")}
                />
                {t("apply.mode.permanent")}
              </label>
            </fieldset>
            <p>{t("apply.note")}</p>
            <div className="modal-actions">
              <button onClick={() => closeApplyModal({ restoreFocus: true })}>{t("common.cancel")}</button>
              <button
                ref={applyConfirmButtonRef}
                className="danger"
                onClick={() => void handleApplyConfirm()}
                disabled={applyDisabled}
              >
                {t("app.applyAll")}
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div className="modal settings-modal" ref={settingsModalRef}>
            <h2 id="settings-title">{t("settings.title")}</h2>
            <fieldset>
              <legend>{t("settings.language")}</legend>
              {LANGUAGES.map(({ code, label }) => (
                <label key={code}>
                  <input
                    type="radio"
                    name="language"
                    checked={language === code}
                    onChange={() => handleLanguageChange(code)}
                  />
                  {label}
                  {code === "en" ? ` (${t("settings.language.default")})` : ""}
                </label>
              ))}
            </fieldset>

            <section className="settings-section" aria-labelledby="background-scan-interval-title">
              <h3 id="background-scan-interval-title">{t("settings.backgroundScanInterval")}</h3>
              <select
                aria-label={t("settings.backgroundScanInterval")}
                value={backgroundScanIntervalHours}
                onChange={(event) => {
                  handleBackgroundScanIntervalChange(Number(event.currentTarget.value) as BackgroundScanIntervalHours);
                }}
              >
                {BACKGROUND_SCAN_INTERVAL_OPTIONS.map((hours) => (
                  <option key={hours} value={hours}>
                    {t(`settings.backgroundScanInterval.${hours}` as const)}
                  </option>
                ))}
              </select>
            </section>

            <section className="settings-section" aria-labelledby="quick-select-title">
              <h3 id="quick-select-title">{t("settings.quickSelect")}</h3>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={quickSelectEnabled}
                  onChange={(event) => handleQuickSelectChange(event.currentTarget.checked)}
                />
                <span>{t("settings.quickSelectHelp")}</span>
              </label>
            </section>

            <section className="settings-section" aria-labelledby="include-online-only-title">
              <h3 id="include-online-only-title">{t("settings.includeOnlineOnly")}</h3>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={includeOnlineOnlyDraft}
                  onChange={(event) => setIncludeOnlineOnlyDraft(event.currentTarget.checked)}
                />
                <span>{t("settings.includeOnlineOnlyHelp")}</span>
              </label>
              <p className="settings-note">{t("settings.includeOnlineOnlyWarning")}</p>
            </section>

            <section className="settings-section" aria-labelledby="scan-folders-title">
              <h3 id="scan-folders-title">{t("settings.scanFolders")}</h3>
              <div className="folder-add-row">
                <input
                  aria-label={t("settings.scanFolderInput")}
                  value={scanFolderDraft}
                  placeholder={t("settings.scanFolderPlaceholder")}
                  onChange={(event) => setScanFolderDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && canAddFolder) handleAddScanFolder();
                  }}
                />
                <button
                  onClick={handleAddScanFolder}
                  disabled={!canAddFolder}
                  aria-label={t("settings.addFolder")}
                >
                  {t("common.add")}
                </button>
                {canSelectSettingsFolders && (
                  <button
                    onClick={() => void handleSelectSettingsFolders()}
                    disabled={settingsSaving}
                    aria-label={t("settings.selectFolders")}
                  >
                    {t("settings.selectFolders")}
                  </button>
                )}
              </div>
              {scanFolders.length === 0 ? (
                <p className="empty-note">{t("settings.scanFolders.empty")}</p>
              ) : (
                <ul className="folder-list">
                  {scanFolders.map((path) => (
                    <li key={path}>
                      <span>{path}</span>
                      <button
                        onClick={() => handleRemoveScanFolder(path)}
                        aria-label={t("settings.removeFolder", { path })}
                      >
                        {t("common.remove")}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="settings-section" aria-labelledby="similarity-threshold-title">
              <div className="settings-section-header">
                <h3 id="similarity-threshold-title">{t("settings.similarityThreshold")}</h3>
                <strong>{thresholdDraft}</strong>
              </div>
              <label className="range-row">
                <span>{t("settings.similarityThreshold")}</span>
                <input
                  type="range"
                  min="70"
                  max="100"
                  step="1"
                  value={thresholdDraft}
                  aria-label={t("settings.similarityThreshold")}
                  onChange={(event) => setThresholdDraft(Number(event.currentTarget.value))}
                />
              </label>
              <p className="settings-note">{t("settings.similarityThresholdHelp")}</p>
            </section>

            <p className="settings-note">{t("settings.savedImmediately")}</p>
            <div className="modal-actions">
              <button onClick={() => void handleSaveSettings()} disabled={settingsSaving}>
                {t("settings.save")}
              </button>
              <button onClick={() => setSettingsOpen(false)}>{t("common.close")}</button>
            </div>
          </div>
        </div>
      )}

      {helpOpen && <HelpView onClose={() => setHelpOpen(false)} />}

      {toast && (
        <button className="toast" onClick={() => setToast(null)}>
          {toast}
        </button>
      )}
    </main>
  );
}

function EngineConnectionErrorView({ message }: { message: string }) {
  return (
    <main className="engine-error-view" role="alert">
      <section>
        <p className="eyebrow">Photo Dedup Desktop</p>
        <h1>{message}</h1>
      </section>
    </main>
  );
}

async function loadGroups(
  dataSource: DataSource,
  setGroups: (groups: GroupDetail[]) => void,
  setSelectedGroupId: (id: number | null) => void,
  roots: string[],
  options: GroupListOptions
) {
  if (roots.length === 0) {
    setGroups([]);
    setSelectedGroupId(null);
    return [];
  }
  const groupList = await dataSource.listGroupDetails(roots, options);
  const details = groupList.items;
  setGroups(details);
  setSelectedGroupId(details[0]?.group.id ?? null);
  return details;
}

async function waitForCleanup(dataSource: DataSource, jobId: string): Promise<CleanupStatus> {
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const cleanup = await dataSource.getCleanup(jobId);
    if (TERMINAL_CLEANUP_STATES.has(cleanup.status)) {
      if (cleanup.status === "error") {
        throw new Error(cleanup.error ?? String(cleanup.summary?.error ?? "Cleanup job failed"));
      }
      if (cleanup.status !== "done") {
        throw new Error(`Cleanup job ended with status: ${cleanup.status}`);
      }
      return cleanup;
    }
    await delay(CLEANUP_POLL_INTERVAL_MS);
  }

  throw new Error("Cleanup job timed out");
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function initialScanStatus(scan: { scan_id: string; status: ScanStatus["status"] }): ScanStatus {
  return {
    scan_id: scan.scan_id,
    status: scan.status,
    phase: scan.status === "done" ? "done" : "collecting",
    done: 0,
    total: 0,
    cancellable: scan.status !== "done",
  };
}

function ScanPanel({
  rootLabel,
  status,
  busy,
  canStart,
  running,
  onStart,
  onCancel,
  t,
}: {
  rootLabel: string | null;
  status: ScanStatus | null;
  busy: boolean;
  canStart: boolean;
  running: boolean;
  onStart: () => void;
  onCancel: () => void;
  t: ReturnType<typeof useT>["t"];
}) {
  const progress = status && status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;
  const statusLabel = status ? scanStatusLabel(status, t) : null;
  return (
    <section className="scan-panel">
      <div>
        <p className="eyebrow">{t("scan.title")}</p>
        <strong>{rootLabel ?? t("scan.noFolder")}</strong>
        {statusLabel && <span>{statusLabel}</span>}
      </div>
      <div className="scan-progress" aria-label={t("scan.progress")}>
        <span style={{ width: `${progress}%` }} />
      </div>
      {running && status?.cancellable ? (
        <button onClick={onCancel} disabled={busy}>{t("scan.cancel")}</button>
      ) : (
        <button onClick={onStart} disabled={busy || !canStart} title={!canStart ? t("scan.noFolder") : undefined}>
          {t("scan.start")}
        </button>
      )}
    </section>
  );
}

function scanStatusLabel(status: ScanStatus, t: ReturnType<typeof useT>["t"]) {
  const statusText = status.status === "cancel_requested" ? t("scan.status.cancelRequested") : status.status;
  const skippedText = scanSkippedSummary(status, t);
  if (status.phase === "collecting") {
    return `${t("scan.phase.collecting", { count: status.done })}${skippedText} · ${statusText}`;
  }

  return `${status.phase} · ${status.done}/${status.total}${skippedText} · ${statusText}`;
}

function scanSkippedSummary(status: ScanStatus, t: ReturnType<typeof useT>["t"]) {
  const skipped = status.skipped ?? {};
  const parts = [
    skipped.cloud_placeholders ? t("scan.skipped.cloudPlaceholders", { count: skipped.cloud_placeholders }) : null,
    skipped.reparse_dirs ? t("scan.skipped.reparseDirs", { count: skipped.reparse_dirs }) : null,
    skipped.unreadable ? t("scan.skipped.unreadable", { count: skipped.unreadable }) : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

function sameScanFolders(left: string[], right: string[]) {
  return left.length === right.length && left.every((folder, index) => folder === right[index]);
}

function buildSettings(
  settings: Settings | null,
  scanFolders: string[],
  threshold = settings?.threshold ?? 90,
  includeOnlineOnly = settings?.include_online_only ?? false
): Settings {
  return {
    threshold,
    recursive: settings?.recursive ?? true,
    extensions: settings?.extensions ?? ["jpg", "jpeg", "png", "heic", "webp"],
    cleanup_mode: settings?.cleanup_mode ?? "trash",
    scan_folders: scanFolders,
    scan_folders_updated_at: new Date().toISOString(),
    include_online_only: includeOnlineOnly,
  };
}

function shouldUseStoredScanFolders(
  storedFolders: string[],
  storedUpdatedAt: string | null,
  settings: Settings
): boolean {
  const engineFolders = normalizeScanFolders(settings.scan_folders ?? []);
  if (storedFolders.length === 0) return false;
  if (engineFolders.length === 0) return true;

  const storedTime = parseSettingsTime(storedUpdatedAt);
  const engineTime = parseSettingsTime(settings.scan_folders_updated_at ?? null);
  if (storedTime !== null && engineTime !== null) return storedTime > engineTime;
  if (storedTime !== null && engineTime === null) return true;
  return false;
}

function parseSettingsTime(value: string | null): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function clampThumbnailZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(3, Math.max(0.5, zoom));
}

function roundZoom(zoom: number): number {
  return Math.round(zoom * 10_000) / 10_000;
}

function isPrimaryShortcutKey(event: KeyboardEvent): boolean {
  return event.key === "Enter" || event.key === " " || event.code === "Space";
}

function isDefaultActionGuardedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".photo-card, .compare-tile, .mark-box")) return true;

  const tagName = target.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    tagName === "button" ||
    target.isContentEditable
  );
}

function isModalOpenOutsideTarget(target: EventTarget | null, modals: Array<HTMLElement | null>): boolean {
  const openModals = modals.filter((modal): modal is HTMLElement => modal !== null);
  if (openModals.length === 0) return false;
  if (!(target instanceof Node)) return true;

  return openModals.every((modal) => !modal.contains(target));
}

function PhotoImage({ dataSource, image }: { dataSource: DataSource; image: Image }) {
  const [src, setSrc] = useState(() => dataSource.kind === "mock" ? placeholderFor(image) : "");

  useEffect(() => {
    let cancelled = false;
    setSrc(dataSource.kind === "mock" ? placeholderFor(image) : "");
    dataSource.loadThumbSrc(image)
      .then((next) => {
        if (!cancelled) setSrc(next);
      })
      .catch(() => {
        if (!cancelled) setSrc(placeholderFor(image));
      });
    return () => {
      cancelled = true;
    };
  }, [dataSource, image]);

  return <img src={src || placeholderFor(image)} alt="" />;
}

function CompareModal({
  dataSource,
  images,
  limited,
  t,
  onClose,
  onMark,
}: {
  dataSource: DataSource;
  images: Image[];
  limited: boolean;
  t: ReturnType<typeof useT>["t"];
  onClose: () => void;
  onMark: (imageId: number, mark: ImageMark) => void;
}) {
  return (
    <div className="modal-backdrop compare-backdrop" role="dialog" aria-modal="true" aria-labelledby="compare-title" onClick={onClose}>
      <article className="modal compare-modal" onClick={(event) => event.stopPropagation()}>
        <header className="compare-header">
          <div>
            <h2 id="compare-title">{t("compare.title")}</h2>
            {limited && <p>{t("compare.limited")}</p>}
          </div>
          <button className="icon-button" type="button" aria-label={t("compare.close")} onClick={onClose}>×</button>
        </header>
        <div className={`compare-grid count-${images.length}`}>
          {images.map((image) => (
            <CompareTile
              key={image.id}
              dataSource={dataSource}
              image={image}
              t={t}
              onMark={onMark}
            />
          ))}
        </div>
      </article>
    </div>
  );
}

function CompareTile({
  dataSource,
  image,
  t,
  onMark,
}: {
  dataSource: DataSource;
  image: Image;
  t: ReturnType<typeof useT>["t"];
  onMark: (imageId: number, mark: ImageMark) => void;
}) {
  const [src, setSrc] = useState(() => dataSource.kind === "mock" ? placeholderFor(image) : "");

  useEffect(() => {
    let cancelled = false;
    setSrc(dataSource.kind === "mock" ? placeholderFor(image) : "");
    dataSource.loadFullSrc(image)
      .then((next) => {
        if (!cancelled) setSrc(next);
      })
      .catch(() => {
        if (!cancelled) setSrc(placeholderFor(image));
      });
    return () => {
      cancelled = true;
    };
  }, [dataSource, image]);

  return (
    <article className={`compare-tile mark-${image.mark}`} onClick={() => onMark(image.id, nextMark(image.mark))}>
      <div className="compare-image">
        <img src={src || placeholderFor(image)} alt="" />
      </div>
      <div className="compare-meta">
        <strong title={image.path}>{fileName(image.path)}</strong>
        <span>{formatDimensions(image)} · {formatBytes(image.size_bytes)}</span>
        <span>{t("compare.date", { date: formatImageDate(image) })}</span>
        <span>{t("compare.similarity", { similarity: formatSimilarity(image) })}</span>
        <span className={`mark-chip ${image.mark}`}>{t(markKey(image.mark))}</span>
      </div>
      <div className="mark-row" aria-label={t("mark.aria", { fileName: fileName(image.path) })}>
        <MarkBox
          checked={image.mark === "keep"}
          icon="🔒"
          label={t("mark.keep")}
          onChange={() => onMark(image.id, image.mark === "keep" ? "none" : "keep")}
        />
        <MarkBox
          checked={image.mark === "delete"}
          icon="🗑"
          label={t("mark.delete")}
          onChange={() => onMark(image.id, image.mark === "delete" ? "none" : "delete")}
        />
      </div>
    </article>
  );
}

function GroupCover({ dataSource, detail }: { dataSource: DataSource; detail: GroupDetail }) {
  const coverId = detail.group.cover_image_id ?? detail.group.thumbnail_image_id ?? detail.images[0]?.id ?? null;
  const image = detail.images.find((item) => item.id === coverId) ?? detail.images[0] ?? null;
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setSrc("");
    if (!image) {
      setFailed(true);
      return () => {
        cancelled = true;
      };
    }
    dataSource.loadThumbSrc(image)
      .then((next) => {
        if (!cancelled) setSrc(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [dataSource, image]);

  return (
    <span className="group-cover" aria-hidden="true">
      {!failed && src ? <img src={src} alt="" /> : <span>{image ? fileName(image.path).slice(0, 2).toUpperCase() : `#${detail.group.id}`}</span>}
    </span>
  );
}

function ActionButton({
  active,
  disabled,
  label,
  shortcut,
  shortcutPressed,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  label: string;
  shortcut: string;
  shortcutPressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`${active ? "active" : ""} ${shortcutPressed ? "shortcut-pressed" : ""}`.trim()}
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      disabled={disabled}
    >
      <span>{label}</span>
      <span className="key-hint" aria-hidden="true">{shortcut}</span>
    </button>
  );
}

function MarkBox({
  checked,
  icon,
  label,
  onChange
}: {
  checked: boolean;
  icon: string;
  label: string;
  onChange: () => void;
}) {
  return (
    <label className="mark-box" onClick={(event) => event.stopPropagation()}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{icon}</span>
      <em>{label}</em>
    </label>
  );
}

function fileName(path: string): string {
  return path.split("\\").pop() ?? path.split("/").pop() ?? path;
}

function selectCompareImages(detail: GroupDetail, selectedImageIds: number[]): Image[] {
  if (selectedImageIds.length >= 2) {
    const byId = new Map(detail.images.map((image) => [image.id, image]));
    return selectedImageIds
      .map((id) => byId.get(id))
      .filter((image): image is Image => Boolean(image))
      .slice(0, 4);
  }

  const recommended = detail.images.find((image) => image.recommended_keep) ?? detail.images[0];
  if (!recommended) return [];
  const next = detail.images
    .filter((image) => image.id !== recommended.id)
    .sort((left, right) =>
      (right.similarity_to_recommended ?? -1) - (left.similarity_to_recommended ?? -1) ||
      (right.quality_score ?? -1) - (left.quality_score ?? -1) ||
      left.id - right.id
    )[0];

  return [recommended, next].filter((image): image is Image => Boolean(image));
}

function nextMark(mark: ImageMark): ImageMark {
  if (mark === "none") return "keep";
  if (mark === "keep") return "delete";
  return "none";
}

function formatDimensions(image: Image): string {
  return image.width && image.height ? `${image.width}x${image.height}` : "-";
}

function formatImageDate(image: Image): string {
  if (!image.taken_at) return "-";
  const date = new Date(image.taken_at);
  if (!Number.isFinite(date.getTime())) return image.taken_at;
  return date.toLocaleString();
}

function formatSimilarity(image: Image): string {
  return image.similarity_to_recommended === null || image.similarity_to_recommended === undefined
    ? "-"
    : `${image.similarity_to_recommended.toFixed(1)}%`;
}

function markKey(mark: ImageMark) {
  return `mark.${mark}` as const;
}

function markForSelectedAction(image: Image, action: GroupAction): ImageMark {
  if (action === "keep_all") return "keep";
  if (action === "delete_all") return "delete";
  return image.recommended_keep ? "keep" : "delete";
}

function stateLabel(state: SelectionState, t: ReturnType<typeof useT>["t"]): string {
  return t(`group.state.${state}` as const);
}
