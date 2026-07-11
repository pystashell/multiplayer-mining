/**
 * A serializable, immutable Minesweeper engine.
 *
 * Keep the complete GameState on the authoritative server: hidden cells still
 * contain `isMine`, so a network layer should redact that field before sending
 * an in-progress board to an untrusted client.
 */

export interface DifficultyPreset {
  readonly id: Difficulty;
  readonly width: number;
  readonly height: number;
  readonly mineCount: number;
}

export const DIFFICULTY_PRESETS = {
  beginner: { id: "beginner", width: 9, height: 9, mineCount: 10 },
  intermediate: { id: "intermediate", width: 16, height: 16, mineCount: 40 },
  expert: { id: "expert", width: 30, height: 16, mineCount: 99 },
} as const;

export type Difficulty = keyof typeof DIFFICULTY_PRESETS;
export type GameDifficulty = Difficulty | "custom";
export type GameStatus = "ready" | "playing" | "won" | "lost";
export type PlayerId = string;
export type CellMark = "hidden" | "flagged" | "questioned";

export interface GameConfig {
  width: number;
  height: number;
  mineCount: number;
  difficulty?: GameDifficulty;
}

export interface Cell {
  x: number;
  y: number;
  isMine: boolean;
  adjacentMines: number;
  isRevealed: boolean;
  isFlagged: boolean;
  /** Classic uncertain mark; unlike a flag, it does not protect the cell. */
  isQuestioned: boolean;
  /** True only for a mine directly opened by the losing action. */
  isExploded: boolean;
  /** The player responsible for revealing this cell, including flood reveals. */
  revealedBy: PlayerId | null;
  /** The player who placed the current flag. */
  flaggedBy: PlayerId | null;
}

export interface GameState {
  schemaVersion: 1;
  difficulty: GameDifficulty;
  width: number;
  height: number;
  mineCount: number;
  cells: Cell[];
  status: GameStatus;
  /** False until the first successful reveal action. */
  minesPlaced: boolean;
  revealedSafeCells: number;
  flagsPlaced: number;
  /** Unix time in milliseconds, set by the first successful reveal. */
  startedAt: number | null;
  /** Unix time in milliseconds, set on win or loss. */
  endedAt: number | null;
  /** Incremented once for every action that changes the state. */
  revision: number;
}

export type RandomSource = () => number;
export type Clock = () => number;

/** Dependencies and authenticated player metadata supplied by the server. */
export interface ActionContext {
  random?: RandomSource;
  now?: Clock;
  actorId?: PlayerId;
}

export type GameAction =
  | { type: "reveal"; x: number; y: number }
  | { type: "toggleFlag"; x: number; y: number }
  | { type: "setMark"; x: number; y: number; mark: CellMark }
  | { type: "chord"; x: number; y: number }
  | { type: "restart" }
  | { type: "changeDifficulty"; difficulty: Difficulty };

const UINT32_RANGE = 0x1_0000_0000;

/** A Web Crypto random source that works in browsers and Cloudflare Workers. */
export const secureRandom: RandomSource = () => {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Web Crypto getRandomValues is required to place mines securely.");
  }

  const value = new Uint32Array(1);
  globalThis.crypto.getRandomValues(value);
  return value[0] / UINT32_RANGE;
};

const systemClock: Clock = () => Date.now();

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer.`);
  }
}

function validateConfig(config: GameConfig): void {
  assertPositiveInteger(config.width, "width");
  assertPositiveInteger(config.height, "height");

  if (!Number.isSafeInteger(config.mineCount) || config.mineCount < 0) {
    throw new RangeError("mineCount must be a non-negative safe integer.");
  }

  const maximumMines = config.width * config.height - 1;
  if (config.mineCount > maximumMines) {
    throw new RangeError(
      `mineCount must be at most ${maximumMines} so the first revealed cell can be safe.`,
    );
  }
}

function resolveConfig(input: Difficulty | GameConfig): Required<GameConfig> {
  if (typeof input === "string") {
    const preset = DIFFICULTY_PRESETS[input];
    return { ...preset, difficulty: preset.id };
  }

  return {
    width: input.width,
    height: input.height,
    mineCount: input.mineCount,
    difficulty: input.difficulty ?? "custom",
  };
}

function blankCells(width: number, height: number): Cell[] {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width,
    y: Math.floor(index / width),
    isMine: false,
    adjacentMines: 0,
    isRevealed: false,
    isFlagged: false,
    isQuestioned: false,
    isExploded: false,
    revealedBy: null,
    flaggedBy: null,
  }));
}

/** Create a blank board. Mines are deliberately not placed yet. */
export function createGame(input: Difficulty | GameConfig = "beginner"): GameState {
  const config = resolveConfig(input);
  validateConfig(config);

  return {
    schemaVersion: 1,
    difficulty: config.difficulty,
    width: config.width,
    height: config.height,
    mineCount: config.mineCount,
    cells: blankCells(config.width, config.height),
    status: "ready",
    minesPlaced: false,
    revealedSafeCells: 0,
    flagsPlaced: 0,
    startedAt: null,
    endedAt: null,
    revision: 0,
  };
}

export function isInBounds(state: GameState, x: number, y: number): boolean {
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < state.width &&
    y < state.height
  );
}

export function cellIndex(state: Pick<GameState, "width">, x: number, y: number): number {
  return y * state.width + x;
}

export function getCell(state: GameState, x: number, y: number): Cell | undefined {
  return isInBounds(state, x, y) ? state.cells[cellIndex(state, x, y)] : undefined;
}

function adjacentIndexes(state: Pick<GameState, "width" | "height">, x: number, y: number): number[] {
  const indexes: number[] = [];

  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      if (offsetX === 0 && offsetY === 0) continue;

      const neighborX = x + offsetX;
      const neighborY = y + offsetY;
      if (
        neighborX >= 0 &&
        neighborY >= 0 &&
        neighborX < state.width &&
        neighborY < state.height
      ) {
        indexes.push(neighborY * state.width + neighborX);
      }
    }
  }

  return indexes;
}

export function getAdjacentCells(state: GameState, x: number, y: number): Cell[] {
  if (!isInBounds(state, x, y)) return [];
  return adjacentIndexes(state, x, y).map((index) => state.cells[index]);
}

function cloneCells(cells: readonly Cell[]): Cell[] {
  return cells.map((cell) => ({ ...cell }));
}

function sampleIndex(random: RandomSource, upperBound: number): number {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("RandomSource must return a finite number in the range [0, 1).");
  }
  return Math.floor(value * upperBound);
}

function placeMines(
  state: GameState,
  cells: Cell[],
  safeX: number,
  safeY: number,
  random: RandomSource,
): void {
  const excluded = cellIndex(state, safeX, safeY);
  const candidates: number[] = [];

  for (let index = 0; index < cells.length; index += 1) {
    if (index !== excluded) candidates.push(index);
  }

  // Partial Fisher-Yates shuffle: only the selected prefix is randomized.
  for (let selected = 0; selected < state.mineCount; selected += 1) {
    const swapWith = selected + sampleIndex(random, candidates.length - selected);
    [candidates[selected], candidates[swapWith]] = [candidates[swapWith], candidates[selected]];
    cells[candidates[selected]].isMine = true;
  }

  for (const cell of cells) {
    cell.adjacentMines = adjacentIndexes(state, cell.x, cell.y).reduce(
      (count, index) => count + (cells[index].isMine ? 1 : 0),
      0,
    );
  }
}

function readTimestamp(clock: Clock | undefined): number {
  const timestamp = (clock ?? systemClock)();
  if (!Number.isFinite(timestamp)) {
    throw new RangeError("Clock must return a finite timestamp.");
  }
  return timestamp;
}

function revealSafeArea(
  state: GameState,
  cells: Cell[],
  startingIndexes: readonly number[],
  actorId: PlayerId | undefined,
): number {
  const pending = [...startingIndexes];
  const queued = new Set(pending);
  let revealed = 0;

  while (pending.length > 0) {
    const index = pending.pop()!;
    const cell = cells[index];

    // Flags always protect a cell, including from zero-cell flood opening.
    if (cell.isRevealed || cell.isFlagged || cell.isMine) continue;

    cell.isRevealed = true;
    cell.isQuestioned = false;
    cell.revealedBy = actorId ?? null;
    revealed += 1;

    if (cell.adjacentMines !== 0) continue;

    for (const neighborIndex of adjacentIndexes(state, cell.x, cell.y)) {
      if (!queued.has(neighborIndex)) {
        queued.add(neighborIndex);
        pending.push(neighborIndex);
      }
    }
  }

  return revealed;
}

function completeWin(state: GameState, cells: Cell[], timestamp: number, actorId?: PlayerId): GameState {
  for (const cell of cells) {
    if (!cell.isMine) continue;
    cell.isFlagged = true;
    cell.isQuestioned = false;
    cell.flaggedBy ??= actorId ?? null;
  }

  return {
    ...state,
    cells,
    status: "won",
    flagsPlaced: state.mineCount,
    endedAt: timestamp,
    revision: state.revision + 1,
  };
}

function completeLoss(state: GameState, cells: Cell[], timestamp: number): GameState {
  // Reveal the mine layout at game over while preserving every player's flags.
  for (const cell of cells) {
    if (cell.isMine) {
      cell.isRevealed = true;
      if (!cell.isFlagged) cell.isQuestioned = false;
    }
  }

  return {
    ...state,
    cells,
    status: "lost",
    endedAt: timestamp,
    revision: state.revision + 1,
  };
}

/** Reveal one cell, with lazy first-cell-safe mine placement and zero flood fill. */
export function revealCell(
  state: GameState,
  x: number,
  y: number,
  context: ActionContext = {},
): GameState {
  if (state.status === "won" || state.status === "lost" || !isInBounds(state, x, y)) {
    return state;
  }

  const targetIndex = cellIndex(state, x, y);
  const existingTarget = state.cells[targetIndex];
  if (existingTarget.isRevealed || existingTarget.isFlagged) return state;

  const timestamp = readTimestamp(context.now);
  const cells = cloneCells(state.cells);
  let workingState = state;

  if (!state.minesPlaced) {
    placeMines(state, cells, x, y, context.random ?? secureRandom);
    workingState = {
      ...state,
      minesPlaced: true,
      status: "playing",
      startedAt: timestamp,
    };
  }

  const target = cells[targetIndex];
  if (target.isMine) {
    target.isRevealed = true;
    target.isQuestioned = false;
    target.isExploded = true;
    target.revealedBy = context.actorId ?? null;
    return completeLoss(workingState, cells, timestamp);
  }

  const newlyRevealed = revealSafeArea(workingState, cells, [targetIndex], context.actorId);
  const revealedSafeCells = workingState.revealedSafeCells + newlyRevealed;
  workingState = { ...workingState, revealedSafeCells };

  if (revealedSafeCells === workingState.width * workingState.height - workingState.mineCount) {
    return completeWin(workingState, cells, timestamp, context.actorId);
  }

  return {
    ...workingState,
    cells,
    revision: state.revision + 1,
  };
}

/** Set an explicit hidden-cell mark. This is idempotent for network retries. */
export function setMark(
  state: GameState,
  x: number,
  y: number,
  mark: CellMark,
  context: Pick<ActionContext, "actorId"> = {},
): GameState {
  if (state.status === "won" || state.status === "lost" || !isInBounds(state, x, y)) {
    return state;
  }

  const index = cellIndex(state, x, y);
  if (state.cells[index].isRevealed) return state;

  const previous = state.cells[index];
  const currentMark: CellMark = previous.isFlagged
    ? "flagged"
    : previous.isQuestioned
      ? "questioned"
      : "hidden";
  if (currentMark === mark) return state;

  const cells = cloneCells(state.cells);
  const cell = cells[index];
  cell.isFlagged = mark === "flagged";
  cell.isQuestioned = mark === "questioned";
  cell.flaggedBy = mark === "flagged" ? context.actorId ?? null : null;
  const flagDelta = Number(mark === "flagged") - Number(currentMark === "flagged");

  return {
    ...state,
    cells,
    flagsPlaced: state.flagsPlaced + flagDelta,
    revision: state.revision + 1,
  };
}

/** Cycle a hidden cell through hidden -> flagged -> questioned -> hidden. */
export function toggleFlag(
  state: GameState,
  x: number,
  y: number,
  context: Pick<ActionContext, "actorId"> = {},
): GameState {
  if (state.status === "won" || state.status === "lost" || !isInBounds(state, x, y)) {
    return state;
  }
  const cell = state.cells[cellIndex(state, x, y)];
  if (cell.isRevealed) return state;
  const next: CellMark = cell.isFlagged ? "questioned" : cell.isQuestioned ? "hidden" : "flagged";
  return setMark(state, x, y, next, context);
}

/**
 * Open all hidden, unflagged neighbors of a revealed number when the adjacent
 * flag count matches it. Incorrect flags can therefore detonate a mine.
 */
export function chordCell(
  state: GameState,
  x: number,
  y: number,
  context: ActionContext = {},
): GameState {
  if (state.status !== "playing" || !isInBounds(state, x, y)) return state;

  const target = state.cells[cellIndex(state, x, y)];
  if (!target.isRevealed || target.isMine || target.adjacentMines === 0) return state;

  const neighbors = adjacentIndexes(state, x, y);
  const adjacentFlags = neighbors.reduce(
    (count, index) => count + (state.cells[index].isFlagged ? 1 : 0),
    0,
  );
  if (adjacentFlags !== target.adjacentMines) return state;

  const toOpen = neighbors.filter((index) => {
    const cell = state.cells[index];
    return !cell.isRevealed && !cell.isFlagged;
  });
  if (toOpen.length === 0) return state;

  const timestamp = readTimestamp(context.now);
  const cells = cloneCells(state.cells);
  const detonated = toOpen.filter((index) => cells[index].isMine);
  const safeTargets = toOpen.filter((index) => !cells[index].isMine);
  const newlyRevealed = revealSafeArea(state, cells, safeTargets, context.actorId);
  const revealedSafeCells = state.revealedSafeCells + newlyRevealed;
  const workingState = { ...state, revealedSafeCells };

  if (detonated.length > 0) {
    for (const index of detonated) {
      cells[index].isRevealed = true;
      cells[index].isQuestioned = false;
      cells[index].isExploded = true;
      cells[index].revealedBy = context.actorId ?? null;
    }
    return completeLoss(workingState, cells, timestamp);
  }

  if (revealedSafeCells === state.width * state.height - state.mineCount) {
    return completeWin(workingState, cells, timestamp, context.actorId);
  }

  return {
    ...workingState,
    cells,
    revision: state.revision + 1,
  };
}

/** Restart the current board size/difficulty with no mines placed. */
export function restartGame(state: GameState): GameState {
  const restarted = createGame({
    width: state.width,
    height: state.height,
    mineCount: state.mineCount,
    difficulty: state.difficulty,
  });
  return { ...restarted, revision: state.revision + 1 };
}

/** Start a fresh game using one of the Windows-style difficulty presets. */
export function changeDifficulty(state: GameState, difficulty: Difficulty): GameState {
  const changed = createGame(difficulty);
  return { ...changed, revision: state.revision + 1 };
}

/** Authoritative action reducer; actions outside the board or invalid for the current state are no-ops. */
export function reduceGameAction(
  state: GameState,
  action: GameAction,
  context: ActionContext = {},
): GameState {
  switch (action.type) {
    case "reveal":
      return revealCell(state, action.x, action.y, context);
    case "toggleFlag":
      return toggleFlag(state, action.x, action.y, context);
    case "setMark":
      return setMark(state, action.x, action.y, action.mark, context);
    case "chord":
      return chordCell(state, action.x, action.y, context);
    case "restart":
      return restartGame(state);
    case "changeDifficulty":
      return changeDifficulty(state, action.difficulty);
    default: {
      const exhaustive: never = action;
      void exhaustive;
      return state;
    }
  }
}

/** Conventional reducer alias. */
export const gameReducer = reduceGameAction;

/** Elapsed game time in milliseconds, suitable for rendering a ticking timer. */
export function getElapsedTime(state: GameState, now: number = Date.now()): number {
  if (state.startedAt === null) return 0;
  const end = state.endedAt ?? now;
  return Math.max(0, end - state.startedAt);
}
