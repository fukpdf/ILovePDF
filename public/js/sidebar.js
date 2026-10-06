function buildSidebar(activeToolId) {
  const container = document.getElementById('sidebar-container');
  if (!container) return;

  const grouped = {};
  TOOLS.forEach(tool => {
    if (!grouped[tool.category]) grouped[tool.category] = [];
    grouped[tool.category].push(tool);
  });

  const catOrder = CATEGORIES.map(c => c.name);
  const params = new URLSearchParams(window.location.search);
  const activeFilter = params.get('filter') || 'all';

  let html = `
    <div class="sidebar-logo">
      <div class="sidebar-logo-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="9" y1="15" x2="15" y2="15"/>
          <line x1="9" y1="11" x2="15" y2="11"/>
        </svg>
      </div>
      <div class="sidebar-logo-text">
        ILovePDF
        <span>Free PDF &amp; Image Tools</span>
      </div>
    </div>

    <div class="sidebar-filter-nav">
      <a href="/" class="sidebar-filter-btn ${activeFilter === 'all' ? 'active' : ''}">
        <i data-lucide="layout-grid"></i> All Tools
      </a>
      <a href="/?filter=pdf" class="sidebar-filter-btn ${activeFilter === 'pdf' ? 'active' : ''}">
        <i data-lucide="file-text"></i> PDF Tools
      </a>
      <a href="/?filter=image" class="sidebar-filter-btn ${activeFilter === 'image' ? 'active' : ''}">
        <i data-lucide="image"></i> Image Tools
      </a>
      <a href="/?filter=soon" class="sidebar-filter-btn ${activeFilter === 'soon' ? 'active' : ''}">
        <i data-lucide="clock"></i> Coming Soon
      </a>
    </div>

    <nav class="sidebar-nav">
  `;

  catOrder.forEach(catName => {
    const catMeta = CATEGORIES.find(c => c.name === catName);
    const tools = (grouped[catName] || []).filter(t => {
      if (activeFilter === 'pdf')   return t.group === 'pdf';
      if (activeFilter === 'image') return t.group === 'image';
      if (activeFilter === 'soon')  return !t.working;
      return true;
    });
    if (tools.length === 0) return;

    html += `<div class="sidebar-category">${catName}</div>`;
    tools.forEach(tool => {
      const isActive = tool.id === activeToolId ? ' active' : '';
      const isSoon = !tool.working;
      const badge = isSoon ? `<span class="sidebar-item-badge badge-soon">Soon</span>` : '';
      html += `
        <a href="tool.html?id=${tool.id}" class="sidebar-item${isActive}" data-tool-id="${tool.id}" data-working="${tool.working}">
          <i data-lucide="${tool.icon}"></i>
          <span>${tool.name}</span>
          ${badge}
        </a>
      `;
    });
  });

  html += `</nav>`;
  container.innerHTML = html;

  if (window.lucide) lucide.createIcons();

  const toggle = document.getElementById('menu-toggle');
  const overlay = document.getElementById('sidebar-overlay');

  if (toggle) {
    toggle.addEventListener('click', () => {
      container.classList.toggle('open');
      if (overlay) overlay.classList.toggle('hidden');
    });
  }
  if (overlay) {
    overlay.addEventListener('click', () => {
      container.classList.remove('open');
      overlay.classList.add('hidden');
    });
  }
}
