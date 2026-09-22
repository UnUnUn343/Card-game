'use strict';
/* Launcher screen. All data comes from the main process through window.launcher (preload). */
(() => {
  const api = window.launcher;
  const $ = id => document.getElementById(id);

  let snap = null;          // launcherSnapshot() from main
  let upd = null;           // UpdateService state
  let starting = false;

  const t = (key, ...args) => {
    const dict = window.I18N[(snap && snap.lang) || 'uk'] || window.I18N.uk;
    const v = dict[key] ?? window.I18N.uk[key] ?? key;
    return typeof v === 'function' ? v(...args) : v;
  };

  // ── small helpers ──────────────────────────────────────────────────────────────────────
  const cmp = (a, b) => {
    const p = v => (String(v || '').replace(/^v/i, '').match(/^\d+(?:\.\d+)*/) || [''])[0].split('.').filter(Boolean).map(Number);
    const x = p(a), y = p(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
    return 0;
  };
  const vName = b => (b ? (b.version ? `v${b.version}` : b.label || '?') : '—');
  const mb = n => `${(n / 1048576).toFixed(1)} ${snap.lang === 'uk' ? 'МБ' : 'MB'}`;
  const locale = () => (snap.lang === 'uk' ? 'uk-UA' : 'en-GB');
  const time = iso => new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  const day = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' }); };
  const pct = p => (p && p.total ? Math.min(100, Math.round((100 * p.received) / p.total)) : 0);
  const active = () => snap && snap.builds.find(b => b.id === snap.activeId);

  let toastTimer = null;
  function toast(msg, isErr = false) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('err', isErr);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isErr ? 7000 : 3500);
  }

  /** Release notes are plain text with a little markdown: "- item", "## heading", **bold**. Built as DOM, never innerHTML. */
  function renderNotes(container, text) {
    container.textContent = '';
    if (!text || !text.trim()) {
      const p = document.createElement('p');
      p.className = 'news-empty';
      p.textContent = t('noNotes');
      container.appendChild(p);
      return;
    }
    const inline = (el, s) => {
      s.split(/(\*\*[^*]+\*\*)/g).forEach(part => {
        if (/^\*\*[^*]+\*\*$/.test(part)) { const b = document.createElement('strong'); b.textContent = part.slice(2, -2); el.appendChild(b); }
        else if (part) el.appendChild(document.createTextNode(part));
      });
    };
    let list = null;
    for (const raw of text.replace(/\r/g, '').split('\n')) {
      const line = raw.trim();
      if (!line) { list = null; continue; }
      const item = line.match(/^[-*•]\s+(.*)$/);
      const head = line.match(/^#{1,4}\s+(.*)$/);
      if (item) {
        if (!list) { list = document.createElement('ul'); container.appendChild(list); }
        const li = document.createElement('li'); inline(li, item[1]); list.appendChild(li);
      } else if (head) {
        list = null; const h = document.createElement('h4'); inline(h, head[1]); container.appendChild(h);
      } else {
        list = null; const p = document.createElement('p'); inline(p, line); container.appendChild(p);
      }
    }
  }

  // ── rendering ──────────────────────────────────────────────────────────────────────────
  function renderStatic() {
    document.documentElement.lang = snap.lang;
    document.querySelectorAll('[data-t]').forEach(el => { el.textContent = t(el.dataset.t); });
    document.querySelectorAll('[data-t-title]').forEach(el => { el.title = t(el.dataset.tTitle); el.setAttribute('aria-label', t(el.dataset.tTitle)); });
    document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.lang === snap.lang));
    $('chip-launcher').textContent = snap.appVersion;
  }

  function renderNews() {
    const a = active();
    const g = upd && upd.game;
    const latest = g && g.latest;
    const head = $('news-head');
    head.textContent = '';
    let label, notes, date;
    if (latest && (!a || cmp(latest.version, a.version) >= 0)) {
      label = a && cmp(latest.version, a.version) === 0 ? t('installedNow', `v${latest.version}`) : t('newVersion', `v${latest.version}`);
      notes = latest.notes; date = latest.date;
    } else if (a) {
      label = t('installedNow', vName(a)); notes = a.notes; date = a.date;
    }
    if (label) {
      head.appendChild(document.createTextNode(label));
      if (date) { const s = document.createElement('span'); s.className = 'date'; s.textContent = day(date); head.appendChild(s); }
    }
    renderNotes($('news-body'), notes);
  }

  function setStatus(kind, text, sub = '', action = null) {
    $('status-dot').className = `dot ${kind}`;
    $('status-text').textContent = text;
    $('status-sub').textContent = sub;
    const btn = $('status-action');
    if (action) { btn.hidden = false; btn.textContent = action.label; btn.onclick = action.run; } else btn.hidden = true;
  }

  function renderStatus() {
    const g = upd.game;
    const a = active();
    const newV = g.latest ? `v${g.latest.version}` : '';
    const checked = upd.lastCheck ? t('st_checkedAt', time(upd.lastCheck)) : '';
    $('progress').hidden = g.status !== 'downloading';

    if (!upd.feedConfigured) return setStatus('', t('st_notConfigured'));
    if (g.status === 'downloading') {
      const p = g.progress || {};
      $('progress-fill').style.width = `${pct(p)}%`;
      return setStatus('busy', p.total ? t('st_downloading', newV, mb(p.received || 0), mb(p.total)) : t('st_downloadingNoTotal', newV, mb(p.received || 0)), '', { label: t('cancel'), run: () => api.cancelDownload() });
    }
    if (upd.checking) return setStatus('busy', t('st_checking'));
    if (g.status === 'ready' && g.justInstalled) return setStatus('ok', t('st_ready', `v${g.justInstalled}`), checked);
    if (g.status === 'error') return setStatus('err', t('st_downloadFailed', g.error || ''), '', { label: t('retry'), run: () => api.downloadGame() });
    if (upd.error) return setStatus('warn', t('st_offline'), checked, { label: t('retry'), run: () => api.check() });
    if (g.status === 'blocked') return setStatus('warn', t('st_blocked', newV), checked);
    if (g.status === 'available') return setStatus('warn', t('st_available', newV), checked, { label: t('download'), run: () => api.downloadGame() });
    if (upd.feedEmpty) return setStatus('', t('st_noReleases'), checked);
    if (g.status === 'up-to-date') return setStatus('ok', t('st_upToDate'), checked);
    setStatus('', a ? vName(a) : '');
  }

  function renderLauncherUpdate() {
    const l = upd.launcher;
    const bar = $('launcher-update');
    const btn = $('lu-btn');
    const v = l.latest && l.latest.version;
    bar.hidden = true;
    document.body.classList.remove('has-lu');
    if (!v) return;
    if (l.status === 'ready') {
      bar.hidden = false; $('lu-text').textContent = t('lu_ready', v);
      btn.hidden = false; btn.textContent = t('lu_install'); btn.onclick = () => api.installLauncherUpdate();
    } else if (l.status === 'downloading') {
      bar.hidden = false; $('lu-text').textContent = t('lu_downloading', v, `${pct(l.progress)}%`); btn.hidden = true;
    } else if (l.status === 'available' || l.status === 'error') {
      bar.hidden = false; $('lu-text').textContent = t('lu_available', v);
      btn.hidden = false;
      if (l.canInstall) { btn.textContent = l.status === 'error' ? t('retry') : t('download'); btn.onclick = () => api.check(); }
      else { btn.textContent = t('lu_manual'); btn.onclick = () => api.openLink(l.latest.url); }
    }
    document.body.classList.toggle('has-lu', !bar.hidden);
  }

  function renderPlay() {
    const a = active();
    const g = upd.game;
    const play = $('play');
    const old = $('play-old');
    old.hidden = true;
    $('chip-game').textContent = vName(a);
    if (starting) { play.disabled = true; $('play-label').textContent = t('playing'); $('play-ver').textContent = vName(a); return; }
    const updating = g.status === 'downloading' && g.latest && (!a || cmp(g.latest.version, a.version) > 0);
    if (!a) {
      play.disabled = true;
      $('play-label').textContent = updating ? t('updatingBtn', `${pct(g.progress)}%`) : t('noGame');
      $('play-ver').textContent = '';
      return;
    }
    if (updating) {
      play.disabled = true;
      $('play-label').textContent = t('updatingBtn', `${pct(g.progress)}%`);
      $('play-ver').textContent = `v${g.latest.version}`;
      old.hidden = false; old.textContent = t('playOld', vName(a));
      return;
    }
    play.disabled = false;
    $('play-label').textContent = t('play');
    $('play-ver').textContent = vName(a);
  }

  function renderSettings() {
    const s = snap.settings;
    for (const key of ['autoDownload', 'startFullscreen', 'openGameDirectly']) $(`set-${key}`).checked = !!s[key];
    $('last-check').textContent = upd && upd.lastCheck ? t('st_checkedAt', time(upd.lastCheck)) : '';

    const code = $('source-text');
    code.textContent = snap.updateSource && !/^OWNER\/REPO$/.test(snap.updateSource) ? snap.updateSource : '—';
    if (snap.updateSourceIsDefault) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = `(${t('s_sourceDefault')})`; code.appendChild(tag); }

    $('pin-auto').checked = !s.pinnedBuild;
    const list = $('builds');
    list.textContent = '';
    for (const b of snap.builds) {
      const li = document.createElement('li');
      li.classList.toggle('is-active', b.id === snap.activeId);
      const label = document.createElement('label'); label.className = 'radio';
      const input = document.createElement('input'); input.type = 'radio'; input.name = 'pin'; input.value = b.id; input.checked = s.pinnedBuild === b.id;
      input.onchange = () => pin(b.id);
      const dot = document.createElement('span');
      const em = document.createElement('em');
      const name = document.createElement('span'); name.className = 'b-name'; name.textContent = vName(b);
      em.appendChild(name);
      if (b.id === snap.activeId) { const badge = document.createElement('span'); badge.className = 'b-badge'; badge.textContent = t('active'); em.appendChild(badge); }
      const meta = document.createElement('span'); meta.className = 'b-meta';
      meta.textContent = [t(`src_${b.source}`), b.installedAt ? day(b.installedAt) : b.date ? day(b.date) : ''].filter(Boolean).join(' · ');
      em.appendChild(meta);
      label.append(input, dot, em);
      const actions = document.createElement('div'); actions.className = 'b-actions';
      const playBtn = document.createElement('button'); playBtn.textContent = t('playThis'); playBtn.onclick = () => startGame(b.id);
      actions.appendChild(playBtn);
      if (b.source !== 'bundled') {
        const del = document.createElement('button'); del.className = 'del'; del.textContent = t('remove'); del.title = t('remove');
        del.onclick = async () => { snap = await api.removeBuild(b.id); renderAll(); };
        actions.appendChild(del);
      }
      li.append(label, actions);
      list.appendChild(li);
    }
    $('about').textContent = `Pokemon Battle ${snap.appVersion} · ${snap.dataDir}`;
  }

  function renderAll() {
    if (!snap || !upd) return;
    renderStatic();
    renderStatus();
    renderLauncherUpdate();
    renderPlay();
    renderNews();
    renderSettings();
  }

  // ── actions ────────────────────────────────────────────────────────────────────────────
  async function startGame(buildId) {
    if (starting) return;
    starting = true; renderPlay();
    try { await api.play(buildId); }
    catch (e) { starting = false; renderPlay(); toast(t('playFailed', e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), true); }
  }

  async function pin(id) { snap = await api.setSetting('pinnedBuild', id || null); renderAll(); }

  async function installFromDrop(file) {
    const r = await api.installFile(file);
    if (r.ok) { snap = await api.snapshot(); renderAll(); toast(t('installedToast', vName(r.build))); }
    else toast(t('installFailed', r.error), true);
  }

  function openDrawer(open) {
    $('drawer').classList.toggle('open', open);
    $('drawer').setAttribute('aria-hidden', String(!open));
    $('scrim').hidden = !open;
  }

  function wire() {
    $('play').onclick = () => startGame();
    $('play-old').onclick = () => startGame(snap.activeId);
    $('open-settings').onclick = () => openDrawer(true);
    $('close-settings').onclick = () => openDrawer(false);
    $('scrim').onclick = () => openDrawer(false);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') openDrawer(false);
      if (e.key === 'Enter' && !$('drawer').classList.contains('open') && !$('play').disabled && document.activeElement.tagName !== 'INPUT') startGame();
    });
    document.querySelectorAll('.seg button').forEach(b => { b.onclick = async () => { snap = await api.setSetting('lang', b.dataset.lang); renderAll(); }; });
    for (const key of ['autoDownload', 'startFullscreen', 'openGameDirectly']) {
      $(`set-${key}`).onchange = async e => { snap = await api.setSetting(key, e.target.checked); renderAll(); if (key === 'autoDownload' && e.target.checked) api.check(); };
    }
    $('pin-auto').onchange = () => pin(null);
    $('check-now').onclick = () => api.check();
    $('install-file').onclick = async () => {
      const r = await api.pickFile();
      if (r.ok) { snap = await api.snapshot(); renderAll(); toast(t('installedToast', vName(r.build))); }
      else if (!r.cancelled) toast(t('installFailed', r.error), true);
    };
    $('open-data').onclick = () => api.openDataFolder();
    $('source-edit').onclick = () => { $('source-form').hidden = false; $('source-view').hidden = true; $('source-input').value = snap.updateSourceIsDefault ? '' : snap.updateSource || ''; $('source-input').focus(); };
    const saveSource = async value => {
      try { snap = await api.setUpdateSource(value); toast(t('sourceSaved')); $('source-form').hidden = true; $('source-view').hidden = false; renderAll(); }
      catch (e) { toast(t('sourceBad', e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), true); }
    };
    $('source-save').onclick = () => saveSource($('source-input').value.trim());
    $('source-input').onkeydown = e => { if (e.key === 'Enter') saveSource(e.target.value.trim()); };
    $('source-reset').onclick = () => saveSource('');

    // Drag a build file anywhere onto the window to install it.
    let depth = 0;
    const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; $('dropzone').hidden = false; });
    window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) $('dropzone').hidden = true; });
    window.addEventListener('drop', e => {
      e.preventDefault(); depth = 0; $('dropzone').hidden = true;
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) installFromDrop(f);
    });

    api.onUpdateState(s => { upd = s; renderStatus(); renderLauncherUpdate(); renderPlay(); renderNews(); $('last-check').textContent = upd.lastCheck ? t('st_checkedAt', time(upd.lastCheck)) : ''; });
    api.onSnapshot(s => { snap = s; upd = s.update; renderAll(); });
  }

  (async function init() {
    wire();
    snap = await api.snapshot();
    upd = snap.update;
    renderAll();
    document.body.classList.add('ready');
  })();
})();
