"use client";

import { FormEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMineRoomSocket } from "./useMineRoomSocket";
import {
  LOCALE_COOKIE,
  LOCALE_STORAGE_KEY,
  META_COPY,
  parseLocale,
  translate,
  translateServerMessage,
  type Locale,
} from "./i18n";
import type {
  Activity,
  Difficulty,
  GameAction,
  PublicCell,
  PublicGame,
  Room,
  RoomPlayer,
  Session,
} from "../shared/mine-protocol";

const DIFFICULTY_SPECS: Record<Difficulty, { label: "初级" | "中级" | "专家"; size: string; mines: number }> = {
  beginner: { label: "初级", size: "9×9", mines: 10 },
  intermediate: { label: "中级", size: "16×16", mines: 40 },
  expert: { label: "专家", size: "30×16", mines: 99 },
};

const SESSION_KEY = "shared-minefield-session-v1";

function difficultyCopy(locale: Locale, difficulty: Difficulty) {
  const spec = DIFFICULTY_SPECS[difficulty];
  return {
    label: translate(locale, spec.label),
    meta: locale === "zh-CN" ? `${spec.size} · ${spec.mines} 雷` : `${spec.size} · ${spec.mines} mines`,
  };
}

function displayError(error: unknown, locale: Locale) {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return translateServerMessage(locale, code, error.message);
  }
  return locale === "zh-CN" ? "雷区信号中断了，请再试一次。" : "The minefield signal was lost. Please try again.";
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

function statusCopy(game: PublicGame, players: RoomPlayer[], locale: Locale) {
  if (locale === "en") {
    if (game.status === "won") return { eyebrow: "CLEAR", title: "Somehow, you are still friends", body: "The minefield is clear. The friendship is safe for now." };
    if (game.status === "lost") return { eyebrow: "BOOM", title: "Someone clicked the forbidden square", body: "Do not rush to assign blame—the incident log remembers everything." };
    if (game.status === "playing") return { eyebrow: "LIVE", title: "Everyone hold your breath", body: players.length < 2 ? "Start sweeping. Teammates can join at any time." : `${players.length} players are sharing one board. Every move syncs live.` };
    return { eyebrow: "READY", title: players.length < 2 ? "Wait for teammates—or start now" : players.length >= 4 ? "Everyone is here. Prepare to pass the blame" : `${players.length} players are here and ready`, body: "The first reveal is always safe, and the clock starts with it." };
  }
  if (game.status === "won") return { eyebrow: "CLEAR", title: "你们居然还在做朋友", body: "雷区清空，友谊暂时安全。" };
  if (game.status === "lost") return { eyebrow: "BOOM", title: "有人动了不该动的格子", body: "别急着甩锅，活动记录都记着呢。" };
  if (game.status === "playing") return { eyebrow: "LIVE", title: "全员屏住呼吸", body: players.length < 2 ? "先扫着，队友随时可以加入。" : `${players.length} 人同扫一块棋盘，任何一步都会同步。` };
  return { eyebrow: "READY", title: players.length < 2 ? "等队友，也可以先开" : players.length >= 4 ? "全员到齐，准备互相甩锅" : `${players.length} 位已到场，随时开扫`, body: "第一次揭开必定安全，计时也从那时开始。" };
}

function activityCopy(item: Activity, locale: Locale) {
  const coordinate = item.detail && /^[A-Z]{1,2}\d+$/.test(item.detail) ? item.detail : undefined;
  const difficulty = item.detail === "beginner" || item.detail === "初级"
    ? difficultyCopy(locale, "beginner").label
    : item.detail === "intermediate" || item.detail === "中级"
      ? difficultyCopy(locale, "intermediate").label
      : item.detail === "expert" || item.detail === "专家"
        ? difficultyCopy(locale, "expert").label
        : locale === "zh-CN" ? "新难度" : "a new difficulty";
  if (locale === "en") {
    const map: Record<string, string> = {
      create: " created this minefield",
      join: " joined the room; the friendship test begins",
      reveal: coordinate ? ` revealed ${coordinate}` : " revealed a cell",
      flag: coordinate ? ` planted a flag on ${coordinate}` : " planted a flag",
      question: coordinate ? ` questioned ${coordinate}` : " placed a question mark",
      unmark: coordinate ? ` removed the mark from ${coordinate}` : " removed a mark",
      chord: coordinate ? ` opened the cells around ${coordinate}` : " chorded a number",
      restart: " restarted the board and pretended nothing happened",
      difficulty: ` changed the difficulty to ${difficulty}`,
      win: " made the final move and cleared the minefield",
      boom: coordinate ? ` detonated a mine at ${coordinate}` : " detonated a mine",
      incident: " hit a mine; the players must now decide",
      accident: coordinate ? ` caused a mine incident at ${coordinate}` : " caused a mine incident",
      revival_prompt: " triggered emergency friendship support",
      watch_ad: " chose the ad and sentenced every player to watch",
      ad: " chose the ad and sentenced every player to watch",
      revive: " finished the ad and rewound time",
      revived: " finished the ad and rewound time",
      end_game: " declined the ad rescue and ended the game",
      end: " declined the ad rescue and ended the game",
    };
    return map[item.type] ?? " updated the board";
  }
  const map: Record<string, string> = {
    create: "建好了这片雷区",
    join: "进入房间，友谊测试开始",
    reveal: coordinate ? `揭开了 ${coordinate}` : "揭开一格",
    flag: coordinate ? `在 ${coordinate} 插了一面旗` : "插了一面旗",
    question: coordinate ? `对 ${coordinate} 表示怀疑` : "留下一个问号",
    unmark: coordinate ? `撤掉了 ${coordinate} 的标记` : "撤掉一个标记",
    chord: coordinate ? `在 ${coordinate} 一口气多开` : "进行了一次多开",
    restart: "按下重开，假装无事发生",
    difficulty: `把难度改成${difficulty}`,
    win: "完成最后一击，清空雷区",
    boom: coordinate ? `在 ${coordinate} 引爆了雷` : "引爆了雷",
    incident: "踩雷了，等待场上玩家选择",
    accident: coordinate ? `在 ${coordinate} 制造了一起雷区事故` : "制造了一起雷区事故",
    revival_prompt: "踩雷后触发了场上玩家友谊急救",
    watch_ad: "选择看广告，拉所有参赛玩家一起坐牢",
    ad: "选择看广告，拉所有参赛玩家一起坐牢",
    revive: "看完广告，成功把时间倒带",
    revived: "看完广告，成功把时间倒带",
    end_game: "放弃广告急救，决定结束游戏",
    end: "放弃广告急救，决定结束游戏",
  };
  return map[item.type] ?? "更新了棋盘";
}

function LanguageSwitch({ locale, onChange }: { locale: Locale; onChange: (locale: Locale) => void }) {
  return (
    <div className="locale-switch" role="group" aria-label={translate(locale, "界面语言")}>
      <button type="button" className={locale === "zh-CN" ? "active" : ""} aria-pressed={locale === "zh-CN"} onClick={() => onChange("zh-CN")}>中</button>
      <span aria-hidden="true">/</span>
      <button type="button" className={locale === "en" ? "active" : ""} aria-pressed={locale === "en"} onClick={() => onChange("en")}>EN</button>
    </div>
  );
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

export function MinefieldApp({ initialLocale }: { initialLocale: Locale }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const roomSocket = useMineRoomSocket({ autoResume: true });
  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty>("intermediate");
  const [session, setSession] = useState<Session | null>(null);
  const [pausedSession, setPausedSession] = useState<Session | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [connected, setConnected] = useState(false);
  const [tapMode, setTapMode] = useState<"reveal" | "mark">("reveal");
  const [chatDraft, setChatDraft] = useState("");
  const [sendingChat, setSendingChat] = useState(false);
  const [membershipAction, setMembershipAction] = useState<"player" | "spectator" | "leave" | null>(null);
  const [revivalDecision, setRevivalDecision] = useState<"watchAd" | "endGame" | null>(null);
  const [chordPreviewIndex, setChordPreviewIndex] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const roomRef = useRef<Room | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const uiGenerationRef = useRef(0);
  const actionQueue = useRef<Promise<void>>(Promise.resolve());
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedIndex = useRef<number | null>(null);
  const chordGestureIndex = useRef<number | null>(null);
  const suppressContextMenuIndex = useRef<number | null>(null);
  const suppressContextMenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const t = useCallback((key: Parameters<typeof translate>[1]) => translate(locale, key), [locale]);

  const changeLocale = useCallback((nextLocale: Locale) => {
    setLocale(nextLocale);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    } catch {
      // The cookie still keeps the preference when local storage is unavailable.
    }
    document.cookie = `${LOCALE_COOKIE}=${nextLocale}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }, []);

  useEffect(() => {
    let restoreTimer = 0;
    try {
      const saved = parseLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY));
      if (saved) restoreTimer = window.setTimeout(() => setLocale(saved), 0);
    } catch {
      // The server-selected locale remains valid when storage is unavailable.
    }
    const syncLocale = (event: StorageEvent) => {
      if (event.key !== LOCALE_STORAGE_KEY) return;
      const saved = parseLocale(event.newValue);
      if (saved) setLocale(saved);
    };
    window.addEventListener("storage", syncLocale);
    return () => {
      window.clearTimeout(restoreTimer);
      window.removeEventListener("storage", syncLocale);
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = META_COPY[locale].title;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description) description.content = META_COPY[locale].description;
  }, [locale]);

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

  useEffect(() => {
    const nextSession = roomSocket.session;
    const timer = window.setTimeout(() => {
      if (!nextSession) {
        if (sessionRef.current || roomRef.current) uiGenerationRef.current += 1;
        sessionRef.current = null;
        roomRef.current = null;
        setSession(null);
        setPausedSession(null);
        setRoom(null);
        return;
      }
      window.localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
      sessionRef.current = nextSession;
      setSession(nextSession);
      setName(nextSession.playerName || "");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [roomSocket.session]);

  useEffect(() => {
    if (!roomSocket.room) return;
    const timer = window.setTimeout(() => acceptRoom(roomSocket.room!), 0);
    return () => window.clearTimeout(timer);
  }, [acceptRoom, roomSocket.room]);

  useEffect(() => {
    const timer = window.setTimeout(() => setConnected(roomSocket.connected), 0);
    return () => window.clearTimeout(timer);
  }, [roomSocket.connected]);

  useEffect(() => {
    const timer = window.setTimeout(() => setError(
      roomSocket.error
        ? translateServerMessage(locale, roomSocket.error.code, roomSocket.error.message)
        : "",
    ), 0);
    return () => window.clearTimeout(timer);
  }, [locale, roomSocket.error]);

  const latestChatId = room?.chat?.at(-1)?.id;

  useEffect(() => {
    if (!latestChatId || !chatListRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const list = chatListRef.current;
      if (list) list.scrollTop = list.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [latestChatId]);

  useEffect(() => {
    if (room?.game.status !== "playing" && room?.revival?.phase !== "ad") return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [room?.game.status, room?.revival?.phase]);

  useEffect(() => {
    if (!room?.revival?.createdAt) return;
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
    longPressedIndex.current = null;
    chordGestureIndex.current = null;
    const frame = window.requestAnimationFrame(() => setChordPreviewIndex(null));
    return () => window.cancelAnimationFrame(frame);
  }, [room?.revival?.createdAt]);

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
    uiGenerationRef.current += 1;
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    sessionRef.current = next;
    actionQueue.current = Promise.resolve();
    setPausedSession(null);
    setChatDraft("");
    setSendingChat(false);
    setMembershipAction(null);
    setRevivalDecision(null);
    setSession(next);
  };

  const switchRole = async (targetRole: "player" | "spectator", sourceSession: Session | null = sessionRef.current) => {
    if (!sourceSession || membershipAction) return false;
    const generation = uiGenerationRef.current;
    const wasActive = sessionRef.current?.token === sourceSession.token;
    setMembershipAction(targetRole);
    setError("");
    try {
      await roomSocket.switchRole(targetRole);
      if (generation !== uiGenerationRef.current || (wasActive && sessionRef.current?.token !== sourceSession.token)) return false;
      persistSession({ ...sourceSession, role: targetRole } as Session);
      return true;
    } catch (switchError) {
      if (generation === uiGenerationRef.current) setError(displayError(switchError, locale));
      return false;
    } finally {
      if (generation === uiGenerationRef.current) setMembershipAction(null);
    }
  };

  const leaveMembership = async () => {
    const activeSession = sessionRef.current;
    if (!activeSession || membershipAction) return;
    const generation = uiGenerationRef.current;
    setMembershipAction("leave");
    setError("");
    try {
      await roomSocket.leaveMembership();
      if (generation !== uiGenerationRef.current || sessionRef.current?.token !== activeSession.token) return;
      uiGenerationRef.current += 1;
      window.localStorage.removeItem(SESSION_KEY);
      sessionRef.current = null;
      roomRef.current = null;
      actionQueue.current = Promise.resolve();
      setSession(null);
      setRoom(null);
      setPausedSession(null);
      setName("");
      setJoinCode("");
      setChatDraft("");
      setSendingChat(false);
      setMembershipAction(null);
      setRevivalDecision(null);
      setNotice("");
      setError("");
    } catch (leaveError) {
      if (generation === uiGenerationRef.current && sessionRef.current?.token === activeSession.token) setError(displayError(leaveError, locale));
    } finally {
      if (generation === uiGenerationRef.current) setMembershipAction(null);
    }
  };

  const createRoom = async (event: FormEvent) => {
    event.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) return setError(locale === "zh-CN" ? "先留个名字，不然队友没法甩锅。" : "Enter your name first, so your teammates know who to blame.");
    setLoading(true);
    setError("");
    try {
      const createdSession = await roomSocket.createRoom(cleanName, difficulty);
      if (!createdSession) throw new Error(roomSocket.error?.message || (locale === "zh-CN" ? "创建房间失败，请再试一次。" : "The room could not be created. Please try again."));
      persistSession(createdSession);
    } catch (createError) {
      setError(displayError(createError, locale));
    } finally {
      setLoading(false);
    }
  };

  const enterRoom = async (op: "join" | "spectate") => {
    const cleanName = name.trim();
    const cleanCode = joinCode.replace(/[^a-z0-9]/gi, "").toUpperCase();
    const targetRole = op === "join" ? "player" : "spectator";
    if (!cleanName) return setError(locale === "zh-CN" ? "先留个名字，不然队友没法甩锅。" : "Enter your name first, so your teammates know who to blame.");
    if (cleanCode.length !== 6) return setError(locale === "zh-CN" ? "房间码是 6 位，检查一下再进。" : "Room codes contain 6 characters. Check the code and try again.");
    setLoading(true);
    setError("");
    try {
      if (pausedSession?.code === cleanCode) {
        const pausedRole = pausedSession.role ?? "player";
        if (pausedRole === targetRole) {
          persistSession(pausedSession);
          roomSocket.connect(pausedSession);
          if (roomSocket.room) acceptRoom(roomSocket.room);
        } else {
          persistSession(pausedSession);
          roomSocket.connect(pausedSession);
          await switchRole(targetRole, pausedSession);
        }
        return;
      }
      const joinedSession = await roomSocket.joinRoom(cleanCode, cleanName, targetRole);
      if (!joinedSession) throw new Error(roomSocket.error?.message || (locale === "zh-CN" ? "加入房间失败，请再试一次。" : "The room could not be joined. Please try again."));
      persistSession(joinedSession);
    } catch (joinError) {
      const message = displayError(joinError, locale);
      setError(op === "join" && /满|full/i.test(message)
        ? locale === "zh-CN" ? `${message} 还可以点“旁观”进入房间。` : `${message} You can still join as a spectator.`
        : message);
    } finally {
      setLoading(false);
    }
  };

  const joinRoom = (event: FormEvent) => {
    event.preventDefault();
    void enterRoom("join");
  };

  const leaveRoom = () => {
    if (membershipAction) return;
    if (session) setPausedSession(session);
    roomSocket.pause();
    uiGenerationRef.current += 1;
    sessionRef.current = null;
    actionQueue.current = Promise.resolve();
    setSession(null);
    setRoom(null);
    setJoinCode("");
    setChatDraft("");
    setSendingChat(false);
    setRevivalDecision(null);
    setError("");
  };

  const resumeRoom = () => {
    if (!pausedSession || loading) return;
    persistSession(pausedSession);
    roomSocket.connect(pausedSession);
    if (roomSocket.room) acceptRoom(roomSocket.room);
  };

  const commitAction = useCallback((action: GameAction) => {
    const activeSession = sessionRef.current;
    if (!activeSession || activeSession.role === "spectator") return Promise.resolve();
    const activeRevival = roomRef.current?.revival;
    const isRevivalDecision = action.type === "watchAd" || action.type === "endGame";
    const generation = uiGenerationRef.current;
    if ((activeRevival && !isRevivalDecision) || (!activeRevival && isRevivalDecision)) return Promise.resolve();
    return actionQueue.current = actionQueue.current.then(async () => {
      if (generation !== uiGenerationRef.current) return;
      try {
        await roomSocket.sendAction(action);
        if (generation !== uiGenerationRef.current || sessionRef.current?.token !== activeSession.token) return;
        setError("");
      } catch (actionError) {
        if (generation !== uiGenerationRef.current || sessionRef.current?.token !== activeSession.token) return;
        setError(displayError(actionError, locale));
        await roomSocket.sync().catch(() => undefined);
      }
    });
  }, [locale, roomSocket]);

  const submitRevivalDecision = (decision: "watchAd" | "endGame") => {
    if (isSpectator || room?.revival?.phase !== "prompt" || revivalDecision) return;
    setRevivalDecision(decision);
    const generation = uiGenerationRef.current;
    void commitAction({ type: decision }).finally(() => {
      if (generation !== uiGenerationRef.current) return;
      setRevivalDecision((current) => current === decision ? null : current);
    });
  };

  const sendChat = async (event: FormEvent) => {
    event.preventDefault();
    const message = chatDraft.trim();
    const activeSession = sessionRef.current;
    if (!activeSession || !message || sendingChat) return;
    const generation = uiGenerationRef.current;
    setSendingChat(true);
    try {
      await roomSocket.sendChat(message);
      if (generation !== uiGenerationRef.current || sessionRef.current?.token !== activeSession.token) return;
      setChatDraft("");
      setError("");
    } catch (chatError) {
      if (generation !== uiGenerationRef.current || sessionRef.current?.token !== activeSession.token) return;
      setError(displayError(chatError, locale));
    } finally {
      if (generation === uiGenerationRef.current && sessionRef.current?.token === activeSession.token) setSendingChat(false);
    }
  };

  const copyInvite = async () => {
    if (!room) return;
    const link = `${window.location.origin}/?room=${room.code}`;
    try {
      await navigator.clipboard.writeText(locale === "zh-CN"
        ? `来同雷共苦：房间 ${room.code}\n${link}`
        : `Join Mine Together, Blame Together — room ${room.code}\n${link}`);
      setNotice(locale === "zh-CN" ? "邀请已复制，祝你们友谊长存" : "Invite copied. May your friendship survive.");
    } catch {
      setNotice(locale === "zh-CN" ? `房间码：${room.code}` : `Room code: ${room.code}`);
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

  const status = room ? statusCopy(room.game, room.players, locale) : null;
  const revival = room?.revival ?? null;
  const isRevivalLocked = Boolean(revival);
  const isMembershipPending = Boolean(membershipAction);
  const seconds = room ? secondsFor(room.game, revival?.createdAt ?? now) : 0;
  const adSecondsRemaining = revival?.phase === "ad" && revival.adEndsAt
    ? Math.max(0, Math.min(10, Math.ceil((revival.adEndsAt - now) / 1000)))
    : 10;
  const isAdFinished = revival?.phase === "ad" && revival.adEndsAt !== null && now >= revival.adEndsAt;
  const currentDifficulty = room?.game.difficulty ?? difficulty;
  const isSpectator = (session?.role ?? "player") === "spectator";
  const me = room?.players.find((player) => player.id === session?.playerId);
  const spectatorMe = room?.spectators?.find((spectator) => spectator.id === session?.playerId);
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
          <a className="brand" href="#" aria-label={t("同雷共苦首页")}>
            <span className="brand-mark" aria-hidden="true">✹</span>
            <span>{t("同雷共苦")}</span>
          </a>
          <div className="topbar-actions">
            <span className="topbar-note"><i /> {t("最多四人实时扫雷 · 好友围观")}</span>
            <LanguageSwitch locale={locale} onChange={changeLocale} />
          </div>
        </header>

        <section className="lobby-grid">
          <div className="hero-copy">
            <p className="kicker">LIVE CO-OP MINESWEEPER</p>
            <h1>{t("一块雷区，")}<br /><em>{t("全队一起背锅。")}</em></h1>
            <p className="hero-lede">{t("经典扫雷的全部紧张感，再加上最多三个会乱插旗的朋友和一群在线围观群众。双击多开、右键标记、首击安全——以及一个随时可以甩锅的聊天区。")}</p>

            <div className="pressure-card" aria-label={t("血压预警")}>
              <div className="pressure-head"><span>{t("血压预警")}</span><strong>{t("偏高")}</strong></div>
              <div className="pressure-track"><span /><span /><span /><span /><span /></div>
              <p>{t("错误插旗不会立刻输，但可能让队友的多开直接起飞。")}</p>
            </div>

            <div className="feature-tape" aria-label={t("游戏特性")}>
              <span>{t("同盘实时同步")}</span><span>{t("玩家与旁观聊天")}</span><span>{t("手机长按插旗")}</span>
            </div>
          </div>

          <div className="lobby-console">
            <div className="console-title">
              <div><p>{t("准备进入雷区")}</p><h2>{t("先报上名来")}</h2></div>
              <span className="console-index">01</span>
            </div>
            {pausedSession && (
              <button className="resume-room" type="button" disabled={loading || Boolean(membershipAction)} onClick={resumeRoom}>
                <span>{pausedSession.role === "spectator" ? t("继续旁观") : t("继续刚才的房间")}</span><strong>{pausedSession.code}</strong><b aria-hidden="true">→</b>
              </button>
            )}
            <label className="field-label" htmlFor="player-name">{t("你的名字")}</label>
            <input id="player-name" className="text-input" value={name} maxLength={16} onChange={(event) => setName(event.target.value)} placeholder={t("例如：绝不乱点的小刘")} autoComplete="nickname" />

            <form onSubmit={createRoom} className="console-section">
              <div className="section-heading"><span>{t("创建新房间")}</span><small>{t("可以先单人开扫")}</small></div>
              <div className="difficulty-grid" role="group" aria-label={t("选择难度")}>
                {(Object.keys(DIFFICULTY_SPECS) as Difficulty[]).map((key) => (
                  <button key={key} type="button" className={difficulty === key ? "difficulty-option active" : "difficulty-option"} onClick={() => setDifficulty(key)}>
                    <strong>{difficultyCopy(locale, key).label}</strong><span>{difficultyCopy(locale, key).meta}</span>
                  </button>
                ))}
              </div>
              <button className="primary-button" disabled={loading} type="submit"><span>{loading ? t("正在布置雷区…") : t("创建房间")}</span><b aria-hidden="true">↗</b></button>
            </form>

            <div className="or-line"><span>{t("或者加入朋友")}</span></div>

            <form onSubmit={joinRoom} className="join-row">
              <label className="sr-only" htmlFor="room-code">{t("6 位房间码")}</label>
              <input id="room-code" className="text-input code-input" value={joinCode} maxLength={6} onChange={(event) => setJoinCode(event.target.value.replace(/[^a-z0-9]/gi, "").toUpperCase())} placeholder={t("房间码")} autoCapitalize="characters" />
              <div className="join-actions">
                <button className="secondary-button" disabled={loading} type="submit">{loading ? t("处理中…") : t("加入游戏")}</button>
                <button className="spectate-button" disabled={loading} type="button" onClick={() => void enterRoom("spectate")}>{loading ? t("处理中…") : t("作为旁观者加入")}</button>
              </div>
            </form>
            <p className="spectate-hint">{t("旁观不占玩家席位 · 可以看棋盘和参与聊天")}</p>
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
        </section>

        <footer className="site-footer"><span>{t("四人下场 · 好友旁观 · 全员聊天")}</span><span>NO FRIENDSHIPS WERE GUARANTEED</span></footer>
      </main>
    );
  }

  return (
    <main className="site-shell game-shell">
      <header className="topbar game-topbar">
        <button className="brand brand-button" disabled={isMembershipPending} onClick={leaveRoom} aria-label={t("暂时离开并保留席位，返回首页")}>
          <span className="brand-mark" aria-hidden="true">✹</span><span>{t("同雷共苦")}</span>
        </button>
        <div className="room-identity">
          <span>{t("房间")}</span><strong>{room.code}</strong>
          <button onClick={copyInvite}>{t("复制邀请")}</button>
        </div>
        <div className="game-topbar-actions">
          <span className={connected ? "connection-state online" : "connection-state"}><i />{isSpectator ? (connected ? t("旁观中") : t("重连中")) : (connected ? t("同步中") : t("重连中"))}</span>
          <LanguageSwitch locale={locale} onChange={changeLocale} />
        </div>
      </header>

      <section className="game-layout">
        <div className="board-column">
          <div className="game-status-line">
            <div>
              <p>{isSpectator ? "SPECTATING" : status?.eyebrow}</p>
              <h1>{isSpectator ? t("前排围观友谊危机") : status?.title}</h1>
              <span>{isSpectator ? t("你以旁观者身份进入，棋盘只读；可以在聊天区和大家交流。") : status?.body}</span>
            </div>
            <div className="friendship-meter">
              <span>{t("友谊耐久")}</span>
              <strong>{friendship}%</strong>
              <div><i style={{ width: `${friendship}%` }} /></div>
            </div>
          </div>

          <section className={`mine-console status-${room.game.status}${isRevivalLocked ? " revival-active" : ""}`} aria-label={t("扫雷棋盘")}>
            <div className="classic-display">
              <div className="digit-box"><small>{t("剩余雷数")}</small><strong>{formatCounter(room.game.mines - room.game.flags)}</strong></div>
              <button className="face-button" onClick={() => commitAction({ type: "restart" })} aria-label={isSpectator ? t("旁观模式，不能重新开始") : isRevivalLocked ? t("事故处理中，暂时不能重新开始") : t("重新开始")} disabled={!connected || isSpectator || isRevivalLocked || isMembershipPending}>
                {isRevivalLocked ? "⊙_⊙" : room.game.status === "lost" ? "×_×" : room.game.status === "won" ? "^‿^" : room.game.status === "playing" ? "•_•" : "•‿•"}
              </button>
              <div className="digit-box align-right"><small>{t("用时")}</small><strong>{formatCounter(seconds)}</strong></div>
            </div>

            <div className="board-scroll">
              <div className="mine-board" style={boardStyle} role="grid" aria-label={`${difficultyCopy(locale, currentDifficulty).label} ${t("扫雷棋盘")}`}>
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
                  const position = locale === "zh-CN" ? `第 ${cell.row + 1} 行第 ${cell.col + 1} 列` : `Row ${cell.row + 1}, column ${cell.col + 1}`;
                  const label = locale === "zh-CN"
                    ? cell.state === "flagged" ? `${position}，已插旗` : cell.state === "questioned" ? `${position}，问号标记` : cell.state === "revealed" ? `${position}，${cell.mine ? "地雷" : `${cell.adjacent ?? 0} 个相邻雷`}` : `${position}，未揭开`
                    : cell.state === "flagged" ? `${position}, flagged` : cell.state === "questioned" ? `${position}, marked with a question` : cell.state === "revealed" ? `${position}, ${cell.mine ? "mine" : `${cell.adjacent ?? 0} adjacent mines`}` : `${position}, hidden`;
                  return (
                    <button
                      key={cell.index}
                      className={`mine-cell ${stateClass}`}
                      role="gridcell"
                      aria-label={label}
                      disabled={!connected || isSpectator || isRevivalLocked || isMembershipPending || room.game.status === "won" || room.game.status === "lost"}
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

            {!isSpectator && (
              <div className={`mobile-mode${isRevivalLocked ? " locked" : ""}`} role="group" aria-label={t("触屏操作模式")}>
                <button className={tapMode === "reveal" ? "active" : ""} disabled={!connected || isRevivalLocked || isMembershipPending} onClick={() => setTapMode("reveal")}>{t("轻触排雷")}</button>
                <button className={tapMode === "mark" ? "active" : ""} disabled={!connected || isRevivalLocked || isMembershipPending} onClick={() => setTapMode("mark")}>{t("轻触标记")}</button>
                <span>{t("也可长按插旗")}</span>
              </div>
            )}

            {revival && (
              <div className={`revival-overlay revival-${revival.phase}`} role="dialog" aria-modal="false" aria-labelledby="revival-title">
                <div className="revival-card">
                  {revival.phase === "prompt" ? (
                    <>
                      <div className="revival-warning"><span aria-hidden="true">!</span> FRIENDSHIP EMERGENCY</div>
                      <div className="revival-accident-icon" aria-hidden="true">✹</div>
                      <p className="revival-culprit"><strong>{revival.triggeredByName}</strong> {t("刚刚非常精准地踩中了雷")}</p>
                      <h2 id="revival-title">{t("这段友谊还有抢救价值吗？")}</h2>
                      <p className="revival-explainer">{t("只要有一位玩家选择看广告，所有参赛玩家就得一起看，然后棋盘会回到踩雷前。")}</p>
                      {isSpectator ? (
                        <div className="revival-spectator-wait">
                          <span className="waiting-dots" aria-hidden="true"><i /><i /><i /></span>
                          <p>{t("等待场上玩家决定。旁观席暂时只有起哄权，没有生杀大权。")}</p>
                        </div>
                      ) : (
                        <div className="revival-actions">
                          <button className="revival-watch-button" type="button" disabled={!connected || Boolean(revivalDecision)} onClick={() => submitRevivalDecision("watchAd")}>
                            <span>{revivalDecision === "watchAd" ? t("正在召集所有参赛玩家…") : t("看广告复活")}</span><b aria-hidden="true">▶</b>
                          </button>
                          <p className="ad-rental">{t("（广告位招租中……）")}</p>
                          <button className="revival-end-button" type="button" disabled={!connected || Boolean(revivalDecision)} onClick={() => submitRevivalDecision("endGame")}>
                            {revivalDecision === "endGame" ? t("正在结束本局…") : t("结束游戏")}
                          </button>
                        </div>
                      )}
                    </>
                  ) : isSpectator ? (
                    <>
                      <div className="revival-ad-label"><span>GAME PAUSED</span><b>{t("旁观提示")}</b></div>
                      <p className="revival-forced spectator-copy">{t("场上玩家正在看广告")}</p>
                      <h2 id="revival-title">{isAdFinished ? t("棋盘即将恢复") : t("旁观席免广告")}</h2>
                      <p className="revival-spectator-free">{isAdFinished ? t("场上玩家正在复活；旁观者可以继续聊天围观。") : t("场上玩家正在看广告；旁观者免广告，可继续聊天围观。")}</p>
                      <div className={`revival-countdown spectator-countdown${isAdFinished ? " finished" : ""}`} aria-live="polite" aria-label={locale === "zh-CN" ? `场上游戏预计 ${adSecondsRemaining} 秒后恢复` : `The game should resume in ${adSecondsRemaining} ${adSecondsRemaining === 1 ? "second" : "seconds"}`}>
                        <strong>{adSecondsRemaining}</strong><small>{locale === "en" && adSecondsRemaining === 1 ? "second to resume" : t("秒后继续")}</small>
                      </div>
                      <div className="revival-spectator-perk">
                        <span aria-hidden="true">◉</span><div><b>{t("免广告旁观通道")}</b><small>{t("棋盘暂停不耽误聊天区继续起哄")}</small></div>
                      </div>
                      <p className="revival-no-skip">{isAdFinished ? t("服务器正在恢复场上棋盘，请稍候……") : t("你没有复活选择权，但也没有陪看广告的义务。")}</p>
                    </>
                  ) : (
                    <>
                      <div className="revival-ad-label"><span>AD BREAK</span><b>{t("场上同步")}</b></div>
                      <p className="revival-forced">{t("所有参赛玩家被迫观看")}</p>
                      <h2 id="revival-title">{isAdFinished ? t("正在复活") : t("广告播放中")}</h2>
                      <p className="ad-rental">{t("（广告位招租中……）")}</p>
                      <div className={`revival-countdown${isAdFinished ? " finished" : ""}`} aria-live="polite" aria-label={locale === "zh-CN" ? `广告剩余 ${adSecondsRemaining} 秒` : `${adSecondsRemaining} ${adSecondsRemaining === 1 ? "second" : "seconds"} left in the ad`}>
                        <strong>{adSecondsRemaining}</strong><small>{locale === "en" && adSecondsRemaining === 1 ? "second" : t("秒")}</small>
                      </div>
                      <div className="revival-ad-space" aria-hidden="true">
                        <span>YOUR AD HERE</span>
                        <b>{locale === "zh-CN" ? <>本广告位可精准触达<br />正在互相甩锅的高净值好友</> : <>Reach a premium audience<br />of friends blaming one another</>}</b>
                        <i>{t("商务合作 · 请在聊天区自行报价")}</i>
                      </div>
                      <p className="revival-no-skip">{isAdFinished ? t("服务器正在把场上棋盘拨回踩雷前，请稍候……") : t("无法跳过：你的朋友已经替你做了决定。")}</p>
                    </>
                  )}
                </div>
              </div>
            )}
          </section>

          <div className="board-help">
            {isSpectator ? <span><b>{t("旁观模式")}</b> {t("棋盘实时同步但不可操作，欢迎在聊天区指挥。")}</span> : <><span><b>{t("左键")}</b> {t("揭开")}</span><span><b>{t("右键")}</b> {t("旗帜 / 问号")}</span><span><b>{t("左右键齐按 / 双击数字")}</b> {t("多开周围")}</span><span><b>{t("空格")}</b> {t("标记")}</span></>}
          </div>

          <div className="board-lower-panels">
            <section className="panel-section settings-section board-settings-section">
              <div className="panel-heading"><span>{isSpectator ? t("旁观状态") : t("本局设置")}</span>{isSpectator && <small>READ ONLY</small>}</div>
              <div className={`settings-controls${isSpectator ? " spectator-controls" : ""}`}>
                {isSpectator ? (
                  <p className="spectator-note">{locale === "zh-CN" ? <>你正在以 <strong>{spectatorMe?.name ?? session.playerName}</strong> 的身份旁观。棋盘操作与本局设置已锁定，聊天仍可使用。</> : <>You are spectating as <strong>{spectatorMe?.name ?? session.playerName}</strong>. Board controls and game settings are locked; chat remains available.</>}</p>
                ) : (
                  <>
                    <div className="settings-field">
                      <label htmlFor="game-difficulty">{t("难度")}</label>
                      <select id="game-difficulty" value={currentDifficulty} disabled={!connected || isRevivalLocked || isMembershipPending} onChange={(event) => commitAction({ type: "changeDifficulty", difficulty: event.target.value as Difficulty })}>
                        {(Object.keys(DIFFICULTY_SPECS) as Difficulty[]).map((key) => <option value={key} key={key}>{difficultyCopy(locale, key).label} · {difficultyCopy(locale, key).meta}</option>)}
                      </select>
                    </div>
                    <button className="restart-button" type="button" disabled={!connected || isRevivalLocked || isMembershipPending} onClick={() => commitAction({ type: "restart" })}>{t("重新布置雷区")}</button>
                  </>
                )}
                <div className="membership-actions">
                  <button className="membership-switch-button" type="button" disabled={!connected || isMembershipPending} onClick={() => void switchRole(isSpectator ? "player" : "spectator")}>
                    {membershipAction === "player" ? t("正在加入雷区…") : membershipAction === "spectator" ? t("正在转入旁观席…") : isSpectator ? t("加入雷区") : t("转为旁观者")}
                  </button>
                  <button className="leave-button" type="button" disabled={isMembershipPending} onClick={leaveRoom}>{t("暂时离开（保留席位）")}</button>
                  <button className="membership-exit-button" type="button" disabled={!connected || isMembershipPending} onClick={() => void leaveMembership()}>
                    {membershipAction === "leave" ? t("正在退出…") : isSpectator ? t("退出旁观席") : t("退出雷区并释放席位")}
                  </button>
                </div>
              </div>
            </section>

            <section className="panel-section activity-section board-activity-section">
              <div className="panel-heading"><span>{t("事故记录")}</span><small>LIVE</small></div>
              <div className="activity-list">
                {room.activity.length ? room.activity.slice(0, 7).map((item) => {
                  const actorSlot = room.players.find((player) => player.id === item.playerId)?.slot;
                  return (
                    <div className="activity-item" key={item.id}>
                      <i className={actorSlot ? `p${actorSlot}` : undefined} aria-hidden="true" />
                      <p><strong>{item.playerName}</strong>{activityCopy(item, locale)}<time>{new Date(item.createdAt).toLocaleTimeString(locale === "zh-CN" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" })}</time></p>
                    </div>
                  );
                }) : <p className="empty-activity">{t("还没有事故。很快就会有的。")}</p>}
              </div>
            </section>
          </div>
        </div>

        <aside className="side-panel">
          <section className="panel-section players-section">
            <div className="panel-heading"><span>{t("雷区成员")}</span><small>{room.players.length}/4</small></div>
            {([1, 2, 3, 4] as const).map((slot) => {
              const player = room.players.find((candidate) => candidate.slot === slot);
              return player ? (
                <div className={`player-card player-${slot}`} key={slot}>
                  <div className="player-avatar">{player.name.slice(0, 1).toUpperCase()}</div>
                  <div><strong>{player.name}{player.id === me?.id ? t("（你）") : ""}</strong><span>{player.online ? t("正在雷区") : t("暂时离线")}</span></div>
                  <i className={player.online ? "online" : ""} />
                </div>
              ) : (
                <button className="empty-player" key={slot} onClick={copyInvite}><span>+</span><div><strong>{t("等待队友")}</strong><small>{t("点击复制邀请")}</small></div></button>
              );
            })}
            <div className="spectator-heading">
              <span>{t("旁观席")}</span><small>{locale === "zh-CN" ? `${room.spectators?.length ?? 0} 人` : `${room.spectators?.length ?? 0} ${(room.spectators?.length ?? 0) === 1 ? "person" : "people"}`}</small>
            </div>
            {room.spectators?.length ? (
              <div className="spectator-list">
                {room.spectators.map((spectator) => (
                  <div className="spectator-card" key={spectator.id}>
                    <span className="spectator-avatar" aria-hidden="true">◉</span>
                    <strong>{spectator.name}{spectator.id === spectatorMe?.id ? t("（你）") : ""}</strong>
                    <i className={spectator.online ? "online" : ""} title={spectator.online ? t("正在旁观") : t("暂时离线")} />
                  </div>
                ))}
              </div>
            ) : <p className="empty-spectators">{t("还没有围观群众。")}</p>}
          </section>

          <section className="panel-section chat-section">
            <div className="panel-heading"><span>{t("房间聊天")}</span><small>{isSpectator ? t("旁观也能聊") : "ALL HANDS"}</small></div>
            <div className="chat-list" ref={chatListRef} aria-live="polite" aria-label={t("房间聊天记录")}>
              {room.chat?.length ? room.chat.map((message) => {
                const slotClass = message.senderRole === "player" && message.senderSlot ? ` chat-player-${message.senderSlot}` : " chat-spectator";
                const isMine = message.senderId === session.playerId;
                return (
                  <article className={`chat-message${slotClass}${isMine ? " mine" : ""}`} key={message.id}>
                    <div className="chat-message-meta">
                      <strong>{message.senderName}{isMine ? t("（你）") : ""}</strong>
                      <span>{message.senderRole === "spectator" ? t("旁观") : locale === "zh-CN" ? `${message.senderSlot ?? "?"} 号玩家` : `Player ${message.senderSlot ?? "?"}`}</span>
                      <time>{new Date(message.createdAt).toLocaleTimeString(locale === "zh-CN" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" })}</time>
                    </div>
                    <p>{message.content}</p>
                  </article>
                );
              }) : <div className="empty-chat"><span aria-hidden="true">…</span><p>{t("还没人开口。先发一句“这格肯定安全”。")}</p></div>}
            </div>
            <form className="chat-form" onSubmit={sendChat}>
              <label className="sr-only" htmlFor="chat-message">{t("发送聊天消息")}</label>
              <textarea
                id="chat-message"
                disabled={!connected}
                value={chatDraft}
                maxLength={240}
                rows={2}
                onChange={(event) => setChatDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={isSpectator ? t("给场上选手一点建议…") : t("和队友商量，或提前甩锅…")}
              />
              <div><small>{chatDraft.length}/240</small><button type="submit" disabled={!connected || !chatDraft.trim() || sendingChat}>{sendingChat ? t("发送中") : t("发送")}</button></div>
            </form>
          </section>

        </aside>
      </section>

      {(notice || error) && <div className={error ? "toast error-toast" : "toast"} role="status">{error || notice}</div>}
    </main>
  );
}
