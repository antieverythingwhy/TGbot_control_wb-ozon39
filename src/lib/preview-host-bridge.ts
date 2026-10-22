/**
 * Гостевая сторона моста postMessage между grok-web и превью песочницы.
 *
 * Включается, только когда эта страница во фрейме разрешённого эмбеддера Grok.
 * Запуски верхнего уровня (скачивание/экспорт, локальный `npm run dev`, задеплоенные сайты) ничего не делают.
 */

import { z } from "zod";
import { CONNECTOR_TOKEN_READY_EVENT } from "./app-data/types";
import { resolveParentEmbedderOrigin } from "./preview-embedder-origin";

export {
  isGrokEmbedderOrigin,
  isSandboxPreviewGuestHost,
  resolveParentEmbedderOrigin,
} from "./preview-embedder-origin";

export const PREVIEW_BRIDGE_CHANNEL = "grok-preview-bridge" as const;
export const PREVIEW_BRIDGE_VERSION = 1 as const;

const EnvelopeSchema = z.object({
  channel: z.literal(PREVIEW_BRIDGE_CHANNEL),
  version: z.number().int().positive(),
  type: z.string().min(1),
});

const HelloSchema = EnvelopeSchema.extend({
  type: z.literal("hello"),
});

const NavigateSchema = EnvelopeSchema.extend({
  type: z.literal("navigate"),
  path: z.string().min(1),
});

const HistorySchema = EnvelopeSchema.extend({
  type: z.literal("history"),
  delta: z.union([z.literal(-1), z.literal(1)]),
});

const ConnectorTokenReadySchema = EnvelopeSchema.extend({
  type: z.literal("connector-token-ready"),
});

export type PreviewHostBridgeOptions = {
  /** Предпочитает роутер приложения, если он есть; иначе откатывается к history.pushState. */
  navigate?: (path: string) => void;
  /** Зарегистрированные пути для автоподсказок хоста, по возможности (список может быть пуст). */
  getRoutePaths?: () => string[];
};

export function isSafeBridgePath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    return false;
  }
  try {
    const resolved = new URL(path, "https://preview.invalid");
    return resolved.origin === "https://preview.invalid";
  } catch {
    return false;
  }
}

/**
 * Origin эмбеддера Grok, в чьём фрейме эта страница, или null, когда страница работает
 * на верхнем уровне (скачивание/экспорт, локальный `npm run dev`, задеплоенные сайты) или под
 * родителем не из Grok. Только на клиенте; null во время SSR.
 */
export function resolveCurrentEmbedderOrigin(): string | null {
  if (typeof window === "undefined") return null;
  const ancestorOrigin =
    typeof location.ancestorOrigins !== 'undefined' && location.ancestorOrigins.length > 0
      ? location.ancestorOrigins[0]
      : null;
  return resolveParentEmbedderOrigin(
    window.parent === window,
    document.referrer,
    ancestorOrigin,
    window.location.hostname,
  );
}

/**
 * Ставит обмен сообщениями хост↔гость. Возвращает функцию очистки.
 * Ничего не делает (возвращает пустую очистку), если страница не встроена под родителем Grok.
 */
export function installPreviewHostBridge(
  options: PreviewHostBridgeOptions = {},
): () => void {
  const parentOrigin = resolveCurrentEmbedderOrigin();
  if (parentOrigin === null) return () => {};

  const ROOT_STATE_KEY = "__grokPreviewBridgeRoot";
  const originalPushState = window.history.pushState.bind(window.history);
  const originalReplaceState = window.history.replaceState.bind(window.history);

  const isAtHistoryRoot = () => {
    const state = window.history.state;
    return Boolean(
      state && typeof state === "object" && state[ROOT_STATE_KEY] === true,
    );
  };

  // Пол для кнопки «Назад» в хроме: корнем считается только первая установка в свежем стеке истории.
  // Полные переходы документа заново ставят этот мост на глубоком URL; если бы мы
  // снова пометили эту запись как корень, «Назад» ничего бы не делал, хотя более ранняя история
  // внутри превью ещё есть. Сохраняем уже стоящую метку (bfcache / повторный монтаж SPA).
  try {
    const current = window.history.state;
    const alreadyTagged =
      current !== null &&
      typeof current === "object" &&
      Object.prototype.hasOwnProperty.call(current, ROOT_STATE_KEY);
    if (!alreadyTagged) {
      const isRoot = window.history.length <= 1;
      const marked =
        current && typeof current === "object"
          ? { ...current, [ROOT_STATE_KEY]: isRoot }
          : { [ROOT_STATE_KEY]: isRoot };
      originalReplaceState(marked, "", window.location.href);
    }
  } catch {
    // игнорируем, если документ нельзя пометить
  }

  const post = (message: object) => {
    window.parent.postMessage(message, parentOrigin);
  };

  const reportLocation = () => {
    post({
      channel: PREVIEW_BRIDGE_CHANNEL,
      version: PREVIEW_BRIDGE_VERSION,
      type: "location",
      path: window.location.pathname || "/",
      search: window.location.search,
      hash: window.location.hash,
    });
  };

  const reportRoutes = () => {
    const paths = options.getRoutePaths?.() ?? [];
    post({
      channel: PREVIEW_BRIDGE_CHANNEL,
      version: PREVIEW_BRIDGE_VERSION,
      type: "routes",
      paths,
    });
  };

  const defaultNavigate = (path: string) => {
    if (!isSafeBridgePath(path)) return;
    try {
      const url = new URL(path, window.location.origin);
      if (url.origin !== window.location.origin) return;
      const next = `${url.pathname}${url.search}${url.hash}`;
      window.history.pushState(window.history.state, "", next);
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    } catch {
      // игнорируем некорректные пути
    }
  };

  const navigate = (path: string) => {
    if (!isSafeBridgePath(path)) return;
    if (options.navigate) {
      options.navigate(path);
      return;
    }
    defaultNavigate(path);
  };

  const announce = () => {
    reportLocation();
    reportRoutes();
    post({
      channel: PREVIEW_BRIDGE_CHANNEL,
      version: PREVIEW_BRIDGE_VERSION,
      type: "ready",
    });
  };

  // Повторное рукопожатие хоста: он мог (пере)смонтироваться после нашего объявления
  // при установке или спросить до гидратации. Объявляем ещё раз.
  const onHello = (data: unknown) => {
    if (!HelloSchema.safeParse(data).success) return;
    announce();
  };

  const onNavigate = (data: unknown) => {
    const parsed = NavigateSchema.safeParse(data);
    if (!parsed.success) return;
    navigate(parsed.data.path);
    // Навигации роутера часто обновляют location асинхронно; сообщаем после тика.
    queueMicrotask(reportLocation);
  };

  const onHistory = (data: unknown) => {
    const parsed = HistorySchema.safeParse(data);
    if (!parsed.success) return;
    // Не вызываем history.go(-1) с первой записи — это уводит из превью.
    if (parsed.data.delta === -1 && isAtHistoryRoot()) return;
    // Синхронизация location приходит из слушателя popstate, когда история устоится.
    window.history.go(parsed.data.delta);
  };

  const onConnectorTokenReady = (data: unknown) => {
    if (!ConnectorTokenReadySchema.safeParse(data).success) return;
    window.dispatchEvent(new Event(CONNECTOR_TOKEN_READY_EVENT));
  };

  const hostMessageHandlers = new Map<string, (data: unknown) => void>([
    ["hello", onHello],
    ["navigate", onNavigate],
    ["history", onHistory],
    ["connector-token-ready", onConnectorTokenReady],
  ]);

  const onMessage = (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    if (event.origin !== parentOrigin) return;

    const envelope = EnvelopeSchema.safeParse(event.data);
    if (!envelope.success || envelope.data.version !== PREVIEW_BRIDGE_VERSION) return;
    hostMessageHandlers.get(envelope.data.type)?.(event.data);
  };

  const onPopState = () => {
    reportLocation();
  };

  // Переходы по `#` в том же документе порождают hashchange, а не popstate / pushState.
  const onHashChange = () => {
    reportLocation();
  };

  // Патчим history, чтобы навигации SPA внутри приложения синхронизировали адресную строку хоста.
  window.history.pushState = (data, unused, url) => {
    const next =
      data && typeof data === "object"
        ? { ...data, [ROOT_STATE_KEY]: false }
        : data;
    originalPushState(next, unused, url);
    reportLocation();
  };
  window.history.replaceState = (data, unused, url) => {
    const next =
      isAtHistoryRoot()
        ? {
            ...(data && typeof data === "object" ? data : {}),
            [ROOT_STATE_KEY]: true,
          }
        : data;
    originalReplaceState(next, unused, url);
    reportLocation();
  };

  window.addEventListener("message", onMessage);
  window.addEventListener("popstate", onPopState);
  window.addEventListener("hashchange", onHashChange);

  announce();

  return () => {
    window.removeEventListener("message", onMessage);
    window.removeEventListener("popstate", onPopState);
    window.removeEventListener("hashchange", onHashChange);
    window.history.pushState = originalPushState;
    window.history.replaceState = originalReplaceState;
  };
}

/** Собирает статические шаблоны путей из дерева маршрутов TanStack (по возможности). */
export function collectRoutePathsFromTree(routeTree: unknown): string[] {
  const paths = new Set<string>();

  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as {
      fullPath?: unknown;
      path?: unknown;
      children?: unknown;
    };
    const full =
      typeof record.fullPath === "string"
        ? record.fullPath
        : typeof record.path === "string"
          ? record.path
          : null;
    if (full !== null && full !== "") {
      paths.add(full.startsWith("/") ? full : `/${full}`);
    } else if (full === "") {
      paths.add("/");
    }
    const children = record.children;
    if (Array.isArray(children)) {
      for (const child of children) walk(child);
    } else if (children && typeof children === "object") {
      for (const child of Object.values(children as Record<string, unknown>)) {
        walk(child);
      }
    }
  };

  walk(routeTree);
  return [...paths];
}
