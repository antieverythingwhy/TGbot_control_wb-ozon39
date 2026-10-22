#!/usr/bin/env node
/**
 * Владеет :8081, QA-превью собранного вывода.
 *
 * `vite preview` — strictPort, поэтому превью, оставшееся с прошлого хода,
 * и валит следующий старт, и продолжает отдавать вывод прошлой сборки.
 * Каждый рестарт поэтому сначала убивает текущего владельца порта, кто бы его ни запустил.
 * Владельцы берутся из /proc, поэтому это работает только внутри Linux-песочницы.
 *
 *   node scripts/preview.mjs stop|restart
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PREVIEW_PORT = 8081;
const PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}/`;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PID_FILE = join(ROOT, ".grok/preview.pid");
const LOG_FILE = join(ROOT, ".grok/preview.log");
const READY_TIMEOUT_MS = Number(process.env.PREVIEW_READY_TIMEOUT_MS || 60000);
const GRACE_MS = 3000;
const POLL_MS = 100;

export function parsePreviewArgs(argv) {
  const [action, ...rest] = argv;
  if (!action) return { error: "usage: node scripts/preview.mjs stop|restart" };
  if (rest.length > 0) return { error: `unexpected argument: ${rest[0]}` };
  if (!["stop", "restart"].includes(action)) {
    return { error: `unknown action: ${action} (expected stop or restart)` };
  }
  return { action };
}

export function parsePid(text) {
  const pid = Number.parseInt(String(text ?? "").trim(), 10);
  // pid 1 — init песочницы: никогда не превью, и сигналить ему опасно.
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

/** pgid процесса из строки /proc/<pid>/stat. */
export function parsePgid(stat) {
  const line = String(stat ?? "");
  // Поле comm в скобках и само может содержать пробелы; state, ppid
  // и pgrp — три поля после него.
  const end = line.lastIndexOf(") ");
  if (end === -1) return null;
  const pgid = Number.parseInt(line.slice(end + 2).split(/\s+/)[2], 10);
  return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
}

const TCP_LISTEN = "0A";

/** Inode сокетов LISTEN на `port` в дампе /proc/net/tcp{,6}. */
export function parseListenerInodes(procNetTcp, port) {
  const wanted = `:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  const inodes = [];
  for (const line of String(procNetTcp ?? "").split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10 || cols[3] !== TCP_LISTEN || !cols[1].endsWith(wanted)) continue;
    if (/^\d+$/.test(cols[9])) inodes.push(cols[9]);
  }
  return inodes;
}

export function looksLikePreviewProcess(cmdline) {
  // /proc/<pid>/cmdline разделён NUL.
  const argv = String(cmdline ?? "")
    .split("\0")
    .filter(Boolean)
    .join(" ");
  // Сервис песочницы запускает scripts/preview-thumbnail.mjs в этом боксе, и
  // этот скрипт может идти параллельно: ни один никогда не цель.
  if (/\bpreview[\w-]*\.mjs\b/.test(argv)) return false;
  // Обёртка `npm run preview` (`npm-cli.js run preview`) и её дочерний vite.
  // `preview` должно быть целым именем скрипта: `run preview:stop`/`preview:restart`
  // — собственные обёртки этой оснастки, а `vite build --outDir preview-dist` —
  // не сервер.
  return /\brun\s+preview(?:\s|$)/.test(argv) || /\bvite\b\s+preview\b/.test(argv);
}

/**
 * Pid, которым слать сигнал. Владельцы порта — владельцы по определению; pid из pidfile — лишь
 * заявка прошлого запуска: pid переиспользуются через hibernate/revive, поэтому
 * сигналим ему, только если командная строка всё ещё похожа на превью.
 */
export function previewOwners({ portPids, pidFilePid, cmdlineOf }) {
  const owners = new Set(portPids);
  if (
    pidFilePid !== null &&
    !owners.has(pidFilePid) &&
    looksLikePreviewProcess(cmdlineOf(pidFilePid))
  ) {
    owners.add(pidFilePid);
  }
  return [...owners];
}

async function waitForExit(pids, { isAlive, sleep, timeoutMs, pollMs }) {
  let remaining = pids.filter((pid) => isAlive(pid));
  for (let waited = 0; remaining.length > 0 && waited < timeoutMs; waited += pollMs) {
    await sleep(pollMs);
    remaining = remaining.filter((pid) => isAlive(pid));
  }
  return remaining;
}

/**
 * SIGTERM каждому живому pid, затем SIGKILL тому, что пережило льготный период.
 * Возвращает `{ signalled, killed, stubborn }` — `stubborn` ещё жив после
 * ожидания SIGKILL, значит порт ненадёжно свободен.
 */
export async function terminatePids(
  pids,
  { kill, isAlive, sleep, graceMs = GRACE_MS, pollMs = POLL_MS },
) {
  const signalled = pids.filter((pid) => isAlive(pid));
  for (const pid of signalled) kill(pid, "SIGTERM");
  const killed = await waitForExit(signalled, { isAlive, sleep, timeoutMs: graceMs, pollMs });
  for (const pid of killed) kill(pid, "SIGKILL");
  const stubborn = await waitForExit(killed, { isAlive, sleep, timeoutMs: graceMs, pollMs });
  return { signalled, killed, stubborn };
}

/**
 * Что сообщает `stop`. `after` — проверка порта после убийства: `unattributed: true`
 * значит, слушатель есть, но его pid не разрешился, поэтому нельзя утверждать,
 * что порт свободен.
 */
export function stopOutcome({ signalled, stubborn, after }) {
  const held = [...new Set([...stubborn, ...after.pids])];
  if (held.length > 0) {
    return { ok: false, error: `port ${PREVIEW_PORT} is still held by pid(s) ${held.join(", ")}` };
  }
  if (after.unattributed) {
    return {
      ok: false,
      error: `port ${PREVIEW_PORT} is held by a process this script cannot see`,
    };
  }
  const message =
    signalled.length > 0
      ? `stopped pid(s) ${signalled.join(", ")} — port ${PREVIEW_PORT} is free`
      : `nothing was listening on ${PREVIEW_PORT}`;
  return { ok: true, message };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function pgidOf(pid) {
  try {
    return parsePgid(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

function killPid(pid, signal) {
  // restart() отвязывает сервер в свою группу процессов, поэтому сигналим
  // группе, чтобы достать `vite` под обёрткой `npm`. Только лидеру: `-pid` у
  // pid, который никого не ведёт, всё равно достаёт любую чужую группу с этим номером.
  if (pgidOf(pid) === pid) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Группа вышла между чтением pgid и сигналом.
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Вышел между проверкой живости и сигналом.
  }
}

function cmdlineOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    // Обычно мёртвый pid — устаревший pidfile, ради которого и нужна эта сверка.
    return "";
  }
}

function readPidFile() {
  try {
    return parsePid(readFileSync(PID_FILE, "utf8"));
  } catch {
    return null;
  }
}

function pidsForSocketInodes(inodes) {
  const targets = new Set([...inodes].map((inode) => `socket:[${inode}]`));
  const pids = [];
  for (const entry of readdirSync("/proc")) {
    const pid = parsePid(entry);
    if (pid === null || pid === process.pid) continue;
    let fds;
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      // Вышел посреди скана или принадлежит другому пользователю.
      continue;
    }
    for (const fd of fds) {
      try {
        if (targets.has(readlinkSync(`/proc/${pid}/fd/${fd}`))) {
          pids.push(pid);
          break;
        }
      } catch {
        // fd закрылся посреди скана.
      }
    }
  }
  return pids;
}

/**
 * `{ pids, unattributed }` — `unattributed: true`, когда у порта есть слушатель,
 * чей pid владельца не разрешился (каталог fd, который нам нельзя читать).
 */
function portOwners() {
  const inodes = new Set();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let dump;
    try {
      dump = readFileSync(file, "utf8");
    } catch {
      // tcp6 нет, когда у бокса нет IPv6.
      continue;
    }
    for (const inode of parseListenerInodes(dump, PREVIEW_PORT)) inodes.add(inode);
  }
  const pids = inodes.size > 0 ? pidsForSocketInodes(inodes) : [];
  return { pids, unattributed: inodes.size > 0 && pids.length === 0 };
}

async function stop(announce = true) {
  const owners = previewOwners({
    portPids: portOwners().pids,
    pidFilePid: readPidFile(),
    cmdlineOf,
  });
  const { signalled, stubborn } = await terminatePids(owners, { kill: killPid, isAlive, sleep });

  const outcome = stopOutcome({ signalled, stubborn, after: portOwners() });
  if (!outcome.ok) {
    // Оставляем pidfile: выживший, которого скан порта не может атрибутировать, остаётся
    // единственной записью, которой может воспользоваться повтор.
    console.error(`[preview] ${outcome.error}`);
    return false;
  }
  rmSync(PID_FILE, { force: true });
  if (announce) console.log(`[preview] ${outcome.message}`);
  return true;
}

async function waitForReady(failure) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline && failure() === null) {
    try {
      // Любой HTTP-ответ значит, что сервер привязан; 404 — тоже готов.
      await fetch(PREVIEW_URL, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await sleep(250);
    }
  }
  return false;
}

async function restart() {
  if (!(await stop())) return 1;

  mkdirSync(dirname(LOG_FILE), { recursive: true });
  const log = openSync(LOG_FILE, "a");
  const child = spawn("npm", ["run", "preview"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  writeFileSync(PID_FILE, `${child.pid}\n`);

  let failure = null;
  child.on("error", (err) => {
    failure = `npm run preview could not be spawned: ${err.message}`;
  });
  child.on("exit", (code, signal) => {
    failure = `npm run preview exited early (${signal ?? `code ${code}`})`;
  });

  if (!(await waitForReady(() => failure))) {
    const secs = Math.round(READY_TIMEOUT_MS / 1000);
    const why =
      failure ??
      `nothing answered on ${PREVIEW_URL} within ${secs}s — check that vite.config.ts ` +
        `still sets preview.port ${PREVIEW_PORT}`;
    console.error(`[preview] ${why} — see ${LOG_FILE}`);
    // Сервер, который привяжется на несколько секунд позже, отдал бы сборку, которую агенту
    // уже велели не доверять.
    await stop(false);
    return 1;
  }
  console.log(`[preview] serving ${PREVIEW_URL} (pid ${child.pid}, log ${LOG_FILE})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parsePreviewArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`[preview] ${args.error}`);
    process.exit(1);
  }
  if (!existsSync("/proc/self")) {
    console.error("[preview] no /proc — this script only runs inside the sandbox");
    process.exit(1);
  }
  process.exitCode = args.action === "stop" ? ((await stop()) ? 0 : 1) : await restart();
}
