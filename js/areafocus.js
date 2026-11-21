/* BRASS — Project-scoped Affected Area focus pill (drawn areas + standalone closed roads + connected road clusters),
 * mini "Auto change" / "Applied Route Changes" button, and AI Pill place aliases */
(function () {
  const B = window.B;
  if (!B || !B.Controller || !B.Controller.prototype) return;

  const CHECK_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

  // Build this selected project's affected areas:
  // 1) Each drawn/uploaded affected area added or modified in this project = 1 affected area
  // 2) Any closed road(s) added in this project that aren't inside/touching a drawn area are clustered by connectivity/proximity:
  //    - A standalone closed road = 1 affected area
  //    - A connected cluster of related closed roads = 1 affected area
  const projectAffectedGroups = (ctrl) => {
    const doc = ctrl && ctrl.store && ctrl.store.doc;
    if (!doc) return [];
    const pid = ctrl.reviewMode ? 'review' : ctrl.activeProjectId;
    const isMain = !pid || pid === 'main';
    const base = isMain
      ? null
      : (ctrl.reviewMode ? ctrl.reviewBaseDoc : (typeof ctrl._projectBase === 'function' ? ctrl._projectBase(pid) : null));
    const baseAreas = (base && base.areas) || {};
    const baseClosures = (base && base.closures) || {};

    const groups = [];

    // 1. Drawn/uploaded affected areas owned by this project
    const docAreas = doc.areas || {};
    for (const [aid, a] of Object.entries(docAreas)) {
      if (!isMain && (aid in baseAreas) && JSON.stringify(baseAreas[aid]) === JSON.stringify(a)) continue;
      const poly = ctrl.store.areaPoly(a) || [];
      const edgeIds = new Set((ctrl.store.areaEdges && ctrl.store.areaEdges[aid]) || []);
      const nodeSet = new Set();
      for (const eid of edgeIds) {
        const e = ctrl.net && ctrl.net.edge(eid);
        if (e) { nodeSet.add(e.a); nodeSet.add(e.b); }
      }
      groups.push({
        id: 'area:' + aid,
        kind: 'area',
        areaId: aid,
        area: a,
        name: a.name || `Affected Area ${aid}`,
        edgeIds,
        nodeSet,
        poly,
        pts: poly.slice(),
      });
    }

    // 2. Closed road edges added in this project
    const docClosures = doc.closures || {};
    const ownClosedEdges = [];
    for (const eidStr of Object.keys(docClosures)) {
      if (!isMain && (eidStr in baseClosures)) continue;
      const eid = Number(eidStr);
      const e = ctrl.net && ctrl.net.edge(eid);
      if (e) ownClosedEdges.push(e);
    }

    // Absorb closed edges that lie inside or directly connect to one of this project's drawn areas
    const standaloneOrClusterEdges = [];
    for (const e of ownClosedEdges) {
      let absorbedBy = null;
      for (const g of groups) {
        if (g.kind !== 'area') continue;
        const inPoly = g.poly.length >= 3 && e.pts && e.pts.some((pt) => B.pointInPoly(pt, g.poly));
        const touchesNode = g.nodeSet.has(e.a) || g.nodeSet.has(e.b);
        if (g.edgeIds.has(e.id) || inPoly || touchesNode) {
          absorbedBy = g;
          break;
        }
      }
      if (absorbedBy) {
        absorbedBy.edgeIds.add(e.id);
        absorbedBy.nodeSet.add(e.a);
        absorbedBy.nodeSet.add(e.b);
        if (e.pts) absorbedBy.pts.push(...e.pts);
      } else {
        standaloneOrClusterEdges.push(e);
      }
    }

    // 3. Group remaining closed roads into connected clusters (shared junction node OR endpoints within 120m)
    const n = standaloneOrClusterEdges.length;
    if (n > 0) {
      const visited = new Uint8Array(n);
      const edgesRelated = (e1, e2) => {
        if (e1.a === e2.a || e1.a === e2.b || e1.b === e2.a || e1.b === e2.b) return true;
        const p1a = e1.pts && e1.pts[0], p1b = e1.pts && e1.pts[e1.pts.length - 1];
        const p2a = e2.pts && e2.pts[0], p2b = e2.pts && e2.pts[e2.pts.length - 1];
        if (!p1a || !p1b || !p2a || !p2b) return false;
        const dMin = Math.min(
          Math.hypot(p1a.x - p2a.x, p1a.y - p2a.y),
          Math.hypot(p1a.x - p2b.x, p1a.y - p2b.y),
          Math.hypot(p1b.x - p2a.x, p1b.y - p2a.y),
          Math.hypot(p1b.x - p2b.x, p1b.y - p2b.y)
        );
        return dMin <= 120;
      };

      for (let i = 0; i < n; i++) {
        if (visited[i]) continue;
        const comp = [];
        const queue = [i];
        visited[i] = 1;
        while (queue.length) {
          const cur = queue.shift();
          comp.push(standaloneOrClusterEdges[cur]);
          for (let j = 0; j < n; j++) {
            if (!visited[j] && edgesRelated(standaloneOrClusterEdges[cur], standaloneOrClusterEdges[j])) {
              visited[j] = 1;
              queue.push(j);
            }
          }
        }

        const sortedIds = comp.map((e) => e.id).sort((a, b) => a - b);
        const roadNames = [...new Set(comp.map((e) => e.name).filter(Boolean))];
        let label;
        if (roadNames.length === 1) label = roadNames[0];
        else if (roadNames.length === 2) label = `${roadNames[0]} & ${roadNames[1]}`;
        else if (roadNames.length > 2) label = `${roadNames[0]} (+${roadNames.length - 1} roads)`;
        else label = `Road Closure #${sortedIds[0]}`;

        const pts = [];
        const edgeIds = new Set();
        for (const e of comp) {
          edgeIds.add(e.id);
          if (e.pts) pts.push(...e.pts);
        }

        groups.push({
          id: 'cluster:' + sortedIds[0],
          kind: 'cluster',
          primaryEdgeId: sortedIds[0],
          name: label,
          edgeIds,
          pts,
        });
      }
    }

    return groups;
  };

  // Compute edges of interior junctions for a set of blocked edges (nodes where >= 2 edges in the group meet)
  const groupBlockedEdges = (ctrl, group) => {
    const blocked = new Set(group.edgeIds || []);
    const nodeCounts = new Map();
    for (const eid of blocked) {
      const e = ctrl.net && ctrl.net.edge(eid);
      if (!e) continue;
      nodeCounts.set(e.a, (nodeCounts.get(e.a) || 0) + 1);
      nodeCounts.set(e.b, (nodeCounts.get(e.b) || 0) + 1);
    }
    for (const [nid, cnt] of nodeCounts.entries()) {
      if (cnt >= 2) {
        const nd = ctrl.city && ctrl.city.nodes && ctrl.city.nodes[nid];
        if (nd && nd.edges) nd.edges.forEach((eid) => blocked.add(eid));
      }
    }
    return blocked;
  };

  const groupCrossingRoutes = (ctrl, group) => {
    if (!ctrl || !ctrl.store || !ctrl.store.doc || !group) return [];
    const routes = Object.values(ctrl.store.doc.routes || {});
    const blockedEdges = groupBlockedEdges(ctrl, group);
    return routes.filter((r) => {
      if (r.isChunk || r.active === false) return false;
      if (group.kind === 'area' && ctrl._routeThroughArea(r, group.area)) return true;
      if (blockedEdges.size && ctrl._routeUsesEdges(r, blockedEdges)) return true;
      return false;
    });
  };

  const applyAutoChangeForGroup = (ctrl, groupId) => {
    if (!ctrl || !ctrl.store || !ctrl.store.doc) return;
    if (ctrl._isCurrentMapReadOnly && ctrl._isCurrentMapReadOnly()) return;
    const group = projectAffectedGroups(ctrl).find((g) => g.id === groupId);
    if (!group) return;

    const crossing = groupCrossingRoutes(ctrl, group);
    if (!crossing.length) {
      if (ctrl._showToast) ctrl._showToast(`All routes already avoid ${B.esc(group.name)}`, 'info');
      syncProjectAreaFocusUI(ctrl);
      return;
    }

    const plans = [];
    for (const r of crossing) {
      let opts = (typeof ctrl._rankedDetourOptions === 'function' ? ctrl._rankedDetourOptions(r.id) : null) || [];
      if (!opts.length && ctrl.store.generateDetourOptions) {
        opts = ctrl.store.generateDetourOptions(r.id) || [];
      }
      const chosen = opts.find((o) => o && o.anchors && o.anchors.length >= 2 && (!o.geom || !(o.geom.conflicts && o.geom.conflicts.length))) || opts[0];
      if (chosen && chosen.anchors && chosen.anchors.length >= 2) {
        plans.push({ rid: r.id, opt: chosen });
      }
    }

    if (!plans.length) {
      if (ctrl._showToast) ctrl._showToast(`No valid bypass route found around ${B.esc(group.name)}`, 'warn');
      return;
    }

    ctrl.store.commit(`Auto-detour around ${group.name}`, (doc) => {
      for (const { rid, opt } of plans) {
        const route = doc.routes[rid];
        if (!route) continue;
        if (!route.originalAnchors) {
          route.originalAnchors = JSON.parse(JSON.stringify(route.anchors));
        }
        route.anchors = JSON.parse(JSON.stringify(opt.anchors));
        route.activeOptionIdx = 0;
        route.viaName = opt.viaName || opt.title || 'AI Bypass';
        route.detourApplied = true;
        route.detourTitle = opt.title || `Detour via ${route.viaName}`;
        route.fromAiSuggest = true;
        const firstStop = doc.stops[route.anchors[0]?.id];
        const lastStop = doc.stops[route.anchors[route.anchors.length - 1]?.id];
        if (firstStop && lastStop) {
          route.name = `Bus ${route.number} (${firstStop.name} ➔ ${lastStop.name})`;
        }
      }
    });

    if (ctrl.store.save) ctrl.store.save();
    if (ctrl._saveCurrentProjectDraft) ctrl._saveCurrentProjectDraft(false);
    if (ctrl._updateUIState) ctrl._updateUIState();
    if (ctrl._renderQuickFilters) ctrl._renderQuickFilters(true);
    if (ctrl.renderer && ctrl.renderer.requestRender) ctrl.renderer.requestRender();
    if (ctrl._showToast) {
      ctrl._showToast(`Applied auto change for ${plans.length} bus route${plans.length === 1 ? '' : 's'} around ${B.esc(group.name)}`, 'success');
    }
  };

  const setFocusedGroupsOnRenderer = (ctrl, groupsToShow) => {
    if (!ctrl || !ctrl.renderer) return;
    if (!groupsToShow || !groupsToShow.length) {
      ctrl.renderer.focusedProjectAreaIds = null;
      ctrl.renderer.focusedProjectClosureEdges = null;
    } else {
      const areaIds = new Set();
      const closureEdges = new Set();
      for (const g of groupsToShow) {
        if (g.kind === 'area' && g.areaId) areaIds.add(g.areaId);
        if (g.edgeIds) for (const eid of g.edgeIds) closureEdges.add(eid);
      }
      // Use empty Set (truthy!) when focusing on road-only cluster so unrelated drawn areas stay hidden
      ctrl.renderer.focusedProjectAreaIds = areaIds;
      ctrl.renderer.focusedProjectClosureEdges = closureEdges;
    }
    ctrl.renderer.requestRender();
  };

  const focusSingleGroup = (ctrl, group) => {
    if (!ctrl || !group) return;
    if (group.pts && group.pts.length && ctrl._fitClearOfPanels) {
      ctrl._fitClearOfPanels(B.bbox(group.pts, 450));
    }
    ctrl.focusedAreaId = group.id;
    if (group.kind === 'area') {
      ctrl.renderer.selected = { type: 'area', id: group.areaId, obj: group.area };
      if (ctrl._showInspector) ctrl._showInspector(ctrl.renderer.selected);
    } else if (group.primaryEdgeId != null) {
      ctrl.renderer.selected = { type: 'closure', id: group.primaryEdgeId };
      if (ctrl._showInspector) ctrl._showInspector(ctrl.renderer.selected);
    }
    setFocusedGroupsOnRenderer(ctrl, [group]);
  };

  const clearAreaFocus = (ctrl) => {
    ctrl.focusedAreaId = null;
    if (ctrl.renderer && ctrl.renderer.selected && (ctrl.renderer.selected.type === 'area' || ctrl.renderer.selected.type === 'closure')) {
      ctrl.renderer.selected = null;
      if (ctrl._hideInspector) ctrl._hideInspector();
    }
    setFocusedGroupsOnRenderer(ctrl, null);
  };

  let syncing = false;
  const syncProjectAreaFocusUI = (ctrl) => {
    if (syncing || !ctrl) return;
    const row = document.getElementById('quick-filter-row');
    const box = document.getElementById('affected-areas-focus-list');
    if (!row) return;

    syncing = true;
    try {
      // Remove the View project scope pill
      row.querySelectorAll('.quick-filter-chip[data-key="scope"]').forEach((el) => el.remove());

      const groups = projectAffectedGroups(ctrl);
      const groupIdSet = new Set(groups.map((g) => g.id));

      if (!groups.length) {
        ctrl.affectedAreaPanelOpen = false;
        ctrl.focusedAreaId = null;
        setFocusedGroupsOnRenderer(ctrl, null);
      } else if (ctrl.focusedAreaId && !groupIdSet.has(ctrl.focusedAreaId)) {
        ctrl.focusedAreaId = null;
      }

      const existingChip = row.querySelector('.quick-filter-chip[data-key="affected_areas"]');
      if (!groups.length) {
        if (existingChip) existingChip.remove();
        if (box) {
          box.hidden = true;
          box.innerHTML = '';
        }
        return;
      }

      const pillActive = Boolean(ctrl.affectedAreaPanelOpen);

      const addChip = row.querySelector('.quick-filter-chip[data-key="create_ai_pill"]');
      const chipBtn = document.createElement('button');
      chipBtn.type = 'button';
      chipBtn.className = `quick-filter-chip affected-area-chip${pillActive ? ' active' : ''}`;
      chipBtn.dataset.key = 'affected_areas';
      chipBtn.setAttribute('aria-pressed', String(pillActive));
      chipBtn.title = groups.length === 1
        ? `Focus on ${groups[0].name} in this project`
        : `Find and focus on the ${groups.length} affected areas in this project`;
      chipBtn.innerHTML = `
        <span>Affected area</span>
        <span class="quick-filter-count">${groups.length}</span>
        <svg class="affected-area-chip-chev${pillActive ? ' open' : ''}" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      `;
      chipBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const latest = projectAffectedGroups(ctrl);
        if (!latest.length) return;
        ctrl.affectedAreaPanelOpen = !ctrl.affectedAreaPanelOpen;
        if (ctrl.affectedAreaPanelOpen) {
          if (latest.length === 1) {
            focusSingleGroup(ctrl, latest[0]);
          } else {
            ctrl.focusedAreaId = null;
            setFocusedGroupsOnRenderer(ctrl, latest);
            const pts = [];
            for (const g of latest) {
              if (g.pts && g.pts.length) pts.push(...g.pts);
            }
            if (pts.length && ctrl._fitClearOfPanels) ctrl._fitClearOfPanels(B.bbox(pts, 450));
          }
        } else {
          clearAreaFocus(ctrl);
        }
        syncProjectAreaFocusUI(ctrl);
      });

      if (existingChip) existingChip.replaceWith(chipBtn);
      else if (addChip) row.insertBefore(chipBtn, addChip);
      else row.appendChild(chipBtn);

      // Render expandable list strictly for this project's affected areas & road clusters (including when there is 1)
      if (!box) return;
      if (!(groups.length >= 1 && ctrl.affectedAreaPanelOpen)) {
        box.hidden = true;
        box.innerHTML = '';
        return;
      }

      box.hidden = false;
      box.innerHTML = `
        <div class="affected-areas-list-head">${groups.length === 1 ? 'Affected area (1)' : `Affected areas (${groups.length})`}</div>
        <div class="affected-areas-list-items"></div>
      `;
      const itemsWrap = box.querySelector('.affected-areas-list-items');
      groups.forEach((group) => {
        const gid = group.id;
        const label = group.name;
        const isFocused = ctrl.focusedAreaId === gid;
        const rowBtn = document.createElement('button');
        rowBtn.type = 'button';
        rowBtn.className = `affected-area-list-item${isFocused ? ' active' : ''}`;
        rowBtn.dataset.areaId = gid;
        rowBtn.title = `Focus on ${label}`;
        rowBtn.innerHTML = `
          <span class="affected-area-list-dot" aria-hidden="true"></span>
          <span class="affected-area-list-name">${B.esc(label)}</span>
        `;

        const crossing = groupCrossingRoutes(ctrl, group);
        let actionEl;
        if (crossing.length > 0) {
          actionEl = document.createElement('span');
          actionEl.className = 'affected-area-auto-btn';
          actionEl.setAttribute('role', 'button');
          actionEl.setAttribute('tabindex', '0');
          actionEl.dataset.autoArea = gid;
          actionEl.title = `Auto-detour ${crossing.length} bus route${crossing.length === 1 ? '' : 's'} to avoid ${label}`;
          actionEl.innerHTML = `${B.AI_ICON || ''}<span>Auto change</span>`;
          const trigger = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            applyAutoChangeForGroup(ctrl, gid);
          };
          actionEl.addEventListener('click', trigger);
          actionEl.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') trigger(ev);
          });
        } else {
          actionEl = document.createElement('span');
          actionEl.className = 'affected-area-applied-badge';
          actionEl.title = `All bus routes avoid ${label}`;
          actionEl.innerHTML = `${CHECK_ICON}<span>Applied Route Changes</span>`;
          actionEl.addEventListener('click', (ev) => ev.stopPropagation());
        }
        rowBtn.appendChild(actionEl);

        rowBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (ctrl.focusedAreaId === gid) {
            ctrl.focusedAreaId = null;
            if (ctrl.renderer && ctrl.renderer.selected && (ctrl.renderer.selected.type === 'area' || ctrl.renderer.selected.type === 'closure')) {
              ctrl.renderer.selected = null;
              if (ctrl._hideInspector) ctrl._hideInspector();
            }
            setFocusedGroupsOnRenderer(ctrl, groups);
          } else {
            focusSingleGroup(ctrl, group);
          }
          syncProjectAreaFocusUI(ctrl);
        });

        itemsWrap.appendChild(rowBtn);
      });
    } finally {
      syncing = false;
    }
  };

  const origRenderQF = B.Controller.prototype._renderQuickFilters;
  if (typeof origRenderQF === 'function') {
    B.Controller.prototype._renderQuickFilters = function () {
      const res = origRenderQF.apply(this, arguments);
      syncProjectAreaFocusUI(this);
      return res;
    };
  }

  const origSwitch = B.Controller.prototype._switchProject;
  if (typeof origSwitch === 'function') {
    B.Controller.prototype._switchProject = function () {
      this.affectedAreaPanelOpen = false;
      this.focusedAreaId = null;
      if (this.renderer) {
        this.renderer.focusedProjectAreaIds = null;
        this.renderer.focusedProjectClosureEdges = null;
      }
      return origSwitch.apply(this, arguments);
    };
  }

  // Expose helper for testing/diagnostics
  B.projectAffectedGroups = projectAffectedGroups;

  // Automatically turn on the Bus Stop Point layer (and sync its View Settings checkbox)
  // whenever the user starts connecting stops, cutting a route to reconnect, or picking the stop/route tool
  const ensureBusStopsLayerVisible = (ctrl) => {
    if (!ctrl || !ctrl.renderer || !ctrl.renderer.layers) return;
    const L = ctrl.renderer.layers;
    let changed = false;
    if (L.stopPoints === false) { L.stopPoints = true; changed = true; }
    if (L.stops === false) { L.stops = true; changed = true; }
    if (L.busInterchanges === false) { L.busInterchanges = true; changed = true; }
    if (changed) {
      const chkPts = document.getElementById('layer-stop-points');
      if (chkPts) chkPts.checked = true;
      const chkStops = document.getElementById('layer-stops');
      if (chkStops) chkStops.checked = true;
      const chkInt = document.getElementById('layer-interchanges');
      if (chkInt) chkInt.checked = true;
      ctrl.renderer.requestRender();
    }
  };

  const origStartConnect = B.Controller.prototype._startConnectingFrom;
  if (typeof origStartConnect === 'function') {
    B.Controller.prototype._startConnectingFrom = function () {
      ensureBusStopsLayerVisible(this);
      return origStartConnect.apply(this, arguments);
    };
  }

  const origCutRoute = B.Controller.prototype._cutRouteIntoChunks;
  if (typeof origCutRoute === 'function') {
    B.Controller.prototype._cutRouteIntoChunks = function () {
      ensureBusStopsLayerVisible(this);
      return origCutRoute.apply(this, arguments);
    };
  }

  const origSetTool = B.Controller.prototype.setTool;
  if (typeof origSetTool === 'function') {
    B.Controller.prototype.setTool = function (tool) {
      if (tool === 'route' || tool === 'stop') {
        ensureBusStopsLayerVisible(this);
      }
      return origSetTool.apply(this, arguments);
    };
  }

  const origPromptNewBus = B.Controller.prototype._promptNewBus;
  if (typeof origPromptNewBus === 'function') {
    B.Controller.prototype._promptNewBus = function () {
      ensureBusStopsLayerVisible(this);
      return origPromptNewBus.apply(this, arguments);
    };
  }

  // Clearer guidance toast when a new bus number is created
  const origShowToast = B.Controller.prototype._showToast;
  if (typeof origShowToast === 'function') {
    B.Controller.prototype._showToast = function (msg, type = 'info') {
      if (typeof msg === 'string' && /^Bus\s+.+?\s+added\.\s+Click a Bus Interchange to start its route$/i.test(msg)) {
        const m = msg.match(/^Bus\s+(.+?)\s+added\./i);
        const num = m ? m[1] : '';
        ensureBusStopsLayerVisible(this);
        msg = `Bus ${num} created. Click bus stops to connect the bus route together (start from a Bus Interchange).`;
      }
      return origShowToast.call(this, msg, type);
    };
  }

  // Friendly Singapore neighborhood aliases so prompts like "Little India" match local corridors
  const PLACE_ALIASES = [
    [/\blittle\s+india\b/gi, 'Serangoon Road or Kallang or Bugis'],
    [/\bchinatown\b/gi, 'Downtown Core or Tanjong Pagar'],
    [/\bkampong\s+glam\b/gi, 'Bugis or Kallang'],
    [/\bmarina\s+bay\b/gi, 'Downtown Core'],
    [/\bholland\s+village\b/gi, 'Queenstown or Bukit Timah'],
    [/\bfarrer\s+park\b/gi, 'Novena or Kallang'],
  ];
  const origEvalPrompt = B.Controller.prototype._evaluateAiPillPrompt;
  if (typeof origEvalPrompt === 'function') {
    B.Controller.prototype._evaluateAiPillPrompt = function (prompt) {
      let expanded = String(prompt || '');
      for (const [re, rep] of PLACE_ALIASES) {
        expanded = expanded.replace(re, rep);
      }
      return origEvalPrompt.call(this, expanded);
    };
  }

  // Re-rank detour recommendations using the user's selected/typed criteria
  const origRankedDetour = B.Controller.prototype._rankedDetourOptions;
  if (typeof origRankedDetour === 'function') {
    B.Controller.prototype._rankedDetourOptions = function (routeId) {
      const options = origRankedDetour.apply(this, arguments);
      if (!options || options.length < 2) return options;
      const crit = this.recommendationCriteria || (this.store && this.store.doc && this.store.doc.recommendationCriteria);
      const selected = Array.isArray(crit && crit.selected) ? crit.selected : [];
      const text = String((crit && crit.text) || '').trim();
      if (!selected.length && !text) return options;

      const sig = JSON.stringify({ selected, text });
      if (options._criteriaSig === sig) return options;

      const active = new Set(selected);
      const t = text.toLowerCase();
      if (/\b(time|fast|fastest|quick|quicker|speed|duration|min|minute)\b/.test(t)) active.add('time');
      if (/\b(cost|cheap|cheapest|budget|fuel|operating|expense|money)\b/.test(t)) active.add('cost');
      if (/\b(dist|distance|short|shortest|length|km|kilometre|kilometer|near|direct)\b/.test(t)) active.add('distance');
      if (/\b(stop|stops|skip|skipped|serve|served|coverage|mrt|station)\b/.test(t)) active.add('stops');
      if (/\b(commuter|commuters|passenger|passengers|rider|riders|crowd|people|impact)\b/.test(t)) active.add('commuters');
      if (/\b(interchange|interchanges|terminal|terminals|hub|hubs)\b/.test(t)) active.add('interchange');

      if (!active.size) {
        options._criteriaSig = sig;
        return options;
      }

      const scaled = (key) => {
        const vals = options.map((o) => Number(o[key]) || 0);
        const lo = Math.min(...vals), hi = Math.max(...vals);
        return (o) => (hi > lo ? ((Number(o[key]) || 0) - lo) / (hi - lo) : 0);
      };
      const time = scaled('time');
      const dist = scaled('length');
      const skips = scaled('stopsSkipped');
      const riders = scaled('commutersAffected');
      const costs = scaled('cost');

      const w = {
        time: active.has('time') ? 1.0 : 0.12,
        cost: active.has('cost') ? 1.0 : 0.12,
        distance: active.has('distance') ? 1.0 : 0.08,
        stops: active.has('stops') ? 1.0 : 0.08,
        commuters: active.has('commuters') ? 1.0 : 0.08,
      };
      const total = w.time + w.cost + w.distance + w.stops + w.commuters;
      const interchangeBonus = active.has('interchange') ? 0.35 : 0.08;

      for (const o of options) {
        o.score = (
          w.time * time(o) +
          w.cost * costs(o) +
          w.distance * dist(o) +
          w.stops * skips(o) +
          w.commuters * riders(o)
        ) / total;
        if (o.isInterchangeOption) o.score -= interchangeBonus;
      }

      options.sort((a, b) => a.score - b.score);
      options.forEach((o, i) => {
        o.index = i;
        o.isRecommended = i === 0;
      });
      options._criteriaSig = sig;
      return options;
    };
  }

  // ---------------------------------------------------------------------------
  // Overlapping-period route sync:
  // Projects with overlapping effective periods share the latest bus route changes
  // (e.g. detours around combined road closures / affected areas) while keeping
  // each project's own road closures & affected areas separate (shown in grey as
  // foreign obstacles).
  // ---------------------------------------------------------------------------
  const lastRouteSnapByProj = new Map();
  let syncingOverlapRoutes = false;

  const canonicalRouteSig = (r) => {
    if (!r) return '';
    const copy = Object.assign({}, r);
    delete copy._routeUpdatedAt;
    delete copy._routeUpdatedBy;
    return JSON.stringify(copy);
  };

  const captureRouteSnap = (doc) => {
    const map = new Map();
    const routes = (doc && doc.routes) || {};
    for (const [rid, r] of Object.entries(routes)) {
      map.set(rid, canonicalRouteSig(r));
    }
    return map;
  };

  const overlappingPeersOf = (ctrl, proj) => {
    if (!ctrl || !proj || !proj.id || proj.id === 'main' || proj.status === 'archive') return [];
    if (typeof ctrl._periodsOverlap !== 'function') return [];
    return (ctrl.projects || []).filter((other) => (
      other &&
      other.id &&
      other.id !== proj.id &&
      other.status !== 'archive' &&
      ctrl._periodsOverlap(proj, other)
    ));
  };

  const copyReferencedStops = (srcStops, dstStops, route) => {
    if (!srcStops || !dstStops || !route) return;
    const lists = [route.anchors, route.originalAnchors];
    for (const anchors of lists) {
      if (!Array.isArray(anchors)) continue;
      for (const a of anchors) {
        if (a && a.t === 'stop' && a.id && !dstStops[a.id] && srcStops[a.id]) {
          dstStops[a.id] = JSON.parse(JSON.stringify(srcStops[a.id]));
        }
      }
    }
  };

  const findTargetRouteKey = (dstRoutes, srcId, srcRoute) => {
    if (srcId in dstRoutes) return srcId;
    if (srcRoute && srcRoute.number != null) {
      const normNum = String(srcRoute.number).trim().toUpperCase();
      for (const [k, r] of Object.entries(dstRoutes)) {
        if (r && String(r.number || '').trim().toUpperCase() === normNum && r.kind === srcRoute.kind && Boolean(r.isChunk) === Boolean(srcRoute.isChunk)) {
          return k;
        }
      }
    }
    return srcId;
  };

  const pushRouteChangesToOverlappingPeers = (ctrl, activeProj, changedIds, deletedIds, now) => {
    if (!changedIds.length && !deletedIds.length) return;
    const peers = overlappingPeersOf(ctrl, activeProj);
    if (!peers.length) return;

    const srcDoc = ctrl.store && ctrl.store.doc;
    if (!srcDoc) return;

    for (const peer of peers) {
      try {
        const peerDoc = ctrl._loadProjectDraft(peer.id);
        if (!peerDoc || typeof peerDoc !== 'object') continue;
        peerDoc.routes = peerDoc.routes || {};
        peerDoc.stops = peerDoc.stops || {};
        peerDoc._deletedRoutes = peerDoc._deletedRoutes || {};
        let dirty = false;

        for (const rid of changedIds) {
          const srcRoute = srcDoc.routes && srcDoc.routes[rid];
          if (!srcRoute) continue;
          const targetKey = findTargetRouteKey(peerDoc.routes, rid, srcRoute);
          const existing = peerDoc.routes[targetKey];
          const srcTs = srcRoute._routeUpdatedAt || now;
          const dstTs = (existing && existing._routeUpdatedAt) || 0;
          if (!existing || srcTs >= dstTs) {
            const cloned = JSON.parse(JSON.stringify(srcRoute));
            cloned.id = targetKey;
            cloned._routeUpdatedAt = srcTs;
            cloned._routeUpdatedBy = activeProj.id;
            if (canonicalRouteSig(existing) !== canonicalRouteSig(cloned) || dstTs !== srcTs) {
              peerDoc.routes[targetKey] = cloned;
              delete peerDoc._deletedRoutes[targetKey];
              copyReferencedStops(srcDoc.stops, peerDoc.stops, cloned);
              dirty = true;
            }
          }
        }

        for (const rid of deletedIds) {
          const existing = peerDoc.routes[rid];
          const dstTs = (existing && existing._routeUpdatedAt) || 0;
          if (existing && dstTs < now) {
            delete peerDoc.routes[rid];
            peerDoc._deletedRoutes[rid] = now;
            dirty = true;
          }
        }

        if (dirty) {
          peerDoc.seq = Math.max(peerDoc.seq || 1, srcDoc.seq || 1);
          localStorage.setItem('brass_proj_doc_' + peer.id, JSON.stringify(peerDoc));
          if (ctrl._storedDocs) ctrl._storedDocs.delete('brass_proj_doc_' + peer.id);
          lastRouteSnapByProj.set(peer.id, captureRouteSnap(peerDoc));
        }
      } catch (e) {
        console.warn('Could not sync overlapping project routes to', peer.id, e);
      }
    }
  };

  const pullLatestRoutesFromOverlappingPeers = (ctrl, targetProj) => {
    if (!ctrl || !targetProj || !targetProj.id || targetProj.id === 'main' || targetProj.status === 'archive') return false;
    const peers = overlappingPeersOf(ctrl, targetProj);
    if (!peers.length) return false;

    const targetDoc = ctrl._loadProjectDraft(targetProj.id);
    if (!targetDoc || typeof targetDoc !== 'object') return false;
    targetDoc.routes = targetDoc.routes || {};
    targetDoc.stops = targetDoc.stops || {};
    targetDoc._deletedRoutes = targetDoc._deletedRoutes || {};
    const targetBaseRoutes = (B.storedPart && B.storedPart('brass_proj_base_' + targetProj.id, 'routes')) || null;
    let dirty = false;

    for (const peer of peers) {
      try {
        const peerKey = 'brass_proj_doc_' + peer.id;
        const peerRoutes = (B.storedPart && B.storedPart(peerKey, 'routes')) || null;
        if (!peerRoutes) continue;
        const peerBaseRoutes = (B.storedPart && B.storedPart('brass_proj_base_' + peer.id, 'routes')) || null;
        const peerStops = (B.storedPart && B.storedPart(peerKey, 'stops')) || null;
        const peerDeleted = (B.storedPart && B.storedPart(peerKey, '_deletedRoutes')) || null;

        // Apply latest modified/added routes from overlapping peer
        for (const [rid, pRoute] of Object.entries(peerRoutes)) {
          if (!pRoute) continue;
          const peerModified = Boolean(pRoute._routeUpdatedAt) ||
            (peerBaseRoutes ? canonicalRouteSig(pRoute) !== canonicalRouteSig(peerBaseRoutes[rid]) : false);
          if (!peerModified) continue;

          const targetKey = findTargetRouteKey(targetDoc.routes, rid, pRoute);
          const tRoute = targetDoc.routes[targetKey];
          const targetModified = Boolean(tRoute && tRoute._routeUpdatedAt) ||
            (tRoute && targetBaseRoutes ? canonicalRouteSig(tRoute) !== canonicalRouteSig(targetBaseRoutes[targetKey]) : false);

          const peerTs = pRoute._routeUpdatedAt || (peer.updatedAt || 1);
          const targetTs = (tRoute && tRoute._routeUpdatedAt) || (targetModified ? (targetProj.updatedAt || 1) : 0);
          const targetDelTs = targetDoc._deletedRoutes[targetKey] || 0;
          if (targetDelTs >= peerTs) continue;

          const shouldPull = !tRoute
            ? true
            : (!targetModified && canonicalRouteSig(pRoute) !== canonicalRouteSig(tRoute)) ||
            (peerTs > targetTs && canonicalRouteSig(pRoute) !== canonicalRouteSig(tRoute));

          if (shouldPull) {
            const cloned = JSON.parse(JSON.stringify(pRoute));
            cloned.id = targetKey;
            cloned._routeUpdatedAt = peerTs;
            cloned._routeUpdatedBy = pRoute._routeUpdatedBy || peer.id;
            targetDoc.routes[targetKey] = cloned;
            copyReferencedStops(peerStops, targetDoc.stops, cloned);
            dirty = true;
          }
        }

        // Apply newer explicit route deletions from overlapping peer
        if (peerDeleted && typeof peerDeleted === 'object') {
          for (const [rid, delTs] of Object.entries(peerDeleted)) {
            if (!delTs || !targetDoc.routes[rid]) continue;
            const tRoute = targetDoc.routes[rid];
            const targetTs = (tRoute && tRoute._routeUpdatedAt) || 0;
            if (delTs > targetTs) {
              delete targetDoc.routes[rid];
              targetDoc._deletedRoutes[rid] = delTs;
              dirty = true;
            }
          }
        }
      } catch (e) {
        console.warn('Could not pull overlapping project routes from', peer.id, e);
      }
    }

    if (dirty) {
      localStorage.setItem('brass_proj_doc_' + targetProj.id, JSON.stringify(targetDoc));
      if (ctrl._storedDocs) ctrl._storedDocs.delete('brass_proj_doc_' + targetProj.id);
    }
    return dirty;
  };

  const origSaveDraft = B.Controller.prototype._saveCurrentProjectDraft;
  if (typeof origSaveDraft === 'function') {
    B.Controller.prototype._saveCurrentProjectDraft = function () {
      const pid = this.activeProjectId;
      const doc = this.store && this.store.doc;
      const canSync = !syncingOverlapRoutes &&
        pid && pid !== 'main' &&
        !this.reviewMode &&
        !(this._isReadOnlyView && this._isReadOnlyView()) &&
        doc && doc.routes;

      let changedIds = [];
      let deletedIds = [];
      let now = Date.now();
      let activeProj = null;

      if (canSync) {
        activeProj = (this.projects || []).find((p) => p.id === pid) || null;
        if (activeProj && activeProj.status !== 'archive') {
          let prevSnap = lastRouteSnapByProj.get(pid);
          if (!prevSnap) {
            const savedRoutes = B.storedPart && B.storedPart('brass_proj_doc_' + pid, 'routes');
            prevSnap = captureRouteSnap({ routes: savedRoutes || {} });
          }

          for (const [rid, r] of Object.entries(doc.routes)) {
            const sig = canonicalRouteSig(r);
            if (!prevSnap.has(rid) || prevSnap.get(rid) !== sig) {
              changedIds.push(rid);
              // The project a bus was first made in, kept as it's shared with other projects: the project it
              // came from (its last stamp) if it was copied in, else this one when it's new here
              if (!r._createdIn) {
                if (r._routeUpdatedBy) r._createdIn = r._routeUpdatedBy;
                else if (!prevSnap.has(rid)) r._createdIn = pid;
              }
              r._routeUpdatedAt = now;
              r._routeUpdatedBy = pid;
            }
          }
          for (const rid of prevSnap.keys()) {
            if (!(rid in doc.routes)) {
              deletedIds.push(rid);
              doc._deletedRoutes = doc._deletedRoutes || {};
              doc._deletedRoutes[rid] = now;
            }
          }
        }
      }

      const res = origSaveDraft.apply(this, arguments);

      if (canSync && activeProj && activeProj.status !== 'archive') {
        lastRouteSnapByProj.set(pid, captureRouteSnap(doc));
        if (changedIds.length || deletedIds.length) {
          syncingOverlapRoutes = true;
          try {
            pushRouteChangesToOverlappingPeers(this, activeProj, changedIds, deletedIds, now);
          } finally {
            syncingOverlapRoutes = false;
          }
        }
      }
      return res;
    };
  }

  const origSwitchForSync = B.Controller.prototype._switchProject;
  if (typeof origSwitchForSync === 'function') {
    B.Controller.prototype._switchProject = function (targetProjectId, targetMode) {
      let resolvedId = targetProjectId;
      if (resolvedId && this.projects && this.projects.length) {
        if (resolvedId === 'proj-1' && !this.projects.some((p) => p.id === 'proj-1') && this.projects.some((p) => p.id === 'prj-1')) {
          resolvedId = 'prj-1';
        } else if (resolvedId === 'prj-1' && !this.projects.some((p) => p.id === 'prj-1') && this.projects.some((p) => p.id === 'proj-1')) {
          resolvedId = 'proj-1';
        }
      }

      // First flush current project's draft (so its latest route edits push to overlapping peers)
      if (!syncingOverlapRoutes && this.activeProjectId && this.activeProjectId !== resolvedId && this.activeProjectId !== 'main' && !this.reviewMode) {
        this._saveCurrentProjectDraft(false);
      }

      // Reconcile target project's saved doc with overlapping peers before _switchProject loads it
      if (!syncingOverlapRoutes && resolvedId && resolvedId !== 'main' && !this.reviewMode) {
        const targetProj = (this.projects || []).find((p) => p.id === resolvedId);
        if (targetProj && targetProj.status !== 'archive') {
          syncingOverlapRoutes = true;
          try {
            pullLatestRoutesFromOverlappingPeers(this, targetProj);
          } finally {
            syncingOverlapRoutes = false;
          }
        }
      }

      const res = origSwitchForSync.apply(this, arguments);

      if (this.activeProjectId && this.activeProjectId !== 'main' && this.store && this.store.doc) {
        lastRouteSnapByProj.set(this.activeProjectId, captureRouteSnap(this.store.doc));
      }
      return res;
    };
  }

  // Keep only Route, Time, Distance, Stops, Skipped and Passengers in the detour comparison scorecard
  const origRenderScorecard = B.Controller.prototype._renderDetourScorecard;
  if (typeof origRenderScorecard === 'function') {
    B.Controller.prototype._renderDetourScorecard = function (content) {
      const res = origRenderScorecard.apply(this, arguments);
      const table = content && content.querySelector && content.querySelector('.scorecard');
      if (table) {
        // Columns are named (data-col): drop Cost, MRT and INT, and call Riders "Passengers"
        table.querySelectorAll('[data-col="cost"], [data-col="mrt"], [data-col="interchange"]').forEach((el) => el.remove());
        const ridersHead = table.querySelector('th[data-col="riders"]');
        if (ridersHead) {
          ridersHead.textContent = 'Passengers';
          ridersHead.title = 'Passengers a day at its stops (estimate)';
        }
        const rows = table.querySelectorAll('tr');
        rows.forEach((tr) => {
          const nameCell = tr.querySelector('.sc-name');
          if (nameCell) {
            nameCell.querySelectorAll('.int-tag').forEach((el) => el.remove());
            const tags = Array.from(nameCell.querySelectorAll('.sc-tag, .detour-best'));
            if (tags.length) {
              const tagWrap = document.createElement('div');
              tagWrap.className = 'sc-tags';
              tags.forEach((tag) => {
                if (tag.classList.contains('detour-best')) {
                  tag.textContent = 'Best';
                }
                tagWrap.appendChild(tag);
              });
              nameCell.appendChild(tagWrap);
            }
          }
        });
      }
      return res;
    };
  }

  // Move "Resolution Options" (.route-problem-box: Divert / Curtail / Suspend) to the top of the
  // inspector, behind a collapsible "AI Smart Route Adjustment" button. "Changes made by AI" (.doc-notes)
  // goes in the same card, above the options; with no options it stays where it is.
  const CHEV_ICON = '<svg class="ai-help-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

  let aiHelpOpenRouteId = null;
  const origShowInspector = B.Controller.prototype._showInspector;
  if (typeof origShowInspector === 'function') {
    B.Controller.prototype._showInspector = function (target) {
      const res = origShowInspector.apply(this, arguments);
      const content = document.querySelector('#inspector-panel .inspector-body');
      if (!content) return res;
      const problemBox = content.querySelector('.route-problem-box');
      if (!problemBox) return res;

      const curRouteId = (target && target.id) || (this.renderer && this.renderer.selected && this.renderer.selected.id) || '__route__';
      const isOpen = aiHelpOpenRouteId === curRouteId;

      const wrap = document.createElement('div');
      wrap.className = `ai-help-wrap${isOpen ? ' is-open' : ''}`;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ai-help-btn';
      btn.setAttribute('aria-expanded', String(isOpen));
      btn.innerHTML = `${B.AI_ICON || ''}<span>AI Smart Route Adjustment</span>${CHEV_ICON}`;

      const drawer = document.createElement('div');
      drawer.className = 'ai-help-drawer';
      drawer.hidden = !isOpen;
      const docNotes = content.querySelector('.doc-notes');
      if (docNotes) drawer.appendChild(docNotes);
      drawer.appendChild(problemBox);

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nextOpen = drawer.hidden;
        drawer.hidden = !nextOpen;
        wrap.classList.toggle('is-open', nextOpen);
        btn.setAttribute('aria-expanded', String(nextOpen));
        aiHelpOpenRouteId = nextOpen ? curRouteId : null;
      });

      wrap.appendChild(btn);
      wrap.appendChild(drawer);
      content.insertBefore(wrap, content.firstElementChild);
      return res;
    };
  }

  // ---------------------------------------------------------------------------
  // Strict overlap & Go-Live duration guard + clean new projects from live temp overlays:
  // 1) Never bake temporary live scheduled incidents (like Novena Car Accident) into new projects.
  // 2) Clean up any temporary live incident closures/areas that leaked into existing projects' base/doc.
  // 3) Only show foreign affected areas / road closures from projects that strictly overlap
  //    the current project's period and have not passed their Go-Live duration.
  // ---------------------------------------------------------------------------
  const scheduledEndTs = (proj) => {
    const raw = proj && proj.applyPeriod;
    if (!raw || raw.mode !== 'scheduled') return Infinity;
    if (!raw.endDate || !raw.endTime) return NaN;
    const t = new Date(`${raw.endDate}T${raw.endTime}`).getTime();
    return Number.isFinite(t) ? t : NaN;
  };

  const collectForeignTempObstacles = (ctrl, excludeProjId) => {
    const areaIds = new Set();
    const areaNames = new Set();
    const closureEdges = new Set();

    // 1. From scheduledChanges belonging to other projects
    for (const sc of (ctrl.scheduledChanges || [])) {
      if (!sc || !sc.patch || sc.projectId === excludeProjId) continue;
      if (sc.patch.areas && sc.patch.areas.set) {
        for (const [aid, a] of Object.entries(sc.patch.areas.set)) {
          areaIds.add(aid);
          if (a && a.name) areaNames.add(a.name);
        }
      }
      if (sc.patch.closures && sc.patch.closures.set) {
        for (const eid of Object.keys(sc.patch.closures.set)) {
          closureEdges.add(String(eid));
        }
      }
    }

    // 2. From other temporary go_live/archive projects (their own added areas/closures)
    for (const other of (ctrl.projects || [])) {
      if (!other || other.id === excludeProjId) continue;
      if (!(other.applyPeriod && other.applyPeriod.mode === 'scheduled')) continue;
      if (other.status !== 'go_live' && other.status !== 'archive') continue;
      const oAreas = (B.storedPart && B.storedPart('brass_proj_doc_' + other.id, 'areas')) || {};
      const oBaseAreas = (B.storedPart && B.storedPart('brass_proj_base_' + other.id, 'areas')) || {};
      for (const [aid, a] of Object.entries(oAreas)) {
        if (!(aid in oBaseAreas)) {
          areaIds.add(aid);
          if (a && a.name) areaNames.add(a.name);
        }
      }
      const oClosures = (B.storedPart && B.storedPart('brass_proj_doc_' + other.id, 'closures')) || {};
      const oBaseClosures = (B.storedPart && B.storedPart('brass_proj_base_' + other.id, 'closures')) || {};
      for (const eid of Object.keys(oClosures)) {
        if (!(eid in oBaseClosures)) {
          closureEdges.add(String(eid));
        }
      }
    }

    return { areaIds, areaNames, closureEdges };
  };

  const stripLeakedTempObstaclesFromProject = (ctrl, projId) => {
    if (!ctrl || !projId || projId === 'main') return false;
    const rawDoc = localStorage.getItem('brass_proj_doc_' + projId);
    const rawBase = localStorage.getItem('brass_proj_base_' + projId);
    if (!rawDoc || !rawBase) return false;

    let doc, baseDoc;
    try {
      doc = JSON.parse(rawDoc);
      baseDoc = JSON.parse(rawBase);
    } catch (e) {
      return false;
    }
    if (!doc || !baseDoc) return false;

    const leaked = collectForeignTempObstacles(ctrl, projId);
    if (!leaked.areaIds.size && !leaked.closureEdges.size) return false;

    let changed = false;
    doc.areas = doc.areas || {};
    baseDoc.areas = baseDoc.areas || {};
    doc.closures = doc.closures || {};
    baseDoc.closures = baseDoc.closures || {};

    // 1. Strip leaked obstacles that were inherited in proj's baseDoc
    for (const aid of Object.keys(baseDoc.areas)) {
      const a = baseDoc.areas[aid];
      const matchesLeaked = leaked.areaIds.has(aid) || (a && a.name && leaked.areaNames.has(a.name));
      if (matchesLeaked) {
        if (a && a.name) leaked.areaNames.add(a.name);
        delete baseDoc.areas[aid];
        if (aid in doc.areas) delete doc.areas[aid];
        changed = true;
      }
    }

    // Also strip exact foreign temporary incident areas (e.g. Traffic Accident Clearance Zone) if they leaked into doc
    for (const aid of Object.keys(doc.areas)) {
      const a = doc.areas[aid];
      if (a && a.name && leaked.areaNames.has(a.name)) {
        delete doc.areas[aid];
        if (aid in baseDoc.areas) delete baseDoc.areas[aid];
        changed = true;
      }
    }

    for (const eid of Object.keys(baseDoc.closures)) {
      const cl = baseDoc.closures[eid];
      const reasonArea = cl && typeof cl.reason === 'string' && cl.reason.startsWith('Closed by ')
        ? cl.reason.slice('Closed by '.length)
        : null;
      const matchesLeaked = leaked.closureEdges.has(String(eid)) || (reasonArea && leaked.areaNames.has(reasonArea));
      if (matchesLeaked) {
        delete baseDoc.closures[eid];
        if (eid in doc.closures) delete doc.closures[eid];
        changed = true;
      }
    }

    // Also clean leaked foreign temporary closures & auto-derived "Closed by <leakedAreaName>" closures in doc.closures
    const foreignTempProjectNames = new Set(
      (ctrl.projects || [])
        .filter((o) => o && o.id !== projId && o.applyPeriod && o.applyPeriod.mode === 'scheduled' && (o.status === 'go_live' || o.status === 'archive'))
        .map((o) => o.name)
        .filter(Boolean)
    );
    for (const eid of Object.keys(doc.closures)) {
      const cl = doc.closures[eid];
      const reason = cl && typeof cl.reason === 'string' ? cl.reason : '';
      const isClosedByLeaked = reason.startsWith('Closed by ') && leaked.areaNames.has(reason.slice('Closed by '.length)) &&
        !Object.values(doc.areas).some((a) => a && a.name === reason.slice('Closed by '.length));
      const isNamedForeignIncident = reason && foreignTempProjectNames.has(reason) && leaked.closureEdges.has(String(eid));
      if (isClosedByLeaked || isNamedForeignIncident) {
        delete doc.closures[eid];
        if (eid in baseDoc.closures) delete baseDoc.closures[eid];
        changed = true;
      }
    }

    if (changed) {
      try {
        localStorage.setItem('brass_proj_base_' + projId, JSON.stringify(baseDoc));
        localStorage.setItem('brass_proj_doc_' + projId, JSON.stringify(doc));
        if (ctrl._storedDocs) {
          ctrl._storedDocs.delete('brass_proj_base_' + projId);
          ctrl._storedDocs.delete('brass_proj_doc_' + projId);
        }
      } catch (e) {}
    }
    return changed;
  };
  B.stripLeakedTempObstaclesFromProject = stripLeakedTempObstaclesFromProject;

  // 1. Clean new projects so they start from the permanent base map (never inheriting temporary live closures/areas)
  const origCreateNewProject = B.Controller.prototype._createNewProject;
  if (typeof origCreateNewProject === 'function') {
    B.Controller.prototype._createNewProject = function () {
      const res = origCreateNewProject.apply(this, arguments);
      const newId = this.activeProjectId;
      if (newId && newId !== 'main') {
        const cleanBase = this.scheduledBase ? JSON.parse(JSON.stringify(this.scheduledBase)) : null;
        if (cleanBase) {
          try {
            localStorage.setItem('brass_proj_doc_' + newId, JSON.stringify(cleanBase));
            localStorage.setItem('brass_proj_base_' + newId, JSON.stringify(cleanBase));
            if (this._storedDocs) {
              this._storedDocs.delete('brass_proj_doc_' + newId);
              this._storedDocs.delete('brass_proj_base_' + newId);
            }
            this._prepareForeignBlocked(cleanBase);
            this.store.loadDoc(cleanBase, { label: `Clean base for ${newId}` });
            this._lastSavedDoc = JSON.stringify(this.store.doc);
            this._foreignKey = null;
            if (this._syncForeignObstacles) this._syncForeignObstacles();
            if (this._updateUIState) this._updateUIState();
            if (this.renderer) this.renderer.requestRender();
          } catch (e) {}
        } else if (stripLeakedTempObstaclesFromProject(this, newId)) {
          const cleaned = this._loadProjectDraft(newId);
          this._prepareForeignBlocked(cleaned);
          this.store.loadDoc(cleaned, { label: `Clean base for ${newId}` });
          this._foreignKey = null;
          if (this._syncForeignObstacles) this._syncForeignObstacles();
          if (this._updateUIState) this._updateUIState();
        }
      }
      return res;
    };
  }

  // 2. Strip leaked temporary obstacles before switching to any project
  const origSwitchClean = B.Controller.prototype._switchProject;
  if (typeof origSwitchClean === 'function') {
    B.Controller.prototype._switchProject = function (targetProjectId) {
      if (targetProjectId && targetProjectId !== 'main' && !this.reviewMode) {
        stripLeakedTempObstaclesFromProject(this, targetProjectId);
      }
      return origSwitchClean.apply(this, arguments);
    };
  }

  // 3. Strictly filter _foreignObstacles: never show archived or expired Go-Live projects, only strictly overlapping periods
  const origForeignObstacles = B.Controller.prototype._foreignObstacles;
  if (typeof origForeignObstacles === 'function') {
    B.Controller.prototype._foreignObstacles = function (currentDoc) {
      const fo = origForeignObstacles.apply(this, arguments);
      if (!fo) return fo;

      const now = Date.now();
      const currentProj = (this.projects || []).find((x) => x.id === this.activeProjectId) || { id: this.activeProjectId || 'main', name: 'Current Map' };
      const projById = new Map((this.projects || []).map((p) => [p.id, p]));

      const allowProject = (pid) => {
        const other = projById.get(pid);
        if (!other || other.id === currentProj.id) return false;
        if (other.status === 'archive') return false;
        if (!this._periodsOverlap(currentProj, other)) return false;

        // If the other project has a scheduled Go-Live / temporary end time that has already passed,
        // do not show its affected areas/closures once its Go-Live duration has passed.
        const endTs = scheduledEndTs(other);
        if (Number.isFinite(endTs) && endTs <= now) {
          return false;
        }
        return true;
      };

      const areas = (fo.areas || []).filter((a) => allowProject(a.projectId));
      const closures = (fo.closures || []).filter((c) => allowProject(c.projectId));
      const stops = (fo.stops || []).filter((st) => allowProject(st.projectId));
      const allStops = (fo.allStops || []).filter((st) => allowProject(st.projectId));
      const activeIds = new Set([...areas.map((a) => a.projectId), ...closures.map((c) => c.projectId)]);
      const signs = (fo.signs || []).filter((s) => activeIds.has(s.projectId));
      return { areas, closures, stops, allStops, signs };
    };
  }

  // 4. One-time cleanup on initial load for the active project so any previously leaked Novena/temp obstacles vanish right away
  let cleanedBootProj = false;
  const origSyncForeignBoot = B.Controller.prototype._syncForeignObstacles;
  if (typeof origSyncForeignBoot === 'function') {
    B.Controller.prototype._syncForeignObstacles = function () {
      if (!cleanedBootProj && this.activeProjectId && this.activeProjectId !== 'main' && !this.reviewMode && this.store && this.store.doc) {
        cleanedBootProj = true;
        if (stripLeakedTempObstaclesFromProject(this, this.activeProjectId)) {
          const cleaned = this._loadProjectDraft(this.activeProjectId);
          this._prepareForeignBlocked(cleaned);
          this.store.loadDoc(cleaned, { label: 'Clean inherited temporary obstacles' });
          this._lastSavedDoc = JSON.stringify(this.store.doc);
          this._foreignKey = null;
          if (this._updateUIState) this._updateUIState();
          if (this.renderer) this.renderer.requestRender();
        }
      }
      return origSyncForeignBoot.apply(this, arguments);
    };
  }
})();
