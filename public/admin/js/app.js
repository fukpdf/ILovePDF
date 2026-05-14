/* ILovePDF Admin Dashboard — Full SPA (Vanilla JS) */
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(typeof c === 'string' ? c : c);
  return e;
};
const fmt = {
  date: ts => ts ? new Date(ts * 1000).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '—',
  time: ts => ts ? new Date(ts * 1000).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—',
  bytes: b => b < 1024 ? b + ' B' : b < 1048576 ? (b/1024).toFixed(1)+' KB' : (b/1048576).toFixed(1)+' MB',
  num: n => Number(n).toLocaleString(),
  ago: ts => {
    const s = Math.floor(Date.now()/1000) - ts;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s/60) + 'm ago';
    if (s < 86400) return Math.floor(s/3600) + 'h ago';
    return Math.floor(s/86400) + 'd ago';
  }
};
function slugify(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9\s-]/g,'').trim().replace(/\s+/g,'-').replace(/-+/g,'-').slice(0,80);
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ═══════════════════════════════════════════════════════════════════════════
// API LAYER
// ═══════════════════════════════════════════════════════════════════════════

const API = {
  async req(method, path, body) {
    const opts = { method, credentials: 'include', headers: {} };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch('/api/admin' + path, opts);
    if (res.status === 401) { window.location.href = '/admin/login'; throw new Error('Session expired'); }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  },
  get:    (p)    => API.req('GET',    p),
  post:   (p, b) => API.req('POST',   p, b),
  put:    (p, b) => API.req('PUT',    p, b),
  delete: (p)    => API.req('DELETE', p),
  upload: async (path, formData) => {
    const res = await fetch('/api/admin' + path, { method:'POST', body: formData, credentials:'include' });
    if (res.status === 401) { window.location.href = '/admin/login'; throw new Error('Session expired'); }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════════════════

function toast(msg, type = 'default', duration = 3500) {
  const icons = {
    success: '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>',
    error:   '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    warning: '<svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    default: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  };
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = (icons[type]||icons.default) + `<span>${esc(msg)}</span>`;
  $('#toast-container').prepend(t);
  setTimeout(() => { t.style.opacity='0'; t.style.transform='translateX(20px)'; t.style.transition='.25s'; setTimeout(() => t.remove(), 250); }, duration);
}

// ═══════════════════════════════════════════════════════════════════════════
// MODAL
// ═══════════════════════════════════════════════════════════════════════════

let _modalResolve;
function modal(title, bodyHtml, confirmText = 'Confirm', type = 'primary') {
  return new Promise(resolve => {
    _modalResolve = resolve;
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHtml;
    $('#modal-confirm').textContent = confirmText;
    $('#modal-confirm').className = `btn btn-${type}`;
    $('#modal-overlay').classList.add('open');
    _modalResolve = resolve;
  });
}
function closeModal() { $('#modal-overlay').classList.remove('open'); if (_modalResolve) { _modalResolve(false); _modalResolve = null; } }
$('#modal-close').onclick = closeModal;
$('#modal-cancel').onclick = closeModal;
$('#modal-confirm').onclick = () => { $('#modal-overlay').classList.remove('open'); if (_modalResolve) { _modalResolve(true); _modalResolve = null; } };
$('#modal-overlay').onclick = e => { if (e.target === $('#modal-overlay')) closeModal(); };

// ═══════════════════════════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════════════════════════

const SECTION_TITLES = {
  overview:'Overview', blog:'Blog Manager', tools:'Tool Manager',
  analytics:'Analytics', homepage:'Homepage Content', branding:'Branding',
  media:'Media Library', announcements:'Announcements', seo:'SEO Panel',
  ads:'Ads & Monetization', donations:'Donations', health:'System Health',
  logs:'Audit Logs', settings:'Settings', backup:'Backup & Export',
};

let _currentSection = 'overview';
// Monotonic navigation counter — incremented on every navigate() call so any
// in-flight async renderSection() can detect it has been superseded and bail
// before writing to the DOM. This prevents stale data from a slow API call
// overwriting content rendered by a more recent navigation event.
let _navSeq = 0;

function navigate(section) {
  if (!SECTION_TITLES[section]) section = 'overview';
  _currentSection = section;
  _navSeq++;

  $$('.section').forEach(s => s.classList.remove('active'));
  const sec = $(`#section-${section}`);
  if (sec) sec.classList.add('active');

  $$('.nav-item').forEach(n => n.classList.remove('active'));
  $$(`[data-section="${section}"]`).forEach(n => n.classList.add('active'));

  $('#topbar-title').textContent = SECTION_TITLES[section];

  history.pushState({ section }, '', `/admin#${section}`);
  renderSection(section);
}

async function renderSection(name) {
  const sec = $(`#section-${name}`);
  if (!sec) return;
  switch (name) {
    case 'overview':     return renderOverview(sec);
    case 'blog':         return renderBlog(sec);
    case 'tools':        return renderTools(sec);
    case 'analytics':    return renderAnalytics(sec);
    case 'homepage':     return renderHomepage(sec);
    case 'branding':     return renderBranding(sec);
    case 'media':        return renderMedia(sec);
    case 'announcements':return renderAnnouncements(sec);
    case 'seo':          return renderSEO(sec);
    case 'ads':          return renderAds(sec);
    case 'donations':    return renderDonations(sec);
    case 'health':       return renderHealth(sec);
    case 'logs':         return renderLogs(sec);
    case 'settings':     return renderSettings(sec);
    case 'backup':       return renderBackup(sec);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — OVERVIEW
// ═══════════════════════════════════════════════════════════════════════════

async function renderOverview(sec) {
  sec.innerHTML = `<div class="page-header"><div><div class="page-title">Overview</div><div class="page-sub">Dashboard summary and recent activity.</div></div><div class="page-actions"><button class="btn btn-secondary btn-sm" id="refresh-overview"><svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Refresh</button></div></div><div id="ov-stats"><div class="stat-grid">${[1,2,3,4,5,6].map(()=>'<div class="stat-card"><div class="skeleton skel-row w60"></div><div class="skeleton skel-row" style="height:28px;width:50%;margin-top:8px"></div></div>').join('')}</div></div><div class="grid-2" style="gap:16px"><div class="card" id="ov-logs-card"><div class="card-header"><span class="card-title">Recent Activity</span></div><div class="card-body" id="ov-logs">Loading…</div></div><div id="ov-health-card"><div class="card"><div class="card-header"><span class="card-title">System Health</span></div><div class="card-body" id="ov-health">Loading…</div></div></div></div>`;
  $('#refresh-overview').onclick = () => renderOverview(sec);
  try {
    const d = await API.get('/overview');
    const s   = d.stats   || {};
    const sys = d.system  || {};
    const recentLogs = Array.isArray(d.recentLogs) ? d.recentLogs : [];
    $('#ov-stats').innerHTML = `<div class="stat-grid">
      <div class="stat-card"><div class="stat-icon icon-purple"><svg viewBox="0 0 24 24"><rect x="2" y="3" width="6" height="6" rx="1"/><rect x="9" y="3" width="6" height="6" rx="1"/><rect x="16" y="3" width="6" height="6" rx="1"/><rect x="2" y="10" width="6" height="6" rx="1"/></svg></div><div class="stat-label">Total Tools</div><div class="stat-value">${s.totalTools||0}</div><div class="stat-sub">${s.totalTools||0} available</div></div>
      <div class="stat-card"><div class="stat-icon icon-green"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></div><div class="stat-label">Blog Posts</div><div class="stat-value">${s.totalPosts||0}</div><div class="stat-sub">${s.pubPosts||0} published · ${s.draftPosts||0} draft</div></div>
      <div class="stat-card"><div class="stat-icon icon-blue"><svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></div><div class="stat-label">Registered Users</div><div class="stat-value">${fmt.num(s.totalUsers||0)}</div><div class="stat-sub">+${s.todayUsers||0} today</div></div>
      <div class="stat-card"><div class="stat-icon icon-yellow"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33"/></svg></div><div class="stat-label">Active Flags</div><div class="stat-value">${s.activeFlags||0}</div><div class="stat-sub">Feature flags enabled</div></div>
      <div class="stat-card"><div class="stat-icon icon-green"><svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></div><div class="stat-label">Uptime</div><div class="stat-value">${fmtUptime(sys.uptime||0)}</div><div class="stat-sub">Node ${sys.nodeVersion||'N/A'}</div></div>
      <div class="stat-card"><div class="stat-icon icon-purple"><svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg></div><div class="stat-label">Memory Used</div><div class="stat-value">${sys.memUsedMB||0}<small style="font-size:14px">MB</small></div><div class="stat-sub">of ${sys.memTotalMB||0}MB heap</div></div>
    </div>`;
    // Recent logs
    $('#ov-logs').innerHTML = recentLogs.length ? recentLogs.slice(0,10).map(l => `
      <div class="log-item">
        <div class="log-dot" style="background:${actionColor(l.action||'')}"></div>
        <div class="log-content">
          <div class="log-action">${esc((l.action||'').replace(/_/g,' '))}</div>
          <div class="log-meta">${esc(l.details||'')} ${l.ip?'· '+l.ip:''}</div>
        </div>
        <div class="log-time">${fmt.ago(l.created_at)}</div>
      </div>`).join('') : '<div class="text-muted text-sm">No activity yet.</div>';
    // System health
    const memPct = sys.memTotalMB ? Math.round((sys.memUsedMB||0) / sys.memTotalMB * 100) : 0;
    $('#ov-health').innerHTML = `
      <div style="display:grid;gap:14px">
        <div><div class="flex justify-between mb-1"><span class="text-sm">Heap Memory</span><span class="text-sm font-bold">${memPct}%</span></div><div class="health-bar"><div class="health-fill ${memPct>80?'danger':memPct>60?'warn':''}" style="width:${memPct}%"></div></div></div>
        <div class="flex justify-between" style="font-size:13px"><span class="text-muted">Platform</span><span>${sys.platform||'—'}</span></div>
        <div class="flex justify-between" style="font-size:13px"><span class="text-muted">CPU Cores</span><span>${sys.cpuCount||'—'}</span></div>
        <div class="flex justify-between" style="font-size:13px"><span class="text-muted">Total RAM</span><span>${sys.totalMemGB||'—'}GB</span></div>
        <div class="flex justify-between" style="font-size:13px"><span class="text-muted">Free RAM</span><span>${sys.freeMemGB||'—'}GB</span></div>
      </div>`;
  } catch (e) { toast(e.message, 'error'); }
}

function fmtUptime(s) {
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm';
  if (s < 86400) return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
  return Math.floor(s/86400) + 'd ' + Math.floor((s%86400)/3600) + 'h';
}
function actionColor(a) {
  if (a.includes('LOGIN')) return '#6366f1';
  if (a.includes('DELETE')) return '#ef4444';
  if (a.includes('CREATE') || a.includes('PUBLISH')) return '#10b981';
  if (a.includes('UPDATE') || a.includes('CHANGE')) return '#f59e0b';
  return '#94a3b8';
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — BLOG
// ═══════════════════════════════════════════════════════════════════════════

let _blogPage = 1, _blogStatus = '', _blogSearch = '';
async function renderBlog(sec) {
  sec.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Blog Manager</div><div class="page-sub">Create, edit and publish blog posts.</div></div>
      <div class="page-actions">
        <button class="btn btn-secondary btn-sm" id="manage-cats">Manage Categories</button>
        <button class="btn btn-primary" id="new-post-btn"><svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>New Post</button>
      </div>
    </div>
    <div class="card mb-4">
      <div class="card-body" style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
        <input type="search" id="blog-search" placeholder="Search posts…" style="max-width:240px" value="${esc(_blogSearch)}">
        <select id="blog-status-filter" style="max-width:160px">
          <option value="" ${!_blogStatus?'selected':''}>All statuses</option>
          <option value="published" ${_blogStatus==='published'?'selected':''}>Published</option>
          <option value="draft" ${_blogStatus==='draft'?'selected':''}>Drafts</option>
        </select>
      </div>
    </div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Title</th><th>Status</th><th>Category</th><th>Published</th><th>Updated</th><th class="col-actions">Actions</th></tr></thead><tbody id="blog-tbody"><tr><td colspan="6" style="text-align:center;padding:32px;color:var(--muted)">Loading…</td></tr></tbody></table></div><div class="card-footer flex justify-between items-center"><span class="text-sm text-muted" id="blog-count"></span><div id="blog-pagination"></div></div></div>`;

  $('#new-post-btn').onclick = () => openEditor();
  $('#manage-cats').onclick = () => showCategoryManager();
  $('#blog-search').oninput = debounce(e => { _blogSearch = e.target.value; _blogPage = 1; loadBlogPosts(); }, 300);
  $('#blog-status-filter').onchange = e => { _blogStatus = e.target.value; _blogPage = 1; loadBlogPosts(); };
  await loadBlogPosts();
}

async function loadBlogPosts() {
  try {
    const params = new URLSearchParams({ page: _blogPage, limit: 15 });
    if (_blogStatus) params.set('status', _blogStatus);
    if (_blogSearch) params.set('search', _blogSearch);
    const d = await API.get('/blog/posts?' + params);
    const posts = Array.isArray(d.posts) ? d.posts : [];
    const total = d.total || 0;
    const tbody = $('#blog-tbody');
    if (!tbody) return;
    if (!posts.length) { tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg><h3>No posts found</h3><p>Create your first blog post to get started.</p></div></td></tr>`; return; }
    tbody.innerHTML = posts.map(p => `
      <tr>
        <td><div style="font-weight:600;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.title)}</div><div style="font-size:11px;color:var(--muted)">/blog/${esc(p.slug)}</div></td>
        <td><span class="badge ${p.status==='published'?'badge-green':'badge-gray'}">${p.status}</span></td>
        <td>${esc(p.category_name||'—')}</td>
        <td>${fmt.date(p.published_at)}</td>
        <td>${fmt.ago(p.updated_at)}</td>
        <td class="col-actions">
          <button class="btn btn-ghost btn-xs edit-post" data-id="${p.id}" title="Edit">✏️</button>
          ${p.status==='published'?`<a href="/blog/${p.slug}" target="_blank" class="btn btn-ghost btn-xs" title="View">👁</a>`:''}
          <button class="btn btn-ghost btn-xs del-post" data-id="${p.id}" data-title="${esc(p.title)}" title="Delete">🗑</button>
        </td>
      </tr>`).join('');
    $('#blog-count').textContent = `${total} total post${total!==1?'s':''}`;
    renderPagination('#blog-pagination', total, 15, _blogPage, p => { _blogPage = p; loadBlogPosts(); });
    $$('.edit-post').forEach(b => b.onclick = () => openEditor(b.dataset.id));
    $$('.del-post').forEach(b => b.onclick = async () => {
      const ok = await modal('Delete Post', `<p>Permanently delete <strong>${esc(b.dataset.title)}</strong>? This cannot be undone.</p>`, 'Delete', 'danger');
      if (!ok) return;
      try { await API.delete('/blog/posts/' + b.dataset.id); toast('Post deleted', 'success'); loadBlogPosts(); } catch (e) { toast(e.message, 'error'); }
    });
    const badge = $('#blog-badge');
    if (badge) { badge.style.display = d.total ? '' : 'none'; badge.textContent = d.total; }
  } catch (e) { toast(e.message, 'error'); }
}

async function showCategoryManager() {
  const d = await API.get('/blog/categories');
  const categories = Array.isArray(d.categories) ? d.categories : [];
  const html = `
    <div class="form-group">
      <label class="form-label">New Category</label>
      <div class="input-group">
        <input type="text" id="new-cat-name" placeholder="Category name">
        <button class="btn btn-primary" id="add-cat-btn">Add</button>
      </div>
    </div>
    <div id="cat-list">${categories.map(c=>`
      <div class="flex justify-between items-center" style="padding:8px 0;border-bottom:1px solid var(--border)">
        <div><strong>${esc(c.name)}</strong><span class="text-muted text-sm"> /${c.slug}</span></div>
        <button class="btn btn-ghost btn-xs del-cat" data-id="${c.id}">Remove</button>
      </div>`).join('')}</div>`;
  modal('Manage Categories', html, '', 'secondary');
  $('#modal-footer').style.display = 'none';
  $('#add-cat-btn').onclick = async () => {
    const name = $('#new-cat-name').value.trim();
    if (!name) return;
    try { await API.post('/blog/categories', { name }); toast('Category added', 'success'); showCategoryManager(); } catch (e) { toast(e.message,'error'); }
  };
  $$('.del-cat').forEach(b => b.onclick = async () => {
    await API.delete('/blog/categories/' + b.dataset.id); toast('Removed','success'); showCategoryManager();
  });
}

// Blog editor
let _editingPost = null;
async function openEditor(postId) {
  _editingPost = null;
  const overlay = $('#editor-overlay');
  const editor  = $('#blog-editor');
  // Reset form
  ['post-title','post-slug','post-tags','post-excerpt','post-thumbnail','post-author','post-meta-title','post-meta-desc','post-og-image'].forEach(id => { const el = $(`#${id}`); if(el) el.value=''; });
  $('#post-status').value = 'draft';
  $('#post-featured').checked = false;
  $('#post-category').innerHTML = '<option value="">— None —</option>';
  editor.innerHTML = '';
  $('#editing-post-id').value = '';
  $('#editor-modal-title').textContent = 'New Post';

  // Load categories
  try {
    const cats = await API.get('/blog/categories');
    const categoryList = Array.isArray(cats.categories) ? cats.categories : [];
    categoryList.forEach(c => {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = c.name;
      $('#post-category').append(o);
    });
  } catch {}

  if (postId) {
    try {
      const d = await API.get('/blog/posts/' + postId);
      const p = d.post;
      _editingPost = p;
      $('#editing-post-id').value = p.id;
      $('#editor-modal-title').textContent = 'Edit Post';
      $('#post-title').value     = p.title || '';
      $('#post-slug').value      = p.slug  || '';
      $('#post-status').value    = p.status || 'draft';
      $('#post-featured').checked= !!p.featured;
      $('#post-category').value  = p.category_id || '';
      $('#post-tags').value      = Array.isArray(p.tags) ? p.tags.join(', ') : '';
      $('#post-excerpt').value   = p.excerpt || '';
      $('#post-thumbnail').value = p.thumbnail || '';
      $('#post-author').value    = p.author || 'Admin';
      $('#post-meta-title').value= p.meta_title || '';
      $('#post-meta-desc').value = p.meta_description || '';
      $('#post-og-image').value  = p.og_image || '';
      editor.innerHTML           = p.content || '';
      updateSlugPreview();
    } catch (e) { toast(e.message, 'error'); return; }
  }

  overlay.classList.add('open');
}

function closeEditor() { $('#editor-overlay').classList.remove('open'); }
$('#editor-close').onclick = closeEditor;
$('#editor-overlay').onclick = e => { if (e.target === $('#editor-overlay')) closeEditor(); };

async function savePost(status) {
  const title   = $('#post-title').value.trim();
  const content = $('#blog-editor').innerHTML;
  if (!title) { toast('Title is required', 'error'); return; }
  const tags = $('#post-tags').value.split(',').map(t => t.trim()).filter(Boolean);
  const body = {
    title, content, status,
    slug:             $('#post-slug').value.trim() || slugify(title),
    category_id:      $('#post-category').value || null,
    tags, excerpt:    $('#post-excerpt').value.trim(),
    thumbnail:        $('#post-thumbnail').value.trim(),
    author:           $('#post-author').value.trim() || 'Admin',
    meta_title:       $('#post-meta-title').value.trim(),
    meta_description: $('#post-meta-desc').value.trim(),
    og_image:         $('#post-og-image').value.trim(),
    featured:         $('#post-featured').checked,
  };
  try {
    const id = $('#editing-post-id').value;
    if (id) { await API.put('/blog/posts/' + id, body); toast('Post updated', 'success'); }
    else     { await API.post('/blog/posts', body); toast('Post created', 'success'); }
    closeEditor();
    if (_currentSection === 'blog') loadBlogPosts();
  } catch (e) { toast(e.message, 'error'); }
}

$('#editor-save-draft').onclick = () => savePost('draft');
$('#editor-publish').onclick    = () => savePost('published');

// Auto-slug from title
$('#post-title').oninput = function() {
  if (!$('#editing-post-id').value && !$('#post-slug').value) {
    $('#post-slug').value = slugify(this.value);
  }
  updateSlugPreview();
};
$('#post-slug').oninput = updateSlugPreview;
function updateSlugPreview() {
  const s = $('#slug-preview');
  if (s) s.textContent = $('#post-slug').value || slugify($('#post-title').value) || '…';
}

// SEO counters
$('#post-meta-title').oninput = function() { $('#meta-title-count').textContent = this.value.length; };
$('#post-meta-desc').oninput  = function() { $('#meta-desc-count').textContent  = this.value.length; };

// Rich editor toolbar
$$('#editor-toolbar button').forEach(btn => {
  btn.onclick = () => {
    const cmd = btn.dataset.cmd;
    const ed  = $('#blog-editor');
    ed.focus();
    if (cmd === 'h2') document.execCommand('formatBlock', false, '<h2>');
    else if (cmd === 'h3') document.execCommand('formatBlock', false, '<h3>');
    else if (cmd === 'ul') document.execCommand('insertUnorderedList');
    else if (cmd === 'ol') document.execCommand('insertOrderedList');
    else if (cmd === 'blockquote') document.execCommand('formatBlock', false, '<blockquote>');
    else if (cmd === 'code') { document.execCommand('insertHTML', false, '<code>' + (getSelectionText()||'code') + '</code>'); }
    else if (cmd === 'hr') document.execCommand('insertHTML', false, '<hr>');
    else if (cmd === 'link') {
      const url = prompt('URL:');
      if (url) document.execCommand('createLink', false, url);
    } else if (cmd === 'image') {
      const url = prompt('Image URL:');
      if (url) document.execCommand('insertImage', false, url);
    } else { document.execCommand(cmd); }
    btn.classList.toggle('active', document.queryCommandState && document.queryCommandState(cmd));
  };
});
function getSelectionText() { return window.getSelection ? window.getSelection().toString() : ''; }

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — TOOLS
// ═══════════════════════════════════════════════════════════════════════════

const ALL_TOOLS = [
  {id:'merge',slug:'merge-pdf',name:'Merge PDF',icon:'layers',cat:'Organize'},
  {id:'split',slug:'split-pdf',name:'Split PDF',icon:'scissors',cat:'Organize'},
  {id:'rotate',slug:'rotate-pdf',name:'Rotate PDF',icon:'rotate-cw',cat:'Organize'},
  {id:'crop',slug:'crop-pdf',name:'Crop PDF',icon:'crop',cat:'Organize'},
  {id:'organize',slug:'organize-pdf',name:'Organize PDF',icon:'list-ordered',cat:'Organize'},
  {id:'compress',slug:'compress-pdf',name:'Compress PDF',icon:'archive',cat:'Optimize'},
  {id:'protect',slug:'protect-pdf',name:'Protect PDF',icon:'lock',cat:'Security'},
  {id:'unlock',slug:'unlock-pdf',name:'Unlock PDF',icon:'unlock',cat:'Security'},
  {id:'watermark',slug:'watermark-pdf',name:'Watermark PDF',icon:'droplet',cat:'Edit'},
  {id:'page-numbers',slug:'add-page-numbers',name:'Add Page Numbers',icon:'hash',cat:'Edit'},
  {id:'edit',slug:'edit-pdf',name:'Edit PDF',icon:'edit-3',cat:'Edit'},
  {id:'sign',slug:'sign-pdf',name:'Sign PDF',icon:'pen-tool',cat:'Edit'},
  {id:'redact',slug:'redact-pdf',name:'Redact PDF',icon:'eye-off',cat:'Edit'},
  {id:'pdf-to-jpg',slug:'pdf-to-jpg',name:'PDF to JPG',icon:'image',cat:'Convert'},
  {id:'pdf-to-word',slug:'pdf-to-word',name:'PDF to Word',icon:'file-text',cat:'Convert'},
  {id:'pdf-to-powerpoint',slug:'pdf-to-powerpoint',name:'PDF to PowerPoint',icon:'presentation',cat:'Convert'},
  {id:'pdf-to-excel',slug:'pdf-to-excel',name:'PDF to Excel',icon:'table',cat:'Convert'},
  {id:'word-to-pdf',slug:'word-to-pdf',name:'Word to PDF',icon:'file-text',cat:'Convert'},
  {id:'powerpoint-to-pdf',slug:'powerpoint-to-pdf',name:'PowerPoint to PDF',icon:'presentation',cat:'Convert'},
  {id:'excel-to-pdf',slug:'excel-to-pdf',name:'Excel to PDF',icon:'table',cat:'Convert'},
  {id:'jpg-to-pdf',slug:'jpg-to-pdf',name:'JPG to PDF',icon:'image',cat:'Convert'},
  {id:'html-to-pdf',slug:'html-to-pdf',name:'HTML to PDF',icon:'code',cat:'Convert'},
  {id:'ocr',slug:'ocr-pdf',name:'OCR PDF',icon:'type',cat:'Advanced'},
  {id:'scan-to-pdf',slug:'scan-pdf',name:'Scan PDF',icon:'scan-line',cat:'Advanced'},
  {id:'repair',slug:'repair-pdf',name:'Repair PDF',icon:'wrench',cat:'Advanced'},
  {id:'compare',slug:'compare-pdf',name:'Compare PDF',icon:'git-compare',cat:'Advanced'},
  {id:'ai-summarize',slug:'ai-summarizer',name:'AI Summarizer',icon:'sparkles',cat:'Advanced'},
  {id:'translate',slug:'translate-pdf',name:'Translate PDF',icon:'languages',cat:'Advanced'},
  {id:'background-remover',slug:'background-remover',name:'Background Remover',icon:'image-off',cat:'Image'},
  {id:'crop-image',slug:'crop-image',name:'Crop Image',icon:'crop',cat:'Image'},
  {id:'resize-image',slug:'resize-image',name:'Resize Image',icon:'maximize',cat:'Image'},
  {id:'image-filters',slug:'image-filters',name:'Image Filters',icon:'sliders',cat:'Image'},
  {id:'workflow',slug:'workflow-builder',name:'Workflow Builder',icon:'workflow',cat:'Advanced'},
];

async function renderTools(sec) {
  sec.innerHTML = `<div class="page-header"><div><div class="page-title">Tool Manager</div><div class="page-sub">Control visibility, badges and settings for each tool.</div></div></div><div class="alert alert-info mb-4"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span>Changes here only affect display and visibility. Core PDF processing is never modified.</span></div><div id="tools-loading" style="text-align:center;padding:40px;color:var(--muted)">Loading overrides…</div><div id="tools-grid" class="hidden"></div>`;
  try {
    const d = await API.get('/tools');
    const overrides = d.overrides || {};
    $('#tools-loading').classList.add('hidden');
    const grid = $('#tools-grid');
    grid.classList.remove('hidden');
    const cats = [...new Set(ALL_TOOLS.map(t=>t.cat))];
    grid.innerHTML = cats.map(cat => {
      const tools = ALL_TOOLS.filter(t=>t.cat===cat);
      return `<div class="mb-6"><div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:10px">${cat}</div><div class="tool-grid">${tools.map(t => {
        const ov = overrides[t.id] || {};
        const visible  = ov.visible  != null ? ov.visible  : 1;
        const featured = ov.featured != null ? ov.featured : 0;
        const beta     = ov.beta     != null ? ov.beta     : 0;
        return `<div class="tool-card ${!visible?'disabled':''}" id="tool-card-${t.id}">
          <div class="tool-icon"><svg viewBox="0 0 24 24" width="18" height="18" stroke="var(--accent)" fill="none" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/></svg></div>
          <div class="tool-info">
            <div class="tool-name">${esc(t.name)}</div>
            <div class="tool-meta">${esc(t.cat)} ${beta?'<span class="badge badge-yellow">BETA</span>':''} ${featured?'<span class="badge badge-purple">★</span>':''}</div>
          </div>
          <div class="tool-actions">
            <label class="toggle" title="${visible?'Enabled — click to disable':'Disabled — click to enable'}">
              <input type="checkbox" class="tool-visible-toggle" data-id="${t.id}" ${visible?'checked':''}>
              <div class="toggle-track"><div class="toggle-thumb"></div></div>
            </label>
            <button class="btn btn-ghost btn-xs tool-settings-btn" data-id="${t.id}" data-name="${esc(t.name)}" data-featured="${featured}" data-beta="${beta}" title="Settings">⚙</button>
          </div>
        </div>`;
      }).join('')}</div></div>`;
    }).join('');

    // Visibility toggles
    $$('.tool-visible-toggle').forEach(cb => {
      cb.onchange = async function() {
        const id = this.dataset.id;
        const card = $(`#tool-card-${id}`);
        try {
          const current = overrides[id] || {};
          await API.put('/tools/' + id, { ...current, visible: this.checked ? 1 : 0 });
          if (card) card.classList.toggle('disabled', !this.checked);
          toast(this.checked ? 'Tool enabled' : 'Tool disabled', 'success');
        } catch (e) { toast(e.message, 'error'); this.checked = !this.checked; }
      };
    });
    // Settings button
    $$('.tool-settings-btn').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.id; const name = btn.dataset.name;
        const ov  = overrides[id] || {};
        const html = `
          <div class="form-group"><label class="toggle"><input type="checkbox" id="ts-featured" ${ov.featured?'checked':''}><div class="toggle-track"><div class="toggle-thumb"></div></div><span class="toggle-label">Featured tool</span></label></div>
          <div class="form-group"><label class="toggle"><input type="checkbox" id="ts-beta" ${ov.beta?'checked':''}><div class="toggle-track"><div class="toggle-thumb"></div></div><span class="toggle-label">Mark as Beta</span></label></div>
          <div class="form-group"><label class="form-label">Custom Badge Text</label><input type="text" id="ts-badge" value="${esc(ov.custom_badge||'')}" placeholder="e.g. NEW"></div>
          <div class="form-group"><label class="form-label">Custom Description</label><textarea id="ts-desc" rows="2">${esc(ov.custom_description||'')}</textarea></div>`;
        const ok = await modal(`Settings: ${name}`, html, 'Save', 'primary');
        if (!ok) return;
        try {
          await API.put('/tools/' + id, {
            ...ov,
            featured:          $('#ts-featured').checked ? 1 : 0,
            beta:              $('#ts-beta').checked ? 1 : 0,
            custom_badge:      $('#ts-badge').value.trim(),
            custom_description:$('#ts-desc').value.trim(),
          });
          toast('Tool settings saved', 'success'); renderTools(sec);
        } catch (e) { toast(e.message, 'error'); }
      };
    });
  } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════

// Analytics filter state — persists for the session
const _an = { range:'30', from:'', to:'', tool:'', ua:'' };
// Monotonic counter for analytics renders. Incremented on every loadAnalytics()
// call so concurrent invocations (rapid filter changes, Refresh clicks) can
// detect they have been superseded and bail before writing to the DOM or
// creating duplicate charts.
let _analyticsSeq = 0;

async function renderAnalytics(sec) {
  const today   = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 6*86400000).toISOString().split('T')[0];

  sec.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Analytics</div><div class="page-sub">Privacy-first usage insights.</div></div>
    </div>
    <div class="card mb-4">
      <div class="card-body" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select id="an-range" class="btn btn-secondary btn-sm" style="padding:7px 12px">
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="7">Last 7 days</option>
          <option value="30" selected>Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="custom">Custom range…</option>
        </select>
        <div id="an-custom" style="display:none;gap:6px;align-items:center;flex-wrap:wrap" class="flex">
          <input type="date" id="an-from" class="btn btn-secondary btn-sm" style="padding:6px 10px" value="${weekAgo}">
          <span style="font-size:13px;color:var(--muted,#9ca3af)">→</span>
          <input type="date" id="an-to"   class="btn btn-secondary btn-sm" style="padding:6px 10px" value="${today}">
          <button class="btn btn-primary btn-sm" id="an-apply" style="padding:6px 14px">Apply</button>
        </div>
        <select id="an-ua" class="btn btn-secondary btn-sm" style="padding:7px 12px">
          <option value="">All devices</option>
          <option value="mobile">Mobile only</option>
          <option value="desktop">Desktop only</option>
        </select>
        <select id="an-tool" class="btn btn-secondary btn-sm" style="padding:7px 12px">
          <option value="">All tools</option>
        </select>
        <button class="btn btn-secondary btn-sm" id="an-refresh" style="padding:7px 12px;margin-left:auto" title="Refresh">↻ Refresh</button>
      </div>
    </div>
    <div id="analytics-body"><div style="text-align:center;padding:48px;color:var(--muted,#9ca3af)">Loading analytics…</div></div>`;

  const applyFilters = () => {
    const r = ($('#an-range')||{}).value || '30';
    _an.range = r;
    _an.from  = r === 'custom' ? (($('#an-from')||{}).value || weekAgo) : '';
    _an.to    = r === 'custom' ? (($('#an-to')||{}).value   || today)   : '';
    _an.ua    = ($('#an-ua')||{}).value   || '';
    _an.tool  = ($('#an-tool')||{}).value || '';
    loadAnalytics();
  };

  $('#an-range').onchange = e => {
    const c = $('#an-custom');
    if (c) c.style.display = e.target.value === 'custom' ? 'flex' : 'none';
    if (e.target.value !== 'custom') applyFilters();
  };
  if ($('#an-apply'))   $('#an-apply').onclick   = applyFilters;
  if ($('#an-ua'))      $('#an-ua').onchange      = applyFilters;
  if ($('#an-tool'))    $('#an-tool').onchange     = applyFilters;
  if ($('#an-refresh')) $('#an-refresh').onclick   = applyFilters;

  await loadAnalytics();
}

async function loadAnalytics() {
  // Increment and snapshot the sequence counter.  If a newer call is made
  // while we are awaiting the API, our seq will no longer equal _analyticsSeq
  // and we bail before touching the DOM or creating duplicate charts.
  _analyticsSeq++;
  const seq = _analyticsSeq;

  const body = $('#analytics-body');
  if (!body) return;
  try {
    let url = '/analytics?';
    const r = _an.range;
    if (r === 'today' || r === 'yesterday') {
      url += `range=${r}`;
    } else if (r === 'custom' && _an.from && _an.to) {
      url += `from=${encodeURIComponent(_an.from)}&to=${encodeURIComponent(_an.to)}`;
    } else {
      url += `days=${parseInt(r)||30}`;
    }
    if (_an.tool) url += `&tool=${encodeURIComponent(_an.tool)}`;
    if (_an.ua)   url += `&ua=${encodeURIComponent(_an.ua)}`;

    const d = await API.get(url);

    // Bail if a newer filter-change or Refresh click has already fired.
    if (seq !== _analyticsSeq) return;

    const toolUsage   = Array.isArray(d.toolUsage)   ? d.toolUsage   : [];
    const dailyEvents = Array.isArray(d.dailyEvents)  ? d.dailyEvents  : [];
    const uaBreakdown = Array.isArray(d.uaBreakdown)  ? d.uaBreakdown  : [];
    const totalEvents = d.totalEvents || 0;
    const toolIds     = Array.isArray(d.toolIds)      ? d.toolIds      : [];

    // Populate tool filter dropdown (keep current selection)
    const toolSel = $('#an-tool');
    if (toolSel && toolIds.length) {
      const cur = _an.tool;
      const opts = ['<option value="">All tools</option>',
        ...toolIds.map(id => `<option value="${esc(id)}"${id===cur?' selected':''}>${esc(id)}</option>`)].join('');
      toolSel.innerHTML = opts;
    }

    const mobile  = uaBreakdown.find(u=>u.ua_type==='mobile')?.c  || 0;
    const desktop = uaBreakdown.find(u=>u.ua_type==='desktop')?.c || 0;
    const avgDaily = dailyEvents.length ? Math.round(totalEvents / dailyEvents.length) : 0;

    body.innerHTML = `
      <div class="stat-grid mb-4">
        <div class="stat-card">
          <div class="stat-icon icon-blue"><svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></div>
          <div class="stat-label">Total Events</div>
          <div class="stat-value">${fmt.num(totalEvents)}</div>
          <div class="stat-sub">${dailyEvents.length} active days · avg ${fmt.num(avgDaily)}/day</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon icon-green"><svg viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></div>
          <div class="stat-label">Top Tool</div>
          <div class="stat-value" style="font-size:16px">${esc(toolUsage[0]?.tool_id||'—')}</div>
          <div class="stat-sub">${fmt.num(toolUsage[0]?.c||0)} uses</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon icon-purple"><svg viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg></div>
          <div class="stat-label">Mobile / Desktop</div>
          <div class="stat-value">${fmt.num(mobile)}</div>
          <div class="stat-sub">vs ${fmt.num(desktop)} desktop · ${mobile+desktop ? Math.round(mobile*100/(mobile+desktop)) : 0}% mobile</div>
        </div>
      </div>
      <div class="grid-2 mb-4">
        <div class="card">
          <div class="card-header"><span class="card-title">Daily Events</span></div>
          <div class="card-body"><div class="chart-wrap" style="position:relative;height:200px">
            ${dailyEvents.length ? '<canvas id="chart-daily"></canvas>' : '<div class="text-muted text-sm" style="padding:32px 0;text-align:center">No events in this period.</div>'}
          </div></div>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">Top Tools</span></div>
          <div class="card-body"><div class="chart-wrap" style="position:relative;height:200px">
            ${toolUsage.length ? '<canvas id="chart-tools"></canvas>' : '<div class="text-muted text-sm" style="padding:32px 0;text-align:center">No tool usage recorded yet.</div>'}
          </div></div>
        </div>
      </div>
      <div class="card mb-4">
        <div class="card-header"><span class="card-title">Tool Usage Breakdown</span></div>
        <div class="card-body">
          ${toolUsage.length
            ? toolUsage.map((t,i) => {
                const pct = toolUsage[0]?.c ? Math.round(t.c*100/toolUsage[0].c) : 0;
                return `<div style="margin-bottom:10px">
                  <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                    <span style="font-size:13px;font-weight:500"><span style="color:var(--muted,#9ca3af);font-size:11px;margin-right:6px">${i+1}</span>${esc(t.tool_id||'')}</span>
                    <span class="badge badge-purple">${fmt.num(t.c)}</span>
                  </div>
                  <div style="height:4px;background:var(--border,#e5e7eb);border-radius:2px">
                    <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#6366f1,#8b5cf6);border-radius:2px;transition:width .4s"></div>
                  </div>
                </div>`;
              }).join('')
            : '<div class="text-muted text-sm">No tool usage recorded yet.</div>'}
        </div>
      </div>`;

    // Line chart — Daily Events
    if (window.Chart && dailyEvents.length) {
      const ctx = $('#chart-daily');
      if (ctx) {
        if (ctx._chart) ctx._chart.destroy();
        ctx._chart = new Chart(ctx, {
          type: 'line',
          data: {
            labels: dailyEvents.map(e => e.day),
            datasets: [{ label:'Events', data: dailyEvents.map(e => e.c), borderColor:'#6366f1', backgroundColor:'rgba(99,102,241,.08)', fill:true, tension:.4, pointRadius:3 }]
          },
          options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true,grid:{color:'rgba(0,0,0,.04)'}},x:{grid:{display:false},ticks:{maxTicksLimit:8}}} }
        });
      }
    }

    // Bar chart — Top Tools
    if (window.Chart && toolUsage.length) {
      const ctx = $('#chart-tools');
      if (ctx) {
        if (ctx._chart) ctx._chart.destroy();
        ctx._chart = new Chart(ctx, {
          type: 'bar',
          data: {
            labels: toolUsage.slice(0,8).map(t => t.tool_id||'?'),
            datasets: [{ label:'Uses', data: toolUsage.slice(0,8).map(t => t.c),
              backgroundColor: toolUsage.slice(0,8).map((_,i)=>`hsl(${245+i*18},75%,${60+i*2}%)`) }]
          },
          options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true,grid:{color:'rgba(0,0,0,.04)'}},x:{grid:{display:false}}} }
        });
      }
    }
  } catch (e) {
    // Only show the error if this is still the latest analytics render.
    if (seq !== _analyticsSeq) return;
    if ($('#analytics-body')) $('#analytics-body').innerHTML = `<div class="alert alert-warning"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg> ${esc(e.message)}</div>`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — HOMEPAGE CONTENT
// ═══════════════════════════════════════════════════════════════════════════

async function renderHomepage(sec) {
  sec.innerHTML = `<div class="page-header"><div><div class="page-title">Homepage Content</div><div class="page-sub">Edit homepage text, CTAs and layout without touching code.</div></div></div><div id="homepage-form">Loading…</div>`;
  try {
    const d = await API.get('/config?prefix=site.');
    const c = d.config;
    $('#homepage-form').innerHTML = `
      <div class="card"><div class="card-header"><span class="card-title">Hero Section</span></div><div class="card-body">
        <div class="form-group"><label class="form-label">Site Name</label><input type="text" id="cfg-site.name" value="${esc(c['site.name']||'')}"></div>
        <div class="form-group"><label class="form-label">Tagline</label><input type="text" id="cfg-site.tagline" value="${esc(c['site.tagline']||'')}"></div>
        <div class="form-group"><label class="form-label">Hero Description</label><textarea id="cfg-site.hero_text" rows="3">${esc(c['site.hero_text']||'')}</textarea></div>
        <div class="form-group"><label class="form-label">Footer Text</label><input type="text" id="cfg-site.footer_text" value="${esc(c['site.footer_text']||'')}"></div>
        <div class="form-group"><label class="form-label">Support Email</label><input type="email" id="cfg-site.support_email" value="${esc(c['site.support_email']||'')}"></div>
      </div></div>
      <div style="margin-top:16px;text-align:right"><button class="btn btn-primary" id="save-homepage">Save Homepage Content</button></div>`;
    $('#save-homepage').onclick = () => saveConfigSection('site.', 'Homepage saved!');
  } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — BRANDING
// ═══════════════════════════════════════════════════════════════════════════

async function renderBranding(sec) {
  sec.innerHTML = `<div class="page-header"><div><div class="page-title">Branding</div><div class="page-sub">Update logo, colors and social links.</div></div></div><div id="brand-form">Loading…</div>`;
  try {
    const d = await API.get('/config?prefix=brand.');
    const c = d.config;
    $('#brand-form').innerHTML = `
      <div class="card"><div class="card-header"><span class="card-title">Visual Identity</span></div><div class="card-body">
        <div class="form-group"><label class="form-label">Logo URL</label><input type="url" id="cfg-brand.logo_url" value="${esc(c['brand.logo_url']||'')}"><div class="form-hint">Full URL or relative path e.g. /favicon.svg</div></div>
        <div class="form-group"><label class="form-label">Primary Color</label><div class="color-input-wrap"><div class="color-preview" id="color-preview" style="background:${esc(c['brand.primary_color']||'#6366f1')}" onclick="this.nextElementSibling.click()"></div><input type="color" id="cfg-brand.primary_color" value="${esc(c['brand.primary_color']||'#6366f1')}" oninput="document.getElementById('color-preview').style.background=this.value"></div></div>
        <div class="form-group"><label class="form-label">Founder Name</label><input type="text" id="cfg-brand.founder_name" value="${esc(c['brand.founder_name']||'')}"></div>
        <div class="form-group"><label class="form-label">Founder Image URL</label><input type="url" id="cfg-brand.founder_image" value="${esc(c['brand.founder_image']||'')}"></div>
      </div></div>
      <div class="card" style="margin-top:16px"><div class="card-header"><span class="card-title">Social Links</span></div><div class="card-body">
        <div class="form-row">
          <div class="form-group"><label class="form-label">Twitter / X URL</label><input type="url" id="cfg-brand.twitter_url" value="${esc(c['brand.twitter_url']||'')}"></div>
          <div class="form-group"><label class="form-label">GitHub URL</label><input type="url" id="cfg-brand.github_url" value="${esc(c['brand.github_url']||'')}"></div>
        </div>
        <div class="form-group"><label class="form-label">Buy Me a Coffee URL</label><input type="url" id="cfg-brand.buymeacoffee_url" value="${esc(c['brand.buymeacoffee_url']||'')}"></div>
      </div></div>
      <div style="margin-top:16px;text-align:right"><button class="btn btn-primary" id="save-branding">Save Branding</button></div>`;
    $('#save-branding').onclick = () => saveConfigSection('brand.', 'Branding saved!');
  } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7 — MEDIA
// ═══════════════════════════════════════════════════════════════════════════

let _mediaPage = 1;
async function renderMedia(sec) {
  sec.innerHTML = `<div class="page-header"><div><div class="page-title">Media Library</div><div class="page-sub">Upload and manage images for your blog and site.</div></div></div>
    <div class="card mb-4"><div class="card-body">
      <div class="upload-zone" id="upload-zone">
        <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        <p><strong>Click to upload</strong> or drag and drop</p>
        <p style="font-size:12px;margin-top:4px">JPEG, PNG, GIF, WebP, SVG — max 10MB</p>
        <input type="file" id="media-file-input" accept="image/*" multiple style="display:none">
      </div>
    </div></div>
    <div class="card"><div class="card-header"><span class="card-title">Uploaded Images</span><span class="text-muted text-sm" id="media-count"></span></div><div class="card-body"><div class="media-grid" id="media-grid"><div class="text-muted text-sm">Loading…</div></div></div><div class="card-footer"><div id="media-pagination"></div></div></div>`;

  const zone  = $('#upload-zone');
  const input = $('#media-file-input');
  zone.onclick  = () => input.click();
  zone.ondragover = e => { e.preventDefault(); zone.classList.add('drag'); };
  zone.ondragleave  = () => zone.classList.remove('drag');
  zone.ondrop = e => { e.preventDefault(); zone.classList.remove('drag'); uploadFiles(e.dataTransfer.files); };
  input.onchange = () => uploadFiles(input.files);

  async function uploadFiles(files) {
    for (const file of files) {
      const fd = new FormData(); fd.append('file', file);
      try { await API.upload('/media/upload', fd); toast(file.name + ' uploaded', 'success'); } catch(e) { toast(e.message, 'error'); }
    }
    loadMedia();
  }
  await loadMedia();

  async function loadMedia() {
    const grid = $('#media-grid'); if(!grid) return;
    try {
      const d = await API.get('/media?page=' + _mediaPage + '&limit=30');
      $('#media-count').textContent = d.total + ' files';
      if (!d.files.length) { grid.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg><h3>No media yet</h3><p>Upload images to use in your blog posts.</p></div>'; return; }
      grid.innerHTML = d.files.map(f => `<div class="media-item" data-id="${f.id}" data-url="${esc(f.url)}">
        <img src="${esc(f.url)}" alt="${esc(f.alt_text||f.original_name)}" loading="lazy">
        <button class="del-btn" data-id="${f.id}">✕</button>
        <div class="media-item-info"><div class="media-item-name">${esc(f.original_name||f.filename)}</div><div class="media-item-size">${fmt.bytes(f.size||0)}</div></div>
      </div>`).join('');
      $$('.del-btn').forEach(b => b.onclick = async (e) => {
        e.stopPropagation();
        const ok = await modal('Delete File', '<p>Permanently delete this file?</p>', 'Delete', 'danger');
        if (!ok) return;
        try { await API.delete('/media/' + b.dataset.id); toast('Deleted','success'); loadMedia(); } catch(e){toast(e.message,'error');}
      });
      $$('.media-item').forEach(m => m.onclick = () => {
        const url = m.dataset.url;
        if (navigator.clipboard) { navigator.clipboard.writeText(url); toast('URL copied!', 'success'); }
      });
      renderPagination('#media-pagination', d.total, 30, _mediaPage, p => { _mediaPage=p; loadMedia(); });
    } catch(e) { toast(e.message,'error'); }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8 — ANNOUNCEMENTS
// ═══════════════════════════════════════════════════════════════════════════

async function renderAnnouncements(sec) {
  sec.innerHTML = `<div class="page-header"><div><div class="page-title">Announcements</div><div class="page-sub">Show site-wide banners to your visitors.</div></div><div class="page-actions"><button class="btn btn-primary" id="new-ann-btn"><svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>New Announcement</button></div></div><div class="card"><div class="table-wrap"><table><thead><tr><th>Message</th><th>Type</th><th>Active</th><th class="col-actions">Actions</th></tr></thead><tbody id="ann-tbody"><tr><td colspan="4" style="text-align:center;padding:24px;color:var(--muted)">Loading…</td></tr></tbody></table></div></div>`;
  async function load() {
    try {
      const d = await API.get('/announcements');
      const tbody = $('#ann-tbody'); if (!tbody) return;
      if (!d.announcements.length) { tbody.innerHTML = '<tr><td colspan="4"><div class="empty-state"><svg viewBox="0 0 24 24"><path d="M22 17H2a3 3 0 0 0 3-3V9a7 7 0 0 1 14 0v5a3 3 0 0 0 3 3z"/></svg><h3>No announcements</h3><p>Add a banner to display across your site.</p></div></td></tr>'; return; }
      tbody.innerHTML = d.announcements.map(a => `
        <tr>
          <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${esc(a.message)}</td>
          <td><span class="badge badge-${a.type==='info'?'blue':a.type==='warning'?'yellow':a.type==='success'?'green':'red'}">${a.type}</span></td>
          <td><label class="toggle"><input type="checkbox" class="ann-active" data-id="${a.id}" ${a.active?'checked':''}><div class="toggle-track"><div class="toggle-thumb"></div></div></label></td>
          <td class="col-actions"><button class="btn btn-ghost btn-xs del-ann" data-id="${a.id}">🗑</button></td>
        </tr>`).join('');
      $$('.ann-active').forEach(cb => cb.onchange = async function() {
        try { await API.put('/announcements/' + this.dataset.id, { active: this.checked }); toast(this.checked?'Announcement enabled':'Announcement disabled','success'); } catch(e){toast(e.message,'error');}
      });
      $$('.del-ann').forEach(b => b.onclick = async () => {
        const ok = await modal('Delete Announcement','<p>Remove this announcement?</p>','Delete','danger');
        if (!ok) return;
        try { await API.delete('/announcements/'+b.dataset.id); toast('Removed','success'); load(); } catch(e){toast(e.message,'error');}
      });
    } catch(e) { toast(e.message,'error'); }
  }
  $('#new-ann-btn').onclick = async () => {
    const html = `<div class="form-group"><label class="form-label">Message</label><textarea id="ann-message" rows="3" placeholder="Your announcement text…"></textarea></div><div class="form-group"><label class="form-label">Type</label><select id="ann-type"><option value="info">Info</option><option value="warning">Warning</option><option value="success">Success</option><option value="error">Alert</option></select></div>`;
    const ok = await modal('New Announcement', html, 'Create', 'primary');
    if (!ok) return;
    const msg = $('#ann-message').value.trim();
    if (!msg) { toast('Message required','error'); return; }
    try { await API.post('/announcements',{message:msg,type:$('#ann-type').value}); toast('Announcement created','success'); load(); } catch(e){toast(e.message,'error');}
  };
  await load();
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 9 — SEO
// ═══════════════════════════════════════════════════════════════════════════

async function renderSEO(sec) {
  sec.innerHTML = `<div class="page-header"><div><div class="page-title">SEO Panel</div><div class="page-sub">Global metadata, sitemap, and search engine settings.</div></div></div><div id="seo-form">Loading…</div>`;
  try {
    const d = await API.get('/config?prefix=seo.');
    const c = d.config;
    $('#seo-form').innerHTML = `
      <div class="card mb-4"><div class="card-header"><span class="card-title">Global Meta Tags</span></div><div class="card-body">
        <div class="form-group"><label class="form-label">Global Title</label><input type="text" id="cfg-seo.global_title" value="${esc(c['seo.global_title']||'')}"><div class="form-hint"><span id="seo-title-len">${(c['seo.global_title']||'').length}</span>/60 chars</div></div>
        <div class="form-group"><label class="form-label">Global Description</label><textarea id="cfg-seo.global_description" rows="3">${esc(c['seo.global_description']||'')}</textarea><div class="form-hint"><span id="seo-desc-len">${(c['seo.global_description']||'').length}</span>/160 chars</div></div>
        <div class="form-group"><label class="form-label">Default OG Image URL</label><input type="url" id="cfg-seo.og_image" value="${esc(c['seo.og_image']||'')}"></div>
      </div></div>
      <div class="card mb-4"><div class="card-header"><span class="card-title">Analytics & Verification</span></div><div class="card-body">
        <div class="form-row">
          <div class="form-group"><label class="form-label">Google Analytics ID</label><input type="text" id="cfg-seo.google_analytics_id" value="${esc(c['seo.google_analytics_id']||'')}" placeholder="G-XXXXXXXXXX"></div>
          <div class="form-group"><label class="form-label">Search Console Verification</label><input type="text" id="cfg-seo.google_search_console" value="${esc(c['seo.google_search_console']||'')}" placeholder="meta tag content"></div>
        </div>
      </div></div>
      <div class="card mb-4"><div class="card-header"><span class="card-title">Sitemap & Robots</span></div><div class="card-body">
        <div class="flex gap-3">
          <a href="/sitemap.xml" target="_blank" class="btn btn-secondary btn-sm">View Sitemap</a>
          <a href="/robots.txt" target="_blank" class="btn btn-secondary btn-sm">View Robots.txt</a>
        </div>
        <div class="alert alert-info mt-3"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span>Sitemap and robots.txt are auto-generated from your tools and blog posts.</span></div>
      </div></div>
      <div style="text-align:right"><button class="btn btn-primary" id="save-seo">Save SEO Settings</button></div>`;
    $('#cfg-seo.global_title').oninput = function(){ $('#seo-title-len').textContent = this.value.length; };
    $('#cfg-seo.global_description').oninput = function(){ $('#seo-desc-len').textContent = this.value.length; };
    $('#save-seo').onclick = () => saveConfigSection('seo.', 'SEO settings saved!');
  } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 10 — ADS
// ═══════════════════════════════════════════════════════════════════════════

async function renderAds(sec) {
  sec.innerHTML = `<div class="page-header"><div><div class="page-title">Ads & Monetization</div><div class="page-sub">Manage ad slots across your site.</div></div></div><div id="ads-form">Loading…</div>`;
  try {
    const d = await API.get('/config?prefix=ads.');
    const c = d.config;
    const enabled = c['ads.enabled'];
    $('#ads-form').innerHTML = `
      <div class="card mb-4"><div class="card-header"><span class="card-title">Global Ad Settings</span></div><div class="card-body">
        <div class="form-group"><label class="toggle"><input type="checkbox" id="cfg-ads.enabled" ${enabled?'checked':''}><div class="toggle-track"><div class="toggle-thumb"></div></div><span class="toggle-label">Enable ads globally</span></label><div class="form-hint">When disabled, no ad slots are injected anywhere on the site.</div></div>
        <div class="form-group"><label class="form-label">Google AdSense Client ID</label><input type="text" id="cfg-ads.adsense_client" value="${esc(c['ads.adsense_client']||'')}" placeholder="ca-pub-XXXXXXXXXXXXXXXX"></div>
      </div></div>
      <div class="card mb-4"><div class="card-header"><span class="card-title">Ad Slots</span></div><div class="card-body">
        <div class="form-row">
          <div class="form-group"><label class="form-label">Homepage Slot ID</label><input type="text" id="cfg-ads.homepage_slot" value="${esc(c['ads.homepage_slot']||'')}" placeholder="AdSense slot ID"></div>
          <div class="form-group"><label class="form-label">Sidebar Slot ID</label><input type="text" id="cfg-ads.sidebar_slot" value="${esc(c['ads.sidebar_slot']||'')}" placeholder="AdSense slot ID"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label class="form-label">In-Content Slot ID</label><input type="text" id="cfg-ads.in_content_slot" value="${esc(c['ads.in_content_slot']||'')}" placeholder="AdSense slot ID"></div>
          <div class="form-group"><label class="form-label">Footer Slot ID</label><input type="text" id="cfg-ads.footer_slot" value="${esc(c['ads.footer_slot']||'')}" placeholder="AdSense slot ID"></div>
        </div>
      </div></div>
      <div class="alert alert-warning mb-4"><svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span>Ads are injected via the public widget script. They never interfere with PDF processing tools.</span></div>
      <div style="text-align:right"><button class="btn btn-primary" id="save-ads">Save Ad Settings</button></div>`;
    $('#save-ads').onclick = () => saveConfigSection('ads.', 'Ad settings saved!');
  } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 11 — DONATIONS
// ═══════════════════════════════════════════════════════════════════════════

async function renderDonations(sec) {
  sec.innerHTML = `<div class="page-header"><div><div class="page-title">Donations</div><div class="page-sub">Manage your support / donate button.</div></div></div><div id="donate-form">Loading…</div>`;
  try {
    const d = await API.get('/config?prefix=donate.');
    const c = d.config;
    $('#donate-form').innerHTML = `
      <div class="card"><div class="card-header"><span class="card-title">Donation Settings</span></div><div class="card-body">
        <div class="form-group"><label class="toggle"><input type="checkbox" id="cfg-donate.enabled" ${c['donate.enabled']?'checked':''}><div class="toggle-track"><div class="toggle-thumb"></div></div><span class="toggle-label">Show donate button in navigation</span></label></div>
        <div class="form-group"><label class="form-label">Donation URL</label><input type="url" id="cfg-donate.url" value="${esc(c['donate.url']||'')}" placeholder="https://buymeacoffee.com/yourname"></div>
        <div class="form-group"><label class="form-label">Button / Banner Message</label><input type="text" id="cfg-donate.message" value="${esc(c['donate.message']||'')}" placeholder="Support the project!"></div>
      </div></div>
      <div style="margin-top:16px;text-align:right"><button class="btn btn-primary" id="save-donate">Save</button></div>`;
    $('#save-donate').onclick = () => saveConfigSection('donate.', 'Donation settings saved!');
  } catch (e) { toast(e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 12 — SYSTEM HEALTH
// ═══════════════════════════════════════════════════════════════════════════

async function renderHealth(sec) {
  sec.innerHTML = `<div class="page-header"><div><div class="page-title">System Health</div><div class="page-sub">Real-time server and application diagnostics.</div></div><div class="page-actions"><button class="btn btn-secondary btn-sm" id="refresh-health">Refresh</button></div></div><div id="health-body"><div style="text-align:center;padding:40px;color:var(--muted)">Loading health data…</div></div>`;
  $('#refresh-health').onclick = () => renderHealth(sec);
  try {
    const d = await API.get('/health');
    const memory       = d.memory   || {};
    const osInfo       = d.os       || {};
    const dbInfo       = d.db       || {};
    const uploads      = d.uploads  || {};
    const recentErrors = Array.isArray(d.recentErrors) ? d.recentErrors : [];
    const loadAvg      = Array.isArray(osInfo.loadAvg) ? osInfo.loadAvg : [];
    const memPct   = memory.heapTotalMB   ? Math.round((memory.heapUsedMB||0)   / memory.heapTotalMB   * 100) : 0;
    const totalGB  = parseFloat(osInfo.totalMemGB) || 0;
    const freeGB   = parseFloat(osInfo.freeMemGB)  || 0;
    const osMemPct = totalGB ? Math.round((1 - freeGB / totalGB) * 100) : 0;
    $('#health-body').innerHTML = `
      <div class="stat-grid mb-4">
        <div class="stat-card"><div class="stat-icon ${memPct>80?'icon-red':memPct>60?'icon-yellow':'icon-green'}"><svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></div><div class="stat-label">Heap Memory</div><div class="stat-value">${memory.heapUsedMB||0}MB</div><div class="stat-sub">of ${memory.heapTotalMB||0}MB (${memPct}%)</div></div>
        <div class="stat-card"><div class="stat-icon icon-blue"><svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/></svg></div><div class="stat-label">RSS Memory</div><div class="stat-value">${memory.rssMB||0}MB</div><div class="stat-sub">Process total</div></div>
        <div class="stat-card"><div class="stat-icon icon-purple"><svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg></div><div class="stat-label">Database</div><div class="stat-value">${dbInfo.sizeMB||0}MB</div><div class="stat-sub">${dbInfo.users||0} users · ${dbInfo.posts||0} posts</div></div>
        <div class="stat-card"><div class="stat-icon icon-yellow"><svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div><div class="stat-label">Uploads Dir</div><div class="stat-value">${uploads.count||0}</div><div class="stat-sub">${uploads.sizeMB||0}MB on disk</div></div>
      </div>
      <div class="grid-2 mb-4">
        <div class="card"><div class="card-header"><span class="card-title">Server Info</span></div><div class="card-body" style="display:grid;gap:12px">
          <div><div class="flex justify-between mb-1"><span class="text-sm">Heap Memory</span><span class="text-sm font-bold">${memPct}%</span></div><div class="health-bar"><div class="health-fill ${memPct>80?'danger':memPct>60?'warn':''}" style="width:${memPct}%"></div></div></div>
          <div><div class="flex justify-between mb-1"><span class="text-sm">System RAM Used</span><span class="text-sm font-bold">${osMemPct}%</span></div><div class="health-bar"><div class="health-fill ${osMemPct>80?'danger':osMemPct>60?'warn':''}" style="width:${osMemPct}%"></div></div></div>
          <div class="flex justify-between text-sm"><span class="text-muted">Platform</span><span>${osInfo.platform||'—'}</span></div>
          <div class="flex justify-between text-sm"><span class="text-muted">Node.js</span><span>${osInfo.nodeVersion||'—'}</span></div>
          <div class="flex justify-between text-sm"><span class="text-muted">CPU Cores</span><span>${osInfo.cpus||'—'}</span></div>
          <div class="flex justify-between text-sm"><span class="text-muted">Load Average</span><span>${loadAvg.length ? loadAvg.join(' ') : '—'}</span></div>
          <div class="flex justify-between text-sm"><span class="text-muted">Total RAM</span><span>${osInfo.totalMemGB||'—'}GB</span></div>
          <div class="flex justify-between text-sm"><span class="text-muted">Free RAM</span><span>${osInfo.freeMemGB||'—'}GB</span></div>
          <div class="flex justify-between text-sm"><span class="text-muted">Uptime</span><span>${fmtUptime(d.uptime||0)}</span></div>
        </div></div>
        <div class="card"><div class="card-header"><span class="card-title">Service Status</span></div><div class="card-body" style="display:grid;gap:12px">
          ${serviceRow('Express Server', true)}
          ${serviceRow('SQLite Database', true)}
          ${serviceRow('File Uploads', true)}
          ${serviceRow('Cloudflare R2', false, 'Optional — not configured')}
          ${serviceRow('Firebase Auth', false, 'Optional — not configured')}
          ${serviceRow('HuggingFace AI', false, 'Optional — not configured')}
        </div></div>
      </div>
      ${recentErrors.length ? `<div class="card"><div class="card-header"><span class="card-title">Recent Errors</span></div><div class="card-body">${recentErrors.map(e=>`<div class="log-item"><div class="log-dot" style="background:var(--danger)"></div><div class="log-content"><div class="log-action">${esc(e.action||'')}</div><div class="log-meta">${esc(e.details||'')}</div></div><div class="log-time">${fmt.ago(e.created_at)}</div></div>`).join('')}</div></div>` : ''}`;
  } catch(e) { toast(e.message,'error'); }
}
function serviceRow(name, ok, note='') {
  return `<div class="flex justify-between items-center"><div><span class="text-sm font-bold">${esc(name)}</span>${note?`<div class="text-sm text-muted">${esc(note)}</div>`:''}</div><span class="badge ${ok?'badge-green':'badge-gray'}">${ok?'✓ Online':'— Off'}</span></div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 13 — AUDIT LOGS
// ═══════════════════════════════════════════════════════════════════════════

let _logsPage = 1;
async function renderLogs(sec) {
  sec.innerHTML = `<div class="page-header"><div><div class="page-title">Audit Logs</div><div class="page-sub">Track all admin actions.</div></div></div><div class="card"><div class="table-wrap"><table><thead><tr><th>Action</th><th>Details</th><th>IP</th><th>Time</th></tr></thead><tbody id="logs-tbody"><tr><td colspan="4" style="text-align:center;padding:32px;color:var(--muted)">Loading…</td></tr></tbody></table></div><div class="card-footer"><div id="logs-pagination"></div></div></div>`;
  try {
    const d = await API.get('/logs?page=' + _logsPage + '&limit=50');
    const tbody = $('#logs-tbody'); if (!tbody) return;
    if (!d.logs.length) { tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:32px;color:var(--muted)">No logs yet.</td></tr>'; return; }
    tbody.innerHTML = d.logs.map(l => `
      <tr>
        <td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${actionColor(l.action)};margin-right:8px"></span>${esc(l.action.replace(/_/g,' '))}</td>
        <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.details||'—')}</td>
        <td style="font-family:monospace;font-size:12px">${esc(l.ip||'—')}</td>
        <td><span title="${fmt.time(l.created_at)}">${fmt.ago(l.created_at)}</span></td>
      </tr>`).join('');
    renderPagination('#logs-pagination', d.total, 50, _logsPage, p => { _logsPage=p; renderLogs(sec); });
  } catch(e) { toast(e.message,'error'); }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 14 — SETTINGS (Feature Flags)
// ═══════════════════════════════════════════════════════════════════════════

async function renderSettings(sec) {
  sec.innerHTML = `<div class="page-header"><div><div class="page-title">Settings</div><div class="page-sub">Feature flags, maintenance mode, and site-wide toggles.</div></div></div><div id="settings-body">Loading…</div>`;
  try {
    const d = await API.get('/feature-flags');
    const flags = Array.isArray(d.flags) ? d.flags : [];
    const maintenanceFlag = flags.find(f => f.key === 'maintenance_mode');
    $('#settings-body').innerHTML = `
      ${maintenanceFlag?.enabled ? '<div class="alert alert-warning mb-4"><svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg><strong>Maintenance mode is ON.</strong> Your site is currently showing a maintenance page to visitors.</div>' : ''}
      <div class="card mb-4"><div class="card-header"><span class="card-title">Feature Flags</span><button class="btn btn-primary btn-sm" id="add-flag-btn">+ Add Flag</button></div><div class="card-body" id="flags-list">Loading flags…</div></div>
      <div class="card mb-4"><div class="card-header"><span class="card-title">Change Admin Password</span></div><div class="card-body">
        <div class="form-row"><div class="form-group"><label class="form-label">Current Password</label><input type="password" id="cur-pw" placeholder="Current password"></div><div class="form-group"><label class="form-label">New Password</label><input type="password" id="new-pw" placeholder="Min 10 chars, mixed case + symbol"></div></div>
        <button class="btn btn-secondary btn-sm" id="change-pw-btn">Update Password</button>
      </div></div>`;

    renderFlagsList(flags);

    $('#add-flag-btn').onclick = async () => {
      const html = `<div class="form-group"><label class="form-label">Flag Key (e.g. new_feature)</label><input type="text" id="flag-key" placeholder="flag_key"></div><div class="form-group"><label class="form-label">Description</label><input type="text" id="flag-desc" placeholder="What does this flag do?"></div>`;
      const ok = await modal('New Feature Flag', html, 'Create', 'primary');
      if (!ok) return;
      const key = $('#flag-key').value.trim().replace(/\s+/g,'_');
      if (!key) { toast('Key required','error'); return; }
      try { await API.post('/feature-flags',{key,enabled:false,description:$('#flag-desc').value.trim()}); toast('Flag created','success'); renderSettings(sec); } catch(e){toast(e.message,'error');}
    };
    $('#change-pw-btn').onclick = async () => {
      const cur = $('#cur-pw').value; const nw = $('#new-pw').value;
      if (!cur || !nw) { toast('Both fields required','error'); return; }
      try { await API.post('/auth/change-password',{currentPassword:cur,newPassword:nw}); toast('Password updated! Please log in again.','success'); setTimeout(()=>window.location.href='/admin/login',2000); } catch(e){toast(e.message,'error');}
    };
  } catch(e) { toast(e.message,'error'); }
}

function renderFlagsList(flags) {
  const list = $('#flags-list'); if (!list) return;
  const safeFlags = Array.isArray(flags) ? flags : [];
  if (!safeFlags.length) { list.innerHTML = '<div class="text-muted text-sm">No feature flags.</div>'; return; }
  flags = safeFlags;
  list.innerHTML = flags.map(f => `
    <div class="flex justify-between items-center" style="padding:10px 0;border-bottom:1px solid var(--border)">
      <div><div style="font-weight:600;font-size:13px">${esc(f.key)}</div><div class="text-sm text-muted">${esc(f.description||'')}</div></div>
      <label class="toggle"><input type="checkbox" class="flag-toggle" data-key="${f.key}" ${f.enabled?'checked':''}><div class="toggle-track"><div class="toggle-thumb"></div></div></label>
    </div>`).join('');
  $$('.flag-toggle').forEach(cb => cb.onchange = async function() {
    const updates = {}; updates[this.dataset.key] = this.checked;
    try { await API.put('/feature-flags', updates); toast(`Flag "${this.dataset.key}" ${this.checked?'enabled':'disabled'}`, 'success'); } catch(e){toast(e.message,'error'); this.checked=!this.checked;}
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 15 — BACKUP
// ═══════════════════════════════════════════════════════════════════════════

async function renderBackup(sec) {
  sec.innerHTML = `<div class="page-header"><div><div class="page-title">Backup & Export</div><div class="page-sub">Export and import your content, settings, and configuration.</div></div></div>
    <div class="grid-2">
      <div class="card"><div class="card-header"><span class="card-title">Export Backup</span></div><div class="card-body">
        <p class="text-sm text-muted mb-4">Download a complete backup of all blog posts, settings, feature flags, tool overrides, and announcements as a JSON file.</p>
        <button class="btn btn-primary" id="export-btn"><svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><polyline points="21 15 21 21 3 21 3 15"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download Backup</button>
      </div></div>
      <div class="card"><div class="card-header"><span class="card-title">Import Backup</span></div><div class="card-body">
        <p class="text-sm text-muted mb-4">Restore settings and content from a previously exported backup file. Existing data is preserved (import is additive).</p>
        <div class="upload-zone" id="import-zone" style="padding:20px">
          <svg viewBox="0 0 24 24" width="24" height="24"><polyline points="21 15 21 21 3 21 3 15"/><polyline points="7 10 12 5 17 10"/><line x1="12" y1="5" x2="12" y2="17"/></svg>
          <p style="font-size:13px"><strong>Click to select</strong> backup JSON file</p>
          <input type="file" id="import-input" accept=".json" style="display:none">
        </div>
      </div></div>
    </div>`;
  $('#export-btn').onclick = () => {
    window.open('/api/admin/backup/export', '_blank');
    toast('Backup download started', 'success');
  };
  const importZone = $('#import-zone'); const importInput = $('#import-input');
  importZone.onclick = () => importInput.click();
  importInput.onchange = async () => {
    const file = importInput.files[0]; if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const ok = await modal('Import Backup', `<p>Import backup from <strong>${esc(data.exportedAt)}</strong>?</p><p class="text-sm text-muted mt-2">This will add ${(data.posts||[]).length} posts, ${(data.config||[]).length} config items, and ${(data.flags||[]).length} flags. Existing data is kept.</p>`, 'Import', 'primary');
      if (!ok) return;
      await API.post('/backup/import', data);
      toast('Backup imported successfully!', 'success');
    } catch(e) { toast('Import failed: ' + e.message, 'error'); }
    importInput.value = '';
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════════════

async function saveConfigSection(prefix, successMsg) {
  const inputs = $$(`[id^="cfg-${prefix}"]`);
  if (!inputs.length) { toast('No fields found', 'error'); return; }
  const updates = {};
  inputs.forEach(el => {
    const key = el.id.replace('cfg-', '');
    updates[key] = el.type === 'checkbox' ? el.checked : el.value;
  });
  try { await API.put('/config', updates); toast(successMsg, 'success'); } catch(e) { toast(e.message, 'error'); }
}

function renderPagination(sel, total, limit, current, onChange) {
  const container = $(sel); if (!container) return;
  const pages = Math.ceil(total / limit);
  if (pages <= 1) { container.innerHTML = ''; return; }
  let html = '';
  if (current > 1) html += `<button class="page-btn" data-p="${current-1}">‹</button>`;
  for (let i = Math.max(1, current-2); i <= Math.min(pages, current+2); i++) {
    html += `<button class="page-btn ${i===current?'active':''}" data-p="${i}">${i}</button>`;
  }
  if (current < pages) html += `<button class="page-btn" data-p="${current+1}">›</button>`;
  container.innerHTML = html;
  $$('.page-btn', container).forEach(b => b.onclick = () => onChange(parseInt(b.dataset.p)));
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ═══════════════════════════════════════════════════════════════════════════
// TOPBAR NEW POST BUTTON
// ═══════════════════════════════════════════════════════════════════════════

$('#topbar-new-post').onclick = () => {
  navigate('blog');
  setTimeout(() => openEditor(), 100);
};

// ═══════════════════════════════════════════════════════════════════════════
// SIDEBAR NAV WIRING
// ═══════════════════════════════════════════════════════════════════════════

$$('.nav-item[data-section]').forEach(item => {
  item.onclick = () => {
    navigate(item.dataset.section);
    // Auto-close on mobile
    if (window.innerWidth < 768) $('#sidebar').classList.remove('open');
  };
});

// Mobile menu toggle
$('#menu-toggle').onclick = () => $('#sidebar').classList.toggle('open');
document.addEventListener('click', e => {
  if (window.innerWidth < 768 && !$('#sidebar').contains(e.target) && !$('#menu-toggle').contains(e.target)) {
    $('#sidebar').classList.remove('open');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// LOGOUT
// ═══════════════════════════════════════════════════════════════════════════

$('#logout-btn').onclick = async () => {
  const ok = await modal('Sign Out', '<p>Are you sure you want to sign out of the admin panel?</p>', 'Sign Out', 'danger');
  if (!ok) return;
  await fetch('/api/admin/auth/logout', { method:'POST', credentials:'include' }).catch(()=>{});
  window.location.href = '/admin/login';
};

// ═══════════════════════════════════════════════════════════════════════════
// LOAD CHART.JS
// ═══════════════════════════════════════════════════════════════════════════

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════

async function boot() {
  // Load Chart.js lazily
  loadScript('https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js').catch(()=>{});

  // Check session
  try {
    const d = await API.get('/auth/me');
    const name = d.username || 'Admin';
    const el = $('#user-name'); if (el) el.textContent = name;
    const av = $('#user-avatar'); if (av) av.textContent = name[0].toUpperCase();
  } catch { return; }

  // Hash-based routing
  const hash = location.hash.replace('#','') || 'overview';
  navigate(hash);

  window.addEventListener('popstate', e => {
    navigate(e.state?.section || location.hash.replace('#','') || 'overview');
  });

  // Track analytics: page view on navigation
  window._trackEvent = (event, toolId) => {
    fetch('/api/admin/analytics/event', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ event, tool_id: toolId, path: location.pathname }),
      credentials: 'include',
    }).catch(()=>{});
  };
}

boot();
