import { useCallback, useRef } from "react";

import { cn } from "@/lib/utils";

/**
 * A 1px drag handle that reports horizontal deltas.
 *
 * Uses pointer capture so the drag keeps working when the cursor leaves the
 * element, and switches the body cursor for the duration.
 */
export function ResizableHandle({
  onResize,
  className,
  side = "left",
}: {
  /** Called with the pixel delta since the previous move. */
  onResize: (delta: number) => void;
  className?: string;
  side?: "left" | "right";
}) {
  const lastX = useRef(0);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      lastX.current = event.clientX;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const delta = event.clientX - lastX.current;
      if (delta === 0) return;
      lastX.current = event.clientX;
      onResize(side === "left" ? delta : -delta);
    },
    [onResize, side],
  );

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={cn(
        "group relative w-px shrink-0 cursor-col-resize bg-border",
        "after:absolute after:inset-y-0 after:-left-1 after:-right-1 after:content-['']",
        "hover:bg-accent/60",
        className,
      )}
    />
  );
}
