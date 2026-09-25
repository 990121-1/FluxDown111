/**
 * FluxDown 页面内 UI — 悬浮圆点 + 资源面板
 *
 * - 默认停靠右侧边缘，半隐藏，hover 露出
 * - 自由拖拽（X+Y），松手后平滑吸附到最近的左/右边缘
 * - 面板方向随停靠侧自动切换
 *
 * 【定位策略】圆点统一用 `left` 定位，不用 `right`，
 *  避免拖拽时 left/right 冲突、CSS 无法跨属性过渡。
 *  右侧停靠 = left: calc(100% - Npx)
 */

import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import type { DetectedResource, ResourceType, ConfidenceLevel, TrackPairGroup } from '@/utils/resource-types';
import {
  extractExtension,
  formatFileSize,
  groupTrackPairs,
  isExplicitStreamManifestUrl,
  normalizeUrlForDedup,
} from '@/utils/resource-types';
import type { DashManifest } from '@/utils/dash-manifest';
import { detectTrackKind } from '@/utils/track-detector';
import type { DashManifestEntry, MediaCandidate, MediaCandidateVariant } from '@/utils/media-candidates';
import {
  buildMediaCandidates,
  candidateFilename,
  defaultCandidateVariant,
  isMediaCandidateVisible,
  qualityFrameRateLabel,
  qualityResolutionLabel,
  selectQualityVideoTracks,
} from '@/utils/media-candidates';
import {
  buildResourceDebugLog,
  stringifyResourceDebugLog,
} from '@/utils/resource-debug-log';
import type { MessageKey } from '@/utils/locales/zh-CN';
import { initI18n, setLocale, t } from '@/utils/i18n';
import { loadSettings } from '@/utils/settings';
import type { ResolvedPreviewVariant } from '@/utils/native-messaging';
import './style.css';

/* ===== 常量 ===== */
interface TabDef { key: 'all' | ResourceType; i18nKey: MessageKey }

/**
 * 选轨小窗展示用的清晰度选项（UI 视图模型，脱离 DetectedResource 的必填字段约束，
 * 因为权威 manifest 轨道来自解析而非嗅探，没有 confidence/tabId 等资源存储专属字段）。
 */
interface QualityOption {
  quality: string;
  videoUrl: string;
  audioUrl?: string;
  /** 预格式化的大小/码率文本；真实大小用 formatFileSize，未知大小时显示码率，绝不伪造 */
  sizeLabel: string;
  /** 轨道构成标注，如 "视频轨" / "视频轨 + 音频轨" */
  kindLabel: string;
  filename: string;
  mimeType?: string;
  fileSize?: number;
}
const TABS: TabDef[] = [
  { key: 'all', i18nKey: 'panel.tabAll' },
  { key: 'video', i18nKey: 'panel.tabVideo' },
  { key: 'audio', i18nKey: 'panel.tabAudio' },
  { key: 'document', i18nKey: 'panel.tabDocs' },
  { key: 'archive', i18nKey: 'panel.tabArchive' },
  { key: 'stream', i18nKey: 'panel.tabStream' },
  { key: 'subtitle', i18nKey: 'panel.tabSubtitle' },
  { key: 'magnet', i18nKey: 'panel.tabMagnet' },
  { key: 'other', i18nKey: 'panel.tabOther' },
];

const SVG_DOWNLOAD = '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>';
const SVG_CLOSE = '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>';
const SVG_LOGO = '<path d="M12 3v11M8 10l4 4 4-4"/><path d="M5 17h14"/>';
const SVG_EMPTY = '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>';
const SVG_EYE_OFF = '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/>';
const SVG_TRASH = '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>';

const STORAGE_KEY = 'fluxdown_dot_pos';
const DOT_VISIBLE_KEY = 'fluxdown_dot_visible';
/** popup 主题存储键（与 popup/main.ts 共用），值：'light' | 'dark' | 'system'。 */
const THEME_KEY = 'theme';

function svg(inner: string, cls = ''): string {
  return `<svg viewBox="0 0 24 24"${cls ? ` class="${cls}"` : ''} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

export default defineContentScript({
  matches: ['<all_urls>'],
  cssInjectionMode: 'ui',

  async main(ctx) {
    console.log('[FluxDown UI] starting');

    /* ========== i18n 初始化 ========== */
    await initI18n();

    /* ========== 状态 ========== */
    let resources: DetectedResource[] = [];
    let resourceVersion = 0;
    let manifestVersion = 0;
    let resolverVersion = 0;
    let resolverPreviewHref = '';
    let resolverPreviewName = '';
    let resolverPreviewVariants: ResolvedPreviewVariant[] = [];
    let resolverPreviewTimer: number | null = null;
    let candidateCache: {
      resourceVersion: number;
      manifestVersion: number;
      resolverVersion: number;
      candidates: MediaCandidate[];
    } | null = null;
    let activeTab: string = 'all';
    const selectedIds = new Set<string>();
    interface ContentResourceRow {
      id: string;
      item: DetectedResource | MediaCandidate;
      variant?: MediaCandidateVariant;
    }
    function isContentMediaCandidate(
      item: DetectedResource | MediaCandidate,
    ): item is MediaCandidate {
      return 'downloadable' in item;
    }
    function contentResourceRowId(
      item: DetectedResource | MediaCandidate,
      variant?: MediaCandidateVariant,
    ): string {
      // Representation ids are not guaranteed to be unique in real DASH
      // manifests, so include the source URL in the row key.
      return variant ? `${item.id}::${variant.id}::${variant.videoUrl}` : item.id;
    }
    /** 曾预览失败（video/img/audio error）的资源 id：仅做视觉标记，不自动隐藏
     * ——预览失败常见于 CORS，下载走引擎带 cookie/headers 仍可能成功，
     * 对标 cat-catch：默认全显示，用户手动点「清理」才过滤。 */
    const previewFailedIds = new Set<string>();
    /** 用户手动「清理预览失败项」后从展示中排除的资源 id（纯前端视图过滤，不动 store）。 */
    const dismissedIds = new Set<string>();
    let panelOpen = false;
    let side: 'left' | 'right' = 'right';
    let showFloatingButtonSetting = true;
    let showResourcePanelSetting = true;
    let autoPanelPageHref = location.href;
    let showSecondaryMedia = false;
    let playbackSignature = '';

    /* ========== DOM 引用 ========== */
    let dotEl: HTMLElement;
    let badgeEl: HTMLElement;
    let panelEl: HTMLElement;
    let tabsEl: HTMLElement;
    let listEl: HTMLElement;
    let countEl: HTMLElement;
    let selectAllEl: HTMLInputElement;
    let batchCountEl: HTMLElement;
    let batchBtnEl: HTMLButtonElement;
    let clearFailedBtnEl: HTMLButtonElement;
    let exportDebugBtnEl: HTMLButtonElement | undefined;
    let selectAllText: Text;
    let floatBtnEl: HTMLElement;
    let qualityPickerEl: HTMLElement;
    let pendingQualityOptions: QualityOption[] = [];
    let previewModalEl: HTMLElement;
    /** 页面拦到的权威 DASH manifest（兼容旧消息，仅用于悬浮按钮）。 */
    let dashManifest: DashManifest | null = null;
    /** 同一 tab 的多个播放会话；资源面板按此集合构建视频候选。 */
    let dashManifests: DashManifestEntry[] = [];
    /** shadow 内根容器，主题以 data-theme 属性挂在其上，供 CSS light/dark 变量切换。 */
    let rootContainer: HTMLElement | null = null;

    function resolverPageUrl(rawHref = location.href): string {
      try {
        const url = new URL(rawHref);
        const host = url.hostname.toLowerCase();
        if ((host === 'www.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com') && url.pathname === '/watch') {
          const videoId = url.searchParams.get('v');
          if (videoId) return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
        }
        if ((host === 'www.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com') && url.pathname.startsWith('/shorts/')) {
          const videoId = url.pathname.split('/').filter(Boolean)[1];
          if (videoId) return `https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`;
        }
        if (host === 'youtu.be') {
          const videoId = url.pathname.split('/').filter(Boolean)[0];
          if (videoId) return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
        }
        url.hash = '';
        return url.toString();
      } catch {
        return rawHref;
      }
    }

    async function refreshResolverPreview(force = false): Promise<void> {
      const href = resolverPageUrl();
      if (!/^https?:\/\//i.test(href)) return;
      if (!force && resolverPreviewHref === href) return;

      resolverPreviewHref = href;
      resolverPreviewName = '';
      resolverPreviewVariants = [];
      resolverVersion += 1;
      candidateCache = null;
      render();

      try {
        const response = await browser.runtime.sendMessage({
          action: 'resolvePageVariants',
          url: href,
        });
        // SPA 导航期间旧请求回来时不可污染新视频；YouTube 的 playlist/radio
        // 查询参数会频繁变化，因此按 canonical video URL 而非完整 location.href 比较。
        if (resolverPageUrl() !== href || resolverPreviewHref !== href) return;
        const preview = response?.resolvePreview;
        resolverPreviewName = typeof preview?.name === 'string' ? preview.name : '';
        resolverPreviewVariants = Array.isArray(preview?.variants)
          ? preview.variants.filter((variant: ResolvedPreviewVariant) => !!variant?.url)
          : [];
      } catch {
        resolverPreviewName = '';
        resolverPreviewVariants = [];
      } finally {
        if (resolverPageUrl() === href && resolverPreviewHref === href) {
          resolverVersion += 1;
          candidateCache = null;
          render();
        }
      }
    }

    function scheduleResolverPreview(force = false, delay = 250): void {
      if (!sniffEnabled || !/^https?:\/\//i.test(location.href)) return;
      if (resolverPreviewTimer != null) {
        window.clearTimeout(resolverPreviewTimer);
      }
      resolverPreviewTimer = window.setTimeout(() => {
        resolverPreviewTimer = null;
        void refreshResolverPreview(force);
      }, delay);
    }

    function resourceDebugFilename(): string {
      const stamp = new Date().toISOString().replace(/[.:]/g, '-');
      return `fluxdown-resource-debug-${stamp}.json`;
    }

    /** 从页面内资源面板直接导出当前嗅探/聚合快照。 */
    function exportResourceDebugLog(): void {
      if (!import.meta.env.DEV) return;
      const log = buildResourceDebugLog({
        resources,
        manifests: dashManifests,
        candidates: mediaCandidatesSnapshot(),
        tabId: undefined,
        pageUrl: location.href,
        pageTitle: document.title,
        source: 'content',
      });
      const blobUrl = URL.createObjectURL(
        new Blob([stringifyResourceDebugLog(log)], { type: 'application/json' }),
      );
      try {
        const anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = resourceDebugFilename();
        anchor.click();
        if (exportDebugBtnEl) exportDebugBtnEl.textContent = t('panel.exportDebugLogDone');
      } catch {
        if (exportDebugBtnEl) exportDebugBtnEl.textContent = t('panel.exportDebugLogFailed');
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
        window.setTimeout(() => {
          if (exportDebugBtnEl) exportDebugBtnEl.textContent = t('panel.exportDebugLog');
        }, 2_000);
      }
    }

    /* ========== Shadow UI ========== */
    const ui = await createShadowRootUi(ctx, {
      name: 'fluxdown-ui',
      position: 'overlay',
      anchor: 'body',
      onMount(container) {
        rootContainer = container;
        buildDot(container);
        buildPanel(container);
        buildFloatButton(container);
        buildQualityPicker(container);
        buildPreviewModal(container);
        restoreDotPosition();
        applyThemeFromStorage();
      },
    });
    /* ========== 资源嗅探开关 ==========
     * 关掉嗅探后 background 不再上报资源，页面里的悬浮球 / 资源面板 /
     * 视频浮动下载按钮也必须一起消失——否则用户明明关了却仍看到注入 UI。
     * 开关改动即时生效（挂载 / 卸载 shadow root），不需要刷新页面。 */
    let sniffEnabled = true;
    try {
      const settings = await loadSettings();
      sniffEnabled = settings.resourceSniffing !== false;
      showFloatingButtonSetting = settings.showFloatingButton !== false;
      showResourcePanelSetting = settings.showResourcePanel !== false;
    } catch {
      // 设置读取失败按开启处理
    }
    if (sniffEnabled) ui.mount();

    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes.settings) return;
      const next = changes.settings.newValue as
        | {
            resourceSniffing?: boolean;
            showFloatingButton?: boolean;
            showResourcePanel?: boolean;
          }
        | undefined;
      const enabled = next?.resourceSniffing !== false;
      showFloatingButtonSetting = next?.showFloatingButton !== false;
      showResourcePanelSetting = next?.showResourcePanel !== false;
      if (!showFloatingButtonSetting) hideFloat();
      if (!showResourcePanelSetting && panelOpen) closePanel();
      if (enabled === sniffEnabled) return;
      sniffEnabled = enabled;
      if (enabled) {
        ui.mount();
      } else {
        hideFloat();
        panelOpen = false;
        ui.remove();
      }
    });

    /* ========== 消息监听 ========== */
    browser.runtime.onMessage.addListener((msg) => {
      if (!sniffEnabled) return;
      if (msg.action === 'resourcesUpdated' && Array.isArray(msg.resources)) {
        resources = msg.resources;
        resourceVersion += 1;
        candidateCache = null;
        render();
        syncPanelPageState();
      }
      if (msg.action === 'toggleResourcePanel') {
        togglePanel();
      }
      if (msg.action === 'dashManifestUpdated') {
        dashManifest = msg.manifest || null;
        dashManifests = Array.isArray(msg.dashManifests)
          ? msg.dashManifests
          : dashManifest
            ? [{ url: '', manifest: dashManifest }]
            : [];
        manifestVersion += 1;
        candidateCache = null;
        render();
        syncPanelPageState();
      }
    });

    /* ========== 语言变化监听 ========== */
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes['fluxdown_locale']) {
        const newLocale = changes['fluxdown_locale'].newValue;
        if (newLocale) {
          setLocale(newLocale);
          refreshStaticTexts();
          render();
        }
      }
      if (DOT_VISIBLE_KEY in changes) {
        applyDotVisibility(changes[DOT_VISIBLE_KEY].newValue !== false);
      }
      // 主题跟随 popup 切换：popup 改 storage.local.theme，此处同步到 shadow root。
      if (THEME_KEY in changes) {
        applyTheme(changes[THEME_KEY].newValue);
      }
    });

    if (sniffEnabled) {
      try {
        const resp = await browser.runtime.sendMessage({ action: 'getResources' });
        if (Array.isArray(resp?.resources)) {
          resources = resp.resources;
          resourceVersion += 1;
        }
        if (resp?.dashManifest) {
          dashManifest = resp.dashManifest;
        }
        if (Array.isArray(resp?.dashManifests)) {
          dashManifests = resp.dashManifests;
          manifestVersion += 1;
        } else if (dashManifest) {
          dashManifests = [{ url: '', manifest: dashManifest }];
        }
        render();
        syncPanelPageState();
        scheduleResolverPreview(false, 50);
      } catch { /* */ }
    }

    /* ========== 预览弹层：Esc 关闭 ========== */
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && previewModalEl?.classList.contains('visible')) {
        closePreview();
      }
    });

    /* ========== 视频 hover ========== */
    let floatTimer: ReturnType<typeof setTimeout> | null = null;
    let hoverVideo: HTMLVideoElement | null = null;

    // 从事件路径中查找 video 元素：B站/迅雷等播放器在 video 上覆盖弹幕/控件层，
    // e.target 往往是覆盖层而非 video 本身，composedPath 可穿透覆盖层与 shadow DOM。
    function videoInPath(e: Event): HTMLVideoElement | null {
      const path = e.composedPath ? e.composedPath() : [];
      for (const node of path) {
        if (node instanceof HTMLVideoElement) return node;
      }
      return e.target instanceof HTMLVideoElement ? e.target : null;
    }

    document.addEventListener('mouseover', (e) => {
      const video = videoInPath(e);
      if (!video) return;
      hoverVideo = video;
      if (floatTimer) { clearTimeout(floatTimer); floatTimer = null; }
      showFloat(video);
    }, true);

    document.addEventListener('mouseout', (e) => {
      if (!videoInPath(e)) return;
      floatTimer = setTimeout(hideFloat, 400);
    }, true);

    /* ========== 当前播放器跟踪 ==========
     * Reels / Shorts 会在同一 SPA 页面内替换/滚动多个 <video>，而 URL、blob src、
     * 播放状态和可视位置可能分别变化。事件 + 轻量轮询双保险，只在主播放器身份改变
     * 时重排资源，不随 currentTime 每秒重绘。 */
    function currentPlaybackSignature(): string {
      const video = activePlaybackVideo();
      if (!video) return '';
      const rect = video.getBoundingClientRect();
      return [
        video.currentSrc || video.src || '',
        video.paused ? 'paused' : 'playing',
        video.ended ? 'ended' : 'active',
        video.readyState,
        Math.round(rect.top / 80),
        Math.round(rect.left / 80),
        Math.round(rect.width / 80),
        Math.round(rect.height / 80),
      ].join('|');
    }

    function refreshPlaybackPriority(): void {
      syncPanelPageState();
      const next = currentPlaybackSignature();
      if (next === playbackSignature) return;
      playbackSignature = next;
      showSecondaryMedia = false;
      if (panelOpen) renderList();
      if (next) scheduleResolverPreview(false, 150);
    }

    const playbackEvents = ['play', 'playing', 'pause', 'ended', 'loadedmetadata', 'emptied'] as const;
    for (const eventName of playbackEvents) {
      document.addEventListener(eventName, refreshPlaybackPriority, true);
    }

    // IDM-style warmup: as soon as a media element appears on a dynamic page,
    // resolve the page in the background so opening the floating panel is instant.
    const mediaObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof Element)) continue;
          if (node.matches('video,audio') || node.querySelector('video,audio')) {
            scheduleResolverPreview(false, 200);
            return;
          }
        }
      }
    });
    mediaObserver.observe(document.documentElement, { childList: true, subtree: true });

    const playbackMonitor = window.setInterval(refreshPlaybackPriority, 1200);
    ctx.onInvalidated(() => {
      window.clearInterval(playbackMonitor);
      if (resolverPreviewTimer != null) window.clearTimeout(resolverPreviewTimer);
      mediaObserver.disconnect();
      for (const eventName of playbackEvents) {
        document.removeEventListener(eventName, refreshPlaybackPriority, true);
      }
    });

    /* ================================================================
     *  构建 DOM
     * ================================================================ */

    function buildDot(root: HTMLElement): void {
      dotEl = h('div', 'fluxdown-dot');
      // 初始隐藏，等 restoreDotPosition 定位后再显示，避免闪烁
      dotEl.style.visibility = 'hidden';
      dotEl.innerHTML = `
        ${svg(SVG_LOGO, 'dot-icon')}
        <span class="dot-badge"></span>
      `;
      badgeEl = dotEl.querySelector('.dot-badge') as HTMLElement;

      // 点击 → 切换面板
      dotEl.addEventListener('click', (e) => {
        if (didDrag) { didDrag = false; return; }
        e.stopPropagation();
        togglePanel();
      });

      // ===== 拖拽（X+Y 自由移动，松手吸附边缘） =====
      let startX = 0;
      let startY = 0;
      let startLeft = 0;
      let startTop = 0;
      let dragging = false;
      let didDrag = false;
      let moveCount = 0;

      dotEl.addEventListener('pointerdown', (e: PointerEvent) => {
        if (e.button !== 0) return;
        dragging = true;
        didDrag = false;
        moveCount = 0;
        startX = e.clientX;
        startY = e.clientY;

        // getBoundingClientRect 保证获取准确的视口坐标，
        // 不受 Shadow DOM / offsetParent / CSS right 等影响
        const rect = dotEl.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;

        dotEl.setPointerCapture(e.pointerId);
        dotEl.classList.add('dragging');

        // 拖拽开始时关闭面板（拖拽是重新定位操作，面板碍事）
        if (panelOpen) {
          panelOpen = false;
          panelEl.classList.remove('visible');
          dotEl.classList.remove('active');
        }
      });

      dotEl.addEventListener('pointermove', (e: PointerEvent) => {
        if (!dragging) return;
        moveCount++;
        if (moveCount < 3) return;
        didDrag = true;

        // 允许拖到半隐藏的范围：left 从 -18 到 viewport-18
        const newLeft = Math.max(-18, Math.min(
          window.innerWidth - 18,
          startLeft + (e.clientX - startX),
        ));
        const newTop = Math.max(20, Math.min(
          window.innerHeight - 56,
          startTop + (e.clientY - startY),
        ));

        // 拖拽中只用 inline left + top（.dragging 禁用了过渡）
        dotEl.style.left = `${newLeft}px`;
        dotEl.style.top = `${newTop}px`;
      });

      const endDrag = () => {
        if (!dragging) return;
        dragging = false;

        if (!didDrag) {
          // 没有实际拖拽，只是点击，直接恢复
          dotEl.classList.remove('dragging');
          return;
        }

        // 用 getBoundingClientRect 获取松手时准确位置
        const rect = dotEl.getBoundingClientRect();
        const currentLeft = rect.left;
        const currentTop = rect.top;

        // 根据圆点中心 X 判断吸附方向
        const centerX = currentLeft + 18;
        side = centerX < window.innerWidth / 2 ? 'left' : 'right';

        // --- 平滑吸附动画序列 ---
        // 1) 确保 inline left 是当前像素值（.dragging 仍在，无过渡）
        dotEl.style.left = `${currentLeft}px`;
        dotEl.style.top = `${Math.round(currentTop)}px`;

        // 2) 设置目标 side class（CSS class 定义了吸附目标 left 值）
        applySideClass();

        // 3) 移除 .dragging → CSS transition 启用
        dotEl.classList.remove('dragging');

        // 4) 强制浏览器完成一次样式计算（确认 "before" 状态）
        void dotEl.offsetWidth;

        // 5) 清除 inline left → CSS class 的 left 值生效
        //    浏览器看到 left 从 currentLeft → CSS 目标值，触发过渡动画
        dotEl.style.left = '';

        // 持久化
        saveDotPosition(Math.round(currentTop), side);
      };

      dotEl.addEventListener('pointerup', endDrag);
      dotEl.addEventListener('pointercancel', endDrag);

      root.appendChild(dotEl);
    }

    /** 切换 .left / .right CSS 类（不操作 inline style） */
    function applySideClass(): void {
      dotEl.classList.toggle('left', side === 'left');
      dotEl.classList.toggle('right', side === 'right');
    }

    function buildPanel(root: HTMLElement): void {
      panelEl = h('div', 'fluxdown-panel');

      const header = h('div', 'panel-header');
      header.innerHTML = `
        ${svg(SVG_LOGO, 'logo')}
        <span class="title">FluxDown</span>
        <span class="resource-count"></span>
      `;
      countEl = header.querySelector('.resource-count') as HTMLElement;

      const headerActions = h('div', 'panel-header-actions');

      if (import.meta.env.DEV) {
        exportDebugBtnEl = document.createElement('button');
        exportDebugBtnEl.className = 'export-debug-btn';
        exportDebugBtnEl.type = 'button';
        exportDebugBtnEl.textContent = t('panel.exportDebugLog');
        exportDebugBtnEl.title = t('panel.exportDebugLogTitle');
        exportDebugBtnEl.setAttribute('aria-label', t('panel.exportDebugLog'));
        exportDebugBtnEl.addEventListener('click', exportResourceDebugLog);
        headerActions.appendChild(exportDebugBtnEl);
      }

      // #559：清空当前 tab 嗅探资源列表（抖音等长会话 SPA 反复切换播放会
      // 不断累积资源，提供一键清空；清空后新嗅探到的资源仍会正常加入）。
      const clearBtn = h('button', 'btn-close');
      clearBtn.title = t('panel.clearResourcesTitle');
      clearBtn.innerHTML = svg(SVG_TRASH);
      clearBtn.addEventListener('click', () => {
        browser.runtime.sendMessage({ action: 'clearResources' }).catch(() => {});
        resources = [];
        dashManifests = [];
        dashManifest = null;
        resourceVersion += 1;
        manifestVersion += 1;
        candidateCache = null;
        selectedIds.clear();
        render();
      });
      headerActions.appendChild(clearBtn);

      const hideBtn = h('button', 'btn-close');
      hideBtn.title = t('panel.hideDot');
      hideBtn.innerHTML = svg(SVG_EYE_OFF);
      hideBtn.addEventListener('click', () => {
        browser.storage.local.set({ [DOT_VISIBLE_KEY]: false });
        if (panelOpen) closePanel();
      });
      headerActions.appendChild(hideBtn);

      const closeBtn = h('button', 'btn-close');
      closeBtn.innerHTML = svg(SVG_CLOSE);
      closeBtn.addEventListener('click', () => { closePanel(); });
      headerActions.appendChild(closeBtn);
      header.appendChild(headerActions);

      tabsEl = h('div', 'panel-tabs');
      listEl = h('div', 'panel-list');

      const footer = h('div', 'panel-footer');
      const label = document.createElement('label');
      selectAllEl = document.createElement('input');
      selectAllEl.type = 'checkbox';
      label.appendChild(selectAllEl);
      selectAllText = document.createTextNode(` ${t('panel.selectAll')}`);
      label.appendChild(selectAllText);
      selectAllEl.addEventListener('change', () => {
        const items = selectableItems();
        if (selectAllEl.checked) {
          for (const item of items) selectedIds.add(item.id);
        } else {
          for (const item of items) selectedIds.delete(item.id);
        }
        renderList();
        updateBatch();
      });

      batchBtnEl = document.createElement('button');
      batchBtnEl.className = 'batch-btn';
      batchBtnEl.disabled = true;
      batchBtnEl.innerHTML = `${svg(SVG_DOWNLOAD)} ${t('panel.batchDownload')} (<span>0</span>)`;
      batchCountEl = batchBtnEl.querySelector('span') as HTMLElement;
      batchBtnEl.addEventListener('click', () => {
        const items = selectedDownloadItems();
        if (items.length === 0) return;

        // 一次性发送所有选中资源给 Background，由 Background 端顺序执行
        // 避免循环 sendMessage 导致 Chrome MV3 消息通道串行阻塞，只有第一个被处理
        void browser.runtime.sendMessage({
          action: 'batchDownload',
          items,
        }).then((response: { success?: boolean; message?: string } | undefined) => {
          if (!response?.success) console.warn('[FluxDown UI] batch download failed:', response?.message);
        }).catch(() => {
          console.warn('[FluxDown UI] batch download message failed');
        });
        selectedIds.clear();
        renderList();
        updateBatch();
        updateSelectAll();
      });

      clearFailedBtnEl = document.createElement('button');
      clearFailedBtnEl.className = 'clear-failed-btn';
      clearFailedBtnEl.textContent = t('panel.clearFailed');
      clearFailedBtnEl.title = t('panel.clearFailedHint');
      clearFailedBtnEl.style.display = 'none';
      clearFailedBtnEl.addEventListener('click', () => {
        for (const id of previewFailedIds) dismissedIds.add(id);
        previewFailedIds.clear();
        render();
      });

      const actions = h('div', 'panel-footer-actions');
      actions.appendChild(clearFailedBtnEl);
      actions.appendChild(batchBtnEl);

      footer.appendChild(label);
      footer.appendChild(actions);

      panelEl.appendChild(header);
      panelEl.appendChild(tabsEl);
      panelEl.appendChild(listEl);
      panelEl.appendChild(footer);
      root.appendChild(panelEl);
    }

    function buildFloatButton(root: HTMLElement): void {
      floatBtnEl = h('div', 'fluxdown-float-btn');
      floatBtnEl.innerHTML = `${svg(SVG_DOWNLOAD, 'icon')}<span class="label"></span>`;
      floatBtnEl.addEventListener('mouseenter', () => {
        if (floatTimer) { clearTimeout(floatTimer); floatTimer = null; }
      });
      floatBtnEl.addEventListener('mouseleave', () => {
        floatTimer = setTimeout(hideFloat, 300);
      });
      floatBtnEl.addEventListener('click', () => {
        if (!hoverVideo) return;
        const src = hoverVideo.currentSrc || hoverVideo.src;
        const isBlob = !src || src.startsWith('blob:') || src.startsWith('data:');

        // 直链视频 → 直接下载。
        if (!isBlob && src) {
          const candidate = mediaCandidatesForTab('all').find((item) =>
            item.variants.some((variant) => variant.videoUrl === src),
          );
          const variant = candidate ? defaultCandidateVariant(candidate) : undefined;
          if (candidate && variant) {
            downloadCandidate(candidate, variant);
          } else {
            const fallbackCandidate: MediaCandidate = {
              id: 'float-direct',
              title: document.title || t('panel.videoCandidate'),
              type: 'video',
              source: 'direct',
              pageUrl: location.href,
              variants: [],
              rawResourceIds: [],
              fragmentCount: 0,
              downloadable: true,
            };
            void browser.runtime.sendMessage({
              action: 'downloadResource',
              url: src,
              referrer: location.href,
              filename: candidateFilename(fallbackCandidate, {
                id: 'float-direct-variant',
                label: 'original',
                videoUrl: src,
              }),
            });
          }
          hideFloat();
          return;
        }

        // blob/MSE 视频（B站/迅雷等）无直链 → 优先用页面拦到的权威 DASH manifest
        // 构造真清晰度档（height/bandwidth 来自 manifest，可信）；manifest 缺失时
          // 清单缺失时仍保留原有分片聚合兜底，避免 document_idle 注入竞态
          // 让浮标从“有行可点”退化为空白面板。
        // 存在音视频轨对或多档清晰度 → 弹出清晰度选择小窗；只有一条无音频的单轨
        // → 直接下载；两者都拿不到（未嗅探到媒体）→ 回退打开资源面板。
        const media = mediaResources();
        const options =
          dashManifest && dashManifest.video.length > 0
            ? qualityOptionsFromManifest(dashManifest)
            : qualityOptionsFromTrackGroups(groupTrackPairs(media));
        const needsPicker =
          options.length > 1 || options.some((o) => o.audioUrl);
        if (needsPicker) {
          const rect = floatBtnEl.getBoundingClientRect();
          hideFloat();
          showQualityPicker(options, rect);
          return;
        }
        if (options.length === 1) {
          downloadQualityOption(options[0]);
          hideFloat();
          return;
        }
        if (media.length > 0) {
          activeTab = media.some((r) => r.type === 'video') ? 'video' : 'all';
          if (!panelOpen) openPanel();
          else render();
        }
        hideFloat();
      });
      root.appendChild(floatBtnEl);
    }

    /* ================================================================
     *  面板控制
     * ================================================================ */

    function syncPanelPageState(): void {
      if (autoPanelPageHref === location.href) return;
      autoPanelPageHref = location.href;
      showSecondaryMedia = false;
      resolverPreviewHref = '';
      resolverPreviewName = '';
      resolverPreviewVariants = [];
      resolverVersion += 1;
      candidateCache = null;
      scheduleResolverPreview(true, 100);
    }

    function openPanel(): void {
      if (!sniffEnabled || !showResourcePanelSetting || panelOpen) return;
      syncPanelPageState();
      panelOpen = true;
      const dotY = parseInt(dotEl.style.top) || Math.round(window.innerHeight * 0.4);
      positionPanel(dotY);
      panelEl.classList.add('visible');
      dotEl.classList.add('active');
      render();
      scheduleResolverPreview(false, 0);
    }

    function closePanel(): void {
      if (!panelOpen) return;
      panelOpen = false;
      panelEl.classList.remove('visible');
      dotEl.classList.remove('active');
    }

    function togglePanel(): void {
      if (!sniffEnabled || !showResourcePanelSetting) return;
      if (panelOpen) closePanel();
      else openPanel();
    }

    function positionPanel(dotY: number): void {
      const panelHeight = 460;
      let top = dotY - 20;
      if (top + panelHeight > window.innerHeight - 10) {
        top = window.innerHeight - panelHeight - 10;
      }
      if (top < 10) top = 10;
      panelEl.style.top = `${top}px`;

      // 重置
      panelEl.style.left = '';
      panelEl.style.right = '';

      if (side === 'left') {
        panelEl.classList.add('left');
        panelEl.classList.remove('right');
        panelEl.style.left = '52px';
      } else {
        panelEl.classList.remove('left');
        panelEl.classList.add('right');
        panelEl.style.right = '52px';
      }
    }

    function applyDotVisibility(visible: boolean): void {
      if (visible) {
        dotEl.classList.remove('hidden');
      } else {
        dotEl.classList.add('hidden');
        if (panelOpen) togglePanel();
      }
    }

    function restoreDotPosition(): void {
      // 禁用过渡，避免初始定位时有动画
      dotEl.classList.add('dragging');

      const applyDefaults = () => {
        dotEl.style.top = `${Math.round(window.innerHeight * 0.4)}px`;
        side = 'right';
        applySideClass();
        dotEl.style.visibility = '';
        requestAnimationFrame(() => { dotEl.classList.remove('dragging'); });
      };

      try {
        browser.storage.local.get([STORAGE_KEY, DOT_VISIBLE_KEY]).then((r) => {
          const safeR = r ?? {};
          const pos = safeR[STORAGE_KEY];
          if (pos && typeof pos === 'object') {
            const y = typeof pos.y === 'number' && pos.y > 0
              ? Math.min(pos.y, window.innerHeight - 56)
              : Math.round(window.innerHeight * 0.4);
            dotEl.style.top = `${y}px`;
            if (pos.side === 'left' || pos.side === 'right') {
              side = pos.side;
            }
          } else {
            dotEl.style.top = `${Math.round(window.innerHeight * 0.4)}px`;
          }
          applySideClass();
          // 未设置时默认显示，明确为 false 时隐藏
          if (safeR[DOT_VISIBLE_KEY] === false) {
            dotEl.classList.add('hidden');
          }
          dotEl.style.visibility = '';
          requestAnimationFrame(() => { dotEl.classList.remove('dragging'); });
        }).catch(() => { applyDefaults(); });
      } catch { applyDefaults(); }
    }

    function saveDotPosition(y: number, s: 'left' | 'right'): void {
      try {
        browser.storage.local.set({ [STORAGE_KEY]: { y, side: s } });
      } catch { /* */ }
    }

    // 点击外部关闭面板 — composedPath 穿透 Shadow DOM
    document.addEventListener('click', (e) => {
      if (!panelOpen) return;
      const path = e.composedPath();
      if (path.includes(panelEl) || path.includes(dotEl)) return;
      panelOpen = false;
      panelEl.classList.remove('visible');
      dotEl.classList.remove('active');
    });

    /* ================================================================
     *  渲染
     * ================================================================ */

    function render(): void {
      renderBadge();
      renderTabs();
      renderList();
      updateBatch();
      if (clearFailedBtnEl) {
        // 仅当存在「已标记预览失败且尚未清理」的项时才显示清理按钮。
        const hasFailed = [...previewFailedIds].some((id) => !dismissedIds.has(id));
        clearFailedBtnEl.style.display = hasFailed ? '' : 'none';
      }
    }

    function renderBadge(): void {
      if (!badgeEl) return;
      const n = resourceRowsForTab('all').length;
      badgeEl.textContent = n > 99 ? '99+' : String(n);
      badgeEl.classList.toggle('show', n > 0);
      if (countEl) countEl.textContent = n > 0 ? `${n} ${t('panel.resources')}` : '';
    }

    function renderTabs(): void {
      if (!tabsEl) return;
      tabsEl.innerHTML = '';
      for (const tab of TABS) {
        const count = resourceRowsForTab(tab.key).length;
        if (tab.key !== 'all' && count === 0) continue;
        const btn = h('button', `panel-tab${activeTab === tab.key ? ' active' : ''}`);
        btn.textContent = `${t(tab.i18nKey)} ${count}`;
        btn.addEventListener('click', () => { activeTab = tab.key; renderTabs(); renderList(); });
        tabsEl.appendChild(btn);
      }
    }

    let showLowConf = false; // 低可信度资源是否展开

    function visibleArea(video: HTMLVideoElement): number {
      const rect = video.getBoundingClientRect();
      const width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
      const height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
      if (width <= 0 || height <= 0) return 0;
      const style = getComputedStyle(video);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return 0;
      return width * height;
    }

    function activePlaybackVideo(): HTMLVideoElement | null {
      let best: HTMLVideoElement | null = null;
      let bestScore = -1;
      for (const video of Array.from(document.querySelectorAll<HTMLVideoElement>('video'))) {
        const area = visibleArea(video);
        if (area <= 0) continue;
        let score = area;
        if (!video.paused && !video.ended) score += 1_000_000_000;
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) score += 10_000_000;
        if (video.currentTime > 0) score += 1_000_000;
        if (score > bestScore) {
          best = video;
          bestScore = score;
        }
      }
      return best;
    }

    function normalizedMediaUrl(url: string | undefined): string {
      if (!url || url.startsWith('blob:') || url.startsWith('data:')) return '';
      return normalizeUrlForDedup(url);
    }

    function rowUrl(row: ContentResourceRow): string {
      if (isContentMediaCandidate(row.item)) return row.variant?.videoUrl || '';
      return row.item.url;
    }

    function rowLatestDetectedAt(row: ContentResourceRow): number {
      if (!isContentMediaCandidate(row.item)) return row.item.detectedAt || 0;
      const ids = new Set(row.item.rawResourceIds);
      let latest = 0;
      for (const resource of resources) {
        if (ids.has(resource.id)) latest = Math.max(latest, resource.detectedAt || 0);
      }
      return latest;
    }

    function rowCompletenessPriority(row: ContentResourceRow): number {
      const url = rowUrl(row);
      const ext = extractExtension(url);

      // HLS / DASH 清单与完整文件才是“用户想下载的媒体”。TS/M4S 即使刚刚
      // 收到、甚至服务器带 filename，也只是播放器分片，永远不能盖过清单。
      if (isContentMediaCandidate(row.item)) {
        if (row.item.source === 'hls' || row.item.source === 'dash') return 400;
        if (row.item.source === 'fragments' || ext === 'ts' || ext === 'm4s') return 0;
        if (row.item.source === 'direct') return 400;
      }

      if (!isContentMediaCandidate(row.item) && isResolverPageResource(row.item)) return 500;
      if (isExplicitStreamManifestUrl(url)) return 400;
      if (ext === 'ts' || ext === 'm4s') return 0;
      if (row.item.type === 'stream') return 350;
      if (row.item.type === 'video') return 400;
      return 100;
    }

    function bestCompleteMediaRow(rows: ContentResourceRow[]): ContentResourceRow | undefined {
      return [...rows].sort((a, b) => {
        const priority = rowCompletenessPriority(b) - rowCompletenessPriority(a);
        if (priority !== 0) return priority;
        return rowLatestDetectedAt(b) - rowLatestDetectedAt(a);
      })[0];
    }

    function isProfileReelsResolver(resource: DetectedResource): boolean {
      if (!isResolverPageResource(resource)) return false;
      try {
        const url = new URL(resource.url);
        if (url.hostname.toLowerCase().replace(/^www\./, '') !== 'instagram.com') return false;
        const parts = url.pathname.split('/').filter(Boolean);
        return parts.length === 2 && parts[1] === 'reels';
      } catch {
        return false;
      }
    }

    function isCurrentResolverRow(row: ContentResourceRow): boolean {
      if (isContentMediaCandidate(row.item) || !isResolverPageResource(row.item)) return false;
      try {
        const current = new URL(location.href);
        const source = new URL(row.item.url);
        current.hash = '';
        source.hash = '';
        return current.origin === source.origin && current.pathname.replace(/\/+$/, '') === source.pathname.replace(/\/+$/, '');
      } catch {
        return row.item.url === location.href;
      }
    }

    function mediaRow(row: ContentResourceRow): boolean {
      if (isContentMediaCandidate(row.item)) return true;
      return row.item.type === 'video' || row.item.type === 'stream' || isResolverPageResource(row.item);
    }

    function primaryMediaRow(rows: ContentResourceRow[]): ContentResourceRow | undefined {
      if (rows.length === 0) return undefined;

      // Resolver 页面是当前页面的权威“完整视频”入口，优先级高于页面预载的 CDN
      // range/chunk。Instagram profile /reels/ 代表批量动作，也保留为主入口。
      const resolver = rows.find(isCurrentResolverRow);
      if (resolver) return resolver;

      const active = activePlaybackVideo();
      const activeUrl = normalizedMediaUrl(active?.currentSrc || active?.src);
      const best = bestCompleteMediaRow(rows);
      if (activeUrl) {
        const exact = rows.find((row) => normalizedMediaUrl(rowUrl(row)) === activeUrl);
        if (
          exact &&
          (!best || rowCompletenessPriority(exact) >= rowCompletenessPriority(best))
        ) return exact;
      }

      // MSE/blob 无法直接把 <video> 与 CDN URL 一一对应。先选完整性最高的候选，
      // 再在同等级内按最近检测时间排序；不能让持续流入的 .ts/.m4s 抢走主位置。
      if (active && !active.paused && !active.ended) {
        return best;
      }

      return best || rows[0];
    }

    function primaryRowLabel(row: ContentResourceRow): string {
      if (!isContentMediaCandidate(row.item) && isProfileReelsResolver(row.item)) {
        return t('panel.batchReels');
      }
      return t('panel.currentlyPlaying');
    }

    function appendMediaRow(row: ContentResourceRow, primary: boolean): void {
      const el = isContentMediaCandidate(row.item)
        ? buildMediaCandidateRow(row.item, row.variant, primary)
        : buildResourceRow(row.item, primary);
      if (primary) {
        el.dataset.primaryMedia = 'true';
        el.setAttribute('aria-label', primaryRowLabel(row));
      }
      listEl?.appendChild(el);
    }

    function renderList(): void {
      if (!listEl) return;
      const rows = resourceRowsForTab(activeTab);

      if (rows.length === 0) {
        listEl.innerHTML = `
          <div class="panel-empty">
            ${svg(SVG_EMPTY)}
            <span>${t('panel.empty')}</span>
          </div>
        `;
        return;
      }

      listEl.innerHTML = '';

      const mediaRows = rows.filter(mediaRow);
      const primary = primaryMediaRow(mediaRows);
      // IDM 式呈现：如果当前主资源是一个已解析出的媒体候选（DASH / HLS /
      // direct），同一候选的所有 variant 都属于“这支影片的可选画质”，必须
      // 直接展开，不能把 720p / 480p 等兄弟画质折进「其他预载资源」。
      // 真正属于其他候选（广告、下一支影片预载、另一个播放器）的资源才折叠。
      const primaryGroup = primary
        ? isContentMediaCandidate(primary.item)
          ? mediaRows.filter(
            (row) => isContentMediaCandidate(row.item) && row.item.id === primary.item.id,
          )
          : [primary]
        : [];
      const primaryGroupIds = new Set(primaryGroup.map((row) => row.id));
      const secondaryMedia = primary
        ? mediaRows.filter((row) => !primaryGroupIds.has(row.id))
        : mediaRows;

      // 保留候选原有的清晰度顺序（buildMediaCandidates 已按质量排序），只在
      // 当前实际播放的那一档加「正在播放」标记；其它档同样直接可勾选/下载。
      for (const row of primaryGroup) appendMediaRow(row, row.id === primary?.id);

      if (secondaryMedia.length > 0) {
        const toggle = h('div', 'secondary-media-toggle');
        toggle.innerHTML = `
          <span class="secondary-media-line"></span>
          <button class="secondary-media-btn">
            ${showSecondaryMedia
              ? esc(t('panel.hidePreloaded'))
              : esc(t('panel.otherPreloaded', { count: String(secondaryMedia.length) }))}
          </button>
          <span class="secondary-media-line"></span>
        `;
        toggle.querySelector<HTMLButtonElement>('.secondary-media-btn')?.addEventListener('click', () => {
          showSecondaryMedia = !showSecondaryMedia;
          renderList();
        });
        listEl.appendChild(toggle);
        if (showSecondaryMedia) {
          for (const row of secondaryMedia) appendMediaRow(row, false);
        }
      }

      const items = rows
        .filter((row): row is ContentResourceRow & { item: DetectedResource } => !mediaRow(row) && !('downloadable' in row.item))
        .map((row) => row.item);

      // 按可信度分组（资源已按 confidence desc 排序）
      const main = items.filter((r) => r.confidence !== 'low');
      const low = items.filter((r) => r.confidence === 'low');

      // 渲染 high + medium
      for (const r of main) {
        listEl.appendChild(buildResourceRow(r));
      }

      // 低可信度折叠区域
      if (low.length > 0) {
        const toggle = h('div', 'low-conf-toggle');
        toggle.innerHTML = `
          <span class="low-conf-line"></span>
          <button class="low-conf-btn">
            ${showLowConf
              ? t('panel.collapse')
              : t('panel.more', { count: String(low.length) })}
          </button>
          <span class="low-conf-line"></span>
        `;
        const btn = toggle.querySelector('.low-conf-btn') as HTMLButtonElement;
        btn.addEventListener('click', () => {
          showLowConf = !showLowConf;
          renderList();
          updateBatch();
        });
        listEl.appendChild(toggle);

        if (showLowConf) {
          for (const r of low) {
            listEl.appendChild(buildResourceRow(r));
          }
        }
      }
    }

    /**
     * m4s/分片等 stream 类资源的轨道标注。
     * 判定委托给通用识别器 `detectTrackKind`（MIME → URL 线索 → 站点规则兜底），
     * 此处只负责映射为展示用的文案 + CSS class。
     */
    function trackKindLabel(r: DetectedResource): { text: string; cls: string } | null {
      if (r.type !== 'stream') return null;
      const kind = detectTrackKind({ url: r.url, filename: r.filename, mimeType: r.mimeType, pageUrl: r.pageUrl });
      if (kind === 'video') return { text: t('panel.trackVideo'), cls: 'video' };
      if (kind === 'audio') return { text: t('panel.trackAudio'), cls: 'audio' };
      return null;
    }

    function candidateVariantLabel(variant: MediaCandidateVariant): string {
      if (variant.label === 'auto') return t('panel.autoQuality');
      if (variant.label === 'original') return t('panel.originalQuality');
      const resolution = qualityResolutionLabel(variant.label);
      // 无 height 时 variant.label 是 qualityLabel() 产出的 "<bandwidth>kbps"
      // 稳定标识（selectQualityVideoTracks 已按它分档）；qualityResolutionLabel
      // 只认 "<n>p" 格式，匹配不到就原样展示该标识，而不是统一降级成
      // 「未知画质」（否则多档无 height 轨道会渲染成完全同名、无法区分）。
      if (!resolution) return variant.label || t('panel.qualityUnknown');
      const fps = qualityFrameRateLabel(variant.frameRate);
      return fps ? `${resolution} ${fps}` : resolution;
    }

    function downloadCandidate(
      candidate: MediaCandidate,
      variant: MediaCandidateVariant,
      button?: HTMLButtonElement,
    ): void {
      if (button?.disabled) return;
      if (button) button.disabled = true;
      void browser.runtime.sendMessage({
        action: 'downloadResource',
        url: variant.videoUrl,
        audioUrl: variant.audioUrl,
        referrer: candidate.pageUrl || location.href,
        filename: candidateFilename(candidate, variant),
        fileSize: variant.fileSize,
        mimeType: variant.mimeType,
        headers: variant.headers,
      }).then((response: { success?: boolean } | undefined) => {
        if (!response?.success && button) button.disabled = false;
      }).catch(() => {
        if (button) button.disabled = false;
      });
    }

    function buildMediaCandidateRow(
      candidate: MediaCandidate,
      variant?: MediaCandidateVariant,
      primary = false,
    ): HTMLElement {
      const row = h(
        'div',
        `resource-row media-candidate-row${candidate.downloadable ? '' : ' unresolved'}${primary ? ' primary-media' : ''}`,
      );
      const rowId = contentResourceRowId(candidate, variant);
      const quality = variant
        ? `<span>${esc(candidateVariantLabel(variant))}</span>`
        : '';
      const warning = candidate.downloadable
        ? ''
        : `<span class="candidate-warning">${esc(t('panel.videoNeedsManifest'))}</span>`;
      const isResolvedVariant = candidate.id.startsWith('resolver:');
      const sizeLabel = variant?.fileSize ? formatFileSize(variant.fileSize) : '';

      row.innerHTML = `
        <input type="checkbox" class="check" ${candidate.downloadable && variant ? '' : 'disabled'} ${selectedIds.has(rowId) ? 'checked' : ''}>
        <div class="info">
          <div class="filename" title="${esc(candidate.pageUrl)}">${esc(candidate.title)}</div>
          <div class="meta candidate-meta">
            ${primary ? `<span class="now-playing-tag">${esc(t('panel.currentlyPlaying'))}</span>` : ''}
            ${quality}
            ${sizeLabel ? `<span class="size">${esc(sizeLabel)}</span>` : ''}
            ${warning}
          </div>
          ${variant?.videoUrl && !isResolvedVariant
            ? `<div class="source-url" title="${esc(variant.videoUrl)}">${esc(variant.videoUrl)}</div>`
            : ''}
        </div>
        ${candidate.downloadable && variant
          ? `<button class="dl-btn" title="${t('panel.downloadCandidate')}">${esc(t('panel.download'))}</button>`
          : ''}
      `;

      const cb = row.querySelector('.check') as HTMLInputElement;
      cb.addEventListener('change', () => {
        if (cb.checked) selectedIds.add(rowId); else selectedIds.delete(rowId);
        updateBatch();
        updateSelectAll();
      });

      const dl = row.querySelector('.dl-btn') as HTMLButtonElement | null;
      dl?.addEventListener('click', () => {
        if (variant) downloadCandidate(candidate, variant, dl);
      });
      return row;
    }

    function buildResourceRow(r: DetectedResource, primary = false): HTMLElement {
      const failed = previewFailedIds.has(r.id);
      const row = h(
        'div',
        `resource-row conf-${r.confidence}${failed ? ' preview-failed' : ''}${primary ? ' primary-media' : ''}`,
      );
      const sizeStr = r.size > 0 ? formatFileSize(r.size) : '';
      const quality = r.quality ? `<span class="quality-tag">${r.quality}</span>` : '';
      const track = trackKindLabel(r);
      const trackTag = track ? `<span class="track-tag ${track.cls}">${esc(track.text)}</span>` : '';
      const name = r.filename || tryDecodeUrl(r.url) || r.url;

      row.innerHTML = `
        <input type="checkbox" class="check" ${selectedIds.has(r.id) ? 'checked' : ''}>
        <div class="info">
          <div class="filename" title="${esc(r.url)}">${esc(name)}</div>
          <div class="meta">
            ${primary ? `<span class="now-playing-tag">${esc(isProfileReelsResolver(r) ? t('panel.batchReels') : t('panel.currentlyPlaying'))}</span>` : ''}
            ${trackTag}
            ${quality}
            ${sizeStr ? `<span class="size">${sizeStr}</span>` : ''}
            ${r.mimeType ? `<span>${esc(r.mimeType)}</span>` : ''}
            ${failed ? `<span class="preview-limited" title="${t('panel.previewLimitedHint')}">${t('panel.previewLimited')}</span>` : ''}
          </div>
          <div class="source-url" title="${esc(r.url)}">${esc(r.url)}</div>
        </div>
        ${isPreviewable(r) ? `<button class="preview-btn" title="${t('panel.previewTitle')}">${esc(t('panel.previewTitle'))}</button>` : ''}
        <button class="dl-btn" title="${t('panel.download')}">${esc(t('panel.download'))}</button>
      `;

      const cb = row.querySelector('.check') as HTMLInputElement;
      cb.addEventListener('change', () => {
        if (cb.checked) selectedIds.add(r.id); else selectedIds.delete(r.id);
        updateBatch();
        updateSelectAll();
      });

      const previewBtnEl = row.querySelector('.preview-btn') as HTMLButtonElement | null;
      previewBtnEl?.addEventListener('click', (e) => {
        e.stopPropagation();
        openPreview(r);
      });

      const dl = row.querySelector('.dl-btn') as HTMLButtonElement;
      dl.addEventListener('click', () => {
        if (dl.disabled) return;
        dl.disabled = true;
        void browser.runtime.sendMessage({
          action: 'downloadResource',
          url: r.url, referrer: r.pageUrl || location.href,
          filename: r.filename,
          fileSize: r.size > 0 ? r.size : undefined,
          mimeType: r.mimeType,
        }).then((response: { success?: boolean } | undefined) => {
          if (!response?.success) dl.disabled = false;
        }).catch(() => {
          dl.disabled = false;
        });
      });

      return row;
    }

    function updateBatch(): void {
      const count = selectedDownloadItems().length;
      if (batchCountEl) batchCountEl.textContent = String(count);
      if (batchBtnEl) batchBtnEl.disabled = count === 0;
    }

    function updateSelectAll(): void {
      if (!selectAllEl) return;
      const items = selectableItems();
      selectAllEl.checked = items.length > 0 && items.every((item) => selectedIds.has(item.id));
    }

    /** 语言切换时刷新静态文本（全选 label、批量下载按钮） */
    function refreshStaticTexts(): void {
      candidateCache = null;
      if (selectAllText) selectAllText.textContent = ` ${t('panel.selectAll')}`;
      if (exportDebugBtnEl) {
        exportDebugBtnEl.textContent = t('panel.exportDebugLog');
        exportDebugBtnEl.title = t('panel.exportDebugLogTitle');
        exportDebugBtnEl.setAttribute('aria-label', t('panel.exportDebugLog'));
      }
      if (batchBtnEl) {
        batchBtnEl.innerHTML = `${svg(SVG_DOWNLOAD)} ${t('panel.batchDownload')} (<span>0</span>)`;
        batchCountEl = batchBtnEl.querySelector('span') as HTMLElement;
        updateBatch();
      }
    }

    function isMediaResource(resource: DetectedResource): boolean {
      return resource.type === 'video' || resource.type === 'stream';
    }

    function isResolverPageResource(resource: DetectedResource): boolean {
      return resource.mimeType === 'application/x-fluxdown-resolver-page';
    }

    function resolverPageResourcesForTab(tab: string): DetectedResource[] {
      if (tab !== 'all' && tab !== 'video') return [];
      return resources.filter((resource) =>
        isResolverPageResource(resource) && !dismissedIds.has(resource.id));
    }

    function mediaCandidatesForTab(tab: string): MediaCandidate[] {
      if (tab !== 'all' && tab !== 'video' && tab !== 'stream') return [];
      const candidates = mediaCandidatesSnapshot();
      // 可见性规则（含 MSE 无清单页面的禁用汇总行）由 isMediaCandidateVisible
      // 单点定义，与 countMediaCandidateRows / popup 保持一致。
      return candidates.filter(
        (candidate) => isMediaCandidateVisible(candidate, candidates) && (tab === 'all' || candidate.type === tab),
      );
    }

    function mediaCandidatesSnapshot(): MediaCandidate[] {
      if (
        candidateCache &&
        candidateCache.resourceVersion === resourceVersion &&
        candidateCache.manifestVersion === manifestVersion &&
        candidateCache.resolverVersion === resolverVersion
      ) {
        return candidateCache.candidates;
      }
      let candidates = buildMediaCandidates(
        resources.filter((resource) => !isResolverPageResource(resource)),
        {
        pageTitle: document.title,
        pageUrl: location.href,
        fallbackTitle: t('panel.videoCandidate'),
        videoLabel: t('panel.videoIndex'),
        manifests: dashManifests,
        },
      );

      // IDM 式主路径：桌面 resolver/yt-dlp 一旦给出最终格式清单，就以这份
      // 权威清单取代浏览器嗅探出来的零碎媒体请求。这样 YouTube 会直接显示
      // 1080p/720p/480p...，而不是 f.txt / feed / googlevideo 分片噪声。
      if (resolverPreviewHref === resolverPageUrl() && resolverPreviewVariants.length > 0) {
        const orderedVariants = [...resolverPreviewVariants].sort((a, b) => {
          const byHeight = (b.height || 0) - (a.height || 0);
          if (byHeight !== 0) return byHeight;
          return (b.bandwidth || 0) - (a.bandwidth || 0);
        });
        const resolverCandidate: MediaCandidate = {
          id: `resolver:${location.href}`,
          title: resolverPreviewName || document.title || t('panel.videoCandidate'),
          type: 'video',
          source: 'direct',
          pageUrl: location.href,
          variants: orderedVariants.map((variant, index) => ({
            id: `resolver:${index}:${variant.label || 'variant'}`,
            label: variant.label || t('panel.qualityUnknown'),
            videoUrl: variant.url,
            audioUrl: variant.audioUrl || undefined,
            mimeType: variant.container ? `video/${variant.container}` : undefined,
            bandwidth: variant.bandwidth || undefined,
            fileSize: variant.size && variant.size > 0 ? variant.size : undefined,
            fileName: variant.fileName || undefined,
            headers: variant.headers,
          })),
          rawResourceIds: [],
          fragmentCount: 0,
          downloadable: true,
        };
        candidates = [resolverCandidate];
      }

      candidateCache = { resourceVersion, manifestVersion, resolverVersion, candidates };
      return candidates;
    }

    /** DASH 候选已经代表的原始轨道不再作为独立音频/视频资源重复展示。 */
    function aggregatedMediaResourceIds(): Set<string> {
      return new Set(
        mediaCandidatesSnapshot().flatMap((candidate) => candidate.rawResourceIds),
      );
    }

    function rawResourcesForTab(tab: string): DetectedResource[] {
      const base = tab === 'all'
        ? resources.filter((resource) => !isMediaResource(resource))
        : resources
          .filter((resource) => resource.type === tab)
          .filter((resource) => !isMediaResource(resource));
      const aggregatedIds = aggregatedMediaResourceIds();
      return dismissedIds.size > 0
        ? base.filter(
          (resource) =>
            !dismissedIds.has(resource.id) && !aggregatedIds.has(resource.id),
        )
        : base.filter((resource) => !aggregatedIds.has(resource.id));
    }

    function displayItemsForTab(tab: string): Array<DetectedResource | MediaCandidate> {
      const resolverPages = resolverPageResourcesForTab(tab);
      const hasResolvedVariants =
        resolverPreviewHref === resolverPageUrl() && resolverPreviewVariants.length > 0;
      if (hasResolvedVariants && (tab === 'all' || tab === 'video')) {
        // IDM-style default view: once the native resolver has a real format list,
        // the main panel is a clean quality picker. Raw page endpoints such as
        // f.txt / feed / playlists stay available in their explicit type tabs
        // instead of polluting the primary video list.
        return [...resolverPages, ...mediaCandidatesForTab(tab)];
      }
      // Resolver page 保留为当前完整视频/批量入口；底层播放流量不再完全丢弃，
      // 而是在 renderList 中作为“其他预载资源”折叠显示，便于高级用户检查。
      return [...resolverPages, ...mediaCandidatesForTab(tab), ...rawResourcesForTab(tab)];
    }

    function resourceRowsForTab(tab: string): ContentResourceRow[] {
      const rows: ContentResourceRow[] = [];
      for (const item of displayItemsForTab(tab)) {
        if ('downloadable' in item && item.variants.length > 0) {
          for (const variant of item.variants) {
            rows.push({ id: contentResourceRowId(item, variant), item, variant });
          }
        } else {
          rows.push({ id: item.id, item });
        }
      }
      return rows;
    }

    function selectableItems(): ContentResourceRow[] {
      return resourceRowsForTab(activeTab).filter(
        (row) => !('downloadable' in row.item) || row.item.downloadable,
      );
    }

    function selectedDownloadItems(): Array<Record<string, unknown>> {
      const items: Array<Record<string, unknown>> = [];
      for (const row of resourceRowsForTab(activeTab)) {
        if (!selectedIds.has(row.id)) continue;
        if ('downloadable' in row.item) {
          if (!row.item.downloadable || !row.variant) continue;
          items.push({
            url: row.variant.videoUrl,
            audioUrl: row.variant.audioUrl,
            referrer: row.item.pageUrl || location.href,
            filename: candidateFilename(row.item, row.variant),
            fileSize: row.variant.fileSize,
            mimeType: row.variant.mimeType,
            headers: row.variant.headers,
          });
        } else {
          items.push({
            url: row.item.url,
            referrer: row.item.pageUrl || location.href,
            filename: row.item.filename,
            fileSize: row.item.size > 0 ? row.item.size : undefined,
            mimeType: row.item.mimeType,
          });
        }
      }
      return items;
    }

    /* ================================================================
     *  视频浮动按钮
     * ================================================================ */

    /** 该 tab 已嗅探到的视频类资源，供浮标关联 blob/MSE 视频。 */
    function mediaResources(): DetectedResource[] {
      return resources.filter(
        (r) => r.type === 'video' || r.type === 'stream',
      );
    }

    function showFloat(video: HTMLVideoElement): void {
      if (!sniffEnabled || !showFloatingButtonSetting || !floatBtnEl) return;
      const rect = video.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 80) return;

      const src = video.currentSrc || video.src;
      const isBlob = !src || src.startsWith('blob:') || src.startsWith('data:');
      const media = mediaResources();

      // 直链视频 → 可直接下载；blob/MSE 视频 → 依赖嗅探到的媒体资源。
      // 两者皆无 → 无可下载源，不显示浮标。
      if (isBlob && media.length === 0) return;

      floatBtnEl.style.top = `${rect.top + 8}px`;
      floatBtnEl.style.left = `${rect.right - 110}px`;

      // 分辨率标签优先取播放器实际高度；取不到时回退到嗅探资源数量提示。
      const height = video.videoHeight;
      let label = t('panel.floatDL');
      if (height > 0) label = `${height}p`;
      else if (isBlob && media.length > 0) label = String(media.length);

      const lbl = floatBtnEl.querySelector('.label');
      if (lbl) lbl.textContent = label;
      floatBtnEl.classList.add('visible');
    }

    function hideFloat(): void {
      if (floatBtnEl) floatBtnEl.classList.remove('visible');
      hoverVideo = null;
    }

    /* ================================================================
     *  清晰度选择小窗（离散音视频轨对下载）
     * ================================================================ */

    /** 由权威 DASH manifest 构造清晰度选项：真清晰度（height/bandwidth），配对码率最高的音频轨。 */
    function qualityOptionsFromManifest(manifest: DashManifest): QualityOption[] {
      const filenameCandidate: MediaCandidate = {
        id: 'float-manifest',
        title: document.title || t('panel.videoCandidate'),
        type: 'stream',
        source: 'dash',
        pageUrl: location.href,
        variants: [],
        rawResourceIds: [],
        fragmentCount: 0,
        downloadable: true,
      };
      return selectQualityVideoTracks(manifest.video).map((v) => {
        const bestAudio = manifest.audio
          .filter((audio) => audio.downloadable !== false && (audio.periodId || '__default__') === (v.periodId || '__default__'))
          .reduce<DashManifest['audio'][number] | undefined>((best, cur) =>
            !best || (cur.bandwidth ?? 0) > (best.bandwidth ?? 0) ? cur : best, undefined);
        const kindLabel = bestAudio
          ? `${t('panel.trackVideo')} + ${t('panel.trackAudio')}`
          : t('panel.trackVideo');
        const rawQuality = v.height
          ? `${v.height}p`
          : v.bandwidth
            ? `${Math.round(v.bandwidth / 1000)}kbps`
            : '';
        const resolution = qualityResolutionLabel(rawQuality);
        const fps = qualityFrameRateLabel(v.frameRate);
        const quality = resolution
          ? fps ? `${resolution} ${fps}` : resolution
          : rawQuality || t('panel.qualityUnknown');

        return {
          quality,
          videoUrl: v.url,
          audioUrl: bestAudio?.url,
          sizeLabel: '',
          kindLabel,
          filename: candidateFilename(filenameCandidate, {
            id: `float:${v.id ?? v.url}`,
            label: quality,
            videoUrl: v.url,
            audioUrl: bestAudio?.url,
          }),
          mimeType: v.mimeType,
          fileSize: undefined,
        };
      });
    }

    function qualityOptionsFromTrackGroups(groups: TrackPairGroup[]): QualityOption[] {
      const filenameCandidate: MediaCandidate = {
        id: 'float-fragments',
        title: document.title || t('panel.videoCandidate'),
        type: 'stream',
        source: 'fragments',
        pageUrl: location.href,
        variants: [],
        rawResourceIds: [],
        fragmentCount: 0,
        downloadable: true,
      };
      return groups.map((group, index) => ({
        quality: group.quality || `${t('panel.videoIndex')} ${index + 1}`,
        videoUrl: group.videoUrl,
        audioUrl: group.audioUrl,
        sizeLabel: group.videoRes.size > 0 ? formatFileSize(group.videoRes.size) : '',
        kindLabel: group.audioUrl
          ? `${t('panel.trackVideo')} + ${t('panel.trackAudio')}`
          : t('panel.trackVideo'),
        filename: candidateFilename(filenameCandidate, {
          id: `float-fragment:${index}`,
          label: group.quality,
          videoUrl: group.videoUrl,
          audioUrl: group.audioUrl,
        }),
        mimeType: group.videoRes.mimeType,
        fileSize: group.videoRes.size > 0 ? group.videoRes.size : undefined,
      }));
    }

    function buildQualityPicker(root: HTMLElement): void {
      qualityPickerEl = h('div', 'fluxdown-quality-picker');
      root.appendChild(qualityPickerEl);
    }

    function hideQualityPicker(): void {
      if (qualityPickerEl) qualityPickerEl.classList.remove('visible');
      pendingQualityOptions = [];
    }

    /** 弹出清晰度选择小窗：列出各档真清晰度 + 大小/码率 + 轨道构成，选中后下载。 */
    function showQualityPicker(options: QualityOption[], anchorRect: DOMRect): void {
      if (!qualityPickerEl) return;
      pendingQualityOptions = options;

      const items = options.map((o, idx) => `<div class="qp-item" data-idx="${idx}">
          <div class="qp-main">
            <span class="qp-quality">${esc(o.quality)}</span>
            <span class="qp-size">${esc(o.sizeLabel)}</span>
          </div>
          <span class="qp-kind">${esc(o.kindLabel)}</span>
        </div>`).join('');

      qualityPickerEl.innerHTML = `
        <div class="qp-header">
          <span class="qp-title">${esc(t('panel.qualityPickerTitle'))}</span>
          <button type="button" class="qp-close">${svg(SVG_CLOSE)}</button>
        </div>
        <div class="qp-list">${items}</div>
      `;

      qualityPickerEl.querySelector('.qp-close')?.addEventListener('click', hideQualityPicker);
      qualityPickerEl.querySelectorAll<HTMLElement>('.qp-item').forEach((el) => {
        el.addEventListener('click', () => {
          const idx = Number(el.dataset.idx);
          const option = pendingQualityOptions[idx];
          if (option) downloadQualityOption(option);
          hideQualityPicker();
        });
      });

      // 定位到浮标附近，越界时回夹到视口内
      const width = 220;
      let left = anchorRect.right - width;
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      let top = anchorRect.top;
      top = Math.max(8, Math.min(top, window.innerHeight - 40));
      qualityPickerEl.style.left = `${left}px`;
      qualityPickerEl.style.top = `${top}px`;
      qualityPickerEl.classList.add('visible');
    }

    /** 发送单条轨道（或音视频轨对）下载请求给 background。 */
    function downloadQualityOption(option: QualityOption): void {
      void browser.runtime.sendMessage({
        action: 'downloadResource',
        url: option.videoUrl,
        audioUrl: option.audioUrl,
        referrer: location.href,
        filename: option.filename,
        fileSize: option.fileSize,
        mimeType: option.mimeType,
      }).catch(() => {});
    }

    /* ================================================================
     *  独立预览弹层（点击按钮触发；图片/视频直链/m4s 分片/hls/dash 按类型分发，
     *  原生播放失败一律诚实降级提示，禁止引入 hls.js）
     * ================================================================ */

    /** 仅这些类型显示预览按钮；document/archive/其他不可预览。 */
    function isPreviewable(r: DetectedResource): boolean {
      return (
        r.type === 'image' || r.type === 'video' || r.type === 'audio' || r.type === 'stream'
      );
    }

    type PreviewKind = 'image' | 'audio' | 'direct-video' | 'hls' | 'dash' | 'fragment' | 'unsupported';

    /** 按结构特征（type + URL 后缀）分发预览渲染方式，不做站点特判。 */
    function previewKind(r: DetectedResource): PreviewKind {
      const mime = r.mimeType?.toLowerCase() || '';
      const url = r.url.toLowerCase();
      if (r.type === 'image' || mime.startsWith('image/')) return 'image';
      if (r.type === 'stream') {
        if (url.includes('.m3u8')) return 'hls';
        if (url.includes('.mpd')) return 'dash';
        return 'fragment'; // m4s 等分片：单文件常缺 moov/init，原生播放大概率失败
      }
      if (r.type === 'audio') return 'audio';
      if (r.type === 'video') return 'direct-video';
      return 'unsupported';
    }

    function buildPreviewModal(root: HTMLElement): void {
      previewModalEl = h('div', 'fluxdown-preview-modal');
      previewModalEl.innerHTML = `
        <div class="fluxdown-preview-card">
          <div class="preview-header">
            <span class="preview-title"></span>
            <button type="button" class="preview-close" title="${t('panel.previewClose')}">${svg(SVG_CLOSE)}</button>
          </div>
          <div class="preview-body"></div>
        </div>
      `;
      // 点遮罩关闭；点卡片内部（含控件交互）不关闭
      previewModalEl.addEventListener('click', (e) => {
        if (e.target === previewModalEl) closePreview();
      });
      previewModalEl.querySelector('.preview-close')?.addEventListener('click', closePreview);
      root.appendChild(previewModalEl);
    }

    /** 用降级提示替换预览区内容（不黑屏、不假装能播放），并记录该资源预览失败。 */
    function showPreviewFallback(bodyEl: HTMLElement, message: string, failedId?: string): void {
      bodyEl.innerHTML = `<div class="preview-fallback">${esc(message)}</div>`;
      if (failedId && !previewFailedIds.has(failedId)) {
        previewFailedIds.add(failedId);
        render();
      }
    }

    /** 打开独立预览弹层：按资源类型分发渲染，原生播放失败诚实降级。 */
    function openPreview(r: DetectedResource): void {
      if (!previewModalEl) return;
      const titleEl = previewModalEl.querySelector('.preview-title') as HTMLElement;
      const bodyEl = previewModalEl.querySelector('.preview-body') as HTMLElement;
      titleEl.textContent = r.filename || tryDecodeUrl(r.url) || r.url;
      bodyEl.innerHTML = '';

      const kind = previewKind(r);
      if (kind === 'image') {
        const img = document.createElement('img');
        img.className = 'preview-media';
        img.addEventListener('load', () => {
          const hint = h('div', 'preview-hint');
          hint.textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
          bodyEl.appendChild(hint);
        });
        img.addEventListener('error', () => showPreviewFallback(bodyEl, t('panel.previewFailed'), r.id));
        img.src = r.url;
        bodyEl.appendChild(img);
      } else if (kind === 'audio') {
        const audio = document.createElement('audio');
        audio.className = 'preview-media';
        audio.controls = true;
        audio.addEventListener('error', () => showPreviewFallback(bodyEl, t('panel.previewFailed'), r.id));
        audio.src = r.url;
        bodyEl.appendChild(audio);
      } else if (kind === 'direct-video') {
        const video = document.createElement('video');
        video.className = 'preview-media';
        video.controls = true;
        video.autoplay = true;
        video.muted = true;
        video.addEventListener('error', () => showPreviewFallback(bodyEl, t('panel.previewFailed'), r.id));
        video.src = r.url;
        bodyEl.appendChild(video);
      } else if (kind === 'fragment' || kind === 'hls' || kind === 'dash') {
        // m4s 分片 / hls / dash：浏览器原生尝试，失败诚实降级（禁止引入 hls.js）
        const video = document.createElement('video');
        video.className = 'preview-media';
        video.controls = true;
        const fallbackMsg =
          kind === 'hls' ? t('panel.previewHlsUnsupported')
          : kind === 'dash' ? t('panel.previewDashUnsupported')
          : t('panel.previewFragmentUnsupported');
        video.addEventListener('error', () => showPreviewFallback(bodyEl, fallbackMsg));
        video.src = r.url;
        bodyEl.appendChild(video);
      } else {
        showPreviewFallback(bodyEl, t('panel.previewUnsupported'));
      }

      previewModalEl.classList.add('visible');
    }

    /** 关闭预览弹层，销毁 video/audio 元素释放资源（暂停 + 清空 src）。 */
    function closePreview(): void {
      if (!previewModalEl) return;
      previewModalEl.classList.remove('visible');
      const media = previewModalEl.querySelectorAll('video, audio');
      media.forEach((el) => {
        const m = el as HTMLMediaElement;
        m.pause();
        m.src = '';
        m.load();
      });
    }

    /* ================================================================
     *  工具
     * ================================================================ */

    /** 把主题模式应用到 shadow root 容器：'system' 移除属性（走 CSS media query 回退），
     *  'light'/'dark' 设 data-theme 属性。与 popup/main.ts 的 applyTheme 语义一致。 */
    function applyTheme(mode: unknown): void {
      if (!rootContainer) return;
      if (mode === 'light' || mode === 'dark') {
        rootContainer.setAttribute('data-theme', mode);
      } else {
        rootContainer.removeAttribute('data-theme');
      }
    }

    /** 初始化时从 storage.local 读取 popup 保存的主题并应用（默认 system）。 */
    async function applyThemeFromStorage(): Promise<void> {
      try {
        const res = await browser.storage.local.get(THEME_KEY);
        applyTheme(res?.[THEME_KEY] ?? 'system');
      } catch {
        /* storage 不可用则保持默认（CSS media query 回退） */
      }
    }

    function h(tag: string, cls: string): HTMLElement {
      const e = document.createElement(tag);
      e.className = cls;
      return e;
    }

    function esc(s: string): string {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function tryDecodeUrl(url: string): string {
      try {
        const seg = new URL(url).pathname.split('/').pop() || '';
        return decodeURIComponent(seg);
      } catch { return ''; }
    }
  },
});
