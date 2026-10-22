export function env(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v || undefined;
}

/**
 * Превью воркспейса против задеплоенного приложения. Деплоер пишет GROK_PROJECT_ID при
 * каждой публикации; у превью песочницы его никогда нет. Единый источник истины для
 * этого разделения — аудитория гейта, эндпоинты гейта и смысл токена коннектора
 * все завязаны на этот предикат.
 */
export function isWorkspacePreview(): boolean {
  return !env("GROK_PROJECT_ID");
}
