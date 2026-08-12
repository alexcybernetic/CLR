import { expect, test, type Page } from '@playwright/test';

const PREFS_KEY = 'bff-console.params.v1';
const CURRENT_PREFS_KEY = 'bff-console.ui.v2';

async function useOneWorker(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key }) => {
      // Bound the worker choices. The test selects one fixed worker after the
      // initial coordinator snapshot because execution settings are no longer
      // restored from local storage.
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        configurable: true,
        value: 4,
      });

      // Observe the coordinator's public snapshot protocol without replacing
      // the real module Worker. The application still receives the same event;
      // this extra listener records only the reported shard count for asserts.
      const NativeWorker = window.Worker;
      window.Worker = new Proxy(NativeWorker, {
        construct(target, args) {
          const testWindow = window as Window & {
            __clrTestWorkerCount?: number;
            __clrTestCore?: string;
            __clrTestInitialSnapshot?: unknown;
            __clrTestDispatchWorkerMessage?: (data: unknown) => void;
          };
          testWindow.__clrTestWorkerCount = (testWindow.__clrTestWorkerCount ?? 0) + 1;
          const worker = Reflect.construct(target, args) as Worker;
          worker.addEventListener('message', (event: MessageEvent<unknown>) => {
            const data = event.data as { t?: unknown; core?: unknown } | null;
            if (data?.t === 'snapshot' && typeof data.core === 'string') {
              testWindow.__clrTestCore = data.core;
              testWindow.__clrTestInitialSnapshot ??= data;
            }
          });
          testWindow.__clrTestDispatchWorkerMessage = (data) => {
            worker.dispatchEvent(new MessageEvent('message', { data }));
          };
          return worker;
        },
      });
      localStorage.setItem(key, JSON.stringify({ sampler: false }));
    },
    { key: PREFS_KEY },
  );
}

async function startClr(page: Page): Promise<void> {
  await expect(page.locator('#startWindow')).toBeVisible();
  await page.locator('#btnStart').click();
  await expect(page.locator('#startLayer')).toBeHidden();
  await expect(page.locator('#application')).not.toHaveAttribute('inert', '');
}

function telemetryValue(page: Page, label: string) {
  // `has` evaluates its locator relative to each row; keeping the inner
  // selector local avoids looking for a nested second `#tele`.
  const namedLabel = page.locator('b').filter({ hasText: new RegExp(`^${label}$`) });
  return page.locator('#tele > div').filter({ has: namedLabel }).locator('em');
}

test('boots and serializes live changes around a real shard epoch', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await useOneWorker(page);
  await page.goto('/');

  const startWindow = page.locator('#startWindow');
  await expect(startWindow).toBeVisible();
  await expect(startWindow).toHaveAttribute('role', 'dialog');
  await expect(startWindow).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('#application')).toHaveAttribute('inert', '');
  await expect(page.locator('#application header#headerRoot')).toHaveCount(1);
  await expect(page.locator('#headerRoot #btnHelp')).toHaveCount(1);
  await expect(page.locator('#startLicenseLink')).toHaveAttribute('href', /LICENSE/);
  await expect(page.locator('#startNoticesLink')).toHaveAttribute('href', /THIRD_PARTY_NOTICES/);
  await expect(page.locator('#btnStart')).toBeFocused();
  expect(
    await page.evaluate(
      () => (window as Window & { __clrTestWorkerCount?: number }).__clrTestWorkerCount ?? 0,
    ),
  ).toBe(0);

  await page.keyboard.press('Escape');
  await expect(startWindow).toBeVisible();
  await startClr(page);
  expect(
    await page.evaluate(
      () => (window as Window & { __clrTestWorkerCount?: number }).__clrTestWorkerCount ?? 0,
    ),
  ).toBe(1);

  // The epoch text exists in static markup, so telemetry is the readiness
  // signal: it is populated only after the real worker and Wasm core post their
  // first snapshot.
  await expect(telemetryValue(page, 'dimensions')).toHaveText('4096 tapes × 64 bytes');
  await expect(telemetryValue(page, 'distinct tapes')).toHaveText('4096 / 4096');
  expect(await page.evaluate(() => {
    const testWindow = window as Window & {
      __clrOrderCanvas?: HTMLCanvasElement;
      __clrSoupCanvas?: HTMLCanvasElement;
    };
    const soupCanvas = document.querySelector<HTMLCanvasElement>('#soupCanvas');
    const orderCanvas = document.querySelector<HTMLCanvasElement>('#orderCanvas');
    if (!soupCanvas || !orderCanvas) return false;
    testWindow.__clrSoupCanvas = soupCanvas;
    testWindow.__clrOrderCanvas = orderCanvas;
    return soupCanvas.isConnected && orderCanvas.isConnected;
  })).toBe(true);
  await page.locator('[data-ctl="mode"] button[data-v="value"]').click();
  await expect(
    page.locator('[data-ctl="mode"] button[data-v="value"]'),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => {
    const screen = document.querySelector('#soupScreen');
    if (!screen) return false;
    return !screen.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
      deltaY: 100,
    }));
  })).toBe(true);
  expect(await page.evaluate(() => {
    const testWindow = window as Window & { __clrSoupCanvas?: HTMLCanvasElement };
    return testWindow.__clrSoupCanvas === document.querySelector('#soupCanvas');
  })).toBe(true);
  await page.locator('[data-ctl="mode"] button[data-v="ops"]').click();
  await expect(page.locator('#selEngine')).toHaveValue('brainfuck-life');
  await expect(page.locator('#selTapes')).toHaveValue('4096');
  await expect(page.locator('#inSeed')).toHaveValue('4');
  const epoch = page.locator('#segEpoch .seg-live');
  await expect(epoch).toHaveText('000000');
  await expect(page.locator('#alarm')).toBeHidden();
  await page.locator('#selWorkers').selectOption('1');
  await expect
    .poll(() =>
      page.evaluate(() => (window as Window & { __clrTestCore?: string }).__clrTestCore ?? ''),
    )
    .toBe('brainfuck-life wasm ×1');

  // Running past zero exercises the actual module shard, message wiring and
  // transferable-buffer round trip—not only the in-process PackedCore tests.
  const run = page.locator('#swRun');
  const rate = page.locator('#rateTag');
  await run.click();
  await expect
    .poll(async () => Number((await epoch.textContent())?.trim() ?? '0'))
    .toBeGreaterThan(0);
  await expect
    .poll(async () => Number((await rate.textContent())?.trim() ?? '0'))
    .toBeGreaterThan(0);

  // A stopped or restarted core has no current throughput. Waiting for a
  // positive measurement first ensures these assertions cannot pass against
  // the initial zero-rate snapshot.
  await run.click();
  await expect(run).toHaveAttribute('aria-checked', 'false');
  await expect(rate).toHaveText('0.0');
  await page.locator('#btnReset').click();
  await expect(epoch).toHaveText('000000');
  await expect(rate).toHaveText('0.0');

  // Start once more so the pool replacement and resize below still exercise
  // the coordinator while epochs are live.
  await run.click();
  await expect
    .poll(async () => Number((await epoch.textContent())?.trim() ?? '0'))
    .toBeGreaterThan(0);
  const orderEpoch = page.locator('#orderEpoch');
  await expect(orderEpoch).toHaveText(/^\d+$/);
  expect(await page.evaluate(() => {
    const testWindow = window as Window & { __clrOrderCanvas?: HTMLCanvasElement };
    return testWindow.__clrOrderCanvas === document.querySelector('#orderCanvas');
  })).toBe(true);

  // Restart while live, then deliver messages from the pre-reset revision.
  // Neither is allowed to repopulate telemetry or the cleared order history.
  await page.locator('#btnReset').click();
  await expect(run).toHaveAttribute('aria-checked', 'true');
  await page.evaluate(() => {
    const testWindow = window as Window & {
      __clrTestInitialSnapshot?: Record<string, unknown>;
      __clrTestDispatchWorkerMessage?: (data: unknown) => void;
    };
    if (!testWindow.__clrTestInitialSnapshot || !testWindow.__clrTestDispatchWorkerMessage) {
      throw new Error('worker test hooks are unavailable');
    }
    testWindow.__clrTestDispatchWorkerMessage({
      ...testWindow.__clrTestInitialSnapshot,
      epoch: 999999,
    });
    testWindow.__clrTestDispatchWorkerMessage({
      t: 'order',
      runId: testWindow.__clrTestInitialSnapshot.runId,
      epoch: 999999,
      configRevision: 0,
      highOrder: 8,
      byteOrder: 8,
      h0: 0,
      bpb: 0,
      compressed: 0,
      raw: 1,
    });
  });
  await expect(epoch).not.toHaveText('999999');
  await expect(orderEpoch).not.toHaveText('999999');

  // Experiment and worker-pool controls remain fixed while epochs are live.
  const locked = page.locator('[data-lock-running]');
  for (let i = 0; i < (await locked.count()); i++) await expect(locked.nth(i)).toBeDisabled();
  await expect(page.locator('#selWorkers')).toBeDisabled();
  await expect(page.locator('#inMut')).toBeEnabled();
  await expect(page.locator('.segctl[data-ctl="rate"] button[data-v="10"]')).toBeEnabled();
  await expect(page.locator('#btnReset')).toBeEnabled();

  await run.click();
  const enabledWhenHalted = page.locator('[data-lock-running]:not(#selCompute)');
  for (let i = 0; i < (await enabledWhenHalted.count()); i++) {
    await expect(enabledWhenHalted.nth(i)).toBeEnabled();
  }
  // The initial Brainfuck-Life engine has no WebGPU path, independently of
  // whether the browser reports a production-eligible adapter.
  await expect(page.locator('#selCompute')).toBeDisabled();

  await page.locator('#selWorkers').selectOption('2');
  await expect
    .poll(() =>
      page.evaluate(() => (window as Window & { __clrTestCore?: string }).__clrTestCore ?? ''),
    )
    .toBe('brainfuck-life wasm ×2');

  await page.locator('#selEngine').selectOption('cubff');
  await expect(epoch).toHaveText('000000');
  await expect(page.locator('#selTapes')).toHaveValue('131072');
  await expect(page.locator('#selLen')).toHaveValue('64');
  await expect(page.locator('#selSteps')).toHaveValue('8192');
  await expect(page.locator('#inSeed')).toHaveValue('0');
  await expect(page.locator('#roMut')).toHaveText('0.0244%');
  await expect
    .poll(() =>
      page.evaluate(() => (window as Window & { __clrTestCore?: string }).__clrTestCore ?? ''),
    )
    .toBe('cubff wasm ×2');

  await page.locator('#selLen').selectOption('32');
  await page.locator('#btnReset').click();

  await expect(telemetryValue(page, 'dimensions')).toHaveText('131072 tapes × 32 bytes');
  await expect(epoch).toHaveText('000000');
  await expect(rate).toHaveText('0.0');
  await expect(run).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#alarm')).toBeHidden();
  expect(errors).toEqual([]);
});

test('shows a contained fatal alert when CSP blocks WebAssembly compilation', async ({
  context,
  page,
}) => {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
  ].join('; ');

  // A dedicated worker receives its own response policy. Applying the same
  // restrictive header to the document and its same-origin assets matches the
  // nginx deployment and ensures the coordinator worker cannot compile Wasm.
  await context.route('**/*', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        'content-security-policy': policy,
      },
    });
  });

  await useOneWorker(page);
  await page.goto('/');
  await startClr(page);

  const alarm = page.locator('#alarm');
  const diagnostic = page.locator('#alarmText');
  const header = page.locator('header#headerRoot');

  await expect(alarm).toBeVisible();
  await expect(diagnostic).toHaveText(/\S/);
  await expect(page.locator('#swRun')).toHaveAttribute('aria-checked', 'false');

  const coreControls = page.locator(
    '[data-core-controls] button:not([data-help]), ' +
      '[data-core-controls] input, [data-core-controls] select',
  );
  expect(await coreControls.count()).toBeGreaterThan(0);
  for (let i = 0; i < (await coreControls.count()); i++) {
    await expect(coreControls.nth(i)).toBeDisabled();
  }
  for (const selector of ['#btnHelp', '#btnSoupFit', '#btnSoupExpand', '#swSampler']) {
    await expect(page.locator(selector)).toBeEnabled();
  }

  // The global shortcut must not revive a terminal coordinator.
  await page.keyboard.press('Space');
  await expect(page.locator('#swRun')).toHaveAttribute('aria-checked', 'false');

  const [alarmBox, diagnosticBox, headerBox] = await Promise.all([
    alarm.boundingBox(),
    diagnostic.boundingBox(),
    header.boundingBox(),
  ]);
  expect(alarmBox).not.toBeNull();
  expect(diagnosticBox).not.toBeNull();
  expect(headerBox).not.toBeNull();
  if (!alarmBox || !diagnosticBox || !headerBox) return;

  const tolerance = 1;
  expect(diagnosticBox.x).toBeGreaterThanOrEqual(alarmBox.x - tolerance);
  expect(diagnosticBox.y).toBeGreaterThanOrEqual(alarmBox.y - tolerance);
  expect(diagnosticBox.x + diagnosticBox.width).toBeLessThanOrEqual(
    alarmBox.x + alarmBox.width + tolerance,
  );
  expect(diagnosticBox.y + diagnosticBox.height).toBeLessThanOrEqual(
    alarmBox.y + alarmBox.height + tolerance,
  );
  expect(alarmBox.y + alarmBox.height).toBeLessThanOrEqual(headerBox.y + tolerance);

  const overflow = await alarm.evaluate((el) => ({
    client: el.clientWidth,
    scroll: el.scrollWidth,
  }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + tolerance);
});

test('contains a synchronous worker construction failure', async ({ page }) => {
  await page.addInitScript(() => {
    class UnavailableWorker {
      constructor() {
        throw new DOMException('worker construction blocked', 'SecurityError');
      }
    }
    Object.defineProperty(window, 'Worker', {
      configurable: true,
      value: UnavailableWorker,
    });
  });

  await page.goto('/');
  await startClr(page);

  await expect(page.locator('#alarm')).toBeVisible();
  await expect(page.locator('#alarmText')).toHaveText('worker construction blocked');
  await expect(page.locator('#swRun')).toBeDisabled();
  await expect(page.locator('#swRun')).toHaveAttribute('aria-checked', 'false');
});

test('opens the reactor manual and navigates its model topics', async ({ page }) => {
  await useOneWorker(page);
  await page.goto('/');
  await startClr(page);

  await page.locator('#btnHelp').click();

  const manual = page.locator('#helpWin');
  const activeTopic = page.locator('#helpNav button[aria-pressed="true"]');
  const runSwitch = page.locator('#swRun');
  await expect(manual).toBeVisible();
  await expect(manual).toHaveAttribute('aria-label', /\S/);
  await expect(page.locator('#helpClose')).toHaveAccessibleName(/\S/);
  await expect(page.locator('#helpClose')).toBeFocused();
  await expect(page.locator('#btnHelp')).toHaveAttribute('aria-pressed', 'true');
  await expect(activeTopic).toHaveAttribute('data-topic', 'fundamentals');

  const manualBar = page.locator('#helpBar');
  const beforeDrag = await manual.boundingBox();
  const barBox = await manualBar.boundingBox();
  if (!beforeDrag || !barBox) throw new Error('manual drag geometry is unavailable');
  await page.mouse.move(barBox.x + barBox.width / 2, barBox.y + barBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(barBox.x + barBox.width / 2 - 80, barBox.y + barBox.height / 2 + 60);
  await page.mouse.up();
  await expect.poll(async () => (await manual.boundingBox())?.x ?? 0)
    .toBeLessThan(beforeDrag.x);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');

  const resizeHandle = manual.locator('[data-window-resize]');
  const beforeResize = await manual.boundingBox();
  const handleBox = await resizeHandle.boundingBox();
  if (!beforeResize || !handleBox) throw new Error('manual resize geometry is unavailable');
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 80, handleBox.y + handleBox.height / 2 + 60);
  await page.mouse.up();
  await expect.poll(async () => (await manual.boundingBox())?.width ?? 0)
    .toBeGreaterThan(beforeResize.width);
  await expect.poll(async () => (await manual.boundingBox())?.height ?? 0)
    .toBeGreaterThan(beforeResize.height);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');

  // The React-owned header trigger is the only owner of this toggle.
  await page.locator('#btnHelp').click();
  await expect(manual).toBeHidden();
  await expect(page.locator('#btnHelp')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#btnHelp')).toBeFocused();
  await page.locator('#btnHelp').click();
  await expect(manual).toBeVisible();
  await expect(page.locator('#helpClose')).toBeFocused();

  // The React window focuses its close control. Its normal Space activation
  // must not also reach the reactor's global run shortcut.
  await page.keyboard.press('Space');
  await expect(manual).toBeHidden();
  await expect(runSwitch).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#btnHelp')).toBeFocused();
  await page.keyboard.type('?');
  await expect(manual).toBeVisible();
  await expect(page.locator('#helpClose')).toBeFocused();

  await page.locator('#helpNav button[data-topic="sampler"]').click();
  await expect(activeTopic).toHaveAttribute('data-topic', 'sampler');
  await expect(page.locator('[data-help="sampler"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#btnHelp')).toHaveAttribute('aria-pressed', 'false');

  await page.keyboard.press('Escape');
  await expect(manual).toBeHidden();
  await expect(page.locator('#btnHelp')).toBeFocused();

  const soupHelp = page.locator('[data-help="soup"]');
  await soupHelp.click();
  await expect(activeTopic).toHaveAttribute('data-topic', 'soup');
  await page.keyboard.press('Escape');
  await expect(manual).toBeHidden();
  await expect(soupHelp).toBeFocused();
});

test('does not rewrite closed manual preferences while restoring geometry', async ({ page }) => {
  const stored = {
    mode: 'ops',
    sample: 'random',
    rxrate: '1',
    sampler: false,
    help: false,
    helpTopic: 'references',
    helpBox: { x: 32, y: 48, w: 420, h: 320 },
  };
  await page.addInitScript(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: CURRENT_PREFS_KEY, value: stored },
  );
  await page.goto('/');

  await expect(page.locator('#helpWin')).toBeHidden();
  expect(await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? 'null') as unknown,
    CURRENT_PREFS_KEY,
  )).toEqual(stored);
});

test('restores the React manual geometry and falls back from a stale topic', async ({ page }) => {
  await useOneWorker(page);
  await page.addInitScript(
    ({ key }) => localStorage.setItem(key, JSON.stringify({
      sampler: false,
      help: true,
      helpTopic: 'removed-topic',
      helpBox: { x: 20, y: 30, w: 400, h: 300 },
    })),
    { key: CURRENT_PREFS_KEY },
  );
  await page.goto('/');
  const manual = page.locator('#helpWin');
  await expect(page.locator('#application')).toHaveAttribute('inert', '');
  await expect(page.locator('#btnStart')).toBeFocused();
  await expect(page.locator('#helpClose')).not.toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#startWindow')).toBeVisible();
  await expect(manual).not.toHaveAttribute('hidden', '');
  await startClr(page);

  await expect(manual).toBeVisible();
  await expect(page.locator('#helpNav button[aria-pressed="true"]')).toHaveAttribute(
    'data-topic',
    'fundamentals',
  );
  await expect(page.locator('#btnHelp')).toHaveAttribute('aria-pressed', 'true');
  await expect(manual).toHaveCSS('left', '20px');
  await expect(manual).toHaveCSS('top', '30px');
  await expect(manual).toHaveCSS('width', '400px');
  await expect(manual).toHaveCSS('height', '300px');
  await expect(page.locator('#helpClose')).toBeFocused();

  await page.locator('#helpClose').click();
  await expect(manual).toBeHidden();
  await expect(page.locator('#btnHelp')).toBeFocused();
});

test('persists a dragged manual and its valid topic across reload', async ({ page }) => {
  await useOneWorker(page);
  await page.goto('/');
  await startClr(page);

  await page.locator('[data-help="conditions"]').click();
  const manual = page.locator('#helpWin');
  const bar = page.locator('#helpBar');
  await expect(manual).toBeVisible();
  const before = await bar.boundingBox();
  if (!before) throw new Error('manual title bar has no geometry');

  await page.mouse.move(before.x + 100, before.y + 12);
  await page.mouse.down();
  await page.mouse.move(before.x + 160, before.y + 57);
  await page.mouse.up();

  const saved = await page.evaluate((key) => {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}') as {
      helpTopic?: unknown;
      helpBox?: { x?: unknown; y?: unknown };
    };
    return value;
  }, CURRENT_PREFS_KEY);
  expect(saved.helpTopic).toBe('conditions');
  expect(saved.helpBox?.x).toBe(before.x + 60);
  expect(saved.helpBox?.y).toBe(before.y + 45);

  await page.reload();
  await startClr(page);
  await expect(manual).toBeVisible();
  await expect(page.locator('#helpNav button[aria-pressed="true"]')).toHaveAttribute(
    'data-topic',
    'conditions',
  );
  await expect(manual).toHaveCSS('left', `${saved.helpBox?.x}px`);
  await expect(manual).toHaveCSS('top', `${saved.helpBox?.y}px`);
});

test('rejects a stale sampler rate and keeps the loaded sampler inspectable while off', async ({
  page,
}) => {
  await useOneWorker(page);
  await page.addInitScript(
    ({ key }) => {
      const prefs = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
      localStorage.setItem(key, JSON.stringify({ ...prefs, rxrate: '512' }));
    },
    { key: PREFS_KEY },
  );
  await page.goto('/');
  await startClr(page);

  // A rate saved by the previous control set is rejected. A supported current
  // rate must remain selected, without making its exact value a test contract.
  const selectedRate = page.locator(
    '.segctl[data-ctl="rxrate"] button[aria-pressed="true"]',
  );
  await expect(selectedRate).toHaveCount(1);
  await expect(selectedRate).not.toHaveAttribute('data-v', '512');

  const sampler = page.locator('#swSampler');
  const nextValue = page.locator('#rNextValue');
  const step = page.locator('#btnRxStep');
  expect(await page.evaluate(() => {
    const testWindow = window as Window & { __clrSamplerCanvas?: HTMLCanvasElement };
    const canvas = document.querySelector<HTMLCanvasElement>('#reactorCanvas');
    if (!canvas) return false;
    testWindow.__clrSamplerCanvas = canvas;
    return canvas.isConnected;
  })).toBe(true);

  await expect(sampler).toHaveAttribute('aria-checked', 'false');
  await expect(step).toBeDisabled();

  await sampler.click();
  await expect(sampler).toHaveAttribute('aria-checked', 'true');
  await expect(step).toBeEnabled();
  await expect(nextValue).toHaveText(/^\d+$/);
  const loadedNextValue = await nextValue.textContent();

  await sampler.click();
  await expect(sampler).toHaveAttribute('aria-checked', 'false');
  await expect(step).toBeDisabled();
  await expect(nextValue).toHaveText(loadedNextValue ?? '');
  expect(await page.evaluate(() => {
    const testWindow = window as Window & { __clrSamplerCanvas?: HTMLCanvasElement };
    return testWindow.__clrSamplerCanvas === document.querySelector('#reactorCanvas');
  })).toBe(true);
});

test('executes a durable one-item batch and restores the manual setup', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await useOneWorker(page);
  await page.goto('/');
  await startClr(page);
  await expect(telemetryValue(page, 'dimensions')).toHaveText('4096 tapes × 64 bytes');

  await page.locator('#btnRuns').click();
  await expect(page.locator('#runsWin')).toBeVisible();
  await page.locator('#btnHelp').click();
  await expect(page.locator('#helpWin')).toBeVisible();
  expect(await page.evaluate(() => ({
    help: Number(document.querySelector<HTMLElement>('#helpWin')?.style.zIndex),
    runs: Number(document.querySelector<HTMLElement>('#runsWin')?.style.zIndex),
  }))).toEqual({ help: 61, runs: 60 });
  await page.locator('#runsBar').click({ position: { x: 10, y: 10 } });
  expect(await page.evaluate(() => ({
    help: Number(document.querySelector<HTMLElement>('#helpWin')?.style.zIndex),
    runs: Number(document.querySelector<HTMLElement>('#runsWin')?.style.zIndex),
  }))).toEqual({ help: 60, runs: 61 });
  await page.locator('#btnHelp').click();
  await expect(page.locator('#helpWin')).toBeHidden();
  await page.locator('#runsBody [name="tapes"]').selectOption('1024');
  await page.locator('#runsBody [name="length"]').selectOption('32');
  await page.locator('#runsBody [name="steps"]').selectOption('2048');
  await page.locator('#runsBody [name="epochLimit"]').fill('1');
  await page.locator('#runsBody [name="orderCrossing"]').selectOption('3');
  await page.locator('#batchAdd').click();
  await expect(page.locator('[data-queue-index]')).toHaveCount(1);

  await page.locator('#batchRun').click();
  await expect(page.locator('.batch-state')).toContainText('completed, 1 / 1 completed', {
    timeout: 30_000,
  });
  await expect(page.locator('[data-queue-index]')).toContainText('epoch limit at 1');

  // Cleanup creates a fresh halted epoch-zero manual run with the exact setup
  // that preceded the accepted batch.
  await expect(telemetryValue(page, 'dimensions')).toHaveText('4096 tapes × 64 bytes');
  await expect(page.locator('#segEpoch .seg-live')).toHaveText('000000');
  await expect(page.locator('#swRun')).toBeEnabled();
  await expect(page.locator('#btnReset')).toBeEnabled();
  await expect(page.locator('#selEngine')).toBeEnabled();
  await page.locator('[data-runs-tab="records"]').click();
  await expect(page.locator('[data-export-run]')).toHaveCount(1);

  // A pause retains batch ownership, but local Runs navigation stays usable.
  // Stop is the explicit operation that ends that ownership and restores the
  // manual controls without deleting the draft queue.
  await page.locator('[data-runs-tab="batch"]').click();
  await page.locator('#runsBody [name="epochLimit"]').fill('100000000');
  await page.locator('#batchEdit').click();
  await page.locator('#batchRun').click();
  await expect(page.locator('[data-queue-index]')).toContainText('running');
  await page.locator('#batchRun').click();
  await expect(page.locator('.batch-state')).toContainText('paused');
  await expect(page.locator('#batchClear')).toBeDisabled();
  await expect(page.locator('#batchStop')).toBeEnabled();
  await expect(page.locator('#selEngine')).toBeDisabled();

  await page.locator('#runsClose').click();
  await expect(page.locator('#runsWin')).toBeHidden();
  await expect(page.locator('#btnRuns')).toBeEnabled();
  await page.locator('#btnRuns').click();
  await expect(page.locator('#runsWin')).toBeVisible();

  page.once('dialog', (dialog) => void dialog.accept());
  await page.locator('#batchStop').click();
  await expect(page.locator('.batch-state')).toContainText('stopped');
  await expect(page.locator('[data-queue-index]')).toContainText('stopped');
  await expect(page.locator('#batchClear')).toBeEnabled();
  await expect(page.locator('#batchStop')).toBeDisabled();
  await expect(page.locator('#selEngine')).toBeEnabled();
  expect(errors).toEqual([]);
});
