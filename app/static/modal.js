// modal.js
// Single global namespace to avoid collisions
(function (global) {
  'use strict';

  // Shared state
  const state = global.AgentlessModal?.state || {
    chart: null,
    hostId: null,
    metric: null,
    lastPoints: [],
  };

  // Safe export
  const AgentlessModal = {
    state,

    openChartModal(hostId, metric) {
      // Resolve server name (robust fallback)
      let serverName = `Server ${hostId}`;
      try {
        const section = document.querySelector(`section:has(#host-${hostId})`);
        const nameEl = section?.querySelector('.text-lg.font-medium');
        if (nameEl?.textContent) serverName = nameEl.textContent.trim();
      } catch (_) { /* ignore :has() failures on old browsers */ }

      let title = '';
      switch (metric) {
        case 'cpu': title = `CPU Usage — ${serverName}`; break;
        case 'mem': title = `Memory Usage — ${serverName}`; break;
        default   : title = `${String(metric || '').toUpperCase()} — ${serverName}`;
      }
      AgentlessModal.openModal(title, hostId, metric);
    },

    openModal(title, hostId, metric) {
      const container = document.getElementById('modal-container');
      if (!container) return;

      const backdrop = container.querySelector('.modal-backdrop');
      const content  = container.querySelector('.modal-content');
      const titleEl  = document.getElementById('modal-title');

      if (titleEl) titleEl.textContent = title;
      state.hostId = hostId;
      state.metric = metric;

      // Show
      container.classList.remove('hidden');
      requestAnimationFrame(() => {
        backdrop?.classList.add('show');
        content?.classList.add('show');
      });
      document.body.style.overflow = 'hidden';

      // Ensure controls have handlers and initial active button
      initializeChartControls();
      AgentlessModal.loadExpandedChart().catch(console.error);
    },

    closeModal() {
      const container = document.getElementById('modal-container');
      if (!container) return;

      const backdrop = container.querySelector('.modal-backdrop');
      const content  = container.querySelector('.modal-content');

      backdrop?.classList.remove('show');
      content?.classList.remove('show');

      setTimeout(() => {
        container.classList.add('hidden');
        if (state.chart) {
          state.chart.destroy();
          state.chart = null;
        }
        document.body.style.overflow = '';
      }, 300);
    },

    async loadExpandedChart() {
      if (!state.hostId || !state.metric) return;

      const box = document.querySelector('.modal-chart-container');
      if (!box) return;

      // Loading
      box.innerHTML = '<div class="flex items-center justify-center h-full"><div class="loading-spinner"></div></div>';

      // Active range
      const activeBtn = document.querySelector('.chart-control-btn.active[data-range]');
      const range = activeBtn?.dataset.range || '1h';
      const minutes = range === '24h' ? 1440 : (range === '6h' ? 360 : 60);

      // Fetch time series
      const series = await fetchJSON(`/api/host/${state.hostId}/series?minutes=${minutes}`);

      // Build points based on metric
      let points = [];
      let label = '';
      let options = {};
      if (state.metric === 'cpu') {
        points = (series.samples || [])
          .filter(x => x && x.cpu != null)
          .map(x => ({ ts: x.ts, v: x.cpu }));
        label = 'CPU Usage %';
        options = { color: '#10B981', fill: true, showAxis: true, min: 0, max: 100, valueFormat: 'percent' };
      } else if (state.metric === 'mem') {
        points = (series.samples || [])
          .filter(x => x?.mem_total && x?.mem_avail)
          .map(x => ({ ts: x.ts, v: (x.mem_avail / x.mem_total) * 100 }));
        label = 'Memory Free %';
        options = { color: '#60A5FA', fill: true, showAxis: true, min: 0, max: 100, valueFormat: 'percent' };
      } else {
        // Generic fallback
        points = (series.samples || [])
          .filter(x => x && x.ts != null)
          .map(x => ({ ts: x.ts, v: 0 }));
        label = 'Metric';
        options = { color: '#A78BFA', fill: true, showAxis: true };
      }

      // If no data
      if (!points.length) {
        box.innerHTML = `
          <div class="flex items-center justify-center h-full text-neutral-400">
            <div class="text-center">
              <div class="mb-2">No data for the selected range.</div>
              <button class="btn btn-secondary" onclick="AgentlessModal.loadExpandedChart()">Retry</button>
            </div>
          </div>`;
        return;
      }

      // Render chart
      box.innerHTML = '<canvas id="modal-chart"></canvas>';
      const ctx = document.getElementById('modal-chart');

      if (state.chart) {
        state.chart.destroy();
        state.chart = null;
      }

      // Build dataset
      const labels = points.map(p => {
        const d = new Date(p.ts * 1000);
        return d.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: (range === '1h') ? '2-digit' : undefined
        });
      });

      state.chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label,
            data: points.map(p => p.v),
            borderColor: options.color,
            backgroundColor: options.fill ? 'rgba(16, 185, 129, 0.10)' : 'transparent',
            fill: options.fill,
            borderWidth: 2,
            pointRadius: 2,
            pointHoverRadius: 4,
            tension: 0.3
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { intersect: false, mode: 'index' },
          plugins: {
            legend: { display: true, position: 'top', labels: { color: '#D1D5DB', font: { size: 12 } } },
            tooltip: {
              mode: 'index',
              intersect: false,
              backgroundColor: '#1F2937',
              titleColor: '#D1D5DB',
              bodyColor: '#D1D5DB',
              borderColor: '#374151',
              borderWidth: 1,
              padding: 12,
              displayColors: false,
              callbacks: {
                title(items) {
                  const ts = points[items[0].dataIndex].ts;
                  return new Date(ts * 1000).toLocaleString();
                },
                label(ctx) {
                  const val = Number(ctx.raw ?? 0);
                  if (options.valueFormat === 'percent') return `${val.toFixed(1)}%`;
                  if (options.valueFormat === 'bytes')   return fmtBytes(val);
                  return val.toFixed(2);
                }
              }
            }
          },
          scales: {
            x: {
              display: true,
              grid: { color: 'rgba(75, 85, 99, 0.1)', drawBorder: false },
              ticks: { color: '#9CA3AF', maxRotation: 0, autoSkip: true, maxTicksLimit: 8, font: { size: 11 } }
            },
            y: {
              display: true,
              min: options.min,
              max: options.max,
              grid: { color: 'rgba(75, 85, 99, 0.1)', drawBorder: false },
              ticks: {
                color: '#9CA3AF',
                maxTicksLimit: 6,
                font: { size: 11 },
                callback(value) {
                  if (options.valueFormat === 'percent') return `${value}%`;
                  if (options.valueFormat === 'bytes')   return fmtBytes(value);
                  return value;
                }
              }
            }
          }
        }
      });

      // Save for CSV download
      state.lastPoints = points;

      // Fetch latest for details text
      try {
        const latest = await fetchJSON(`/api/host/${state.hostId}/latest`);
        const ex = latest?.extras || {};
        const detailsEl = document.getElementById('modal-details');

        if (state.metric === 'cpu' && ex.cpu_detail && detailsEl) {
          const cd = ex.cpu_detail;
          detailsEl.textContent =
            `User: ${(+cd.user_pct || 0).toFixed(1)}% · System: ${(+cd.sys_pct || 0).toFixed(1)}% · `
            + `Idle: ${(+cd.idle_pct || 0).toFixed(1)}% · IOwait: ${(+cd.iowait_pct || 0).toFixed(1)}%`;
        } else if (state.metric === 'mem' && ex.mem_detail && detailsEl) {
          const md = ex.mem_detail;
          detailsEl.textContent =
            `Total: ${fmtBytes(md.total_bytes)} · Free: ${fmtBytes(md.free_bytes)} · `
            + `Buffers: ${fmtBytes(md.buffers_bytes)} · Cached: ${fmtBytes(md.cached_bytes)}`;
        } else if (detailsEl) {
          detailsEl.textContent = '';
        }
      } catch (e) {
        // Non-fatal
        console.warn('Extra details fetch failed:', e);
      }
    },

    downloadChartData() {
      if (!state.lastPoints?.length) return;

      const rows = [['timestamp', 'value']];
      for (const p of state.lastPoints) rows.push([new Date(p.ts * 1000).toISOString(), String(p.v)]);
      const csv = rows.map(r => r.join(',')).join('\n');

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `series_${state.metric}_${state.hostId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }
  };

  // Bind control buttons once
  function initializeChartControls() {
    // Range buttons
    document.querySelectorAll('.chart-control-btn[data-range]').forEach(btn => {
      if (btn.__bound) return; // avoid double-binding
      btn.__bound = true;
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.chart-control-btn[data-range]').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        AgentlessModal.loadExpandedChart().catch(console.error);
      });
    });

    // Refresh button
    const refreshBtn = document.querySelector('.chart-control-btn[data-action="refresh"]');
    if (refreshBtn && !refreshBtn.__bound) {
      refreshBtn.__bound = true;
      refreshBtn.addEventListener('click', () => AgentlessModal.loadExpandedChart().catch(console.error));
    }
  }

  // Global helpers from other scripts (ensure they exist)
  // We assume fetchJSON & fmtBytes come from app.js in global scope.

  // Wire up escape & backdrop
  document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('modal-container');
    const backdrop = container?.querySelector('.modal-backdrop');
    backdrop?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) AgentlessModal.closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') AgentlessModal.closeModal();
    });
  });

  // Expose to window
  global.AgentlessModal = AgentlessModal;
  global.openChartModal = AgentlessModal.openChartModal; // keep your existing onclicks working
  global.closeModal = AgentlessModal.closeModal;
  global.downloadChartData = AgentlessModal.downloadChartData;

})(window);
