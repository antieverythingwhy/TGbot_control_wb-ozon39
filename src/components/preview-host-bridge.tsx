/**
 * Монтируется один раз в `__root.tsx`, чтобы хром превью Grok мог вести навигацию
 * (и позже получать зарегистрированные маршруты). Ничего не делает, если приложение не встроено.
 */

import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  collectRoutePathsFromTree,
  installPreviewHostBridge,
} from "@/lib/preview-host-bridge";

export function PreviewHostBridge() {
  const router = useRouter();

  useEffect(() => {
    return installPreviewHostBridge({
      navigate: (path) => {
        router.history.push(path);
      },
      getRoutePaths: () => collectRoutePathsFromTree(router.routeTree),
    });
  }, [router]);

  return null;
}
