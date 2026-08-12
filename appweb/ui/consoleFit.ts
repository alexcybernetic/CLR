export const MIN_CONSOLE_SCALE = 0.88;

export interface ConsoleFit {
  scale: number;
  logicalWidth: number;
  logicalHeight: number;
  stageWidth: number;
  stageHeight: number;
}

/**
 * Fit the complete instrument uniformly into a viewport down to a readable
 * scale floor. Below that floor the stage remains larger than the viewport,
 * so the existing page scrolling remains available.
 */
export function calculateConsoleFit(
  viewportWidth: number,
  viewportHeight: number,
  requiredWidth: number,
  requiredHeight: number,
  minimumScale = MIN_CONSOLE_SCALE,
): ConsoleFit {
  const vw = Math.max(1, viewportWidth);
  const vh = Math.max(1, viewportHeight);
  const rw = Math.max(1, requiredWidth);
  const rh = Math.max(1, requiredHeight);
  const floor = Math.max(0.01, Math.min(1, minimumScale));
  const scale = Math.max(floor, Math.min(1, vw / rw, vh / rh));
  const logicalWidth = Math.max(rw, vw / scale);
  const logicalHeight = Math.max(rh, vh / scale);
  return {
    scale,
    logicalWidth,
    logicalHeight,
    stageWidth: logicalWidth * scale,
    stageHeight: logicalHeight * scale,
  };
}
