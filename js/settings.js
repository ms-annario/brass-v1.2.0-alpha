// Settings page (the Settings item in the left sidebar).
// For each Resolution Option (Divert, Curtail, Suspend), the range of a bus route affected (0 to 100%) for which
// it shows "Recommended" on the route's card. Each range has two handles; ranges may overlap (then a route gets
// more than one recommendation) or leave gaps (then none).
(function () {
  const B = window.B;
  if (!B || !B.resolutionRanges) return;

  const OPTIONS = [
    { key: 'divert', name: 'Divert', color: '#3b82f6', what: 'Re-route the bus around the affected roads.' },
    { key: 'curtail', name: 'Curtail', color: '#f59e0b', what: 'Shorten the bus on its own route, ending each side of the blockage.' },
    { key: 'suspend', name: 'Suspend', color: '#ef4444', what: 'Stop running the bus for the period.' },
  ];
  const label = (r) => (r[0] === r[1] ? `${r[0]}%` : `${r[0]}% – ${r[1]}%`);

  const render = () => {
    const wrap = document.getElementById('settings-wrap');
    if (!wrap) return;
    const ranges = B.resolutionRanges();
    wrap.innerHTML = `
      <section class="settings-card" aria-labelledby="settings-res-title">
        <h2 class="settings-card-title" id="settings-res-title">Resolution Options</h2>
        ${OPTIONS.map((o) => `
          <div class="range-row" data-key="${o.key}" style="--c: ${o.color};">
            <div class="range-row-head">
              <span class="range-dot" aria-hidden="true"></span>
              <span class="range-name">${o.name}</span>
              <span class="range-val" aria-live="polite"></span>
            </div>
            <p class="range-desc">${o.what}</p>
            <div class="dual-range">
              <div class="dual-track"><div class="dual-fill"></div></div>
              <input type="range" class="dual-lo" min="0" max="100" step="1" aria-label="${o.name} from (% affected)">
              <input type="range" class="dual-hi" min="0" max="100" step="1" aria-label="${o.name} to (% affected)">
            </div>
          </div>`).join('')}
        <div class="range-scale" aria-hidden="true"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
      </section>`;

    const show = (r) => {
      for (const o of OPTIONS) {
        const row = wrap.querySelector(`.range-row[data-key="${o.key}"]`);
        const [lo, hi] = r[o.key];
        row.querySelector('.dual-lo').value = lo;
        row.querySelector('.dual-hi').value = hi;
        row.querySelector('.range-val').textContent = label(r[o.key]);
        const fill = row.querySelector('.dual-fill');
        fill.style.left = `${lo}%`;
        fill.style.width = `${hi - lo}%`;
        // when both handles meet, the one that can still move inwards sits on top
        row.querySelector('.dual-lo').classList.toggle('on-top', lo === hi && lo >= 50);
      }
    };

    // Moving one handle past the other pushes it along
    wrap.querySelectorAll('.range-row').forEach((row) => {
      const key = row.dataset.key;
      const lo = row.querySelector('.dual-lo');
      const hi = row.querySelector('.dual-hi');
      const save = (moved) => {
        let a = Number(lo.value), b = Number(hi.value);
        if (a > b) { if (moved === 'lo') b = a; else a = b; }
        const r = B.resolutionRanges();
        r[key] = [a, b];
        B.setResolutionRanges(r);
        show(B.resolutionRanges());
      };
      lo.addEventListener('input', () => save('lo'));
      hi.addEventListener('input', () => save('hi'));
    });
    show(ranges);
  };
  B.renderSettingsPage = render;

  // The open bus card and the bus lists follow the new ranges
  window.addEventListener('brass-thresholds', () => {
    const app = window.BRASS_APP;
    const c = app && app.controller;
    if (!c) return;
    const sel = c.renderer && c.renderer.selected;
    if (sel && (sel.type === 'route' || sel.type === 'route-leg')) c._showInspector(sel);
    if (c._updateRouteDropdown) c._updateRouteDropdown();
  });
})();
