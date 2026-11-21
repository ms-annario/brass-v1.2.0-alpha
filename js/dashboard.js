/* BRASS — Projects page: the first page after login. Lists every project with its details; Open puts a
 * project on the map canvas, where it can be edited, saved and exported. "Projects" in the header comes back here.
 */
(function () {
  const B = window.B;
  const root = document.documentElement;

  B.initDashboard = function (app) {
    const c = app.controller, renderer = app.renderer;
    const page = document.getElementById('projects-page');
    const list = document.getElementById('pp-list');
    const back = document.getElementById('btn-header-projects');
    if (!page || !list) return;
    // Opened from a shared Home link (#dashboard): Home only, without the sidebar
    const dashShare = root.classList.contains('dash-share');

    const fmt = (t) => {
      if (!t) return '–';
      const d = new Date(t), p = (n) => String(n).padStart(2, '0');
      return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };
    const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    const initialsOf = (str) => {
      if (!str) return 'JD';
      const clean = String(str).split('@')[0].replace(/[^a-zA-Z0-9\s._-]/g, '').trim();
      const parts = clean.split(/[\s._-]+/).filter(Boolean);
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
      return clean.slice(0, 2).toUpperCase() || 'JD';
    };
    const resolveMember = (userOrEmail) => {
      if (!userOrEmail) return { name: 'John Doe', email: 'john.doe@brass.sg', initials: 'JD', role: 'Bus Ops' };
      if (typeof userOrEmail === 'object') {
        const name = userOrEmail.name || userOrEmail.email || 'User';
        const email = userOrEmail.email || '';
        return {
          name,
          email,
          role: userOrEmail.role || 'Collaborator',
          initials: userOrEmail.initials || initialsOf(name || email)
        };
      }
      const raw = String(userOrEmail).trim();
      const allSys = (B.SYSTEM_USERS && B.SYSTEM_USERS.length) ? B.SYSTEM_USERS : Object.values(B.USERS || {});
      const matched = allSys.find(
        (u) => u.email.toLowerCase() === raw.toLowerCase() || u.name.toLowerCase() === raw.toLowerCase()
      );
      if (matched) return matched;
      const namePart = raw.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
      return {
        name: namePart,
        email: raw.includes('@') ? raw : '',
        role: 'Collaborator',
        initials: initialsOf(namePart || raw)
      };
    };
    const canUserSeeProject = (p) => {
      const u = B.currentUser;
      if (!u) return true;
      const roleName = u.role || B.currentRole || 'Bus Ops';
      if (roleName === 'Admin' || roleName === 'Bus Ops') return true;
      const allRoles = typeof getSystemRoles === 'function' ? getSystemRoles() : [];
      const roleDef = allRoles.find((r) => r.name === roleName || r.id === roleName);
      if (roleDef && roleDef.perms && roleDef.perms.projects === false) {
        return false;
      }
      return true;
    };
    // The signed-in user is the project's owner themself (with no one signed in, every project is theirs)
    const ownsProject = (p) => {
      const u = B.currentUser;
      if (!u) return true;
      const userEmail = (u.email || '').toLowerCase().trim();
      const userFullName = (u.name || '').toLowerCase().trim();

      const owner = (p && p.owner) || { name: 'John Doe', email: 'john.doe@brass.sg' };
      const ownerEmail = (typeof owner === 'string' ? owner : (owner.email || '')).toLowerCase().trim();
      const ownerName = (typeof owner === 'object' && owner.name ? owner.name : '').toLowerCase().trim();

      return Boolean((userEmail && ownerEmail && userEmail === ownerEmail) || (userFullName && ownerName && userFullName === ownerName));
    };
    // The owner, or an Admin, who can manage every project
    const isUserProjectOwner = (p) => !B.currentUser || B.currentUser.role === 'Admin' || ownsProject(p);
    B.isUserProjectOwner = isUserProjectOwner;
    // The owner (or an Admin), or someone added to the project as a collaborator
    const isAssignedToProject = (p) => {
      if (isUserProjectOwner(p)) return true;
      const u = B.currentUser || {};
      const me = [u.email, u.name].filter(Boolean).map((x) => String(x).toLowerCase().trim());
      return (p.collaborators || []).some((cb) => {
        const them = typeof cb === 'string' ? [cb] : [cb.email, cb.name];
        return them.filter(Boolean).some((x) => me.includes(String(x).toLowerCase().trim()));
      });
    };
    const showsInProjectMenu = (p) => canUserSeeProject(p) && isAssignedToProject(p);
    const docOf = (id) => (id === c.activeProjectId ? c.store.doc : c._loadProjectDraft(id));
    const toast = (m, k, dur) => c._showToast && c._showToast(m, k || 'info', dur);

    const busCount = (d) => new Set(Object.values((d && d.routes) || {}).map((r) => String(r.number).trim())).size;
    // The parts of a saved map the cards count, read without rebuilding the whole map (null: not saved that way)
    const lightDoc = (key) => {
      const raw = B.storedRaw && B.storedRaw(key);
      if (!raw || !raw.startsWith('~d')) return null;
      const d = {};
      for (const part of ['routes', 'stops', 'areas', 'closures']) d[part] = B.storedPart(key, part) || {};
      return d;
    };
    // What the project changes, worked out the way Home's project brief does it (routes, stops, passengers,
    // closures, travel time and distance). That walks every route, so it's kept until the project changes
    const briefCache = new Map();
    // Projects that started from the same map share its worked-out copy
    const baseCalcs = new Map();
    const projectBrief = (p, key) => {
      if (B.stripLeakedTempObstaclesFromProject && p && p.id && p.id !== 'main') {
        const cleaned = B.stripLeakedTempObstaclesFromProject(c, p.id);
        if (cleaned && p.id === c.activeProjectId && c.store) {
          const fresh = c._loadProjectDraft(p.id);
          if (c._prepareForeignBlocked) c._prepareForeignBlocked(fresh);
          c.store.loadDoc(fresh, { label: 'Clean leaked obstacles' });
        }
      }
      const periodSig = JSON.stringify(p && p.applyPeriod || null);
      const sig = key + '|' + periodSig + '|' + (p.id === c.activeProjectId ? c.store.rev : '');
      const known = briefCache.get(p.id);
      if (known && known.sig === sig) return known.br;
      let br = {};
      try {
        const base = c._projectBase(p.id), doc = docOf(p.id);
        if (!base) return br;
        const raw = B.storedRaw && B.storedRaw('brass_proj_base_' + p.id);
        let baseCalc = raw ? baseCalcs.get(raw) : null;
        if (raw && !baseCalc) {
          baseCalcs.set(raw, baseCalc = makeStoreCalc(base));
          if (baseCalcs.size > 6) baseCalcs.delete(baseCalcs.keys().next().value);
        }
        // Another project's map is a fresh copy already; the open one is copied so working it out leaves it alone
        br = computeProjectBrief(base, p.id === c.activeProjectId ? JSON.parse(JSON.stringify(doc)) : doc, baseCalc || undefined);
      } catch (e) { /* the card still shows the rest */ }
      briefCache.set(p.id, { sig, br });
      return br;
    };

    // The six change figures of a brief, with the arrow each shows: green when better, red when worse.
    // Home's project brief and the project cards both draw from this, so they always agree
    const briefFigures = (br) => {
      const flat = { kind: 'flat', arrow: '', text: '—' };
      const trend = (kind, arrow, text) => ({ kind, arrow, text });
      const pl = (n, one, many) => (n === 1 ? one : many);

      const rCnt = br.affectedRoutesCount || 0, added = br.addedRoutesCount || 0, susp = br.suspendedRoutesCount || 0;
      const dis = br.disruptedCount || 0, div = br.divertedCount || 0;
      let rTrend = flat;
      if (susp > added) rTrend = trend('bad', '▼', `−${susp - added}`);
      else if (added > 0 && div === 0 && dis === 0) rTrend = trend('good', '▲', `+${added}`);
      else if (dis > 0) rTrend = trend('bad', '▲', `${dis} blk`);
      else if (div > 0) rTrend = trend('warn', '▲', `${div} div`);

      const sCnt = br.affectedStopsCount || 0, net = br.stopsNet || 0;
      let sTrend = flat;
      if (net < 0) sTrend = trend('bad', '▼', `−${Math.abs(net)}`);
      else if (net > 0) sTrend = trend('good', '▲', `+${net}`);
      else if (sCnt > 0) sTrend = trend('warn', '▲', `${sCnt}`);

      const lost = br.lostCommuters || 0, gained = br.gainedCommuters || 0, delayed = br.delayedCommuters || 0;
      let pNum = 0, pTrend = flat;
      if (lost > gained) { pNum = lost; pTrend = trend('bad', '▼', `−${fmtCompactPeople(lost - gained)}`); }
      else if (gained > lost) { pNum = gained; pTrend = trend('good', '▲', `+${fmtCompactPeople(gained - lost)}`); }
      else if (delayed > 0) { pNum = delayed; pTrend = trend('warn', '▲', `~${fmtCompactPeople(delayed)}`); }

      // An average change: its size and unit, + when longer (worse) and − when shorter (better)
      const change = (v, min, big, fmtBig, fmtSmall, bigUnit, smallUnit) => {
        if (Math.abs(v) < min) return null;
        const a = Math.abs(v), worse = v > 0;
        const num = a >= big ? fmtBig(a) : fmtSmall(a), unit = a >= big ? bigUnit : smallUnit;
        return { num, unit, sign: worse ? '+' : '−', trend: trend(worse ? 'bad' : 'good', worse ? '▲' : '▼', `${worse ? '+' : '−'}${num} ${unit}`) };
      };
      const n = br.roadClosuresCount || 0;
      return {
        routes: { n: rTrend === flat ? 0 : rCnt, unit: pl(rCnt, 'route', 'routes'), trend: rTrend },
        stops: { n: sTrend === flat ? 0 : sCnt, unit: pl(sCnt, 'stop', 'stops'), trend: sTrend },
        passengers: { n: pNum, compact: pNum ? fmtCompactPeople(pNum) : '0', trend: pTrend },
        closures: { n, unit: pl(n, 'road', 'roads') },
        time: change(br.avgTimeDeltaSec || 0, 1, 60, (a) => (a / 60).toFixed(1), (a) => String(Math.max(1, Math.round(a))), 'min', 'sec'),
        dist: change(br.avgDistDeltaM || 0, 5, 1000, (a) => (a / 1000).toFixed(2), (a) => String(Math.max(1, Math.round(a))), 'km', 'm'),
      };
    };
    // A card's counts, kept until the project's saved map or its starting map changes (the open one is counted afresh)
    const countsCache = new Map();
    const details = (p) => {
      if (B.stripLeakedTempObstaclesFromProject && p && p.id && p.id !== 'main') {
        const cleaned = B.stripLeakedTempObstaclesFromProject(c, p.id);
        if (cleaned && p.id === c.activeProjectId && c.store) {
          const fresh = c._loadProjectDraft(p.id);
          if (c._prepareForeignBlocked) c._prepareForeignBlocked(fresh);
          c.store.loadDoc(fresh, { label: 'Clean leaked obstacles' });
        }
      }
      const active = p.id === c.activeProjectId;
      const docKey = 'brass_proj_doc_' + p.id, baseKey = 'brass_proj_base_' + p.id;
      const rawDoc = active ? null : B.storedRaw(docKey), rawBase = B.storedRaw(baseKey);
      const hit = !active && countsCache.get(p.id);
      let n = hit && hit.rawDoc === rawDoc && hit.rawBase === rawBase ? hit.n : null;
      if (!n) {
        const doc = (active ? c.store.doc : lightDoc(docKey) || docOf(p.id)) || {};
        let base = null, changes = 0;
        try { base = lightDoc(baseKey) || c._projectBase(p.id); changes = c._projectChanges(base, doc).length; } catch (e) { /* no base yet */ }
        const buses = busCount(doc), stops = Object.keys(doc.stops || {}).length;
        n = {
          buses, stops,
          // how many more or fewer than the map the project started from
          busesDelta: base ? buses - busCount(base) : 0,
          stopsDelta: base ? stops - Object.keys(base.stops || {}).length : 0,
          areas: Object.keys(doc.areas || {}).length, closures: Object.keys(doc.closures || {}).length,
          changes,
        };
        if (!active) countsCache.set(p.id, { rawDoc, rawBase, n });
      }
      return {
        ...n,
        // worked out only for the projects whose card is shown
        get brief() { return projectBrief(p, [p.updatedAt, n.changes, n.buses, n.stops, n.areas, n.closures].join('|')); },
        status: c._projectOnCurrentMap(p.id) ? 'Applied' : 'Draft',
      };
    };
    // The six change figures, in the order of Home's project brief: [key in briefFigures, label]
    const CHANGE_FIGURES = [
      ['routes', 'Affected Routes'], ['stops', 'Affected Bus Stops'], ['passengers', 'Affected Passengers'],
      ['closures', 'Road Closure'], ['time', 'Travel Time'], ['dist', 'Travel Distance'],
    ];
    // One change figure as shown on a project card and in Home's top cards. Routes, stops, passengers (a day) and
    // road closures are a plain count (the label says what of); travel time and distance have a red or green arrow
    // in front, since which way they go matters
    const changeValue = (f, key) => {
      const num = (v) => `<b class="chg-num">${v}</b>`, unit = (u) => `<small class="chg-unit">${u}</small>`;
      const arrow = (t) => `<span class="home-pb-trend is-${t.kind}"><i class="home-pb-arrow">${t.arrow}</i></span>`;
      const x = f[key];
      if (key === 'routes' || key === 'stops' || key === 'closures') return num(x.n || 0);
      if (key === 'passengers') return x.n ? num(x.compact) + unit('/day') : num(0);
      return x ? arrow(x.trend) + num(x.sign + x.num) + unit(x.unit) : num(0) + unit(key === 'time' ? 'min' : 'km');
    };
    // How big a change is against the whole: the share of all routes, stops, passengers a day and roads it touches,
    // or for travel time and distance the change as a share of the usual trip (the changed routes', else the network's)
    const fmtPct = (p, signed) => {
      if (!p || Math.abs(p) < 0.05) return '0%';
      const a = Math.abs(p);
      const s = a >= 10 ? String(Math.round(a)) : a.toFixed(1).replace(/\.0$/, '');
      return (signed ? (p > 0 ? '+' : '−') : '') + s + '%';
    };
    const fmtTrip = (sec) => (sec >= 60 ? `${Math.round(sec / 60)} min` : `${Math.round(sec)} sec`);
    const changeShare = (key, f, br, totals) => {
      const of = (n, total) => (total > 0 ? (n / total) * 100 : 0);
      if (key === 'routes') return { pct: fmtPct(of(f.routes.n, totals.routes)), of: `${totals.routes || 0} routes`, title: 'Share of all bus services running' };
      if (key === 'stops') return { pct: fmtPct(of(f.stops.n, totals.stops)), of: `${(totals.stops || 0).toLocaleString('en-US')} stops`, title: 'Share of all bus stops' };
      if (key === 'passengers') return { pct: fmtPct(of(f.passengers.n, totals.passengers)), of: `${fmtCompactPeople(totals.passengers || 0)}/day`, title: 'Share of all passengers a day (estimated)' };
      if (key === 'closures') return { pct: fmtPct(of(f.closures.n, totals.roads)), of: `${(totals.roads || 0).toLocaleString('en-US')} roads`, title: 'Share of all named roads' };
      if (key === 'time') return { pct: fmtPct(f.time ? br.timeDeltaPct : 0, true), of: `${fmtTrip(br.avgBaseTimeSec || totals.avgTripSec || 0)} trip`, title: 'Change in the average trip time of the changed routes' };
      return { pct: fmtPct(f.dist ? br.distDeltaPct : 0, true), of: `${(((br.avgBaseDistM || totals.avgRouteM || 0)) / 1000).toFixed(1)} km route`, title: 'Change in the average length of the changed routes' };
    };
    // One figure on the card: its name above, what the project changes below
    const stat = (label, html) => `<div class="pp-stat"><span class="pp-stat-label">${label}</span><span class="pp-stat-val">${html}</span></div>`;
    const changeStats = (br) => {
      const f = briefFigures(br);
      return CHANGE_FIGURES.map(([key, label]) => stat(label, changeValue(f, key))).join('');
    };

    const ICON = {
      exp: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
      get: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
      dup: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
      del: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
      edit: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
      open: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
    };
    let view = 'projects';
    let query = '', statusFilter = 'all', renaming = null;
    let highlightedProjectId = null, highlightTimer = null;
    // Where a project stands, set from the dropdown by its name; new ones start Not Started and move to In Progress on any action.
    // The All filter leaves archived projects out, so they stay out of the way until asked for
    const STATUSES = [
      { key: 'not_started', label: 'Not Started' },
      { key: 'progress', label: 'In Progress' },
      { key: 'review', label: 'Ready to Review' },
      { key: 'approved', label: 'Approved' },
      { key: 'schedule', label: 'Schedule' },
      { key: 'go_live', label: 'Go-Live' },
      { key: 'archive', label: 'Archive' },
    ];
    const statusOf = (p) => {
      if (p && p.status === 'done') p.status = 'approved';
      return STATUSES.some((st) => st.key === (p && p.status)) ? p.status : 'not_started';
    };
    const statusSelect = (p, isOwner = true) => `<select class="pp-status-select st-${statusOf(p)}"${!isOwner ? ' disabled title="Project status is managed by the Project Owner"' : ' title="Status"'}" data-act="status" aria-label="Status of ${esc(p.name)}">
        ${STATUSES.map((st) => `<option value="${st.key}"${st.key === statusOf(p) ? ' selected' : ''}>${st.label}</option>`).join('')}
      </select>`;
    let sortKey = 'updated', newestFirst = true, periodFilter = 'all', mineOnly = false;
    const SORTS = { event: 'Event date', updated: 'Latest updated', created: 'Created date' };
    const PERIODS = { all: 'All projects', temporary: 'Temporary', permanent: 'Permanent' };
    // Permanent means no end date (its effective period isn't scheduled), the same rule as the project's tag
    const isPermanent = (p) => (p.applyPeriod || {}).mode !== 'scheduled';
    const inPeriod = (p) => periodFilter === 'all' || (periodFilter === 'permanent') === isPermanent(p);
    const inMine = (p) => !mineOnly || ownsProject(p);
    const openDocs = new Set();
    const openCollabPickers = new Set();
    const MAX = 25 * 1048576;
    // An area file (GeoJSON, or a sketch saved from the map) is read as an affected area; it reads "Applied" once
    // its area has been put on the project's map from a document, not when the map already had one by that name
    const areaNamesOf = new Map(); // doc id -> names of the areas in it ([] when it isn't an area file)
    const readAreaNames = async (d) => {
      if (areaNamesOf.has(d.id)) return;
      let names = [];
      if (/json/.test(d.type) || /\.(geo)?json$/i.test(d.name)) {
        try {
          const j = JSON.parse(await d.blob.text());
          const base = d.name.replace(/\.[^.]+$/, '');
          if (j && j.kind === 'brass-area-drawing') names = [j.name || base];
          else {
            const polys = [];
            const walk = (g, name) => {
              if (!g) return;
              if (g.type === 'FeatureCollection') (g.features || []).forEach((f) => walk(f));
              else if (g.type === 'Feature') walk(g.geometry, g.properties && (g.properties.name || g.properties.Name));
              else if (g.type === 'GeometryCollection') (g.geometries || []).forEach((x) => walk(x, name));
              else if (g.type === 'Polygon') polys.push(name);
              else if (g.type === 'MultiPolygon') (g.coordinates || []).forEach(() => polys.push(name));
            };
            walk(j);
            // unnamed polygons take the file's name, numbered when there are several (as the map names them)
            names = polys.slice(0, 10).map((n, i) => n || (polys.length > 1 ? `${base} ${i + 1}` : base));
          }
        } catch (e) { names = []; }
      }
      areaNamesOf.set(d.id, names);
    };
    const areaTag = (d) => {
      const names = areaNamesOf.get(d.id) || [];
      if (!names.length) return '';
      const areas = d.projectId === c.activeProjectId ? c.store.doc.areas : (B.storedPart && B.storedPart('brass_proj_doc_' + d.projectId, 'areas'));
      const fromDocs = Object.values(areas || (docOf(d.projectId) || {}).areas || {}).filter((a) => a.fromDocument);
      const applied = names.some((n) => fromDocs.some((a) => a.name === n));
      return `<span class="pp-doc-tag${applied ? ' applied' : ''}" title="${applied ? 'This area is on the project\'s map' : 'Read as an affected area; not on the map yet'}">Affected area${applied ? ' · Applied' : ''}</span>`;
    };
    const docRow = (d, withProject) => `<div class="pp-doc" data-doc="${esc(d.id)}">
        <span class="pp-doc-name">${esc(d.name)}</span>${areaTag(d)}
        ${withProject ? `<span class="pp-doc-proj">${esc((c.projects.find((p) => p.id === d.projectId) || { name: 'Deleted project' }).name)}</span>` : ''}
        <span class="pp-doc-meta">${B.docs.size(d.size)} · ${fmt(d.added)}</span>
        <button type="button" class="pp-icon pp-icon-sm" data-act="doc-get" title="Download" aria-label="Download">${ICON.get}</button>
        <button type="button" class="pp-icon pp-icon-sm pp-danger" data-act="doc-del" title="Remove" aria-label="Remove">${ICON.del}</button>
      </div>`;

    const renderDocsTab = (all) => {
      const q = query.trim().toLowerCase();
      const pname = (d) => ((c.projects.find((p) => p.id === d.projectId) || {}).name || '').toLowerCase();
      const docs = q ? all.filter((d) => d.name.toLowerCase().includes(q) || pname(d).includes(q)) : all;
      document.getElementById('pp-count').textContent = `${docs.length} document${docs.length === 1 ? '' : 's'}`;
      list.innerHTML = docs.length ? `<div class="pp-row pp-docs-all">${docs.map((d) => docRow(d, true)).join('')}</div>` : `<div class="pp-empty">${q ? 'No documents match' : 'No documents yet'}</div>`;
    };

    // ------------------------------------------------------------- Timeline (the strip under the search)
    // Pick a date range, then slide through it: the list keeps the projects whose effective period covers
    // that moment (a Forever project runs from its start on). ↺ clears it and lists every project again.
    const tlFrom = document.getElementById('tl-from'), tlTo = document.getElementById('tl-to');
    const tlSlider = document.getElementById('tl-slider'), tlClose = document.getElementById('tl-close');
    const tlWhen = document.getElementById('tl-when');
    const tlBar = document.getElementById('timeline-bar');
    const ppDateWrap = document.getElementById('pp-date-wrap');
    const ppDateBtn = document.getElementById('pp-date-btn');
    const ppDateLabel = document.getElementById('pp-date-label');
    const ppDateClear = document.getElementById('pp-date-clear');
    const ppDatePop = document.getElementById('pp-date-pop');
    const ppDateReset = document.getElementById('pp-date-reset');
    let tl = null; // { from, to, scrubbing } once a range is picked
    const tlTime = () => tl.from + ((tl.to - tl.from) * Number(tlSlider.value)) / 1000;
    // A project's effective period: from its start to its end, or for good when it's Forever
    const span = (p) => {
      const per = p.applyPeriod || c._defaultApplyPeriod();
      const ts = (d, t) => (d ? new Date(`${d}T${t || '00:00'}`).getTime() : NaN);
      const start = ts(per.startDate, per.startTime);
      const end = per.mode === 'scheduled' ? ts(per.endDate, per.endTime) : NaN;
      return { start: isNaN(start) ? (p.createdAt || 0) : start, end: isNaN(end) ? Infinity : end };
    };
    const onTimeline = (p) => {
      if (!tl) return true;
      const s = span(p);
      if (tl.scrubbing) {
        const t = tlTime();
        return s.start <= t && t < s.end;
      }
      return s.start <= tl.to && s.end >= tl.from;
    };
    const syncDatePickerBtn = () => {
      const hasRange = Boolean(tl);
      if (tlBar) tlBar.hidden = !hasRange || view !== 'projects';
      if (ppDateBtn) ppDateBtn.classList.toggle('has-range', hasRange);
      if (ppDateClear) ppDateClear.hidden = !hasRange;
      if (ppDateReset) ppDateReset.hidden = !hasRange && !(tlFrom && tlFrom.value) && !(tlTo && tlTo.value);
      if (ppDateLabel) {
        if (!hasRange) {
          ppDateLabel.textContent = 'Date range';
        } else {
          const fmtShort = (ms) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
          const a = fmtShort(tl.from);
          const b = fmtShort(tl.to);
          ppDateLabel.textContent = a === b ? a : `${a} – ${b}`;
        }
      }
    };

    // Rough dates under the slider: the smallest step (day … year) that leaves room for each label
    const tlScale = () => {
      const box = document.getElementById('tl-scale');
      if (!tl) { box.innerHTML = ''; return; }
      const { from, to } = tl;
      const DAY = 86400000;
      const maxLabels = Math.max(2, Math.floor((box.clientWidth || 600) / 64));
      const steps = [
        { unit: 'day', n: 1 }, { unit: 'day', n: 2 }, { unit: 'day', n: 7 }, { unit: 'day', n: 14 },
        { unit: 'month', n: 1 }, { unit: 'month', n: 3 }, { unit: 'month', n: 6 },
        { unit: 'year', n: 1 }, { unit: 'year', n: 2 }, { unit: 'year', n: 5 }, { unit: 'year', n: 10 },
      ];
      const approx = { day: DAY, month: 30.44 * DAY, year: 365.25 * DAY };
      const step = steps.find((st) => (to - from) / (approx[st.unit] * st.n) <= maxLabels) || steps[steps.length - 1];
      // First mark on a whole day / month / year at or after the start
      const d = new Date(from);
      d.setHours(0, 0, 0, 0);
      if (step.unit !== 'day') d.setDate(1);
      if (step.unit === 'year') d.setMonth(0);
      const next = () => {
        if (step.unit === 'day') d.setDate(d.getDate() + step.n);
        else if (step.unit === 'month') d.setMonth(d.getMonth() + step.n);
        else d.setFullYear(d.getFullYear() + step.n);
      };
      if (d.getTime() < from) next();
      const marks = [];
      let lastYear = null;
      while (d.getTime() <= to && marks.length < 60) {
        const withYear = marks.length === 0 || (lastYear !== null && d.getFullYear() !== lastYear) ? { year: 'numeric' } : {};
        const text = step.unit === 'day' ? d.toLocaleDateString([], { day: 'numeric', month: 'short', ...withYear })
          : step.unit === 'month' ? d.toLocaleDateString([], { month: 'short', ...withYear }) : String(d.getFullYear());
        marks.push({ pct: ((d.getTime() - from) / (to - from)) * 100, text });
        lastYear = d.getFullYear();
        next();
      }
      box.innerHTML = marks.map((m) => `<span class="tl-scale-mark" style="left: ${m.pct}%">${esc(m.text)}</span>`).join('');
    };
    // Starts and ends of projects inside the range: red when Go-Live/applied, violet when Schedule, grey for drafts
    const tlTicks = () => {
      tlScale();
      const box = document.getElementById('tl-ticks');
      if (!tl) { box.innerHTML = ''; return; }
      const marks = [];
      for (const p of c.projects.filter(showsInProjectMenu)) {
        const s = span(p);
        const st = statusOf(p);
        const kind = (st === 'go_live' || c._projectOnCurrentMap(p.id)) ? 'live' : (st === 'schedule' ? 'scheduled' : 'draft');
        for (const [ts, what] of [[s.start, 'starts'], [s.end, 'ends']]) {
          if (ts >= tl.from && ts <= tl.to) marks.push({ pct: ((ts - tl.from) / (tl.to - tl.from)) * 100, kind, title: `${p.name} ${what} ${fmt(ts)}` });
        }
      }
      box.innerHTML = marks.map((m) => `<span class="tl-tick ${m.kind}" style="left: ${m.pct}%" title="${esc(m.title)}"></span>`).join('');
    };
    // The moment picked, in a bubble that follows the slider's thumb, kept inside the strip
    const tlPlace = () => {
      if (tlWhen.hidden) return;
      const thumb = 16, frac = Number(tlSlider.value) / 1000;
      const rail = tlSlider.getBoundingClientRect(), track = tlWhen.parentElement.getBoundingClientRect();
      const bar = document.getElementById('timeline-bar').getBoundingClientRect();
      const half = tlWhen.offsetWidth / 2;
      const x = rail.left + thumb / 2 + (rail.width - thumb) * frac;
      tlWhen.style.left = `${Math.min(Math.max(x, bar.left + half + 8), bar.right - half - 8) - track.left}px`;
    };
    const tlLabel = (n) => {
      syncDatePickerBtn();
      tlClose.hidden = !tl;
      tlWhen.hidden = !tl || !tl.scrubbing;
      if (!tl || !tl.scrubbing) return;
      const when = new Date(tlTime()).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
      tlWhen.textContent = `${when} · ${n} project${n === 1 ? '' : 's'} running`;
      tlPlace();
    };

    const search = document.getElementById('pp-search');
    const render = async () => {
      if (c.activeProjectId && !c.reviewMode) c._saveCurrentProjectDraft(false);
      let docs = [];
      try { docs = await B.docs.all(); } catch (e) {}
      await Promise.all(docs.map(readAreaNames));
    document.querySelectorAll('.pp-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
      document.getElementById('pp-new').hidden = view !== 'projects';
      if (ppDateWrap) ppDateWrap.hidden = view !== 'projects';
      syncDatePickerBtn();
      if (search) search.placeholder = view === 'projects' ? 'Search projects' : 'Search documents';
      if (view === 'docs') return renderDocsTab(docs);
      if (c._syncProjectScheduleStatuses) c._syncProjectScheduleStatuses({ silent: true });
      const q = query.trim().toLowerCase();
      let statusMigrated = false;
      const all = c.projects.filter(showsInProjectMenu).map((p) => {
        const d = details(p);
        if (p.status === 'done') {
          p.status = 'approved';
          statusMigrated = true;
        } else if (!p.status) {
          p.status = d.changes > 0 ? 'progress' : 'not_started';
          statusMigrated = true;
        } else if (p.status === 'not_started' && !p.manualNotStarted && d.changes > 0) {
          p.status = 'progress';
          statusMigrated = true;
        }
        return { p, d };
      });
      if (statusMigrated) c._saveProjects();
      const chips = document.getElementById('pp-status-tabs');
      const n = (key) => all.filter((x) => (key === 'all' ? statusOf(x.p) !== 'archive' : statusOf(x.p) === key)).length;
      // never an empty status: one with no projects can't be picked, and one that empties out goes back to All
      if (statusFilter !== 'all' && !n(statusFilter)) statusFilter = 'all';
      if (chips) {
        chips.innerHTML = [{ key: 'all', label: 'All' }, ...STATUSES].map((st) => `<button type="button" role="tab" aria-selected="${st.key === statusFilter}" aria-controls="pp-list" class="pp-status-tab${st.key === statusFilter ? ' active' : ''}" data-status="${st.key}"${st.key !== 'all' && !n(st.key) ? ' disabled title="No projects with this status"' : st.key === 'all' ? ' title="Every project except archived ones"' : ''}>${st.label}<span class="pp-status-tab-n">${n(st.key)}</span></button>`).join('');
      }
      const inStatus = (p) => (statusFilter === 'all' ? statusOf(p) !== 'archive' : statusOf(p) === statusFilter);
      const shown = all.filter((x) => (!q || x.p.name.toLowerCase().includes(q) || (x.p.id && String(x.p.id).toLowerCase().includes(q))) && onTimeline(x.p) && inStatus(x.p) && inPeriod(x.p) && inMine(x.p));
      tlTicks();
      tlLabel(shown.length);
      // Event date is when the project's effective period starts
      const stamp = (x) => {
        if (sortKey === 'created') return x.p.createdAt || 0;
        if (sortKey === 'updated') return x.p.updatedAt || x.p.createdAt || 0;
        const per = x.p.applyPeriod || {};
        const t = per.startDate ? new Date(`${per.startDate}T${per.startTime || '00:00'}`).getTime() : NaN;
        return isNaN(t) ? (x.p.createdAt || 0) : t;
      };
      shown.sort((u, v) => (newestFirst ? stamp(v) - stamp(u) : stamp(u) - stamp(v)));
      document.getElementById('pp-count').textContent = shown.length === all.length ? `${all.length} project${all.length === 1 ? '' : 's'}` : `${shown.length} of ${all.length} projects`;
      if (!all.length) {
        list.innerHTML = '';
        return;
      }
      if (!shown.length) { list.innerHTML = `<div class="pp-empty">${tl ? 'No projects running then' : statusFilter !== 'all' && !q && periodFilter === 'all' && !mineOnly ? 'No projects with this status' : 'No projects match'}</div>`; return; }
      list.innerHTML = shown.map(({ p, d }) => {
        const nDocs = docs.filter((x) => x.projectId === p.id).length;
        const owner = resolveMember(p.owner || { name: 'John Doe', email: 'john.doe@brass.sg', role: 'Bus Ops' });
        const collabs = Array.isArray(p.collaborators) ? p.collaborators : [];
        const isOwner = isUserProjectOwner(p);
        // An archived project's team is shown, not changed
        const canEditTeam = isOwner && statusOf(p) !== 'archive';
        const isForever = isPermanent(p);
        return `<div class="pp-row${p.id === highlightedProjectId ? ' is-newly-created' : ''}" data-id="${esc(p.id)}">
          <!-- Header: name, then its tags; actions on the right -->
          <div class="pp-main">
            <div class="pp-head-text">
              <div class="pp-title-row">
                ${renaming === p.id && isOwner
                  ? `<input type="text" class="pp-rename" value="${esc(p.name)}" maxlength="40" aria-label="Project name" title="Enter to save, Esc to cancel" />`
                  : `<span class="pp-name">${esc(p.name)}</span>${isOwner ? `<button type="button" class="pp-edit" data-act="rename" title="Rename" aria-label="Rename">${ICON.edit}</button>` : ''}`}
              </div>
              <div class="pp-sub-row">
                <span class="pp-id-badge" data-proj-id="${esc(p.id)}" title="Project ID: ${esc(p.id)} (Click to copy)" role="button" tabindex="0"><span class="pp-id-prefix">ID:</span><span class="pp-id-val">${esc(p.id)}</span></span>
                <span class="pp-period-tag ${isForever ? 'is-permanent' : 'is-temporary'}" data-period-tag="${esc(p.id)}" title="Effective period: ${isForever ? 'Permanent' : 'Temporary'}">${isForever ? 'Permanent' : 'Temporary'}</span>
                ${statusSelect(p, isOwner)}
                <span class="pp-updated">Updated ${fmt(p.updatedAt || p.createdAt)}</span>
              </div>
            </div>
            <span class="pp-top-actions">
              <span class="pp-icon-group">
                <span class="pp-export">
                  <button type="button" class="pp-icon" data-act="export" title="Share" aria-label="Share" aria-haspopup="true">${ICON.exp}</button>
                  <div class="pp-export-menu" hidden>
                    <button type="button" data-act="exp-link">Copy share link</button>
                    <button type="button" data-act="exp-pdf">Export PDF</button>
                    <button type="button" data-act="exp-slides">Export Slides</button>
                    <button type="button" data-act="exp-poster">Export Poster</button>
                  </div>
                </span>
                <button type="button" class="pp-icon" data-act="dup" title="Duplicate" aria-label="Duplicate">${ICON.dup}</button>
                ${isOwner ? `<button type="button" class="pp-icon pp-danger" data-act="del" title="Delete" aria-label="Delete">${ICON.del}</button>` : ''}
              </span>
              <button type="button" class="pp-view" data-act="open" title="View Project" aria-label="View Project">${ICON.open}</button>
            </span>
          </div>
          <!-- What the project changes: the same six figures as Home's project brief -->
          <div class="pp-meta">
            ${changeStats(d.brief)}
          </div>
          <!-- Schedule and team, side by side when the card is wide enough -->
          <div class="pp-grid">
            <section class="pp-panel pp-sched" aria-label="Schedule">
              <div class="pp-panel-head">
                <span class="pp-panel-title">Schedule</span>
                <span class="pp-forever-slot"></span>
              </div>
              <div class="pp-period" data-period="${esc(p.id)}"></div>
            </section>
            <section class="pp-panel pp-team" aria-label="Team">
              <div class="pp-panel-head">
                <span class="pp-panel-title">Team</span>
                ${canEditTeam ? `
                <div class="pp-add-collab-anchor">
                  <button type="button" class="pp-btn-add-collab" data-act="toggle-add-collab" title="Add project collaborator">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                    <span>Add Collaborator</span>
                  </button>

                  <!-- User Search & List of System Users Picker (shown directly below + Add Collaborator) -->
                  <div class="pp-collab-picker" data-collab-picker="${esc(p.id)}"${openCollabPickers.has(p.id) ? '' : ' hidden'}>
                    <div class="pp-collab-picker-top">
                      <div class="pp-collab-search-box">
                        <svg class="pp-collab-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                        <input type="text" class="pp-collab-search-input" data-collab-search="${esc(p.id)}" placeholder="Search users by name, role, or email..." autocomplete="off" spellcheck="false" />
                      </div>
                      <button type="button" class="pp-btn-collab-cancel" data-act="cancel-add-collab" title="Close" aria-label="Close">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <line x1="18" y1="6" x2="6" y2="18"></line>
                          <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                      </button>
                    </div>
                    <div class="pp-collab-users-list" data-collab-list="${esc(p.id)}">
                      ${(() => {
                        const allUsers = (B.SYSTEM_USERS && B.SYSTEM_USERS.length) ? B.SYSTEM_USERS : Object.values(B.USERS || {});
                        const availableUsers = allUsers.filter((u) => {
                          const isOwner = (owner.email && u.email && owner.email.toLowerCase() === u.email.toLowerCase()) || (owner.name && u.name && owner.name.toLowerCase() === u.name.toLowerCase());
                          const isAdded = collabs.some((cb) => {
                            const em = typeof cb === 'string' ? cb : (cb.email || cb.name || '');
                            return em.toLowerCase() === (u.email || '').toLowerCase() || em.toLowerCase() === (u.name || '').toLowerCase();
                          });
                          return !isOwner && !isAdded;
                        });

                        if (!availableUsers.length) {
                          return `<div class="pp-collab-all-added" style="padding: 16px 12px; text-align: center; color: #64748b; font-size: 12px; font-weight: 500;">All team members have already been added</div>`;
                        }

                        return availableUsers.map((u) => `
                          <div class="pp-collab-user-item is-actionable" data-act="add-collab-user" data-user-email="${esc(u.email)}" data-proj-id="${esc(p.id)}" data-search-text="${esc(`${u.name} ${u.role} ${u.email}`.toLowerCase())}" role="button" tabindex="0" title="Click to add ${esc(u.name)} directly">
                            <span class="pp-member-avatar" aria-hidden="true">${esc(u.initials)}</span>
                            <div class="pp-collab-user-info">
                              <div class="pp-collab-user-name">${esc(u.name)} <span class="pp-collab-user-role">${esc(u.role)}</span></div>
                              <div class="pp-collab-user-email">${esc(u.email)}</div>
                            </div>
                          </div>
                        `).join('');
                      })()}
                    </div>
                    <div class="pp-collab-no-results" data-collab-empty="${esc(p.id)}" hidden>No matching users found</div>
                  </div>
                </div>` : ''}
              </div>
              <div class="pp-team-line">
                <span class="pp-member-avatar-chip is-owner" tabindex="0" data-act="user-tooltip" aria-label="Project Owner: ${esc(owner.name)}">
                  <span class="pp-member-avatar">${esc(owner.initials)}</span>
                  <span class="pp-avatar-tooltip">
                    <span class="pp-avatar-tooltip-name">${esc(owner.name)}</span>
                    <span class="pp-avatar-tooltip-role">Project Owner</span>
                    <span class="pp-avatar-tooltip-email">${esc(owner.email)}</span>
                  </span>
                </span>
                <span class="pp-team-label">Owner</span>
              </div>
              <div class="pp-team-line">
                ${collabs.length ? `<div class="pp-member-avatars-wrap">
                  ${collabs.map((cb) => {
                    const m = resolveMember(cb);
                    return `<span class="pp-member-avatar-chip" tabindex="0" data-act="user-tooltip" aria-label="Collaborator: ${esc(m.name)}">
                      <span class="pp-member-avatar">${esc(m.initials)}</span>
                      <span class="pp-avatar-tooltip">
                        <span class="pp-avatar-tooltip-name">${esc(m.name)}</span>
                        <span class="pp-avatar-tooltip-role">${esc(m.role || 'Collaborator')}</span>
                        ${m.email ? `<span class="pp-avatar-tooltip-email">${esc(m.email)}</span>` : ''}
                      </span>
                      ${canEditTeam ? `<button type="button" class="pp-member-remove" data-act="del-collab" data-email="${esc(m.email || m.name)}" title="Remove collaborator ${esc(m.name)}" aria-label="Remove collaborator">✕</button>` : ''}
                    </span>`;
                  }).join('')}
                </div>` : ''}
                <span class="pp-team-label">Collaborators</span>
                ${collabs.length === 0 ? '<span class="pp-team-empty">No collaborators yet</span>' : ''}
              </div>
            </section>
          </div>
          <!-- Attachments: a footer band across the card -->
          <div class="pp-foot">
            <div class="pp-team-docs-container">
              <div class="pp-team-docs-left">
                <button type="button" class="pp-docs-toggle-btn${openDocs.has(p.id) ? ' on' : ''}" data-act="docs" aria-expanded="${openDocs.has(p.id)}" title="Toggle attachments dropdown">
                  <svg class="pp-docs-chev-icon${openDocs.has(p.id) ? ' open' : ''}" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
                </button>
                <button type="button" class="pp-docs-label-btn" data-act="docs" aria-expanded="${openDocs.has(p.id)}" title="Toggle project attachments">
                  <span class="pp-docs-label-text">View attachments</span>
                  <span class="pp-docs-count-pill">${nDocs}</span>
                </button>
              </div>
              <div class="pp-team-docs-right">
                ${statusOf(p) !== 'archive' ? `<button type="button" class="pp-btn pp-attach-inline" data-act="attach" title="Attach a document; the AI reads it and suggests the map changes it asks for">${B.AI_ICON || ''}<span>Upload suggestions</span></button>` : ''}
              </div>
            </div>
            ${openDocs.has(p.id) ? `<div class="pp-docs">${docs.filter((x) => x.projectId === p.id).map((x) => docRow(x)).join('') || '<div class="pp-doc-empty">No data attachments</div>'}</div>` : ''}
          </div>
        </div>`;
      }).join('');
      mountPeriods();
      const ri = list.querySelector('.pp-rename');
      if (ri) {
        let done = false;
        const finish = (save) => {
          if (done) return;
          done = true;
          const p = c.projects.find((x) => x.id === renaming);
          const val = ri.value.trim();
          if (save && p && val && val !== p.name) {
            p.name = val;
            if (c._markProjectInProgress) c._markProjectInProgress(p.id);
            c._saveProjects();
            if (c._updateHeaderProjectDisplay) c._updateHeaderProjectDisplay();
          }
          renaming = null;
          render();
        };
        ri.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
        ri.addEventListener('blur', () => finish(true));
        ri.focus(); ri.select();
      }
    };

    // The Temporary / Permanent choice and its dates live on this page, using the same picker as before
    const mountPeriods = () => {
      list.querySelectorAll('[data-period]').forEach((slot) => {
        const p = c.projects.find((x) => x.id === slot.dataset.period);
        if (!p) return;
        const box = c._buildProjectPeriod(p);
        slot.appendChild(box);
        // One "Forever" box in place of the Temporary / Permanent switch: ticked means no end date
        const head = box.querySelector('.project-period-head');
        if (head) head.style.display = 'none';
        const forever = isPermanent(p);
        const label = document.createElement('label');
        label.className = 'pp-forever';
        label.innerHTML = `<input type="checkbox"${forever ? ' checked' : ''} /> Forever`;
        label.title = forever ? 'Applies for good, from now' : 'Tick for no end date';
        label.querySelector('input').addEventListener('change', (e) => {
          const isPerm = e.target.checked;
          c._setProjectPeriodMode(p, isPerm ? 'permanent' : 'scheduled');
          const row = slot.closest('.pp-row');
          if (row) {
            const tag = row.querySelector('.pp-period-tag');
            if (tag) {
              tag.textContent = isPerm ? 'Permanent' : 'Temporary';
              tag.className = `pp-period-tag ${isPerm ? 'is-permanent' : 'is-temporary'}`;
              tag.title = `Effective period: ${isPerm ? 'Permanent' : 'Temporary'}`;
            }
          }
          setTimeout(render, 0);
        });
        // Forever sits in the Schedule panel's header; the dates fill the panel below it
        const panel = slot.closest('.pp-sched');
        const foreverSlot = panel && panel.querySelector('.pp-forever-slot');
        const range = box.querySelector('.project-period-range');
        if (foreverSlot) foreverSlot.appendChild(label);
        if (range) { if (!foreverSlot) range.insertBefore(label, range.querySelector('.project-period-summary')); }
        else {
          // Forever keeps the From date and time; only Until goes away
          const def = c._defaultApplyPeriod();
          const per = p.applyPeriod || {};
          const row = document.createElement('div');
          row.className = 'project-period-row';
          row.innerHTML = '<label class="project-period-label">From</label>';
          for (const [field, type, fb] of [['startDate', 'date', def.startDate], ['startTime', 'time', def.startTime]]) {
            const input = document.createElement('input');
            input.type = type;
            input.className = `project-period-input project-period-${type}`;
            input.dataset.field = field;
            input.value = per[field] || fb || '';
            input.setAttribute('aria-label', `From ${type}`);
            const save = () => {
              p.applyPeriod = Object.assign({}, p.applyPeriod, { [field]: input.value });
              if (c._markProjectInProgress) c._markProjectInProgress(p.id);
              c._saveProjects();
            };
            input.addEventListener('input', save);
            input.addEventListener('change', save);
            row.appendChild(input);
          }
          const wrapRow = document.createElement('div');
          wrapRow.className = 'project-period-range';
          wrapRow.appendChild(row);
          if (!foreverSlot) wrapRow.appendChild(label);
          box.appendChild(wrapRow);
        }
        c._updateProjectPeriodUI(p, slot);
        // The whole panel, so the Forever box in its header is locked too
        const lockScope = panel || slot;
        if (p.status === 'archive') {
          lockScope.querySelectorAll('input, button, select').forEach((el) => {
            el.disabled = true;
            el.title = 'Archived: the period can\'t be changed';
          });
        } else if (!isUserProjectOwner(p)) {
          lockScope.querySelectorAll('input, button, select').forEach((el) => {
            el.disabled = true;
            el.title = 'Project timeline is managed by the Project Owner';
          });
        }
        slot.addEventListener('click', (e) => { if (e.target.closest('.project-period-opt')) setTimeout(render, 0); }, true);
        const sync = (checkSchedule = false) => {
          if (checkSchedule && c._syncProjectScheduleStatuses) {
            c._syncProjectScheduleStatuses({ silent: true });
          }
          const row = slot.closest('.pp-row');
          const sel = row && row.querySelector('.pp-status-select');
          if (sel && sel.value !== statusOf(p)) {
            sel.value = statusOf(p);
            sel.className = `pp-status-select st-${statusOf(p)}`;
            const chips = document.getElementById('pp-status-tabs');
            if (chips) {
              const n = (key) => c.projects.filter((x) => showsInProjectMenu(x) && (key === 'all' ? statusOf(x) !== 'archive' : statusOf(x) === key)).length;
              chips.querySelectorAll('.pp-status-tab').forEach((ch) => {
                const k = ch.dataset.status;
                const cnt = n(k);
                const badge = ch.querySelector('.pp-status-tab-n');
                if (badge) badge.textContent = String(cnt);
                if (k !== 'all') ch.disabled = !cnt;
              });
            }
          }
          const btn = row && row.querySelector('.pp-apply');
          if (btn) {
            const period = c._readProjectPeriod(p);
            btn.textContent = c._periodApplyLabel(period);
            btn.disabled = !!period.error;
          }
          // Recompute the 6 affected numbers live when the project's schedule changes
          if (checkSchedule && row) {
            briefCache.delete(p.id);
            countsCache.delete(p.id);
            const meta = row.querySelector('.pp-meta');
            if (meta) meta.innerHTML = changeStats(details(p).brief);
            if (p.id === c.activeProjectId && c._syncForeignObstacles) {
              c._foreignKey = null;
              c._syncForeignObstacles();
            }
          }
        };
        slot.addEventListener('input', () => sync(false));
        slot.addEventListener('change', () => sync(true));
        sync(false);
      });
    };

    const applied = c._confirmApplyProject;
    c._confirmApplyProject = function () { const r = applied.apply(this, arguments); setTimeout(render, 150); return r; };

    const navHome = document.getElementById('nav-item-home');
    const navProjects = document.getElementById('nav-item-projects');
    const navUsers = document.getElementById('nav-item-users');
    const homePage = document.getElementById('home-page');
    const projectsPage = document.getElementById('projects-page');
    const usersPage = document.getElementById('users-page');
    const settingsPage = document.getElementById('settings-page');
    const navSettings = document.getElementById('nav-item-settings');
    const setNavSettings = (on) => {
      if (!navSettings) return;
      navSettings.classList.toggle('active', on);
      if (on) navSettings.setAttribute('aria-current', 'page'); else navSettings.removeAttribute('aria-current');
    };

    let currentMainView = 'home';
    let mapReturnView = 'projects';
    let usersSearchQuery = '';
    let usersRoleFilter = new Set(['all']);
    let usersStatusFilter = new Set(['all']);
    let usersSort = { key: 'name', dir: 1 };
    let usersPageNum = 1;
    let usersRevealId = null; // a user just invited: their page opens
    let rolesSort = { key: 'name', dir: 1 };
    let rolesPageNum = 1;
    let rolesSearchQuery = '';
    let rolesRevealId = null; // a role just created: its page opens
    const USERS_PER_PAGE = 10;

    const DEFAULT_SYSTEM_FEATURES = [
      { id: 'map_editing', name: 'Map editing' },
      { id: 'project_management', name: 'Project management' },
      { id: 'export', name: 'Export' }
    ];

    const DEFAULT_SYSTEM_ROLES = [
      {
        id: 'admin',
        name: 'Admin',
        isSystem: true,
        perms: { map_editing: true, project_management: true, export: true, routes: true, closures: true, projects: true, apply: true, ai: true, admin: true }
      },
      {
        id: 'bus-ops',
        name: 'Bus Ops',
        isSystem: true,
        perms: { map_editing: true, project_management: true, export: true, routes: true, closures: true, projects: true, apply: false, ai: true, admin: false }
      }
    ];

    const getSystemRoles = () => {
      try {
        const raw = localStorage.getItem('brass_system_roles');
        if (raw) {
          const list = JSON.parse(raw);
          if (Array.isArray(list) && list.length) {
            list.forEach((r) => {
              if (r.perms) {
                if (r.perms.map_editing === undefined) r.perms.map_editing = r.perms.routes !== false;
                if (r.perms.project_management === undefined) r.perms.project_management = r.perms.projects !== false;
                if (r.perms.export === undefined) r.perms.export = true;
              }
            });
            return list;
          }
        }
      } catch (e) {}
      try { localStorage.setItem('brass_system_roles', JSON.stringify(DEFAULT_SYSTEM_ROLES)); } catch (e) {}
      return DEFAULT_SYSTEM_ROLES;
    };

    const saveSystemRoles = (roles) => {
      try { localStorage.setItem('brass_system_roles', JSON.stringify(roles)); } catch (e) {}
    };

    // The sample users have no history, so each starts with a sample date; a real change replaces it
    const SAMPLE_UPDATED_DAYS_AGO = { admin: 34.2, 'bops-1': 2.6, 'bops-2': 9.1, 'lead-1': 5.4, 'eng-1': 16.7, 'ops-3': 1.3 };
    const stampSampleUpdate = (u) => {
      if (!u.updatedAt) u.updatedAt = Date.now() - (SAMPLE_UPDATED_DAYS_AGO[u.id] || 0) * 86400000;
    };

    const getAccessUsers = () => {
      const roles = getSystemRoles();
      const validRoleNames = new Set(roles.map((r) => r.name));
      try {
        const raw = localStorage.getItem('brass_user_access_control');
        if (raw) {
          const list = JSON.parse(raw);
          if (Array.isArray(list) && list.length) {
            list.forEach((u) => {
              if (u.role !== 'Admin' && !validRoleNames.has(u.role)) {
                u.role = 'Bus Ops';
              }
            });
            if (list.some((u) => !u.updatedAt)) {
              list.forEach(stampSampleUpdate);
              try { localStorage.setItem('brass_user_access_control', JSON.stringify(list)); } catch (e) {}
            }
            return list;
          }
        }
      } catch (e) {}

      const defs = [
        { id: 'admin', name: 'Alex Tan', role: 'Admin', initials: 'AT', email: 'alex.tan@brass.sg', status: 'active' },
        { id: 'bops-1', name: 'John Doe', role: 'Bus Ops', initials: 'JD', email: 'john.doe@brass.sg', status: 'active' },
        { id: 'bops-2', name: 'Sarah Lim', role: 'Bus Ops', initials: 'SL', email: 'sarah.lim@brass.sg', status: 'active' },
        { id: 'lead-1', name: 'Marcus Chen', role: 'Bus Ops', initials: 'MC', email: 'marcus.chen@brass.sg', status: 'active' },
        { id: 'eng-1', name: 'Priya Sharma', role: 'Bus Ops', initials: 'PS', email: 'priya.sharma@brass.sg', status: 'active' },
        { id: 'ops-3', name: 'David Wong', role: 'Bus Ops', initials: 'DW', email: 'david.wong@brass.sg', status: 'active' },
      ];
      defs.forEach(stampSampleUpdate);
      try { localStorage.setItem('brass_user_access_control', JSON.stringify(defs)); } catch (e) {}
      return defs;
    };

    const saveAccessUsers = (usersList) => {
      try { localStorage.setItem('brass_user_access_control', JSON.stringify(usersList)); } catch (e) {}
      B.SYSTEM_USERS = usersList;
    };

    const markSortHeaders = (viewId, sort) => {
      document.querySelectorAll(`#${viewId} .users-sort`).forEach((b) => {
        const on = b.dataset.sort === sort.key;
        b.classList.toggle('is-asc', on && sort.dir > 0);
        b.classList.toggle('is-desc', on && sort.dir < 0);
        b.title = on && sort.dir > 0 ? 'Sort descending' : 'Sort ascending';
      });
    };

    // Sorts a table's rows, cuts out the current page and draws its pager.
    const pageTableRows = ({ rows, sortValue, sort, page, revealId, pager }) => {
      const sorted = rows.slice().sort((a, b) => {
        const va = sortValue(a), vb = sortValue(b);
        const order = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb), undefined, { sensitivity: 'base' });
        return (order * sort.dir) || a.name.localeCompare(b.name);
      });
      const revealAt = revealId ? sorted.findIndex((row) => row.id === revealId) : -1;
      const pageCount = Math.max(1, Math.ceil(sorted.length / USERS_PER_PAGE));
      const pageNum = revealAt >= 0 ? Math.floor(revealAt / USERS_PER_PAGE) + 1 : Math.min(page, pageCount);
      const firstRow = (pageNum - 1) * USERS_PER_PAGE;
      const pageRows = sorted.slice(firstRow, firstRow + USERS_PER_PAGE);

      if (pager) {
        const pageBtns = Array.from({ length: pageCount }, (_, i) => i + 1)
          .map((n) => `<button type="button" class="users-page-btn${n === pageNum ? ' active' : ''}" data-page="${n}"${n === pageNum ? ' aria-current="page"' : ''}>${n}</button>`).join('');
        pager.innerHTML = `
          <span class="users-pager-count">${firstRow + 1}–${firstRow + pageRows.length} of ${sorted.length}</span>
          <div class="users-pager-btns">
            <button type="button" class="users-page-btn" data-page="${pageNum - 1}" aria-label="Previous page" title="Previous page"${pageNum === 1 ? ' disabled' : ''}>‹</button>
            ${pageBtns}
            <button type="button" class="users-page-btn" data-page="${pageNum + 1}" aria-label="Next page" title="Next page"${pageNum === pageCount ? ' disabled' : ''}>›</button>
          </div>`;
      }
      return { pageRows, pageNum };
    };

    const renderRoleSettings = () => {
      const body = document.getElementById('roles-list-body');
      if (!body) return;
      const users = getAccessUsers();
      const q = rolesSearchQuery.trim().toLowerCase();
      const rows = getSystemRoles()
        .filter((r) => !q || r.name.toLowerCase().includes(q))
        .map((r) => ({ ...r, members: users.filter((u) => u.role === r.name).length }));

      markSortHeaders('users-view-roles', rolesSort);
      const pager = document.getElementById('roles-pager');
      if (!rows.length) {
        body.innerHTML = `<div class="users-empty-message">No matching roles found</div>`;
        if (pager) pager.innerHTML = '';
        return;
      }

      const { pageRows, pageNum } = pageTableRows({
        rows,
        sortValue: rolesSort.key === 'members' ? (r) => r.members : (r) => r.name,
        sort: rolesSort,
        page: rolesPageNum,
        revealId: rolesRevealId,
        pager,
      });
      rolesPageNum = pageNum;
      rolesRevealId = null;

      body.innerHTML = pageRows.map((r) => `
        <div class="users-table-row" data-role-id="${esc(r.id)}">
          <div class="users-name">${esc(r.name)}</div>
          <div class="roles-col-members">${r.members}</div>
          <div class="roles-col-actions">
            <button type="button" class="btn-role-icon-action" data-act="edit-role" data-role-id="${esc(r.id)}" title="Edit role" aria-label="Edit role ${esc(r.name)}">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
              </svg>
            </button>
            ${!r.isSystem ? `
              <button type="button" class="btn-role-icon-action btn-role-icon-delete" data-act="delete-role" data-role-id="${esc(r.id)}" title="Delete role" aria-label="Delete role ${esc(r.name)}">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  <line x1="10" y1="11" x2="10" y2="17"></line>
                  <line x1="14" y1="11" x2="14" y2="17"></line>
                </svg>
              </button>
            ` : ''}
          </div>
        </div>
      `).join('');
    };

    const showUsersView = (view) => {
      const isRoles = view === 'roles';
      const viewMembers = document.getElementById('users-view-members');
      const viewRoles = document.getElementById('users-view-roles');
      const title = document.getElementById('users-top-title');
      if (viewMembers) viewMembers.hidden = isRoles;
      if (viewRoles) viewRoles.hidden = !isRoles;
      if (title) title.textContent = isRoles ? 'Role Settings' : 'User';
      if (isRoles) renderRoleSettings();
      else renderUsersAccessControl();
    };

    const openRoleModal = (role = null) => {
      const modal = document.getElementById('role-modal');
      const titleEl = document.getElementById('role-modal-title');
      const idInp = document.getElementById('role-input-id');
      const nameInp = document.getElementById('role-input-name');
      const descInp = document.getElementById('role-input-desc');
      const listEl = document.getElementById('role-perms-list');
      if (!modal || !titleEl || !nameInp || !listEl) return;

      const isEdit = Boolean(role && role.id);
      titleEl.textContent = isEdit ? `Edit Role: ${role.name}` : 'Create Role';
      idInp.value = isEdit ? role.id : '';
      nameInp.value = isEdit ? role.name : '';
      if (descInp) descInp.value = isEdit ? (role.desc || '') : '';

      // Delete is for roles people created; the built-in ones stay
      const delBtn = document.getElementById('btn-role-modal-delete');
      if (delBtn) {
        const builtIn = Boolean(isEdit && role.isSystem);
        delBtn.hidden = !isEdit;
        delBtn.disabled = builtIn;
        delBtn.title = builtIn ? "Built-in roles can't be deleted" : '';
      }

      // Primary Admin role name cannot be modified
      nameInp.disabled = Boolean(isEdit && role.id === 'admin');

      const currentPerms = isEdit ? (role.perms || {}) : { map_editing: true, project_management: true, export: true };

      listEl.innerHTML = DEFAULT_SYSTEM_FEATURES.map((f) => {
        const checked = Boolean(currentPerms[f.id]);
        return `
          <div class="role-perm-toggle-row">
            <span class="role-perm-title">${esc(f.name)}</span>
            <label class="user-toggle-switch" title="Toggle permission for ${esc(f.name)}">
              <input type="checkbox" class="user-toggle-input role-perm-checkbox" data-feature="${esc(f.id)}" ${checked ? 'checked' : ''} />
              <span class="user-toggle-slider"></span>
            </label>
          </div>
        `;
      }).join('');

      modal.classList.remove('hidden');
      setTimeout(() => {
        if (!nameInp.disabled) nameInp.focus();
      }, 50);
    };

    const closeRoleModal = () => {
      const modal = document.getElementById('role-modal');
      if (modal) modal.classList.add('hidden');
    };

    // Asks first, in the small pop-up; the role's members move to Bus Ops
    const confirmDeleteRole = (rid) => {
      const role = getSystemRoles().find((r) => r.id === rid);
      if (!role || role.isSystem) return;
      const users = getAccessUsers();
      const members = users.filter((u) => u.role === role.name);
      const text = members.length
        ? `${members.length} member${members.length === 1 ? '' : 's'} will move to Bus Ops.`
        : 'No members have this role.';
      B.askConfirm(`Delete ${role.name}?`, text, () => {
        members.forEach((u) => { u.role = 'Bus Ops'; u.updatedAt = Date.now(); });
        if (members.length) saveAccessUsers(users);
        saveSystemRoles(getSystemRoles().filter((r) => r.id !== rid));
        closeRoleModal();
        toast(`Role "${role.name}" deleted`, 'info');
        renderRoleSettings();
        renderUsersAccessControl();
      });
    };

    const renderUsersAccessControl = () => {
      if (!usersPage) return;
      const users = getAccessUsers();
      const roles = getSystemRoles();

      // Dynamically sync role filter options in the dropdown menu
      const checkSvg = `<svg class="users-filter-check-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
      const roleListEl = document.getElementById('users-filter-role-list');
      if (roleListEl) {
        roleListEl.innerHTML = `
          <button type="button" class="users-filter-menu-item ${usersRoleFilter.has('all') ? 'active' : ''}" data-filter="all">
            <span class="users-filter-checkbox" aria-hidden="true">${checkSvg}</span>
            <span class="users-filter-item-name">All Roles</span>
          </button>
          ${roles.map((r) => `
            <button type="button" class="users-filter-menu-item ${usersRoleFilter.has(r.name) ? 'active' : ''}" data-filter="${esc(r.name)}">
              <span class="users-filter-checkbox" aria-hidden="true">${checkSvg}</span>
              <span class="users-filter-item-name">${esc(r.name)}</span>
            </button>
          `).join('')}
        `;
      }

      // Update status options active state in filter menu
      const statusListEl = document.getElementById('users-filter-status-list');
      if (statusListEl) {
        statusListEl.innerHTML = `
          <button type="button" class="users-filter-menu-item ${usersStatusFilter.has('all') ? 'active' : ''}" data-status="all">
            <span class="users-filter-checkbox" aria-hidden="true">${checkSvg}</span>
            <span class="users-filter-item-name">All Status</span>
          </button>
          <button type="button" class="users-filter-menu-item ${usersStatusFilter.has('active') ? 'active' : ''}" data-status="active">
            <span class="users-filter-checkbox" aria-hidden="true">${checkSvg}</span>
            <span class="users-filter-item-name">Active</span>
          </button>
          <button type="button" class="users-filter-menu-item ${usersStatusFilter.has('suspended') ? 'active' : ''}" data-status="suspended">
            <span class="users-filter-checkbox" aria-hidden="true">${checkSvg}</span>
            <span class="users-filter-item-name">Suspended</span>
          </button>
          <button type="button" class="users-filter-menu-item ${usersStatusFilter.has('invited') ? 'active' : ''}" data-status="invited">
            <span class="users-filter-checkbox" aria-hidden="true">${checkSvg}</span>
            <span class="users-filter-item-name">Invited</span>
          </button>
        `;
      }

      // Update filter button label and active styling
      const filterBtn = document.getElementById('users-filter-btn');
      const filterLabel = document.getElementById('users-filter-label');
      if (filterBtn && filterLabel) {
        const hasRole = !usersRoleFilter.has('all') && usersRoleFilter.size > 0;
        const hasStatus = !usersStatusFilter.has('all') && usersStatusFilter.size > 0;
        const roleLabel = hasRole ? Array.from(usersRoleFilter).join(', ') : '';
        const statusLabel = hasStatus ? Array.from(usersStatusFilter).map((s) => s[0].toUpperCase() + s.slice(1)).join(', ') : '';

        if (hasRole && hasStatus) {
          filterLabel.textContent = `${roleLabel} · ${statusLabel}`;
          filterBtn.classList.add('is-active');
        } else if (hasRole) {
          filterLabel.textContent = roleLabel;
          filterBtn.classList.add('is-active');
        } else if (hasStatus) {
          filterLabel.textContent = statusLabel;
          filterBtn.classList.add('is-active');
        } else {
          filterLabel.textContent = 'Filter';
          filterBtn.classList.remove('is-active');
        }
      }

      // Wire filter dropdown interactions
      const filterMenu = document.getElementById('users-filter-menu');
      if (filterBtn && filterMenu && !filterBtn._wired) {
        filterBtn._wired = true;
        filterBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const isHidden = filterMenu.hidden;
          filterMenu.hidden = !isHidden;
          filterBtn.setAttribute('aria-expanded', String(isHidden));
        });

        document.addEventListener('click', (e) => {
          if (!filterMenu.hidden && !filterMenu.contains(e.target) && e.target !== filterBtn && !filterBtn.contains(e.target)) {
            filterMenu.hidden = true;
            filterBtn.setAttribute('aria-expanded', 'false');
          }
        });

        filterMenu.addEventListener('click', (e) => {
          e.stopPropagation();
          usersPageNum = 1;
          const roleBtn = e.target.closest('[data-filter]');
          if (roleBtn) {
            const role = roleBtn.dataset.filter || 'all';
            if (role === 'all') {
              usersRoleFilter = new Set(['all']);
            } else {
              usersRoleFilter.delete('all');
              if (usersRoleFilter.has(role)) {
                usersRoleFilter.delete(role);
                if (usersRoleFilter.size === 0) usersRoleFilter.add('all');
              } else {
                usersRoleFilter.add(role);
                if (roles.length && roles.every((r) => usersRoleFilter.has(r.name))) {
                  usersRoleFilter = new Set(['all']);
                }
              }
            }
            renderUsersAccessControl();
            return;
          }

          const statusBtn = e.target.closest('[data-status]');
          if (statusBtn) {
            const st = statusBtn.dataset.status || 'all';
            if (st === 'all') {
              usersStatusFilter = new Set(['all']);
            } else {
              usersStatusFilter.delete('all');
              if (usersStatusFilter.has(st)) {
                usersStatusFilter.delete(st);
                if (usersStatusFilter.size === 0) usersStatusFilter.add('all');
              } else {
                usersStatusFilter.add(st);
                if (['active', 'suspended', 'invited'].every((x) => usersStatusFilter.has(x))) {
                  usersStatusFilter = new Set(['all']);
                }
              }
            }
            renderUsersAccessControl();
            return;
          }
        });
      }

      // Filtered users by role, status, and search query
      const q = (usersSearchQuery || '').trim().toLowerCase();
      const filtered = users.filter((u) => {
        if (!usersRoleFilter.has('all') && !usersRoleFilter.has(u.role)) return false;
        if (!usersStatusFilter.has('all') && !usersStatusFilter.has(u.status || 'active')) return false;
        if (q) {
          const hay = `${u.name} ${u.role} ${u.email}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      const body = document.getElementById('users-list-body');
      if (!body) return;

      markSortHeaders('users-view-members', usersSort);

      const pager = document.getElementById('users-pager');
      if (!filtered.length) {
        body.innerHTML = `<div class="users-empty-message">No matching team members found</div>`;
        if (pager) pager.innerHTML = '';
        return;
      }

      const sortValue = { name: (u) => u.name, role: (u) => u.role, updated: (u) => u.updatedAt || 0, status: (u) => u.status || 'active' }[usersSort.key];
      const { pageRows, pageNum } = pageTableRows({ rows: filtered, sortValue, sort: usersSort, page: usersPageNum, revealId: usersRevealId, pager });
      usersPageNum = pageNum;
      usersRevealId = null;

      body.innerHTML = pageRows.map((u) => {
        const isSuspended = u.status === 'suspended';
        const isPrimaryAdmin = u.id === 'admin';
        return `
          <div class="users-table-row ${isSuspended ? 'is-suspended' : ''}" data-user-id="${esc(u.id)}">
            <div class="users-col-member">
              <span class="users-avatar ${u.role === 'Admin' ? 'is-admin' : ''}">${esc(u.initials)}</span>
              <div class="users-meta">
                <div class="users-name">${esc(u.name)}</div>
                <div class="users-email">${esc(u.email)}</div>
              </div>
            </div>

            <div class="users-col-role">
              <select class="users-role-select" data-act="change-role" data-user-id="${esc(u.id)}" ${isPrimaryAdmin ? 'disabled title="Primary Administrator role cannot be changed"' : ''}>
                ${roles.map((r) => `<option value="${esc(r.name)}" ${u.role === r.name ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
              </select>
            </div>

            <div class="users-col-updated">${u.updatedAt ? fmt(u.updatedAt) : '–'}</div>

            <div class="users-col-status" style="display: flex; align-items: center; justify-content: flex-end;">
              ${u.status === 'invited' ? `<span class="users-status-badge invited">Invited</span>` : isPrimaryAdmin ? `
                <label class="user-toggle-switch is-disabled" title="Primary Administrator access is permanently protected">
                  <input type="checkbox" checked disabled class="user-toggle-input" />
                  <span class="user-toggle-slider is-protected"></span>
                </label>
              ` : `
                <label class="user-toggle-switch" title="${isSuspended ? 'Click to activate access' : 'Click to suspend access'}">
                  <input type="checkbox" class="user-toggle-input" data-user-id="${esc(u.id)}" ${!isSuspended ? 'checked' : ''} />
                  <span class="user-toggle-slider"></span>
                </label>
              `}
            </div>
          </div>
        `;
      }).join('');
    };

    // ------------------------------------------------------------- Home Page: Interactive Variation Map, Date-Range Slider & KPIs
    const homeStage = document.getElementById('home-map-stage');
    const homeCanvas = document.getElementById('home-map-canvas');
    const homeTlFrom = document.getElementById('home-tl-from');
    const homeTlTo = document.getElementById('home-tl-to');
    const homeTlSlider = document.getElementById('home-tl-slider');
    const homeTlPlayBtn = document.getElementById('home-tl-play');
    const homeTlTodayBtn = document.getElementById('home-tl-today') || document.getElementById('home-tl-now');
    const homeTlIncludeDrafts = document.getElementById('home-tl-include-drafts');
    const homeTlChangesOnly = document.getElementById('home-tl-changes-only');
    const homeTlSpans = document.getElementById('home-tl-spans');
    const homeTlTicks = document.getElementById('home-tl-ticks');
    const homeTlNowMark = document.getElementById('home-tl-now-mark');
    const homeTlScale = document.getElementById('home-tl-scale');
    const homeProjBrief = document.getElementById('home-proj-brief');
    const homePbTabs = document.getElementById('home-pb-tabs');
    const homePbTitle = document.getElementById('home-pb-title');
    const homePbPeriod = document.getElementById('home-pb-period');
    const homePbBadge = document.getElementById('home-pb-badge');
    const homePbMoreBtn = document.getElementById('home-pb-more-btn');

    let homeStore = null;
    let homeRenderer = null;
    let homeInitialFitted = false;
    let homeRange = null; // { from, to }
    let homeTimelineData = null; // { baseDoc, intervals, totalVisibleProjects }
    let homeActiveSig = null;
    let homeLastSim = null; // cached simulation stats at active interval signature
    let homeChangesBBox = null;
    let homePlayRaf = null;
    let homePlayLastTs = 0;
    let homeCompareMode = 'after'; // 'before' | 'after'
    let homeSelectedBriefId = null;
    let homeBriefShownId = null; // the project the popover last showed, to animate it when another is chosen
    let homeBriefClosed = false; // closed by a click on the map; a flag opens it again
    let homeBriefRenderKey = null;
    let homeBriefAction = null;

    const DAY_MS = 86400000;
    const toLocalDateStr = (ts) => {
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const parseLocalDayStart = (str) => (str ? new Date(`${str}T00:00:00`).getTime() : NaN);
    const parseLocalDayEnd = (str) => (str ? new Date(`${str}T23:59:59.999`).getTime() : NaN);

    const pauseHomePlayback = () => {
      if (homePlayRaf) {
        cancelAnimationFrame(homePlayRaf);
        homePlayRaf = null;
      }
      homePlayLastTs = 0;
      if (homeTlPlayBtn) {
        homeTlPlayBtn.classList.remove('is-playing');
        homeTlPlayBtn.textContent = '▶';
        homeTlPlayBtn.title = 'Play date-range variation';
        homeTlPlayBtn.setAttribute('aria-label', 'Play timeline');
      }
    };

    const ensureHomeMap = () => {
      if (homeRenderer || !homeCanvas || !app || !app.city || !app.net || !app.store) return;
      homeStore = Object.create(B.Store.prototype);
      homeStore.city = app.city;
      homeStore.net = app.net;
      homeStore.legCache = app.store.legCache;
      homeStore.past = [];
      homeStore.future = [];
      homeStore.tx = null;
      homeStore.rev = 0;
      homeStore.doc = JSON.parse(JSON.stringify(app.store.doc));
      homeStore.derive();

      homeRenderer = new B.MapRenderer(homeCanvas, app.city, app.net, homeStore);
      homeRenderer.mode = 'view';
      // The running projects' pins and popover kept on the map as it moves (their areas aren't drawn)
      homeRenderer.onRender = () => positionHomePins();
      if (app.renderer) {
        Object.assign(homeRenderer.layers, app.renderer.layers);
        if (typeof app.renderer.mapOpacity === 'number') {
          homeRenderer.setMapOpacity(app.renderer.mapOpacity);
        }
      }
      // Keep Home variation map clean: disable stop points and stop names by default
      homeRenderer.layers.stopPoints = false;
      homeRenderer.layers.stopNames = false;
      syncHomeLayersUI();
      window.brassHomeRenderer = homeRenderer;

      // Resize observer so layout shifts (sidebar toggle, window resize, first unhide) fit cleanly
      if (homeStage && typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
          if (!homeRenderer || (homePage && homePage.hidden)) return;
          homeRenderer.resize();
          if (!homeInitialFitted && homeRenderer.width > 40 && homeRenderer.height > 40) {
            homeInitialFitted = true;
            homeRenderer.fitToBoundary(0.06);
          }
          renderHomeTimelineScale();
        });
        ro.observe(homeStage);
      }

      // Drag-to-pan and wheel-to-zoom on Home map canvas
      let dragging = false;
      let lastX = 0, lastY = 0;
      homeCanvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        homeRenderer.cameraAnim = null;
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging || !homeRenderer) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        homeRenderer.camera.x -= dx / homeRenderer.camera.zoom;
        homeRenderer.camera.y -= dy / homeRenderer.camera.zoom;
        homeRenderer.requestRender();
      });
      window.addEventListener('mouseup', () => { dragging = false; });

      homeCanvas.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        dragging = true;
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
        homeRenderer.cameraAnim = null;
      }, { passive: true });
      homeCanvas.addEventListener('touchmove', (e) => {
        if (!dragging || e.touches.length !== 1 || !homeRenderer) return;
        const dx = e.touches[0].clientX - lastX;
        const dy = e.touches[0].clientY - lastY;
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
        homeRenderer.camera.x -= dx / homeRenderer.camera.zoom;
        homeRenderer.camera.y -= dy / homeRenderer.camera.zoom;
        homeRenderer.requestRender();
      }, { passive: true });
      homeCanvas.addEventListener('touchend', () => { dragging = false; }, { passive: true });

      homeCanvas.addEventListener('wheel', (e) => {
        if (!homeRenderer) return;
        e.preventDefault();
        const rect = homeCanvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const factor = Math.pow(1.0018, -e.deltaY);
        homeRenderer.zoomAt(sx, sy, factor);
      }, { passive: false });

      homeCanvas.addEventListener('dblclick', (e) => {
        if (!homeRenderer) return;
        const rect = homeCanvas.getBoundingClientRect();
        homeRenderer.zoomAt(e.clientX - rect.left, e.clientY - rect.top, 1.65);
      });

      const zIn = document.getElementById('home-map-zoom-in');
      const zOut = document.getElementById('home-map-zoom-out');
      const zFit = document.getElementById('home-map-fit');
      if (zIn) zIn.addEventListener('click', () => homeRenderer && homeRenderer.zoomAt(homeRenderer.width / 2, homeRenderer.height / 2, 1.35));
      if (zOut) zOut.addEventListener('click', () => homeRenderer && homeRenderer.zoomAt(homeRenderer.width / 2, homeRenderer.height / 2, 1 / 1.35));
      if (zFit) zFit.addEventListener('click', () => homeRenderer && homeRenderer.fitToBoundary(0.06));

      initHomeSearch();
    };

    // ------------------------------------------------------------- Home Map Search ("just a search")
    const initHomeSearch = () => {
      const searchWrap = document.getElementById('home-map-search-wrap');
      const searchInput = document.getElementById('home-map-search-input');
      const searchClear = document.getElementById('home-map-search-clear');
      const searchDropdown = document.getElementById('home-map-search-dropdown');
      const searchResults = document.getElementById('home-map-search-results');

      if (!searchInput || !searchDropdown || !searchResults) return;

      let selectedIndex = -1;
      let currentItems = [];
      let entitiesCache = null;

      const getEntities = () => {
        const list = [];
        const doc = (homeStore && homeStore.doc) || (app.store ? app.store.doc : null);
        if (!doc) return list;

        // 1. Bus Routes
        if (doc.routes) {
          Object.values(doc.routes).forEach((r) => {
            const num = String(r.number || '').trim();
            if (!num) return;
            const s0 = r.anchors && r.anchors[0] && doc.stops && doc.stops[r.anchors[0].id];
            const sEnd = r.anchors && r.anchors.length > 1 && doc.stops && doc.stops[r.anchors[r.anchors.length - 1].id];
            const fromName = s0 ? (s0.name || s0.code) : '';
            const toName = sEnd ? (sEnd.name || sEnd.code) : '';
            const sub = fromName && toName ? `${fromName} ⇄ ${toName}` : `${(r.anchors || []).length} stops`;
            list.push({
              type: 'route',
              id: r.id,
              num,
              title: `Bus ${num}`,
              sub,
              searchStr: `bus ${num} ${fromName} ${toName}`.toLowerCase(),
              obj: r
            });
          });
        }

        // 2. Bus Stops & Interchanges
        if (doc.stops) {
          Object.values(doc.stops).forEach((s) => {
            const isInt = B.isInterchange ? B.isInterchange(s) : (s.name && /int|interchange/i.test(s.name));
            const pt = (homeRenderer && typeof homeRenderer.stopPoint === 'function')
              ? homeRenderer.stopPoint(s)
              : (app.net && app.net.posPoint ? app.net.posPoint(s, 0.78) : { x: s.x || 0, y: s.y || 0 });
            const title = s.name || `Bus Stop ${s.code || s.id}`;
            const sub = s.code ? `Code: ${s.code}` : (s.road || 'Bus Stop');
            list.push({
              type: isInt ? 'interchange' : 'stop',
              id: s.id,
              code: s.code || '',
              title,
              sub,
              searchStr: `${title} ${s.code || ''} ${s.road || ''} ${isInt ? 'interchange int' : 'bus stop'}`.toLowerCase(),
              obj: s,
              x: pt ? pt.x : (s.x || 0),
              y: pt ? pt.y : (s.y || 0)
            });
          });
        }

        // 3. MRT Stations
        const mrtList = (app.city && app.city.mrtStations) || (app.net && app.net.mrtStations) || [];
        mrtList.forEach((m) => {
          const name = m.name || 'MRT Station';
          const code = m.code || '';
          list.push({
            type: 'mrt',
            id: m.id,
            code,
            title: `${name} MRT`,
            sub: code || 'MRT Network',
            searchStr: `${name} ${code} mrt station train`.toLowerCase(),
            obj: m,
            x: m.x,
            y: m.y
          });
        });

        // 4. Roads
        const seenRoads = new Set();
        if (app.net && app.net.edges) {
          app.net.edges.forEach((e) => {
            if (!e || !e.name || seenRoads.has(e.name.toLowerCase())) return;
            seenRoads.add(e.name.toLowerCase());
            let mx = 0, my = 0;
            if (e.pts && e.pts.length) {
              const mid = e.pts[Math.floor(e.pts.length / 2)];
              mx = mid.x;
              my = mid.y;
            } else if (app.city && app.city.nodes && e.from != null && e.to != null) {
              const n1 = app.city.nodes[e.from], n2 = app.city.nodes[e.to];
              if (n1 && n2) { mx = (n1.x + n2.x) / 2; my = (n1.y + n2.y) / 2; }
            }
            list.push({
              type: 'road',
              id: 'road_' + e.id,
              title: e.name,
              sub: 'Road',
              searchStr: `${e.name} road street ave avenue expressway blvd`.toLowerCase(),
              edge: e,
              x: mx,
              y: my
            });
          });
        }

        return list;
      };

      const performSearch = (q) => {
        const query = (q || '').trim().toLowerCase();
        if (!query) {
          searchDropdown.hidden = true;
          currentItems = [];
          selectedIndex = -1;
          return;
        }

        if (!entitiesCache) entitiesCache = getEntities();

        const exactBus = [];
        const prefixMatches = [];
        const otherMatches = [];

        for (const item of entitiesCache) {
          if (item.type === 'route') {
            if (item.num.toLowerCase() === query) {
              exactBus.unshift(item);
            } else if (item.num.toLowerCase().startsWith(query)) {
              exactBus.push(item);
            } else if (item.searchStr.includes(query)) {
              otherMatches.push(item);
            }
          } else if (item.code && item.code.toLowerCase().startsWith(query)) {
            prefixMatches.unshift(item);
          } else if (item.title.toLowerCase().startsWith(query)) {
            prefixMatches.push(item);
          } else if (item.searchStr.includes(query)) {
            otherMatches.push(item);
          }
        }

        currentItems = [...exactBus, ...prefixMatches, ...otherMatches].slice(0, 10);
        selectedIndex = -1;
        renderResults(query);
      };

      const renderResults = (query) => {
        if (!currentItems.length) {
          searchResults.innerHTML = `<div class="home-search-empty">No results found for "${esc(query)}"</div>`;
          searchDropdown.hidden = false;
          return;
        }

        const badgeLabels = {
          route: 'Bus',
          stop: 'Stop',
          interchange: 'INT',
          mrt: 'MRT',
          road: 'Road',
          address: 'Address'
        };

        searchResults.innerHTML = currentItems.map((item, idx) => `
          <button type="button" class="home-search-item ${idx === selectedIndex ? 'is-selected' : ''}" data-idx="${idx}" role="option" aria-selected="${idx === selectedIndex}">
            <span class="home-search-item-badge home-search-badge-${item.type}">${badgeLabels[item.type] || item.type}</span>
            <div class="home-search-item-info">
              <span class="home-search-item-title">${esc(item.title)}</span>
              <span class="home-search-item-sub">${esc(item.sub)}</span>
            </div>
          </button>
        `).join('');

        searchDropdown.hidden = false;
      };

      const selectItem = (item) => {
        if (!item || !homeRenderer) return;
        searchInput.value = item.title;
        searchClear.hidden = false;
        searchDropdown.hidden = true;
        currentItems = [];

        if (item.type === 'route') {
          const doc = (homeStore && homeStore.doc) || (app.store ? app.store.doc : null);
          const r = item.obj || (doc && doc.routes && doc.routes[item.id]);
          if (!r) return;
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          const g = (homeStore && homeStore.geom && homeStore.geom[r.id]) || (app.store && app.store.geom && app.store.geom[r.id]);
          if (g && g.legs) {
            for (const l of g.legs) {
              for (const p of l.pts || []) {
                if (p.x < x0) x0 = p.x;
                if (p.y < y0) y0 = p.y;
                if (p.x > x1) x1 = p.x;
                if (p.y > y1) y1 = p.y;
              }
            }
          }
          if (!isFinite(x0) && r.anchors && doc && doc.stops) {
            for (const a of r.anchors) {
              const st = doc.stops[a.id];
              if (st) {
                const pt = (homeRenderer && typeof homeRenderer.stopPoint === 'function')
                  ? homeRenderer.stopPoint(st)
                  : { x: st.x || 0, y: st.y || 0 };
                if (pt.x < x0) x0 = pt.x;
                if (pt.y < y0) y0 = pt.y;
                if (pt.x > x1) x1 = pt.x;
                if (pt.y > y1) y1 = pt.y;
              }
            }
          }
          if (isFinite(x0)) {
            homeRenderer.fitToBounds({ x0, y0, x1, y1 }, { maxZoom: 1.6, padPercent: 0.12 });
          }
          homeRenderer.selected = { type: 'route', id: r.id, obj: r };
          homeRenderer.requestRender();
        } else {
          const zoom = item.type === 'road' ? 1.6 : 1.8;
          homeRenderer.fitToBounds({
            x0: item.x - 260,
            y0: item.y - 260,
            x1: item.x + 260,
            y1: item.y + 260
          }, { maxZoom: zoom });
          const selType = item.type === 'interchange' ? 'stop' : item.type;
          homeRenderer.selected = {
            type: selType,
            id: item.id,
            name: item.title,
            x: item.x,
            y: item.y,
            obj: item.obj,
            isSearch: true
          };
          homeRenderer.requestRender();
        }
      };

      searchInput.addEventListener('input', () => {
        searchClear.hidden = !searchInput.value.trim();
        performSearch(searchInput.value);
      });

      searchInput.addEventListener('focus', () => {
        if (searchInput.value.trim()) {
          performSearch(searchInput.value);
        }
      });

      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (!currentItems.length) return;
          selectedIndex = (selectedIndex + 1) % currentItems.length;
          renderResults(searchInput.value);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (!currentItems.length) return;
          selectedIndex = (selectedIndex - 1 + currentItems.length) % currentItems.length;
          renderResults(searchInput.value);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (selectedIndex >= 0 && selectedIndex < currentItems.length) {
            selectItem(currentItems[selectedIndex]);
          } else if (currentItems.length) {
            selectItem(currentItems[0]);
          }
        } else if (e.key === 'Escape') {
          searchDropdown.hidden = true;
          selectedIndex = -1;
        }
      });

      searchResults.addEventListener('click', (e) => {
        const itemBtn = e.target.closest('.home-search-item');
        if (!itemBtn) return;
        const idx = parseInt(itemBtn.dataset.idx, 10);
        if (currentItems[idx]) {
          selectItem(currentItems[idx]);
        }
      });

      searchClear.addEventListener('click', (e) => {
        e.stopPropagation();
        searchInput.value = '';
        searchClear.hidden = true;
        searchDropdown.hidden = true;
        currentItems = [];
        selectedIndex = -1;
        if (homeRenderer) {
          homeRenderer.selected = null;
          homeRenderer.requestRender();
        }
        searchInput.focus();
      });

      document.addEventListener('click', (e) => {
        if (!searchWrap.contains(e.target)) {
          searchDropdown.hidden = true;
        }
      });
    };

    const makeStoreCalc = (doc) => {
      if (!app || !app.city || !app.net || !app.store || !B.Store || !doc) return null;
      const calc = Object.create(B.Store.prototype);
      calc.city = app.city;
      calc.net = app.net;
      calc.legCache = app.store.legCache;
      calc.past = [];
      calc.future = [];
      calc.tx = null;
      calc.rev = 0;
      calc.doc = doc;
      calc.derive();
      return calc;
    };

    const stopCommutersIn = (calc, sid) => {
      if (!calc || !calc.doc || !calc.doc.stops || !app.net || !app.city) return 0;
      const s = calc.doc.stops[sid];
      if (!s) return 0;
      if (calc.closedSet && calc.closedSet.has(Number(s.edge))) return 0;
      const lines = (calc.stopLines && calc.stopLines[sid]) ? calc.stopLines[sid].length : 0;
      if (lines <= 0) return 0;
      const pt = app.net.posPoint(s, 0.78);
      if (!pt) return 0;
      const district = app.city.districtAt(pt);
      const base = { cbd: 1400, mixed: 950, hdb: 800, industrial: 450, landed: 300 }[district && district.type] || 500;
      const toCentre = district ? Math.hypot(pt.x - district.x, pt.y - district.y) : 1000;
      const nearCentre = 0.6 + 0.8 * Math.exp(-toCentre / 450);
      const byBuses = 0.5 + 0.5 * lines;
      let h = 0;
      for (const ch of String(sid)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const vary = 0.8 + (h % 41) / 100;
      return Math.max(20, Math.round((base * nearCentre * byBuses * vary) / 10) * 10);
    };

    // The whole network before any project, for Home's cards to say "out of how many": bus services running,
    // stops, passengers a day (the same per-stop estimate the projects' figures use), named roads, and the
    // average trip time and route length (used when no route is changed)
    const networkTotals = (doc, calc) => {
      const out = { routes: 0, stops: 0, passengers: 0, roads: 0, avgTripSec: 0, avgRouteM: 0 };
      if (!doc) return out;
      const routes = Object.entries(doc.routes || {}).filter(([, r]) => r && !r.isChunk && (B.busActive ? B.busActive(doc, r.number) : r.active !== false));
      out.routes = new Set(routes.map(([, r]) => String(r.number).trim())).size;
      out.stops = Object.keys(doc.stops || {}).length;
      if (calc) for (const sid of Object.keys(doc.stops || {})) out.passengers += stopCommutersIn(calc, sid);
      out.roads = new Set(((app.net && app.net.edges) || []).filter((e) => e && e.name).map((e) => e.name)).size;
      let n = 0, t = 0, m = 0;
      for (const [rid] of routes) {
        const g = calc && calc.geom ? calc.geom[rid] : null;
        if (g && g.time > 0) { n++; t += g.time; m += g.length || 0; }
      }
      if (n) { out.avgTripSec = t / n; out.avgRouteM = m / n; }
      return out;
    };

    const fmtCompactPeople = (n) => {
      const v = Math.round(Math.abs(n));
      if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
      return String(v);
    };

    const computeProjectBrief = (refDoc, targetDoc, refCalcIn, targetCalcIn) => {
      const rDoc = refDoc || { stops: {}, routes: {}, areas: {}, closures: {} };
      const tDoc = targetDoc || { stops: {}, routes: {}, areas: {}, closures: {} };
      const rCalc = refCalcIn || makeStoreCalc(rDoc);
      const tCalc = targetCalcIn || makeStoreCalc(tDoc);

      const rStops = rDoc.stops || {};
      const tStops = tDoc.stops || {};
      const rRoutes = rDoc.routes || {};
      const tRoutes = tDoc.routes || {};
      const rAreas = rDoc.areas || {};
      const tAreas = tDoc.areas || {};
      const rClosures = rDoc.closures || {};
      const tClosures = tDoc.closures || {};

      // 1. Areas & Road closures added in targetDoc (including roads closed inside affected areas)
      const newAreaNames = [];
      for (const [aid, a] of Object.entries(tAreas)) {
        if (!rAreas[aid] && a) newAreaNames.push(a.name || 'Affected Area');
      }
      const newClosedRoadNames = new Set();
      for (const [eidStr, cl] of Object.entries(tClosures)) {
        if (rClosures[eidStr]) continue;
        const eObj = app.net && app.net.edge(Number(eidStr));
        const nm = (cl && cl.roadName) || (eObj && eObj.name);
        if (nm) newClosedRoadNames.add(String(nm).trim());
      }

      // 2. Stops & Passenger impact
      const closedOrRemovedStops = new Set();
      const skippedStops = new Set();
      const addedStops = new Set();
      const relocatedStops = new Set();
      let lostCommuters = 0;
      let gainedCommuters = 0;

      const allStopIds = new Set([...Object.keys(rStops), ...Object.keys(tStops)]);
      for (const sid of allStopIds) {
        const rs = rStops[sid];
        const ts = tStops[sid];
        const rLines = (rCalc && rCalc.stopLines && rCalc.stopLines[sid]) ? rCalc.stopLines[sid].length : 0;
        const tLines = (tCalc && tCalc.stopLines && tCalc.stopLines[sid]) ? tCalc.stopLines[sid].length : 0;
        const rClosed = Boolean(rs && rCalc && rCalc.closedSet && rCalc.closedSet.has(Number(rs.edge)));
        const tClosed = Boolean(ts && tCalc && tCalc.closedSet && tCalc.closedSet.has(Number(ts.edge)));
        const rComm = stopCommutersIn(rCalc, sid);
        const tComm = stopCommutersIn(tCalc, sid);

        if (rs && !ts) {
          closedOrRemovedStops.add(sid);
          lostCommuters += rComm;
        } else if (!rs && ts) {
          if (ts.fromProject) continue; // another project's new stop, here because both run at the same time
          addedStops.add(sid);
          gainedCommuters += tComm;
        } else if (rs && ts) {
          if (!rClosed && tClosed) {
            closedOrRemovedStops.add(sid);
            lostCommuters += rComm;
          } else if (rLines > 0 && tLines === 0) {
            closedOrRemovedStops.add(sid);
            lostCommuters += rComm;
          } else if (tLines < rLines) {
            skippedStops.add(sid);
            lostCommuters += Math.max(0, rComm - tComm);
          } else if (rLines === 0 && tLines > 0) {
            addedStops.add(sid);
            gainedCommuters += tComm;
          } else if (rs.edge !== ts.edge || Math.abs((rs.s || 0) - (ts.s || 0)) > 1) {
            relocatedStops.add(sid);
          }
        }
      }

      // 3. Routes, Travel Time & Distance
      const impactedNums = new Set();
      const divertedNums = new Set();
      const disruptedNums = new Set();
      const addedNums = new Set();
      const suspendedNums = new Set();

      const blockedSet = new Set([
        ...(tCalc && tCalc.closedSet ? tCalc.closedSet : []),
        ...(tCalc && tCalc.affected ? tCalc.affected.keys() : []),
      ]);

      let totalTimeDeltaSec = 0;
      let totalDistDeltaM = 0;
      // the same routes' trip time and length before the change, to say how big the change is
      let totalBaseTimeSec = 0;
      let totalBaseDistM = 0;
      let comparedRoutesCount = 0;
      const delayedStopIds = new Set();

      for (const [rid, tr] of Object.entries(tRoutes)) {
        if (!tr || tr.isChunk) continue;
        const num = String(tr.number || '').trim();
        const baseId = (tr.kind === 'proposed' && tr.baseId && rRoutes[tr.baseId]) ? tr.baseId : rid;
        const rr = rRoutes[baseId];
        const tg = tCalc && tCalc.geom ? tCalc.geom[rid] : null;
        const rg = rr && rCalc && rCalc.geom ? rCalc.geom[baseId] : null;

        const rActive = rr ? (B.busActive ? B.busActive(rDoc, num) : rr.active !== false) : false;
        const tActive = B.busActive ? B.busActive(tDoc, num) : tr.active !== false;
        if (rr && rActive && !tActive) {
          if (num) { impactedNums.add(num); suspendedNums.add(num); }
          continue;
        }

        const hitsBlocked = Boolean(tg && (
          (tg.conflicts && tg.conflicts.length > 0) ||
          (tg.stopsOnClosed && tg.stopsOnClosed.length > 0) ||
          (tCalc && tCalc.affected && tCalc.affected.size > 0 && tg.legs &&
            tg.legs.some((l) => l.ok && l.segs && l.segs.some((sg) => tCalc.affected.has(sg.edge))))
        ));
        const isDetour = Boolean(tr.detourApplied || (tr.kind === 'proposed' && tr.baseId));
        const isAdded = !rr && !isDetour;
        const isModified = Boolean(rr && JSON.stringify(rr.anchors) !== JSON.stringify(tr.anchors));

        if (!hitsBlocked && !isDetour && !isAdded && !isModified) continue;

        if (num) impactedNums.add(num);
        if (isAdded) {
          if (num) addedNums.add(num);
          continue;
        }

        if (hitsBlocked && !isDetour && !isModified) {
          if (num) disruptedNums.add(num);
        } else if (num) {
          divertedNums.add(num);
        }

        // Collect stops along modified/disrupted routes for commuter delay fallback
        for (const a of (tr.anchors || [])) {
          if (a && a.t === 'stop' && a.id) delayedStopIds.add(a.id);
        }

        let effLen = tg ? tg.length : 0;
        let effTime = tg ? tg.time : 0;
        // If blocked without a detour applied yet, estimate shortest unblocked road detour
        if (hitsBlocked && !isDetour && !isModified && tCalc && blockedSet.size > 0 && Array.isArray(tr.anchors)) {
          const filteredAnchors = tr.anchors.filter((a, idx, arr) => {
            if (idx === 0 || idx === arr.length - 1) return true;
            if (a && a.t === 'stop' && tStops[a.id] && blockedSet.has(Number(tStops[a.id].edge))) return false;
            return true;
          });
          if (filteredAnchors.length >= 2) {
            try {
              const dg = tCalc.computeRoute({ ...tr, kind: 'proposed', override: false, anchors: filteredAnchors }, blockedSet);
              if (dg && dg.ok && dg.length > 0) {
                effLen = dg.length;
                effTime = dg.time;
              }
            } catch (e) {}
          }
        }

        if (rg && rg.time > 0 && effTime > 0) {
          totalTimeDeltaSec += (effTime - rg.time);
          totalDistDeltaM += (effLen - rg.length);
          totalBaseTimeSec += rg.time;
          totalBaseDistM += rg.length || 0;
          comparedRoutesCount++;
        }
      }

      for (const [rid, rr] of Object.entries(rRoutes)) {
        if (!rr || rr.isChunk) continue;
        if (!tRoutes[rid] && !Object.values(tRoutes).some((sr) => sr && sr.baseId === rid)) {
          const num = String(rr.number || '').trim();
          if (num) {
            impactedNums.add(num);
            suspendedNums.add(num);
          }
        }
      }

      let delayedCommuters = 0;
      if (lostCommuters === 0 && gainedCommuters === 0 && delayedStopIds.size > 0) {
        for (const sid of delayedStopIds) delayedCommuters += stopCommutersIn(tCalc, sid);
      }

      const affectedStopsCount = closedOrRemovedStops.size + skippedStops.size + addedStops.size + relocatedStops.size;
      const stopsNet = addedStops.size - (closedOrRemovedStops.size + skippedStops.size);
      const avgTimeDeltaSec = comparedRoutesCount > 0 ? (totalTimeDeltaSec / comparedRoutesCount) : 0;
      const avgDistDeltaM = comparedRoutesCount > 0 ? (totalDistDeltaM / comparedRoutesCount) : 0;

      // Build concise plain-English short brief
      const parts = [];
      if (newAreaNames.length === 1) {
        parts.push(`Zone: ${newAreaNames[0]}`);
      } else if (newAreaNames.length > 1) {
        parts.push(`${newAreaNames.length} zones (${newAreaNames[0]} +${newAreaNames.length - 1})`);
      }
      if (newClosedRoadNames.size > 0) {
        const rList = [...newClosedRoadNames];
        parts.push(`${rList.length} road closure${rList.length === 1 ? '' : 's'} (${rList[0]}${rList.length > 1 ? ` +${rList.length - 1}` : ''})`);
      }
      const routeBits = [];
      if (divertedNums.size > 0) routeBits.push(`${divertedNums.size} diverted`);
      if (disruptedNums.size > 0) routeBits.push(`${disruptedNums.size} blocked`);
      if (addedNums.size > 0) routeBits.push(`${addedNums.size} added`);
      if (suspendedNums.size > 0) routeBits.push(`${suspendedNums.size} suspended`);
      if (routeBits.length) {
        parts.push(`Buses: ${routeBits.join(', ')}`);
      }
      const unservedCount = closedOrRemovedStops.size + skippedStops.size;
      if (unservedCount > 0 && addedStops.size > 0) {
        parts.push(`Stops: ${unservedCount} skipped/closed, ${addedStops.size} added`);
      } else if (unservedCount > 0) {
        parts.push(`${unservedCount} stop${unservedCount === 1 ? '' : 's'} skipped/closed`);
      } else if (addedStops.size > 0) {
        parts.push(`${addedStops.size} stop${addedStops.size === 1 ? '' : 's'} added`);
      } else if (relocatedStops.size > 0) {
        parts.push(`${relocatedStops.size} stop${relocatedStops.size === 1 ? '' : 's'} relocated`);
      }

      const explanation = parts.length
        ? `${parts.join(' · ')}.`
        : 'Scheduled project with no road closures, affected zones, or route changes drawn yet.';

      return {
        explanation,
        // roads the project closes (by name), for the brief's Road Closure row
        roadClosuresCount: newClosedRoadNames.size,
        lostCommuters,
        gainedCommuters,
        delayedCommuters,
        affectedStopsCount,
        stopsNet,
        affectedRoutesCount: impactedNums.size,
        divertedCount: divertedNums.size,
        disruptedCount: disruptedNums.size,
        addedRoutesCount: addedNums.size,
        suspendedRoutesCount: suspendedNums.size,
        avgTimeDeltaSec,
        avgDistDeltaM,
        // the changed routes' usual trip time and length, and the change as a share of them (%)
        avgBaseTimeSec: comparedRoutesCount > 0 ? totalBaseTimeSec / comparedRoutesCount : 0,
        avgBaseDistM: comparedRoutesCount > 0 ? totalBaseDistM / comparedRoutesCount : 0,
        timeDeltaPct: totalBaseTimeSec > 0 ? (totalTimeDeltaSec / totalBaseTimeSec) * 100 : 0,
        distDeltaPct: totalBaseDistM > 0 ? (totalDistDeltaM / totalBaseDistM) * 100 : 0,
      };
    };

    const buildHomeTimelineData = () => {
      if (c._syncProjectScheduleStatuses) c._syncProjectScheduleStatuses({ silent: true });
      const mainDoc = (c.activeProjectId === 'main')
        ? c.store.doc
        : ((c._storedDoc && c._storedDoc('brass_proj_doc_main')) || (c._projectBase ? c._projectBase('main') : c.store.doc));
      const baseDoc = c.scheduledBase || mainDoc || { stops: {}, routes: {}, areas: {}, closures: {}, interchanges: {} };
      const includeDrafts = Boolean(homeTlIncludeDrafts && homeTlIncludeDrafts.checked);
      const visibleProjects = (c.projects || []).filter((p) => canUserSeeProject(p) && statusOf(p) !== 'archive');
      const visibleIds = new Set(visibleProjects.map((p) => p.id));

      const intervals = [];
      const coveredProjIds = new Set();
      let goLiveCount = 0;
      let scheduledCount = 0;
      let draftOnlyCount = 0;
      const baseCalc = makeStoreCalc(baseDoc);

      // 1. Scheduled changes applied to the Current Map
      const projById = new Map((c.projects || []).map((p) => [p.id, p]));
      for (const sc of (c.scheduledChanges || [])) {
        if (!sc || !sc.patch || sc.status === 'cancelled') continue;
        if (sc.projectId) {
          const linked = projById.get(sc.projectId);
          // Skip orphaned entries from deleted projects, invisible projects, or projects no longer Go-Live / Schedule
          if (!linked || !visibleIds.has(sc.projectId)) continue;
          const linkedSt = statusOf(linked);
          if (linkedSt !== 'go_live' && linkedSt !== 'schedule') continue;
          // Deduplicate: at most one timeline interval per project
          if (coveredProjIds.has(sc.projectId)) continue;
        }
        // Slider won't show permanent changes
        if (sc.mode === 'permanent' || sc.end === Infinity || !isFinite(sc.end)) continue;

        if (sc.projectId) coveredProjIds.add(sc.projectId);
        const linkedProj = sc.projectId ? projById.get(sc.projectId) : null;
        const isLiveSc = linkedProj ? (statusOf(linkedProj) === 'go_live') : (sc.status === 'active');
        if (isLiveSc) goLiveCount++;
        else scheduledCount++;
        intervals.push({
          id: 'sc:' + sc.id,
          projectId: sc.projectId || null,
          projectName: (linkedProj && linkedProj.name) || sc.projectName || 'Scheduled Change',
          start: typeof sc.start === 'number' ? sc.start : 0,
          end: typeof sc.end === 'number' ? sc.end : Infinity,
          patch: sc.patch,
          isApplied: true,
          spanKind: isLiveSc ? 'go_live' : 'schedule',
          createdAt: sc.createdAt || 0,
        });
      }

      // 2. Visible projects (Go-Live = active project, Schedule = active once start arrives, plus optional drafts)
      const now = Date.now();
      for (const p of visibleProjects) {
        const s = span(p);
        // Slider won't show permanent changes both draft and all statuses
        const isPerm = (p.applyPeriod && (p.applyPeriod.mode === 'permanent' || p.applyPeriod.mode !== 'scheduled')) ||
                       s.end === Infinity ||
                       !isFinite(s.end) ||
                       (c.mapVersions || []).some((v) => v.type === 'permanent' && v.projectId === p.id);
        if (isPerm) continue;

        const st = statusOf(p);
        const isGoLive = st === 'go_live';
        const isScheduled = st === 'schedule';
        if (!coveredProjIds.has(p.id)) {
          if (isGoLive) goLiveCount++;
          else if (isScheduled) scheduledCount++;
        }
        if (coveredProjIds.has(p.id)) continue;
        const isActiveOrScheduled = isGoLive || isScheduled;
        if (!isActiveOrScheduled) draftOnlyCount++;
        if (!includeDrafts && !isActiveOrScheduled) continue;
        const effStart = (isGoLive && !p.autoFromSchedule) ? Math.min(s.start, now) : s.start;
        const projDoc = JSON.parse(JSON.stringify(docOf(p.id) || {}));
        let patch = {};
        try {
          const refBase = (c._projectBase && c._projectBase(p.id)) || baseDoc;
          patch = c._diffDocs(refBase, projDoc);
        } catch (e) { patch = {}; }
        intervals.push({
          id: 'proj:' + p.id,
          projectId: p.id,
          projectName: p.name || 'Untitled Project',
          start: effStart,
          end: s.end,
          patch,
          isApplied: isActiveOrScheduled,
          spanKind: isGoLive ? 'go_live' : (isScheduled ? 'schedule' : 'draft'),
          createdAt: p.createdAt || 0,
        });
      }

      intervals.sort((a, b) => (a.start - b.start) || (a.createdAt - b.createdAt));
      homeTimelineData = {
        baseDoc,
        baseCalc,
        totals: networkTotals(baseDoc, baseCalc),
        intervals,
        totalVisibleProjects: visibleProjects.length,
        goLiveCount,
        scheduledCount,
        draftOnlyCount,
      };
      homeActiveSig = null;
      homeBriefRenderKey = null;
      return homeTimelineData;
    };

    const renderHomeTimelineScale = () => {
      if (!homeTlScale || !homeRange) return;
      const { from, to } = homeRange;
      const dur = to - from;
      if (!(dur > 0)) { homeTlScale.innerHTML = ''; return; }

      // When focused on Today or single-day window (<= 36 hours): render hourly scale 00:00 – 24:00
      if (dur <= DAY_MS * 1.5) {
        const stepHours = (homeTlScale.clientWidth || 560) < 460 ? 4 : 3;
        const marks = [];
        const d = new Date(from);
        d.setHours(0, 0, 0, 0);
        while (d.getTime() <= to + 1000 && marks.length < 15) {
          const pct = Math.max(0, Math.min(100, ((d.getTime() - from) / dur) * 100));
          const hh = String(d.getHours()).padStart(2, '0');
          if (pct <= 96) {
            marks.push({ pct, text: `${hh}:00` });
          }
          d.setHours(d.getHours() + stepHours);
        }
        marks.push({ pct: 100, text: '24:00' });
        homeTlScale.innerHTML = marks.map((m) => `<span class="home-tl-scale-mark" style="left:${m.pct.toFixed(2)}%">${esc(m.text)}</span>`).join('');
        return;
      }

      const maxLabels = Math.max(2, Math.floor((homeTlScale.clientWidth || 560) / 72));
      const steps = [
        { unit: 'day', n: 1 }, { unit: 'day', n: 2 }, { unit: 'day', n: 4 }, { unit: 'day', n: 7 }, { unit: 'day', n: 14 },
        { unit: 'month', n: 1 }, { unit: 'month', n: 2 }, { unit: 'month', n: 3 }, { unit: 'month', n: 6 },
        { unit: 'year', n: 1 }, { unit: 'year', n: 2 }, { unit: 'year', n: 5 },
      ];
      const approx = { day: DAY_MS, month: 30.44 * DAY_MS, year: 365.25 * DAY_MS };
      const step = steps.find((st) => (to - from) / (approx[st.unit] * st.n) <= maxLabels) || steps[steps.length - 1];
      const d = new Date(from);
      d.setHours(0, 0, 0, 0);
      if (step.unit !== 'day') d.setDate(1);
      if (step.unit === 'year') d.setMonth(0);
      const advance = () => {
        if (step.unit === 'day') d.setDate(d.getDate() + step.n);
        else if (step.unit === 'month') d.setMonth(d.getMonth() + step.n);
        else d.setFullYear(d.getFullYear() + step.n);
      };
      if (d.getTime() < from) advance();
      const marks = [];
      let lastYear = null;
      while (d.getTime() <= to && marks.length < 40) {
        const showYr = marks.length === 0 || (lastYear !== null && d.getFullYear() !== lastYear) ? { year: '2-digit' } : {};
        const text = step.unit === 'day'
          ? d.toLocaleDateString([], { day: 'numeric', month: 'short', ...showYr })
          : step.unit === 'month'
            ? d.toLocaleDateString([], { month: 'short', ...showYr })
            : String(d.getFullYear());
        const pct = ((d.getTime() - from) / (to - from)) * 100;
        if (pct <= 98.5) marks.push({ pct, text });
        lastYear = d.getFullYear();
        advance();
      }
      homeTlScale.innerHTML = marks.map((m) => `<span class="home-tl-scale-mark" style="left:${m.pct.toFixed(2)}%">${esc(m.text)}</span>`).join('');
    };

    const renderHomeTimelineDecorations = () => {
      if (!homeRange) return;
      const { from, to } = homeRange;
      const data = homeTimelineData || buildHomeTimelineData();
      const dur = Math.max(1, to - from);

      // Now marker
      const now = Date.now();
      if (homeTlNowMark) {
        if (now >= from && now <= to) {
          homeTlNowMark.hidden = false;
          homeTlNowMark.style.left = `${(((now - from) / dur) * 100).toFixed(2)}%`;
        } else {
          homeTlNowMark.hidden = true;
        }
      }

      // Project effective span bars & start/end ticks
      const overlapping = data.intervals.filter((iv) => iv.end > from && iv.start < to);
      if (homeTlSpans) {
        homeTlSpans.innerHTML = overlapping.map((iv, idx) => {
          const lPct = Math.max(0, ((iv.start - from) / dur) * 100);
          const rPct = Math.min(100, (((iv.end === Infinity ? to : iv.end) - from) / dur) * 100);
          const wPct = Math.max(0.6, rPct - lPct);
          const laneTop = overlapping.length > 1 ? 2 + (idx % 3) * 5 : 6;
          const barH = overlapping.length > 1 ? 4 : 6;
          const cls = iv.spanKind === 'schedule' ? 'is-scheduled' : (iv.isApplied ? 'is-applied' : '');
          return `<span class="home-tl-span-bar ${cls}" style="left:${lPct.toFixed(2)}%;width:${wPct.toFixed(2)}%;top:${laneTop}px;height:${barH}px"></span>`;
        }).join('');
      }
      if (homeTlTicks) {
        const ticks = [];
        for (const iv of overlapping) {
          const cls = iv.spanKind === 'schedule' ? 'is-scheduled' : (iv.isApplied ? 'is-applied' : '');
          if (iv.start >= from && iv.start <= to) {
            ticks.push({
              pct: ((iv.start - from) / dur) * 100,
              cls,
              title: `${iv.projectName} starts ${fmt(iv.start)}`,
            });
          }
          if (iv.end < Infinity && iv.end >= from && iv.end <= to) {
            ticks.push({
              pct: ((iv.end - from) / dur) * 100,
              cls,
              title: `${iv.projectName} ends ${fmt(iv.end)}`,
            });
          }
        }
        homeTlTicks.innerHTML = ticks.map((tk) => `<span class="home-tl-tick ${tk.cls}" style="left:${tk.pct.toFixed(2)}%" title="${esc(tk.title)}"></span>`).join('');
      }
      renderHomeTimelineScale();
    };

    const getHomeSliderTime = () => {
      if (!homeRange || !homeTlSlider) return Date.now();
      const frac = Number(homeTlSlider.value) / 1000;
      return homeRange.from + (homeRange.to - homeRange.from) * frac;
    };

    const setHomeSliderToTime = (ts) => {
      if (!homeRange || !homeTlSlider) return;
      const dur = Math.max(1, homeRange.to - homeRange.from);
      const clamped = Math.max(homeRange.from, Math.min(homeRange.to, ts));
      homeTlSlider.value = String(Math.round(((clamped - homeRange.from) / dur) * 1000));
    };

    const fmtBriefDate = (ts) => {
      if (!Number.isFinite(ts) || ts <= 0) return 'Start';
      return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
    };

    const renderHomeProjectBrief = (activeIntervals, data, t) => {
      if (!homePbTitle) return;
      if (!activeIntervals || !activeIntervals.length) {
        if (homeProjBrief) homeProjBrief.hidden = true;
        if (homePbTabs) { homePbTabs.hidden = true; homePbTabs.innerHTML = ''; }
        homeBriefRenderKey = 'none';
        return;
      }

      if (homeProjBrief) homeProjBrief.hidden = homeBriefClosed;

      if (!homeSelectedBriefId || !activeIntervals.some((iv) => iv.id === homeSelectedBriefId)) {
        homeSelectedBriefId = activeIntervals[activeIntervals.length - 1].id;
      }

      const isBefore = (homeCompareMode === 'before');
      const renderKey = `act:${activeIntervals.map((iv) => iv.id).join('|')}::sel=${homeSelectedBriefId}::cmp=${homeCompareMode}`;
      if (renderKey === homeBriefRenderKey) return;
      homeBriefRenderKey = renderKey;

      const selectedIv = activeIntervals.find((iv) => iv.id === homeSelectedBriefId) || activeIntervals[activeIntervals.length - 1];
      const currentIndex = Math.max(0, activeIntervals.findIndex((iv) => iv.id === selectedIv.id));
      // Another project chosen: the popover comes in again (a short fade and rise) as it moves to its pin
      if (homeProjBrief && homeBriefShownId && homeBriefShownId !== selectedIv.id) {
        homeProjBrief.classList.remove('is-entering');
        void homeProjBrief.offsetWidth; // restart the animation
        homeProjBrief.classList.add('is-entering');
      }
      homeBriefShownId = selectedIv.id;
      if (homePbTabs) {
        if (activeIntervals.length > 1) {
          homePbTabs.hidden = false;
          const isFirst = (currentIndex === 0);
          const isLast = (currentIndex >= activeIntervals.length - 1);
          homePbTabs.innerHTML = `
            <button type="button" class="home-pb-page-btn is-prev" data-nav="prev" ${isFirst ? 'disabled' : ''} title="Previous" aria-label="Previous">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
            </button>
            <span class="home-pb-page-count">${currentIndex + 1}/${activeIntervals.length}</span>
            <button type="button" class="home-pb-page-btn is-next" data-nav="next" ${isLast ? 'disabled' : ''} title="Next" aria-label="Next">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </button>
          `;
        } else {
          homePbTabs.hidden = true;
          homePbTabs.innerHTML = '';
        }
      }

      homePbTitle.textContent = selectedIv.projectName || 'Active Project';
      // "Dec 26 – Jan 2 · 8 days" (calendar days it touches); the full dates on hover
      const day = (ts) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const midnight = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
      const forever = selectedIv.end === Infinity || !isFinite(selectedIv.end);
      const days = forever ? 0 : Math.round((midnight(selectedIv.end) - midnight(selectedIv.start)) / DAY_MS) + 1;
      const when = forever ? `From ${day(selectedIv.start)} · ongoing` : `${day(selectedIv.start)} – ${day(selectedIv.end)} · ${days} day${days === 1 ? '' : 's'}`;
      homePbPeriod.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg><span>${esc(when)}</span>`;
      homePbPeriod.title = `${fmtBriefDate(selectedIv.start)} – ${forever ? 'Forever' : fmtBriefDate(selectedIv.end)}`;
      if (homePbBadge) {
        if (isBefore) {
          homePbBadge.textContent = 'Before';
          homePbBadge.className = 'home-pb-badge is-baseline';
        } else if (selectedIv.spanKind === 'go_live') {
          homePbBadge.textContent = 'Go-Live';
          homePbBadge.className = 'home-pb-badge is-golive';
        } else if (selectedIv.spanKind === 'schedule') {
          homePbBadge.textContent = 'Schedule';
          homePbBadge.className = 'home-pb-badge is-schedule';
        } else {
          homePbBadge.textContent = 'Draft';
          homePbBadge.className = 'home-pb-badge is-draft';
        }
      }

      // The panel is just the project: name, status and dates, and the way into it. Its figures are in the cards above
      const canOpenProj = Boolean(selectedIv.projectId && (c.projects || []).some((x) => x.id === selectedIv.projectId && showsInProjectMenu(x)));
      if (homePbMoreBtn) {
        // the arrow at the top right: into this project, or to the projects list when it isn't one of them
        const label = canOpenProj ? 'View details' : 'View projects';
        homePbMoreBtn.title = label;
        homePbMoreBtn.setAttribute('aria-label', label);
      }
      homeBriefAction = () => {
        if (canOpenProj) open(selectedIv.projectId);
        else switchMainView('projects');
      };
    };

    // ------------------------------------------------------------- Project pins on the Home map
    // Each project running at the selected moment gets a pin in the middle of the area it changes, with that area
    // outlined; the chosen one's popover sits on its pin, and a pin or ‹ › picks another
    const homePinsLayer = document.getElementById('home-map-pins');
    const pinAreas = new WeakMap(); // interval -> its area ({ hull, center }) or null, worked out once
    let homePins = []; // [{ id, iv, area, el }]
    let homePinIvs = [];

    const convexHull = (points) => {
      const p = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
      if (p.length < 3) return p;
      const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
      const lower = [], upper = [];
      for (const q of p) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
        lower.push(q);
      }
      for (let i = p.length - 1; i >= 0; i--) {
        const q = p[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
        upper.push(q);
      }
      upper.pop();
      lower.pop();
      return lower.concat(upper);
    };

    // Where a project's changes are: its closed (or reopened) roads, its zones, the stops it adds, moves or removes;
    // its routes' stops when it changes nothing else. Outlined a little wider than them, the pin at their middle
    const projectArea = (iv, baseDoc) => {
      const P = iv.patch || {};
      const setOf = (k) => (P[k] && P[k].set) || {};
      const delOf = (k) => (P[k] && P[k].del) || [];
      const baseStops = (baseDoc && baseDoc.stops) || {};
      const pts = [];
      const add = (p) => { if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) pts.push(p); };
      const roadPts = (eid) => { const e = app.net && app.net.edges[Number(eid)]; if (e && e.pts) e.pts.forEach(add); };
      const stopPt = (s) => { if (s && app.net) add(app.net.posPoint(s, 0.78)); };
      Object.keys(setOf('closures')).forEach(roadPts);
      delOf('closures').forEach(roadPts);
      for (const a of Object.values(setOf('areas'))) {
        const poly = a && (a.shape === 'circle' ? B.circlePoly(a.cx, a.cy, a.r, 24) : a.pts);
        (poly || []).forEach(add);
      }
      Object.values(setOf('stops')).forEach(stopPt);
      delOf('stops').forEach((sid) => stopPt(baseStops[sid]));
      if (!pts.length) {
        const routes = [...Object.values(setOf('routes')), ...delOf('routes').map((rid) => ((baseDoc && baseDoc.routes) || {})[rid])];
        for (const r of routes) {
          for (const a of ((r && r.anchors) || [])) if (a && a.t === 'stop') stopPt(setOf('stops')[a.id] || baseStops[a.id]);
        }
      }
      if (!pts.length) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) {
        if (p.x < x0) x0 = p.x;
        if (p.x > x1) x1 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.y > y1) y1 = p.y;
      }
      // a ring of points round each change keeps the outline clear of it
      const pad = 160, ring = [], step = Math.max(1, Math.ceil(pts.length / 300));
      for (let i = 0; i < pts.length; i += step) {
        for (let k = 0; k < 8; k++) {
          const ang = (k / 8) * Math.PI * 2;
          ring.push({ x: pts[i].x + Math.cos(ang) * pad, y: pts[i].y + Math.sin(ang) * pad });
        }
      }
      return { hull: convexHull(ring), center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } };
    };

    const PIN_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4"/><path d="M5 4h12l-2.5 4.5L17 13H5" fill="currentColor"/></svg>';
    // Pins for the projects running now (made again only when that set changes); the chosen one stands out
    const syncHomePins = (activeIntervals, data) => {
      if (!homePinsLayer) return;
      const list = activeIntervals || [];
      if (list.length !== homePinIvs.length || list.some((iv, i) => iv !== homePinIvs[i])) {
        homePinIvs = list.slice();
        homePins = list.map((iv) => {
          if (!pinAreas.has(iv)) pinAreas.set(iv, projectArea(iv, data && data.baseDoc));
          const area = pinAreas.get(iv);
          if (!area) return null;
          const el = document.createElement('button');
          el.type = 'button';
          el.className = 'home-pin';
          el.title = iv.projectName || 'Project';
          el.setAttribute('aria-label', `Show ${iv.projectName || 'project'}`);
          el.innerHTML = PIN_ICON;
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            chooseHomeProject(iv.id);
          });
          return { id: iv.id, iv, area, el };
        }).filter(Boolean);
        homePinsLayer.replaceChildren(...homePins.map((p) => p.el));
      }
      for (const p of homePins) p.el.classList.toggle('is-selected', !homeBriefClosed && p.id === homeSelectedBriefId);
      if (homeRenderer) homeRenderer.requestRender();
      positionHomePins();
    };

    // After every frame of the map: pins on their places, the popover on the chosen pin (above it, or below near
    // the top). A project with nothing to pin, or whose pin is out of view, keeps its popover in the corner
    const positionHomePins = () => {
      if (!homeRenderer || !homePinsLayer) return;
      const W = homeRenderer.width, H = homeRenderer.height;
      let sel = null;
      for (const p of homePins) {
        const s = homeRenderer.worldToScreen(p.area.center.x, p.area.center.y);
        const inView = s.x >= 0 && s.x <= W && s.y >= 0 && s.y <= H;
        p.el.hidden = !inView;
        p.el.style.left = `${s.x}px`;
        p.el.style.top = `${s.y}px`;
        if (p.id === homeSelectedBriefId && inView) sel = s;
      }
      if (!homeProjBrief || homeProjBrief.hidden) return;
      const w = homeProjBrief.offsetWidth, h = homeProjBrief.offsetHeight;
      homeProjBrief.classList.toggle('is-docked', !sel);
      if (!sel) {
        homeProjBrief.classList.remove('is-below');
        homeProjBrief.style.left = `${Math.max(12, W - w - 12)}px`;
        homeProjBrief.style.top = '12px';
        return;
      }
      const PIN = 44, GAP = 14; // pin height with its tip; space with the popover's arrow
      const left = Math.min(Math.max(8, sel.x - w / 2), Math.max(8, W - w - 8));
      let top = sel.y - PIN - GAP - h, below = false;
      if (top < 8) { top = sel.y + GAP; below = true; }
      homeProjBrief.style.left = `${left}px`;
      homeProjBrief.style.top = `${top}px`;
      homeProjBrief.classList.toggle('is-below', below);
      homeProjBrief.style.setProperty('--caret-x', `${Math.min(Math.max(20, sel.x - left), w - 20)}px`);
    };

    // In map space, under the pins: each running project's area, dashed, the chosen one stronger
    // Picking a project (its pin, or ‹ ›): it becomes the chosen one and the map glides to its area, leaving room
    // above the pin for the popover. Only when someone picks; moving through the timeline doesn't move the map
    const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const chooseHomeProject = (id) => {
      if (!id) return;
      homeBriefClosed = false;
      homeSelectedBriefId = id;
      homeBriefRenderKey = null;
      updateHomeAtTime(getHomeSliderTime());
      const p = homePins.find((x) => x.id === id);
      if (!p || !homeRenderer) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const q of p.area.hull) {
        if (q.x < x0) x0 = q.x;
        if (q.x > x1) x1 = q.x;
        if (q.y < y0) y0 = q.y;
        if (q.y > y1) y1 = q.y;
      }
      const popH = (homeProjBrief && homeProjBrief.offsetHeight) || 150;
      homeRenderer.fitToBounds(
        { x0, y0, x1, y1 },
        { top: popH + 70, bottom: 24, left: 24, right: 24 },
        { minSize: 2500, maxZoom: 0.9, instant: reducedMotion() },
      );
    };

    const closeHomeBrief = () => {
      if (homeBriefClosed || !homeProjBrief || homeProjBrief.hidden) return;
      homeBriefClosed = true;
      homeProjBrief.hidden = true;
      for (const p of homePins) p.el.classList.remove('is-selected');
      if (homeRenderer) homeRenderer.requestRender();
    };
    if (homeCanvas) {
      let downAt = null;
      homeCanvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
      homeCanvas.addEventListener('click', (e) => {
        // a drag to pan the map isn't a click
        if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
        closeHomeBrief();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !homePage || homePage.hidden) return;
      if (e.target && e.target.closest && e.target.closest('input, textarea, select, .home-share')) return;
      closeHomeBrief();
    });


    if (homePbTabs) {
      homePbTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const data = homeTimelineData || buildHomeTimelineData();
        const t = getHomeSliderTime();
        const activeIntervals = (data && data.intervals) ? data.intervals.filter((iv) => t >= iv.start && t < iv.end) : [];
        if (!activeIntervals.length) return;

        let currentIndex = activeIntervals.findIndex((iv) => iv.id === homeSelectedBriefId);
        if (currentIndex === -1) currentIndex = 0;

        let target = null;
        if (btn.dataset.nav === 'prev') target = activeIntervals[currentIndex - 1];
        else if (btn.dataset.nav === 'next') target = activeIntervals[currentIndex + 1];
        else if (btn.dataset.idx != null) target = activeIntervals[Number(btn.dataset.idx)];
        else if (btn.dataset.ivId) target = activeIntervals.find((iv) => iv.id === btn.dataset.ivId);
        if (target) chooseHomeProject(target.id);
      });
    }
    if (homePbMoreBtn) {
      homePbMoreBtn.addEventListener('click', () => {
        if (typeof homeBriefAction === 'function') homeBriefAction();
      });
    }

    // Share on the Home bar: a link that opens Home on its own (no sidebar); presentation and PDF are mock-ups
    const homeShare = document.getElementById('home-share');
    if (homeShare) {
      const btn = homeShare.querySelector('[data-act="home-share"]');
      const menu = homeShare.querySelector('.home-share-menu');
      const setOpen = (open) => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
      btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(menu.hidden); });
      document.addEventListener('click', (e) => { if (!homeShare.contains(e.target)) setOpen(false); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { setOpen(false); btn.focus(); } });
      menu.addEventListener('click', async (e) => {
        const item = e.target.closest('[data-exp]');
        if (!item) return;
        setOpen(false);
        if (item.dataset.exp === 'link') {
          try {
            await c._copyText(`${location.origin}${location.pathname}#dashboard`);
            toast('Share link copied · it opens Home without the sidebar', 'success');
          } catch (err) {
            toast("Couldn't copy the link", 'warn');
          }
          return;
        }
        toast(`${item.dataset.exp === 'pdf' ? 'Export PDF' : 'Export presentation'} is a mock-up for now`, 'info');
      });
    }

    const updateHomeAtTime = (t) => {
      if (!homePage) return;
      const data = homeTimelineData || buildHomeTimelineData();
      const { baseDoc, intervals, totalVisibleProjects } = data;

      // Update live Now marker position subtly
      if (homeRange && homeTlNowMark) {
        const now = Date.now();
        if (now >= homeRange.from && now <= homeRange.to) {
          homeTlNowMark.hidden = false;
          homeTlNowMark.style.left = `${(((now - homeRange.from) / Math.max(1, homeRange.to - homeRange.from)) * 100).toFixed(2)}%`;
        } else {
          homeTlNowMark.hidden = true;
        }
      }

      const activeIntervals = intervals.filter((iv) => iv.start <= t && t < iv.end);
      const changesOnly = Boolean(homeTlChangesOnly && homeTlChangesOnly.checked);
      const isBefore = (homeCompareMode === 'before');
      const sig = activeIntervals.map((iv) => iv.id).join('|') + `::co=${changesOnly ? 1 : 0}::cmp=${homeCompareMode}`;

      if (sig !== homeActiveSig || !homeLastSim) {
        homeActiveSig = sig;
        const simDoc = JSON.parse(JSON.stringify(baseDoc));
        for (const iv of activeIntervals) {
          c._applyDocPatch(simDoc, iv.patch);
        }

        ensureHomeMap();
        if (homeStore) {
          homeStore.doc = isBefore ? JSON.parse(JSON.stringify(baseDoc)) : simDoc;
          homeStore.derive();
        }

        // Compute KPI statistics & deltas vs baseline
        const baseStops = baseDoc.stops || {};
        const simStops = simDoc.stops || {};
        const stopsCount = Object.keys(simStops).length;
        const stopsDelta = stopsCount - Object.keys(baseStops).length;
        let stopsOnClosed = 0;
        if (homeStore && homeStore.closedSet && homeStore.closedSet.size) {
          for (const st of Object.values(simStops)) {
            if (st && homeStore.closedSet.has(Number(st.edge))) stopsOnClosed++;
          }
        }

        const baseRoutesCount = busCount(baseDoc);
        const routesCount = busCount(simDoc);
        const routesDelta = routesCount - baseRoutesCount;

        const baseAreas = baseDoc.areas || {};
        const simAreas = simDoc.areas || {};
        const areasList = Object.values(simAreas);
        const areasCount = areasList.length;
        const areasDelta = areasCount - Object.keys(baseAreas).length;

        const baseClosures = baseDoc.closures || {};
        const simClosures = simDoc.closures || {};
        const closuresCount = Object.keys(simClosures).length;
        const closuresDelta = closuresCount - Object.keys(baseClosures).length;
        const distinctClosedRoads = new Set();
        for (const [eidStr, cl] of Object.entries(simClosures)) {
          const eObj = app.net && app.net.edge(Number(eidStr));
          const rName = (cl && cl.roadName) || (eObj && eObj.name) || `edge-${eidStr}`;
          distinctClosedRoads.add(String(rName).toLowerCase().trim());
        }

        // Impacted buses & changed route IDs
        const baseRoutes = baseDoc.routes || {};
        const simRoutes = simDoc.routes || {};
        const changedRouteIds = new Set();
        const impactedNums = new Set();
        const divertedNums = new Set();
        const disruptedNums = new Set();
        const addedNums = new Set();
        const suspendedNums = new Set();
        const modifiedNums = new Set();

        const addChangedRid = (id) => {
          if (id === undefined || id === null) return;
          changedRouteIds.add(id);
          if (typeof id === 'string' && /^\d+$/.test(id)) changedRouteIds.add(Number(id));
          else if (typeof id === 'number') changedRouteIds.add(String(id));
        };

        const simClosureEdgeSet = new Set(Object.keys(simClosures).map(Number));

        for (const [rid, r] of Object.entries(simRoutes)) {
          const num = String(r.number || '').trim();
          const br = baseRoutes[rid];

          let touchesClosure = false;
          if (simClosureEdgeSet.size > 0) {
            const anchors = (br && br.anchors) || r.anchors || [];
            for (const a of anchors) {
              if (a && a.edge && simClosureEdgeSet.has(Number(a.edge))) {
                touchesClosure = true;
                break;
              }
            }
          }

          const g = homeStore && homeStore.geom ? (homeStore.geom[rid] || homeStore.geom[r.baseId]) : null;
          const isDisrupted = touchesClosure || Boolean(g && (
            (g.conflicts && g.conflicts.length > 0) ||
            (g.stopsOnClosed && g.stopsOnClosed.length > 0) ||
            (homeStore && homeStore.affected && homeStore.affected.size > 0 && g.legs &&
              g.legs.some((l) => l.ok && l.segs && l.segs.some((sg) => homeStore.affected.has(sg.edge))))
          ));
          const isDetour = Boolean(r.detourApplied || (r.kind === 'proposed' && r.baseId));
          const isAdded = !br && !isDetour;
          const isModified = Boolean(br && JSON.stringify(br.anchors) !== JSON.stringify(r.anchors));

          if (isDisrupted || isDetour || isAdded || isModified) {
            addChangedRid(rid);
            if (r.id) addChangedRid(r.id);
            if (r.baseId) addChangedRid(r.baseId);
            if (br && br.id) addChangedRid(br.id);
            if (num) impactedNums.add(num);
            if (isDisrupted && num) disruptedNums.add(num);
            else if ((isDetour || isModified) && num) divertedNums.add(num);
            else if (isAdded && num) addedNums.add(num);
            if ((isDetour || isModified) && num) modifiedNums.add(num);
          }
        }

        // Include any corresponding routes sharing the same bus number
        if (impactedNums.size > 0) {
          for (const [brid, br] of Object.entries(baseRoutes)) {
            const bNum = String(br.number || '').trim();
            if (bNum && impactedNums.has(bNum)) {
              addChangedRid(brid);
              if (br.id) addChangedRid(br.id);
            }
          }
          for (const [srid, sr] of Object.entries(simRoutes)) {
            const sNum = String(sr.number || '').trim();
            if (sNum && impactedNums.has(sNum)) {
              addChangedRid(srid);
              if (sr.id) addChangedRid(sr.id);
              if (sr.baseId) addChangedRid(sr.baseId);
            }
          }
        }

        for (const [rid, br] of Object.entries(baseRoutes)) {
          if (!simRoutes[rid] && !Object.values(simRoutes).some((sr) => sr.baseId === rid)) {
            const num = String(br.number || '').trim();
            if (num) {
              impactedNums.add(num);
              suspendedNums.add(num);
            }
            addChangedRid(rid);
            if (br.id) addChangedRid(br.id);
          }
        }

        // Compute world bounding box of active changes & area name tags on map
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        const expandPt = (x, y) => {
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        };
        const areaTags = [];
        for (const [aid, a] of Object.entries(simAreas)) {
          const poly = homeStore ? homeStore.areaPoly(a) : null;
          if (poly && poly.length) {
            let minY = Infinity, sumX = 0;
            for (const pt of poly) {
              if (!baseAreas[aid]) expandPt(pt.x, pt.y);
              sumX += pt.x;
              if (pt.y < minY) minY = pt.y;
            }
            const ownerIv = activeIntervals.slice().reverse().find((iv) => iv.patch && iv.patch.areas && iv.patch.areas.set && iv.patch.areas.set[aid]);
            areaTags.push({
              x: sumX / poly.length,
              y: minY - 14,
              name: ownerIv ? `${ownerIv.projectName} · ${a.name || 'Affected Area'}` : (a.name || 'Affected Area'),
              kind: (!ownerIv || ownerIv.isApplied) ? 'live' : 'draft',
            });
          }
        }
        for (const eidStr of Object.keys(simClosures)) {
          if (baseClosures[eidStr]) continue;
          const eObj = app.net && app.net.edge(Number(eidStr));
          if (eObj && eObj.pts) {
            for (const pt of eObj.pts) expandPt(pt.x, pt.y);
          }
        }
        for (const [sid, st] of Object.entries(simStops)) {
          const bst = baseStops[sid];
          if (!bst || bst.edge !== st.edge || Math.abs((bst.s || 0) - (st.s || 0)) > 1) {
            const p = app.net && app.net.posPoint(st, 0.78);
            if (p) expandPt(p.x, p.y);
          }
        }
        for (const rid of changedRouteIds) {
          const g = homeStore && homeStore.geom ? homeStore.geom[rid] : null;
          if (g && g.legs) {
            for (const leg of g.legs) {
              if (leg.pts) {
                for (const pt of leg.pts) expandPt(pt.x, pt.y);
              }
            }
          }
        }
        homeChangesBBox = x0 <= x1 ? { x0, y0, x1, y1 } : null;

        if (homeRenderer) {
          homeRenderer.visibleRouteIds = changesOnly ? changedRouteIds : null;
          homeRenderer.mapAreaTags = null;
          homeRenderer.requestRender();
        }

        // Diff summary items
        const rawChanges = c._computeProjectChanges ? c._computeProjectChanges(baseDoc, simDoc) : [];
        const groupedChanges = [];
        const seenCounts = new Map();
        for (const ch of rawChanges) {
          const key = `${ch.action}|${ch.text}`;
          if (seenCounts.has(key)) {
            seenCounts.get(key).count++;
          } else {
            const entry = { action: ch.action, text: ch.text, count: 1 };
            seenCounts.set(key, entry);
            groupedChanges.push(entry);
          }
        }

        homeLastSim = {
          stopsCount, stopsDelta, stopsOnClosed, baseStopsCount: Object.keys(baseStops).length,
          routesCount, routesDelta, baseRoutesCount,
          areasCount, areasDelta, areasList,
          closuresCount, closuresDelta, distinctClosedRoadsCount: distinctClosedRoads.size,
          impactedCount: impactedNums.size,
          divertedCount: divertedNums.size,
          disruptedCount: disruptedNums.size,
          addedCount: addedNums.size,
          suspendedCount: suspendedNums.size,
          modifiedRoutesCount: modifiedNums.size,
          activeIntervals,
          groupedChanges,
        };

        // Top cards: what the projects running now change, the same six figures as the project brief. Every running
        // project is applied to one map and worked out together, so where they overlap a route, stop or road counts once
        const combined = (!isBefore && activeIntervals.length)
          ? computeProjectBrief(baseDoc, simDoc, data.baseCalc || undefined, homeStore || undefined)
          : {};
        homeLastSim.combinedBrief = combined;
        const figures = briefFigures(combined);
        const totals = data.totals || {};
        for (const [key] of CHANGE_FIGURES) {
          const el = document.getElementById(`home-kpi-${key}`);
          if (el) el.innerHTML = changeValue(figures, key);
          const share = document.getElementById(`home-kpi-share-${key}`);
          if (share) {
            const s = changeShare(key, figures, combined, totals);
            share.innerHTML = `<b>${s.pct}</b><small>of ${s.of}</small>`;
            share.title = s.title;
          }
        }
      }

      // Update right-side Project Brief panel for active moment
      renderHomeProjectBrief(activeIntervals, data, t);
      syncHomePins(activeIntervals, data);

      // Update Upcoming Events Tomorrow & Upcoming Restores Tomorrow KPIs
      const nowTs = Date.now();
      const tmrwStart = new Date(nowTs + DAY_MS);
      tmrwStart.setHours(0, 0, 0, 0);
      const tmrwEnd = new Date(nowTs + DAY_MS);
      tmrwEnd.setHours(23, 59, 59, 999);
      const tmrwStartTs = tmrwStart.getTime();
      const tmrwEndTs = tmrwEnd.getTime();

      let upcomingTomorrowCount = 0;
      let restoreTomorrowCount = 0;

      for (const iv of intervals) {
        if (iv.start >= tmrwStartTs && iv.start <= tmrwEndTs) {
          upcomingTomorrowCount++;
        }
        if (iv.end >= tmrwStartTs && iv.end <= tmrwEndTs) {
          restoreTomorrowCount++;
        }
      }

      const elUpcomingEvents = document.getElementById('home-stat-upcoming-events');
      if (elUpcomingEvents) elUpcomingEvents.textContent = String(Math.max(1, upcomingTomorrowCount));

      const elUpcomingRestores = document.getElementById('home-stat-upcoming-restores');
      if (elUpcomingRestores) elUpcomingRestores.textContent = String(Math.max(1, restoreTomorrowCount));
    };

    const setHomePresetToday = () => {
      pauseHomePlayback();
      const now = Date.now();
      const fromDay = new Date(now);
      fromDay.setHours(0, 0, 0, 0);
      const toDay = new Date(now);
      toDay.setHours(23, 59, 59, 999);
      homeRange = { from: fromDay.getTime(), to: toDay.getTime() };
      if (homeTlFrom) homeTlFrom.value = toLocalDateStr(homeRange.from);
      if (homeTlTo) homeTlTo.value = toLocalDateStr(homeRange.to);
      if (homeTlTodayBtn) homeTlTodayBtn.classList.add('active');
      document.querySelectorAll('.home-tl-preset[data-days]').forEach((b) => b.classList.remove('active'));
      setHomeSliderToTime(now);
      renderHomeTimelineDecorations();
      updateHomeAtTime(getHomeSliderTime());
    };

    const setHomePresetDays = (days, jumpToNow = false) => {
      const now = Date.now();
      const leadDays = Math.min(2, Math.max(1, Math.floor(days * 0.15)));
      const fromDay = new Date(now - leadDays * DAY_MS);
      fromDay.setHours(0, 0, 0, 0);
      const toDay = new Date(fromDay.getTime() + (days - 1) * DAY_MS);
      toDay.setHours(23, 59, 59, 999);
      const prevT = homeRange ? getHomeSliderTime() : now;
      homeRange = { from: fromDay.getTime(), to: toDay.getTime() };
      if (homeTlFrom) homeTlFrom.value = toLocalDateStr(homeRange.from);
      if (homeTlTo) homeTlTo.value = toLocalDateStr(homeRange.to);
      if (homeTlTodayBtn) homeTlTodayBtn.classList.remove('active');
      document.querySelectorAll('.home-tl-preset[data-days]').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.days) === days);
      });
      const targetT = jumpToNow || prevT < homeRange.from || prevT > homeRange.to ? now : prevT;
      setHomeSliderToTime(targetT);
      renderHomeTimelineDecorations();
      updateHomeAtTime(getHomeSliderTime());
    };

    const initHomeRangeIfNeeded = () => {
      if (homeRange) return;
      const data = homeTimelineData || buildHomeTimelineData();
      const now = Date.now();
      let from = new Date(now - 2 * DAY_MS);
      from.setHours(0, 0, 0, 0);
      let to = new Date(from.getTime() + 13 * DAY_MS);
      to.setHours(23, 59, 59, 999);

      // Expand default window if scheduled projects sit within ±45 days
      for (const iv of data.intervals) {
        if (iv.start >= now - 45 * DAY_MS && iv.start < from.getTime()) {
          from = new Date(iv.start - DAY_MS);
          from.setHours(0, 0, 0, 0);
        }
        if (iv.end < Infinity && iv.end <= now + 45 * DAY_MS && iv.end > to.getTime()) {
          to = new Date(iv.end + DAY_MS);
          to.setHours(23, 59, 59, 999);
        }
      }
      homeRange = { from: from.getTime(), to: to.getTime() };
      if (homeTlFrom) homeTlFrom.value = toLocalDateStr(homeRange.from);
      if (homeTlTo) homeTlTo.value = toLocalDateStr(homeRange.to);
      setHomeSliderToTime(now);
    };

    // Everything the Home timeline is worked out from. Working it out copies whole maps, so while this stays the
    // same (it changes at least once a minute, as "now" moves on) the last one is kept
    let homeTimelineSig = null;
    const homeSig = () => {
      const raw = (key) => (B.storedRaw && B.storedRaw(key)) || '';
      const drafts = Boolean(homeTlIncludeDrafts && homeTlIncludeDrafts.checked);
      const u = B.currentUser || {};
      return JSON.stringify([
        Math.floor(Date.now() / 60000), drafts, u.id || u.email || '', c.activeProjectId, c.store.rev,
        (c.scheduledChanges || []).map((sc) => sc && [sc.id, sc.status, sc.mode, sc.start, sc.end, sc.projectId, sc.projectName, sc.patch]),
        (c.mapVersions || []).map((v) => [v.type, v.projectId]),
        raw('brass_proj_doc_main'), raw('brass_scheduled_base'),
        (c.projects || []).map((p) => [p.id, p.status, p.updatedAt, p.applyPeriod || null, !!p.autoFromSchedule,
          drafts ? raw('brass_proj_doc_' + p.id) + raw('brass_proj_base_' + p.id) : '']),
      ]);
    };

    const syncHomeDashboard = () => {
      if (!homePage || homePage.hidden) return;
      ensureHomeMap();
      if (c._syncProjectScheduleStatuses) c._syncProjectScheduleStatuses({ silent: true });
      const sig = homeSig();
      if (!homeTimelineData || sig !== homeTimelineSig) {
        buildHomeTimelineData();
        homeTimelineSig = sig;
      }
      initHomeRangeIfNeeded();
      if (homeRenderer) {
        homeRenderer.resize();
        if (!homeInitialFitted && homeRenderer.width > 40 && homeRenderer.height > 40) {
          homeInitialFitted = true;
          homeRenderer.fitToBoundary(0.06);
        } else if (!homeInitialFitted) {
          requestAnimationFrame(() => {
            if (!homePage || homePage.hidden || !homeRenderer) return;
            homeRenderer.resize();
            if (!homeInitialFitted && homeRenderer.width > 40 && homeRenderer.height > 40) {
              homeInitialFitted = true;
              homeRenderer.fitToBoundary(0.06);
            }
            renderHomeTimelineDecorations();
          });
        }
      }
      renderHomeTimelineDecorations();
      updateHomeAtTime(getHomeSliderTime());
    };

    // Wire Home timeline & map UI events
    const onHomeDateInput = () => {
      pauseHomePlayback();
      let a = parseLocalDayStart(homeTlFrom && homeTlFrom.value);
      let b = parseLocalDayEnd(homeTlTo && homeTlTo.value);
      if (isNaN(a) && isNaN(b)) return;
      if (isNaN(a)) a = b - 7 * DAY_MS;
      if (isNaN(b) || b <= a) {
        b = a + DAY_MS - 1;
        if (homeTlTo) homeTlTo.value = toLocalDateStr(b);
      }
      const prevT = homeRange ? getHomeSliderTime() : Date.now();
      homeRange = { from: a, to: b };
      const isToday = (
        toLocalDateStr(a) === toLocalDateStr(Date.now()) &&
        toLocalDateStr(b) === toLocalDateStr(Date.now())
      );
      if (homeTlTodayBtn) homeTlTodayBtn.classList.toggle('active', isToday);
      document.querySelectorAll('.home-tl-preset[data-days]').forEach((btn) => btn.classList.remove('active'));
      setHomeSliderToTime(prevT >= a && prevT <= b ? prevT : Date.now());
      renderHomeTimelineDecorations();
      updateHomeAtTime(getHomeSliderTime());
    };
    if (homeTlFrom) homeTlFrom.addEventListener('change', onHomeDateInput);
    if (homeTlTo) homeTlTo.addEventListener('change', onHomeDateInput);

    document.querySelectorAll('.home-tl-preset[data-days]').forEach((btn) => {
      btn.addEventListener('click', () => {
        pauseHomePlayback();
        setHomePresetDays(Number(btn.dataset.days) || 14, false);
      });
    });

    if (homeTlTodayBtn) {
      homeTlTodayBtn.addEventListener('click', () => {
        setHomePresetToday();
      });
    }

    let hasShownOpeningUpcomingToast = false;
    const showOpeningUpcomingToast = () => {
      if (hasShownOpeningUpcomingToast) return;
      hasShownOpeningUpcomingToast = true;

      setTimeout(() => {
        try {
          const tlData = homeTimelineData || (typeof buildHomeTimelineData === 'function' ? buildHomeTimelineData() : null);
          const intervals = (tlData && tlData.intervals) || [];
          const nowTs = Date.now();
          const tmrwStart = new Date(nowTs + DAY_MS);
          tmrwStart.setHours(0, 0, 0, 0);
          const tmrwEnd = new Date(nowTs + DAY_MS);
          tmrwEnd.setHours(23, 59, 59, 999);
          const tmrwStartTs = tmrwStart.getTime();
          const tmrwEndTs = tmrwEnd.getTime();

          let upcomingTomorrowCount = 0;
          let restoreTomorrowCount = 0;
          for (const iv of intervals) {
            if (iv.start >= tmrwStartTs && iv.start <= tmrwEndTs) upcomingTomorrowCount++;
            if (iv.end >= tmrwStartTs && iv.end <= tmrwEndTs) restoreTomorrowCount++;
          }

          const evCount = Math.max(1, upcomingTomorrowCount);
          const resCount = Math.max(1, restoreTomorrowCount);

          const evPlural = evCount === 1 ? 'Event' : 'Events';
          const resPlural = resCount === 1 ? 'Restore' : 'Restores';

          const eventHtml = `<span class="home-toast-icon toast-icon-violet"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/></svg></span> <span><strong>${evCount}</strong> Upcoming ${evPlural} Tomorrow</span>`;
          const restoreHtml = `<span class="home-toast-icon toast-icon-teal"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg></span> <span><strong>${resCount}</strong> Upcoming ${resPlural} Tomorrow</span>`;

          const t1 = c._showToast ? c._showToast(eventHtml, 'info', 5000) : null;
          if (t1) {
            t1.style.cursor = 'pointer';
            t1.title = "Click to jump timeline to tomorrow's event";
            t1.addEventListener('click', (e) => {
              if (e.target.closest('.toast-close-btn')) return;
              pauseHomePlayback();
              const tmrw9am = new Date(Date.now() + DAY_MS);
              tmrw9am.setHours(9, 0, 0, 0);
              if (homeRange && (tmrw9am.getTime() < homeRange.from || tmrw9am.getTime() > homeRange.to)) {
                setHomePresetDays(7, false);
              }
              setHomeSliderToTime(tmrw9am.getTime());
              updateHomeAtTime(tmrw9am.getTime());
              const closeBtn = t1.querySelector('.toast-close-btn');
              if (closeBtn) closeBtn.click();
            });
          }

          setTimeout(() => {
            const t2 = c._showToast ? c._showToast(restoreHtml, 'info', 5000) : null;
            if (t2) {
              t2.style.cursor = 'pointer';
              t2.title = "Click to jump timeline to tomorrow's restoration";
              t2.addEventListener('click', (e) => {
                if (e.target.closest('.toast-close-btn')) return;
                pauseHomePlayback();
                const tmrw6pm = new Date(Date.now() + DAY_MS);
                tmrw6pm.setHours(18, 0, 0, 0);
                if (homeRange && (tmrw6pm.getTime() < homeRange.from || tmrw6pm.getTime() > homeRange.to)) {
                  setHomePresetDays(7, false);
                }
                setHomeSliderToTime(tmrw6pm.getTime());
                updateHomeAtTime(tmrw6pm.getTime());
                const closeBtn = t2.querySelector('.toast-close-btn');
                if (closeBtn) closeBtn.click();
              });
            }
          }, 180);
        } catch (e) {
          console.warn('Could not show upcoming toast on open', e);
        }
      }, 500);
    };

    const homeCompareBtns = document.querySelectorAll('#home-compare-tabs [data-compare]');
    homeCompareBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.compare === 'before' ? 'before' : 'after';
        if (mode === homeCompareMode) return;
        homeCompareMode = mode;
        homeCompareBtns.forEach((b) => {
          const act = (b.dataset.compare === homeCompareMode);
          b.classList.toggle('active', act);
          b.setAttribute('aria-pressed', String(act));
        });
        homeActiveSig = null;
        homeBriefRenderKey = null;
        updateHomeAtTime(getHomeSliderTime());
      });
    });

    if (homeTlIncludeDrafts) {
      homeTlIncludeDrafts.addEventListener('change', () => {
        homeTimelineData = null;
        homeActiveSig = null;
        homeBriefRenderKey = null;
        buildHomeTimelineData();
        renderHomeTimelineDecorations();
        updateHomeAtTime(getHomeSliderTime());
      });
    }
    if (homeTlChangesOnly) {
      homeTlChangesOnly.addEventListener('change', () => {
        homeActiveSig = null;
        updateHomeAtTime(getHomeSliderTime());
      });
    }

    if (homeTlSlider) {
      let scrubRaf = null;
      homeTlSlider.addEventListener('pointerdown', pauseHomePlayback);
      homeTlSlider.addEventListener('input', () => {
        if (scrubRaf) return;
        scrubRaf = requestAnimationFrame(() => {
          scrubRaf = null;
          updateHomeAtTime(getHomeSliderTime());
        });
      });
      homeTlSlider.addEventListener('change', () => {
        if (scrubRaf) {
          cancelAnimationFrame(scrubRaf);
          scrubRaf = null;
        }
        updateHomeAtTime(getHomeSliderTime());
      });
    }

    if (homeTlPlayBtn) {
      homeTlPlayBtn.addEventListener('click', () => {
        if (homePlayRaf) {
          pauseHomePlayback();
          return;
        }
        if (!homeRange || !homeTlSlider) return;
        if (Number(homeTlSlider.value) >= 998) {
          homeTlSlider.value = '0';
          updateHomeAtTime(getHomeSliderTime());
        }
        homeTlPlayBtn.classList.add('is-playing');
        homeTlPlayBtn.textContent = '⏸';
        homeTlPlayBtn.title = 'Pause playback';
        homeTlPlayBtn.setAttribute('aria-label', 'Pause timeline');
        let exactVal = Number(homeTlSlider.value);
        homePlayLastTs = performance.now();
        const stepPlay = (nowPerf) => {
          if (!homePlayRaf) return;
          const dt = Math.min(100, nowPerf - homePlayLastTs);
          homePlayLastTs = nowPerf;
          exactVal += (dt / 12000) * 1000; // full date range in ~12s
          if (exactVal >= 1000) {
            homeTlSlider.value = '1000';
            updateHomeAtTime(getHomeSliderTime());
            pauseHomePlayback();
            return;
          }
          homeTlSlider.value = String(Math.round(exactVal));
          updateHomeAtTime(getHomeSliderTime());
          homePlayRaf = requestAnimationFrame(stepPlay);
        };
        homePlayRaf = requestAnimationFrame(stepPlay);
      });
    }

    // ------------------------------------------------------------- Home Layers & Visibility Pop-up
    const homeLayerMapping = {
      'home-layer-routes': { keys: ['existingRoutes', 'proposedRoutes'], peerId: 'layer-routes' },
      'home-layer-interchanges': { keys: ['busInterchanges'], peerId: 'layer-interchanges' },
      'home-layer-stop-points': { keys: ['stopPoints', 'stops'], peerId: 'layer-stop-points' },
      'home-layer-stop-names': { keys: ['stopNames'], peerId: 'layer-stop-names' },
      'home-layer-mrt': { keys: ['mrtStations'], peerId: 'layer-mrt' },
      'home-layer-closures': { keys: ['closures'], peerId: 'layer-closures' },
      'home-layer-areas': { keys: ['affectedAreas'], peerId: 'layer-areas' },
      'home-layer-buildings': { keys: ['buildings', 'parks', 'waterways'], peerId: 'layer-buildings' },
    };

    const syncHomeLayersUI = () => {
      const rend = homeRenderer || (app && app.renderer);
      if (!rend) return;
      Object.entries(homeLayerMapping).forEach(([chkId, meta]) => {
        const chk = document.getElementById(chkId);
        if (chk) {
          const isVisible = meta.keys.every((k) => rend.layers[k] !== false);
          chk.checked = isVisible;
        }
      });
      const opacity = typeof rend.mapOpacity === 'number' ? Math.round(rend.mapOpacity * 100) : 100;
      const opacitySlider = document.getElementById('home-map-opacity-slider');
      const opacityBadge = document.getElementById('home-map-opacity-badge');
      if (opacitySlider) opacitySlider.value = String(opacity);
      if (opacityBadge) opacityBadge.textContent = `${opacity}%`;
    };

    const initHomeLayers = () => {
      const homeViewBtn = document.getElementById('home-btn-view-setting');
      const homeViewPop = document.getElementById('home-view-setting-pop');
      const homeViewClose = document.getElementById('home-view-setting-close');
      const openHomeViewSetting = (v) => {
        if (!homeViewPop || !homeViewBtn) return;
        homeViewPop.hidden = !v;
        homeViewBtn.classList.toggle('on', Boolean(v));
        homeViewBtn.setAttribute('aria-expanded', String(Boolean(v)));
      };

      if (homeViewBtn && homeViewPop) {
        homeViewBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openHomeViewSetting(homeViewPop.hidden);
        });
        if (homeViewClose) {
          homeViewClose.addEventListener('click', (e) => {
            e.stopPropagation();
            openHomeViewSetting(false);
          });
        }
        homeViewPop.addEventListener('click', (e) => e.stopPropagation());
        document.addEventListener('click', (e) => {
          if (!homeViewPop.hidden && !homeViewPop.contains(e.target) && !homeViewBtn.contains(e.target)) {
            openHomeViewSetting(false);
          }
        });
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') openHomeViewSetting(false);
        });
      }

      Object.entries(homeLayerMapping).forEach(([chkId, meta]) => {
        const chk = document.getElementById(chkId);
        if (chk) {
          chk.addEventListener('change', (e) => {
            const val = e.target.checked;
            if (homeRenderer) {
              meta.keys.forEach((k) => (homeRenderer.layers[k] = val));
              homeRenderer.requestRender();
            }
            if (app && app.renderer) {
              meta.keys.forEach((k) => (app.renderer.layers[k] = val));
              app.renderer.requestRender();
            }
            const peer = document.getElementById(meta.peerId);
            if (peer && peer.checked !== val) peer.checked = val;
          });
        }
      });

      const homeOpacitySlider = document.getElementById('home-map-opacity-slider');
      const homeOpacityBadge = document.getElementById('home-map-opacity-badge');
      const peerOpacitySlider = document.getElementById('map-opacity-slider');
      const peerOpacityBadge = document.getElementById('map-opacity-badge');
      if (homeOpacitySlider) {
        homeOpacitySlider.addEventListener('input', (e) => {
          const num = Math.round(Number(e.target.value));
          if (homeOpacityBadge) homeOpacityBadge.textContent = `${num}%`;
          if (homeRenderer) homeRenderer.setMapOpacity(num / 100);
          if (app && app.renderer) app.renderer.setMapOpacity(num / 100);
          if (peerOpacitySlider && Number(peerOpacitySlider.value) !== num) {
            peerOpacitySlider.value = String(num);
            if (peerOpacityBadge) peerOpacityBadge.textContent = `${num}%`;
          }
        });
      }

      if (peerOpacitySlider) {
        peerOpacitySlider.addEventListener('input', (e) => {
          const num = Math.round(Number(e.target.value));
          if (homeOpacitySlider && Number(homeOpacitySlider.value) !== num) {
            homeOpacitySlider.value = String(num);
            if (homeOpacityBadge) homeOpacityBadge.textContent = `${num}%`;
          }
          if (homeRenderer) homeRenderer.setMapOpacity(num / 100);
        });
      }

      Object.entries(homeLayerMapping).forEach(([chkId, meta]) => {
        const peer = document.getElementById(meta.peerId);
        const chk = document.getElementById(chkId);
        if (peer && chk) {
          peer.addEventListener('change', (e) => {
            chk.checked = e.target.checked;
            if (homeRenderer) {
              meta.keys.forEach((k) => (homeRenderer.layers[k] = e.target.checked));
              homeRenderer.requestRender();
            }
          });
        }
      });

      syncHomeLayersUI();
      window.brassHomeRenderer = homeRenderer;
    };

    initHomeLayers();

    if (B.events && typeof B.events.on === 'function') {
      B.events.on('doc', () => {
        homeActiveSig = null;
        if (currentMainView === 'home' && homePage && !homePage.hidden && !root.classList.contains('in-map')) {
          syncHomeDashboard();
        }
      });
    }

    window.addEventListener('brass-project-status-auto', () => {
      homeTimelineData = null;
      homeActiveSig = null;
      if (root.classList.contains('in-map')) return;
      if (currentMainView === 'home' && homePage && !homePage.hidden) {
        syncHomeDashboard();
      } else if (currentMainView === 'projects' && projectsPage && !projectsPage.hidden) {
        const active = document.activeElement;
        if (active && list && list.contains(active) && active.matches('input, select, textarea')) {
          list.querySelectorAll('.pp-row').forEach((row) => {
            const p = c.projects && c.projects.find((x) => x.id === row.dataset.id);
            const sel = row.querySelector('.pp-status-select');
            if (p && sel) {
              sel.value = statusOf(p);
              sel.className = `pp-status-select st-${statusOf(p)}`;
            }
          });
          const chips = document.getElementById('pp-status-tabs');
          if (chips && c.projects) {
            const n = (key) => c.projects.filter((x) => showsInProjectMenu(x) && (key === 'all' ? statusOf(x) !== 'archive' : statusOf(x) === key)).length;
            chips.querySelectorAll('.pp-status-tab').forEach((ch) => {
              const k = ch.dataset.status;
              const cnt = n(k);
              const badge = ch.querySelector('.pp-status-tab-n');
              if (badge) badge.textContent = String(cnt);
              if (k !== 'all') ch.disabled = !cnt;
            });
          }
        } else {
          render();
        }
      }
    });

    const syncHomeRole = () => {
      const user = (B.currentUser || { name: 'John Doe', role: 'Bus Ops', initials: 'JD' });
      const nameBadge = document.getElementById('home-hero-user-name');
      if (nameBadge) nameBadge.textContent = user.name;
      const roleBadge = document.getElementById('home-hero-role');
      if (roleBadge) roleBadge.textContent = user.role;
      if (currentMainView === 'home' && homePage && !homePage.hidden) {
        syncHomeDashboard();
      }
    };

    const syncUserAccessVisibility = () => {
      const isAdmin = (B.currentRole === 'Admin' || (B.currentUser && B.currentUser.role === 'Admin'));
      if (navUsers) {
        navUsers.hidden = !isAdmin;
        navUsers.style.display = isAdmin ? '' : 'none';
      }
      if (!isAdmin && currentMainView === 'users') {
        switchMainView('projects');
      }
    };

    const switchMainView = (view) => {
      // A shared Home link shows the dashboard on its own: it never moves to another page
      if (dashShare) view = 'home';
      currentMainView = view;
      root.classList.remove('in-map');
      try {
        sessionStorage.setItem('brass_in_map', '0');
        sessionStorage.setItem('brass_main_view', view);
      } catch (e) {}
      if (view !== 'home') pauseHomePlayback();

      if (settingsPage) settingsPage.hidden = view !== 'settings';
      setNavSettings(view === 'settings');

      if (view === 'settings') {
        if (homePage) homePage.hidden = true;
        if (projectsPage) projectsPage.hidden = true;
        if (usersPage) usersPage.hidden = true;
        if (navHome) { navHome.classList.remove('active'); navHome.removeAttribute('aria-current'); }
        if (navProjects) { navProjects.classList.remove('active'); navProjects.removeAttribute('aria-current'); }
        if (navUsers) { navUsers.classList.remove('active'); navUsers.removeAttribute('aria-current'); }
        if (B.renderSettingsPage) B.renderSettingsPage();
      } else if (view === 'home') {
        if (homePage) homePage.hidden = false;
        if (projectsPage) projectsPage.hidden = true;
        if (usersPage) usersPage.hidden = true;
        if (navHome) { navHome.classList.add('active'); navHome.setAttribute('aria-current', 'page'); }
        if (navProjects) { navProjects.classList.remove('active'); navProjects.removeAttribute('aria-current'); }
        if (navUsers) { navUsers.classList.remove('active'); navUsers.removeAttribute('aria-current'); }
        syncHomeDashboard();
        showOpeningUpcomingToast();
      } else if (view === 'users') {
        const isAdmin = (B.currentRole === 'Admin' || (B.currentUser && B.currentUser.role === 'Admin'));
        if (!isAdmin) {
          toast('Access restricted: Administrators only', 'warn');
          return switchMainView('projects');
        }
        if (homePage) homePage.hidden = true;
        if (projectsPage) projectsPage.hidden = true;
        if (usersPage) usersPage.hidden = false;
        if (navHome) { navHome.classList.remove('active'); navHome.removeAttribute('aria-current'); }
        if (navProjects) { navProjects.classList.remove('active'); navProjects.removeAttribute('aria-current'); }
        if (navUsers) { navUsers.classList.add('active'); navUsers.setAttribute('aria-current', 'page'); }
        const viewMembers = document.getElementById('users-view-members');
        const viewRoles = document.getElementById('users-view-roles');
        if (viewMembers) viewMembers.hidden = false;
        if (viewRoles) viewRoles.hidden = true;
        renderUsersAccessControl();
      } else { // 'projects'
        if (homePage) homePage.hidden = true;
        if (projectsPage) projectsPage.hidden = false;
        if (usersPage) usersPage.hidden = true;
        if (navHome) { navHome.classList.remove('active'); navHome.removeAttribute('aria-current'); }
        if (navProjects) { navProjects.classList.add('active'); navProjects.setAttribute('aria-current', 'page'); }
        if (navUsers) { navUsers.classList.remove('active'); navUsers.removeAttribute('aria-current'); }
        render();
      }
      if (typeof window.updateRecommendedPhrases === 'function') {
        window.updateRecommendedPhrases();
      }
    };

    syncUserAccessVisibility();

    window.addEventListener('brass-role-change', () => {
      syncHomeRole();
      syncUserAccessVisibility();
      if (currentMainView === 'users') renderUsersAccessControl();
    });

    const syncNav = () => {
      const inMap = root.classList.contains('in-map');
      if (inMap) {
        if (navHome) { navHome.classList.remove('active'); navHome.removeAttribute('aria-current'); }
        if (navProjects) { navProjects.classList.remove('active'); navProjects.removeAttribute('aria-current'); }
        if (navUsers) { navUsers.classList.remove('active'); navUsers.removeAttribute('aria-current'); }
        setNavSettings(false);
      } else {
        switchMainView(currentMainView);
      }
    };

    const show = () => {
      switchMainView('home');
    };
    const picker = document.getElementById('pp-file');
    let attachTo = null;
    picker.addEventListener('change', async () => {
      const files = [...picker.files];
      picker.value = '';
      let added = 0;
      for (const f of files) {
        if (f.size > MAX) { toast(`${f.name} is over 25 MB`, 'error'); continue; }
        try { await B.docs.add(attachTo, f); added++; } catch (e) { toast('Could not attach', 'error'); }
      }
      if (files.length) {
        if (c._markProjectInProgress) c._markProjectInProgress(attachTo);
        toast('Attached', 'success');
      }
      // the next time this project's map opens, the documents are read again and the new ones asked about
      if (files.length && B.docsChanged) B.docsChanged(attachTo);
      if (added) openDocs.add(attachTo); // show the uploaded list
      render();
    });
    if (search) {
      search.addEventListener('input', () => { query = search.value; render(); });
      search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { search.value = ''; query = ''; render(); } });
    }
    const chipRow = document.getElementById('pp-status-tabs');
    if (chipRow) chipRow.addEventListener('click', (e) => { const b = e.target.closest('.pp-status-tab'); if (b && !b.disabled) { statusFilter = b.dataset.status; render(); } });
    list.addEventListener('change', (e) => {
      const sel = e.target.closest('.pp-status-select');
      if (!sel) return;
      const p = c.projects.find((x) => x.id === sel.closest('.pp-row').dataset.id);
      if (!p) return;
      if (!isUserProjectOwner(p)) {
        toast('Only the Project Owner can change project status', 'warn');
        render();
        return;
      }
      const nextStatus = sel.value;
      const now = Date.now();
      // The open project's edits are kept before it can become archived (an archived map isn't saved)
      if (p.id === c.activeProjectId) c._saveCurrentProjectDraft(false);
      if (nextStatus === 'schedule') {
        if (!p.applyPeriod) p.applyPeriod = c._defaultApplyPeriod();
        const s = span(p);
        if (s.start <= now) {
          // Default to tomorrow at the next whole hour when scheduling a project whose From is already in the past
          const startDt = new Date(now + DAY_MS);
          startDt.setMinutes(0, 0, 0);
          const endDt = new Date(startDt.getTime() + DAY_MS);
          const pad2 = (n) => String(n).padStart(2, '0');
          const fmtD = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
          const fmtT = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
          p.applyPeriod = Object.assign({}, p.applyPeriod, {
            startDate: fmtD(startDt),
            startTime: fmtT(startDt),
            ...(p.applyPeriod.mode === 'scheduled' ? { endDate: fmtD(endDt), endTime: fmtT(endDt) } : {}),
          });
          toast(`Scheduled for ${fmt(startDt.getTime())} — adjust From date/time below if needed`, 'info');
        } else if (s.end <= now) {
          const endDt = new Date(s.start + DAY_MS);
          const pad2 = (n) => String(n).padStart(2, '0');
          p.applyPeriod = Object.assign({}, p.applyPeriod, {
            endDate: `${endDt.getFullYear()}-${pad2(endDt.getMonth() + 1)}-${pad2(endDt.getDate())}`,
            endTime: `${pad2(endDt.getHours())}:${pad2(endDt.getMinutes())}`,
          });
        }
        p.status = 'schedule';
        delete p.autoFromSchedule;
        delete p.manualNotStarted;
      } else if (nextStatus === 'go_live') {
        if (span(p).end <= now) {
          p.applyPeriod = c._defaultApplyPeriod();
        }
        p.status = 'go_live';
        delete p.autoFromSchedule;
        delete p.manualNotStarted;
        toast(`"${esc(p.name)}" is now Go-Live`, 'success');
      } else {
        p.status = nextStatus;
        delete p.autoFromSchedule;
        if (nextStatus === 'not_started') p.manualNotStarted = true;
        else delete p.manualNotStarted;
        if (Array.isArray(c.scheduledChanges) && c.scheduledChanges.some((sc) => sc && sc.projectId === p.id)) {
          c.scheduledChanges = c.scheduledChanges.filter((sc) => !sc || sc.projectId !== p.id);
          if (c._saveScheduledChanges) c._saveScheduledChanges();
        }
      }
      p.updatedAt = now;
      sel.className = `pp-status-select st-${statusOf(p)}`;
      c._saveProjects();
      if (c._syncForeignObstacles && c.renderer) c._syncForeignObstacles();
      homeTimelineData = null;
      homeActiveSig = null;
      render();
    });

    const onRange = () => {
      const a = tlFrom.value ? new Date(`${tlFrom.value}T00:00`).getTime() : NaN;
      const b = tlTo.value ? new Date(`${tlTo.value}T23:59:59`).getTime() : NaN;
      if (isNaN(a) || isNaN(b) || b < a) {
        tl = null;
        tlSlider.disabled = true;
      } else {
        tl = { from: a, to: b, scrubbing: false };
        tlSlider.disabled = false;
        // Start at now when it's in the range, else at the start
        const now = Date.now();
        tlSlider.value = String(now > a && now < b ? Math.round(((now - a) / (b - a)) * 1000) : 0);
      }
      syncDatePickerBtn();
      render();
    };
    const clearDateRange = () => {
      if (tlFrom) tlFrom.value = '';
      if (tlTo) tlTo.value = '';
      onRange();
    };
    const fmtYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (ppDateBtn && ppDatePop) {
      ppDateBtn.addEventListener('click', (e) => {
        if (e.target.closest && e.target.closest('#pp-date-clear')) return;
        e.stopPropagation();
        ppDatePop.hidden = !ppDatePop.hidden;
        ppDateBtn.setAttribute('aria-expanded', String(!ppDatePop.hidden));
      });
      ppDatePop.addEventListener('click', (e) => e.stopPropagation());
      document.addEventListener('click', () => {
        if (!ppDatePop.hidden) {
          ppDatePop.hidden = true;
          ppDateBtn.setAttribute('aria-expanded', 'false');
        }
      });
      ppDatePop.querySelectorAll('.pp-date-preset').forEach((btn) => {
        btn.addEventListener('click', () => {
          const now = new Date();
          const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          let end = new Date(start);
          const p = btn.dataset.preset;
          if (p === '7d') end.setDate(end.getDate() + 7);
          else if (p === '30d') end.setDate(end.getDate() + 30);
          else if (p === 'month') {
            start.setDate(1);
            end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
          }
          if (tlFrom) tlFrom.value = fmtYmd(start);
          if (tlTo) tlTo.value = fmtYmd(end);
          onRange();
          ppDatePop.hidden = true;
          ppDateBtn.setAttribute('aria-expanded', 'false');
        });
      });
    }
    if (ppDateClear) {
      ppDateClear.addEventListener('click', (e) => { e.stopPropagation(); clearDateRange(); });
      ppDateClear.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); clearDateRange(); } });
    }
    if (ppDateReset) ppDateReset.addEventListener('click', () => { clearDateRange(); });
    tlFrom.addEventListener('change', onRange);
    tlTo.addEventListener('change', onRange);
    // One list rebuild per frame while sliding
    let tlFrame = null;
    tlSlider.addEventListener('input', () => {
      if (tl) tl.scrubbing = true;
      if (tlFrame) return;
      tlFrame = requestAnimationFrame(() => { tlFrame = null; render(); });
    });
    tlClose.addEventListener('click', clearDateRange);
    // The scale picks its step from the slider's width
    window.addEventListener('resize', () => { if (tl) { tlScale(); tlPlace(); } });
    const sbtn = document.getElementById('pp-sort-btn'), smenu = document.getElementById('pp-sort-menu');
    const ssync = () => {
      document.getElementById('pp-sort-label').textContent = SORTS[sortKey] + (periodFilter === 'all' ? '' : ` · ${PERIODS[periodFilter]}`) + (mineOnly ? ' · Mine' : '');
      document.getElementById('pp-sort-dir').textContent = newestFirst ? 'Newest first' : 'Oldest first';
      smenu.querySelectorAll('[data-sort]').forEach((b) => b.classList.toggle('on', b.dataset.sort === sortKey));
      smenu.querySelectorAll('[data-period]').forEach((b) => b.classList.toggle('on', b.dataset.period === periodFilter));
      const own = document.getElementById('pp-sort-mine');
      own.classList.toggle('on', mineOnly);
      own.setAttribute('aria-pressed', String(mineOnly));
    };
    if (sbtn) {
      ssync();
      sbtn.addEventListener('click', (e) => { e.stopPropagation(); smenu.hidden = !smenu.hidden; sbtn.setAttribute('aria-expanded', String(!smenu.hidden)); });
      smenu.addEventListener('click', (e) => e.stopPropagation());
      smenu.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => { sortKey = b.dataset.sort; ssync(); smenu.hidden = true; render(); }));
      smenu.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => { periodFilter = b.dataset.period; ssync(); smenu.hidden = true; render(); }));
      document.getElementById('pp-sort-mine').addEventListener('click', () => { mineOnly = !mineOnly; ssync(); smenu.hidden = true; render(); });
      document.getElementById('pp-sort-dir').addEventListener('click', () => { newestFirst = !newestFirst; ssync(); render(); });
      document.addEventListener('click', () => { smenu.hidden = true; sbtn.setAttribute('aria-expanded', 'false'); });
    }
    document.querySelectorAll('.pp-tab').forEach((t) => t.addEventListener('click', () => { view = t.dataset.view; render(); }));
    const open = (id) => {
      if (dashShare) return;
      mapReturnView = currentMainView || 'projects';
      pauseHomePlayback();
      root.classList.add('in-map');
      try { sessionStorage.setItem('brass_in_map', '1'); } catch (e) {}
      syncNav();
      c._switchProject(id, 'edit');
      // An archived project opens view-only (also when it was already the open one), and its documents aren't offered again
      const archived = c._isArchivedActive();
      if (archived) c.setMode('view');
      if (typeof window.updateRecommendedPhrases === 'function') window.updateRecommendedPhrases();
      window.dispatchEvent(new Event('resize'));
      // The whole map first, then the documents are read: any zoom to what they change comes after, not under it
      setTimeout(() => {
        renderer.fitToBoundary();
        if (B.offerSuggestions && !archived) B.offerSuggestions(id);
      }, 50);
    };

    const download = (blob, name) => {
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    };
    B.exportProjectJson = (id) => {
      const p = c.projects.find((x) => x.id === id);
      if (!p) return;
      const blob = new Blob([JSON.stringify({ project: p, map: docOf(id) })], { type: 'application/json' });
      download(blob, `${p.name.replace(/[^\w-]+/g, '_')}.json`);
    };
    B.exportProjectPdf = async (id) => {
      try { await B.downloadChangeReport(c, id); toast('PDF downloaded', 'success'); } catch (e) { toast('Export failed', 'error'); }
    };

    // Every delete asks first, in a small dialog
    const dlg = document.getElementById('pp-confirm');
    let onYes = null;
    let expectedConfirmName = '';
    const confirmInputWrap = document.getElementById('pp-confirm-input-wrap');
    const confirmInput = document.getElementById('pp-confirm-input');
    const yesBtn = dlg ? dlg.querySelector('[data-act=yes]') : null;

    const closeDlg = () => {
      dlg.hidden = true;
      onYes = null;
      expectedConfirmName = '';
      if (confirmInput) confirmInput.value = '';
      if (confirmInputWrap) confirmInputWrap.hidden = true;
      if (yesBtn) yesBtn.disabled = false;
    };

    const updateConfirmInputState = () => {
      if (!expectedConfirmName) {
        if (yesBtn) yesBtn.disabled = false;
        return true;
      }
      const val = (confirmInput ? confirmInput.value : '').trim().toLowerCase();
      const match = val === expectedConfirmName.trim().toLowerCase();
      if (yesBtn) yesBtn.disabled = !match;
      return match;
    };

    if (confirmInput) {
      confirmInput.addEventListener('input', updateConfirmInputState);
      confirmInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (updateConfirmInputState()) {
            const f = onYes;
            closeDlg();
            if (f) f();
          }
        }
      });
    }

    const ask = (title, text, yes, confirmName) => {
      dlg.querySelector('.pp-confirm-title').textContent = title;
      const textEl = dlg.querySelector('.pp-confirm-text');
      expectedConfirmName = confirmName ? String(confirmName).trim() : '';

      if (expectedConfirmName) {
        if (textEl) textEl.innerHTML = `Type <b>"${expectedConfirmName}"</b> to confirm:`;
        if (confirmInputWrap) confirmInputWrap.hidden = false;
        if (confirmInput) {
          confirmInput.value = '';
          confirmInput.placeholder = `Type "${expectedConfirmName}"`;
        }
        if (yesBtn) yesBtn.disabled = true;
        onYes = yes;
        dlg.hidden = false;
        setTimeout(() => { if (confirmInput) confirmInput.focus(); }, 50);
      } else {
        if (textEl) textEl.textContent = text;
        if (confirmInputWrap) confirmInputWrap.hidden = true;
        if (yesBtn) yesBtn.disabled = false;
        onYes = yes;
        dlg.hidden = false;
        const noBtn = dlg.querySelector('[data-act=no]');
        if (noBtn) noBtn.focus();
      }
    };
    B.askConfirm = ask;
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.closest('[data-act=no]')) return closeDlg();
      if (e.target.closest('[data-act=yes]')) {
        if (yesBtn && yesBtn.disabled) return;
        const f = onYes;
        closeDlg();
        if (f) f();
      }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !dlg.hidden) closeDlg(); });

    const exporter = (what, fn) => async (id) => {
      toast(`Preparing ${what}`, 'info');
      try { const file = await fn(c, id); toast(`${what} downloaded`, 'success'); return file; } catch (err) { toast(`${what} failed`, 'error'); console.error(err); }
    };
    B.exportProjectSlides = exporter('slides', (cc, id) => B.downloadSlides(cc, id));
    B.exportProjectPoster = exporter('poster', (cc, id) => B.downloadPoster(cc, id));
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.pp-export')) document.querySelectorAll('.pp-export-menu').forEach((m) => { m.hidden = true; });
      if (!e.target.closest('.pp-member-avatar-chip')) document.querySelectorAll('.pp-member-avatar-chip.show-tooltip').forEach((c) => c.classList.remove('show-tooltip'));
      if (!e.target.closest('.pp-add-collab-anchor')) {
        if (openCollabPickers.size > 0) {
          openCollabPickers.clear();
          document.querySelectorAll('.pp-collab-picker').forEach((p) => { p.hidden = true; });
        }
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.pp-member-avatar-chip.show-tooltip').forEach((c) => c.classList.remove('show-tooltip'));
      }
    });

    list.addEventListener('click', async (e) => {
      // Click avatar chip to toggle full name tooltip
      const avatarChip = e.target.closest('.pp-member-avatar-chip');
      if (avatarChip && !e.target.closest('.pp-member-remove')) {
        e.stopPropagation();
        const wasOpen = avatarChip.classList.contains('show-tooltip');
        document.querySelectorAll('.pp-member-avatar-chip.show-tooltip').forEach((c) => c.classList.remove('show-tooltip'));
        if (!wasOpen) avatarChip.classList.add('show-tooltip');
        return;
      }

      // Click project ID badge to copy ID
      const idBadge = e.target.closest('.pp-id-badge');
      if (idBadge) {
        e.stopPropagation();
        const pId = idBadge.dataset.projId;
        if (pId && navigator.clipboard) {
          navigator.clipboard.writeText(pId).then(() => {
            toast(`Copied project ID: ${pId}`, 'info');
          }).catch(() => {});
        }
        return;
      }

      const btn = e.target.closest('[data-act]');
      const row = e.target.closest('.pp-row');
      if (!row) return;
      const act = btn && btn.dataset.act;
      if (act === 'doc-get' || act === 'doc-del') {
        const docId = btn.closest('.pp-doc').dataset.doc;
        if (act === 'doc-del') {
          const d = (await B.docs.all()).find((x) => x.id === docId);
          return ask(`Delete ${d ? d.name : 'this document'}?`, 'The AI suggestions will change when you apply a map.', async () => {
            if (d && d.projectId && c._markProjectInProgress) c._markProjectInProgress(d.projectId);
            await B.docs.remove(docId);
            render();
          });
        }
        const d = (await B.docs.all()).find((x) => x.id === docId);
        return d && B.docs.download(d);
      }
      const id = row.dataset.id;
      if (!id) return;
      const p = c.projects.find((x) => x.id === id);
      const isOwner = isUserProjectOwner(p);
      if (act === 'rename') {
        if (!isOwner) return toast('Only the Project Owner can rename this project', 'warn');
        renaming = id;
        return render();
      }
      if (act === 'export') {
        const menu = btn.parentNode.querySelector('.pp-export-menu'), was = menu.hidden;
        document.querySelectorAll('.pp-export-menu').forEach((m) => { m.hidden = true; });
        menu.hidden = !was;
        return;
      }
      if (act === 'exp-link') { btn.closest('.pp-export-menu').hidden = true; return c._shareProject(id); }
      if (act === 'exp-pdf' || act === 'exp-slides' || act === 'exp-poster') {
        btn.closest('.pp-export-menu').hidden = true;
        const run = act === 'exp-pdf' ? B.exportProjectPdf : act === 'exp-slides' ? B.exportProjectSlides : B.exportProjectPoster;
        return run(id);
      }
      if (!btn) return;
      if (act === 'toggle-add-collab') {
        if (!isOwner) return toast('Only the Project Owner can edit collaborators', 'warn');
        if (statusOf(p) === 'archive') return toast('Archived project: collaborators can\'t be changed', 'warn');
        if (openCollabPickers.has(id)) {
          openCollabPickers.delete(id);
        } else {
          openCollabPickers.add(id);
        }
        render();
        if (openCollabPickers.has(id)) {
          const freshPicker = list.querySelector(`.pp-collab-picker[data-collab-picker="${id}"]`);
          if (freshPicker) {
            const inp = freshPicker.querySelector('.pp-collab-search-input');
            if (inp) { inp.value = ''; inp.focus(); }
          }
        }
        return;
      }
      if (act === 'cancel-add-collab') {
        openCollabPickers.delete(id);
        const picker = row.querySelector('.pp-collab-picker');
        if (picker) picker.hidden = true;
        return;
      }
      if (act === 'add-collab-user') {
        const email = btn.dataset.userEmail;
        const projId = btn.dataset.projId || id;
        const targetProj = c.projects.find((x) => x.id === projId);
        if (!targetProj || !email) return;
        if (!isUserProjectOwner(targetProj)) return toast('Only the Project Owner can edit collaborators', 'warn');
        if (statusOf(targetProj) === 'archive') return toast('Archived project: collaborators can\'t be changed', 'warn');

        targetProj.collaborators = targetProj.collaborators || [];
        const already = targetProj.collaborators.some((cb) => {
          const em = typeof cb === 'string' ? cb : (cb.email || cb.name || '');
          return em.toLowerCase() === email.toLowerCase();
        });
        if (already) {
          toast('Collaborator is already added', 'info');
          return;
        }

        const member = resolveMember(email);
        targetProj.collaborators.push({ email: member.email, name: member.name, role: member.role, addedAt: Date.now() });
        targetProj.updatedAt = Date.now();
        if (c._markProjectInProgress) c._markProjectInProgress(targetProj.id);
        c._saveProjects();
        toast(`Added ${member.name} (${member.role || 'Collaborator'})`, 'success');
        openCollabPickers.add(projId);
        render();
        const freshPicker = list.querySelector(`.pp-collab-picker[data-collab-picker="${projId}"]`);
        if (freshPicker) {
          const inp = freshPicker.querySelector('.pp-collab-search-input');
          if (inp) { inp.focus(); }
        }
        return;
      }
      if (act === 'del-collab') {
        if (!isOwner) return toast('Only the Project Owner can edit collaborators', 'warn');
        if (statusOf(p) === 'archive') return toast('Archived project: collaborators can\'t be changed', 'warn');
        const email = btn.dataset.email;
        if (p && email) {
          p.collaborators = (p.collaborators || []).filter((cb) => {
            const em = typeof cb === 'string' ? cb : (cb.email || cb.name || '');
            return em.toLowerCase() !== email.toLowerCase();
          });
          p.updatedAt = Date.now();
          c._saveProjects();
          toast('Removed collaborator', 'info');
          return render();
        }
        return;
      }
      if (act === 'docs') { openDocs.has(id) ? openDocs.delete(id) : openDocs.add(id); return render(); }
      if (act === 'attach') {
        if (p && statusOf(p) === 'archive') return toast('Archived project: documents can\'t be added', 'warn');
        attachTo = id; return picker.click();
      }
      if (act === 'open') open(id);
      else if (act === 'apply') { if (p) c._applyFromDrawer(p); }
      else if (act === 'dup') { c._duplicateProject(id); focusNewProject(c.activeProjectId); }
      else if (act === 'pdf') B.exportProjectPdf(id);
      else if (act === 'json') B.exportProjectJson(id);
      else if (act === 'del') {
        if (!isOwner) return toast('Only the Project Owner can delete this project', 'warn');
        const pName = p ? p.name : 'this project';
        ask('Delete Project?', '', () => { c._deleteProject(id); B.docs.removeProject(id).then(render); }, pName);
      }
    });

    list.addEventListener('input', (e) => {
      const searchInp = e.target.closest('.pp-collab-search-input');
      if (searchInp) {
        const q = searchInp.value.trim().toLowerCase();
        const picker = searchInp.closest('.pp-collab-picker');
        if (!picker) return;
        const items = picker.querySelectorAll('.pp-collab-user-item');
        let visibleCount = 0;
        items.forEach((item) => {
          const text = (item.dataset.searchText || '').toLowerCase();
          const match = !q || text.includes(q);
          item.hidden = !match;
          if (match) visibleCount++;
        });
        const emptyMsg = picker.querySelector('.pp-collab-no-results');
        if (emptyMsg) emptyMsg.hidden = visibleCount > 0;
      }
    });

    list.addEventListener('keydown', (e) => {
      const avatarChip = e.target.closest('.pp-member-avatar-chip');
      if (avatarChip && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        e.stopPropagation();
        const wasOpen = avatarChip.classList.contains('show-tooltip');
        document.querySelectorAll('.pp-member-avatar-chip.show-tooltip').forEach((c) => c.classList.remove('show-tooltip'));
        if (!wasOpen) avatarChip.classList.add('show-tooltip');
        return;
      }
      if (e.key === 'Escape') {
        const searchInp = e.target.closest('.pp-collab-search-input');
        if (searchInp) {
          const row = searchInp.closest('.pp-row');
          if (row && row.dataset.id) {
            openCollabPickers.delete(row.dataset.id);
            render();
          }
          return;
        }
      }
      if (e.key === 'Enter' || (e.key === ' ' && e.target.closest('.pp-collab-user-item.is-actionable'))) {
        const actionItem = e.target.closest('.pp-collab-user-item.is-actionable');
        if (actionItem && !e.target.closest('.pp-collab-search-input')) {
          e.preventDefault();
          actionItem.click();
          return;
        }
      }
      if (e.key === 'Enter') {
        const searchInp = e.target.closest('.pp-collab-search-input');
        if (searchInp) {
          e.preventDefault();
          const picker = searchInp.closest('.pp-collab-picker');
          const firstActionable = picker ? picker.querySelector('.pp-collab-user-item.is-actionable:not([hidden])') : null;
          if (firstActionable) {
            firstActionable.click();
          } else {
            const val = searchInp.value.trim().toLowerCase();
            if (val && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
              const row = searchInp.closest('.pp-row');
              const p = row ? c.projects.find((x) => x.id === row.dataset.id) : null;
              if (p && statusOf(p) !== 'archive') {
                p.collaborators = p.collaborators || [];
                const already = p.collaborators.some((cb) => {
                  const em = typeof cb === 'string' ? cb : (cb.email || cb.name || '');
                  return em.toLowerCase() === val;
                });
                if (already) {
                  toast('Collaborator is already added', 'info');
                  return;
                }
                const member = resolveMember(val);
                p.collaborators.push({ email: member.email || val, name: member.name || val, role: member.role || 'Collaborator', addedAt: Date.now() });
                p.updatedAt = Date.now();
                if (c._markProjectInProgress) c._markProjectInProgress(p.id);
                c._saveProjects();
                toast(`Added collaborator ${val}`, 'success');
                openCollabPickers.add(p.id);
                render();
              }
            }
          }
        }
      }
    });

    // Redirect to the Projects page on the "All" tab and highlight the newly created project card with a blue border
    const focusNewProject = async (id) => {
      view = 'projects';
      statusFilter = 'all';
      periodFilter = 'all';
      if (query) {
        query = '';
        if (search) search.value = '';
      }
      if (tl) {
        tl = null;
        if (tlFrom) tlFrom.value = '';
        if (tlTo) tlTo.value = '';
        if (tlSlider) tlSlider.disabled = true;
      }
      highlightedProjectId = id;
      if (highlightTimer) clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => {
        highlightedProjectId = null;
        const el = list.querySelector('.pp-row.is-newly-created');
        if (el) el.classList.remove('is-newly-created');
      }, 5000);
      switchMainView('projects');
      await render();
      const card = list.querySelector(`.pp-row[data-id="${CSS.escape(id)}"]`);
      if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    B.showNewProjectInAllTab = focusNewProject;

    // A new project shows up as a card here first; View Project opens its map to start editing
    document.getElementById('pp-new').addEventListener('click', async () => {
      c._createNewProject();
      await focusNewProject(c.activeProjectId);
    });
    if (back) back.addEventListener('click', () => switchMainView(mapReturnView || 'projects'));
    if (navHome) {
      navHome.addEventListener('click', () => {
        switchMainView('home');
        if (homePage) homePage.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
    if (navProjects) {
      navProjects.addEventListener('click', () => {
        switchMainView('projects');
        if (projectsPage) projectsPage.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
    if (navSettings) {
      navSettings.addEventListener('click', () => {
        switchMainView('settings');
        if (settingsPage) settingsPage.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
    if (navUsers) {
      navUsers.addEventListener('click', () => {
        switchMainView('users');
        if (usersPage) usersPage.scrollTo({ top: 0, behavior: 'smooth' });
        showUsersView('members');
      });
    }

    if (usersPage) {
      // Role changing
      usersPage.addEventListener('change', (e) => {
        const sel = e.target.closest('.users-role-select');
        if (!sel) return;
        const uid = sel.dataset.userId;
        const newRole = sel.value;
        const users = getAccessUsers();
        const user = users.find((x) => x.id === uid);
        if (user) {
          user.role = newRole;
          user.updatedAt = Date.now();
          saveAccessUsers(users);
          toast(`Updated ${user.name}'s role to ${newRole}`, 'success');
          renderUsersAccessControl();
        }
      });

      // Status toggling & Filter chips
      usersPage.addEventListener('change', (e) => {
        const toggle = e.target.closest('.user-toggle-input');
        if (toggle && toggle.classList.contains('role-perm-checkbox')) return; // handled by role form
        if (toggle) {
          const uid = toggle.dataset.userId;
          if (!uid || uid === 'admin') return;
          const users = getAccessUsers();
          const user = users.find((x) => x.id === uid);
          if (user) {
            user.status = toggle.checked ? 'active' : 'suspended';
            user.updatedAt = Date.now();
            saveAccessUsers(users);
            const statusLabel = (user.status === 'suspended') ? 'Suspended access for' : 'Restored active access for';
            toast(`${statusLabel} ${user.name}`, user.status === 'suspended' ? 'warn' : 'success');
            renderUsersAccessControl();
          }
          return;
        }
      });

      // Invite a user: the form opens in place above the list
      const inviteBtn = document.getElementById('btn-invite-user');
      const inviteForm = document.getElementById('users-invite-form');
      const inviteName = document.getElementById('users-invite-name');
      const inviteEmail = document.getElementById('users-invite-email');
      const inviteRole = document.getElementById('users-invite-role');
      const showInvite = (open) => {
        inviteForm.hidden = !open;
        inviteBtn.setAttribute('aria-expanded', String(open));
        if (!open) return;
        inviteRole.innerHTML = getSystemRoles().map((r) => `<option value="${esc(r.name)}"${r.name === 'Bus Ops' ? ' selected' : ''}>${esc(r.name)}</option>`).join('');
        inviteName.value = '';
        inviteEmail.value = '';
        inviteName.focus();
      };
      inviteBtn.addEventListener('click', () => showInvite(inviteForm.hidden));
      document.getElementById('users-invite-cancel').addEventListener('click', () => showInvite(false));
      inviteForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = inviteName.value.trim();
        const email = inviteEmail.value.trim().toLowerCase();
        if (!name) { inviteName.focus(); return toast('Enter a name', 'warn'); }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { inviteEmail.focus(); return toast('Enter a valid email', 'warn'); }
        const users = getAccessUsers();
        if (users.some((u) => String(u.email).toLowerCase() === email)) { inviteEmail.focus(); return toast('Email already added', 'warn'); }
        const user = { id: 'user-' + Date.now().toString(36), name, role: inviteRole.value, initials: initialsOf(name), email, status: 'invited', updatedAt: Date.now() };
        users.push(user);
        saveAccessUsers(users);
        usersRevealId = user.id;
        showInvite(false);
        toast(`Invited ${name}`, 'success');
        renderUsersAccessControl();
      });

      usersPage.addEventListener('click', (e) => {
        const sortBtn = e.target.closest('.users-sort');
        if (sortBtn) {
          const key = sortBtn.dataset.sort;
          if (sortBtn.closest('#users-view-roles')) {
            rolesSort = { key, dir: rolesSort.key === key ? -rolesSort.dir : 1 };
            rolesPageNum = 1;
            renderRoleSettings();
          } else {
            usersSort = { key, dir: usersSort.key === key ? -usersSort.dir : 1 };
            usersPageNum = 1;
            renderUsersAccessControl();
          }
          return;
        }

        const pageBtn = e.target.closest('.users-page-btn');
        if (pageBtn) {
          if (pageBtn.closest('#users-view-roles')) {
            rolesPageNum = Number(pageBtn.dataset.page);
            renderRoleSettings();
          } else {
            usersPageNum = Number(pageBtn.dataset.page);
            renderUsersAccessControl();
          }
          return;
        }

        // Tab switching (Users vs Role Settings)
        const tab = e.target.closest('.users-tab');
        if (tab) {
          const target = tab.dataset.tab;
          usersPage.querySelectorAll('.users-tab').forEach((t) => {
            const isMatch = t === tab;
            t.classList.toggle('active', isMatch);
            t.setAttribute('aria-selected', isMatch ? 'true' : 'false');
          });
          showUsersView(target);
          return;
        }

        // Open Role Settings button from toolbar
        const btnOpenRole = e.target.closest('#btn-open-role-settings');
        if (btnOpenRole) {
          showUsersView('roles');
          return;
        }

        // Create Role button
        const btnCreateRole = e.target.closest('#btn-create-role');
        if (btnCreateRole) {
          openRoleModal(null);
          return;
        }

        // Edit Role button
        const btnEditRole = e.target.closest('[data-act="edit-role"]');
        if (btnEditRole) {
          const rid = btnEditRole.dataset.roleId;
          const roles = getSystemRoles();
          const role = roles.find((r) => r.id === rid);
          if (role) openRoleModal(role);
          return;
        }

        // Delete Role button
        const btnDelRole = e.target.closest('[data-act="delete-role"]');
        if (btnDelRole) {
          confirmDeleteRole(btnDelRole.dataset.roleId);
          return;
        }

        const btn = e.target.closest('.users-btn-toggle-access');
        if (btn) {
          const uid = btn.dataset.userId;
          const users = getAccessUsers();
          const user = users.find((x) => x.id === uid);
          if (user) {
            user.status = (user.status === 'suspended') ? 'active' : 'suspended';
            user.updatedAt = Date.now();
            saveAccessUsers(users);
            const statusLabel = (user.status === 'suspended') ? 'Suspended access for' : 'Restored active access for';
            toast(`${statusLabel} ${user.name}`, user.status === 'suspended' ? 'warn' : 'success');
            renderUsersAccessControl();
          }
          return;
        }

        const chip = e.target.closest('.users-filter-chip');
        if (chip) {
          usersRoleFilter = new Set([chip.dataset.filter || 'all']);
          usersPage.querySelectorAll('.users-filter-chip').forEach((c) => c.classList.toggle('active', c === chip));
          renderUsersAccessControl();
        }
      });

      // Search inputs: filter as you type, Escape clears
      const wireSearch = (id, apply) => {
        const inp = document.getElementById(id);
        if (!inp) return;
        inp.addEventListener('input', () => apply(inp.value));
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            inp.value = '';
            apply('');
          }
        });
      };
      wireSearch('users-search-input', (value) => {
        usersSearchQuery = value;
        usersPageNum = 1;
        renderUsersAccessControl();
      });
      wireSearch('roles-search-input', (value) => {
        rolesSearchQuery = value;
        rolesPageNum = 1;
        renderRoleSettings();
      });
    }

    // Role Modal Form and Actions
    const roleModal = document.getElementById('role-modal');
    const roleForm = document.getElementById('role-modal-form');
    const roleModalCloseX = document.getElementById('btn-close-role-modal-x');
    const roleModalCancel = document.getElementById('btn-role-modal-cancel');

    if (roleModalCloseX) roleModalCloseX.addEventListener('click', closeRoleModal);
    if (roleModalCancel) roleModalCancel.addEventListener('click', closeRoleModal);
    if (roleModal) {
      roleModal.addEventListener('click', (e) => {
        if (e.target === roleModal) closeRoleModal();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !roleModal.classList.contains('hidden')) {
          closeRoleModal();
        }
      });
    }

    if (roleForm) {
      const roleModalDelete = document.getElementById('btn-role-modal-delete');
      if (roleModalDelete) {
        roleModalDelete.addEventListener('click', () => confirmDeleteRole(document.getElementById('role-input-id').value));
      }

      roleForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const idInp = document.getElementById('role-input-id');
        const nameInp = document.getElementById('role-input-name');
        const descInp = document.getElementById('role-input-desc');
        const rid = (idInp ? idInp.value : '').trim();
        const name = (nameInp ? nameInp.value : '').trim();
        const desc = (descInp ? descInp.value : '').trim();
        if (!name) return;

        const roles = getSystemRoles();
        const perms = {};
        document.querySelectorAll('.role-perm-checkbox').forEach((cb) => {
          const fid = cb.dataset.feature;
          if (fid) perms[fid] = cb.checked;
        });

        if (rid) {
          // Editing existing role
          const role = roles.find((r) => r.id === rid);
          if (role) {
            const oldName = role.name;
            role.name = name;
            role.desc = desc;
            role.perms = perms;
            if (oldName !== name) {
              const users = getAccessUsers();
              users.forEach((u) => {
                if (u.role === oldName) { u.role = name; u.updatedAt = Date.now(); }
              });
              saveAccessUsers(users);
            }
            saveSystemRoles(roles);
            toast(`Updated role "${name}"`, 'success');
          }
        } else {
          // Check for duplicate name
          if (roles.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
            toast(`Role name "${name}" already exists`, 'error');
            return;
          }
          const newRole = {
            id: 'role-' + Date.now().toString(36),
            name,
            desc,
            isSystem: false,
            perms
          };
          roles.push(newRole);
          saveSystemRoles(roles);
          rolesRevealId = newRole.id;
          rolesSearchQuery = '';
          const rolesSearch = document.getElementById('roles-search-input');
          if (rolesSearch) rolesSearch.value = '';
          toast(`Created new role "${name}"`, 'success');
        }

        closeRoleModal();
        renderRoleSettings();
        renderUsersAccessControl();
      });
    }

    // Quick action portal buttons on Home page
    const homeNewProjBtn = document.getElementById('home-quick-new-proj');
    if (homeNewProjBtn) {
      homeNewProjBtn.addEventListener('click', async () => {
        c._createNewProject();
        await focusNewProject(c.activeProjectId);
      });
    }
    const homeOpenProjBtn = document.getElementById('home-quick-open-proj');
    if (homeOpenProjBtn) {
      homeOpenProjBtn.addEventListener('click', () => switchMainView('projects'));
    }
    const homePortalProjects = document.getElementById('home-portal-projects');
    if (homePortalProjects) {
      homePortalProjects.addEventListener('click', () => switchMainView('projects'));
    }
    const homePortalMap = document.getElementById('home-portal-map');
    if (homePortalMap) {
      homePortalMap.addEventListener('click', () => {
        const targetId = c.activeProjectId || (c.projects && c.projects[0] ? c.projects[0].id : 'main');
        open(targetId);
      });
    }
    const homePortalAi = document.getElementById('home-portal-ai');
    if (homePortalAi) {
      homePortalAi.addEventListener('click', () => {
        if (window.toggleBrassAi) window.toggleBrassAi(true);
      });
    }
    const toggleSidebarBtn = document.getElementById('btn-toggle-global-sidebar');
    if (toggleSidebarBtn) {
      toggleSidebarBtn.addEventListener('click', () => {
        root.classList.toggle('sidebar-collapsed');
        window.dispatchEvent(new Event('resize'));
      });
    }

    // Header: save and export for the project on the canvas
    const exp = document.getElementById('btn-header-export');
    if (exp) exp.addEventListener('click', () => B.exportProjectPdf(c.activeProjectId));
    // Export in the map header: the same list as on the project card, for the project on the map
    const hx = document.getElementById('header-export');
    if (hx) {
      const btn = hx.querySelector('[data-act=export]'), menu = hx.querySelector('.pp-export-menu');
      const setOpen = (open) => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
      btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(menu.hidden); });
      menu.addEventListener('click', (e) => {
        const b = e.target.closest('[data-exp]');
        if (!b) return;
        setOpen(false);
        ({ link: (id) => c._shareProject(id), pdf: B.exportProjectPdf, slides: B.exportProjectSlides, poster: B.exportProjectPoster })[b.dataset.exp](c.activeProjectId);
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) setOpen(false); });
      document.addEventListener('click', (e) => { if (!hx.contains(e.target)) setOpen(false); });
    }

    // Shown after login; login.js sends this when the user signs in
    window.addEventListener('brass-login', () => {
      show();
      showOpeningUpcomingToast();
    });
    window.addEventListener('brass-logout', () => {
      hasShownOpeningUpcomingToast = false;
    });
    window.addEventListener('brass-role-change', () => {
      render();
      syncHomeRole();
    });
    if (root.classList.contains('authed') && !c.reviewMode && !/^#(review|share|draw)=/.test(location.hash)) {
      switchMainView('home');
      showOpeningUpcomingToast();
    }
  };
})();
