import { useState, useRef, useEffect, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────────────────

export type ContextMenuSeparator = { type: 'separator' };

export type ContextMenuLeafItem = {
  label: string;
  abbr?: string;
  sublabel?: string;
  tooltip?: string;
  icon?: React.ReactNode;
  dotColorClass?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  action: () => void;
};

export type ContextMenuSubmenuItem = {
  label: string;
  abbr?: string;
  sublabel?: string;
  tooltip?: string;
  icon?: React.ReactNode;
  dotColorClass?: string;
  danger?: boolean;
  disabled?: boolean;
  submenu: (ContextMenuLeafItem | ContextMenuSeparator)[];
};

export type ContextMenuItem = ContextMenuLeafItem | ContextMenuSubmenuItem | ContextMenuSeparator;

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

// ── Constants ──────────────────────────────────────────────────────────

const MENU_WIDTH = 220;
const SUBMENU_WIDTH = 200;
const SUBMENU_DELAY_MS = 100;

// ── ContextMenu component ──────────────────────────────────────────────

export function ContextMenu({
  menu,
  onClose,
}: {
  menu: ContextMenuState;
  onClose: () => void;
}) {
  const { x, y, items } = menu;
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [activeSubmenu, setActiveSubmenu] = useState<{
    itemIndex: number;
    items: (ContextMenuLeafItem | ContextMenuSeparator)[];
    x: number;
    y: number;
  } | null>(null);

  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null);

  // Clamp main menu position to viewport
  const clampedX = Math.min(x, Math.max(0, window.innerWidth - MENU_WIDTH - 8));
  const clampedY = Math.min(y, Math.max(0, window.innerHeight - 10));

  // Close on outside click (checks both main menu and submenu)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !submenuRef.current?.contains(t)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Auto-focus for keyboard navigation
  useEffect(() => {
    menuRef.current?.focus();
  }, []);

  // Collect indices of non-separator items for arrow key nav
  const selectableIndices = items.reduce<number[]>((acc, item, i) => {
    if (!('type' in item)) acc.push(i);
    return acc;
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const pos = selectableIndices.indexOf(focusedIndex);
      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          const next = pos < selectableIndices.length - 1 ? pos + 1 : 0;
          setFocusedIndex(selectableIndices[next] ?? selectableIndices[0] ?? -1);
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          const prev = pos > 0 ? pos - 1 : selectableIndices.length - 1;
          setFocusedIndex(selectableIndices[prev] ?? -1);
          break;
        }
        case 'ArrowRight': {
          e.preventDefault();
          if (focusedIndex < 0) break;
          const item = items[focusedIndex];
          if (item && 'submenu' in item) {
            const els = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
            const el = els?.[selectableIndices.indexOf(focusedIndex)];
            if (el) {
              const rect = el.getBoundingClientRect();
              triggerOpenSubmenu(
                focusedIndex,
                (item as ContextMenuSubmenuItem).submenu,
                rect.right,
                rect.top,
              );
            }
          }
          break;
        }
        case 'ArrowLeft':
          e.preventDefault();
          setActiveSubmenu(null);
          break;
        case 'Enter': {
          e.preventDefault();
          if (focusedIndex < 0) break;
          const item = items[focusedIndex];
          if (item && 'action' in item && !item.disabled) {
            item.action();
            onClose();
          }
          break;
        }
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
        default: {
          // Type-to-jump: single printable character
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const ch = e.key.toLowerCase();
            const match = selectableIndices.find((idx) => {
              const item = items[idx];
              if (!item || 'type' in item) return false;
              return item.label.toLowerCase().startsWith(ch);
            });
            if (match !== undefined) {
              e.preventDefault();
              setFocusedIndex(match);
            }
          }
          break;
        }
      }
    },
    [focusedIndex, items, selectableIndices, onClose],
  );

  function triggerOpenSubmenu(
    itemIndex: number,
    submenuItems: (ContextMenuLeafItem | ContextMenuSeparator)[],
    itemRight: number,
    itemTop: number,
  ) {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    // Flip submenu direction if it would overflow the right edge
    const flipped = itemRight + SUBMENU_WIDTH > window.innerWidth;
    const submenuX = flipped ? clampedX - SUBMENU_WIDTH : itemRight;
    setActiveSubmenu({ itemIndex, items: submenuItems, x: submenuX, y: itemTop });
  }

  function scheduleOpenSubmenu(
    itemIndex: number,
    submenuItems: (ContextMenuLeafItem | ContextMenuSeparator)[],
    e: React.MouseEvent,
  ) {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    hoverTimerRef.current = setTimeout(
      () => triggerOpenSubmenu(itemIndex, submenuItems, rect.right, rect.top),
      SUBMENU_DELAY_MS,
    );
  }

  function cancelSchedule() {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }

  return (
    <>
      {/* Main menu */}
      <div
        ref={menuRef}
        role="menu"
        tabIndex={-1}
        className="fixed z-[100] min-w-[200px] rounded-lg border border-slate-200 bg-white py-1 shadow-xl outline-none"
        style={{ left: clampedX, top: clampedY }}
        onKeyDown={handleKeyDown}
      >
        {items.map((item, i) => {
          if ('type' in item && item.type === 'separator') {
            return <hr key={`sep-${i}`} className="my-1 border-slate-100" />;
          }

          const hasSubmenu = 'submenu' in item;
          const isFocused = focusedIndex === i;
          const isSubmenuOpen = activeSubmenu?.itemIndex === i;

          return (
            <div
              key={item.label}
              role="menuitem"
              tabIndex={-1}
              className={[
                'flex cursor-pointer select-none items-center gap-2 px-3 py-1.5 text-xs outline-none transition-colors',
                item.danger ? 'text-red-600' : 'text-slate-700',
                isFocused || isSubmenuOpen
                  ? item.danger
                    ? 'bg-red-50'
                    : 'bg-slate-100'
                  : item.danger
                    ? 'hover:bg-red-50'
                    : 'hover:bg-slate-50',
                item.disabled ? 'pointer-events-none opacity-50' : '',
              ].join(' ')}
              onMouseEnter={(e) => {
                setFocusedIndex(i);
                if (hasSubmenu) {
                  scheduleOpenSubmenu(i, (item as ContextMenuSubmenuItem).submenu, e);
                } else {
                  cancelSchedule();
                  setActiveSubmenu(null);
                }
                if (item.tooltip) {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setTooltip({ text: item.tooltip, x: r.right + 8, y: r.top });
                }
              }}
              onMouseLeave={() => {
                if (hasSubmenu) cancelSchedule();
                setTooltip(null);
              }}
              onClick={() => {
                if (!hasSubmenu && 'action' in item && !item.disabled) {
                  item.action();
                  onClose();
                }
              }}
            >
              {/* Checkmark slot */}
              {'checked' in item && item.checked !== undefined && (
                <span className="flex w-3 flex-shrink-0 items-center justify-center">
                  {item.checked && (
                    <svg
                      className="h-3 w-3"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={2.5}
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M4.5 12.75l6 6 9-13.5"
                      />
                    </svg>
                  )}
                </span>
              )}

              {/* Stage color dot */}
              {item.dotColorClass && (
                <span className={`h-2 w-2 flex-shrink-0 rounded-full ${item.dotColorClass}`} />
              )}

              {/* Optional icon */}
              {item.icon && <span className="flex-shrink-0 text-slate-400">{item.icon}</span>}

              {/* Label */}
              <span className="flex min-w-0 flex-1 flex-col gap-0">
                <span className="flex items-center gap-1.5 truncate">
                  {item.abbr && (
                    <span className="flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-bold leading-none bg-slate-100 text-slate-500">
                      {item.abbr}
                    </span>
                  )}
                  <span className="truncate">{item.label}</span>
                </span>
                {item.sublabel && (
                  <span className="truncate text-[10px] text-slate-400">{item.sublabel}</span>
                )}
              </span>

              {/* Submenu indicator */}
              {hasSubmenu && (
                <svg
                  className="h-3 w-3 flex-shrink-0 text-slate-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="m8.25 4.5 7.5 7.5-7.5 7.5"
                  />
                </svg>
              )}
            </div>
          );
        })}
      </div>

      {/* Submenu (single level) */}
      {activeSubmenu && (
        <div
          ref={submenuRef}
          role="menu"
          className="fixed z-[101] min-w-[180px] rounded-lg border border-slate-200 bg-white py-1 shadow-xl"
          style={{ left: activeSubmenu.x, top: activeSubmenu.y }}
          onMouseEnter={() => { cancelSchedule(); setTooltip(null); }}
        >
          {activeSubmenu.items.map((item, i) => {
            if ('type' in item && item.type === 'separator') {
              return <hr key={`ssep-${i}`} className="my-1 border-slate-100" />;
            }
            return (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={[
                  'flex w-full cursor-pointer select-none items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                  item.danger ? 'text-red-600 hover:bg-red-50' : 'text-slate-700 hover:bg-slate-50',
                  item.disabled ? 'pointer-events-none opacity-50' : '',
                ].join(' ')}
                onClick={() => {
                  item.action();
                  onClose();
                }}
              >
                {/* Checkmark */}
                {'checked' in item && item.checked !== undefined && (
                  <span className="flex w-3 flex-shrink-0 items-center justify-center">
                    {item.checked && (
                      <svg
                        className="h-3 w-3"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={2.5}
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M4.5 12.75l6 6 9-13.5"
                        />
                      </svg>
                    )}
                  </span>
                )}

                {/* Stage dot */}
                {item.dotColorClass && (
                  <span className={`h-2 w-2 flex-shrink-0 rounded-full ${item.dotColorClass}`} />
                )}

                <span className="flex min-w-0 flex-1 flex-col gap-0">
                  <span className="flex items-center gap-1.5 truncate">
                    {item.abbr && (
                      <span className="flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-bold leading-none bg-slate-100 text-slate-500">
                        {item.abbr}
                      </span>
                    )}
                    <span className="truncate">{item.label}</span>
                  </span>
                  {item.sublabel && (
                    <span className="truncate text-[10px] text-slate-400">{item.sublabel}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Tooltip overlay */}
      {tooltip && (
        <div
          className="fixed z-[200] max-w-[200px] rounded-md bg-slate-800 px-2 py-1.5 text-xs text-white shadow-lg pointer-events-none"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.text}
        </div>
      )}
    </>
  );
}
