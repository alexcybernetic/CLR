export const UI_FONT_NAME = 'Geist Mono';
export const CANVAS_FONT_FAMILY = `"${UI_FONT_NAME}", monospace`;

const UI_FONT_PROBES = [
  `400 12px "${UI_FONT_NAME}"`,
  `italic 400 12px "${UI_FONT_NAME}"`,
] as const;

/**
 * Canvas text does not repaint when a web font finishes loading. Resolve both
 * faces before starting the render loop so every canvas uses the same metrics
 * as the DOM from its first draw.
 */
export async function waitForUiFonts(): Promise<void> {
  if (!('fonts' in document)) return;
  const loaded = await Promise.all(UI_FONT_PROBES.map((font) => document.fonts.load(font)));
  if (loaded.some((faces) => faces.length === 0)) {
    throw new Error(`${UI_FONT_NAME} did not match either configured web-font face`);
  }
}
