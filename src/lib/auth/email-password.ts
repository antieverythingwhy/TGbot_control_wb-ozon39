/**
 * Локальный вход по email/паролю (БД Better Auth этого приложения — не брокер).
 *
 * По умолчанию выключено. Чтобы включить: поставьте `emailAndPasswordEnabled` в `true` ниже,
 * затем соберите формы регистрации / входа через `authClient.signUp.email` /
 * `authClient.signIn.email` из `@/lib/auth/client` (см. skill auth).
 *
 * НЕ правьте для этого `server.ts` — этот файл заморожен как заранее подключённый конфиг.
 */
export const emailAndPasswordEnabled = false;
