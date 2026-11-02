"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { fitBox } from "./ticks.ts";

/**
 * The box for a small SVG chart at the width of the element it sits in (D-202): put `ref` on a block wrapper around the chart and lay the
 * chart out in the returned box. It redraws when the column resizes (a right-rail drawer opening, the viewport changing), so the chart's
 * type keeps its size instead of shrinking with a fixed viewBox. Until the first measure it is `box` itself, which is also the server render.
 */
export function useChartBox<T extends { width: number }>(box: T): readonly [RefObject<HTMLDivElement | null>, T] {
  const ref = useRef<HTMLDivElement>(null);
  const [column, setColumn] = useState<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    setColumn(Math.floor(element.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => entry && setColumn(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, fitBox(box, column)] as const;
}
