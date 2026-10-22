// Оболочка мини-приложения. После входа всегда открывается вкладка «Главная».
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  Bell,
  CalendarDays,
  House,
  LayoutDashboard,
  LogOut,
  MapPin,
  Moon,
  Package,
  Phone,
  Sun,
  TriangleAlert,
  Users,
} from "lucide-react";
import { Toaster, toast } from "sonner";
import "sonner/dist/styles.css";
import { call, loginFn, loginTelegramFn, logoutFn } from "@/lib/pvz/api";
import type { Workspace } from "@/lib/pvz/types";
import { roleLabel } from "@/lib/pvz/types";
import {
  CheckPage,
  ContactPage,
  ControlPage,
  HomePage,
  InboxPage,
  IssuePage,
  PointsPage,
  SchedulePage,
  StaffPage,
  SuppliesPage,
} from "./pages";
import { pointName, roleCan, type Gate, type Page } from "./shared";

const NAV: { id: Page; label: string; icon: typeof House; leader?: boolean }[] = [
  { id: "home", label: "Главная", icon: House },
  { id: "opening", label: "Открытие", icon: Sun },
  { id: "closing", label: "Закрытие", icon: Moon },
  { id: "schedule", label: "График", icon: CalendarDays },
  { id: "issue", label: "Проблема", icon: TriangleAlert },
  { id: "contact", label: "Связь", icon: Phone },
  { id: "supplies", label: "Хозтовары", icon: Package },
  { id: "inbox", label: "Уведомления", icon: Bell },
  { id: "control", label: "Контроль", icon: LayoutDashboard, leader: true },
  { id: "staff", label: "Сотрудники", icon: Users, leader: true },
  { id: "points", label: "Пункты", icon: MapPin, leader: true },
];

const DEMOS = [
  { username: "elena_petrova", name: "Елена Петрова", role: "Руководитель" },
  { username: "anna_smirnova", name: "Анна Смирнова", role: "Администратор" },
  { username: "ivan_petrov", name: "Иван Петров", role: "Сотрудник" },
];

export function App() {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: 60_000 } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <Cabinet />
      <Toaster position="top-center" />
    </QueryClientProvider>
  );
}

function Cabinet() {
  const [mounted, setMounted] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [page, setPage] = useState<Page>("home");
  const [pointId, setPointId] = useState<string | null>(null);
  const [shiftId, setShiftId] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    setToken(localStorage.getItem("pvz.token"));
    setMounted(true);
  }, []);

  const query = useQuery({
    queryKey: ["workspace"],
    enabled: mounted && Boolean(token),
    queryFn: () => call<Workspace>("workspace"),
  });

  useEffect(() => {
    if (!query.error) return;
    const message = query.error instanceof Error ? query.error.message : "";
    if (message.includes("Войдите") || message.includes("приглаш")) {
      localStorage.removeItem("pvz.token");
      setToken(null);
    }
  }, [query.error]);

  useEffect(() => {
    const ws = query.data;
    if (!ws) return;
    setPointId((current) => {
      if (current && ws.points.some((point) => point.id === current)) return current;
      const saved = localStorage.getItem("pvz.point");
      if (saved && ws.points.some((point) => point.id === saved)) return saved;
      return ws.points[0]?.id ?? null;
    });
  }, [query.data]);

  async function act<T>(action: string, payload?: Record<string, unknown>): Promise<T | null> {
    setBusy(true);
    try {
      const data = await call<T>(action, payload);
      await qc.invalidateQueries();
      return data;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось выполнить действие");
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (!mounted) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
        <p className="text-sm font-semibold text-accent">ПВЗ</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Рабочий кабинет</h1>
        <p className="mt-2 text-muted">Загрузка…</p>
      </main>
    );
  }

  if (!token) {
    return (
      <Login
        onSuccess={(next) => {
          localStorage.setItem("pvz.token", next);
          setToken(next);
          setPage("home");
        }}
      />
    );
  }

  if (query.data && query.data.points.length === 0) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
        <h1 className="text-2xl font-semibold">Нет доступных пунктов</h1>
        <p className="mt-2 text-sm text-muted">Попросите руководителя закрепить пункт за вашим профилем.</p>
      </main>
    );
  }

  if (query.isLoading || !query.data || !pointId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
        <h1 className="text-2xl font-semibold">Открываем главную…</h1>
        {query.error ? <p className="mt-2 text-sm text-bad">{query.error instanceof Error ? query.error.message : "Ошибка загрузки"}</p> : null}
      </main>
    );
  }

  const ws = query.data;
  const gate: Gate = {
    ws,
    pointId,
    setPage,
    shiftId,
    setShiftId,
    act,
    busy,
  };
  const items = NAV.filter((item) => !item.leader || ws.me.role !== "employee");
  const current = roleCan(ws.me.role, page) ? page : "home";

  function choosePoint(id: string) {
    setPointId(id);
    setShiftId(null);
    localStorage.setItem("pvz.point", id);
  }

  function open(id: Page) {
    setPage(id);
    setMore(false);
    if (id === "inbox" && ws.unread) void act("markRead");
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-control bg-accent text-sm font-semibold text-accent-fg">П</div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">ПВЗ · {ws.me.name}</p>
            <p className="truncate text-xs text-muted">{roleLabel(ws.me.role)}</p>
          </div>
          <label className="ml-auto min-w-0 flex-1 text-xs text-muted sm:max-w-xs">
            <span className="sr-only">Текущий пункт</span>
            <select className="h-11 w-full rounded-control border border-line bg-card px-2 text-sm text-ink" value={pointId} onChange={(event) => choosePoint(event.target.value)}>
              {ws.points.map((point) => (
                <option key={point.id} value={point.id}>
                  {point.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="relative grid h-11 w-11 place-items-center rounded-control border border-line" onClick={() => open("inbox")} aria-label="Уведомления">
            <Bell className="h-5 w-5" />
            {ws.unread ? <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-bad px-1 text-[10px] font-semibold text-accent-fg">{ws.unread}</span> : null}
          </button>
          <button
            type="button"
            className="grid h-11 w-11 place-items-center rounded-control border border-line"
            aria-label="Выйти"
            onClick={async () => {
              try {
                await logoutFn();
              } catch {
                /* сессия уже недействительна */
              }
              localStorage.removeItem("pvz.token");
              qc.clear();
              setToken(null);
              setPage("home");
            }}
          >
            <LogOut className="h-5 w-5" />
          </button>
        </div>
      </header>
      <div className="mx-auto flex max-w-6xl">
        <aside className="sticky top-16 hidden h-[calc(100vh-4rem)] w-56 shrink-0 overflow-auto p-3 md:block">
          <nav className="grid gap-1">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={current === item.id ? "page" : undefined}
                className={`flex h-11 items-center gap-2 rounded-control px-3 text-left text-sm ${current === item.id ? "bg-accent-soft font-semibold text-accent" : "text-ink"}`}
                onClick={() => open(item.id)}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </button>
            ))}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 p-4 pb-24 md:pb-8">
          {current === "home" ? <HomePage {...gate} /> : null}
          {current === "opening" ? <CheckPage gate={gate} type="opening" /> : null}
          {current === "closing" ? <CheckPage gate={gate} type="closing" /> : null}
          {current === "schedule" ? <SchedulePage {...gate} /> : null}
          {current === "issue" ? <IssuePage {...gate} /> : null}
          {current === "contact" ? <ContactPage {...gate} /> : null}
          {current === "supplies" ? <SuppliesPage key={pointId} {...gate} /> : null}
          {current === "inbox" ? <InboxPage {...gate} /> : null}
          {current === "control" ? <ControlPage {...gate} /> : null}
          {current === "staff" ? <StaffPage {...gate} /> : null}
          {current === "points" ? <PointsPage {...gate} /> : null}
        </main>
      </div>
      <nav className="dock fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-line bg-card md:hidden">
        {items.slice(0, 4).map((item) => (
          <button key={item.id} type="button" className={`flex flex-col items-center gap-1 py-2 text-[11px] ${current === item.id ? "font-semibold text-accent" : "text-muted"}`} onClick={() => open(item.id)}>
            <item.icon className="h-5 w-5" />
            {item.label}
          </button>
        ))}
        <button type="button" className="flex flex-col items-center gap-1 py-2 text-[11px] text-muted" onClick={() => setMore(true)}>
          <span className="text-base leading-none">···</span>
          Ещё
        </button>
      </nav>
      {more ? (
        <div className="fixed inset-0 z-30 bg-ink/40 md:hidden" onClick={() => setMore(false)}>
          <div className="absolute inset-x-0 bottom-0 rounded-t-panel bg-card p-4" onClick={(event) => event.stopPropagation()}>
            <p className="mb-2 text-sm font-semibold">{pointName(ws, pointId)}</p>
            <div className="grid gap-1">
              {items.slice(4).map((item) => (
                <button key={item.id} type="button" className="flex h-11 items-center gap-2 rounded-control px-2 text-left text-sm" onClick={() => open(item.id)}>
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type TelegramWindow = Window & {
  Telegram?: { WebApp?: { initData?: string; ready?: () => void; expand?: () => void } };
};

function Login({ onSuccess }: { onSuccess: (token: string) => void }) {
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  // wait — ищем Telegram; telegram — бот сам назвал человека; manual — форма только на своём компьютере; bot — чужой браузер.
  const [gate, setGate] = useState<"wait" | "telegram" | "manual" | "bot">("wait");
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  useEffect(() => {
    let cancelled = false;
    async function enterTelegram(initData: string) {
      setGate("telegram");
      setPending(true);
      setError("");
      try {
        const result = await loginTelegramFn({ data: { initData } });
        if (cancelled) return;
        if (!result.ok) {
          setError(result.error);
          return;
        }
        onSuccessRef.current(result.token);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Не удалось войти через Telegram");
      } finally {
        if (!cancelled) setPending(false);
      }
    }
    function attach(webApp: NonNullable<TelegramWindow["Telegram"]>["WebApp"]) {
      if (!webApp?.initData) return false;
      webApp.ready?.();
      webApp.expand?.();
      void enterTelegram(webApp.initData);
      return true;
    }
    if (attach((window as TelegramWindow).Telegram?.WebApp)) {
      return () => {
        cancelled = true;
      };
    }
    const openedFromTelegram = /Telegram/i.test(navigator.userAgent);
    if (!openedFromTelegram) {
      setGate(import.meta.env.DEV ? "manual" : "bot");
      return;
    }
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-web-app.js";
    script.async = true;
    script.onload = () => {
      if (cancelled) return;
      if (!attach((window as TelegramWindow).Telegram?.WebApp)) {
        setGate(import.meta.env.DEV ? "manual" : "bot");
      }
    };
    script.onerror = () => {
      if (!cancelled) setGate(import.meta.env.DEV ? "manual" : "bot");
    };
    document.head.appendChild(script);
    return () => {
      cancelled = true;
    };
  }, []);

  async function enter(value: string) {
    setPending(true);
    setError("");
    try {
      const result = await loginFn({ data: { username: value } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onSuccess(result.token);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось войти");
    } finally {
      setPending(false);
    }
  }

  if (gate === "wait" || gate === "telegram") {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
        <p className="text-sm font-semibold text-accent">Пункты выдачи</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Открываем кабинет…</h1>
        <p className="mt-3 text-sm text-muted">Telegram сам называет, кто нажал кнопку. Юзернейм вводить не нужно.</p>
        {error ? <p className="mt-3 text-sm text-bad">{error}</p> : null}
      </main>
    );
  }

  if (gate === "bot") {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
        <p className="text-sm font-semibold text-accent">Пункты выдачи</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Откройте кабинет из бота</h1>
        <p className="mt-3 text-sm text-muted">
          Поле с юзернеймом здесь закрыто. Войти можно только кнопкой в Telegram: бот передаёт подписанные данные вашего аккаунта, чужой юзернейм подставить нельзя.
        </p>
        {error ? <p className="mt-3 text-sm text-bad">{error}</p> : null}
      </main>
    );
  }

  return (
    <main className="mx-auto grid min-h-screen max-w-5xl items-center gap-8 px-5 py-10 md:grid-cols-2">
      <section className="order-2 md:order-1">
        <p className="text-sm font-semibold text-accent">Пункты выдачи</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">Рабочий кабинет</h1>
        <p className="mt-3 max-w-md text-muted">
          Вход только по приглашению. Юзернейм заранее записывают в кабинете. Уведомления приходят от бота после команды /start.
        </p>
      </section>
      <form
        className="order-1 rounded-panel border border-line bg-card p-5 shadow-sm md:order-2"
        onSubmit={(event) => {
          event.preventDefault();
          void enter(username);
        }}
      >
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Telegram ID
          <input
            className="h-11 rounded-control border border-line px-3"
            value={username}
            placeholder="@username"
            autoComplete="username"
            onChange={(event) => setUsername(event.target.value)}
          />
          <span className="text-xs font-normal text-muted">Поле называется Telegram ID, но принимается юзернейм, например @ivan_petrov.</span>
        </label>
        {error ? <p className="mt-3 text-sm text-bad">{error}</p> : null}
        <button type="submit" className="mt-4 h-11 w-full rounded-control bg-accent text-sm font-semibold text-accent-fg disabled:opacity-40" disabled={pending}>
          {pending ? "Проверяем приглашение…" : "Войти"}
        </button>
        <div className="mt-5 grid gap-2">
          <p className="text-xs text-muted">Учебные профили. В пустом кабинете для запуска их нет — входите юзернеймом iwannabenever.</p>
          {DEMOS.map((demo) => (
            <button
              key={demo.username}
              type="button"
              className="flex h-11 items-center justify-between rounded-control border border-line px-3 text-left text-sm"
              onClick={() => void enter(demo.username)}
            >
              <span>{demo.name}</span>
              <span className="text-muted">{demo.role}</span>
            </button>
          ))}
        </div>
      </form>
    </main>
  );
}
