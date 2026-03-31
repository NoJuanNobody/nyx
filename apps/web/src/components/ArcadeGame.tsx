import { useState, useEffect, useCallback, useRef } from 'react';

// ── Config ──────────────────────────────────────────────
const TILE = 16;
const SCALE = 2;
const PX = TILE * SCALE; // 32px per tile on screen
const VIEW_COLS = 16;
const VIEW_ROWS = 12;
const CANVAS_W = VIEW_COLS * PX;
const CANVAS_H = VIEW_ROWS * PX;
const TICK_MS = 50;
const WORLD_LENGTH = 200;
const GROUND_Y = 10;
const SUB_STEPS = 1;

// Physics (in tile units per tick)
const GRAVITY = 0.06;
const JUMP_FORCE = -0.55;
const MOVE_SPEED = 0.18;
const MAX_FALL = 0.5;

// ── Sprite definitions (16x16 pixel art as hex color arrays) ──
// '_' = transparent
type SpriteData = (string | '_')[][];

const SPRITES: Record<string, SpriteData> = {};

// Helper to define sprites compactly: each char maps to a color
function defSprite(name: string, palette: Record<string, string>, rows: string[]) {
  SPRITES[name] = rows.map(row =>
    [...row].map(ch => (ch === '.' ? '_' : palette[ch] ?? '_'))
  );
}

// ── Mario sprites ───────────────────────────────────────
const MP: Record<string, string> = {
  R: '#e52521', r: '#b01a18', B: '#6b3e08', b: '#8b5e3c',
  S: '#ffbd59', s: '#f5a623', W: '#ffffff', O: '#f47521',
  G: '#049cd8', g: '#02508a', K: '#000000',
};

defSprite('mario_idle', MP, [
  '....RRRRR.......',
  '...RRRRRRRRR....',
  '...BBBSSbS......',
  '..BsBSSSbSSS....',
  '..BsBBSSSbSSS...',
  '..BBsSSSBBBB....',
  '....SSSSSS......',
  '...GGRGGR.......',
  '..GGGRGGGRG.....',
  '..GGGRRRRGG.....',
  '..SSRGWRWRGS....',
  '..SSSRRRRRSS....',
  '..SSRRRRRSS.....',
  '...RRR.RRR......',
  '..BBB...BBB.....',
  '..BBBB..BBBB....',
]);

defSprite('mario_run', MP, [
  '....RRRRR.......',
  '...RRRRRRRRR....',
  '...BBBSSbS......',
  '..BsBSSSbSSS....',
  '..BsBBSSSbSSS...',
  '..BBsSSSBBBB....',
  '....SSSSSS......',
  '..RRGGRGG.......',
  '..RRGGGRGGR.....',
  '.RRRRRRRRRR.....',
  '.SSRGWRWRSS.....',
  '..SSSRRRRSS.....',
  '..SRRRRRRR......',
  '...RRRR.........',
  '...GGGBB........',
  '...GGGGBB.......',
]);

defSprite('mario_jump', MP, [
  '....RRRRR.......',
  '...RRRRRRRRR....',
  '...BBBSSbS......',
  '..BsBSSSbSSS....',
  '..BsBBSSSbSSS...',
  '..BBsSSSBBBB....',
  '....SSSSSS......',
  '...GGRGG.BB.....',
  '...GGRGG.BBB....',
  '..GGRRRRBB......',
  '..SSRWRWRR......',
  '..SSRRRRRS......',
  '..SRRRRR........',
  '...RR.RR........',
  '..BB...BBB......',
  '.BBB....BBB.....',
]);

// ── Goomba ──────────────────────────────────────────────
const GP: Record<string, string> = {
  B: '#6b3e08', b: '#4a2800', W: '#ffffff', K: '#000000', T: '#d4a56a',
};

defSprite('goomba', GP, [
  '......BBBB......',
  '....BBBBBBBB....',
  '...BBBBBBBBBB...',
  '..BBBWWBBWWBBB..',
  '..BBWKWBBWKWBB..',
  '..BBWWWBBWWWBB..',
  '..BBBBBBBBBBBB..',
  '..BBBBBKKBBBBB..',
  '...BBKKKKKBB....',
  '....KKKKKKKK....',
  '...TTTTTTTTTT...',
  '..TTTTTTTTTTTT..',
  '..TTTTTTTTTTTT..',
  '.TTTT.TTTT.TTTT.',
  '.TTT..TTTT..TTT.',
  '......TTTT......',
]);

// ── Koopa ───────────────────────────────────────────────
const KP: Record<string, string> = {
  G: '#4caf50', g: '#2e7d32', Y: '#ffeb3b', K: '#000000', W: '#ffffff', R: '#e52521',
};

defSprite('koopa', KP, [
  '.......GGG......',
  '......GGGGG.....',
  '.....GGGGGG.....',
  '.....GWGWGG.....',
  '.....GKGKGG.....',
  '......GGGG......',
  '.....GGGGGG.....',
  '....GGGGGGGG....',
  '...GGGGGGGGG....',
  '..GGGGGGGGGGGG..',
  '..YYYGGGGGGYYY..',
  '..YYYYGGGGYYY...',
  '...YYYYYYYYY....',
  '.....YY.YY......',
  '....RRR.RRR.....',
  '...RRRR.RRRR....',
]);

// ── Coin ────────────────────────────────────────────────
const CoP: Record<string, string> = { Y: '#ffd700', y: '#b8960f', W: '#fff8dc' };

defSprite('coin', CoP, [
  '......YYYY......',
  '....YYYYYYYY....',
  '...YYYYyyYYYY...',
  '..YYYYyWWyYYYY..',
  '..YYYyyWWyyYYY..',
  '.YYYYyyWWyyYYYY.',
  '.YYYYyyWWyyYYYY.',
  '.YYYYyyWWyyYYYY.',
  '.YYYYyyWWyyYYYY.',
  '.YYYYyyWWyyYYYY.',
  '.YYYYyyWWyyYYYY.',
  '..YYYyyWWyyYYY..',
  '..YYYYyWWyYYYY..',
  '...YYYYyyYYYY...',
  '....YYYYYYYY....',
  '......YYYY......',
]);

// ── Question block ──────────────────────────────────────
const QP: Record<string, string> = {
  O: '#f47521', o: '#c45a10', Y: '#ffd700', K: '#000000', B: '#8b4513',
};

defSprite('qblock', QP, [
  'KKKKKKKKKKKKKKKK',
  'KOOOOOOOOOOOOOOK',
  'KOOOOOYYYYOOOOOK',
  'KOOOOYYYYYOOOOOK',
  'KOOOOOYYYYOOOOOK',
  'KOOOOOOYYOOOOOOK',
  'KOOOOOOYYOOOOOOK',
  'KOOOOOOYYOOOOOOK',
  'KOOOOOYYYYOOOOOK',
  'KOOOOOYYYYOOOOOK',
  'KOOOOOOYYOOOOOOK',
  'KOOOOOOOOOOOOOOOK',
  'KOOOOOOYYOOOOOOK',
  'KOOOOOYYYYOOOOOK',
  'KOOOOOOOOOOOOOOK',
  'KKKKKKKKKKKKKKKK',
]);

defSprite('qblock_hit', QP, [
  'KKKKKKKKKKKKKKKK',
  'KBBBBBBBBBBBBBBK',
  'KBBBBBBBBBBBBBBK',
  'KBBBBBBBBBBBBBBK',
  'KBBBBBBBBBBBBBBK',
  'KBBBBBBBBBBBBBBK',
  'KBBBBBBBBBBBBBBK',
  'KBBBBBBBBBBBBBBK',
  'KBBBBBBBBBBBBBBK',
  'KBBBBBBBBBBBBBBK',
  'KBBBBBBBBBBBBBBK',
  'KBBBBBBBBBBBBBBK',
  'KBBBBBBBBBBBBBBK',
  'KBBBBBBBBBBBBBBK',
  'KBBBBBBBBBBBBBBK',
  'KKKKKKKKKKKKKKKK',
]);

// ── Brick block ─────────────────────────────────────────
const BrP: Record<string, string> = { B: '#c45a10', b: '#8b4513', K: '#000000' };

defSprite('brick', BrP, [
  'KKKKKKKKKKKKKKKK',
  'KBBBBBBKBBBBBBbK',
  'KBBBBBBKBBBBBBbK',
  'KBBBBBBKBBBBBBbK',
  'KbbbbbbKbbbbbbKK',
  'KKKKKKKKKKKKKKKK',
  'KBBKBBBBBBKBBBbK',
  'KBBKBBBBBBKBBBbK',
  'KBBKBBBBBBKBBBbK',
  'KbbKbbbbbbKbbbKK',
  'KKKKKKKKKKKKKKKK',
  'KBBBBBBKBBBBBBbK',
  'KBBBBBBKBBBBBBbK',
  'KBBBBBBKBBBBBBbK',
  'KbbbbbbKbbbbbbKK',
  'KKKKKKKKKKKKKKKK',
]);

// ── Ground tile ─────────────────────────────────────────
const GrP: Record<string, string> = { G: '#8b4513', g: '#654321', D: '#5c3317', K: '#000000' };

defSprite('ground', GrP, [
  'KKKKKKKKKKKKKKKK',
  'KGGGGGGGGGGGGGDK',
  'KGGGGGGGGGGGGGDK',
  'KGGGGGGGGGGGgDK',
  'KKKKKKKKKKKKKKKK',
  'KDDKGGGGGGKGGgK',
  'KDDKGGGGGGKGGgK',
  'KDDKGGGGGGKGGgK',
  'KKKKKKKKKKKKKKKK',
  'KGGGGGGKDDKGGgK',
  'KGGGGGGKDDKGGgK',
  'KGGGGGGKDDKGGgK',
  'KKKKKKKKKKKKKKKK',
  'KDDKGGGGGGKGGgK',
  'KDDKGGGGGGKGGgK',
  'KKKKKKKKKKKKKKKK',
]);

// ── Pipe top and body ───────────────────────────────────
const PiP: Record<string, string> = { G: '#4caf50', g: '#2e7d32', d: '#1b5e20', K: '#000000' };

defSprite('pipe_top', PiP, [
  '.KKKKKKKKKKKKK..',
  '.KGGGGGGGGGGgK..',
  '.KGGGGGGGGGGgK..',
  '.KGGGGGGGGGGgK..',
  '.KggggggggggdK..',
  '.KKKKKKKKKKKKK..',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KggggggggdK...',
]);

defSprite('pipe_body', PiP, [
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KGGGGGGGGgK...',
  '..KggggggggdK...',
]);

// ── Flag ────────────────────────────────────────────────
const FlP: Record<string, string> = { G: '#4caf50', W: '#ffffff', K: '#000000', Y: '#ffd700' };

defSprite('flag', FlP, [
  '.......K........',
  '.GGGGGKK........',
  '.GGGGGKK........',
  '.GGGGGKK........',
  '.GGGGGKK........',
  '......KK........',
  '......KK........',
  '......KK........',
  '......KK........',
  '......KK........',
  '......KK........',
  '......KK........',
  '......KK........',
  '......KK........',
  '.....YYYY.......',
  '....YYYYYY......',
]);

// ── Cloud ───────────────────────────────────────────────
const ClP: Record<string, string> = { W: '#ffffff', B: '#d4eafc' };

defSprite('cloud', ClP, [
  '................',
  '......WWW.......',
  '....WWWWWWW.....',
  '..WWWWWWWWWWW...',
  '.BWWWWWWWWWWWB..',
  '.BBBBBBBBBBBBB..',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
]);

// ── Hill (bush) ─────────────────────────────────────────
const HiP: Record<string, string> = { G: '#6abf69', g: '#4a9a4a' };

defSprite('hill', HiP, [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '......GGG.......',
  '.....GGGGG......',
  '....GGGGGGG.....',
  '...gGGGGGGGg....',
  '..ggGGGGGGGgg...',
  '.gggGGGGGGGggg..',
  'ggggGGGGGGGgggg.',
  'gggggGGGGGggggg.',
]);

// ── Sprite blit cache ───────────────────────────────────
const spriteCache = new Map<string, ImageData>();

function getSpriteImage(name: string, ctx: CanvasRenderingContext2D, flipped = false): ImageData {
  const key = flipped ? name + '_flip' : name;
  if (spriteCache.has(key)) return spriteCache.get(key)!;
  const data = SPRITES[name];
  if (!data) return ctx.createImageData(TILE, TILE);
  const img = ctx.createImageData(TILE, TILE);
  for (let y = 0; y < Math.min(data.length, TILE); y++) {
    const row = data[y];
    for (let x = 0; x < Math.min(row.length, TILE); x++) {
      const color = row[flipped ? TILE - 1 - x : x];
      if (color === '_') continue;
      const idx = (y * TILE + x) * 4;
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 255;
    }
  }
  spriteCache.set(key, img);
  return img;
}

// ── Scaled sprite blit ──────────────────────────────────
const scaledCache = new Map<string, HTMLCanvasElement>();

function drawSprite(
  ctx: CanvasRenderingContext2D,
  name: string,
  screenX: number,
  screenY: number,
  flipped = false,
) {
  const key = flipped ? name + '_flip' : name;
  if (!scaledCache.has(key)) {
    const imgData = getSpriteImage(name, ctx, flipped);
    const off = document.createElement('canvas');
    off.width = TILE;
    off.height = TILE;
    off.getContext('2d')!.putImageData(imgData, 0, 0);
    scaledCache.set(key, off);
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scaledCache.get(key)!, screenX, screenY, PX, PX);
}

// ── Game types ──────────────────────────────────────────
interface Enemy { x: number; y: number; type: 'goomba' | 'koopa'; dir: -1 | 1; alive: boolean }
interface Coin { x: number; y: number; collected: boolean }
interface Block { x: number; y: number; type: '?' | 'brick'; hit: boolean }
interface Pipe { x: number; height: number }
interface Gap { xStart: number; xEnd: number }
interface Platform { xStart: number; xEnd: number; y: number }
interface World {
  enemies: Enemy[]; coins: Coin[]; blocks: Block[]; pipes: Pipe[];
  gaps: Gap[]; platforms: Platform[]; flagX: number;
}
interface Player {
  x: number; y: number; vy: number; vx: number; onGround: boolean;
  lives: number; invincible: number; facingRight: boolean;
}

// ── World generation ────────────────────────────────────
function generateWorld(): World {
  const enemies: Enemy[] = [];
  const coins: Coin[] = [];
  const blocks: Block[] = [];
  const pipes: Pipe[] = [];
  const gaps: Gap[] = [];
  const platforms: Platform[] = [];
  let nextGapOk = 25;

  for (let x = 12; x < WORLD_LENGTH - 15; x++) {
    const r = Math.random();
    if (x > nextGapOk && r < 0.02) {
      const w = 3;
      gaps.push({ xStart: x, xEnd: x + w });
      nextGapOk = x + w + 15;
      x += w + 2;
      continue;
    }
    if (r < 0.045 && x > 10) {
      const h = 2 + Math.floor(Math.random() * 2);
      pipes.push({ x, height: h });
      if (Math.random() < 0.4) enemies.push({ x: x + 3, y: GROUND_Y - 1, type: 'goomba', dir: -1, alive: true });
      x += 3;
      continue;
    }
    if (r < 0.07) {
      blocks.push({ x, y: GROUND_Y - 4, type: '?', hit: false });
      coins.push({ x, y: GROUND_Y - 5, collected: false });
      continue;
    }
    if (r < 0.09) {
      const count = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i++) blocks.push({ x: x + i, y: GROUND_Y - 4, type: 'brick', hit: false });
      if (Math.random() < 0.5) for (let i = 0; i < count; i += 2) coins.push({ x: x + i, y: GROUND_Y - 5, collected: false });
      x += count;
      continue;
    }
    if (r < 0.11) {
      const len = 3 + Math.floor(Math.random() * 4);
      const py = GROUND_Y - 5 - Math.floor(Math.random() * 2);
      platforms.push({ xStart: x, xEnd: x + len, y: py });
      for (let i = 1; i < len; i += 2) coins.push({ x: x + i, y: py - 1, collected: false });
      x += len;
      continue;
    }
    if (r < 0.15) enemies.push({ x, y: GROUND_Y - 1, type: Math.random() < 0.7 ? 'goomba' : 'koopa', dir: -1, alive: true });
    if (r < 0.22) coins.push({ x, y: GROUND_Y - 1, collected: false });
    if (r < 0.24) {
      for (let i = 0; i < 4; i++) coins.push({ x: x + i, y: GROUND_Y - 3 - Math.round(Math.sin(i / 3 * Math.PI) * 1.5), collected: false });
      x += 4;
    }
  }

  return { enemies, coins, blocks, pipes, gaps, platforms, flagX: WORLD_LENGTH - 8 };
}

// ── Collision ───────────────────────────────────────────
function isSolid(tx: number, ty: number, world: World): boolean {
  const ix = Math.floor(tx);
  const iy = Math.floor(ty);
  if (iy >= GROUND_Y) {
    return !world.gaps.some(g => ix >= g.xStart && ix <= g.xEnd);
  }
  if (world.pipes.some(p => (ix === p.x || ix === p.x + 1) && iy >= GROUND_Y - p.height && iy < GROUND_Y)) return true;
  if (world.blocks.some(b => !b.hit && b.x === ix && b.y === iy)) return true;
  if (world.platforms.some(p => ix >= p.xStart && ix <= p.xEnd && iy === p.y)) return true;
  return false;
}

function groundAt(tx: number, world: World): boolean {
  const ix = Math.floor(tx);
  return !world.gaps.some(g => ix >= g.xStart && ix <= g.xEnd);
}

// ── Component ───────────────────────────────────────────
export function ArcadeGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [world, setWorld] = useState<World>(() => generateWorld());
  const [player, setPlayer] = useState<Player>({
    x: 3, y: GROUND_Y - 1, vy: 0, vx: 0, onGround: true, lives: 3, invincible: 0, facingRight: true,
  });
  const [camera, setCamera] = useState(0);
  const [coinCount, setCoinCount] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [won, setWon] = useState(false);
  const [started, setStarted] = useState(false);
  const [tick, setTick] = useState(0);
  const keysRef = useRef<Set<string>>(new Set());
  const jumpPressedRef = useRef(false);

  // Refs for game loop to avoid stale closures
  const playerRef = useRef(player);
  const worldRef = useRef(world);
  const cameraRef = useRef(camera);
  const coinCountRef = useRef(coinCount);
  playerRef.current = player;
  worldRef.current = world;
  cameraRef.current = camera;
  coinCountRef.current = coinCount;

  const reset = useCallback(() => {
    const w = generateWorld();
    setWorld(w);
    setPlayer({ x: 3, y: GROUND_Y - 1, vy: 0, vx: 0, onGround: true, lives: 3, invincible: 0, facingRight: true });
    setCamera(0);
    setCoinCount(0);
    setGameOver(false);
    setWon(false);
    setStarted(true);
    setTick(0);
    spriteCache.clear();
    scaledCache.clear();
  }, []);

  // Key handling
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'w', 'a', 's', 'd'].includes(e.key)) {
        e.preventDefault();
        keysRef.current.add(e.key);
        // Only trigger jump on fresh press, not key repeat
        if (!e.repeat && (e.key === 'ArrowUp' || e.key === 'w' || e.key === ' ')) {
          jumpPressedRef.current = true;
        }
        if (!started && !gameOver && !won) setStarted(true);
      }
    };
    const up = (e: KeyboardEvent) => keysRef.current.delete(e.key);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [started, gameOver, won]);

  // Game loop
  useEffect(() => {
    if (!started || gameOver || won) return;
    const interval = setInterval(() => {
      setTick(t => t + 1);
      const w = worldRef.current;
      const keys = keysRef.current;

      // ── Update player ─────────
      setPlayer(prev => {
        let { x, y, vy, vx, onGround, lives, invincible, facingRight } = prev;

        // Horizontal input
        if (keys.has('ArrowLeft') || keys.has('a')) { vx = -MOVE_SPEED; facingRight = false; }
        else if (keys.has('ArrowRight') || keys.has('d')) { vx = MOVE_SPEED; facingRight = true; }
        else { vx = 0; }

        // Jump (one-shot: only on fresh keypress, not while held)
        if (jumpPressedRef.current && onGround) {
          vy = JUMP_FORCE;
          onGround = false;
          jumpPressedRef.current = false;
        }

        // Apply physics
        vy = Math.min(vy + GRAVITY, MAX_FALL);
        const nx = x + vx;
        const ny = y + vy;

        // Horizontal collision
        if (vx !== 0) {
          if (!isSolid(nx, y, w) && !isSolid(nx, y - 0.5, w)) {
            x = nx;
          }
        }
        x = Math.max(0, x);

        // Vertical collision
        if (vy > 0) {
          if (isSolid(x, ny, w)) {
            y = Math.floor(ny);
            if (isSolid(x, y, w)) y -= 1;
            vy = 0;
            onGround = true;
          } else {
            y = ny;
            onGround = false;
          }
        } else if (vy < 0) {
          if (isSolid(x, ny, w)) {
            vy = 0.1;
            // Hit block from below
            const bx = Math.floor(x);
            const by = Math.floor(ny);
            setWorld(prev => ({
              ...prev,
              blocks: prev.blocks.map(b =>
                b.x === bx && b.y === by && !b.hit ? { ...b, hit: true } : b
              ),
            }));
          } else {
            y = ny;
            onGround = false;
          }
        } else {
          // Check if still on ground
          onGround = isSolid(x, y + 0.1, w);
          if (!onGround) y = ny;
        }

        // Fell in pit
        if (y > GROUND_Y + 4) {
          lives--;
          if (lives <= 0) { setGameOver(true); return { ...prev, lives: 0 }; }
          return { x: cameraRef.current + 3, y: GROUND_Y - 1, vy: 0, vx: 0, onGround: true, lives, invincible: 40, facingRight: true };
        }

        if (invincible > 0) invincible--;
        return { x, y, vy, vx, onGround, lives, invincible, facingRight };
      });

      // ── Update enemies ────────
      setWorld(prev => ({
        ...prev,
        enemies: prev.enemies.map(e => {
          if (!e.alive) return e;
          const nx = e.x + e.dir * 0.05;
          if (isSolid(nx, e.y, prev) || !isSolid(nx, e.y + 1, prev)) {
            return { ...e, dir: (e.dir === 1 ? -1 : 1) as -1 | 1 };
          }
          return { ...e, x: nx };
        }),
      }));

      // ── Coin collection ───────
      const p = playerRef.current;
      setWorld(prev => {
        let collected = false;
        const coins = prev.coins.map(c => {
          if (!c.collected && Math.abs(c.x - p.x) < 0.8 && Math.abs(c.y - p.y) < 0.8) {
            collected = true;
            return { ...c, collected: true };
          }
          return c;
        });
        if (collected) setCoinCount(n => n + 1);
        return { ...prev, coins };
      });

      // ── Enemy collision ───────
      setPlayer(prev => {
        if (prev.invincible > 0) return prev;
        const hitEnemy = worldRef.current.enemies.find(
          e => e.alive && Math.abs(e.x - prev.x) < 0.7 && Math.abs(e.y - prev.y) < 0.7
        );
        if (hitEnemy) {
          if (prev.vy > 0 && prev.y < hitEnemy.y - 0.3) {
            setWorld(w => ({ ...w, enemies: w.enemies.map(e => e === hitEnemy ? { ...e, alive: false } : e) }));
            setCoinCount(n => n + 2);
            return { ...prev, vy: JUMP_FORCE * 0.6 };
          }
          const newLives = prev.lives - 1;
          if (newLives <= 0) { setGameOver(true); return { ...prev, lives: 0 }; }
          return { ...prev, lives: newLives, invincible: 40 };
        }
        return prev;
      });

      // ── Camera ────────────────
      setCamera(prev => {
        const target = playerRef.current.x - VIEW_COLS / 3;
        return Math.max(prev, target);
      });

      // ── Win ───────────────────
      if (playerRef.current.x >= w.flagX) setWon(true);
    }, TICK_MS);
    return () => clearInterval(interval);
  }, [started, gameOver, won]);

  // ── Render to canvas ──────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Sky
    ctx.fillStyle = '#6185f8';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    const cam = camera;
    const w = world;

    // Clouds (parallax)
    for (let x = 0; x < VIEW_COLS + 2; x++) {
      const wx = Math.floor(x + cam * 0.3);
      if (wx % 12 === 3) {
        drawSprite(ctx, 'cloud', (x - (cam * 0.3 % 1)) * PX, 1 * PX);
      }
    }

    // Hills (parallax)
    for (let x = 0; x < VIEW_COLS + 2; x++) {
      const wx = Math.floor(x + cam * 0.6);
      if (wx % 16 === 0) {
        drawSprite(ctx, 'hill', (x - (cam * 0.6 % 1)) * PX, (GROUND_Y - 1) * PX);
      }
    }

    // Ground tiles
    for (let x = 0; x < VIEW_COLS + 1; x++) {
      const wx = Math.floor(x + cam);
      const sx = (x - (cam % 1)) * PX;
      if (groundAt(wx, w)) {
        drawSprite(ctx, 'ground', sx, GROUND_Y * PX);
        drawSprite(ctx, 'ground', sx, (GROUND_Y + 1) * PX);
      }
    }

    // Platforms
    w.platforms.forEach(p => {
      for (let wx = p.xStart; wx <= p.xEnd; wx++) {
        const sx = (wx - cam) * PX;
        if (sx > -PX && sx < CANVAS_W + PX) {
          drawSprite(ctx, 'brick', sx, p.y * PX);
        }
      }
    });

    // Pipes
    w.pipes.forEach(p => {
      const sx = (p.x - cam) * PX;
      if (sx > -PX * 2 && sx < CANVAS_W + PX) {
        drawSprite(ctx, 'pipe_top', sx, (GROUND_Y - p.height) * PX);
        for (let h = 1; h < p.height; h++) {
          drawSprite(ctx, 'pipe_body', sx, (GROUND_Y - p.height + h) * PX);
        }
      }
    });

    // Blocks
    w.blocks.forEach(b => {
      const sx = (b.x - cam) * PX;
      if (sx > -PX && sx < CANVAS_W + PX) {
        if (b.type === '?') drawSprite(ctx, b.hit ? 'qblock_hit' : 'qblock', sx, b.y * PX);
        else if (!b.hit) drawSprite(ctx, 'brick', sx, b.y * PX);
      }
    });

    // Coins
    w.coins.forEach(c => {
      if (c.collected) return;
      const sx = (c.x - cam) * PX;
      if (sx > -PX && sx < CANVAS_W + PX) {
        drawSprite(ctx, 'coin', sx, c.y * PX);
      }
    });

    // Enemies
    w.enemies.forEach(e => {
      if (!e.alive) return;
      const sx = (e.x - cam) * PX;
      if (sx > -PX && sx < CANVAS_W + PX) {
        drawSprite(ctx, e.type === 'goomba' ? 'goomba' : 'koopa', sx, e.y * PX, e.dir === 1);
      }
    });

    // Flag
    const fsx = (w.flagX - cam) * PX;
    if (fsx > -PX && fsx < CANVAS_W + PX) {
      drawSprite(ctx, 'flag', fsx, (GROUND_Y - 6) * PX);
      // Flagpole body
      for (let fy = GROUND_Y - 5; fy < GROUND_Y; fy++) {
        ctx.fillStyle = '#666';
        ctx.fillRect(fsx + PX * 0.4, fy * PX, PX * 0.15, PX);
      }
    }

    // Player
    const blink = player.invincible > 0 && tick % 6 < 3;
    if (!blink) {
      let spriteName = 'mario_idle';
      if (!player.onGround) spriteName = 'mario_jump';
      else if (Math.abs(player.vx) > 0.01) spriteName = 'mario_run';
      const psx = (player.x - cam) * PX;
      drawSprite(ctx, spriteName, psx, player.y * PX, !player.facingRight);
    }

    // HUD overlay
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, CANVAS_W, 24);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px monospace';
    ctx.fillText(`\u2665 ${player.lives}`, 8, 17);
    ctx.fillStyle = '#ffd700';
    ctx.fillText(`\u2B24 ${coinCount}`, 70, 17);
    ctx.fillStyle = '#aaa';
    const pct = Math.min(100, Math.round((player.x / w.flagX) * 100));
    ctx.fillText(`${pct}%`, CANVAS_W - 50, 17);

    // Progress bar
    ctx.fillStyle = '#333';
    ctx.fillRect(130, 8, 120, 10);
    ctx.fillStyle = '#4caf50';
    ctx.fillRect(130, 8, Math.round(120 * pct / 100), 10);
  }, [player, camera, world, tick, coinCount, gameOver]);

  return (
    <div className="flex flex-col items-center gap-2">
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        className="rounded-lg border-2 border-slate-700 shadow-lg"
        style={{ imageRendering: 'pixelated' }}
      />
      {!started && !gameOver && !won && (
        <p className="text-xs text-slate-400 animate-pulse">
          Arrow keys to move, Up/Space to jump. Reach the flag!
        </p>
      )}
      {gameOver && (
        <div className="flex flex-col items-center gap-1">
          <p className="text-xs font-medium text-red-400">Game Over! Coins: {coinCount}</p>
          <button onClick={reset} className="text-xs text-blue-400 hover:text-blue-300 underline">Play again</button>
        </div>
      )}
      {won && (
        <div className="flex flex-col items-center gap-1">
          <p className="text-xs font-medium text-emerald-400">Level Complete! Coins: {coinCount}</p>
          <button onClick={reset} className="text-xs text-blue-400 hover:text-blue-300 underline">Play again</button>
        </div>
      )}
    </div>
  );
}
