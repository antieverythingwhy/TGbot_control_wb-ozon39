/**
 * Полносвязные комнаты WebRTC: одно RTCPeerConnection на удалённого пира, сигнализация
 * через /api/rtc (см. signaling.server.ts), игровые данные дальше идут напрямую
 * из браузера в браузер. По построению авторитет на клиенте — см.
 * навык multiplayer-p2p, когда это использовать НЕ стоит.
 *
 * Согласование идёт по шаблону «perfect negotiation»: при столкновении (обе
 * стороны сразу шлют offer) вежливый пир — с лексикографически меньшим id —
 * откатывается и принимает, поэтому пары сходятся и не заклинивают.
 */

export type SignalKind = "offer" | "answer" | "ice";

/**
 * Контракт обмена между этим клиентом и сигнальным реле, которое приложение даёт
 * по /api/rtc (эталонную реализацию см. в навыке multiplayer-p2p).
 * Клиенту нужны только эти формы — хранилище реле выбирает само приложение.
 */
export interface PeerRow {
  id: string;
  name: string;
}
export interface SignalRow {
  id: number;
  from: string;
  kind: SignalKind;
  payload: unknown;
}
export interface RtcPollResponse {
  peers: PeerRow[];
  signals: SignalRow[];
}

export interface PeerInfo {
  id: string;
  name: string;
  connectionState: RTCPeerConnectionState;
  /** Тип выбранного локального ICE-кандидата: host | srflx | prflx | relay. */
  candidateType: string | null;
  /** RTT пинга по data-channel (мс), меряется каждые 2 с после подключения. */
  rttMs: number | null;
}

export interface P2PRoomOptions {
  room: string;
  selfId: string;
  name?: string;
  /** По умолчанию VITE_STUN_URLS (через запятую) или публичный STUN Google. */
  iceServers?: RTCIceServer[];
  onPeersChanged?: (peers: PeerInfo[]) => void;
  /** Срабатывает и для ненадёжного канала "state", и для надёжного "reliable". */
  onMessage?: (from: string, data: unknown, channel: "state" | "reliable") => void;
  /** Срабатывает один раз, при первом успешном опросе сигнализации (регистрация). */
  onConnected?: () => void;
}

interface PeerSlot {
  pc: RTCPeerConnection;
  state?: RTCDataChannel;
  reliable?: RTCDataChannel;
  makingOffer: boolean;
  ignoreOffer: boolean;
  /** ICE-кандидаты, пришедшие до удалённого описания (в буфере). */
  pendingCandidates: RTCIceCandidateInit[];
  /** Когда эта пара в последний раз заметно продвинулась к connected. */
  lastProgressAt: number;
  /** Сколько раз watchdog пересоздавал соединение (звонивший) / окон зависания (принимающий). */
  recoveryAttempts: number;
  /** Сдались после MAX_RECOVERY_ATTEMPTS — больше не давят на быстрый опрос. */
  terminal?: boolean;
  /** Один раз: pc уже пересоздан, чтобы принять падающий удалённый offer. */
  recreatedForOffer?: boolean;
  info: PeerInfo;
  pingSentAt?: number;
}

const FAST_POLL_MS = 400;
const IDLE_POLL_MS = 2000;
const PING_INTERVAL_MS = 2000;
const STALL_MS = 10_000;
const MAX_RECOVERY_ATTEMPTS = 3;
const SIGNAL_RETRY_DELAYS_MS = [250, 750];

export function defaultIceServers(): RTCIceServer[] {
  const urls = (import.meta.env.VITE_STUN_URLS as string | undefined)
    ?.split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  // Два независимых провайдера: ICE опрашивает всех параллельно во время
  // сбора, поэтому недоступность любого из них ничего не стоит.
  return [
    {
      urls: urls?.length ? urls : ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"],
    },
  ];
}

export class P2PRoom {
  private readonly opts: P2PRoomOptions;
  private readonly peers = new Map<string, PeerSlot>();
  /** Цепочки доставки сигналов по каждому удалённому пиру (порядок сохраняется). */
  private readonly signalQueues = new Map<string, Promise<void>>();
  private cursor = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private everPolled = false;
  private lastPeersFingerprint = "";

  constructor(opts: P2PRoomOptions) {
    this.opts = opts;
  }

  /**
   * Первый опрос и есть вход: он регистрирует этого пира и возвращает
   * состав. Неудачный первый опрос (холодная БД, офлайн-вкладка) не должен бросать
   * комнату: цикл и таймеры стартуют всё равно, а следующий опрос повторяет попытку.
   */
  async join(): Promise<void> {
    try {
      await this.pollOnce();
    } catch {
      // Первый опрос может временно упасть; запланированный ниже цикл повторит попытку.
    }
    if (this.closed) return;
    this.schedulePoll(this.anyPairConnecting() ? FAST_POLL_MS : IDLE_POLL_MS);
    this.pingTimer = setInterval(() => {
      this.pingAll();
      this.watchdog();
    }, PING_INTERVAL_MS);
  }

  close(): void {
    this.closed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const slot of this.peers.values()) slot.pc.close();
    this.peers.clear();
    // Выход из состава — рассылка завершения: следующий опрос у всех
    // убирает этого пира и закрывает их сторону пары.
    void fetch("/api/rtc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "leave", room: this.opts.room, peer: this.opts.selfId }),
      keepalive: true,
    }).catch(() => {});
  }

  /** Отправка по ненадёжному каналу игрового состояния (устаревшие пакеты отбрасываются). */
  broadcast(data: unknown): void {
    const wire = JSON.stringify({ t: "d", d: data });
    for (const slot of this.peers.values()) {
      if (slot.state?.readyState === "open") slot.state.send(wire);
    }
  }

  /** Надёжная (упорядоченная) отправка одному пиру или всем, если peerId не задан. */
  send(data: unknown, peerId?: string): void {
    const wire = JSON.stringify({ t: "d", d: data });
    const targets = peerId ? [this.peers.get(peerId)] : [...this.peers.values()];
    for (const slot of targets) {
      if (slot?.reliable?.readyState === "open") slot.reliable.send(wire);
    }
  }

  peerList(): PeerInfo[] {
    return [...this.peers.values()].map((s) => ({ ...s.info }));
  }

  // ── цикл сигнализации ──────────────────────────────────────────────────────

  private schedulePoll(delay: number): void {
    if (this.closed) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), delay);
  }

  private anyPairConnecting(): boolean {
    for (const s of this.peers.values()) {
      // Терминальные пары (NAT после всех попыток восстановления) не должны держать
      // сессию на быстром опросе в 400 мс.
      if (s.terminal) continue;
      if (s.info.connectionState !== "connected") return true;
    }
    return false;
  }

  private async pollOnce(): Promise<void> {
    const params = new URLSearchParams({
      room: this.opts.room,
      peer: this.opts.selfId,
      name: this.opts.name ?? "",
      since: String(this.cursor),
    });
    const res = await fetch(`/api/rtc?${params}`);
    if (this.closed) return;
    if (!res.ok) throw new Error(`signaling poll failed: ${res.status}`);
    const body = (await res.json()) as RtcPollResponse;
    if (this.closed) return;
    if (!this.everPolled) {
      this.everPolled = true;
      this.opts.onConnected?.();
    }
    this.reconcileRoster(body.peers);
    const roster = new Set(body.peers.map((p) => p.id));
    for (const sig of body.signals) {
      this.cursor = Math.max(this.cursor, sig.id);
      await this.onSignal(sig.from, sig.kind, sig.payload, roster);
      if (this.closed) return;
    }
  }

  private async poll(): Promise<void> {
    if (this.closed) return;
    try {
      await this.pollOnce();
    } catch {
      // Временные сбои опроса ожидаемы (сон вкладки, выкат деплоя); повторяем.
    }
    this.schedulePoll(this.anyPairConnecting() ? FAST_POLL_MS : IDLE_POLL_MS);
  }

  private reconcileRoster(peers: { id: string; name: string }[]): void {
    const alive = new Set(peers.map((p) => p.id));
    for (const p of peers) {
      if (p.id === this.opts.selfId) continue;
      const existing = this.peers.get(p.id);
      if (existing) {
        existing.info.name = p.name;
      } else {
        // Ровно одна сторона звонит в каждой паре; другая ждёт offer.
        this.connectTo(p.id, p.name, this.opts.selfId > p.id);
      }
    }
    for (const [id, slot] of this.peers) {
      if (!alive.has(id)) {
        slot.pc.close();
        this.peers.delete(id);
      }
    }
    this.emitPeers();
  }

  // ── соединение пары ────────────────────────────────────────────────────────

  private connectTo(peerId: string, name: string, initiator: boolean): PeerSlot | null {
    if (this.closed) return null;
    const pc = new RTCPeerConnection({
      iceServers: this.opts.iceServers ?? defaultIceServers(),
    });
    const slot: PeerSlot = {
      pc,
      makingOffer: false,
      ignoreOffer: false,
      pendingCandidates: [],
      lastProgressAt: Date.now(),
      recoveryAttempts: 0,
      info: {
        id: peerId,
        name,
        connectionState: pc.connectionState,
        candidateType: null,
        rttMs: null,
      },
    };
    this.peers.set(peerId, slot);

    pc.onicecandidate = (e) => {
      if (e.candidate) void this.sendSignal(peerId, "ice", e.candidate.toJSON());
    };
    pc.onconnectionstatechange = () => {
      slot.info.connectionState = pc.connectionState;
      if (pc.connectionState === "connecting" || pc.connectionState === "connected") {
        slot.lastProgressAt = Date.now();
      }
      if (pc.connectionState === "connected") {
        slot.recoveryAttempts = 0;
        slot.terminal = false;
        void this.readCandidateType(slot);
      }
      this.emitPeers();
      if (pc.connectionState === "failed") {
        // Снова порождает negotiationneeded → свежий offer через сигнализацию, чтобы
        // потерянный offer или мёртвый путь не заклинили пару (безопасно при столкновении).
        pc.restartIce();
      }
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        this.schedulePoll(FAST_POLL_MS);
      }
    };
    pc.onnegotiationneeded = async () => {
      try {
        slot.makingOffer = true;
        await pc.setLocalDescription();
        await this.sendSignal(peerId, "offer", pc.localDescription!.toJSON());
      } catch {
        // Неудачный offer повторяется при следующем negotiationneeded.
      } finally {
        slot.makingOffer = false;
      }
    };
    pc.ondatachannel = (e) => this.attachChannel(slot, e.channel);

    if (initiator) {
      // Создание каналов порождает negotiationneeded → offer.
      this.attachChannel(
        slot,
        pc.createDataChannel("state", { ordered: false, maxRetransmits: 0 }),
      );
      this.attachChannel(slot, pc.createDataChannel("reliable", { ordered: true }));
    }
    return slot;
  }

  private attachChannel(slot: PeerSlot, channel: RTCDataChannel): void {
    if (channel.label === "state") slot.state = channel;
    else slot.reliable = channel;
    channel.onopen = () => {
      slot.lastProgressAt = Date.now();
    };
    channel.onmessage = (e) => {
      let msg: { t: string; d?: unknown };
      try {
        msg = JSON.parse(e.data as string) as { t: string; d?: unknown };
      } catch {
        return;
      }
      if (msg.t === "ping") {
        if (slot.state?.readyState === "open") {
          slot.state.send(JSON.stringify({ t: "pong" }));
        }
      } else if (msg.t === "pong") {
        if (slot.pingSentAt) {
          slot.info.rttMs = Math.round(performance.now() - slot.pingSentAt);
          slot.pingSentAt = undefined;
          this.emitPeers();
        }
      } else {
        this.opts.onMessage?.(
          slot.info.id,
          msg.d,
          channel.label === "state" ? "state" : "reliable",
        );
      }
    };
  }

  /** Применяет буферизованные ICE-кандидаты, когда удалённое описание уже на месте. */
  private async flushPendingCandidates(slot: PeerSlot): Promise<void> {
    while (slot.pendingCandidates.length > 0) {
      const candidate = slot.pendingCandidates.shift()!;
      try {
        await slot.pc.addIceCandidate(candidate);
      } catch (err) {
        if (!slot.ignoreOffer) console.warn("[p2p] addIceCandidate failed:", err);
      }
      if (this.closed) return;
    }
  }

  private async onSignal(
    from: string,
    kind: SignalKind,
    payload: unknown,
    roster: Set<string>,
  ): Promise<void> {
    if (this.closed) return;
    let slot = this.peers.get(from);
    if (!slot) {
      // Новые пиры звонят нам в том же опросе, который добавляет их в состав.
      // Сигналы живут дольше членства, поэтому отбрасываем отправителей, за которых состав не ручается.
      if (!roster.has(from)) return;
      const created = this.connectTo(from, "", false);
      if (!created) return;
      slot = created;
    }
    const polite = this.opts.selfId < from;

    try {
      if (kind === "offer" || kind === "answer") {
        const description = payload as RTCSessionDescriptionInit;
        const collision =
          kind === "offer" && (slot.makingOffer || slot.pc.signalingState !== "stable");
        slot.ignoreOffer = !polite && collision;
        if (slot.ignoreOffer) return;
        try {
          await slot.pc.setRemoteDescription(description); // неявный откат, если пир вежливый
        } catch (err) {
          // pc после выхода из сна может не принять ни один новый удалённый
          // offer (устаревший отпечаток DTLS). Один раз пересобираем пару и применяем
          // тот же offer к свежему pc, прежде чем сдаться.
          if (kind !== "offer" || slot.recreatedForOffer) throw err;
          const attempts = slot.recoveryAttempts;
          const name = slot.info.name;
          slot.pc.close();
          this.peers.delete(from);
          const fresh = this.connectTo(from, name, false);
          if (!fresh) return;
          fresh.recoveryAttempts = attempts;
          fresh.recreatedForOffer = true;
          slot = fresh;
          await slot.pc.setRemoteDescription(description);
        }
        if (this.closed) return;
        await this.flushPendingCandidates(slot);
        if (this.closed) return;
        if (kind === "offer") {
          await slot.pc.setLocalDescription();
          if (this.closed) return;
          await this.sendSignal(from, "answer", slot.pc.localDescription!.toJSON());
        }
      } else if (kind === "ice") {
        const candidate = payload as RTCIceCandidateInit;
        if (!slot.pc.remoteDescription) {
          // Кандидат обогнал свой SDP — держим его, пока не придёт описание
          // (сбрасывается после каждого успешного setRemoteDescription).
          slot.pendingCandidates.push(candidate);
          return;
        }
        try {
          await slot.pc.addIceCandidate(candidate);
        } catch (err) {
          // Внешний catch проглотил бы повторный throw; логируем сам сигнал.
          if (!slot.ignoreOffer) console.warn("[p2p] addIceCandidate failed:", err);
        }
      }
    } catch {
      // Ошибки согласования сходятся на следующем цикле offer; состояние видно
      // приложению через connectionState.
    }
  }

  /**
   * Сигналы идут по очереди на каждого удалённого пира (кандидат никогда не должен обогнать
   * свой SDP в БД) и при сбое повторяются с короткой паузой.
   */
  private sendSignal(to: string, kind: SignalKind, payload: unknown): Promise<void> {
    const prev = this.signalQueues.get(to) ?? Promise.resolve();
    const next = prev.then(() => this.postSignal(to, kind, payload));
    this.signalQueues.set(
      to,
      next.catch(() => {}),
    );
    return next;
  }

  private async postSignal(to: string, kind: SignalKind, payload: unknown): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      if (this.closed) return;
      try {
        const res = await fetch("/api/rtc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            op: "signal",
            room: this.opts.room,
            from: this.opts.selfId,
            to,
            kind,
            payload,
          }),
        });
        if (res.ok) return;
        throw new Error(`signal POST failed: ${res.status}`);
      } catch (err) {
        if (attempt >= SIGNAL_RETRY_DELAYS_MS.length) {
          // Доставка сдалась; пара сойдётся на следующем цикле offer (или
          // watchdog пересоберёт её). Логируем один раз, чтобы сбои были видны.
          console.warn(`[p2p] signal ${kind} to ${to} failed after retries`, err);
          return;
        }
        await new Promise((r) => setTimeout(r, SIGNAL_RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  // ── диагностика и восстановление ───────────────────────────────────────────

  private pingAll(): void {
    const wire = JSON.stringify({ t: "ping" });
    for (const slot of this.peers.values()) {
      if (slot.state?.readyState !== "open") continue;
      const stale =
        slot.pingSentAt !== undefined && performance.now() - slot.pingSentAt > 2 * PING_INTERVAL_MS;
      if (slot.pingSentAt === undefined || stale) {
        // Потерянный pong не должен навсегда заморозить rttMs: срок истекает, пингуем снова.
        slot.pingSentAt = performance.now();
        slot.state.send(wire);
      }
    }
  }

  /**
   * Восстановление застрявшей пары, прицепленное к интервалу пинга. Пара, которая
   * не продвинулась за STALL_MS, пересобирается звонящим со СВЕЖИМ
   * RTCPeerConnection (новая личность DTLS — чинит заклинивание отпечатка при
   * сне и пробуждении). После MAX_RECOVERY_ATTEMPTS пара конечная:
   * видна приложению по последнему connectionState и не учитывается быстрым опросом.
   */
  private watchdog(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const [peerId, slot] of this.peers) {
      // pc.close() и часть заклиниваний сна/пробуждения никогда не порождают
      // connectionstatechange — читаем ЖИВОЕ состояние, чтобы молча мёртвый pc
      // всё же сработал по таймеру зависания, а не прятался за закэшированным
      // "connected". Часы зависания обновляют только живые состояния прогресса.
      const live = slot.pc.connectionState;
      if (live !== slot.info.connectionState) {
        slot.info.connectionState = live;
        if (live === "connecting" || live === "connected") slot.lastProgressAt = now;
        this.emitPeers();
      }
      if (slot.terminal || live === "connected") continue;
      if (now - slot.lastProgressAt <= STALL_MS) continue;
      if (slot.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
        slot.terminal = true;
        this.emitPeers();
        continue;
      }
      slot.recoveryAttempts += 1;
      slot.lastProgressAt = now; // заново взводим окно зависания
      if (this.opts.selfId > peerId) {
        // Мы звонящие: пересобираем пару с нуля.
        const { name } = slot.info;
        const attempts = slot.recoveryAttempts;
        slot.pc.close();
        this.peers.delete(peerId);
        const fresh = this.connectTo(peerId, name, true);
        if (fresh) fresh.recoveryAttempts = attempts;
        this.schedulePoll(FAST_POLL_MS);
      }
      // Сторона принимающего: считаем окно зависания и ждём свежий
      // offer звонящего (onSignal его примет, при необходимости пересоздав наш pc).
    }
  }

  private async readCandidateType(slot: PeerSlot): Promise<void> {
    // relay = TURN (по умолчанию не настроен); srflx/host = прямой путь.
    try {
      const stats = await slot.pc.getStats();
      let selected: RTCIceCandidatePairStats | undefined;
      stats.forEach((s) => {
        if (s.type === "candidate-pair" && (s as RTCIceCandidatePairStats).nominated) {
          selected = s as RTCIceCandidatePairStats;
        }
      });
      const localId = selected?.localCandidateId;
      if (localId) {
        const local = stats.get(localId) as { candidateType?: string } | undefined;
        slot.info.candidateType = local?.candidateType ?? null;
        this.emitPeers();
      }
    } catch {
      // getStats — только диагностика по возможности.
    }
  }

  private emitPeers(): void {
    // Уведомляем, только когда реально изменилось что-то наблюдаемое — иначе сеттеры
    // состояния React перерисовывали бы потребителей на каждом опросе и пинге.
    const list = this.peerList();
    const fingerprint = JSON.stringify(
      list.map((p) => [p.id, p.name, p.connectionState, p.candidateType, p.rttMs]),
    );
    if (fingerprint === this.lastPeersFingerprint) return;
    this.lastPeersFingerprint = fingerprint;
    this.opts.onPeersChanged?.(list);
  }
}
