import { useState, useEffect, useCallback, useRef } from 'react';

const COLS = 40;
const ROWS = 18;
const TICK_MS = 100;
const GRAVITY = 1;
const JUMP_FORCE = -3;
const BARREL_SPEED = 1;
const BARREL_SPAWN_RATE = 45; // ticks between barrels

interface Barrel {
  x: number;
  y: number;
}

interface Player {
  x: number;
  y: number;
  vy: number;
  onGround: boolean;
}

// Platform layout: [y, xStart, xEnd]
const PLATFORMS: [number, number, number][] = [
  [16, 0, 39],     // ground
  [13, 5, 20],     // platform 1
  [13, 25, 38],    // platform 1b
  [10, 0, 15],     // platform 2
  [10, 20, 35],    // platform 2b
  [7, 8, 30],      // platform 3
  [4, 2, 18],      // platform 4 (top)
];

const KONG_X = 3;
const KONG_Y = 1;
const PRINCESS_X = 15;
const PRINCESS_Y = 3;

function isPlatform(x: number, y: number): boolean {
  return PLATFORMS.some(([py, sx, ex]) => y === py && x >= sx && x <= ex);
}

function isOnPlatform(x: number, y: number): boolean {
  return isPlatform(x, y + 1);
}

export function ArcadeGame() {
  const [player, setPlayer] = useState<Player>({ x: 2, y: 15, vy: 0, onGround: true });
  const [barrels, setBarrels] = useState<Barrel[]>([]);
  const [score, setScore] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [won, setWon] = useState(false);
  const [started, setStarted] = useState(false);
  const [tick, setTick] = useState(0);
  const keysRef = useRef<Set<string>>(new Set());

  const reset = useCallback(() => {
    setPlayer({ x: 2, y: 15, vy: 0, onGround: true });
    setBarrels([]);
    setScore(0);
    setGameOver(false);
    setWon(false);
    setStarted(true);
    setTick(0);
  }, []);

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

  useEffect(() => {
    if (!started || gameOver || won) return;
    const interval = setInterval(() => {
      setTick(t => t + 1);

      setPlayer(prev => {
        let { x, y, vy, onGround } = prev;
        const keys = keysRef.current;

        // Horizontal movement
        if (keys.has('ArrowLeft') || keys.has('a')) x = Math.max(0, x - 1);
        if (keys.has('ArrowRight') || keys.has('d')) x = Math.min(COLS - 1, x + 1);

        // Jump
        if ((keys.has('ArrowUp') || keys.has('w') || keys.has(' ')) && onGround) {
          vy = JUMP_FORCE;
          onGround = false;
        }

        // Apply gravity
        vy += GRAVITY;
        y += vy;

        // Platform collision (falling down)
        if (vy >= 0) {
          for (let checkY = y - Math.abs(vy); checkY <= y; checkY++) {
            if (isOnPlatform(x, checkY)) {
              y = checkY;
              vy = 0;
              onGround = true;
              break;
            }
          }
        }

        // Floor / ceiling bounds
        if (y >= ROWS - 1) { y = ROWS - 2; vy = 0; onGround = true; }
        if (y < 0) { y = 0; vy = 1; }

        // Check if on ground
        onGround = isOnPlatform(x, y);

        return { x, y, vy, onGround };
      });

      // Move barrels
      setBarrels(prev => {
        const moved = prev
          .map(b => ({ ...b, x: b.x + BARREL_SPEED }))
          .filter(b => b.x < COLS);

        // Barrels fall if no platform
        return moved.map(b => {
          if (!isPlatform(b.x, b.y + 1)) {
            return { ...b, y: Math.min(ROWS - 2, b.y + 1) };
          }
          return b;
        });
      });

      // Spawn barrels from Kong
      setTick(t => {
        if (t % BARREL_SPAWN_RATE === 0 && t > 0) {
          setBarrels(prev => [...prev, { x: KONG_X + 3, y: KONG_Y + 2 }]);
        }
        return t;
      });

      // Score
      setScore(s => s + 1);
    }, TICK_MS);
    return () => clearInterval(interval);
  }, [started, gameOver, won]);

  // Collision detection
  useEffect(() => {
    if (gameOver || won) return;
    // Barrel collision
    if (barrels.some(b => Math.abs(b.x - player.x) < 2 && Math.abs(b.y - player.y) < 2)) {
      setGameOver(true);
    }
    // Win condition — reach princess
    if (Math.abs(player.x - PRINCESS_X) < 2 && Math.abs(player.y - PRINCESS_Y) < 2) {
      setWon(true);
    }
  }, [player, barrels, gameOver, won]);

  // Render ASCII grid
  const grid: string[][] = Array.from({ length: ROWS }, () => Array(COLS).fill(' '));

  // Draw platforms
  PLATFORMS.forEach(([py, sx, ex]) => {
    for (let x = sx; x <= ex; x++) {
      grid[py][x] = '=';
    }
  });

  // Draw ladders between platforms
  const ladderPositions = [12, 22, 8, 28, 15];
  ladderPositions.forEach(lx => {
    for (let y = 0; y < ROWS; y++) {
      if (grid[y][lx] === ' ') {
        // Only draw ladder between platforms
        const abovePlatform = PLATFORMS.some(([py]) => py < y && py > y - 4);
        if (abovePlatform) grid[y][lx] = 'H';
      }
    }
  });

  // Draw Kong (3x3)
  const kong = [
    ' /\\\\ ',
    '{@@}',
    '/||\\',
  ];
  kong.forEach((row, dy) => {
    [...row].forEach((ch, dx) => {
      const ky = KONG_Y + dy;
      const kx = KONG_X + dx - 1;
      if (ky >= 0 && ky < ROWS && kx >= 0 && kx < COLS) {
        grid[ky][kx] = ch;
      }
    });
  });

  // Draw princess
  if (PRINCESS_Y >= 0 && PRINCESS_Y < ROWS && PRINCESS_X >= 0 && PRINCESS_X < COLS) {
    grid[PRINCESS_Y][PRINCESS_X] = '\u2665'; // heart
  }

  // Draw barrels
  barrels.forEach(b => {
    if (b.y >= 0 && b.y < ROWS && b.x >= 0 && b.x < COLS) {
      grid[b.y][b.x] = 'O';
    }
  });

  // Draw player (Mario)
  if (player.y >= 0 && player.y < ROWS && player.x >= 0 && player.x < COLS) {
    grid[player.y][player.x] = gameOver ? 'X' : 'M';
  }

  const border = '+' + '-'.repeat(COLS) + '+';
  const rows = grid.map(row => '|' + row.join('') + '|');

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex items-center gap-4 text-xs text-slate-500">
        <span>Score: {score}</span>
        <span className="text-slate-600">|</span>
        <span>
          <span className="text-yellow-400">M</span>=You{' '}
          <span className="text-red-400">O</span>=Barrel{' '}
          <span className="text-pink-400">{'\u2665'}</span>=Goal
        </span>
      </div>
      <pre className="select-none text-[10px] leading-[12px] font-mono text-emerald-400 bg-slate-950 rounded-lg px-3 py-2 shadow-inner shadow-emerald-900/20 border border-slate-800">
        {border}
        {'\n'}
        {rows.join('\n')}
        {'\n'}
        {border}
      </pre>
      {!started && !gameOver && !won && (
        <p className="text-xs text-slate-400 animate-pulse">
          Arrow keys / WASD to move, Up to jump. Dodge barrels, reach the {'\u2665'}!
        </p>
      )}
      {gameOver && (
        <div className="flex flex-col items-center gap-1">
          <p className="text-xs font-medium text-red-400">Game Over! Score: {score}</p>
          <button onClick={reset} className="text-xs text-blue-400 hover:text-blue-300 underline">
            Play again
          </button>
        </div>
      )}
      {won && (
        <div className="flex flex-col items-center gap-1">
          <p className="text-xs font-medium text-emerald-400">You saved the princess! Score: {score}</p>
          <button onClick={reset} className="text-xs text-blue-400 hover:text-blue-300 underline">
            Play again
          </button>
        </div>
      )}
    </div>
  );
}
