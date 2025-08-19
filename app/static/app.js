// Estado global
const charts = {};
const timers = {};
const hostStates = {};

// Configuración
const CONFIG = {
  updateInterval: 10000, // 10 segundos
  chartPoints: 30, // Puntos en los gráficos
  errorRetries: 3 // Intentos de reconexión
};

// Utility functions
function showError(hostId, message) {
  const el = document.getElementById(`error-${hostId}`);
  if (el) {
    el.textContent = message;
    el.classList.remove('hidden');
  }
}

function hideError(hostId) {
  const el = document.getElementById(`error-${hostId}`);
  if (el) {
    el.classList.add('hidden');
  }
}

window.addEventListener('unload', () => {
  // Limpiar todos los timers al cerrar
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
  if (cpu < 5) return "Inactivo";
  if (cpu < 30) return "Bajo";
  if (cpu < 70) return "Moderado";
  if (cpu < 90) return "Alto";
  return "Crítico";
}

function getMemStatus(free) {
  if (free === null) return "—";
  if (free > 50) return "Óptima";
  if (free > 30) return "Moderada";
  if (free > 15) return "Baja";
  return "Crítica";
}

function sparkline(ctx, label, points, options = {}) {
  // Limpiar gráfico anterior si existe
  if (charts[ctx.id]) {
    charts[ctx.id].destroy();
    delete charts[ctx.id];
  }

  // Validar y filtrar datos
  points = points.filter(p => p && p.ts != null && p.v != null);
  if (points.length === 0) return;

  // Ordenar puntos por timestamp
  points.sort((a, b) => a.ts - b.ts);

  // Limitar a los últimos N puntos para evitar sobrecarga
  const maxPoints = 30;
  if (points.length > maxPoints) {
    points = points.slice(-maxPoints);
  }

  const data = {
    labels: points.map(p => {
      const date = new Date(p.ts * 1000);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }),
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
      animation: {
        duration: 300
      },
      layout: {
        padding: {
          top: 5,
          right: 5,
          bottom: 5,
          left: 5
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: '#1F2937',
          titleColor: '#D1D5DB',
          bodyColor: '#D1D5DB',
          borderColor: '#374151',
          borderWidth: 1,
          padding: 8,
          displayColors: false,
          callbacks: {
            title: function(items) {
              const ts = points[items[0].dataIndex].ts;
              const date = new Date(ts * 1000);
              return date.toLocaleTimeString();
            },
            label: function(context) {
              const value = context.raw;
              if (options.valueFormat === 'percent') return `${value.toFixed(1)}%`;
              if (options.valueFormat === 'bytes') return fmtBytes(value);
              if (options.valueFormat === 'time') return fmtDurHrs(value * 3600);
              return value.toFixed(1);
            }
          }
        }
      },
      interaction: {
        intersect: false,
        mode: 'nearest'
      },
      scales: {
        x: { 
          display: options.showAxis || false,
          grid: {
            display: false
          },
          ticks: { 
            color: '#9CA3AF',
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 5
          }
        },
        y: {
          display: options.showAxis || false,
          min: options.min,
          max: options.max,
          grid: { 
            color: 'rgba(75, 85, 99, 0.1)',
            drawBorder: false
          },
          ticks: { 
            color: '#9CA3AF',
            maxTicksLimit: 5,
            callback: function(value) {
              if (options.valueFormat === 'percent') return value + '%';
              if (options.valueFormat === 'bytes') return fmtBytes(value);
              return value;
            }
          }
        }
      }
    }
  });
}

async function fetchJSON(url){
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

// Exponer toggleHost globalmente
window.toggleHost = function(id, name) {
  const box = document.getElementById(`host-${id}`);
  if (!box) return;

  const isHidden = box.classList.contains("hidden");
  const btn = document.querySelector(`button[data-host="${id}"]`);
  
  if (isHidden) {
    // Mostrar
    box.classList.remove("hidden");
    if (btn) btn.innerHTML = `
      <span>Ocultar</span>
      <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 ml-1" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z" clip-rule="evenodd"/>
      </svg>
    `;
    
    // Iniciar monitoreo
    if (timers[id]) {
      clearInterval(timers[id]);
      delete timers[id];
    }
    loadAndSchedule(id);
    
  } else {
    // Ocultar
    box.classList.add("hidden");
    if (btn) btn.innerHTML = `
      <span>Monitorizar</span>
      <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 ml-1" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/>
      </svg>
    `;
    
    // Detener monitoreo
    if (timers[id]) {
      clearInterval(timers[id]);
      delete timers[id];
    }
  }
}

async function loadAndSchedule(id){
  try { await loadHost(id); } catch(e){ console.error(e); }
  if (timers[id]) clearInterval(timers[id]);
  timers[id] = setInterval(()=>loadHost(id).catch(console.error), 10000); // 10s
}

async function loadHost(id){
  const [series, latest] = await Promise.all([
    fetchJSON(`/api/host/${id}/series?minutes=240`),
    fetchJSON(`/api/host/${id}/latest`)
  ]);

  const s = series.samples;
  const lastRow = latest.last || {};
  const extras = latest.extras || {};

  try {
    // ---- CPU
    const cpuPts = s.filter(x => x.cpu != null).map(x => ({ts: x.ts, v: x.cpu}));
    const cpuNow = last(cpuPts)?.v ?? null;
    
    const cpuEl = document.getElementById(`cpu-${id}`);
    const cpuLoadEl = document.getElementById(`cpu-load-${id}`);
    const cpuChartEl = document.getElementById(`cpuChart-${id}`);
    
    if (cpuEl) cpuEl.innerText = cpuNow != null ? cpuNow.toFixed(1) : "—";
    if (cpuLoadEl) cpuLoadEl.innerText = getLoadStatus(cpuNow);
    if (cpuChartEl) {
      sparkline(cpuChartEl, "CPU %", cpuPts, {
        color: '#10B981',
        fill: true,
        showAxis: true,
        min: 0,
        max: 100,
        valueFormat: 'percent'
      });
    }

    // ---- Memoria
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
      memAbsEl.innerText = `${fmtBytes(used)} usado de ${fmtBytes(lastRow.mem_total)}`;
    } else if (memAbsEl) {
      memAbsEl.innerText = "—";
    }
    
    if (memChartEl) {
      sparkline(memChartEl, "Memoria Libre %", memPts, {
        color: '#60A5FA',
        fill: true,
        showAxis: true,
        min: 0,
        max: 100,
        valueFormat: 'percent'
      });
    }

    // ---- Uptime
    const upPts = s.filter(x => x.uptime != null)
      .map(x => ({ts: x.ts, v: x.uptime/3600}));
    const upNow = last(upPts)?.v ?? null;
    
    const uptimeEl = document.getElementById(`uptime-${id}`);
    const upChartEl = document.getElementById(`upChart-${id}`);
    
    if (uptimeEl) {
      uptimeEl.innerText = lastRow.uptime != null ? 
        fmtDurHrs(lastRow.uptime) : 
        (upNow != null ? upNow.toFixed(1)+" h" : "—");
    }
    
    if (upChartEl) {
      sparkline(upChartEl, "Tiempo Activo", upPts, {
        color: '#F59E0B',
        showAxis: true,
        valueFormat: 'time'
      });
    }
  } catch (err) {
    console.error('Error al actualizar métricas principales:', err);
    showError(id, 'Error al actualizar métricas');
  }

  // ---- Red y Latencia
  const rx = lastRow.net_rx_kbps, tx = lastRow.net_tx_kbps;
  document.getElementById(`lat-${id}`).innerText = 
    lastRow.latency_ms!=null ? lastRow.latency_ms.toFixed(1) : "—";
  
  let netText = "Sin datos";
  if (rx!=null && tx!=null) {
    netText = `↓ ${rx.toFixed(1)} KB/s\n↑ ${tx.toFixed(1)} KB/s`;
    if (extras.net?.interfaces) {
      const ifaces = extras.net.interfaces;
      if (ifaces.length > 0) {
        netText += `\n${ifaces.length} interfaces activas`;
      }
    }
  }
  document.getElementById(`net-${id}`).innerText = netText;

  // ---- Procesos
  let procText = "Sin datos";
  if (extras.processes) {
    const p = extras.processes;
    procText = `Total: ${p.total}\n`;
    if (p.top_cpu && p.top_cpu.length) {
      procText += `Top CPU: ${p.top_cpu[0].cmd} (${p.top_cpu[0].cpu}%)`;
    }
  }
  document.getElementById(`procs-${id}`).innerText = procText;

  // ---- Discos
  try {
    const dDiv = document.getElementById(`disks-${id}`);
    if (!dDiv) return;

    const disks = latest.disks || [];
    let html = '';

    if (disks.length) {
      html = disks.map(d => {
        // Get matching inode info if available
        const inodeInfo = latest.extras?.inodes?.find(i => i.mount === d.mount);
        const inodeText = inodeInfo ? ` · i-nodes ${inodeInfo.iused_percent}%` : '';
        
        // Calculate bar color and status based on usage
        let barColor = 'bg-emerald-500', status = 'text-emerald-400';
        if (d.used_percent > 85) {
          barColor = 'bg-red-500';
          status = 'text-red-400';
        } else if (d.used_percent > 70) {
          barColor = 'bg-yellow-500';
          status = 'text-yellow-400';
        }
        
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
      html = '<div class="text-neutral-500 text-sm text-center py-2">No hay información de discos disponible</div>';
    }

    dDiv.innerHTML = html;
  } catch (err) {
    console.error('Error al actualizar discos:', err);
    showError(id, 'Error al actualizar información de discos');
  }

  // ---- Extras
  try {
    const ex = latest.extras || {};
    
    // CPU Details
    const cpuDet = ex.cpu_detail || {};
    const cpuDetailEl = document.getElementById(`cpu-detail-${id}`);
    if (cpuDetailEl) {
      cpuDetailEl.innerText = `user ${(+cpuDet.user_pct||0).toFixed(1)} · sys ${(+cpuDet.sys_pct||0).toFixed(1)} · idle ${(+cpuDet.idle_pct||0).toFixed(1)} · iowait ${(+cpuDet.iowait_pct||0).toFixed(1)} %`;
    }

    // Sistema
    const sys = ex.system || {};
    const sysEl = document.getElementById(`sysinfo-${id}`);
    if (sysEl) {
      sysEl.innerText = `${sys.os||"SO"} ${sys.os_version||""} · kernel ${sys.kernel||"?"} · ${sys.cores||"?"} núcleos · ${sys.arch||"?"}`;
    }

    // Swap
    const sw = ex.swap || {};
    const swapEl = document.getElementById(`swap-${id}`);
    if (swapEl) {
      swapEl.innerText = sw.total_bytes != null
        ? `Swap usada ${fmtBytes(sw.used_bytes||0)} / ${fmtBytes(sw.total_bytes)} (${(+sw.used_pct||0).toFixed(1)}%)`
        : "Swap: —";
    }
  } catch (err) {
    console.error('Error al actualizar extras:', err);
    showError(id, 'Error al actualizar información adicional');
  }
}
