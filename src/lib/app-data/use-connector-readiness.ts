import { useEffect, useRef, useState } from "react";
import { isFramed } from "./login.ts";
import { getConnectorReadiness } from "./readiness.ts";
import {
  READINESS_PROBE_MAX_TOTAL_MS,
  readinessProbeDelayMs,
  readinessProbeExhausted,
} from "./readiness-schedule.ts";
import { CONNECTOR_TOKEN_READY_EVENT } from "./types.ts";

export type ConnectorWaitStatus =
  | "idle"
  | "waiting"
  | "timed_out"
  | "not_embedded";

export const READINESS_PROBE_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    const settle = (value: T | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    promise.then(settle, () => settle(null));
  });
}

async function isConnectorReady(): Promise<boolean> {
  const result = await withTimeout(
    getConnectorReadiness(),
    READINESS_PROBE_TIMEOUT_MS,
  );
  return result?.ready === true;
}

/**
 * Пока `waiting` истинен (вызов коннектора вернул `pending`), опрашивает
 * сервер на наличие токена коннектора и вызывает `refetch`, как только он появится.
 * Проба — проверка заголовка на собственном сервере приложения: до гейта она не доходит.
 * Событие моста `connector-token-ready` от хрома превью Grok сразу вызывает
 * `refetch`. Страница верхнего уровня (скачивание/экспорт, локальная разработка,
 * собственный `npm run preview` песочницы) не встроена ни в какое превью, поэтому токен
 * никогда не придёт: хук сообщает `not_embedded` и не опрашивает. Любая страница во фрейме
 * опрашивает, даже если origin родителя нельзя определить (пустой referrer,
 * нет `ancestorOrigins`): токен приходит через прокси превью, а событие
 * моста — лишь более быстрый сигнал.
 */
export function useRefetchWhenConnectorReady(
  waiting: boolean,
  refetch: () => unknown,
): ConnectorWaitStatus {
  const refetchRef = useRef(refetch);
  const [timedOut, setTimedOut] = useState(false);
  const [notEmbedded, setNotEmbedded] = useState(false);

  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  useEffect(() => {
    if (!waiting) return;
    if (!isFramed()) {
      setNotEmbedded(true);
      return () => setNotEmbedded(false);
    }
    let cancelled = false;
    let refetching = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    const runRefetch = async () => {
      if (refetching) return;
      refetching = true;
      try {
        await refetchRef.current();
      } catch {
        // Состоянием ошибки владеет сам запрос; неудачный refetch не должен останавливать
        // цикл проб.
      } finally {
        refetching = false;
      }
    };
    const schedule = () => {
      timer = setTimeout(probe, readinessProbeDelayMs(attempt));
      attempt += 1;
    };
    const probe = async () => {
      if (cancelled || readinessProbeExhausted(startedAt, Date.now())) return;
      const ready = await isConnectorReady();
      if (cancelled) return;
      if (ready) await runRefetch();
      if (!cancelled) schedule();
    };
    const onTokenReady = () => {
      void runRefetch();
    };
    // Конечное состояние по времени: проба, которая так и не завершилась, или refetch,
    // который бросает ошибку, не должны оставлять UI в «waiting» навсегда.
    const deadline = setTimeout(() => {
      if (!cancelled) setTimedOut(true);
    }, READINESS_PROBE_MAX_TOTAL_MS);

    window.addEventListener(CONNECTOR_TOKEN_READY_EVENT, onTokenReady);
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(deadline);
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener(CONNECTOR_TOKEN_READY_EVENT, onTokenReady);
      setTimedOut(false);
    };
  }, [waiting]);

  if (!waiting) return "idle";
  if (notEmbedded) return "not_embedded";
  return timedOut ? "timed_out" : "waiting";
}
