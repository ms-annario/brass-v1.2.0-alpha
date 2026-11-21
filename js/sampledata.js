/* BRASS — sample (fictional) bus network on Singapore's map: 10 bus services, with an interchange in every town
 * and stops along the services. Illustrative only — not a live feed.
 * Every service is a loop from a town interchange: round the east, round the west, or across the island
 * from east to west and back. Stops sit along each loop and are shared where loops run together. */
(function () {
  const B = window.B;

  B.abbr = (n) => n.replace(/\bRoad\b/g, 'Rd').replace(/\bAvenue\b/g, 'Ave').replace(/\bBoulevard\b/g, 'Blvd')
    .replace(/\bStreet\b/g, 'St').replace(/\bJalan\b/g, 'Jln').replace(/\bExpressway\b/g, 'Expwy').replace(/\bWay\b/g, 'Way');

  const SERVICES = 10;       // bus services in the system

  // A colour of its own for every service: hues a golden angle apart, light and dark in turn
  const serviceColor = (i) => {
    const hue = (i * 137.508) % 360, sat = 0.62 + (i % 3) * 0.08, lig = 0.36 + (i % 4) * 0.045;
    const f = (n) => {
      const k = (n + hue / 30) % 12, a = sat * Math.min(lig, 1 - lig);
      return Math.round(255 * (lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  };

  B.buildSampleDoc = function (city, net) {
    const rnd = B.rng(4242);
    const { nodes, edges } = city;
    // map: which generated network the stops and roads belong to, so maps from another one are never loaded onto it
    const doc = { map: B.MAP_VERSION, stops: {}, routes: {}, interchanges: {}, accidents: {}, areas: {}, closures: {}, seq: 1 };

    const landmarks = {
      cbd: [
        'Raffles Pl Stn', 'The Sail', 'Lau Pa Sat', 'One Raffles Quay', 'Customs Hse', 'Marina Bay Stn', 'Downtown Stn',
        'Suntec Twr 3', 'Esplanade Dr', 'Marina Blvd', 'Shenton Way', 'Clifford Pier', 'Central Blvd', 'Marina Bay Sands',
        'Ocean Financial Ctr', 'OUE Bayfront', 'Asia Square', 'Bayfront Ave', 'Straits View', 'Marina View', 'Tanjong Pagar Stn',
        'Maxwell Food Ctr', 'Telok Ayer Stn', 'Capital Twr'
      ],
      mixed: [
        'Orchard Stn', 'Ngee Ann City', 'Plaza Singapura', 'Bugis Junction', 'Kallang Stadium', 'City Hall Stn', 'Clarke Quay',
        'Funan Mall', 'Newton Food Ctr', 'Lavender Stn', 'Somerset Stn', 'Dhoby Ghaut Stn', 'Bencoolen St', 'Bras Basah',
        'Fort Canning', 'National Museum', 'Victoria St', 'Albert Mall', 'Waterloo St', 'Stamford Rd', 'Novena Sq',
        'Paya Lebar Sq', 'Jem', 'Westgate', 'JCube', 'Leisure Park', 'Sports Hub'
      ],
      hdb: [
        'Blk', 'Opp Blk', 'Town Ctr', 'Market & Food Ctr', 'Community Club', 'Polyclinic', 'Sports Complex',
        'Neighbourhood Park', 'Library', 'Green', 'Shopping Ctr', 'Pr Sch', 'Sec Sch', 'Stn', 'Hub'
      ],
      landed: [
        'Opp Sec Sch', 'Aft Pri Sch', 'Opp CC', 'Bef Chapel', 'Community Park', 'Hillview Walk', 'Sunset Way',
        'Greenwood Ave', 'Bef Playground', 'Opp Botanic Gdns', 'Clubhouse', 'Hillcrest Ave', 'Opp Condo', 'Bef Temple'
      ],
      industrial: [
        'Opp Factory', 'Aft Logistics Hub', 'Bef Warehouse', 'Opp Depot', 'Cargo Complex', 'Aviation Park', 'Tech Park',
        'Innovation Hub', 'Freight Ctr', 'Coastal Depot', 'Shipyard Cres', 'Opp Wafer Fab', 'Bef Ind Pk', 'Opp Dormitory'
      ]
    };

    const used = new Set(), codeCount = {};
    const stopName = (pos) => {
      const e = edges[pos.edge];
      const p = B.pointAlong(e.pts, e.cum, pos.s);
      const d = city.districtAt(p);
      const node = nodes[pos.s < e.len / 2 ? e.a : e.b];
      const cross = node.edges.map((id) => edges[id]).find((x) => x && x.name !== e.name);
      let name;
      for (let k = 0; k < 12; k++) {
        const r = rnd();
        if (d.type === 'hdb' && r < 0.6) {
          const pick = rnd.pick(landmarks.hdb);
          name = (pick === 'Blk' || pick === 'Opp Blk') ? pick + ' ' + rnd.int(101, 899) : d.short.split(' ')[0] + ' ' + pick;
        } else if ((d.type === 'cbd' || d.type === 'mixed') && r < 0.55) {
          name = rnd.pick(landmarks[d.type]);
        } else if (r < 0.75 && cross) {
          name = (pos.s < e.len / 2 ? (pos.dir > 0 ? 'Aft ' : 'Bef ') : (pos.dir > 0 ? 'Bef ' : 'Aft ')) + B.abbr(cross.name);
        } else {
          const pick = rnd.pick(landmarks[d.type] || landmarks.mixed);
          name = (d.type === 'hdb' && (pick === 'Blk' || pick === 'Opp Blk')) ? pick + ' ' + rnd.int(101, 899) : pick;
        }
        if (!used.has(name)) break;
        if (k > 5) name = name + ' (' + (pos.dir > 0 ? 'Dir 1' : 'Dir 2') + ')';
      }
      used.add(name);
      codeCount[d.code] = (codeCount[d.code] || 0) + 1;
      const code = d.code + String(codeCount[d.code] % 1000).padStart(3, '0');
      return { name, code };
    };

    // ------------------------------------------------------------------ stops
    // Exactly 5,103 bus stops across Singapore's road network
    const TARGET_STOPS = 5103;
    const byLane = new Map();
    const stopsList = [];
    const addStop = (edge, s, dir, name, force) => {
      const key = edge + ':' + dir;
      const lane = byLane.get(key) || [];
      s = net.clampS(edge, s);
      if (!force) {
        const near = lane.find((st) => Math.abs(st.s - s) < 220);
        if (near) return near;
      }
      if (stopsList.length >= TARGET_STOPS) return null;
      const nm = name ? { name, code: stopName({ edge, s, dir }).code } : stopName({ edge, s, dir });
      const id = 'S' + (stopsList.length + 1);
      const st = { id, code: nm.code, name: nm.name, edge, s, dir, kind: 'existing' };
      doc.stops[id] = st;
      stopsList.push(st);
      lane.push(st);
      byLane.set(key, lane);
      return st;
    };

    // ------------------------------------------------------------------ interchanges
    // One per town, on the road nearest its centre
    const posNear = (p, maxD = 900) => {
      const n = net.nearest(p, maxD);
      if (!n) return null;
      const e = edges[n.edge];
      return { edge: n.edge, s: net.clampS(n.edge, n.s), dir: rnd() < 0.5 ? 1 : -1, len: e.len };
    };
    const townStops = new Map();
    for (const d of city.districts) {
      const pos = posNear(d, 1500);
      if (!pos) continue;
      const st = addStop(pos.edge, pos.s, pos.dir, `${d.short} Int`);
      if (st) {
        st.isInterchange = true;
        st.interchangeName = `${d.name} Bus Interchange`;
        st.districtId = d.id;
        doc.interchanges[d.id] = {
          id: d.id,
          stopId: st.id,
          name: `${d.name} Bus Interchange`,
          shortName: `${d.short} Int`,
          districtId: d.id,
          x: d.x,
          y: d.y,
          edge: pos.edge,
        };
        townStops.set(d.name, st);
        townStops.set(d.short, st);
      }
    }

    // ------------------------------------------------------------------ Spider Web Corridors
    // The roads of a loop through these positions, back to the first; null if any stretch has no road
    const loopPath = (positions) => {
      const segs = [];
      let length = 0;
      for (let i = 0; i < positions.length; i++) {
        const a = positions[i], b = positions[(i + 1) % positions.length];
        const leg = net.route(a, b, { closed: null });
        if (!leg.ok) return null;
        segs.push(...leg.segs);
        length += leg.length;
      }
      return { segs, length };
    };

    // Stops along a loop's roads every 450-650 m, starting and ending at its interchange
    const stopsAlong = (path, terminal) => {
      const chain = [terminal];
      let acc = 0, next = rnd.range(450, 650);
      for (const sg of path.segs) {
        const span = Math.abs(sg.s1 - sg.s0);
        while (next <= acc + span) {
          const s = sg.s0 + Math.sign(sg.s1 - sg.s0 || 1) * (next - acc);
          const st = addStop(sg.edge, s, sg.dir);
          if (st && chain[chain.length - 1] !== st && st !== terminal) {
            const prev = chain[chain.length - 1];
            const pPrev = net.posPoint(prev, 0.78);
            const pCur = net.posPoint(st, 0.78);
            if (Math.hypot(pCur.x - pPrev.x, pCur.y - pPrev.y) >= 280) {
              chain.push(st);
            }
          }
          next += rnd.range(450, 650);
        }
        acc += span;
      }
      const last = chain[chain.length - 1];
      if (last !== terminal) {
        const pLast = net.posPoint(last, 0.78);
        const pTerm = net.posPoint(terminal, 0.78);
        if (Math.hypot(pLast.x - pTerm.x, pLast.y - pTerm.y) < 280 && chain.length > 2) {
          chain.pop();
        }
      }
      chain.push(terminal);
      return chain;
    };

    // Spider-Web Network: Radial Spokes radiating from Downtown/Central Core + Concentric Orbital Rings
    const spiderCorridors = [
      // Radial Spoke 1: West Radial Trunk (Downtown -> Jurong -> Boon Lay)
      { num: '174', name: 'West Radial Trunk', way: ['Downtown Core', 'Queenstown', 'Clementi', 'Jurong East', 'Jurong West', 'Clementi', 'Downtown Core'] },
      // Radial Spoke 2: North-West Radial Trunk (Downtown -> Bukit Timah -> Choa Chu Kang)
      { num: '190', name: 'North-West Radial Trunk', way: ['Downtown Core', 'Orchard', 'Bukit Timah', 'Bukit Batok', 'Choa Chu Kang', 'Bukit Panjang', 'Bukit Timah', 'Downtown Core'] },
      // Radial Spoke 3: North Radial Trunk (Downtown -> Bishan -> Woodlands)
      { num: '851', name: 'North Radial Trunk', way: ['Downtown Core', 'Bishan', 'Ang Mo Kio', 'Yishun', 'Woodlands', 'Sembawang', 'Yishun', 'Ang Mo Kio', 'Downtown Core'] },
      // Radial Spoke 4: North-East Radial Trunk (Downtown -> Serangoon -> Punggol)
      { num: '147', name: 'North-East Radial Trunk', way: ['Downtown Core', 'Toa Payoh', 'Serangoon', 'Hougang', 'Sengkang', 'Punggol', 'Hougang', 'Downtown Core'] },
      // Radial Spoke 5: East Radial Trunk (Downtown -> Bedok -> Pasir Ris)
      { num: '12', name: 'East Radial Trunk', way: ['Downtown Core', 'Kallang', 'Geylang', 'Bedok', 'Tampines', 'Pasir Ris', 'Bedok', 'Downtown Core'] },
      // Radial Spoke 6: Coastal Radial Trunk (Downtown -> Marine Parade -> Changi)
      { num: '36', name: 'Coastal Radial Trunk', way: ['Downtown Core', 'Marine Parade', 'Bedok', 'Changi', 'Loyang', 'Tampines', 'Marine Parade', 'Downtown Core'] },
      // Web Ring 1: Inner Central Web Ring (Downtown -> Toa Payoh -> Bishan -> Bukit Timah -> Queenstown)
      { num: '65', name: 'Inner Circle Web Ring', way: ['Downtown Core', 'Kallang', 'Toa Payoh', 'Bishan', 'Bukit Timah', 'Queenstown', 'Tanjong Pagar', 'Downtown Core'] },
      // Web Ring 2: Mid-Island Orbital Ring
      { num: '51', name: 'Mid-Island Orbital Ring', way: ['Clementi', 'Bukit Batok', 'Bukit Panjang', 'Ang Mo Kio', 'Serangoon', 'Paya Lebar', 'Bedok', 'Marine Parade', 'Clementi'] },
      // Web Ring 3: Outer Perimeter Web Ring
      { num: '168', name: 'Outer Island Web Ring', way: ['Jurong East', 'Choa Chu Kang', 'Woodlands', 'Yishun', 'Punggol', 'Pasir Ris', 'Tampines', 'Bedok', 'Jurong East'] },
      // Web Ring 4: Cross-Island Diagonal Spine
      { num: '67', name: 'Cross-Island Diagonal Spine', way: ['Choa Chu Kang', 'Bukit Panjang', 'Bukit Timah', 'Novena', 'Toa Payoh', 'Kallang', 'Geylang', 'Bedok', 'Tampines', 'Bedok', 'Geylang', 'Kallang', 'Novena', 'Bukit Timah', 'Choa Chu Kang'] }
    ];

    spiderCorridors.forEach((sc, i) => {
      const positions = sc.way.map((w) => {
        const st = townStops.get(w);
        return { edge: st.edge, s: st.s, dir: st.dir };
      });
      const path = loopPath(positions);
      if (!path) return;
      const termSt = townStops.get(sc.way[0]);
      const chain = stopsAlong(path, termSt);
      const id = 'R' + (i + 1);
      const num = sc.num;
      const loopMin = (path.length / 5.3 + chain.length * 25) / 60;
      const headway = rnd.range(8, 12);
      doc.routes[id] = {
        id,
        number: num,
        name: `Bus ${num} (${termSt.name} ➔ ${termSt.name})`,
        color: serviceColor(i),
        kind: 'existing',
        baseId: null,
        override: false,
        hours: B.defaultBusHours(num),
        fleet: Math.max(2, Math.ceil((loopMin + 6) / headway)),
        anchors: chain.map((s) => ({ t: 'stop', id: s.id })),
      };
    });

    // ------------------------------------------------------------------ Distribute Remaining Stops
    // Evenly distribute remaining stops across the entire Singapore road network (North, South, East, West, Central)
    // until reaching exactly 5,103 stops — shuffle edges deterministically so stops never clump in one region
    const shuffledEdges = edges.filter((e) => e && e.len >= 60);
    for (let i = shuffledEdges.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = shuffledEdges[i];
      shuffledEdges[i] = shuffledEdges[j];
      shuffledEdges[j] = tmp;
    }

    // Pass 0: spread 1 stop per road across the entire island first for uniform geographic coverage
    for (let ei = 0; ei < shuffledEdges.length && stopsList.length < TARGET_STOPS; ei++) {
      const e = shuffledEdges[ei];
      if (e.len < 90) continue;
      const s = net.clampS(e.id, e.len * rnd.range(0.32, 0.68));
      addStop(e.id, s, rnd() < 0.5 ? 1 : -1);
    }

    // Additional passes (if needed): add opposite-side / secondary stops evenly across all shuffled edges
    for (let pass = 0; pass < 3 && stopsList.length < TARGET_STOPS; pass++) {
      const stepFrac = pass === 0 ? 0.5 : (pass === 1 ? 0.28 : 0.72);
      for (let ei = 0; ei < shuffledEdges.length && stopsList.length < TARGET_STOPS; ei++) {
        const e = shuffledEdges[ei];
        if (e.len < 90) continue;
        const s = e.len * stepFrac;
        addStop(e.id, s, 1);
        if (stopsList.length < TARGET_STOPS && e.len > 160) {
          addStop(e.id, s, -1);
        }
      }
    }

    let fallbackLoop = 0;
    while (stopsList.length < TARGET_STOPS && fallbackLoop < 20000) {
      fallbackLoop++;
      const e = shuffledEdges[Math.floor(rnd() * shuffledEdges.length)];
      if (e && e.len > 40) {
        addStop(e.id, net.clampS(e.id, rnd.range(10, e.len - 10)), rnd() < 0.5 ? 1 : -1, null, true);
      }
    }

    const routes = Object.values(doc.routes);
    doc.seq = stopsList.length + routes.length + 4;
    return doc;
  };

  /**
   * Adds count new bus routes (each a short chain of nearby stops), each with its own number and colour.
   */
  B.generateRandomRoutes = function (city, net, doc, count = 6, specificNumbers = null) {
    const stopsList = Object.values(doc.stops);
    if (!stopsList.length) return [];
    const usedNums = new Set(Object.values(doc.routes).map((r) => String(r.number).trim()));
    const chosen = specificNumbers ? specificNumbers.slice() : [];
    for (let n = 2; chosen.length < count && n < 1000; n++) if (!usedNums.has(String(n)) && !chosen.includes(String(n))) chosen.push(String(n));

    // Nearest stops by straight line first, then by road, up to 10 stops
    const findStopChain = (start, chainLen) => {
      const chain = [start];
      let cur = start;
      for (let step = 0; step < chainLen - 1; step++) {
        const a = net.posPoint(cur, 0.78);
        const near = stopsList
          .filter((c) => !chain.includes(c))
          .map((c) => { const b = net.posPoint(c, 0.78); return { c, d: Math.hypot(a.x - b.x, a.y - b.y) }; })
          .filter((x) => x.d >= 280 && x.d <= 800)
          .sort((x, y) => x.d - y.d)
          .slice(0, 8);
        let best = null;
        for (const { c } of near) {
          const leg = net.route(cur, c, { closed: null });
          if (leg.ok && (!best || leg.length < best.len)) best = { c, len: leg.length };
        }
        if (!best) break;
        chain.push(best.c);
        cur = best.c;
      }
      return chain;
    };

    const created = [];
    for (let i = 0; i < count; i++) {
      let chain = [];
      for (let attempt = 0; attempt < 8 && chain.length < 3; attempt++) {
        chain = findStopChain(stopsList[Math.floor(Math.random() * stopsList.length)], 10);
      }
      if (chain.length < 2) continue;
      const id = 'R' + (Object.keys(doc.routes).length + 1);
      const num = chosen[i] || String(Math.floor(Math.random() * 80 + 20));
      const r = {
        id,
        number: num,
        name: `Bus ${num} (${chain[0].name} ➔ ${chain[chain.length - 1].name})`,
        color: B.pickRouteColor(Object.values(doc.routes).map((x) => x.color)),
        kind: 'existing',
        baseId: null,
        override: false,
        hours: B.defaultBusHours(num),
        anchors: chain.map((s) => ({ t: 'stop', id: s.id })),
      };
      doc.routes[id] = r;
      created.push(r);
    }
    return created;
  };
})();
