/**
 * LEO Constellation Digital Twin — Dashboard Application
 *
 * Fetches JSON/GeoJSON/PNG artifacts from data/artifacts/ and renders them.
 * Uses Leaflet.js for interactive maps, Chart.js for dynamic charts,
 * Three.js for 3D orbit visualization, and multi-track ground tracks.
 */

(function () {
    'use strict';

    // Artifact base path (relative to dashboard/)
    const ARTIFACT_BASE = 'data/artifacts';

    // Page navigation
    const navBtns = document.querySelectorAll('.nav-btn');
    const pages = document.querySelectorAll('.page');

    navBtns.forEach(function (btn) {
        btn.addEventListener('click', function () {
            const target = btn.dataset.page;
            navBtns.forEach(function (b) { b.classList.remove('active'); });
            pages.forEach(function (p) { p.classList.remove('active'); });
            btn.classList.add('active');
            document.getElementById('page-' + target).classList.add('active');

            if (target === 'detail') {
                if (!mapInitialized) initMap();
                // Auto-load first satellite if none loaded yet
                var detailSel = document.getElementById('sat-select');
                if (detailSel && detailSel.value && !detailLoaded) {
                    loadDetail(detailSel.value);
                    detailLoaded = true;
                }
                // Fix Leaflet map rendering after tab switch
                if (map) {
                    setTimeout(function () { map.invalidateSize(); }, 150);
                }
            }
            if (target === 'orbit3d' && !Orbit3D.isInitialized()) {
                Orbit3D.initScene('orbit3d-container');
            }
            if (target === 'tracks2d') {
                if (!Tracks2D.isInitialized()) {
                    Tracks2D.initMap('map-multitrack');
                } else {
                    Tracks2D.invalidateSize();
                }
            }
        });
    });

    // Utility: fetch JSON
    function fetchJSON(path) {
        return fetch(path)
            .then(function (r) {
                if (!r.ok) throw new Error('Failed to load ' + path);
                return r.json();
            });
    }

    // Utility: set image src with error handling
    function setImage(id, path) {
        var img = document.getElementById(id);
        if (img) {
            img.src = path;
            img.onerror = function () { img.alt = 'Artifact not available'; };
        }
    }

    // Utility: set stat value
    function setStat(id, value) {
        var el = document.querySelector('#' + id + ' .stat-value');
        if (el) el.textContent = value;
    }

    // ========== Overview Page ==========
    var altEvolChart = null;
    var speedEvolChart = null;
    var orbElemChart = null;

    // Distinct satellite colors
    var SAT_COLORS = [
        '#58a6ff', '#f85149', '#3fb950', '#d29922',
        '#bc8cff', '#f778ba', '#79c0ff', '#ff9a2e',
        '#56d364', '#e6edf3'
    ];

    function loadOverview() {
        fetchJSON(ARTIFACT_BASE + '/overview/overview_summary.json')
            .then(function (data) {
                setStat('stat-nsats', data.nSatellites.toLocaleString());
                setStat('stat-timesteps', data.nTimesteps.toLocaleString());
                if (data.altitudeStats) {
                    setStat('stat-alt-mean', data.altitudeStats.mean_km.toFixed(1) + ' km');
                    setStat('stat-alt-range',
                        data.altitudeStats.min_km.toFixed(0) + '–' +
                        data.altitudeStats.max_km.toFixed(0) + ' km');
                }
                if (data.generatedAt) {
                    document.getElementById('generated-at').textContent = data.generatedAt;
                }
            })
            .catch(function () {
                console.warn('Overview summary not available');
            });

        setImage('img-altitude', ARTIFACT_BASE + '/overview/altitude_histogram.png');
        setImage('img-inclination', ARTIFACT_BASE + '/overview/inclination.png');

        // Interactive altitude evolution chart
        fetchJSON(ARTIFACT_BASE + '/overview/altitude_evolution.json')
            .then(function (data) {
                renderAltEvolutionChart(data);
            })
            .catch(function () {
                console.warn('Altitude evolution data not available');
            });

        // Interactive speed evolution chart
        fetchJSON(ARTIFACT_BASE + '/overview/speed_evolution.json')
            .then(function (data) {
                renderSpeedEvolutionChart(data);
            })
            .catch(function () {
                console.warn('Speed evolution data not available');
            });

        // Orbital elements scatter
        fetchJSON(ARTIFACT_BASE + '/overview/orbital_elements.json')
            .then(function (data) {
                renderOrbitalElementsChart(data);
            })
            .catch(function () {
                console.warn('Orbital elements data not available');
            });
    }

    function renderAltEvolutionChart(data) {
        var ctx = document.getElementById('chart-alt-evolution');
        if (!ctx) return;
        ctx = ctx.getContext('2d');
        if (altEvolChart) altEvolChart.destroy();

        var datasets = [];
        var nSats = data.satellites.length;
        for (var i = 0; i < nSats; i++) {
            datasets.push({
                label: data.names[i],
                data: data.satellites[i],
                borderColor: SAT_COLORS[i % SAT_COLORS.length],
                backgroundColor: 'transparent',
                borderWidth: 1.5,
                pointRadius: 0,
                tension: 0.1
            });
        }

        var labels = data.time_hours.map(function (h) { return h.toFixed(2); });

        altEvolChart = new Chart(ctx, {
            type: 'line',
            data: { labels: labels, datasets: datasets },
            options: {
                responsive: true,
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: {
                        title: { display: true, text: 'Time (hours)', color: '#8b949e' },
                        ticks: { color: '#8b949e', maxTicksLimit: 12 },
                        grid: { color: '#30363d' }
                    },
                    y: {
                        title: { display: true, text: 'Altitude (km)', color: '#8b949e' },
                        ticks: { color: '#8b949e' },
                        grid: { color: '#30363d' }
                    }
                },
                plugins: {
                    legend: { labels: { color: '#e6edf3', usePointStyle: true } },
                    tooltip: { mode: 'index' }
                }
            }
        });
    }

    function renderSpeedEvolutionChart(data) {
        var ctx = document.getElementById('chart-speed-evolution');
        if (!ctx) return;
        ctx = ctx.getContext('2d');
        if (speedEvolChart) speedEvolChart.destroy();

        var datasets = [];
        var nSats = data.satellites.length;
        for (var i = 0; i < nSats; i++) {
            datasets.push({
                label: data.names[i],
                data: data.satellites[i],
                borderColor: SAT_COLORS[i % SAT_COLORS.length],
                backgroundColor: 'transparent',
                borderWidth: 1.5,
                pointRadius: 0,
                tension: 0.1
            });
        }

        var labels = data.time_hours.map(function (h) { return h.toFixed(2); });

        speedEvolChart = new Chart(ctx, {
            type: 'line',
            data: { labels: labels, datasets: datasets },
            options: {
                responsive: true,
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: {
                        title: { display: true, text: 'Time (hours)', color: '#8b949e' },
                        ticks: { color: '#8b949e', maxTicksLimit: 12 },
                        grid: { color: '#30363d' }
                    },
                    y: {
                        title: { display: true, text: 'Speed (km/s)', color: '#8b949e' },
                        ticks: { color: '#8b949e' },
                        grid: { color: '#30363d' }
                    }
                },
                plugins: {
                    legend: { labels: { color: '#e6edf3', usePointStyle: true } }
                }
            }
        });
    }

    function renderOrbitalElementsChart(data) {
        var ctx = document.getElementById('chart-orbital-elements');
        if (!ctx) return;
        ctx = ctx.getContext('2d');
        if (orbElemChart) orbElemChart.destroy();

        // Plot RAAN vs Inclination as scatter if available
        if (data.raan_deg && data.inclination_deg) {
            var points = [];
            var nSats = data.raan_deg.length;
            for (var i = 0; i < nSats; i++) {
                points.push({
                    x: data.raan_deg[i],
                    y: data.inclination_deg[i]
                });
            }

            var names = data.names || [];
            orbElemChart = new Chart(ctx, {
                type: 'scatter',
                data: {
                    datasets: [{
                        label: 'Satellites',
                        data: points,
                        backgroundColor: SAT_COLORS.slice(0, nSats),
                        pointRadius: 8,
                        pointHoverRadius: 12
                    }]
                },
                options: {
                    responsive: true,
                    scales: {
                        x: {
                            title: { display: true, text: 'RAAN (deg)', color: '#8b949e' },
                            ticks: { color: '#8b949e' },
                            grid: { color: '#30363d' }
                        },
                        y: {
                            title: { display: true, text: 'Inclination (deg)', color: '#8b949e' },
                            ticks: { color: '#8b949e' },
                            grid: { color: '#30363d' }
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: function (context) {
                                    var idx = context.dataIndex;
                                    var name = (names[idx] || 'SAT-' + (idx + 1));
                                    return name + ': RAAN=' + context.parsed.x.toFixed(1) +
                                        '°, i=' + context.parsed.y.toFixed(1) + '°';
                                }
                            }
                        }
                    }
                }
            });
        } else if (data.inclination_deg) {
            // Fallback: bar chart of inclinations
            var labels = (data.names || []).map(function (n, i) {
                return n || ('SAT-' + (i + 1));
            });
            orbElemChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Inclination (deg)',
                        data: data.inclination_deg,
                        backgroundColor: SAT_COLORS.slice(0, data.inclination_deg.length)
                    }]
                },
                options: {
                    responsive: true,
                    scales: {
                        x: {
                            ticks: { color: '#8b949e' },
                            grid: { color: '#30363d' }
                        },
                        y: {
                            title: { display: true, text: 'Inclination (deg)', color: '#8b949e' },
                            ticks: { color: '#8b949e' },
                            grid: { color: '#30363d' }
                        }
                    },
                    plugins: {
                        legend: { display: false }
                    }
                }
            });
        }
    }

    // ========== Satellite Detail Page ==========
    var map = null;
    var mapInitialized = false;
    var trackLayer = null;
    var detailLoaded = false;

    function initMap() {
        if (mapInitialized) return;
        map = L.map('map-groundtrack').setView([0, 0], 2);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 18,
            attribution: 'OpenStreetMap'
        }).addTo(map);
        trackLayer = L.layerGroup().addTo(map);
        mapInitialized = true;
    }

    function loadDetail(satId) {
        var prefix = ARTIFACT_BASE + '/detail/sat_' + satId;

        setImage('img-groundtrack', prefix + '_groundtrack.png');

        // Load GeoJSON track on map
        if (map && trackLayer) {
            trackLayer.clearLayers();
            fetch(prefix + '_groundtrack.geojson')
                .then(function (r) { return r.json(); })
                .then(function (geojson) {
                    L.geoJSON(geojson, {
                        style: { color: '#58a6ff', weight: 2 }
                    }).addTo(trackLayer);
                })
                .catch(function () {
                    console.warn('GeoJSON not available for sat ' + satId);
                });
        }

        // Altitude chart
        fetchJSON(prefix + '_state.json')
            .then(function (data) {
                renderAltitudeChart(data);
            })
            .catch(function () {
                console.warn('State data not available for sat ' + satId);
            });
    }

    var altChart = null;

    function renderAltitudeChart(stateData) {
        var ctx = document.getElementById('chart-altitude').getContext('2d');
        if (altChart) altChart.destroy();

        var labels = stateData.time_s.map(function (t) {
            return (t / 3600).toFixed(2);
        });

        altChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Altitude (km)',
                    data: stateData.altitude_km,
                    borderColor: '#58a6ff',
                    backgroundColor: 'rgba(88,166,255,0.1)',
                    borderWidth: 1.5,
                    pointRadius: 0,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                scales: {
                    x: {
                        title: { display: true, text: 'Time (hours)', color: '#8b949e' },
                        ticks: { color: '#8b949e', maxTicksLimit: 10 },
                        grid: { color: '#30363d' }
                    },
                    y: {
                        title: { display: true, text: 'Altitude (km)', color: '#8b949e' },
                        ticks: { color: '#8b949e' },
                        grid: { color: '#30363d' }
                    }
                },
                plugins: {
                    legend: { labels: { color: '#e6edf3' } }
                }
            }
        });
    }

    document.getElementById('btn-load-detail').addEventListener('click', function () {
        var sel = document.getElementById('sat-select');
        if (sel.value) {
            if (!mapInitialized) initMap();
            loadDetail(sel.value);
            detailLoaded = true;
        }
    });

    // ========== 3D Orbit Page ==========
    document.getElementById('btn-load-orbit3d').addEventListener('click', function () {
        var sel = document.getElementById('orbit3d-sat-select');
        if (sel.value) {
            if (!Orbit3D.isInitialized()) {
                Orbit3D.initScene('orbit3d-container');
            }
            Orbit3D.loadOrbitData(sel.value).then(function () {
                // Update scrubber range
                var maxFrames = Orbit3D.getMaxFrames();
                var scrubber = document.getElementById('orbit3d-scrubber');
                if (scrubber && maxFrames > 0) {
                    scrubber.max = maxFrames - 1;
                    scrubber.value = 0;
                    var label = document.getElementById('orbit3d-scrubber-label');
                    if (label) label.textContent = '0 / ' + (maxFrames - 1);
                }
                // Set initial speed from slider
                var speedSlider = document.getElementById('orbit3d-speed');
                if (speedSlider) {
                    Orbit3D.setAnimSpeedFromSlider(parseInt(speedSlider.value, 10));
                }
                // Build visibility toggle panel
                buildOrbit3DToggles();
            });
        }
    });

    document.getElementById('btn-animate-orbit3d').addEventListener('click', function () {
        Orbit3D.startAnimation();
    });

    document.getElementById('btn-pause-orbit3d').addEventListener('click', function () {
        Orbit3D.pauseAnimation();
    });

    document.getElementById('orbit3d-speed').addEventListener('input', function () {
        Orbit3D.setAnimSpeedFromSlider(parseInt(this.value, 10));
    });

    // Scrubber: manual position control
    var orbit3dScrubber = document.getElementById('orbit3d-scrubber');
    if (orbit3dScrubber) {
        orbit3dScrubber.addEventListener('mousedown', function () {
            Orbit3D.pauseAnimation();
        });
        orbit3dScrubber.addEventListener('input', function () {
            var frame = parseInt(this.value, 10);
            Orbit3D.setAnimFrame(frame);
            var label = document.getElementById('orbit3d-scrubber-label');
            if (label) label.textContent = frame + ' / ' + this.max;
        });
    }

    // Ground track master toggle
    var groundMaster = document.getElementById('orbit3d-ground-master');
    if (groundMaster) {
        groundMaster.addEventListener('change', function () {
            Orbit3D.setAllGroundTracksVisible(this.checked);
        });
    }

    // Build toggle checkboxes for each orbit track
    function buildOrbit3DToggles() {
        var container = document.getElementById('orbit3d-track-toggles');
        if (!container) return;
        container.innerHTML = '';

        var tracks = Orbit3D.getTrackInfo();
        for (var i = 0; i < tracks.length; i++) {
            (function (track) {
                var item = document.createElement('div');
                item.className = 'toggle-item';

                // Orbit visibility checkbox
                var orbitLabel = document.createElement('label');
                orbitLabel.className = 'toggle-label';
                var orbitCb = document.createElement('input');
                orbitCb.type = 'checkbox';
                orbitCb.checked = track.visible;
                orbitCb.addEventListener('change', function () {
                    Orbit3D.setTrackVisible(track.name, this.checked);
                });
                var dot = document.createElement('span');
                dot.className = 'legend-dot';
                dot.style.background = track.color;
                dot.style.display = 'inline-block';
                dot.style.width = '10px';
                dot.style.height = '10px';
                dot.style.marginRight = '6px';
                var text = document.createElement('span');
                text.className = 'toggle-text';
                text.textContent = track.name;
                orbitLabel.appendChild(orbitCb);
                orbitLabel.appendChild(dot);
                orbitLabel.appendChild(text);
                item.appendChild(orbitLabel);

                container.appendChild(item);
            })(tracks[i]);
        }
    }

    // ========== 2D Multi-Track Page ==========
    document.getElementById('btn-load-tracks2d').addEventListener('click', function () {
        var sel = document.getElementById('tracks2d-sat-select');
        if (sel.value) {
            if (!Tracks2D.isInitialized()) {
                Tracks2D.initMap('map-multitrack');
            }
            Tracks2D.loadMultiTracks(sel.value);
        }
    });

    // 2D track visibility toggles
    var t2dToggles = {
        't2d-toggle-truth': 'truth',
        't2d-toggle-ekf': 'ekf',
        't2d-toggle-sgp4': 'sgp4'
    };
    Object.keys(t2dToggles).forEach(function (cbId) {
        var cb = document.getElementById(cbId);
        if (cb) {
            cb.addEventListener('change', function () {
                Tracks2D.setTrackVisible(t2dToggles[cbId], this.checked);
            });
        }
    });

    // 2D animation controls
    document.getElementById('btn-animate-tracks2d').addEventListener('click', function () {
        Tracks2D.startAnimation();
    });

    document.getElementById('btn-pause-tracks2d').addEventListener('click', function () {
        Tracks2D.pauseAnimation();
    });

    document.getElementById('tracks2d-speed').addEventListener('input', function () {
        Tracks2D.setAnimSpeedFromSlider(parseInt(this.value, 10));
    });

    // 2D scrubber
    var tracks2dScrubber = document.getElementById('tracks2d-scrubber');
    if (tracks2dScrubber) {
        tracks2dScrubber.addEventListener('mousedown', function () {
            Tracks2D.pauseAnimation();
            Tracks2D.setScrubberDragging(true);
        });
        tracks2dScrubber.addEventListener('mouseup', function () {
            Tracks2D.setScrubberDragging(false);
        });
        tracks2dScrubber.addEventListener('input', function () {
            var frame = parseInt(this.value, 10);
            Tracks2D.setAnimFrame(frame);
            var label = document.getElementById('tracks2d-scrubber-label');
            if (label) label.textContent = frame + ' / ' + this.max;
        });
    }

    // ========== Twin Comparison Page ==========
    function loadComparison() {
        fetchJSON(ARTIFACT_BASE + '/comparison/twin_error_envelope.json')
            .then(function (data) {
                setStat('stat-rms-pos', data.oneStep.rmsPos.toFixed(1) + ' m');
                setStat('stat-rms-vel', data.oneStep.rmsVel.toFixed(3) + ' m/s');
                setStat('stat-horizon', data.rollout.maxStepsBelow1km.toString());
            })
            .catch(function () {
                console.warn('Twin error envelope not available');
            });

        setImage('img-error-ts', ARTIFACT_BASE + '/comparison/error_timeseries.png');
        setImage('img-regime', ARTIFACT_BASE + '/comparison/regime_map.png');

        // Drift heatmap: only show if the artifact exists (requires rollout data)
        var driftImg = document.getElementById('img-drift');
        if (driftImg) {
            fetch(ARTIFACT_BASE + '/comparison/drift_heatmap.png', { method: 'HEAD' })
                .then(function (r) {
                    if (r.ok) {
                        setImage('img-drift', ARTIFACT_BASE + '/comparison/drift_heatmap.png');
                    } else {
                        driftImg.style.display = 'none';
                        var parent = driftImg.parentElement;
                        if (parent) {
                            var notice = document.createElement('div');
                            notice.className = 'artifact-notice';
                            notice.textContent = 'Drift data requires surrogate rollout ' +
                                '(R_phys, R_surr). Not available in current pipeline run.';
                            parent.appendChild(notice);
                        }
                    }
                })
                .catch(function () {
                    driftImg.alt = 'Drift data not available';
                });
        }
    }

    // ========== GPU Performance Page ==========
    var throughputChart = null;

    function loadPerformance() {
        fetchJSON(ARTIFACT_BASE + '/performance/gpu_device_info.json')
            .then(function (data) {
                var infoDiv = document.getElementById('gpu-info');
                infoDiv.innerHTML = '';
                var fields = [
                    ['Device', data.name],
                    ['Compute Capability', data.computeCapability],
                    ['Total Memory', (data.totalMemory_GB || 0).toFixed(2) + ' GB'],
                    ['Available Memory', (data.availableMemory_GB || 0).toFixed(2) + ' GB'],
                    ['Driver', data.driverVersion || '—'],
                    ['Toolkit', data.toolkitVersion || '—']
                ];
                fields.forEach(function (f) {
                    var row = document.createElement('div');
                    row.className = 'info-row';
                    row.innerHTML = '<span class="info-label">' + f[0] +
                        '</span><span class="info-value">' + f[1] + '</span>';
                    infoDiv.appendChild(row);
                });
            })
            .catch(function () {
                console.warn('GPU device info not available');
            });

        setImage('img-throughput', ARTIFACT_BASE + '/performance/gpu_throughput.png');
        setImage('img-memory', ARTIFACT_BASE + '/performance/gpu_memory.png');

        fetchJSON(ARTIFACT_BASE + '/performance/gpu_throughput.json')
            .then(function (data) {
                var ctx = document.getElementById('chart-throughput').getContext('2d');
                if (throughputChart) throughputChart.destroy();

                var datasets = [{
                    label: 'Benchmark (isolated)',
                    data: data.N.map(function (n, i) {
                        return { x: n, y: data.StepsPerSec[i] };
                    }),
                    borderColor: '#58a6ff',
                    backgroundColor: 'rgba(88,166,255,0.1)',
                    borderWidth: 2,
                    pointRadius: 6,
                    pointBackgroundColor: '#58a6ff',
                    fill: true,
                    showLine: true
                }];

                // Overlay actual pipeline throughput if available
                if (data.actual && data.actual.nSatellites && data.actual.effectiveStepsPerSec) {
                    datasets.push({
                        label: 'Actual Pipeline Run',
                        data: [{ x: data.actual.nSatellites, y: data.actual.effectiveStepsPerSec }],
                        borderColor: '#f85149',
                        backgroundColor: '#f85149',
                        pointRadius: 10,
                        pointStyle: 'star',
                        pointHoverRadius: 14,
                        showLine: false
                    });
                }

                throughputChart = new Chart(ctx, {
                    type: 'scatter',
                    data: { datasets: datasets },
                    options: {
                        responsive: true,
                        scales: {
                            x: {
                                type: 'logarithmic',
                                title: { display: true, text: 'N (satellites)', color: '#8b949e' },
                                ticks: { color: '#8b949e' },
                                grid: { color: '#30363d' }
                            },
                            y: {
                                type: 'logarithmic',
                                title: { display: true, text: 'Steps/sec', color: '#8b949e' },
                                ticks: { color: '#8b949e' },
                                grid: { color: '#30363d' }
                            }
                        },
                        plugins: {
                            legend: { labels: { color: '#e6edf3', usePointStyle: true } },
                            tooltip: {
                                callbacks: {
                                    label: function (context) {
                                        var pt = context.raw;
                                        return context.dataset.label + ': N=' +
                                            pt.x + ', ' + pt.y.toLocaleString() + ' steps/sec';
                                    }
                                }
                            }
                        }
                    }
                });

                // Show actual pipeline timing summary
                if (data.actual && data.actual.propTime_s) {
                    var infoDiv = document.getElementById('gpu-info');
                    if (infoDiv) {
                        var sep = document.createElement('div');
                        sep.style.cssText = 'border-top:2px solid #1f6feb;margin:0.8rem 0;padding-top:0.5rem;';
                        sep.innerHTML = '<strong style="color:#e6edf3">Actual Pipeline Run</strong>';
                        infoDiv.appendChild(sep);

                        var fields = [];
                        if (data.actual.nSatellites) {
                            fields.push(['Satellites', data.actual.nSatellites]);
                        }
                        fields.push(['Propagation Time', data.actual.propTime_s.toFixed(1) + ' s']);
                        if (data.actual.nSteps) {
                            fields.push(['Steps', data.actual.nSteps.toLocaleString()]);
                        }
                        if (data.actual.effectiveStepsPerSec) {
                            fields.push(['Effective Throughput',
                                data.actual.effectiveStepsPerSec.toLocaleString(undefined,
                                    {maximumFractionDigits: 0}) + ' step-sats/sec']);
                        }
                        fields.forEach(function (f) {
                            var row = document.createElement('div');
                            row.className = 'info-row';
                            row.innerHTML = '<span class="info-label">' + f[0] +
                                '</span><span class="info-value" style="color:#f85149">' +
                                f[1] + '</span>';
                            infoDiv.appendChild(row);
                        });
                    }
                }
            })
            .catch(function () {
                console.warn('Throughput data not available');
            });
    }

    // ========== Populate satellite selectors ==========
    function populateSatSelector() {
        // Try orbit summary first (has orbit-specific satellite list)
        var orbitSummaryLoaded = false;

        fetchJSON(ARTIFACT_BASE + '/orbits/orbit_summary.json')
            .then(function (orbitData) {
                orbitSummaryLoaded = true;
                populateSelector('orbit3d-sat-select', orbitData);
                populateSelector('tracks2d-sat-select', orbitData);
            })
            .catch(function () {
                // Fallback: use overview summary for orbit pages too
                fetchJSON(ARTIFACT_BASE + '/overview/overview_summary.json')
                    .then(function (data) {
                        populateSelector('orbit3d-sat-select', data);
                        populateSelector('tracks2d-sat-select', data);
                    })
                    .catch(function () {
                        console.warn('Could not load satellite list for orbit pages');
                    });
            });

        // Detail page selector (always from overview)
        fetchJSON(ARTIFACT_BASE + '/overview/overview_summary.json')
            .then(function (data) {
                populateSelector('sat-select', data);
            })
            .catch(function () {
                console.warn('Could not load satellite list');
            });
    }

    function populateSelector(selectId, data) {
        var sel = document.getElementById(selectId);
        if (!sel) return;

        // Clear existing options
        sel.innerHTML = '';

        if (data.satelliteIds && data.satelliteIds.length > 0) {
            for (var i = 0; i < data.satelliteIds.length; i++) {
                var satId = String(data.satelliteIds[i]);
                var name = (data.satelliteNames && data.satelliteNames[i])
                    ? data.satelliteNames[i] : 'SAT-' + satId;
                var opt = document.createElement('option');
                opt.value = satId;
                opt.textContent = name + ' (' + satId + ')';
                sel.appendChild(opt);
            }
        } else {
            var n = Math.min(data.nSatellites || 10, 50);
            for (var j = 1; j <= n; j++) {
                var opt2 = document.createElement('option');
                opt2.value = String(j).padStart(4, '0');
                opt2.textContent = 'SAT-' + String(j).padStart(4, '0');
                sel.appendChild(opt2);
            }
        }
    }

    // ========== Init ==========
    loadOverview();
    loadComparison();
    loadPerformance();
    populateSatSelector();

})();
