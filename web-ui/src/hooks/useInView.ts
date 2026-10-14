import { useEffect, useRef, useState } from 'react';

/**
 * True once the element has been on screen (stays true afterwards). Where IntersectionObserver
 * does not exist the element counts as visible immediately.
 */
export function useInView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true);
        io.disconnect();
      }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  return [ref, seen];
}
