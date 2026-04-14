import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface PortalProps {
  children: ReactNode;
  /**
   * Optional target node. Defaults to `document.body`.
   * Useful for tests that want to mount into a specific container.
   */
  container?: Element | null;
}

/**
 * Renders children into a React Portal targeting `document.body` (or a custom
 * container). Use this for any overlay that uses `position: fixed` and must
 * escape ancestor `transform` containing blocks.
 *
 * Background: any non-none `transform` on an ancestor element creates a new
 * containing block for `position: fixed` descendants, which causes
 * `inset-0` to resolve to that ancestor's box instead of the viewport. The
 * fix is to render the overlay outside that ancestor via a portal.
 */
export function Portal({ children, container }: PortalProps) {
  // Avoid SSR / first-render mismatches by only mounting after the client
  // has access to `document`.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  if (!mounted) return null;

  const target = container ?? (typeof document !== 'undefined' ? document.body : null);
  if (!target) return null;

  return createPortal(children, target);
}
