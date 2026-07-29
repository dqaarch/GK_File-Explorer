import { useState, useRef, useCallback, useEffect } from "react";

/**
 * useRefState - returns a state value paired with a mutable ref that always
 * tracks the latest value. Lets you read the current value inside async
 * callbacks (intervals, event listeners, async/await) without re-binding
 * the callback on every state change.
 *
 * Supports lazy initialization: if `initial` is a function, it is called once
 * on first render (same semantics as React.useState).
 *
 * The returned setter has the same signature as React's setState.
 */
export function useRefState<T>(initial: T | (() => T)) {
  const [value, setValue] = useState<T>(initial);
  const ref = useRef<T>(typeof initial === 'function' ? (initial as () => T)() : initial);

  useEffect(() => {
    ref.current = value;
  }, [value]);

  const setter = useCallback((next: T | ((prev: T) => T)) => {
    setValue(prev => {
      const resolved =
        typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      ref.current = resolved;
      return resolved;
    });
  }, []);

  return [value, setter, ref] as const;
}
