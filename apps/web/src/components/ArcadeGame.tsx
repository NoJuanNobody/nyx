import { useState, useEffect, useCallback, useRef } from 'react';

// ── Side-scrolling Mario runner ─────────────────────────
// Viewport scrolls with the player. Procedurally generated world.
// Coins, goombas, pipes, gaps, question blocks, and a flagpole goal.

const VIEW_COLS = 50;
const VIEW_ROWS = 20;
const TICK_MS = 80;
const GRAVITY = 1;
const JUMP_FORCE = -4;
const WORLD_LENGTH = 300;
const GROUND_Y = 18;

type Point = { x: number; y: number };

interface Enemy {
  x: number;
  y: number;
  type: 'goomba' | 'koopa';
  dir: -1 | 1;
  alive: boolean;
}

interface Coin {
  x: number;
  y: number;
  collected: boolean;
}

interface Block {
  x: number;
  y: number;
  type: '?' | 'brick';
  hit: boolean;
}

interface Pipe {
  x: number;
  height: number; // 2 or 3
}

interface Gap {
  xStart: number;
  xEnd: number;
}

interface Platform {
  xStart: number;
  xEnd: number;
  y: number;
}

interface World {
  enemies: Enemy[];
  coins: Coin[];
  blocks: Block[];
  pipes: Pipe[];
  gaps: Gap[];
  platforms: Platform[];
  flagX: number;
}

interface Player {
  x: number;
  y: number;
  vy: number;
  onGround: boolean;
  lives: number;
  invincible: number; // ticks remaining
  facingRight: boolean;
}

// ── World generation ────────────────────────────────────
function generateWorld(): World {
  const enemies: Enemy[] = [];
  const coins: Coin[] = [];
  const blocks: Block[] = [];
  const pipes: Pipe[] = [];
  const gaps: Gap[] = [];
  const platforms: Platform[] = [];

  let nextGapOk = 30; // don't place gaps too early

  for (let x = 15; x < WORLD_LENGTH - 20; x++) {
    const r = Math.random();

    // Gaps in the ground (pits)
    if (x > nextGapOk && r < 0.015) {
      const width = 3 + Math.floor(Math.random() * 2);
      gaps.push({ xStart: x, xEnd: x + width });
      nextGapOk = x + width + 12;
      x += width + 2;
      continue;
    }

    // Pipes
    if (r < 0.04 && x > 10) {
      const h = 2 + Math.floor(Math.random() * 2);
      pipes.push({ x, height: h });
      // Sometimes an enemy near a pipe
      if (Math.random() < 0.5) {
        enemies.push({ x: x + 3, y: GROUND_Y - 1, type: 'goomba', dir: -1, alive: true });
      }
      x += 4;
      continue;
    }

    // Question blocks with coins
    if (r < 0.07) {
      const bx = x;
      const by = GROUND_Y - 4 - Math.floor(Math.random() * 2);
      blocks.push({ x: bx, y: by, type: '?', hit: false });
      // Coin above block
      coins.push({ x: bx, y: by - 1, collected: false });
      continue;
    }

    // Brick clusters
    if (r < 0.09) {
      const count = 2 + Math.floor(Math.random() * 4);
      const by = GROUND_Y - 4;
      for (let i = 0; i < count; i++) {
        blocks.push({ x: x + i, y: by, type: 'brick', hit: false });
      }
      // Coins on top of bricks
      if (Math.random() < 0.6) {
        for (let i = 0; i < count; i += 2) {
          coins.push({ x: x + i, y: by - 1, collected: false });
        }
      }
      x += count;
      continue;
    }

    // Floating platforms
    if (r < 0.11) {
      const len = 4 + Math.floor(Math.random() * 5);
      const py = GROUND_Y - 5 - Math.floor(Math.random() * 3);
      platforms.push({ xStart: x, xEnd: x + len, y: py });
      // Coins on platform
      for (let i = 1; i < len; i += 2) {
        coins.push({ x: x + i, y: py - 1, collected: false });
      }
      x += len;
      continue;
    }

    // Ground-level goombas
    if (r < 0.14) {
      enemies.push({ x, y: GROUND_Y - 1, type: Math.random() < 0.7 ? 'goomba' : 'koopa', dir: -1, alive: true });
    }

    // Ground-level coins
    if (r < 0.2) {
      coins.push({ x, y: GROUND_Y - 1, collected: false });
    }

    // Coin arcs in the air
    if (r < 0.22) {
      for (let i = 0; i < 5; i++) {
        const arcY = GROUND_Y - 3 - Math.round(Math.sin(i / 4 * Math.PI) * 2);
        coins.push({ x: x + i, y: arcY, collected: false });
      }
      x += 5;
    }
  }

  return { enemies, coins, blocks, pipes, gaps, platforms, flagX: WORLD_LENGTH - 10 };
}

// ── Collision helpers ───────────────────────────────────
function isSolid(x: number, y: number, world: World): boolean {
  // Ground (unless it's a gap)
  if (y === GROUND_Y) {
    const inGap = world.gaps.some(g => x >= g.xStart && x <= g.xEnd);
    return !inGap;
  }
  // Pipes
  if (world.pipes.some(p => (x === p.x || x === p.x + 1) && y >= GROUND_Y - p.height && y < GROUND_Y)) return true;
  // Blocks
  if (world.blocks.some(b => b.x === x && b.y === y)) return true;
  // Platforms
  if (world.platforms.some(p => x >= p.xStart && x <= p.xEnd && y === p.y)) return true;
  return false;
}

export function ArcadeGame() {
  const [world, setWorld] = useState<World>(() => generateWorld());
  const [player, setPlayer] = useState<Player>({
    x: 3, y: GROUND_Y - 1, vy: 0, onGround: true, lives: 3, invincible: 0, facingRight: true,
  });
  const [camera, setCamera] = useState(0);
  const [coinCount, setCoinCount] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [won, setWon] = useState(false);
  const [started, setStarted] = useState(false);
  const [tick, setTick] = useState(0);
  const keysRef = useRef<Set<string>>(new Set());

  const reset = useCallback(() => {
    const w = generateWorld();
    setWorld(w);
    setPlayer({ x: 3, y: GROUND_Y - 1, vy: 0, onGround: true, lives: 3, invincible: 0, facingRight: true });
    setCamera(0);
    setCoinCount(0);
    setGameOver(false);
    setWon(false);
    setStarted(true);
    setTick(0);
  }, []);

  // Key handling
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'w', 'a', 's', 'd'].includes(e.key)) {
        e.preventDefault();
        keysRef.current.add(e.key);
        if (!started && !gameOver && !won) setStarted(true);
      }
    };
    const up = (e: KeyboardEvent) => keysRef.current.delete(e.key);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [started, gameOver, won]);

  // Game loop
  useEffect(() => {
    if (!started || gameOver || won) return;
    const interval = setInterval(() => {
      setTick(t => t + 1);

      // ── Update player ──────────────────
      setPlayer(prev => {
        let { x, y, vy, onGround, lives, invincible, facingRight } = prev;
        const keys = keysRef.current;

        // Horizontal
        const speed = 1;
        if (keys.has('ArrowLeft') || keys.has('a')) {
          const nx = x - speed;
          if (nx >= 0 && !isSolid(nx, y, world)) { x = nx; facingRight = false; }
        }
        if (keys.has('ArrowRight') || keys.has('d')) {
          const nx = x + speed;
          if (!isSolid(nx, y, world)) { x = nx; facingRight = true; }
        }

        // Jump
        if ((keys.has('ArrowUp') || keys.has('w') || keys.has(' ')) && onGround) {
          vy = JUMP_FORCE;
          onGround = false;
        }

        // Gravity
        vy = Math.min(vy + GRAVITY, 4); // terminal velocity
        const newY = y + vy;

        if (vy > 0) {
          // Falling — check for landing
          let landed = false;
          for (let checkY = y + 1; checkY <= newY; checkY++) {
            if (isSolid(x, checkY, world)) {
              y = checkY - 1;
              vy = 0;
              onGround = true;
              landed = true;
              break;
            }
          }
          if (!landed) {
            y = newY;
            onGround = false;
          }
        } else if (vy < 0) {
          // Rising — check for head bonk
          if (isSolid(x, newY, world)) {
            vy = 0;
            // Hit a question block?
            setWorld(w => ({
              ...w,
              blocks: w.blocks.map(b =>
                b.x === x && b.y === newY && b.type === '?' && !b.hit
                  ? { ...b, hit: true }
                  : b
              ),
            }));
          } else {
            y = newY;
            onGround = false;
          }
        }

        // Fell into pit
        if (y > VIEW_ROWS + 3) {
          lives--;
          if (lives <= 0) {
            setGameOver(true);
            return { ...prev, lives: 0 };
          }
          // Respawn at camera position
          return { x: camera + 5, y: GROUND_Y - 1, vy: 0, onGround: true, lives, invincible: 30, facingRight: true };
        }

        // Invincibility countdown
        if (invincible > 0) invincible--;

        return { x, y, vy, onGround, lives, invincible, facingRight };
      });

      // ── Update enemies ─────────────────
      setWorld(w => ({
        ...w,
        enemies: w.enemies.map(e => {
          if (!e.alive) return e;
          let { x, y, dir } = e;
          x += dir;
          // Turn around at edges or walls
          if (isSolid(x, y, w) || !isSolid(x, y + 1, w)) {
            dir = (dir === 1 ? -1 : 1) as -1 | 1;
            x = e.x; // revert
          }
          return { ...e, x, dir };
        }),
      }));

      // ── Coin collection ────────────────
      setWorld(w => {
        let collected = false;
        const coins = w.coins.map(c => {
          if (!c.collected && c.x === player.x && c.y === player.y) {
            collected = true;
            return { ...c, collected: true };
          }
          return c;
        });
        if (collected) setCoinCount(n => n + 1);
        return { ...w, coins };
      });

      // ── Enemy collision ────────────────
      setPlayer(prev => {
        if (prev.invincible > 0) return prev;
        const hitEnemy = world.enemies.find(
          e => e.alive && Math.abs(e.x - prev.x) < 1 && Math.abs(e.y - prev.y) < 1
        );
        if (hitEnemy) {
          // Stomp from above
          if (prev.vy > 0 && prev.y < hitEnemy.y) {
            setWorld(w => ({
              ...w,
              enemies: w.enemies.map(e =>
                e === hitEnemy ? { ...e, alive: false } : e
              ),
            }));
            setCoinCount(n => n + 2);
            return { ...prev, vy: JUMP_FORCE / 2 };
          }
          // Hit from side — lose a life
          const newLives = prev.lives - 1;
          if (newLives <= 0) {
            setGameOver(true);
            return { ...prev, lives: 0 };
          }
          return { ...prev, lives: newLives, invincible: 30 };
        }
        return prev;
      });

      // ── Camera follows player ──────────
      setCamera(prev => {
        const target = player.x - Math.floor(VIEW_COLS / 3);
        if (target > prev) return target;
        return prev;
      });

      // ── Win check ──────────────────────
      if (player.x >= world.flagX) {
        setWon(true);
      }
    }, TICK_MS);
    return () => clearInterval(interval);
  }, [started, gameOver, won, world, player, camera]);

  // ── Render ────────────────────────────────────────────
  const grid: string[][] = Array.from({ length: VIEW_ROWS }, () => Array(VIEW_COLS).fill(' '));

  // Sky background — clouds
  for (let x = 0; x < VIEW_COLS; x++) {
    const wx = x + camera;
    if (wx % 20 === 5) { grid[1][x] = '~'; if (x + 1 < VIEW_COLS) grid[1][x + 1] = '~'; }
    if (wx % 25 === 10) { grid[2][x] = '~'; if (x + 1 < VIEW_COLS) grid[2][x + 1] = '~'; }
  }

  // Ground
  for (let x = 0; x < VIEW_COLS; x++) {
    const wx = x + camera;
    const inGap = world.gaps.some(g => wx >= g.xStart && wx <= g.xEnd);
    if (!inGap) {
      grid[GROUND_Y][x] = '#';
      if (GROUND_Y - 1 >= 0) { /* sub-ground decoration */ }
    }
  }

  // Hills (decorative)
  for (let x = 0; x < VIEW_COLS; x++) {
    const wx = x + camera;
    if (wx % 30 >= 10 && wx % 30 <= 16) {
      const mid = 13;
      const dist = Math.abs((wx % 30) - mid);
      const hillH = 3 - dist;
      if (hillH > 0) {
        for (let h = 0; h < hillH; h++) {
          const hy = GROUND_Y - 1 - h;
          if (hy >= 0 && hy < VIEW_ROWS && grid[hy][x] === ' ') grid[hy][x] = '.';
        }
      }
    }
  }

  // Platforms
  world.platforms.forEach(p => {
    for (let wx = p.xStart; wx <= p.xEnd; wx++) {
      const sx = wx - camera;
      if (sx >= 0 && sx < VIEW_COLS && p.y >= 0 && p.y < VIEW_ROWS) {
        grid[p.y][sx] = '-';
      }
    }
  });

  // Pipes
  world.pipes.forEach(p => {
    for (let h = 0; h < p.height; h++) {
      const py = GROUND_Y - 1 - h;
      const sx1 = p.x - camera;
      const sx2 = p.x + 1 - camera;
      if (py >= 0 && py < VIEW_ROWS) {
        if (sx1 >= 0 && sx1 < VIEW_COLS) grid[py][sx1] = h === p.height - 1 ? '[' : '|';
        if (sx2 >= 0 && sx2 < VIEW_COLS) grid[py][sx2] = h === p.height - 1 ? ']' : '|';
      }
    }
  });

  // Blocks
  world.blocks.forEach(b => {
    const sx = b.x - camera;
    if (sx >= 0 && sx < VIEW_COLS && b.y >= 0 && b.y < VIEW_ROWS) {
      if (b.type === '?') grid[b.y][sx] = b.hit ? '.' : '?';
      else grid[b.y][sx] = b.hit ? ' ' : '#';
    }
  });

  // Coins
  world.coins.forEach(c => {
    if (c.collected) return;
    const sx = c.x - camera;
    if (sx >= 0 && sx < VIEW_COLS && c.y >= 0 && c.y < VIEW_ROWS) {
      grid[c.y][sx] = 'o';
    }
  });

  // Enemies
  world.enemies.forEach(e => {
    if (!e.alive) return;
    const sx = e.x - camera;
    if (sx >= 0 && sx < VIEW_COLS && e.y >= 0 && e.y < VIEW_ROWS) {
      grid[e.y][sx] = e.type === 'goomba' ? 'G' : 'K';
    }
  });

  // Flag
  const flagSx = world.flagX - camera;
  if (flagSx >= 0 && flagSx < VIEW_COLS) {
    for (let fy = GROUND_Y - 6; fy < GROUND_Y; fy++) {
      if (fy >= 0 && fy < VIEW_ROWS) grid[fy][flagSx] = fy === GROUND_Y - 6 ? 'P' : '|';
    }
    if (GROUND_Y - 5 >= 0 && flagSx + 1 < VIEW_COLS) grid[GROUND_Y - 5][flagSx + 1] = '>';
  }

  // Player
  const psx = player.x - camera;
  if (psx >= 0 && psx < VIEW_COLS && player.y >= 0 && player.y < VIEW_ROWS) {
    const blink = player.invincible > 0 && tick % 4 < 2;
    if (!blink) {
      grid[player.y][psx] = gameOver ? 'X' : player.facingRight ? 'M' : 'W';
    }
  }

  const border = '+' + '-'.repeat(VIEW_COLS) + '+';
  const rows = grid.map(row => '|' + row.join('') + '|');
  const livesStr = '\u2665'.repeat(player.lives) + '\u2661'.repeat(Math.max(0, 3 - player.lives));
  const progressPct = Math.min(100, Math.round((player.x / world.flagX) * 100));

  return (
    <div className="flex flex-col items-center gap-1.5">
      {/* HUD */}
      <div className="flex items-center gap-4 text-xs">
        <span className="text-red-400 font-mono">{livesStr}</span>
        <span className="text-yellow-400 font-mono">Coins: {coinCount}</span>
        <span className="text-slate-500 font-mono">Progress: {progressPct}%</span>
      </div>

      {/* Game screen */}
      <pre className="select-none text-[9px] leading-[11px] font-mono text-emerald-400 bg-slate-950 rounded-lg px-2 py-1.5 shadow-inner shadow-emerald-900/20 border border-slate-800">
        {border}
        {'\n'}
        {rows.join('\n')}
        {'\n'}
        {border}
      </pre>

      {/* Legend / controls */}
      <div className="flex items-center gap-3 text-[10px] text-slate-500">
        <span><span className="text-yellow-400">M</span> Mario</span>
        <span><span className="text-yellow-400">o</span> Coin</span>
        <span><span className="text-red-400">G</span> Goomba</span>
        <span><span className="text-green-400">[]</span> Pipe</span>
        <span><span className="text-blue-400">?</span> Block</span>
        <span><span className="text-pink-400">P</span> Flag</span>
      </div>

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
