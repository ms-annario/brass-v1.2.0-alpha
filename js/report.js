/* BRASS — Change report: a PDF comparing a project draft with the Current Map.
 * Page 1 shows both maps side by side, framed on what changed (changed buses in full colour,
 * everything else faded). The pages after it list every change. Pages are drawn on a canvas and
 * written as a small image-based PDF, so no PDF library is needed.
 */
(function () {
  const B = window.B;

  // A4 landscape, drawn at 2x (the PDF page is 842 x 595 pt)
  const PAGE_W = 1684, PAGE_H = 1190, M = 64;
  const PDF_W = 842, PDF_H = 595;
  const FONT = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
  const COLORS = { add: '#16a34a', del: '#dc2626', mod: '#d97706', close: '#dc2626', reopen: '#2563eb' };

  // Route geometry for any doc, from a throwaway calculator (no storage, no events)
  function geometryOf(store, doc) {
    const calc = Object.create(B.Store.prototype);
    Object.assign(calc, { city: store.city, net: store.net, doc, legCache: store.legCache });
    calc.derive();
    return calc;
  }

  // What differs between the Current Map (base) and the draft (proj)
  function diffDocs(c, base, proj) {
    const groupsOf = (doc) => new Map(c._busGroups(Object.values(doc.routes || {})).map((g) => [g.number, g]));
    const gb = groupsOf(base), gp = groupsOf(proj);
    const signature = (doc, g) => JSON.stringify([g.routes.map((r) => JSON.stringify(r.anchors)).sort(), B.busHours(doc, g.number), B.busModel(doc, g.number), B.busDays(doc, g.number), B.busActive(doc, g.number), B.busFleetSet(doc, g.number)]);
    const changedBuses = [...gp.keys()].filter((n) => gb.has(n) && signature(base, gb.get(n)) !== signature(proj, gp.get(n)));
    const bs = base.stops || {}, ps = proj.stops || {};
    const bc = base.closures || {}, pc = proj.closures || {};
    const ba = base.areas || {}, pa = proj.areas || {};
    return {
      addedBuses: new Set([...gp.keys()].filter((n) => !gb.has(n))),
      removedBuses: new Set([...gb.keys()].filter((n) => !gp.has(n))),
      changedBuses: new Set(changedBuses),
      // (another project's new stop, only shown in this one, isn't this project's)
      addedStops: new Set(Object.keys(ps).filter((id) => !bs[id] && !(ps[id] && ps[id].fromProject))),
      removedStops: new Set(Object.keys(bs).filter((id) => !ps[id])),
      movedStops: new Set(Object.keys(ps).filter((id) => bs[id] && (bs[id].edge !== ps[id].edge || Math.abs((bs[id].s || 0) - (ps[id].s || 0)) > 1))),
      addedClosures: Object.keys(pc).filter((id) => !bc[id]),
      removedClosures: Object.keys(bc).filter((id) => !pc[id]),
      addedAreas: Object.keys(pa).filter((id) => !ba[id]),
      removedAreas: Object.keys(ba).filter((id) => !pa[id]),
    };
  }

  // The part of the map both pages frame: everything that changed, or the whole island
  function changeBounds(city, before, after, d) {
    const pts = [];
    const routePts = (calc, doc, numbers) => {
      for (const r of Object.values(doc.routes || {})) {
        if (!numbers.has(String(r.number).trim())) continue;
        const g = calc.geom[r.id];
        if (g) for (const l of g.legs) if (l.pts) pts.push(...l.pts);
      }
    };
    routePts(before.calc, before.doc, new Set([...d.removedBuses, ...d.changedBuses]));
    routePts(after.calc, after.doc, new Set([...d.addedBuses, ...d.changedBuses]));
    const stopPt = (side, id) => { const s = side.doc.stops[id]; if (s) pts.push(side.calc.net.posPoint(s, 0.78)); };
    d.removedStops.forEach((id) => stopPt(before, id));
    [...d.addedStops, ...d.movedStops].forEach((id) => stopPt(after, id));
    [...d.addedClosures, ...d.removedClosures].forEach((id) => { const e = city.edges[id]; if (e) pts.push(...e.pts); });
    d.addedAreas.forEach((id) => pts.push(...after.calc.areaPoly(after.doc.areas[id])));
    d.removedAreas.forEach((id) => pts.push(...before.calc.areaPoly(before.doc.areas[id])));
    if (!pts.length) return { ...city.bounds };
    const bb = B.bbox(pts);
    const pad = Math.max(150, 0.08 * Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0));
    return { x0: bb.x0 - pad, y0: bb.y0 - pad, x1: bb.x1 + pad, y1: bb.y1 + pad };
  }

  // World box to a panel, keeping the aspect ratio and filling the panel
  function fitTo(bbox, rect) {
    let { x0, y0, x1, y1 } = bbox;
    const want = rect.w / rect.h;
    if ((x1 - x0) / (y1 - y0) < want) {
      const grow = ((y1 - y0) * want - (x1 - x0)) / 2; x0 -= grow; x1 += grow;
    } else {
      const grow = ((x1 - x0) / want - (y1 - y0)) / 2; y0 -= grow; y1 += grow;
    }
    const s = rect.w / (x1 - x0);
    return { s, X: (x) => rect.x + (x - x0) * s, Y: (y) => rect.y + (y - y0) * s };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // One map panel: land, roads, areas, closures, buses (changed ones bright), and the stops that changed
  function drawMap(ctx, rect, city, side, d, bbox, which) {
    const t = fitTo(bbox, rect);
    const path = (pts, close) => {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(t.X(p.x), t.Y(p.y)) : ctx.moveTo(t.X(p.x), t.Y(p.y))));
      if (close) ctx.closePath();
    };
    ctx.save();
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 14);
    ctx.clip();
    ctx.fillStyle = '#cfe3f3';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

    ctx.fillStyle = '#f3f1ea';
    path(city.coast, true); ctx.fill();
    for (const i of city.islets || []) { path(i.poly, true); ctx.fill(); }
    ctx.fillStyle = '#dcebd5';
    for (const p of city.parks || []) { path(p.poly, true); ctx.fill(); }
    ctx.fillStyle = '#cfe3f3';
    for (const l of city.lakes || []) { path(l.poly, true); ctx.fill(); }
    ctx.strokeStyle = '#cfe3f3';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const r of city.rivers || []) { ctx.lineWidth = Math.max(2, r.hw * 2 * t.s); path(r.pts, false); ctx.stroke(); }

    ctx.strokeStyle = '#d5dae2';
    for (const e of city.edges) { ctx.lineWidth = Math.max(1, (e.cls === 'major' ? 12 : 7) * t.s); path(e.pts, false); ctx.stroke(); }

    // Affected areas and closures on this map
    for (const a of Object.values(side.doc.areas || {})) {
      path(side.calc.areaPoly(a), true);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.14)'; ctx.fill();
      ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.strokeStyle = '#dc2626';
    for (const id of Object.keys(side.doc.closures || {})) {
      const e = city.edges[id]; if (!e) continue;
      ctx.lineWidth = Math.max(4, 11 * t.s); path(e.pts, false); ctx.stroke();
    }

    // Buses: the ones that changed on this side in full colour, the rest faded
    const bright = which === 'before'
      ? new Set([...d.removedBuses, ...d.changedBuses])
      : new Set([...d.addedBuses, ...d.changedBuses]);
    const routes = Object.values(side.doc.routes || {}).sort((a, b) => bright.has(String(a.number).trim()) - bright.has(String(b.number).trim()));
    const labels = [];
    for (const r of routes) {
      const g = side.calc.geom[r.id];
      if (!g) continue;
      const num = String(r.number).trim();
      const on = bright.has(num);
      ctx.globalAlpha = on ? 1 : 0.16;
      ctx.strokeStyle = r.color || '#2563eb';
      ctx.lineWidth = on ? 6 : 4;
      for (const l of g.legs) { if (l.ok && l.pts && l.pts.length > 1) { path(l.pts, false); ctx.stroke(); } }
      if (on) {
        const all = g.legs.flatMap((l) => l.pts || []);
        if (all.length) labels.push({ num, color: r.color || '#2563eb', p: all[Math.floor(all.length / 2)] });
      }
    }
    ctx.globalAlpha = 1;

    // Only the stops that changed: added (green) and moved (amber) on the draft, removed (red) on the Current Map
    const dot = (p, fill, r, ring) => {
      ctx.beginPath(); ctx.arc(t.X(p.x), t.Y(p.y), r, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill();
      if (ring) { ctx.lineWidth = 2.5; ctx.strokeStyle = ring; ctx.stroke(); }
    };
    const marks = which === 'after'
      ? [[d.addedStops, COLORS.add], [d.movedStops, COLORS.mod]]
      : [[d.removedStops, COLORS.del]];
    for (const [ids, color] of marks) {
      for (const id of ids) {
        const s = side.doc.stops[id];
        if (s) dot(side.calc.net.posPoint(s, 0.78), color, 7, '#ffffff');
      }
    }

    // Bus numbers on the changed lines
    ctx.font = `800 18px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const lb of labels) {
      const x = t.X(lb.p.x), y = t.Y(lb.p.y);
      const w = ctx.measureText(lb.num).width + 16;
      roundRect(ctx, x - w / 2, y - 14, w, 28, 6);
      ctx.fillStyle = lb.color; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff'; ctx.stroke();
      ctx.fillStyle = '#ffffff'; ctx.fillText(lb.num, x, y + 1);
    }
    ctx.restore();

    ctx.save();
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 14);
    ctx.lineWidth = 2; ctx.strokeStyle = '#cbd5e1'; ctx.stroke();
    ctx.restore();
  }

  function newPage() {
    const canvas = document.createElement('canvas');
    canvas.width = PAGE_W; canvas.height = PAGE_H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    return { canvas, ctx };
  }

  function header(ctx, title, subtitle) {
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#0f172a';
    ctx.font = `800 40px ${FONT}`;
    ctx.fillText(title, M, M + 34);
    ctx.fillStyle = '#64748b';
    ctx.font = `500 21px ${FONT}`;
    ctx.fillText(subtitle, M, M + 72);
  }

  function footer(ctx, page, pages) {
    ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#94a3b8';
    ctx.font = `500 18px ${FONT}`;
    ctx.fillText(`BRASS · Page ${page} of ${pages}`, PAGE_W - M, PAGE_H - 36);
  }

  // Summary chips: "+20 buses", "−6 buses", ...
  function summaryChips(ctx, d, x, y) {
    const chips = [
      [d.addedBuses.size, 'bus added', 'buses added', COLORS.add],
      [d.removedBuses.size, 'bus removed', 'buses removed', COLORS.del],
      [d.changedBuses.size, 'bus changed', 'buses changed', COLORS.mod],
      [d.addedStops.size, 'stop added', 'stops added', COLORS.add],
      [d.removedStops.size, 'stop removed', 'stops removed', COLORS.del],
      [d.movedStops.size, 'stop moved', 'stops moved', COLORS.mod],
      [d.addedClosures.length, 'road closed', 'roads closed', COLORS.close],
      [d.removedClosures.length, 'road reopened', 'roads reopened', COLORS.reopen],
      [d.addedAreas.length, 'area added', 'areas added', COLORS.del],
      [d.removedAreas.length, 'area removed', 'areas removed', COLORS.reopen],
    ].filter(([n]) => n > 0);
    ctx.font = `700 20px ${FONT}`;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    if (!chips.length) {
      ctx.fillStyle = '#64748b';
      ctx.fillText('No differences from the Current Map', x, y + 18);
      return;
    }
    for (const [n, one, many, color] of chips) {
      const text = `${n} ${n === 1 ? one : many}`;
      const w = ctx.measureText(text).width + 28;
      roundRect(ctx, x, y, w, 36, 8);
      ctx.fillStyle = '#f8fafc'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke();
      ctx.fillStyle = color; ctx.fillText(text, x + 14, y + 19);
      x += w + 10;
    }
  }

  function legend(ctx, x, y) {
    const items = [
      ['line', '#2563eb', 1, 'Changed bus (full colour)'],
      ['line', '#2563eb', 0.16, 'Unchanged bus'],
      ['line', '#dc2626', 1, 'Road closure'],
      ['area', '#ef4444', 1, 'Affected area'],
      ['dot', COLORS.add, 1, 'Stop added'],
      ['dot', COLORS.mod, 1, 'Stop moved'],
      ['dot', COLORS.del, 1, 'Stop removed'],
    ];
    ctx.font = `600 18px ${FONT}`;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    for (const [kind, color, alpha, label] of items) {
      ctx.globalAlpha = alpha;
      if (kind === 'line') {
        ctx.strokeStyle = color; ctx.lineWidth = 6; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 34, y); ctx.stroke();
      } else if (kind === 'area') {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.14)'; ctx.fillRect(x, y - 11, 34, 22);
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.strokeRect(x, y - 11, 34, 22);
      } else {
        ctx.beginPath(); ctx.arc(x + 17, y, 8, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#334155';
      ctx.fillText(label, x + 44, y + 1);
      x += 44 + ctx.measureText(label).width + 30;
    }
  }

  // Pages after the maps: every change, one line each, two columns
  function changePages(lines, title, subtitle) {
    const PER_COL = 26, LINE = 34;
    const perPage = PER_COL * 2;
    const pages = [];
    const glyph = { add: '+', del: '−', mod: '~', close: '■', reopen: '□' };
    for (let i = 0; i < Math.max(1, lines.length); i += perPage) {
      const { canvas, ctx } = newPage();
      header(ctx, title, subtitle);
      ctx.fillStyle = '#0f172a';
      ctx.font = `800 24px ${FONT}`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(`Changes (${lines.length})`, M, M + 130);
      const chunk = lines.slice(i, i + perPage);
      if (!chunk.length) {
        ctx.fillStyle = '#64748b'; ctx.font = `500 20px ${FONT}`;
        ctx.fillText('No differences from the Current Map', M, M + 180);
      }
      const colW = (PAGE_W - M * 2) / 2;
      chunk.forEach((ch, k) => {
        const col = Math.floor(k / PER_COL), row = k % PER_COL;
        const x = M + col * colW, y = M + 180 + row * LINE;
        ctx.font = `800 22px ${FONT}`;
        ctx.fillStyle = COLORS[ch.action] || '#64748b';
        ctx.fillText(glyph[ch.action] || '•', x, y);
        ctx.font = `500 20px ${FONT}`;
        ctx.fillStyle = '#1e293b';
        let text = ch.text;
        while (ctx.measureText(text).width > colW - 60 && text.length > 4) text = text.slice(0, -2);
        if (text !== ch.text) text = text.trimEnd() + '…';
        ctx.fillText(text, x + 30, y);
      });
      pages.push({ canvas, ctx });
    }
    return pages;
  }

  // A minimal PDF: one JPEG filling each page (A4 landscape unless a page size in pt is given)
  function buildPdf(images, pageW = PDF_W, pageH = PDF_H) {
    const enc = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let offset = 0;
    const push = (data) => {
      const bytes = typeof data === 'string' ? enc.encode(data) : data;
      chunks.push(bytes);
      offset += bytes.length;
    };
    const obj = (n, write) => { offsets[n] = offset; push(`${n} 0 obj\n`); write(); push('\nendobj\n'); };

    push('%PDF-1.4\n%âãÏÓ\n');
    const kids = images.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
    obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => push(`<< /Type /Pages /Kids [${kids}] /Count ${images.length} >>`));
    images.forEach((img, i) => {
      const pageN = 3 + i * 3, contentN = pageN + 1, imageN = pageN + 2;
      obj(pageN, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im${i} ${imageN} 0 R >> >> /Contents ${contentN} 0 R >>`));
      const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im${i} Do Q`;
      obj(contentN, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
      obj(imageN, () => {
        push(`<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpeg.length} >>\nstream\n`);
        push(img.jpeg);
        push('\nendstream');
      });
    });
    const xref = offset;
    const size = 3 + images.length * 3;
    push(`xref\n0 ${size}\n0000000000 65535 f \n`);
    for (let n = 1; n < size; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
    push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
    return new Blob(chunks, { type: 'application/pdf' });
  }

  function jpegOf(canvas) {
    const b64 = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { jpeg: bytes, w: canvas.width, h: canvas.height };
  }

  // Builds the report for a project draft; returns { blob, filename, canvases }
  B.buildChangeReport = async function (c, projectId) {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const project = c.projects.find((p) => p.id === projectId);
    const name = project ? project.name : 'Project';
    const baseDoc = c._loadProjectDraft('main');
    const projDoc = c.activeProjectId === projectId ? JSON.parse(JSON.stringify(c.store.doc)) : c._loadProjectDraft(projectId);
    const city = c.store.city;
    const before = { doc: baseDoc, calc: geometryOf(c.store, baseDoc) };
    const after = { doc: projDoc, calc: geometryOf(c.store, projDoc) };
    const d = diffDocs(c, baseDoc, projDoc);
    const lines = c._computeProjectChanges(baseDoc, projDoc);

    const when = new Date().toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const title = `Change report: ${name}`;
    const subtitle = `Compared with the Current Map · Prepared by John Doe · ${when}`;

    // Page 1: summary, both maps side by side, legend
    const first = newPage();
    header(first.ctx, title, subtitle);
    summaryChips(first.ctx, d, M, M + 100);
    const top = M + 190, gap = 40;
    const panelW = (PAGE_W - M * 2 - gap) / 2;
    const panelH = PAGE_H - top - 150;
    const bbox = changeBounds(city, before, after, d);
    const rects = [
      { x: M, y: top, w: panelW, h: panelH },
      { x: M + panelW + gap, y: top, w: panelW, h: panelH },
    ];
    first.ctx.fillStyle = '#0f172a';
    first.ctx.font = `800 24px ${FONT}`;
    first.ctx.textAlign = 'left'; first.ctx.textBaseline = 'alphabetic';
    first.ctx.fillText('Current Map', rects[0].x, top - 16);
    first.ctx.fillText(`${name} (proposed)`, rects[1].x, top - 16);
    drawMap(first.ctx, rects[0], city, before, d, bbox, 'before');
    drawMap(first.ctx, rects[1], city, after, d, bbox, 'after');
    legend(first.ctx, M, PAGE_H - 100);

    const pages = [first, ...changePages(lines, title, subtitle)];
    pages.forEach((p, i) => footer(p.ctx, i + 1, pages.length));

    const blob = buildPdf(pages.map((p) => jpegOf(p.canvas)));
    const filename = `${name.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Project'} - change report.pdf`;
    return { blob, filename, canvases: pages.map((p) => p.canvas) };
  };

  // The numbers the poster and slides share, from the same comparison the PDF uses
  function exportData(c, projectId) {
    const project = c.projects.find((p) => p.id === projectId);
    const name = project ? project.name : 'Project';
    const baseDoc = c._loadProjectDraft('main');
    const projDoc = c.activeProjectId === projectId ? JSON.parse(JSON.stringify(c.store.doc)) : c._loadProjectDraft(projectId);
    const city = c.store.city;
    const before = { doc: baseDoc, calc: geometryOf(c.store, baseDoc) };
    const after = { doc: projDoc, calc: geometryOf(c.store, projDoc) };
    const d = diffDocs(c, baseDoc, projDoc);
    const lines = c._computeProjectChanges(baseDoc, projDoc);
    const when = new Date().toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const stats = [
      ['Changes', lines.length, ''],
      ['Buses', d.addedBuses.size + d.changedBuses.size, `${d.addedBuses.size} added · ${d.removedBuses.size} removed · ${d.changedBuses.size} changed`],
      ['Stops', d.addedStops.size + d.removedStops.size + d.movedStops.size, `${d.addedStops.size} added · ${d.removedStops.size} removed · ${d.movedStops.size} moved`],
      ['Affected areas', d.addedClosures.length + d.addedAreas.length + d.removedClosures.length + d.removedAreas.length, `${d.addedClosures.length} roads closed · ${d.addedAreas.length} areas`],
    ];
    return { name, city, before, after, d, lines, when, stats };
  }
  const safeName = (n) => n.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Project';

  // ------------------------------------------------------------------ Poster
  // A bus notice in the "Temporary Route Diversion" layout: a title band with the project's name, the services
  // affected beside the date and time, the stops they skip (road, stop, code, services), a map of the diversion
  // with its legend, and customer care contacts. One A4 portrait page, saved as a PDF.

  // Contacts printed at the foot of the poster (edit to suit)
  const POSTER_CONTACTS = [
    ['Go-Ahead Singapore Customer Care', '6812 6469 (7.30am - 10.00pm daily)'],
    ['SBS Transit Customer Care', '1800 287 2727 (7.30am - 8.00pm daily)'],
    ['SMRT Customer Hotline', '1800 336 8900 (7.30am to 8.00pm daily)'],
    ['Tower Transit Singapore Customer Care', '1800 248 0950 (7.30am - 1.00am daily)'],
  ];
  // Optional logo for the strip above the title: put the image in assets/ and set its path here,
  // e.g. 'assets/poster-logo.png'. Empty shows a plain "Bus Service Notice" heading instead.
  const POSTER_LOGO = '';
  const PF = 'Arial, Helvetica, sans-serif';
  const PC = {
    teal: '#16858c', lime: '#a8d52f', limeSoft: '#d7edc1', indigo: '#2e3192', ink: '#111111',
    grey: '#4b5563', red: '#e3000f', stopRed: '#a50000', peach: '#fcd5b0', rowAlt: '#e8e8ec', rule: '#9ca3af',
  };
  // One colour per group of services that share a diversion (as on the printed notices)
  const GROUP_COLORS = ['#19e3a0', '#ff2fe0', '#2e3192', '#ff8a00', '#00a6ff', '#8b5cf6', '#e11d48', '#0f766e'];
  const LINES_SKIP = [
    ['These bus services will skip the following bus stops.', 40, 'normal'],
    ['临时路线改道。以下巴士路线将不停靠下列巴士站点。', 28, 'normal'],
    ['Lencongan Laluan Sementara. Perkhidmatan bas ini tidak akan berhenti di perhentian bas berikut.', 28, 'normal'],
    ['தற்காலிக பாதை மாற்றம். இந்த பேருந்து சேவைகள் பின்வரும் பேருந்து நிறுத்தங்களைத் தவிர்க்கும்.', 28, 'normal'],
  ];
  const MORE_INFO = ['For more information:', '欲知更多详情:', 'Untuk keterangan lanjut:', 'மேலும் விவரங்களுக்கு:'];

  const loadImage = (src) => new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  });
  const byNumber = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

  // Words wrapped to a width (a "word" here is anything between spaces)
  function wrapLines(ctx, text, maxW) {
    const words = String(text).split(' ');
    const lines = [];
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (line && ctx.measureText(next).width > maxW) { lines.push(line); line = w; } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }

  // "Sunday, 30 August 2026" / "10.00am to 8.30pm" (or a range across days, or a permanent change)
  function posterWhen(period) {
    const clock = (d) => {
      const h = d.getHours(), m = d.getMinutes();
      return `${h % 12 || 12}.${String(m).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}`;
    };
    const long = (d) => `${d.toLocaleDateString('en-GB', { weekday: 'long' })}, ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`;
    const short = (d) => `${d.toLocaleDateString('en-GB', { weekday: 'short' })}, ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    if (!period || period.mode !== 'scheduled' || !isFinite(period.start) || !isFinite(period.end)) {
      return ['Permanent change', 'Until further notice'];
    }
    const s = new Date(period.start), e = new Date(period.end);
    if (s.toDateString() === e.toDateString()) return [long(s), `${clock(s)} to ${clock(e)}`];
    return [`${short(s)}, ${clock(s)}`, `to ${short(e)}, ${clock(e)}`];
  }

  // What each affected bus does in this project, grouped by shared diversion, plus the stops they skip
  function posterData(c, projectId) {
    const base = exportData(c, projectId);
    const { before, after, d, city } = base;
    const project = c.projects.find((p) => p.id === projectId);
    const raw = project && c._readProjectPeriod ? c._readProjectPeriod(project) : { mode: 'permanent' };
    const period = raw.mode === 'scheduled' && project && project.applyPeriod
      ? { mode: 'scheduled', start: new Date(`${project.applyPeriod.startDate}T${project.applyPeriod.startTime}`).getTime(), end: new Date(`${project.applyPeriod.endDate}T${project.applyPeriod.endTime}`).getTime() }
      : raw;

    const routesOf = (doc, num) => Object.values(doc.routes || {}).filter((r) => String(r.number).trim() === num);
    const stopsOf = (routes) => new Set(routes.flatMap((r) => (r.anchors || []).filter((a) => a.t === 'stop').map((a) => a.id)));
    const edgesOf = (calc, routes) => {
      const s = new Set();
      for (const r of routes) {
        const g = calc.geom[r.id];
        for (const l of (g && g.legs) || []) for (const sg of l.segs || []) s.add(sg.edge);
      }
      return s;
    };

    const buses = [];
    for (const num of new Set([...d.changedBuses, ...d.removedBuses, ...d.addedBuses])) {
      const rb = routesOf(before.doc, num), ra = routesOf(after.doc, num);
      const onBefore = rb.length > 0 && B.busActive(before.doc, num) !== false;
      const onAfter = ra.length > 0 && B.busActive(after.doc, num) !== false;
      let kind;
      if (!ra.length) kind = 'withdrawn';
      else if (!rb.length) kind = 'new';
      else if (onBefore && !onAfter) kind = 'suspended';
      else if (ra.some((r) => r.curtailed) || ra.length > rb.length) kind = 'curtailed';
      else kind = 'diverted';
      const after1 = stopsOf(ra);
      const skipped = (kind === 'diverted' || kind === 'curtailed') ? [...stopsOf(rb)].filter((id) => !after1.has(id)) : [];
      const eb = edgesOf(before.calc, rb), ea = edgesOf(after.calc, ra);
      const changedEdges = kind === 'new' ? [...ea] : [...ea].filter((e) => !eb.has(e)).concat([...eb].filter((e) => !ea.has(e)));
      // Hours, fleet or model only: nothing to show on a street notice
      if (kind === 'diverted' && !skipped.length && !changedEdges.length) continue;
      const lastStop = ra.length === 1 ? (ra[0].anchors || []).filter((a) => a.t === 'stop').slice(-1)[0] : null;
      const towards = lastStop && after.doc.stops[lastStop.id] ? after.doc.stops[lastStop.id].name : '';
      buses.push({ num, kind, skipped, changedEdges, routes: ra, towards });
    }

    // Services that share the same diversion (same kind, same stops skipped, same changed roads) share a colour
    const groups = [];
    const byKey = new Map();
    for (const b of buses.filter((x) => x.kind !== 'suspended' && x.kind !== 'withdrawn').sort((x, y) => byNumber(x.num, y.num))) {
      const key = `${b.kind}|${b.skipped.slice().sort().join(',')}|${b.changedEdges.slice().sort((x, y) => x - y).join(',')}`;
      if (!byKey.has(key)) { byKey.set(key, { kind: b.kind, nums: [], routes: [], towards: new Set(), changedEdges: b.changedEdges }); groups.push(byKey.get(key)); }
      const g = byKey.get(key);
      g.nums.push(b.num); g.routes.push(...b.routes);
      if (b.towards) g.towards.add(b.towards);
    }
    groups.forEach((g, i) => { g.color = GROUP_COLORS[i % GROUP_COLORS.length]; });

    // The skipped stops, with the services that skip each, by road
    const skipMap = new Map();
    for (const b of buses) for (const id of b.skipped) {
      if (!skipMap.has(id)) skipMap.set(id, new Set());
      skipMap.get(id).add(b.num);
    }
    const rows = [...skipMap.entries()].map(([id, set]) => {
      const st = before.doc.stops[id] || {};
      const e = city.edges[st.edge];
      return { id, road: (e && e.name) || '—', name: st.name || id, code: st.code || '—', services: [...set].sort(byNumber), st };
    }).sort((a, b) => a.road.localeCompare(b.road) || a.name.localeCompare(b.name));

    const off = buses.filter((b) => b.kind === 'suspended' || b.kind === 'withdrawn').map((b) => b.num).sort(byNumber);
    const all = buses.map((b) => b.num).sort(byNumber);
    const kinds = new Set(buses.map((b) => b.kind));
    const prefix = period.mode === 'scheduled' ? 'TEMPORARY ' : '';
    let title = `${prefix}ROUTE DIVERSION`;
    if (buses.length && [...kinds].every((k) => k === 'suspended' || k === 'withdrawn')) title = `${prefix}SERVICE SUSPENSION`;
    else if (kinds.size === 1 && kinds.has('curtailed')) title = `${prefix}ROUTE CURTAILMENT`;
    else if (kinds.size === 1 && kinds.has('new')) title = 'NEW BUS SERVICE';
    else if (!buses.length) title = 'BUS SERVICE NOTICE';
    return { ...base, period, groups, rows, off, all, title };
  }

  // The part of the map to show: skipped stops, changed roads of each diversion, closures and areas
  function posterBounds(data) {
    const { city, before, after, groups, rows, d } = data;
    const pts = [];
    rows.forEach((r) => { if (r.st && r.st.edge != null) pts.push(before.calc.net.posPoint(r.st, 0.78)); });
    groups.forEach((g) => g.changedEdges.forEach((id) => { const e = city.edges[id]; if (e) pts.push(...e.pts); }));
    Object.keys(after.doc.closures || {}).forEach((id) => { const e = city.edges[id]; if (e) pts.push(...e.pts); });
    d.addedAreas.forEach((id) => pts.push(...after.calc.areaPoly(after.doc.areas[id])));
    if (!pts.length) return changeBounds(city, before, after, d);
    const bb = B.bbox(pts);
    const size = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0, 900);
    const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2, half = size * 0.62;
    return { x0: cx - half, y0: cy - half, x1: cx + half, y1: cy + half };
  }

  // The diversion map: a grey street map, closures in red, each group's route in its colour with direction
  // arrows, the skipped stops (⊗ with their codes) and peach labels on the roads that matter
  function drawPosterMap(ctx, rect, data, bbox) {
    const { city, before, after, groups, rows } = data;
    const t = fitTo(bbox, rect);
    const sx = (p) => t.X(p.x), sy = (p) => t.Y(p.y);
    const path = (pts, close) => {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(sx(p), sy(p)) : ctx.moveTo(sx(p), sy(p))));
      if (close) ctx.closePath();
    };
    ctx.save();
    ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();
    ctx.fillStyle = '#d5dbe1'; ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.fillStyle = '#eeeeee'; path(city.coast, true); ctx.fill();
    for (const i of city.islets || []) { path(i.poly, true); ctx.fill(); }
    ctx.fillStyle = '#e0e6dc'; for (const p of city.parks || []) { path(p.poly, true); ctx.fill(); }
    ctx.fillStyle = '#d5dbe1'; for (const l of city.lakes || []) { path(l.poly, true); ctx.fill(); }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = '#d5dbe1';
    for (const r of city.rivers || []) { ctx.lineWidth = Math.max(2, r.hw * 2 * t.s); path(r.pts, false); ctx.stroke(); }
    for (const pass of [['#c8c8c8', 5], ['#ffffff', 0]]) {
      ctx.strokeStyle = pass[0];
      for (const e of city.edges) { ctx.lineWidth = Math.max(1, (e.cls === 'major' ? 13 : 8) * t.s) + pass[1]; path(e.pts, false); ctx.stroke(); }
    }

    for (const a of Object.values(after.doc.areas || {})) {
      path(after.calc.areaPoly(a), true);
      ctx.fillStyle = 'rgba(227, 0, 15, 0.08)'; ctx.fill();
      ctx.strokeStyle = PC.red; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.strokeStyle = PC.red;
    for (const id of Object.keys(after.doc.closures || {})) {
      const e = city.edges[id]; if (!e) continue;
      ctx.lineWidth = Math.max(9, 18 * t.s); path(e.pts, false); ctx.stroke();
    }

    // Each group's route: a white halo, then its colour; arrows show the direction of travel
    const arrow = (x, y, ang, color) => {
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-10, -12); ctx.lineTo(-10, 12); ctx.closePath();
      ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.stroke();
      ctx.restore();
    };
    const inside = (x, y) => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
    groups.slice().reverse().forEach((g) => {
      for (const pass of [['#ffffff', 16], [g.color, 9]]) {
        ctx.strokeStyle = pass[0]; ctx.lineWidth = pass[1];
        for (const r of g.routes) {
          const geom = after.calc.geom[r.id];
          for (const l of (geom && geom.legs) || []) if (l.ok && l.pts && l.pts.length > 1) { path(l.pts, false); ctx.stroke(); }
        }
      }
      // Arrows along the longest stretch of this group's route that's on the map
      const r0 = g.routes[0], geom = r0 && after.calc.geom[r0.id];
      const pts = ((geom && geom.legs) || []).flatMap((l) => (l.ok && l.pts) || []).map((p) => ({ x: sx(p), y: sy(p) }));
      let best = [], run = [];
      for (const p of pts) { if (inside(p.x, p.y)) run.push(p); else { if (run.length > best.length) best = run; run = []; } }
      if (run.length > best.length) best = run;
      if (best.length > 2) {
        const segs = []; let total = 0;
        for (let i = 1; i < best.length; i++) { const l = Math.hypot(best[i].x - best[i - 1].x, best[i].y - best[i - 1].y); segs.push(l); total += l; }
        for (const f of [0.35, 0.8]) {
          let acc = 0;
          for (let i = 1; i < best.length; i++) {
            if (acc + segs[i - 1] >= total * f && segs[i - 1] > 0) {
              const k = (total * f - acc) / segs[i - 1];
              const a = best[i - 1], b = best[i];
              arrow(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, Math.atan2(b.y - a.y, b.x - a.x), g.color);
              break;
            }
            acc += segs[i - 1];
          }
        }
      }
    });

    // Peach labels on the roads that matter: closed, skipped-stop and diversion roads
    const placed = [];
    const free = (b) => !placed.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y);
    const stopPts = rows.map((r) => (r.st && r.st.edge != null ? before.calc.net.posPoint(r.st, 0.78) : null)).filter(Boolean)
      .map((p) => ({ x: sx(p), y: sy(p) }));
    stopPts.forEach((p) => placed.push({ x: p.x - 24, y: p.y - 24, w: 48, h: 48 }));
    const roadIds = [
      ...Object.keys(after.doc.closures || {}).map(Number),
      ...rows.map((r) => r.st && r.st.edge).filter((e) => e != null),
      ...groups.flatMap((g) => g.changedEdges),
    ];
    const seen = new Set();
    ctx.font = `700 26px ${PF}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let labels = 0;
    for (const id of roadIds) {
      if (labels >= 8) break;
      const e = city.edges[id];
      if (!e || !e.name || seen.has(e.name) || !e.pts || !e.pts.length) continue;
      const mid = e.pts[Math.floor(e.pts.length / 2)];
      const x = sx(mid), y = sy(mid);
      if (!inside(x, y)) continue;
      const w = ctx.measureText(e.name).width + 28, h = 40;
      const spot = [[0, -44], [0, 44], [w / 2 + 20, 0], [-w / 2 - 20, 0]]
        .map(([dx, dy]) => ({ x: x + dx - w / 2, y: y + dy - h / 2, w, h }))
        .find((b) => free(b) && b.x > rect.x + 4 && b.x + b.w < rect.x + rect.w - 4 && b.y > rect.y + 4 && b.y + b.h < rect.y + rect.h - 4);
      if (!spot) continue;
      seen.add(e.name); placed.push(spot); labels++;
      roundRect(ctx, spot.x, spot.y, spot.w, spot.h, 6);
      ctx.fillStyle = PC.peach; ctx.fill();
      ctx.fillStyle = PC.ink; ctx.fillText(e.name, spot.x + spot.w / 2, spot.y + spot.h / 2 + 1);
    }

    // Skipped stops: ⊗, and the stop code in a dark red tag wherever it fits without covering another label
    // (rows come in table order, so the stops listed in the table get their tags first). A stop sitting right
    // next to one already marked shares its ⊗, so a long run of skipped stops stays readable.
    const marked = [];
    rows.forEach((r) => {
      if (!r.st || r.st.edge == null) return;
      const p = before.calc.net.posPoint(r.st, 0.78);
      const x = sx(p), y = sy(p);
      if (!inside(x, y) || marked.some((q) => Math.hypot(q.x - x, q.y - y) < 26)) return;
      marked.push({ x, y });
      ctx.beginPath(); ctx.arc(x, y, 17, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = PC.red; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 8, y - 8); ctx.lineTo(x + 8, y + 8); ctx.moveTo(x + 8, y - 8); ctx.lineTo(x - 8, y + 8);
      ctx.lineWidth = 4; ctx.stroke();
      ctx.font = `700 28px ${PF}`;
      const w = ctx.measureText(r.code).width + 24, h = 42;
      const tag = [[22, -70], [-22 - w, -70], [22, 28], [-22 - w, 28]]
        .map(([dx, dy]) => ({ x: x + dx, y: y + dy, w, h }))
        .find((b) => free(b) && b.x > rect.x + 4 && b.x + b.w < rect.x + rect.w - 4 && b.y > rect.y + 4 && b.y + b.h < rect.y + rect.h - 4);
      if (!tag) return;
      placed.push(tag);
      roundRect(ctx, tag.x, tag.y, tag.w, tag.h, 5);
      ctx.fillStyle = PC.stopRed; ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.fillText(r.code, tag.x + tag.w / 2, tag.y + tag.h / 2 + 1);
    });
    ctx.restore();
    ctx.save(); ctx.lineWidth = 2; ctx.strokeStyle = PC.rule; ctx.strokeRect(rect.x, rect.y, rect.w, rect.h); ctx.restore();
  }

  B.buildPoster = async function (c, projectId) {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const data = posterData(c, projectId);
    const { name, groups, rows, off, all, title, period } = data;
    const W = 1684, H = 2382, FOOT = 200;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'alphabetic';

    // Top strip: your logo if there is one, else a plain heading
    const logo = POSTER_LOGO ? await loadImage(POSTER_LOGO) : null;
    if (logo) {
      const lh = 90, lw = logo.width * (lh / logo.height);
      ctx.drawImage(logo, (W - lw) / 2, 15, lw, lh);
    } else {
      ctx.fillStyle = PC.teal; ctx.font = `700 40px ${PF}`; ctx.textAlign = 'center';
      ctx.fillText('Bus Service Notice', W / 2, 78);
    }

    // Title band
    ctx.fillStyle = PC.teal; ctx.fillRect(0, 120, W, 260);
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left';
    let ts = 96;
    ctx.font = `400 ${ts}px ${PF}`;
    while (ctx.measureText(title).width > W - 200 && ts > 50) { ts -= 4; ctx.font = `400 ${ts}px ${PF}`; }
    ctx.fillText(title, 96, 250);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)'; ctx.fillRect(60, 285, W - 120, 3);
    ctx.fillStyle = '#ffffff'; ctx.font = `700 46px ${PF}`;
    let sub = name;
    while (ctx.measureText(sub).width > W - 220 && sub.length > 4) sub = sub.slice(0, -2);
    ctx.fillText(sub === name ? sub : `${sub.trimEnd()}…`, 110, 352);

    // Services affected (lime) beside the date and time (soft green)
    const sY = 395, sH = 300;
    roundRect(ctx, 900, sY, W - 918, sH, 40); ctx.fillStyle = PC.limeSoft; ctx.fill();
    roundRect(ctx, 18, sY, 1010, sH, 40); ctx.fillStyle = PC.lime; ctx.fill();
    const svc = all.length ? all.join(', ') : 'No bus services affected';
    let fs = 78, lines = [];
    for (; fs >= 40; fs -= 4) {
      ctx.font = `700 ${fs}px ${PF}`;
      lines = wrapLines(ctx, svc, 860);
      if (lines.length * fs * 1.12 <= sH - 50) break;
    }
    ctx.fillStyle = PC.ink; ctx.textAlign = 'left';
    const lh = fs * 1.12, top = sY + (sH - lines.length * lh) / 2;
    lines.forEach((l, i) => ctx.fillText(l, 54, top + lh * (i + 0.8)));
    // Wheelchair-accessible mark
    roundRect(ctx, 920, sY + sH - 92, 64, 64, 8); ctx.fillStyle = '#1d4ed8'; ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.font = `44px "Segoe UI Symbol", "Apple Symbols", ${PF}`; ctx.textAlign = 'center';
    ctx.fillText('♿', 952, sY + sH - 44);
    const when = posterWhen(period);
    ctx.fillStyle = PC.ink; ctx.textAlign = 'left';
    let ws = 50;
    ctx.font = `700 ${ws}px ${PF}`;
    while (Math.max(...when.map((s) => ctx.measureText(s).width)) > W - 1100 && ws > 28) { ws -= 2; ctx.font = `700 ${ws}px ${PF}`; }
    when.forEach((s, i) => ctx.fillText(s, 1066, sY + sH / 2 - ws * 0.35 + i * ws * 1.35));

    // What happens, in four languages, and any services not running
    let y = 765;
    if (rows.length) {
      LINES_SKIP.forEach(([text, size], i) => {
        ctx.font = `400 ${size}px ${PF}`; ctx.fillStyle = i ? PC.grey : PC.ink;
        ctx.fillText(text, 40, y);
        y += i === 0 ? 46 : 40;
      });
    } else if (groups.length) {
      ctx.font = `400 40px ${PF}`; ctx.fillStyle = PC.ink;
      ctx.fillText('These bus services will run on a changed route.', 40, y);
      y += 46;
    }
    if (off.length) {
      ctx.font = `700 32px ${PF}`; ctx.fillStyle = PC.red;
      const note = `Service ${off.join(', ')} will not operate${period.mode === 'scheduled' ? ' during this period' : ''}.`;
      wrapLines(ctx, note, W - 80).forEach((l) => { ctx.fillText(l, 40, y); y += 40; });
    }
    y += 10;

    // Skipped stops: Road Name | Bus Stop Description | Bus Stop Code | Services Affected
    const mapMin = 700;
    if (rows.length) {
      const X = 18, TW = W - 36;
      const cols = [0.25, 0.28, 0.2, 0.27].map((f) => f * TW);
      const colX = cols.reduce((acc, w, i) => { acc.push(i ? acc[i - 1] + cols[i - 1] : X); return acc; }, []);
      const HDR = 64;
      ctx.fillStyle = PC.indigo; ctx.fillRect(X, y, TW, HDR);
      ctx.fillStyle = '#ffffff'; ctx.font = `700 30px ${PF}`; ctx.textAlign = 'center';
      ['Road Name', 'Bus Stop Description', 'Bus Stop Code', 'Services Affected'].forEach((h, i) => ctx.fillText(h, colX[i] + cols[i] / 2, y + 42));
      let ry = y + HDR;
      const limit = H - FOOT - 20 - mapMin;
      ctx.font = `400 28px ${PF}`;
      const laid = rows.map((r) => {
        const svcLines = wrapLines(ctx, r.services.join(', '), cols[3] - 30);
        const nameLines = wrapLines(ctx, r.name, cols[1] - 30);
        return { r, svcLines, nameLines, h: Math.max(64, Math.max(svcLines.length, nameLines.length) * 34 + 26) };
      });
      let shown = 0;
      for (const L of laid) { if (ry + L.h + (shown < laid.length - 1 ? 50 : 0) > limit) break; ry += L.h; shown++; }
      ry = y + HDR;
      let roadStart = ry, prevRoad = null;
      const drawRoad = (road, from, to) => {
        ctx.fillStyle = '#ffffff'; ctx.fillRect(colX[0], from, cols[0], to - from);
        ctx.strokeStyle = PC.rule; ctx.lineWidth = 1.5; ctx.strokeRect(colX[0], from, cols[0], to - from);
        ctx.fillStyle = PC.ink; ctx.font = `400 28px ${PF}`; ctx.textAlign = 'center';
        wrapLines(ctx, road, cols[0] - 30).forEach((l, i, arr) => ctx.fillText(l, colX[0] + cols[0] / 2, from + 42 + i * 34 - (arr.length - 1) * 0));
      };
      laid.slice(0, shown).forEach((L, k) => {
        if (prevRoad !== null && L.r.road !== prevRoad) { drawRoad(prevRoad, roadStart, ry); roadStart = ry; }
        prevRoad = L.r.road;
        ctx.fillStyle = k % 2 ? PC.rowAlt : '#ffffff';
        ctx.fillRect(colX[1], ry, TW - cols[0], L.h);
        ctx.strokeStyle = PC.rule; ctx.lineWidth = 1.5;
        for (let i = 1; i < 4; i++) ctx.strokeRect(colX[i], ry, cols[i], L.h);
        ctx.fillStyle = PC.ink; ctx.font = `400 28px ${PF}`; ctx.textAlign = 'center';
        const mid = (n) => ry + L.h / 2 - ((n - 1) * 34) / 2 + 10;
        L.nameLines.forEach((l, i) => ctx.fillText(l, colX[1] + cols[1] / 2, mid(L.nameLines.length) + i * 34));
        ctx.fillText(L.r.code, colX[2] + cols[2] / 2, mid(1));
        L.svcLines.forEach((l, i) => ctx.fillText(l, colX[3] + cols[3] / 2, mid(L.svcLines.length) + i * 34));
        ry += L.h;
      });
      if (prevRoad !== null) drawRoad(prevRoad, roadStart, ry);
      if (shown < laid.length) {
        ctx.fillStyle = '#f8fafc'; ctx.fillRect(X, ry, TW, 50);
        ctx.strokeStyle = PC.rule; ctx.strokeRect(X, ry, TW, 50);
        ctx.fillStyle = PC.grey; ctx.font = `italic 400 26px ${PF}`; ctx.textAlign = 'center';
        ctx.fillText(`+ ${laid.length - shown} more stop${laid.length - shown === 1 ? '' : 's'} skipped (see the change report)`, X + TW / 2, ry + 34);
        ry += 50;
      }
      y = ry + 20;
    }

    // Map and its legend
    const mapRect = { x: 30, y, w: 1210, h: H - FOOT - 20 - y };
    drawPosterMap(ctx, mapRect, data, posterBounds(data));
    const lx = 1270, lw = W - lx - 30;
    let ly = y + 40;
    const legendLine = (color, isArrow) => {
      ctx.save();
      ctx.lineCap = 'butt'; ctx.strokeStyle = color; ctx.lineWidth = isArrow ? 9 : 12;
      ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + (isArrow ? 70 : 84), ly); ctx.stroke();
      if (isArrow) { ctx.beginPath(); ctx.moveTo(lx + 88, ly); ctx.lineTo(lx + 66, ly - 13); ctx.lineTo(lx + 66, ly + 13); ctx.closePath(); ctx.fillStyle = color; ctx.fill(); }
      ctx.restore();
    };
    const legendText = (text) => {
      ctx.fillStyle = PC.ink; ctx.font = `400 26px ${PF}`; ctx.textAlign = 'left';
      const ls = wrapLines(ctx, text, lw - 110);
      ls.forEach((l, i) => ctx.fillText(l, lx + 108, ly + 9 + i * 31));
      ly += Math.max(60, ls.length * 31 + 30);
    };
    legendLine(PC.red, false); legendText('Road Closure');
    groups.forEach((g) => {
      legendLine(g.color, true);
      const towards = g.kind === 'diverted' && g.towards.size === 1 ? ` (Towards ${[...g.towards][0]})` : '';
      const tag = g.kind === 'curtailed' ? ' (Curtailed)' : g.kind === 'new' ? ' (New service)' : '';
      legendText(`Service ${g.nums.join(', ')}${towards}${tag}`);
    });
    if (rows.length) {
      const cx = lx + 42, cy = ly;
      ctx.beginPath(); ctx.arc(cx, cy, 17, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = PC.red; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - 8, cy - 8); ctx.lineTo(cx + 8, cy + 8); ctx.moveTo(cx + 8, cy - 8); ctx.lineTo(cx - 8, cy + 8); ctx.stroke();
      legendText('Bus Stop Skipped');
    }

    // Footer: where to find out more
    const fy = H - FOOT;
    ctx.fillStyle = PC.rule; ctx.fillRect(18, fy, W - 36, 2);
    ctx.fillStyle = PC.ink; ctx.textAlign = 'left'; ctx.font = `400 22px ${PF}`;
    MORE_INFO.forEach((s, i) => ctx.fillText(s, 30, fy + 70 + i * 28));
    ctx.font = `48px "Segoe UI Symbol", "Apple Symbols", ${PF}`; ctx.fillText('☎', 330, fy + 125);
    POSTER_CONTACTS.forEach(([who, tel], i) => {
      const cx = 410 + Math.floor(i / 2) * 620, cy = fy + 62 + (i % 2) * 70;
      ctx.font = `700 24px ${PF}`; ctx.fillText(who, cx, cy);
      ctx.font = `400 24px ${PF}`; ctx.fillText(tel, cx, cy + 30);
    });

    const blob = buildPdf([jpegOf(canvas)], 595, 842);
    return { blob, filename: `${safeName(name)} - poster.pdf`, canvas };
  };

  const saveBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return filename;
  };
  B.downloadPoster = async function (c, projectId) {
    const { blob, filename } = await B.buildPoster(c, projectId);
    return saveBlob(blob, filename);
  };

  // Slides: a real .pptx (title, the maps, the numbers, then the changes as text)
  const loadScript = (src) => new Promise((res, rej) => {
    if (window.PptxGenJS) return res();
    const el = document.createElement('script');
    el.src = src; el.onload = res; el.onerror = () => rej(new Error('Could not load the slides tool'));
    document.head.appendChild(el);
  });
  B.downloadSlides = async function (c, projectId) {
    await loadScript('js/vendor/pptxgen.bundle.js?v=1'); // PptxGenJS 3.12.0 (MIT), kept in the project so exports work offline
    const { canvases } = await B.buildChangeReport(c, projectId);
    const { name, lines, when, stats } = exportData(c, projectId);
    const pptx = new window.PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
    pptx.title = `${name} - changes`;
    const FONTP = 'Arial';

    let sl = pptx.addSlide();
    sl.background = { color: '0F172A' };
    sl.addText('BRASS · BUS ROUTE CHANGES', { x: 0.7, y: 2.1, w: 12, h: 0.4, fontFace: FONTP, fontSize: 16, bold: true, color: '93C5FD' });
    sl.addText(name, { x: 0.7, y: 2.6, w: 12, h: 1.3, fontFace: FONTP, fontSize: 48, bold: true, color: 'FFFFFF' });
    sl.addText(`Compared with the Current Map · Prepared by John Doe · ${when}`, { x: 0.7, y: 4.0, w: 12, h: 0.5, fontFace: FONTP, fontSize: 16, color: 'CBD5E1' });

    sl = pptx.addSlide();
    sl.addText('At a glance', { x: 0.6, y: 0.4, w: 12, h: 0.7, fontFace: FONTP, fontSize: 30, bold: true, color: '0F172A' });
    stats.forEach(([label, n, sub], i) => {
      const x = 0.6 + i * 3.1;
      sl.addShape(pptx.ShapeType.roundRect, { x, y: 1.5, w: 2.9, h: 2.3, fill: { color: 'F8FAFC' }, line: { color: 'E2E8F0', width: 1 }, rectRadius: 0.12 });
      sl.addText(String(n), { x: x + 0.2, y: 1.65, w: 2.5, h: 1.0, fontFace: FONTP, fontSize: 46, bold: true, color: '0F172A' });
      sl.addText(label.toUpperCase(), { x: x + 0.2, y: 2.65, w: 2.5, h: 0.4, fontFace: FONTP, fontSize: 12, bold: true, color: '64748B' });
      sl.addText(sub, { x: x + 0.2, y: 3.05, w: 2.55, h: 0.6, fontFace: FONTP, fontSize: 10.5, color: '94A3B8', valign: 'top' });
    });

    sl = pptx.addSlide();
    sl.addText('Current Map and proposed', { x: 0.6, y: 0.3, w: 12, h: 0.6, fontFace: FONTP, fontSize: 26, bold: true, color: '0F172A' });
    const cv = canvases[0], iw = 12.1, ih = iw * (cv.height / cv.width), maxH = 6.3;
    const fit = ih > maxH ? maxH / ih : 1;
    sl.addImage({ data: cv.toDataURL('image/jpeg', 0.9), x: 0.6 + (iw - iw * fit) / 2, y: 1.0, w: iw * fit, h: ih * fit });

    const per = 11;
    const label = { add: 'Added', del: 'Removed', mod: 'Changed', close: 'Closed', reopen: 'Reopened' };
    const color = { add: '16A34A', del: 'DC2626', mod: 'D97706', close: 'DC2626', reopen: '2563EB' };
    for (let i = 0; i < Math.max(1, lines.length); i += per) {
      sl = pptx.addSlide();
      sl.addText(`What changes (${lines.length})`, { x: 0.6, y: 0.4, w: 12, h: 0.7, fontFace: FONTP, fontSize: 28, bold: true, color: '0F172A' });
      const chunk = lines.slice(i, i + per);
      if (!chunk.length) sl.addText('No differences from the Current Map', { x: 0.6, y: 1.4, w: 12, h: 0.5, fontFace: FONTP, fontSize: 18, color: '64748B' });
      chunk.forEach((ch, k) => {
        const y = 1.35 + k * 0.5;
        sl.addText(label[ch.action] || '•', { x: 0.6, y, w: 1.3, h: 0.4, fontFace: FONTP, fontSize: 13, bold: true, color: color[ch.action] || '64748B' });
        sl.addText(ch.text, { x: 1.95, y, w: 10.8, h: 0.4, fontFace: FONTP, fontSize: 14, color: '1E293B', fit: 'shrink' });
      });
    }
    const filename = `${safeName(name)} - slides.pptx`;
    await pptx.writeFile({ fileName: filename });
    return filename;
  };

  // Builds the report and saves it as a file
  B.downloadChangeReport = async function (c, projectId) {
    const { blob, filename } = await B.buildChangeReport(c, projectId);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return filename;
  };
})();
