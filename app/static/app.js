/* Global state */
const charts = {};
const timers = {};
const hostStates = {};

/* Config */
const CONFIG = {
  updateInterval: 10000,   // ms, default 10s
  chartPoints: 60,         // points in small charts
  errorRetries: 3
};

/* ---------- Utilities ---------- */

function showError(hostId, message) {
  const el = document.getElementById(`error-${hostId}`);
  if (el) {
    el.textContent = message;
    el.classList.remove('hidden');
  }
}

function hideError(hostId) {
  const el = document.getElementById(`error-${hostId}`);
  if (el) el.classList.add('hidden');
}

window.addEventListener('unload', () => {
  // Clean up all timers on unload
  Object.values(timers).forEach(t => clearInterval(t));
});

function fmtBytes(b) {
  if (b == null) return "—";
  const u = ["B","KB","MB","GB","TB"]; let i = 0, n = Math.abs(b);
  while (n >= 1024 && i < u.length-1) { n /= 1024; i++; }
  return `${(Math.sign(b)*n).toFixed(1)} ${u[i]}`;
}

function fmtDurHrs(sec) {
  if (sec == null) return "—";
  const d = Math.floor(sec/86400), h = Math.floor((sec%86400)/3600), m = Math.floor((sec%3600)/60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function last(arr){ return arr.length ? arr[arr.length-1] : null; }

function getLoadStatus(cpu) {
  if (cpu === null) return "—";
  if (cpu < 5)  return "Idle";
  if (cpu < 30) return "Low";
  if (cpu < 70) return "Moderate";
  if (cpu < 90) return "High";
  return "Critical";
}

function getMemStatus(free) {
  if (free === null) return "—";
  if (free > 50) return "Optimal";
  if (free > 30) return "Moderate";
  if (free > 15) return "Low";
  return "Critical";
}

/* Small line chart (sparkline) */
function sparkline(ctx, label, points, options = {}) {
  // Destroy previous chart if any
  if (charts[ctx.id]) {
    charts[ctx.id].destroy();
    delete charts[ctx.id];
  }

  // Validate & sanitize data
  points = points.filter(p => p && p.ts != null && p.v != null);
  if (points.length === 0) return;

  // Sort by timestamp
  points.sort((a, b) => a.ts - b.ts);

  // Keep last N points
  const maxPoints = CONFIG.chartPoints;
  if (points.length > maxPoints) {
    points = points.slice(-maxPoints);
  }

  const data = {
    labels: points.map(p => new Date(p.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
    datasets: [{
      label,
      data: points.map(p => p.v),
      borderColor: options.color || '#10B981',
      backgroundColor: options.fill ? 'rgba(16, 185, 129, 0.1)' : 'transparent',
      fill: options.fill || false,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 3,
      tension: 0.3
    }]
  };

  charts[ctx.id] = new Chart(ctx, {
    type: "line",
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      layout: { padding: 5 },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: '#111827',
          titleColor: '#D1D5DB',
          bodyColor: '#D1D5DB',
          borderColor: '#374151',
          borderWidth: 1,
          padding: 8,
          displayColors: false,
          callbacks: {
            title: (items) => new Date(points[items[0].dataIndex].ts * 1000).toLocaleTimeString(),
            label: (ctx) => {
              const value = ctx.raw;
              if (options.valueFormat === 'percent') return `${value.toFixed(1)}%`;
              if (options.valueFormat === 'bytes') return fmtBytes(value);
              return value.toFixed(1);
            }
          }
        }
      },
      interaction: { intersect: false, mode: 'nearest' },
      scales: {
        x: { display: options.showAxis || false, grid: { display: false }, ticks: { color:'#9CA3AF', maxTicksLimit:5 } },
        y: { display: options.showAxis || false, min: options.min, max: options.max,
             grid: { color: 'rgba(75,85,99,0.1)', drawBorder: false },
             ticks: { color:'#9CA3AF', maxTicksLimit:5,
               callback: (v) => options.valueFormat === 'percent' ? `${v}%` : (options.valueFormat === 'bytes' ? fmtBytes(v) : v)
             } }
      }
    }
  });
}

/* Fetch JSON helper */
async function fetchJSON(url){
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

/* ---------- UI: toggle section per host ---------- */
window.toggleHost = function(id, name) {
  const box = document.getElementById(`host-${id}`);
  if (!box) return;

  const isHidden = box.classList.contains("hidden");
  const btn = document.querySelector(`button[data-host="${id}"]`);

  if (isHidden) {
    // Show & start monitoring
    box.classList.remove("hidden");
    if (btn) btn.innerHTML = `
      <span>Hide</span>
      <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 ml-1" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z" clip-rule="evenodd"/>
      </svg>
    `;
    if (timers[id]) clearInterval(timers[id]);
    loadAndSchedule(id);
  } else {
    // Hide & stop monitoring
    box.classList.add("hidden");
    if (btn) btn.innerHTML = `
      <span>Monitor</span>
      <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 ml-1" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/>
      </svg>
    `;
    if (timers[id]) { clearInterval(timers[id]); delete timers[id]; }
  }
};

async function loadAndSchedule(id){
  try { await loadHost(id); } catch(e){ console.error(e); }
  if (timers[id]) clearInterval(timers[id]);
  timers[id] = setInterval(()=>loadHost(id).catch(console.error), CONFIG.updateInterval);
}

/* ---------- Main loader per host ---------- */
async function loadHost(id){
  const [series, latest] = await Promise.all([
    fetchJSON(`/api/host/${id}/series?minutes=240`),
    fetchJSON(`/api/host/${id}/latest`)
  ]);

  const s = series.samples || [];
  const lastRow = latest.last || {};
  const extras = latest.extras || {};

  try {
    // CPU
    const cpuPts = s.filter(x => x.cpu != null).map(x => ({ts: x.ts, v: x.cpu}));
    const cpuNow = last(cpuPts)?.v ?? null;

    const cpuEl = document.getElementById(`cpu-${id}`);
    const cpuLoadEl = document.getElementById(`cpu-load-${id}`);
    const cpuChartEl = document.getElementById(`cpuChart-${id}`);

    if (cpuEl) cpuEl.innerText = cpuNow != null ? Math.max(cpuNow, 0.1).toFixed(1) : "—";
    if (cpuLoadEl) cpuLoadEl.innerText = getLoadStatus(cpuNow);
    if (cpuChartEl) {
      sparkline(cpuChartEl, "CPU %", cpuPts, {
        color: '#10B981', fill: true, showAxis: true, min: 0, max: 100, valueFormat: 'percent'
      });
    }

    // Memory
    const memPts = s.filter(x => x.mem_total && x.mem_avail)
      .map(x => ({ts: x.ts, v: (x.mem_avail/x.mem_total)*100}));
    const memNow = last(memPts)?.v ?? null;

    const memPctEl = document.getElementById(`mempct-${id}`);
    const memStatusEl = document.getElementById(`mem-status-${id}`);
    const memAbsEl = document.getElementById(`memabs-${id}`);
    const memChartEl = document.getElementById(`memChart-${id}`);

    if (memPctEl) memPctEl.innerText = memNow != null ? memNow.toFixed(1) : "—";
    if (memStatusEl) memStatusEl.innerText = getMemStatus(memNow);

    if (memAbsEl && lastRow.mem_total && lastRow.mem_avail != null) {
      const used = lastRow.mem_total - lastRow.mem_avail;
      memAbsEl.innerText = `${fmtBytes(used)} used of ${fmtBytes(lastRow.mem_total)}`;
    } else if (memAbsEl) {
      memAbsEl.innerText = "—";
    }

    if (memChartEl) {
      sparkline(memChartEl, "Free Memory %", memPts, {
        color: '#60A5FA', fill: true, showAxis: true, min: 0, max: 100, valueFormat: 'percent'
      });
    }

    // Uptime (text only) + load average + system info
    const uptimeEl = document.getElementById(`uptime-${id}`);
    if (uptimeEl) {
      uptimeEl.innerText = lastRow.uptime != null ? fmtDurHrs(lastRow.uptime) : "—";
    }
    const l = extras.load_avg || {};
    const loadEl = document.getElementById(`loadavg-{{id}}`.replace('{{id}}', id));
    if (loadEl) loadEl.innerText = (l.l1!=null) ? `Load avg (1/5/15): ${(+l.l1).toFixed(2)} / ${(+l.l5).toFixed(2)} / ${(+l.l15).toFixed(2)}` : "Load avg: —";

    const sys = extras.system || {};
    const sysEl = document.getElementById(`sysinfo-${id}`);
    if (sysEl) {
      sysEl.innerText = `${sys.os || 'OS'} ${sys.os_version || ''} · kernel ${sys.kernel || '?'} · ${sys.cores || '?'} cores · ${sys.arch || '?'}`;
    }

    // CPU breakdown
    const cpuDet = extras.cpu_detail || {};
    const cpuDetailEl = document.getElementById(`cpu-detail-${id}`);
    if (cpuDetailEl) {
      cpuDetailEl.innerText = `user ${(+cpuDet.user_pct||0).toFixed(1)} · sys ${(+cpuDet.sys_pct||0).toFixed(1)} · idle ${(+cpuDet.idle_pct||0).toFixed(1)} · iowait ${(+cpuDet.iowait_pct||0).toFixed(1)} %`;
    }

    // Swap
    const sw = extras.swap || {};
    const swapEl = document.getElementById(`swap-${id}`);
    if (swapEl) {
      swapEl.innerText = sw.total_bytes != null
        ? `Swap used ${fmtBytes(sw.used_bytes||0)} / ${fmtBytes(sw.total_bytes)} (${(+sw.used_pct||0).toFixed(1)}%)`
        : "Swap: —";
    }

  } catch (err) {
    console.error('Update error (primary metrics):', err);
    showError(id, 'Update error');
  }

  // Network & latency
  const rx = lastRow.net_rx_kbps, tx = lastRow.net_tx_kbps;
  const latEl = document.getElementById(`lat-${id}`);
  if (latEl) latEl.innerText = lastRow.latency_ms!=null ? lastRow.latency_ms.toFixed(1) : "—";

  let netText = "No data";
  if (rx!=null && tx!=null) {
    netText = `↓ ${rx.toFixed(1)} KB/s\n↑ ${tx.toFixed(1)} KB/s`;
    if (extras.net?.interfaces?.length) {
      netText += `\n${extras.net.interfaces.length} active interfaces`;
    }
  }
  const netEl = document.getElementById(`net-${id}`);
  if (netEl) netEl.innerText = netText;

  // Processes (list)
  const p = extras.processes || {};
  const procEl = document.getElementById(`procs-${id}`);
  if (procEl) {
    if (p.total == null) {
      procEl.innerText = "No data";
    } else {
      const top = (p.top_cpu || []).slice(0,3).map(t => `• ${t.cmd} (${t.cpu}%)`).join('<br>');
      procEl.innerHTML = `Total: ${p.total}<br>${top || ''}`;
    }
  }

  // Disks
  try {
    const dDiv = document.getElementById(`disks-${id}`);
    if (!dDiv) return;

    const disks = latest.disks || [];
    const inodes = extras.inodes || [];
    let html = '';

    if (disks.length) {
      html = disks.map(d => {
        const inodeInfo = inodes.find(i => i.mount === d.mount);
        const inodeText = inodeInfo ? ` · inodes ${inodeInfo.iused_percent}%` : '';

        let barColor = 'bg-emerald-500', status = 'text-emerald-400';
        if (d.used_percent > 85) { barColor = 'bg-red-500'; status = 'text-red-400'; }
        else if (d.used_percent > 70) { barColor = 'bg-yellow-500'; status = 'text-yellow-400'; }

        return `
          <div class="mb-3 last:mb-0">
            <div class="flex justify-between text-xs mb-1">
              <div class="flex items-center gap-2">
                <span title="${d.device}" class="font-medium">${d.mount}</span>
                <span class="${status}">${d.used_percent}%</span>
              </div>
              <span class="text-neutral-400">${fmtBytes(d.size_bytes - d.free_bytes)} / ${fmtBytes(d.size_bytes)}${inodeText}</span>
            </div>
            <div class="h-2 rounded-full bg-neutral-700/50 overflow-hidden">
              <div class="${barColor} h-full transition-all duration-500" style="width: ${d.used_percent}%"></div>
            </div>
          </div>`;
      }).join('');
    } else {
      html = '<div class="text-neutral-500 text-sm text-center py-2">No disk information available</div>';
    }

    dDiv.innerHTML = html;
  } catch (err) {
    console.error('Update error (disks):', err);
    showError(id, 'Disk update error');
  }
}

/* ---------- Fullscreen modal charts ---------- */
window.openChartModal = async function(hostId, kind){
  // Create modal structure
  const m = document.createElement('div');
  m.className = "fixed inset-0 z-50 flex items-center justify-center bg-black/70";
  m.innerHTML = `
    <div class="w-[95vw] max-w-6xl h-[80vh] bg-neutral-900 border border-neutral-800 rounded-2xl shadow-xl flex flex-col">
      <div class="p-4 border-b border-neutral-800 flex items-center justify-between">
        <div class="text-sm text-neutral-400">
          ${kind === 'cpu' ? 'CPU Utilization' : 'Free Memory'} · Range:
          <select id="modal-range" class="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 ml-2">
            <option value="60">1h</option>
            <option value="360">6h</option>
            <option value="1440" selected>24h</option>
            <option value="2880">48h</option>
          </select>
        </div>
        <button class="px-3 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700" id="modal-close">Close</button>
      </div>
      <div class="p-4 flex-1">
        <canvas id="modalChart" class="w-full h-full"></canvas>
      </div>
    </div>
  `;
  document.getElementById('modal-container').appendChild(m);

  const close = () => { m.remove(); if (charts.modalChart) { charts.modalChart.destroy(); delete charts.modalChart; } };
  m.querySelector('#modal-close').addEventListener('click', close);
  m.addEventListener('click', (e)=>{ if(e.target===m) close(); });

  async function draw(rangeMin){
    const data = await fetchJSON(`/api/host/${hostId}/series?minutes=${rangeMin}`);
    const s = data.samples || [];
    let pts = [];
    if (kind === 'cpu') pts = s.filter(x=>x.cpu!=null).map(x=>({ts:x.ts,v:x.cpu}));
    else pts = s.filter(x=>x.mem_total&&x.mem_avail).map(x=>({ts:x.ts,v:(x.mem_avail/x.mem_total)*100}));

    const ctx = document.getElementById('modalChart').getContext('2d');
    if (charts.modalChart) { charts.modalChart.destroy(); delete charts.modalChart; }
    charts.modalChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: pts.map(p=> new Date(p.ts*1000).toLocaleString()),
        datasets: [{
          label: (kind==='cpu'?'CPU %':'Free Memory %'),
          data: pts.map(p=>p.v),
          borderColor: kind==='cpu' ? '#10B981' : '#60A5FA',
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.25
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend:{display:false} },
        interaction: { intersect:false, mode:'index' },
        scales: {
          x: { ticks:{ color:'#9CA3AF' }, grid:{ color:'rgba(75,85,99,0.1)'} },
          y: { ticks:{ color:'#9CA3AF' }, grid:{ color:'rgba(75,85,99,0.1)' }, min:0, max:100 }
        }
      }
    });
  }

  // Initial draw + range changes
  await draw(1440);
  m.querySelector('#modal-range').addEventListener('change', (e)=> draw(+e.target.value));
};

/* ---------- Header widgets ---------- */
(function bootHeader(){
  // Clock
  const clock = document.getElementById('current-time');
  if (clock) setInterval(()=> clock.textContent = new Date().toLocaleString(), 1000);

  // Layout toggle: 1 / 2 columns
  const grid = document.getElementById('servers-grid');
  const btn = document.getElementById('layout-toggle');
  if (btn && grid) {
    btn.addEventListener('click', ()=>{
      grid.classList.toggle('2xl:grid-cols-2');
      grid.classList.toggle('2xl:grid-cols-1');
    });
  }

  // Refresh All (only visible/monitored hosts)
  const refreshBtn = document.getElementById('refresh-all');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', ()=>{
      document.querySelectorAll('[id^="host-"]').forEach(el=>{
        if (!el.classList.contains('hidden')) {
          const id = +el.id.replace('host-','');
          loadHost(id).catch(console.error);
        }
      });
    });
  }

  // Auto-refresh interval selector
  const sel = document.getElementById('refresh-interval');
  if (sel) {
    sel.addEventListener('change', ()=>{
      CONFIG.updateInterval = +sel.value;
      // Recreate timers
      Object.keys(timers).forEach(id=>{
        clearInterval(timers[id]);
        timers[id] = setInterval(()=>loadHost(+id).catch(console.error), CONFIG.updateInterval);
      });
    });
  }
})();
