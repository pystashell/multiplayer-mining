"use client";

import { FormEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Difficulty = "beginner" | "intermediate" | "expert";
type CellState = "hidden" | "flagged" | "questioned" | "revealed";
type GameStatus = "ready" | "playing" | "won" | "lost";

type PublicCell = {
  index: number;
  row: number;
  col: number;
  state: CellState;
  adjacent: number | null;
  mine?: boolean;
  exploded?: boolean;
  wrongFlag?: boolean;
};

type PublicGame = {
  difficulty: Difficulty;
  width: number;
  height: number;
  mines: number;
  flags: number;
  revealed: number;
  status: GameStatus;
  startedAt: number | null;
  endedAt: number | null;
  cells: PublicCell[];
};

type RoomPlayer = {
  id: string;
  name: string;
  slot: 1 | 2;
  online: boolean;
  lastSeenAt: number;
};

type Activity = {
  id: string;
  playerId: string;
  playerName: string;
  type: string;
  detail?: string;
  createdAt: number;
};

type Room = {
  code: string;
  version: number;
  game: PublicGame;
  players: RoomPlayer[];
  activity: Activity[];
  updatedAt: number;
};

type Session = {
  code: string;
  token: string;
  playerId: string;
  playerName: string;
};

type GameAction =
  | { type: "reveal"; index: number }
  | { type: "mark"; index: number; state: "hidden" | "flagged" | "questioned" }
  | { type: "chord"; index: number }
  | { type: "restart" }
  | { type: "changeDifficulty"; difficulty: Difficulty };

const DIFFICULTIES: Record<Difficulty, { label: string; meta: string }> = {
  beginner: { label: "初级", meta: "9×9 · 10 雷" },
  intermediate: { label: "中级", meta: "16×16 · 40 雷" },
  expert: { label: "专家", meta: "30×16 · 99 雷" },
};

const SESSION_KEY = "shared-minefield-session-v1";

function displayError(error: unknown) {
  return error instanceof Error ? error.message : "雷区信号中断了，请再试一次。";
}

async function readJson(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(payload.error || "操作失败，请再试一次。");
  return payload;
}

function formatCounter(value: number) {
  if (value < 0) return `-${String(Math.min(99, Math.abs(value))).padStart(2, "0")}`;
  return String(Math.min(999, value)).padStart(3, "0");
}

function secondsFor(game: PublicGame, now: number) {
  if (!game.startedAt) return 0;
  const end = game.endedAt ?? now;
  return Math.max(0, Math.floor((end - game.startedAt) / 1000));
}

function statusCopy(game: PublicGame, players: RoomPlayer[]) {
  if (game.status === "won") return { eyebrow: "CLEAR", title: "你们居然还在做朋友", body: "雷区清空，友谊暂时安全。" };
  if (game.status === "lost") return { eyebrow: "BOOM", title: "有人动了不该动的格子", body: "别急着甩锅，活动记录都记着呢。" };
  if (game.status === "playing") return { eyebrow: "LIVE", title: "全员屏住呼吸", body: players.length < 2 ? "先扫着，队友随时可以加入。" : "同一块棋盘，任何一步都会同步。" };
  return { eyebrow: "READY", title: players.length < 2 ? "等队友，也可以先开" : "两位都到齐了", body: "第一次揭开必定安全，计时也从那时开始。" };
}

function activityCopy(item: Activity) {
  const map: Record<string, string> = {
    create: "建好了这片雷区",
    join: "进入房间，友谊测试开始",
    reveal: item.detail ? `揭开了 ${item.detail}` : "揭开一格",
    flag: item.detail ? `在 ${item.detail} 插了一面旗` : "插了一面旗",
    question: item.detail ? `对 ${item.detail} 表示怀疑` : "留下一个问号",
    unmark: item.detail ? `撤掉了 ${item.detail} 的标记` : "撤掉一个标记",
    chord: item.detail ? `在 ${item.detail} 一口气多开` : "进行了一次多开",
    restart: "按下重开，假装无事发生",
    difficulty: `把难度改成${item.detail ?? "新难度"}`,
    win: "完成最后一击，清空雷区",
    boom: item.detail ? `在 ${item.detail} 引爆了雷` : "引爆了雷",
  };
  return map[item.type] ?? item.detail ?? "更新了棋盘";
}

function CellGlyph({ cell }: { cell: PublicCell }) {
  if (cell.exploded) return <span className="mine-glyph">✹</span>;
  if (cell.wrongFlag) return <span className="wrong-glyph">×</span>;
  if (cell.state === "flagged") return <span className="flag-glyph">⚑</span>;
  if (cell.state === "questioned") return <span className="question-glyph">?</span>;
  if (cell.mine) return <span className="mine-glyph">✹</span>;
  if (cell.state === "revealed" && cell.adjacent) return <span>{cell.adjacent}</span>;
  return null;
}

export function MinefieldApp() {
  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty>("intermediate");
  const [session, setSession] = useState<Session | null>(null);
  const [pausedSession, setPausedSession] = useState<Session | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [connected, setConnected] = useState(true);
  const [tapMode, setTapMode] = useState<"reveal" | "mark">("reveal");
  const [chordPreviewIndex, setChordPreviewIndex] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const roomRef = useRef<Room | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const actionQueue = useRef<Promise<void>>(Promise.resolve());
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedIndex = useRef<number | null>(null);
  const chordGestureIndex = useRef<number | null>(null);
  const suppressContextMenuIndex = useRef<number | null>(null);
  const suppressContextMenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const acceptRoom = useCallback((next: Room) => {
    const activeSession = sessionRef.current;
    if (!activeSession || activeSession.code !== next.code) return;
    setRoom((current) => (
      !current || current.code !== next.code || next.version >= current.version ? next : current
    ));
  }, []);

  const fetchRoom = useCallback(async (activeSession: Session, silent = false) => {
    try {
      const response = await fetch(`/api/rooms/${activeSession.code}`, {
        headers: { "x-player-token": activeSession.token },
        cache: "no-store",
      });
      const payload = (await readJson(response)) as { room: Room };
      if (sessionRef.current?.token !== activeSession.token) return false;
      acceptRoom(payload.room);
      setConnected(true);
      if (!silent) setError("");
      return true;
    } catch (fetchError) {
      if (sessionRef.current?.token !== activeSession.token) return false;
      setConnected(false);
      if (!silent) setError(displayError(fetchError));
      return false;
    }
  }, [acceptRoom]);

  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      const saved = window.localStorage.getItem(SESSION_KEY);
      if (!saved) return;
      try {
        const restored = JSON.parse(saved) as Session;
        if (!restored.code || !restored.token) return;
        sessionRef.current = restored;
        setSession(restored);
        setName(restored.playerName || "");
        void fetchRoom(restored);
      } catch {
        window.localStorage.removeItem(SESSION_KEY);
      }
    }, 0);
    return () => window.clearTimeout(restoreTimer);
  }, [fetchRoom]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let pollTimer = 0;
    let failures = 0;
    let running = false;

    const schedule = (delay: number) => {
      window.clearTimeout(pollTimer);
      pollTimer = window.setTimeout(async () => {
        if (cancelled) return;
        if (running) {
          schedule(900);
          return;
        }
        running = true;
        if (document.visibilityState !== "hidden") {
          const ok = await fetchRoom(session, true);
          failures = ok ? 0 : Math.min(failures + 1, 3);
        }
        running = false;
        if (!cancelled) schedule(Math.min(6_000, 900 * (2 ** failures)));
      }, delay);
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") schedule(0);
    };

    schedule(900);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      cancelled = true;
      window.clearTimeout(pollTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [fetchRoom, session]);

  useEffect(() => {
    if (room?.game.status !== "playing") return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [room?.game.status]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const cancelHeldChord = () => {
      const heldIndex = chordGestureIndex.current;
      chordGestureIndex.current = null;
      setChordPreviewIndex(null);
      if (heldIndex !== null) {
        suppressContextMenuIndex.current = heldIndex;
        if (suppressContextMenuTimer.current) clearTimeout(suppressContextMenuTimer.current);
        suppressContextMenuTimer.current = setTimeout(() => {
          if (suppressContextMenuIndex.current === heldIndex) suppressContextMenuIndex.current = null;
        }, 500);
      }
    };
    window.addEventListener("blur", cancelHeldChord);
    return () => {
      window.removeEventListener("blur", cancelHeldChord);
      if (suppressContextMenuTimer.current) clearTimeout(suppressContextMenuTimer.current);
    };
  }, []);

  const persistSession = (next: Session) => {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    sessionRef.current = next;
    actionQueue.current = Promise.resolve();
    setPausedSession(null);
    setSession(next);
  };

  const createRoom = async (event: FormEvent) => {
    event.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) return setError("先留个名字，不然队友没法甩锅。 ");
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: cleanName, difficulty }),
      });
      const payload = (await readJson(response)) as { room: Room; session: Session };
      persistSession(payload.session);
      acceptRoom(payload.room);
    } catch (createError) {
      setError(displayError(createError));
    } finally {
      setLoading(false);
    }
  };

  const joinRoom = async (event: FormEvent) => {
    event.preventDefault();
    const cleanName = name.trim();
    const cleanCode = joinCode.replace(/[^a-z0-9]/gi, "").toUpperCase();
    if (!cleanName) return setError("先留个名字，不然队友没法甩锅。 ");
    if (cleanCode.length !== 6) return setError("房间码是 6 位，检查一下再进。 ");
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/rooms/${cleanCode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "join", name: cleanName }),
      });
      const payload = (await readJson(response)) as { room: Room; session: Session };
      persistSession(payload.session);
      acceptRoom(payload.room);
    } catch (joinError) {
      setError(displayError(joinError));
    } finally {
      setLoading(false);
    }
  };

  const leaveRoom = () => {
    if (session) setPausedSession(session);
    sessionRef.current = null;
    actionQueue.current = Promise.resolve();
    setSession(null);
    setRoom(null);
    setJoinCode("");
    setError("");
  };

  const resumeRoom = () => {
    if (!pausedSession) return;
    sessionRef.current = pausedSession;
    setSession(pausedSession);
    void fetchRoom(pausedSession);
  };

  const commitAction = useCallback((action: GameAction) => {
    const activeSession = sessionRef.current;
    if (!activeSession) return;
    actionQueue.current = actionQueue.current.then(async () => {
      try {
        const response = await fetch(`/api/rooms/${activeSession.code}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-player-token": activeSession.token,
          },
          body: JSON.stringify({ op: "action", action, observedVersion: roomRef.current?.version }),
        });
        const payload = (await readJson(response)) as { room: Room };
        if (sessionRef.current?.token !== activeSession.token) return;
        acceptRoom(payload.room);
        setConnected(true);
        setError("");
      } catch (actionError) {
        if (sessionRef.current?.token !== activeSession.token) return;
        setError(displayError(actionError));
        setConnected(false);
        await fetchRoom(activeSession, true);
      }
    });
  }, [acceptRoom, fetchRoom]);

  const copyInvite = async () => {
    if (!room) return;
    const link = `${window.location.origin}/?room=${room.code}`;
    try {
      await navigator.clipboard.writeText(`来同雷共苦：房间 ${room.code}\n${link}`);
      setNotice("邀请已复制，祝你们友谊长存");
    } catch {
      setNotice(`房间码：${room.code}`);
    }
  };

  const nextMarkAction = (cell: PublicCell): GameAction => ({
    type: "mark",
    index: cell.index,
    state: cell.state === "flagged" ? "questioned" : cell.state === "questioned" ? "hidden" : "flagged",
  });

  useEffect(() => {
    const linkTimer = window.setTimeout(() => {
      const code = new URLSearchParams(window.location.search).get("room");
      if (code) setJoinCode(code.slice(0, 6).toUpperCase());
    }, 0);
    return () => window.clearTimeout(linkTimer);
  }, []);

  const handleCellClick = (cell: PublicCell) => {
    if (longPressedIndex.current === cell.index) {
      longPressedIndex.current = null;
      return;
    }
    if (tapMode === "mark") commitAction(nextMarkAction(cell));
    else if (cell.state !== "flagged" && cell.state !== "revealed") commitAction({ type: "reveal", index: cell.index });
  };

  const beginLongPress = (event: ReactPointerEvent, cell: PublicCell) => {
    if (event.pointerType !== "touch" || cell.state === "revealed") return;
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => {
      longPressedIndex.current = cell.index;
      commitAction(nextMarkAction(cell));
      if (navigator.vibrate) navigator.vibrate(35);
    }, 420);
  };

  const clearLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  const beginClassicChord = (event: ReactMouseEvent, cell: PublicCell) => {
    const isBothPrimaryButtons = (event.buttons & 3) === 3;
    if (!isBothPrimaryButtons || cell.state !== "revealed" || !cell.adjacent) return;
    event.preventDefault();
    chordGestureIndex.current = cell.index;
    suppressContextMenuIndex.current = cell.index;
    setChordPreviewIndex(cell.index);
  };

  const finishClassicChord = (event: ReactMouseEvent, cell: PublicCell) => {
    if (chordGestureIndex.current !== cell.index || (event.buttons & 3) === 3) return;
    event.preventDefault();
    chordGestureIndex.current = null;
    suppressContextMenuIndex.current = cell.index;
    setChordPreviewIndex(null);
    if (suppressContextMenuTimer.current) clearTimeout(suppressContextMenuTimer.current);
    suppressContextMenuTimer.current = setTimeout(() => {
      if (suppressContextMenuIndex.current === cell.index) suppressContextMenuIndex.current = null;
    }, 500);
    commitAction({ type: "chord", index: cell.index });
  };

  const cancelClassicChord = (cellIndex: number) => {
    if (chordGestureIndex.current !== cellIndex) return;
    chordGestureIndex.current = null;
    setChordPreviewIndex(null);
    suppressContextMenuIndex.current = cellIndex;
    if (suppressContextMenuTimer.current) clearTimeout(suppressContextMenuTimer.current);
    suppressContextMenuTimer.current = setTimeout(() => {
      if (suppressContextMenuIndex.current === cellIndex) suppressContextMenuIndex.current = null;
    }, 500);
  };

  const status = room ? statusCopy(room.game, room.players) : null;
  const seconds = room ? secondsFor(room.game, now) : 0;
  const currentDifficulty = room?.game.difficulty ?? difficulty;
  const me = room?.players.find((player) => player.id === session?.playerId);
  const remainingSafe = room ? room.game.width * room.game.height - room.game.mines - room.game.revealed : 0;
  const friendship = room ? Math.max(8, Math.round(100 - (remainingSafe / Math.max(1, room.game.width * room.game.height - room.game.mines)) * 52 - (room.game.status === "lost" ? 40 : 0))) : 72;

  const boardStyle = useMemo(() => ({
    "--board-cols": room?.game.width ?? 9,
    "--cell-size": room?.game.width === 30 ? "27px" : room?.game.width === 16 ? "31px" : "38px",
  }) as React.CSSProperties, [room?.game.width]);

  if (!room || !session) {
    return (
      <main className="site-shell lobby-shell">
        <header className="topbar">
          <a className="brand" href="#" aria-label="同雷共苦首页">
            <span className="brand-mark" aria-hidden="true">✹</span>
            <span>同雷共苦</span>
          </a>
          <span className="topbar-note"><i /> 双人实时扫雷</span>
        </header>

        <section className="lobby-grid">
          <div className="hero-copy">
            <p className="kicker">LIVE CO-OP MINESWEEPER</p>
            <h1>一块雷区，<br /><em>两个人背锅。</em></h1>
            <p className="hero-lede">经典扫雷的全部紧张感，再加一个会乱插旗的朋友。双击多开、右键标记、首击安全——以及全程可追溯的友谊事故现场。</p>

            <div className="pressure-card" aria-label="血压预警">
              <div className="pressure-head"><span>血压预警</span><strong>偏高</strong></div>
              <div className="pressure-track"><span /><span /><span /><span /><span /></div>
              <p>错误插旗不会立刻输，但可能让队友的多开直接起飞。</p>
            </div>

            <div className="feature-tape" aria-label="游戏特性">
              <span>同盘实时同步</span><span>经典三态标记</span><span>手机长按插旗</span>
            </div>
          </div>

          <div className="lobby-console">
            <div className="console-title">
              <div><p>准备进入雷区</p><h2>先报上名来</h2></div>
              <span className="console-index">01</span>
            </div>
            {pausedSession && (
              <button className="resume-room" type="button" onClick={resumeRoom}>
                <span>继续刚才的房间</span><strong>{pausedSession.code}</strong><b aria-hidden="true">→</b>
              </button>
            )}
            <label className="field-label" htmlFor="player-name">你的名字</label>
            <input id="player-name" className="text-input" value={name} maxLength={16} onChange={(event) => setName(event.target.value)} placeholder="例如：绝不乱点的小刘" autoComplete="nickname" />

            <form onSubmit={createRoom} className="console-section">
              <div className="section-heading"><span>创建新房间</span><small>可以先单人开扫</small></div>
              <div className="difficulty-grid" role="group" aria-label="选择难度">
                {(Object.keys(DIFFICULTIES) as Difficulty[]).map((key) => (
                  <button key={key} type="button" className={difficulty === key ? "difficulty-option active" : "difficulty-option"} onClick={() => setDifficulty(key)}>
                    <strong>{DIFFICULTIES[key].label}</strong><span>{DIFFICULTIES[key].meta}</span>
                  </button>
                ))}
              </div>
              <button className="primary-button" disabled={loading} type="submit"><span>{loading ? "正在布置雷区…" : "创建房间"}</span><b aria-hidden="true">↗</b></button>
            </form>

            <div className="or-line"><span>或者加入朋友</span></div>

            <form onSubmit={joinRoom} className="join-row">
              <label className="sr-only" htmlFor="room-code">6 位房间码</label>
              <input id="room-code" className="text-input code-input" value={joinCode} maxLength={6} onChange={(event) => setJoinCode(event.target.value.replace(/[^a-z0-9]/gi, "").toUpperCase())} placeholder="房间码" autoCapitalize="characters" />
              <button className="secondary-button" disabled={loading} type="submit">加入房间</button>
            </form>
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
        </section>

        <footer className="site-footer"><span>右键插旗 · 再右键问号 · 双击数字多开</span><span>NO FRIENDSHIPS WERE GUARANTEED</span></footer>
      </main>
    );
  }

  return (
    <main className="site-shell game-shell">
      <header className="topbar game-topbar">
        <button className="brand brand-button" onClick={leaveRoom} aria-label="暂时离开房间返回首页">
          <span className="brand-mark" aria-hidden="true">✹</span><span>同雷共苦</span>
        </button>
        <div className="room-identity">
          <span>房间</span><strong>{room.code}</strong>
          <button onClick={copyInvite}>复制邀请</button>
        </div>
        <span className={connected ? "connection-state online" : "connection-state"}><i />{connected ? "同步中" : "重连中"}</span>
      </header>

      <section className="game-layout">
        <div className="board-column">
          <div className="game-status-line">
            <div><p>{status?.eyebrow}</p><h1>{status?.title}</h1><span>{status?.body}</span></div>
            <div className="friendship-meter">
              <span>友谊耐久</span>
              <strong>{friendship}%</strong>
              <div><i style={{ width: `${friendship}%` }} /></div>
            </div>
          </div>

          <section className={`mine-console status-${room.game.status}`} aria-label="扫雷棋盘">
            <div className="classic-display">
              <div className="digit-box"><small>剩余雷数</small><strong>{formatCounter(room.game.mines - room.game.flags)}</strong></div>
              <button className="face-button" onClick={() => commitAction({ type: "restart" })} aria-label="重新开始">
                {room.game.status === "lost" ? "×_×" : room.game.status === "won" ? "^‿^" : room.game.status === "playing" ? "•_•" : "•‿•"}
              </button>
              <div className="digit-box align-right"><small>用时</small><strong>{formatCounter(seconds)}</strong></div>
            </div>

            <div className="board-scroll">
              <div className="mine-board" style={boardStyle} role="grid" aria-label={`${DIFFICULTIES[currentDifficulty].label}扫雷棋盘`}>
                {room.game.cells.map((cell) => {
                  const numberClass = cell.state === "revealed" && cell.adjacent ? ` number-${cell.adjacent}` : "";
                  const previewRow = chordPreviewIndex === null ? -10 : Math.floor(chordPreviewIndex / room.game.width);
                  const previewCol = chordPreviewIndex === null ? -10 : chordPreviewIndex % room.game.width;
                  const isChordPreview = chordPreviewIndex !== null
                    && cell.index !== chordPreviewIndex
                    && cell.state !== "revealed"
                    && cell.state !== "flagged"
                    && Math.abs(cell.row - previewRow) <= 1
                    && Math.abs(cell.col - previewCol) <= 1;
                  const stateClass = `cell-${cell.state}${cell.exploded ? " exploded" : ""}${cell.wrongFlag ? " wrong" : ""}${numberClass}${isChordPreview ? " chord-preview" : ""}`;
                  const label = cell.state === "flagged" ? `第 ${cell.row + 1} 行第 ${cell.col + 1} 列，已插旗` : cell.state === "questioned" ? `第 ${cell.row + 1} 行第 ${cell.col + 1} 列，问号标记` : cell.state === "revealed" ? `第 ${cell.row + 1} 行第 ${cell.col + 1} 列，${cell.mine ? "地雷" : `${cell.adjacent ?? 0} 个相邻雷`}` : `第 ${cell.row + 1} 行第 ${cell.col + 1} 列，未揭开`;
                  return (
                    <button
                      key={cell.index}
                      className={`mine-cell ${stateClass}`}
                      role="gridcell"
                      aria-label={label}
                      disabled={room.game.status === "won" || room.game.status === "lost"}
                      onClick={() => handleCellClick(cell)}
                      onDoubleClick={(event) => { event.preventDefault(); if (cell.state === "revealed") commitAction({ type: "chord", index: cell.index }); }}
                      onMouseDown={(event) => beginClassicChord(event, cell)}
                      onMouseUp={(event) => finishClassicChord(event, cell)}
                      onMouseLeave={() => cancelClassicChord(cell.index)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        if (chordGestureIndex.current === cell.index || suppressContextMenuIndex.current === cell.index) return;
                        commitAction(nextMarkAction(cell));
                      }}
                      onPointerDown={(event) => beginLongPress(event, cell)}
                      onPointerUp={clearLongPress}
                      onPointerCancel={clearLongPress}
                      onPointerLeave={clearLongPress}
                      onKeyDown={(event) => { if (event.key === " ") { event.preventDefault(); commitAction(nextMarkAction(cell)); } }}
                    ><CellGlyph cell={cell} /></button>
                  );
                })}
              </div>
            </div>

            <div className="mobile-mode" role="group" aria-label="触屏操作模式">
              <button className={tapMode === "reveal" ? "active" : ""} onClick={() => setTapMode("reveal")}>轻触排雷</button>
              <button className={tapMode === "mark" ? "active" : ""} onClick={() => setTapMode("mark")}>轻触标记</button>
              <span>也可长按插旗</span>
            </div>
          </section>

          <div className="board-help"><span><b>左键</b> 揭开</span><span><b>右键</b> 旗帜 / 问号</span><span><b>左右键齐按 / 双击数字</b> 多开周围</span><span><b>空格</b> 标记</span></div>
        </div>

        <aside className="side-panel">
          <section className="panel-section players-section">
            <div className="panel-heading"><span>雷区成员</span><small>{room.players.length}/2</small></div>
            {[1, 2].map((slot) => {
              const player = room.players.find((candidate) => candidate.slot === slot);
              return player ? (
                <div className={`player-card player-${slot}`} key={slot}>
                  <div className="player-avatar">{player.name.slice(0, 1).toUpperCase()}</div>
                  <div><strong>{player.name}{player.id === me?.id ? "（你）" : ""}</strong><span>{player.online ? "正在雷区" : "暂时离线"}</span></div>
                  <i className={player.online ? "online" : ""} />
                </div>
              ) : (
                <button className="empty-player" key={slot} onClick={copyInvite}><span>+</span><div><strong>等待队友</strong><small>点击复制邀请</small></div></button>
              );
            })}
          </section>

          <section className="panel-section activity-section">
            <div className="panel-heading"><span>事故记录</span><small>LIVE</small></div>
            <div className="activity-list">
              {room.activity.length ? room.activity.slice(0, 7).map((item) => (
                <div className="activity-item" key={item.id}>
                  <i className={item.playerId === room.players[0]?.id ? "p1" : "p2"} />
                  <p><strong>{item.playerName}</strong>{activityCopy(item)}<time>{new Date(item.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></p>
                </div>
              )) : <p className="empty-activity">还没有事故。很快就会有的。</p>}
            </div>
          </section>

          <section className="panel-section settings-section">
            <div className="panel-heading"><span>本局设置</span></div>
            <label htmlFor="game-difficulty">难度</label>
            <select id="game-difficulty" value={currentDifficulty} onChange={(event) => commitAction({ type: "changeDifficulty", difficulty: event.target.value as Difficulty })}>
              {(Object.keys(DIFFICULTIES) as Difficulty[]).map((key) => <option value={key} key={key}>{DIFFICULTIES[key].label} · {DIFFICULTIES[key].meta}</option>)}
            </select>
            <button className="restart-button" onClick={() => commitAction({ type: "restart" })}>重新布置雷区</button>
            <button className="leave-button" onClick={leaveRoom}>暂时离开房间</button>
          </section>
        </aside>
      </section>

      {(notice || error) && <div className={error ? "toast error-toast" : "toast"} role="status">{error || notice}</div>}
    </main>
  );
}
