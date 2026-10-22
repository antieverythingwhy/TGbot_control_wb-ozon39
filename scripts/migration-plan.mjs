// @ts-check
/**
 * Учёт миграций, общий для двух применяющих — `scripts/migrate.mjs`
 * (деплой, `readdir`) и `src/lib/db.ts` (превью PGLite, `import.meta.glob`).
 *
 * Применённые файлы ключуются по BASENAME, поэтому один и тот же файл применяется один раз
 * независимо от того, из какого каталога его глобят. Поэтому схему auth безопасно
 * копировать из `migrations/auth/` в `migrations/`, когда приложение включает вход:
 * база, в которой уже есть `0001_auth.sql`, не прогонит его снова.
 *
 * Ни один применяющий не спускается в подкаталоги, поэтому `migrations/auth/*.sql`
 * вне охвата обоих, пока файл не скопирован наверх.
 */

/**
 * Ключ `_migrations` для пути миграции (или голого имени файла).
 * @param {string} path
 * @returns {string}
 */
export function migrationName(path) {
  return path.split("/").pop() ?? path;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isMigrationFile(path) {
  return path.endsWith(".sql");
}

/**
 * Миграции из `paths`, которых ещё нет в `applied`, в порядке применения.
 * Записи не `.sql` (`readdir` также отдаёт `migrations/auth/`) отбрасываются.
 * @param {Iterable<string>} paths
 * @param {Iterable<string>} applied
 * @returns {Array<{ name: string, path: string }>}
 */
export function pendingMigrations(paths, applied) {
  const done = new Set(applied);
  return [...paths]
    .filter(isMigrationFile)
    .map((path) => ({ name: migrationName(path), path }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter(({ name }) => !done.has(name));
}
