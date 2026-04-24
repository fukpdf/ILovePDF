// Side-panel (home dashboard) controller for the Numbers-to-Words tool.
// Reuses window.convertNumberToWords from n2w-converter.js.
(function () {
  const $ = id => document.getElementById(id);
  const panel  = $('n2w-side');
  const toggle = $('adv-toggle');
  if (!panel || !toggle) return;

  function run() {
    const mode = document.querySelector('input[name="n2w-mode"]:checked').value;
    const out  = window.convertNumberToWords($('n2w-num').value, {
      mode,
      currency:   $('n2w-currency').value,
      suffix:     mode === 'check' ? 'only' : 'exactly',
      letterCase: $('n2w-case').value,
    });
    $('n2w-err').classList.add('hidden');
    $('n2w-out-wrap').classList.add('hidden');
    if (out.error) {
      $('n2w-err').textContent = out.error;
      $('n2w-err').classList.remove('hidden');
      return;
    }
    $('n2w-out').textContent = out.text;
    $('n2w-out-wrap').classList.remove('hidden');
  }

  $('n2w-convert').addEventListener('click', run);
  $('n2w-num').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run();
  });
  $('n2w-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('n2w-out').textContent);
      const b = $('n2w-copy'); const t = b.textContent;
      b.textContent = '✓ Copied'; setTimeout(() => (b.textContent = t), 1200);
    } catch { /* ignore */ }
  });

  // Mobile accordion: panel is hidden by default, toggle expands it.
  toggle.addEventListener('click', () => {
    const open = panel.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.classList.toggle('open', open);
    if (open) panel.querySelector('#n2w-num')?.focus();
  });

  // Close button (visible on mobile when expanded)
  $('n2w-close').addEventListener('click', () => {
    panel.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.classList.remove('open');
  });
})();
