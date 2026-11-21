/* BRASS — the sample projects: 3 named projects on the 10 bus services, each closing roads those services run on.
 * Seeded once, before the Current Map, its history and the date-range schedule load, and with no documents attached.
 * What it replaces is kept: small entries in brass_backup_projects, maps under brass_proj_doc_backup__<their key>. */
(function () {
  const B = window.B;
  const VERSION = '2026.8';
  const FLAG = 'brass_sample_projects';
  const DAY = 86400000;
  const at = (s) => new Date(s.replace(' ', 'T')).getTime();

  // [name, stage, period, owner, collaborators, changes]
  // period: ['start', 'end'] for a Temporary change, or the day a Permanent change goes live
  // changes: area (a zone that closes the roads in it) · close (a stretch of a road)
  //          bus (a new service between two interchanges) · withdraw (a bus number) · stop (a new stop)
  // Each closes the stretch of road that the bus services named beside it run on
  const PROJECTS = [
    // Live emergency incident project (currently active right now)
    ['Emergency Incident: Car Accident along Balestier Road', 'go_live', ['2026-11-20 08:30', '2026-11-20 18:00'], 'bops-1', ['ops-3'], [
      { area: 'Traffic Accident Clearance Zone', at: 'mrt:Novena', r: 500 },
      { close: 'Balestier Road', at: 'mrt:Novena', r: 500 },
    ]],
    // In the past: ended, kept as a record — all affected routes (Bus 12, 67, 147, 168) detoured to completely avoid the Geylang Serai Light-Up Zone and closed road junctions
    ['Hari Raya Light-Up 2026: Geylang Serai', 'archive', ['2026-02-14 17:00', '2026-03-22 02:00'], 'bops-1', ['ops-3', 'bops-2'], [
      { area: 'Geylang Serai Light-Up Zone', at: 'mrt:Geylang', r: 500 },
      { close: 'Geylang Street 73', at: 'mrt:Geylang', r: 600 },
      { close: 'Upper Paya Lebar Road', at: 'mrt:Geylang', r: 800 },
      { detour: '12' },
      { detour: '67' },
      { detour: '147' },
      { detour: '168' },
    ]],
    // Drafts being prepared, overlapping from 26 Dec 18:00 to 28 Dec 02:00
    ['Christmas on A Great Street 2026: Orchard Road', 'progress', ['2026-12-18 18:00', '2026-12-28 02:00'], 'bops-1', ['ops-3', 'bops-2'], [
      { close: 'Orchard Road', at: 'mrt:Tanglin', r: 700 }, // bus 780
    ]],
    ['New Year Countdown 2027: Tampines', 'progress', ['2026-12-26 18:00', '2027-01-02 02:00'], 'bops-1', ['ops-3'], [
      { close: 'Tampines Avenue 10', at: 'Tampines Int', r: 800 }, // buses 63 and 476
    ]],
  ];

  // The changes, made on a map the way the editor makes them
  const changer = (city, net) => {
    const intStop = (doc, name) => Object.values(doc.stops).find((s) => B.isInterchange(s) && s.name === name);
    const placeOf = (doc, p) => {
      if (p.startsWith('mrt:')) {
        const m = (city.mrtStations || []).find((x) => x.name === p.slice(4));
        return m && { x: m.x, y: m.y };
      }
      const st = intStop(doc, p);
      return st && net.posPoint(st, 0.78);
    };
    // The stretch of a road nearest a place (its closest pieces when none are within r)
    const stretch = (road, p, r) => {
      const near = net.edges
        .filter((e) => e && e.name === road)
        .map((e) => ({ id: e.id, d: Math.min(...e.pts.map((q) => Math.hypot(q.x - p.x, q.y - p.y))) }))
        .sort((a, b) => a.d - b.d);
      const inside = near.filter((x) => x.d <= r);
      return (inside.length ? inside : near.slice(0, 3)).map((x) => x.id);
    };
    const routesNumbered = (doc, num) => Object.values(doc.routes).filter((r) => String(r.number).trim() === num);
    const newId = (doc, prefix) => prefix + doc.seq++;
    // A new service along the roads from one interchange to the other, stopping at the stops on the way
    const service = (doc, o) => {
      const a = intStop(doc, o.from), b = intStop(doc, o.to);
      if (!a || !b) return;
      const leg = net.route({ edge: a.edge, s: a.s, dir: a.dir }, { edge: b.edge, s: b.s, dir: b.dir });
      if (!leg.ok) return;
      const lanes = new Map();
      for (const st of Object.values(doc.stops)) {
        if (st.active === false) continue;
        const k = st.edge * 2 + (st.dir > 0 ? 0 : 1);
        if (lanes.has(k)) lanes.get(k).push(st); else lanes.set(k, [st]);
      }
      let ids = [a.id];
      for (const sg of leg.segs) {
        const lo = Math.min(sg.s0, sg.s1) - 1, hi = Math.max(sg.s0, sg.s1) + 1;
        (lanes.get(sg.edge * 2 + (sg.dir > 0 ? 0 : 1)) || [])
          .filter((st) => st.s >= lo && st.s <= hi)
          .sort((x, y) => (sg.dir > 0 ? x.s - y.s : y.s - x.s))
          .forEach((st) => { if (!ids.includes(st.id)) ids.push(st.id); });
      }
      if (!ids.includes(b.id)) ids.push(b.id);
      const step = Math.max(o.express || 1, Math.ceil(ids.length / 24));
      if (step > 1) ids = ids.filter((id, k) => k === 0 || k === ids.length - 1 || k % step === 0);
      if (ids.length < 3) return;
      const id = newId(doc, 'R');
      doc.routes[id] = {
        id, number: o.bus, name: `Bus ${o.bus} (${a.name} ➔ ${b.name})`,
        color: B.pickRouteColor(Object.values(doc.routes).map((r) => r.color)),
        kind: 'proposed', baseId: null, override: false,
        hours: { start: '05:45', end: '23:30' }, days: B.ALL_DAYS.slice(), fleet: o.fleet || 6,
        anchors: ids.map((sid) => ({ t: 'stop', id: sid })),
      };
    };
    const make = {
      area: (doc, o) => {
        const p = placeOf(doc, o.at);
        if (!p) return;
        const id = newId(doc, 'A');
        doc.areas[id] = { id, name: o.area, shape: 'circle', cx: Math.round(p.x), cy: Math.round(p.y), r: o.r };
      },
      close: (doc, o, name) => {
        const p = placeOf(doc, o.at);
        if (p) B.ops.setClosed(doc, stretch(o.close, p, o.r), true, { reason: name });
      },
      bus: service,
      detour: (doc, o) => {
        const targets = routesNumbered(doc, String(o.detour));
        if (!targets.length || !B.Store) return;
        const calc = Object.create(B.Store.prototype);
        Object.assign(calc, { city, net, doc, legCache: new Map(), past: [], future: [], tx: null, rev: 1 });
        calc.derive();
        for (const r of targets) {
          const opts = calc.generateDetourOptions(r.id) || [];
          const chosen = opts.find((opt) => opt && opt.anchors && opt.anchors.length >= 2 && (!opt.geom || !(opt.geom.conflicts && opt.geom.conflicts.length))) || opts[0];
          if (!chosen || !chosen.anchors) continue;
          if (!r.originalAnchors) r.originalAnchors = JSON.parse(JSON.stringify(r.anchors));
          r.anchors = JSON.parse(JSON.stringify(chosen.anchors));
          r.activeOptionIdx = 0;
          r.detourApplied = true;
          r.viaName = chosen.viaName || chosen.title || 'Geylang Bypass';
          r.detourTitle = chosen.title || `Detour via ${r.viaName}`;
        }
      },
      withdraw: (doc, o) => routesNumbered(doc, o.withdraw).forEach((r) => { r.active = false; }),
      stop: (doc, o, name, when) => {
        const p = placeOf(doc, o.at);
        const cls = p && net.classify(p, 160);
        if (!cls || !cls.pos) return;
        const near = Object.values(doc.stops).reduce((best, s) => {
          const q = net.posPoint(s, 0.78), d = Math.hypot(q.x - p.x, q.y - p.y);
          return !best || d < best.d ? { s, d } : best;
        }, null);
        const id = newId(doc, 'S');
        doc.stops[id] = {
          id, code: (near ? near.s.code.slice(0, 2) : '99') + '9' + String(doc.seq % 100).padStart(2, '0'), name: o.stop,
          edge: cls.edge, s: cls.pos.s, dir: cls.pos.dir, kind: 'proposed', userCreated: true, createdAt: when,
        };
      },
    };
    return (doc, o, name, when) => {
      const kind = Object.keys(make).find((k) => k in o);
      try { make[kind](doc, o, name, when); } catch (e) { console.warn('Sample change skipped', name, e); }
    };
  };

  // Projects, maps, history and schedules from before are set aside, and attached documents removed
  const SAMPLE_KEYS = /^(brass_projects_list|brass_active_project_id|brass_proj_doc_|brass_proj_base_|brass_map_versions|brass_map_snapshot_|brass_map_before_|brass_project_map_|brass_scheduled_changes|brass_scheduled_base|brass_seeded_default_docs_v1|brass\.doc\.)/;
  const MAPS = /^(brass_proj_doc_|brass_proj_base_|brass_map_snapshot_|brass_project_map_|brass_scheduled_base$|brass\.doc\.)/;
  const putAside = (now) => {
    Object.keys(localStorage).filter((x) => x.startsWith('brass_proj_doc_backup__')).forEach((x) => localStorage.removeItem(x));
    const small = {};
    for (const k of Object.keys(localStorage).filter((x) => SAMPLE_KEYS.test(x))) {
      const v = localStorage.getItem(k);
      if (v == null) continue;
      if (MAPS.test(k)) { try { localStorage.setItem('brass_proj_doc_backup__' + k, v); } catch (e) { /* no room: not kept */ } }
      else small[k] = v;
      localStorage.removeItem(k);
    }
    if (Object.keys(small).length) localStorage.setItem('brass_backup_projects', JSON.stringify({ at: now, entries: small }));
    if (B.docs) B.docs.all().then((list) => list.forEach((d) => B.docs.remove(d.id))).catch(() => { });
  };

  B.seedSampleProjects = (c) => {
    const PATCH_FLAG = 'brass_patch_hari_raya_detour_v4';
    const applyHariRayaDetourPatch = () => {
      try {
        if (localStorage.getItem(PATCH_FLAG) === '1') return;
        const rawList = localStorage.getItem('brass_projects_list');
        if (!rawList) return;
        const projs = JSON.parse(rawList);
        const hr = Array.isArray(projs) && projs.find((p) => p && /Hari Raya Light-Up 2026/i.test(p.name || ''));
        if (!hr) { localStorage.setItem(PATCH_FLAG, '1'); return; }
        const docKey = 'brass_proj_doc_' + hr.id;
        const rawDoc = localStorage.getItem(docKey);
        if (!rawDoc) return;
        const doc = JSON.parse(rawDoc);
        const change = changer(c.city, c.net);
        const hasArea = Object.values(doc.areas || {}).some((a) => /Geylang Serai/i.test(a.name || ''));
        if (!hasArea) {
          change(doc, { area: 'Geylang Serai Light-Up Zone', at: 'mrt:Geylang', r: 500 }, hr.name, hr.createdAt);
        }
        // Re-compute detours cleanly for all affected routes so none cut through closed road junctions
        for (const num of ['12', '67', '147', '168']) {
          change(doc, { detour: num }, hr.name, hr.createdAt);
        }
        localStorage.setItem(docKey, JSON.stringify(doc));
        localStorage.setItem(PATCH_FLAG, '1');
      } catch (e) {
        console.warn('Could not apply Hari Raya detour example patch', e);
      }
    };
    try {
      if (localStorage.getItem(FLAG) === VERSION) {
        applyHariRayaDetourPatch();
        return;
      }
    } catch (e) { return; }
    try {
      const now = Date.now();
      putAside(now);
      const users = Object.fromEntries((B.SYSTEM_USERS || []).map((u) => [u.id, { name: u.name, email: u.email, role: u.role }]));
      const change = changer(c.city, c.net);
      const clone = (d) => JSON.parse(JSON.stringify(d));
      const pad = (n) => String(n).padStart(2, '0');
      const day = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
      const time = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

      const list = PROJECTS.map(([name, stage, period, owner, collabs, changes], i) => {
        const temp = Array.isArray(period);
        const start = at(temp ? period[0] : period + ' 05:30');
        const end = temp ? at(period[1]) : null;
        const lead = (20 + (i * 11) % 30) * DAY;
        const preparing = !['go_live', 'archive', 'schedule'].includes(stage);
        const createdAt = Math.min(preparing ? now - lead : start - lead, now - DAY);
        let updatedAt = now - ((i * 13) % 9 + 1) * DAY;
        if (stage === 'go_live') updatedAt = Math.min(start, now);
        if (stage === 'archive') updatedAt = Math.min(end + 2 * DAY, now);
        if (stage === 'schedule') updatedAt = Math.min(createdAt + 6 * DAY, now);
        return { name, stage, temp, start, end, owner, collabs, changes, createdAt, updatedAt: Math.max(updatedAt, createdAt) };
      });
      // Ids follow the order they were created in
      [...list].sort((a, b) => a.createdAt - b.createdAt).forEach((s, i) => { s.id = `prj-${i + 1}`; });

      let main = JSON.parse(c.store.sample);
      const versions = [], schedules = [];
      const version = (entry, snapshot) => {
        const v = Object.assign({ id: `ver-${entry.appliedAt}-${versions.length + 1}`, status: null }, entry);
        if (snapshot) { localStorage.setItem('brass_map_snapshot_' + v.id, JSON.stringify(snapshot)); v.hasSnapshot = true; }
        versions.push(v);
      };
      version({ type: 'start', projectName: 'Starting point', appliedAt: at('2026-01-01 00:00') }, main);

      // Through the year: each project starts from the Current Map of its time
      for (const s of [...list].sort((a, b) => a.start - b.start)) {
        const base = clone(main), doc = clone(main);
        s.changes.forEach((o) => change(doc, o, s.name, s.start));
        localStorage.setItem('brass_proj_base_' + s.id, JSON.stringify(base));
        localStorage.setItem('brass_proj_doc_' + s.id, JSON.stringify(doc));
        const ref = { projectId: s.id, projectName: s.name };
        const scheduledAt = Math.min(s.createdAt + 10 * DAY, s.start, now);
        if (s.stage === 'go_live' && !s.temp) {
          main = doc;
          version(Object.assign({ type: 'permanent', appliedAt: s.start }, ref), main);
        } else if (s.stage === 'archive') {
          version(Object.assign({ type: 'temporary', scheduleId: 'sched-' + s.id, start: s.start, end: s.end, appliedAt: scheduledAt, status: 'ended', endedAt: s.end }, ref));
        } else if (s.stage === 'go_live' || s.stage === 'schedule') {
          // Waiting in the schedule: the app puts it live once its start has passed
          schedules.push(Object.assign({ id: 'sched-' + s.id, start: s.start, end: s.end, status: 'pending', patch: c._diffDocs(main, doc), createdAt: scheduledAt }, ref));
          version(Object.assign({ type: 'temporary', scheduleId: 'sched-' + s.id, start: s.start, end: s.end, appliedAt: scheduledAt }, ref));
          schedules.push(Object.assign({ id: 'sched-' + s.id, start: s.start, end: s.end, status: s.stage === 'go_live' ? 'active' : 'pending', patch: c._diffDocs(main, doc), createdAt: scheduledAt }, ref));
          version(Object.assign({ type: 'temporary', scheduleId: 'sched-' + s.id, start: s.start, end: s.end, appliedAt: scheduledAt, status: s.stage === 'go_live' ? 'live' : null }, ref));
        }
      }
      versions.sort((a, b) => a.appliedAt - b.appliedAt).forEach((v, i) => { v.version = i; });

      const projects = [...list].sort((a, b) => a.createdAt - b.createdAt).map((s) => ({
        id: s.id,
        name: s.name,
        mode: ['go_live', 'archive'].includes(s.stage) ? 'view' : 'edit',
        status: s.stage,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        owner: users[s.owner],
        // John Doe, who the app opens as, works on every project, so all of them are in his list
        collaborators: [...new Set(s.owner === 'bops-1' ? s.collabs : ['bops-1', ...s.collabs])]
          .filter((u) => users[u]).map((u) => Object.assign({ addedAt: s.createdAt + DAY }, users[u])),
        applyPeriod: s.temp
          ? { mode: 'scheduled', startDate: day(s.start), startTime: time(s.start), endDate: day(s.end), endTime: time(s.end), repeat: 'none' }
          : { mode: 'permanent', startDate: day(s.start), startTime: time(s.start) },
      }));

      const mainStr = JSON.stringify(main);
      localStorage.setItem('brass_proj_doc_main', mainStr);
      localStorage.setItem(c.store.KEY, mainStr);
      localStorage.setItem('brass_map_versions', JSON.stringify(versions));
      localStorage.setItem('brass_scheduled_changes', JSON.stringify(schedules));
      localStorage.setItem('brass_projects_list', JSON.stringify(projects));
      const opening = projects.find((p) => p.status === 'go_live') || projects.find((p) => p.status === 'progress' && p.owner && p.owner.email === 'john.doe@brass.sg');
      localStorage.setItem('brass_active_project_id', opening ? opening.id : 'main');
      localStorage.setItem(FLAG, VERSION);
    } catch (e) {
      console.warn('Could not create the sample projects', e);
    }
  };
})();
