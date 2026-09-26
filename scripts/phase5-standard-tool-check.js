  if (!tool.capabilities || tool.capabilities.fileSizePolicy !== 'unlimited') fail(label + ' file-size policy is not unlimited.');
}

// ── Runtime scheduler cancellation contract ───────────────────────────────
const taskScheduler = read('public/js/task-scheduler.js');
const runtimeScheduler = read('public/js/runtime-task-scheduler.js');
if (!/function acquireSlot\(tier, token\)/.test(taskScheduler)) fail('TaskScheduler acquireSlot is not token-cancellable.');
if (!/token\.onCancel\(function \(reason\)/.test(taskScheduler)) fail('TaskScheduler does not remove cancelled queued waiters.');
if (!/slot\.queue\.indexOf\(entry\)/.test(taskScheduler)) fail('TaskScheduler cancellation does not identify the queued entry.');
if (!/entry\.resolve\(\)/.test(taskScheduler)) fail('TaskScheduler queue entries do not resolve through their scheduler contract.');
if (!/acquireSlot\(tier, token\)/.test(runtimeScheduler)) fail('RuntimeScheduler does not pass cancellation into TaskScheduler.');
if (runtimeScheduler.indexOf('if (!_canStart(type))') === -1 || runtimeScheduler.indexOf('token.onCancel(function (reason)') === -1 || runtimeScheduler.indexOf('releaseTierSlotOnce()') === -1) fail('RuntimeScheduler type-cap queue does not release its held tier slot on cancellation.');
if (!/Only create telemetry\/progress resources once both queue layers can start/.test(runtimeScheduler)) fail('RuntimeScheduler may allocate telemetry/progress before queued cancellation is settled.');

const browserRuntime = read('public/js/browser-tool-runtime.js');
if (!/RuntimeScheduler\.run\(/.test(browserRuntime)) fail('BrowserToolRuntime does not use RuntimeScheduler.');