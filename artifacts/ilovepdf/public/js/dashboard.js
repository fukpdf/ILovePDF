document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const filter = params.get('filter') || 'all';

  buildSidebar(null);
  renderDashboard(filterTools(TOOLS, filter), filter);

  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      const base = filterTools(TOOLS, filter);
      const filtered = q ? base.filter(t =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q)
      ) : base;
      renderDashboard(filtered, filter, q);
    });
  }
});

function filterTools(tools, filter) {
  if (filter === 'pdf')   return tools.filter(t => t.group === 'pdf');
  if (filter === 'image') return tools.filter(t => t.group === 'image');
  if (filter === 'soon')  return tools.filter(t => !t.working);
  return tools;
}

function renderDashboard(tools, filter, query) {
  const content = document.getElementById('dashboard-content');
  if (!content) return;

  if (tools.length === 0) {
    content.innerHTML = `
      <div class="empty-state">
        <i data-lucide="search-x"></i>
        <div class="empty-state-title">No tools found</div>
        <p>Try a different search term or filter</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  const grouped = {};
  tools.forEach(t => {
    if (!grouped[t.category]) grouped[t.category] = [];
    grouped[t.category].push(t);
  });

  const catOrder = CATEGORIES.map(c => c.name).filter(n => grouped[n]);
  let html = '';

  catOrder.forEach(catName => {
    const catTools = grouped[catName];
    const catMeta = CATEGORIES.find(c => c.name === catName);
    const color = catMeta ? catMeta.color : '#6366f1';

    html += `
      <div class="section-header">
        <div class="section-dot" style="background:${color}"></div>
        <span class="section-title">${catName}</span>
        <span class="section-count">${catTools.length} tool${catTools.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="tools-grid">
    `;

    catTools.forEach(tool => {
      const bgAlpha = hexToRgba(color, 0.12);
      const isWorking = tool.working;

      const badgeColor = getBadgeColor(tool.badge);
      const catBadgeHtml = `<span class="cat-badge" style="background:${badgeColor.bg};color:${badgeColor.text}">${tool.badge}</span>`;
      const statusBadge = isWorking
        ? `<span class="card-badge badge-live">Live</span>`
        : `<span class="card-badge badge-soon-card">Coming Soon</span>`;

      if (isWorking) {
        const href = tool.url || `tool.html?id=${tool.id}`;
        html += `
          <a href="${href}" class="tool-card" title="${tool.description}">
            <div style="display:flex;align-items:center;justify-content:space-between">
              <div class="tool-card-icon" style="background:${bgAlpha}; color:${color}">
                <i data-lucide="${tool.icon}"></i>
              </div>
              ${catBadgeHtml}
            </div>
            <div>
              <div class="tool-card-name">${tool.name}</div>
              <div class="tool-card-desc">${tool.description}</div>
            </div>
            <div class="tool-card-footer">
              ${statusBadge}
              <span class="tool-card-arrow"><i data-lucide="arrow-right"></i></span>
            </div>
          </a>
        `;
      } else {
        html += `
          <div class="tool-card tool-card--soon" onclick="showComingSoonModal('${tool.name}')" title="${tool.description}">
            <div style="display:flex;align-items:center;justify-content:space-between">
              <div class="tool-card-icon" style="background:${bgAlpha}; color:${color}; opacity:.6">
                <i data-lucide="${tool.icon}"></i>
              </div>
              ${catBadgeHtml}
            </div>
            <div>
              <div class="tool-card-name">${tool.name}</div>
              <div class="tool-card-desc">${tool.description}</div>
            </div>
            <div class="tool-card-footer">
              ${statusBadge}
              <span class="tool-card-arrow"><i data-lucide="clock"></i></span>
            </div>
          </div>
        `;
      }
    });

    html += `</div>`;
  });

  content.innerHTML = html;
  lucide.createIcons();
}

function showComingSoonModal(toolName) {
  const modal = document.getElementById('coming-soon-modal');
  const modalToolName = document.getElementById('modal-tool-name');
  if (!modal) return;
  if (modalToolName) modalToolName.textContent = toolName || 'This feature';
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeComingSoonModal() {
  const modal = document.getElementById('coming-soon-modal');
  if (modal) modal.classList.add('hidden');
  document.body.style.overflow = '';
}

function getBadgeColor(badge) {
  const map = {
    'PDF':     { bg: '#dbeafe', text: '#1d4ed8' },
    'Image':   { bg: '#f3e8ff', text: '#7e22ce' },
    'AI':      { bg: '#e0e7ff', text: '#4338ca' },
    'Utility': { bg: '#ffedd5', text: '#c2410c' },
  };
  return map[badge] || { bg: '#f1f5f9', text: '#475569' };
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
