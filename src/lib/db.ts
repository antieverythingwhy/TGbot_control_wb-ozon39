import { pendingMigrations } from "../../scripts/migration-plan.mjs";

/** Какой бэкенд базы данных активен. */
export type DbSource = "neon" | "pglite";

// Пустой или из одних пробелов DATABASE_URL (частая ошибка настройки в UI деплоя) должен означать
// «не задан» — иначе продакшен молча работал бы на запасном PGLite.
const rawDatabaseUrl =
  typeof process !== "undefined" ? process.env.DATABASE_URL : undefined;
const databaseUrl =
  rawDatabaseUrl && rawDatabaseUrl.trim() ? rawDatabaseUrl : undefined;

/**
 * Активный бэкенд: настоящий **Neon**, когда задан `DATABASE_URL` (задеплоенная / настроенная
 * песочница), иначе локальный встроенный **PGLite** (Postgres, скомпилированный в WASM), чтобы
 * у приложения была рабочая база даже без настройки — включая живое превью.
 * Позже переключиться на Neon можно, просто задав `DATABASE_URL`; код менять не нужно.
 */
export const dbSource: DbSource = databaseUrl ? "neon" : "pglite";

/**
 * Минимальный общий SQL-интерфейс, который дают и Neon, и PGLite. И форма
 * с теговым шаблоном, и `.query()` возвращают массив объектов-строк:
 *
 *   const sql = await getSql();
 *   const rows = await sql`select * from todos where id = ${id}`; // параметризованный
 *   const rows2 = await sql.query("select * from todos where id = $1", [id]);
 */
export interface Sql {
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
}

/**
 * Состояние инициализации живёт на globalThis в виде промисов: HMR в разработке создаёт новые экземпляры
 * этого модуля, и гонка двух экземпляров за состоянием уровня модуля открыла бы второй
 * пул или запустила два параллельных прохода миграций PGLite (повторная вставка в
 * `_migrations` отклоняется — и была бы запомнена, отравляя каждый последующий
 * `getSql()`). Неудачная инициализация очищает свой слот, чтобы следующий вызов повторил попытку.
 */
const globalRef = globalThis as typeof globalThis & {
  __pgSqlPromise__?: Promise<Sql>;
  __pgliteInstance__?: Promise<import("@electric-sql/pglite").PGlite>;
  __pgliteMigrateChain__?: Promise<void>;
};

/**
 * Согласованность типов результата: Postgres передаёт каждое значение текстом плюс OID типа —
 * JS-значение выбирает ДРАЙВЕР при разборе, и pg с PGLite расходятся (pg:
 * int8 -> string, date -> Date на локальной полуночи; PGLite: int8 -> BigInt, который
 * JSON.stringify отвергает, date -> Date в UTC). Нормализуем оба, чтобы превью и
 * продакшен возвращали одинаковые, безопасные для JSON формы:
 *   int8/bigint (включая count(*)) -> number (за 2^53 точность теряется — приведите
 *                                   к `::text`, если когда-нибудь понадобятся огромные целые)
 *   date                         -> строка 'YYYY-MM-DD'
 *   interval                     -> текст интервала Postgres
 * numeric и так приходит строкой в обоих (произвольная точность).
 */
const OID_INT8 = 20;
const OID_DATE = 1082;
const OID_INTERVAL = 1186;
const identity = (v: string) => v;

type Run = <T>(text: string, params: unknown[]) => Promise<T[]>;

/** Оборачивает исполнитель запросов в поверхность `Sql` с теговым шаблоном и `.query()`. */
function toSql(run: Run): Sql {
  const sql = (async <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    // Собираем заново с плейсхолдерами $1, $2, …, чтобы значения оставались параметризованными.
    let text = strings[0];
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
    return run<T>(text, values);
  }) as unknown as Sql;
  sql.query = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    run<T>(text, params);
  return sql;
}

function createNeonSql(): Promise<Sql> {
  globalRef.__pgSqlPromise__ ??= (async () => {
    // Обычный драйвер Postgres: node-postgres (`pg`) — работает напрямую с пуловым
    // эндпоинтом Neon. Один пул на процесс; прогретые serverless-инстансы его переиспользуют.
    const { Pool, types } = await import("pg");
    types.setTypeParser(OID_INT8, Number);
    types.setTypeParser(OID_DATE, identity);
    types.setTypeParser(OID_INTERVAL, identity);
    const pool = new Pool({ connectionString: databaseUrl });
    return toSql(async <T>(text: string, params: unknown[]) => {
      const res = await pool.query(text, params);
      return res.rows as T[];
    });
  })().catch((err) => {
    globalRef.__pgSqlPromise__ = undefined;
    throw err;
  });
  return globalRef.__pgSqlPromise__;
}

async function createPgliteSql(): Promise<Sql> {
  // Встроенный Postgres, импортируется по требованию, чтобы не грузиться на пути Neon.
  // Один экземпляр в памяти на процесс, общий для экземпляров модуля при HMR, поэтому
  // данные переживают правки исходников (сбрасываются при перезапуске dev-сервера).
  globalRef.__pgliteInstance__ ??= (async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = new PGlite({
      parsers: {
        [OID_INT8]: Number,
        [OID_DATE]: identity,
        [OID_INTERVAL]: identity,
      },
    });
    await pg.waitReady;
    await pg.exec(
      "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    return pg;
  })().catch((err) => {
    globalRef.__pgliteInstance__ = undefined;
    throw err;
  });
  const pg = await globalRef.__pgliteInstance__;

  // Применяем migrations/ (единственный источник схемы), чтобы превью совпадало с продакшеном.
  // SQL встраивает бандлер через import.meta.glob (без fs в рантайме); применённые
  // файлы учитываются в _migrations. Glob не спускается в подкаталоги, поэтому опциональная
  // схема auth в migrations/auth/ не попадает. Запускается один раз на экземпляр модуля
  // — поэтому перезагрузка HMR после добавления файла миграции применяет его сразу — а
  // проходы выстроены в глобальную цепочку, чтобы параллельные вызывающие никогда
  // не применяли миграции дважды.
  const migrate = async (): Promise<void> => {
    const migrations = import.meta.glob("/migrations/*.sql", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const doneRows = await pg.query<{ name: string }>(
      "select name from _migrations",
    );
    const done = doneRows.rows.map((r) => r.name);
    for (const { name, path } of pendingMigrations(Object.keys(migrations), done)) {
      // Применяем и записываем атомарно (как в scripts/migrate.mjs), чтобы упавший
      // оператор не оставил файл наполовину применённым, но неучтённым.
      await pg.transaction(async (tx) => {
        await tx.exec(migrations[path]);
        await tx.query("insert into _migrations (name) values ($1)", [name]);
      });
    }
  };
  const pass = (globalRef.__pgliteMigrateChain__ ?? Promise.resolve())
    .catch(() => undefined) // более ранний неудачный проход не должен заклинить цепочку
    .then(migrate);
  globalRef.__pgliteMigrateChain__ = pass;
  await pass;

  return toSql(async <T>(text: string, params: unknown[]) => {
    const result = await pg.query<T>(text, params);
    return result.rows;
  });
}

let sqlPromise: Promise<Sql> | null = null;

async function createSql(): Promise<Sql> {
  if (typeof window !== "undefined") {
    throw new Error(
      "@/lib/db is server-only — call getSql() from a createServerFn handler " +
        "or a server route loader, never from client code.",
    );
  }
  return dbSource === "neon" ? createNeonSql() : createPgliteSql();
}

/**
 * Общий, **только серверный** SQL-клиент. Neon, когда задан `DATABASE_URL`,
 * иначе локальный запасной PGLite. Результат запоминается — безопасно вызывать на каждый запрос.
 *
 * Схема берётся из `migrations/*.sql` и сама применяется до первого запроса на
 * обоих бэкендах — таблицы описывайте там, а не прямо в серверных функциях.
 */
export function getSql(): Promise<Sql> {
  sqlPromise ??= createSql().catch((err) => {
    sqlPromise = null; // не запоминаем неудачи — пусть следующий вызов повторит попытку
    throw err;
  });
  return sqlPromise;
}

/**
 * Общий экземпляр PGLite (только превью) с уже применёнными `migrations/*.sql`.
 * Позволяет Better Auth писать в ТУ ЖЕ встроенную БД, что и данные приложения в превью (через
 * диалект Kysely). Бросает ошибку, когда задан `DATABASE_URL` (этот путь использует Neon).
 */
export async function getPglite(): Promise<import("@electric-sql/pglite").PGlite> {
  if (dbSource !== "pglite") {
    throw new Error("getPglite() is only available on the PGLite fallback (no DATABASE_URL)");
  }
  await getSql();
  const pg = await globalRef.__pgliteInstance__;
  if (!pg) throw new Error("PGLite instance failed to initialize");
  return pg;
}

/**
 * Заканчивает подготовку БД до того, как сервер начнёт принимать трафик.
 *
 * - **PGLite** (превью / нет `DATABASE_URL`): открыть БД в памяти и применить
 *   `migrations/*.sql`. Идемпотентно — параллельные вызывающие делят один промис.
 * - **Neon**: пустая операция (пул создаётся лениво при первом запросе).
 *
 * Vite `configureServer` ждёт это при старте в разработке; продакшен-импорты этого
 * модуля запускают подготовку сразу (см. конец файла).
 */
export function ensureDbReady(): Promise<void> {
  if (dbSource !== "pglite") return Promise.resolve();
  return getSql().then(() => undefined);
}

// Ранний старт только на сервере: запускаем подготовку PGLite, как только этот модуль загрузится в
// Node. Клиентские бандлы на этот путь не попадают (`getSql` бросает ошибку в браузере).
const globalBoot = globalThis as typeof globalThis & {
  __pgBootstrapPromise__?: Promise<void>;
};
if (typeof window === "undefined" && dbSource === "pglite") {
  globalBoot.__pgBootstrapPromise__ ??= ensureDbReady().catch((err) => {
    globalBoot.__pgBootstrapPromise__ = undefined;
    console.error("[db] PGLite bootstrap failed:", err);
    throw err;
  });
}
