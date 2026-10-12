/**
 * patch-tool-page-init.js
 * Build step: tool-page.js must not wait for DOMContentLoaded (blocked by 300+ deferred scripts).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'public', 'js', 'tool-page.js');

function main() {
  let t = fs.readFileSync(FILE, 'utf8');
  const oldOpen = "document.addEventListener('DOMContentLoaded', async () => {";
  const newOpen = 'async function initToolPage() {';
  if (!t.includes(oldOpen)) {
    if (t.includes('async function initToolPage()')) {
      console.log('[patch-tool-page-init] already patched');
      return;
    }
    throw new Error('expected DOMContentLoaded bootstrap not found');
  }
  t = t.replace(oldOpen, newOpen);
  const oldClose = `    }, 1800);
  });
});

function renderNotFound`;
  const newClose = `    }, 1800);
  });
}

// Do not wait for DOMContentLoaded — deferred script chain holds that event.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initToolPage, { once: true });
} else {
  initToolPage();
}

function renderNotFound`;
  if (!t.includes(oldClose)) {
    throw new Error('expected handler close marker not found');
  }
  t = t.replace(oldClose, newClose);
  fs.writeFileSync(FILE, t, 'utf8');
  console.log('[patch-tool-page-init] patched', FILE, 'bytes', t.length);
}

main();
