/**
 * Upstream-провайдеры личности, которые это приложение предлагает для входа (через брокер).
 *
 * Источник истины И для сервера (`server.ts`, один провайдер `genericOAuth`
 * на запись), И для клиента (`client.ts` / кнопки входа). Вынесен в собственный
 * модуль без зависимостей, чтобы клиент мог импортировать его, не таща
 * только-серверный экземпляр Better Auth (и `pg`) в браузерный бандл.
 *
 * Каждое приложение федеративно ходит к общему **брокеру аутентификации** (`GROK_AUTH_ISSUER`), который
 * хранит настоящие секреты Google/X. Приложение их никогда не видит — оно знает только
 * свой client id/secret на приложение и какой upstream попросить у брокера (`idp`).
 *
 * Чтобы добавить upstream (напр. GitHub), когда брокер это поддержит: добавьте одну запись
 * сюда (`{ providerId: "grok-github", idp: "github", label: "GitHub" }`).
 * `providerId` — локальный id этого приложения и сегмент пути OAuth callback
 * (`/api/auth/oauth2/callback/<providerId>`); `idp` — подсказка, которую читает брокер,
 * чтобы выбрать upstream (id Better Auth для X по-прежнему `twitter`).
 */
export type GrokProvider = {
  /** Локальный id провайдера этого приложения; также сегмент пути callback. */
  providerId: string;
  /** Подсказка upstream, куда брокер пересылает (social id Better Auth). */
  idp: string;
  /** Человекочитаемая подпись для кнопки входа. */
  label: string;
};

export const GROK_PROVIDERS: readonly GrokProvider[] = [
  { providerId: "grok-google", idp: "google", label: "Google" },
  { providerId: "grok-x", idp: "twitter", label: "X" },
];
