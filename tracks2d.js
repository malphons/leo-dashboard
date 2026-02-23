/**
 * LEO Constellation Digital Twin — 2D Multi-Track Ground Track Visualization
 *
 * Renders multiple ground tracks on a Leaflet map:
 *   - Truth (red)
 *   - EKF Estimated (blue)
 *   - SGP4 Validation (green)
 *
 * Supports animated satellite markers moving along tracks with
 * real-time telemetry updates.
 */

var Tracks2D = (function () {
    'use strict';

    var ARTIFACT_BASE = 'data/artifacts';
    var map = null;
    var trackLayer = null;
    var markerLayer = null;
    var initialized = false;

    // Animation state
    var animating = false;
    var animFrame = 0;
    var animSpeed = 0.15;
    var animRequestId = null;
    var scrubberDragging = false;

    // Track data for animation
    var trackDataSets = [];  // {type, lat, lon, style, name, marker, polylines}
    var orbitData = null;    // Full orbit JSON for telemetry

    // Chart.js instances for Range and Range-Rate
    var rangeChart = null;
    var rangeRateChart = null;
    var chartTimeSeries = null;  // Pre-computed {time_h, range, rangeRate} per track type

    // Track styling by type
    var TRACK_STYLES = {
        truth: {
            color: '#FF4444',
            weight: 3,
            opacity: 0.9,
            dashArray: null
        },
        ekf: {
            color: '#4488FF',
            weight: 3,
            opacity: 0.9,
            dashArray: '8, 6'
        },
        sgp4: {
            color: '#44BB44',
            weight: 2.5,
            opacity: 0.8,
            dashArray: '4, 8'
        }
    };

    // Satellite icon factory
    function createSatIcon(color) {
        return L.divIcon({
            className: 'sat-marker',
            html: '<div style="' +
                'width:14px;height:14px;' +
                'background:' + color + ';' +
                'border:2px solid #fff;' +
                'border-radius:50%;' +
                'box-shadow:0 0 8px ' + color + ', 0 0 16px ' + color + '40;' +
                '"></div>',
            iconSize: [14, 14],
            iconAnchor: [7, 7]
        });
    }

    function initMap(containerId) {
        if (initialized) return;

        var container = document.getElementById(containerId);
        if (!container) return;

        map = L.map(containerId, {
            center: [0, 0],
            zoom: 2,
            minZoom: 1,
            maxZoom: 10,
            worldCopyJump: true
        });

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 18,
            attribution: 'OpenStreetMap'
        }).addTo(map);

        trackLayer = L.layerGroup().addTo(map);
        markerLayer = L.layerGroup().addTo(map);
        initialized = true;

        // Start render loop for animation
        animLoop();
    }

    function animLoop() {
        animRequestId = requestAnimationFrame(animLoop);

        if (animating && trackDataSets.length > 0) {
            var maxLen = getMaxFrames();
            animFrame += animSpeed;
            if (animFrame >= maxLen) {
                animFrame = 0;
            }
            updateMarkerPositions(Math.floor(animFrame));
        }
    }

    function loadMultiTracks(satId) {
        if (!map || !trackLayer) return Promise.reject('Map not initialized');

        trackLayer.clearLayers();
        markerLayer.clearLayers();
        trackDataSets = [];
        orbitData = null;
        animFrame = 0;

        // Load orbit JSON (has lat/lon + ECI for telemetry)
        return fetch(ARTIFACT_BASE + '/orbits/sat_' + satId + '_orbits.json')
            .then(function (r) {
                if (!r.ok) throw new Error('Orbit JSON not available');
                return r.json();
            })
            .then(function (data) {
                orbitData = data;

                // Show satellite info
                var nameEl = document.getElementById('t2d-sat-name');
                var idEl = document.getElementById('t2d-sat-id');
                if (nameEl) nameEl.textContent = data.satName || ('SAT-' + satId);
                if (idEl) idEl.textContent = 'NORAD ' + (data.satId || satId);

                // Draw tracks and create markers from orbit data
                if (data.truth && data.truth.lat) {
                    drawAnimatedTrack(data.truth.lat, data.truth.lon,
                        'truth', 'Truth — SAT-' + satId, data.truth.time_s);
                }
                if (data.ekf && data.ekf.lat) {
                    drawAnimatedTrack(data.ekf.lat, data.ekf.lon,
                        'ekf', 'EKF — SAT-' + satId, data.ekf.time_s);
                }
                if (data.sgp4 && data.sgp4.lat) {
                    drawAnimatedTrack(data.sgp4.lat, data.sgp4.lon,
                        'sgp4', 'SGP4 — SAT-' + satId, data.sgp4.time_s);
                }

                // Update scrubber range
                var maxFrames = getMaxFrames();
                var scrubber = document.getElementById('tracks2d-scrubber');
                if (scrubber && maxFrames > 0) {
                    scrubber.max = maxFrames - 1;
                    scrubber.value = 0;
                    var label = document.getElementById('tracks2d-scrubber-label');
                    if (label) label.textContent = '0 / ' + (maxFrames - 1);
                }

                // Build Range / Range-Rate charts
                buildRangeCharts();

                // Position markers at frame 0
                updateMarkerPositions(0);

                // Set initial speed from slider
                var speedSlider = document.getElementById('tracks2d-speed');
                if (speedSlider) {
                    setAnimSpeedFromSlider(parseInt(speedSlider.value, 10));
                }
            })
            .catch(function (err) {
                console.warn('Tracks 2D:', err.message);

                // Fallback: try loading GeoJSON (no animation, static tracks only)
                return fetch(ARTIFACT_BASE + '/orbits/sat_' + satId + '_multitracks.geojson')
                    .then(function (r) {
                        if (!r.ok) throw new Error('GeoJSON not available');
                        return r.json();
                    })
                    .then(function (geojson) {
                        renderMultiTrackGeoJSON(geojson);
                    })
                    .catch(function (err2) {
                        console.warn('Tracks 2D fallback:', err2.message);
                    });
            });
    }

    /**
     * Filter null/NaN entries from parallel arrays, returning only
     * indices where both lat and lon are valid numbers.
     */
    function filterValidPoints(latArr, lonArr) {
        var validLat = [];
        var validLon = [];
        var validIdx = [];
        for (var i = 0; i < latArr.length; i++) {
            if (latArr[i] !== null && lonArr[i] !== null &&
                !isNaN(latArr[i]) && !isNaN(lonArr[i])) {
                validLat.push(latArr[i]);
                validLon.push(lonArr[i]);
                validIdx.push(i);
            }
        }
        return { lat: validLat, lon: validLon, idx: validIdx };
    }

    function drawAnimatedTrack(latArr, lonArr, trackType, name, timeS) {
        var style = TRACK_STYLES[trackType] || TRACK_STYLES.truth;

        // Filter out null/NaN entries (satellite may have re-entered)
        var valid = filterValidPoints(latArr, lonArr);
        var vLat = valid.lat;
        var vLon = valid.lon;
        var vIdx = valid.idx;

        if (vLat.length < 2) return;  // Not enough valid points

        // Split at antimeridian crossings (lon jump > 180 degrees)
        var segments = [];
        var current = [];

        for (var i = 0; i < vLat.length; i++) {
            if (current.length > 0 && i > 0 &&
                Math.abs(vLon[i] - vLon[i - 1]) > 180) {
                if (current.length >= 2) segments.push(current);
                current = [];
            }
            current.push([vLat[i], vLon[i]]);
        }
        if (current.length >= 2) segments.push(current);

        // Draw track polylines (store references for visibility toggle)
        var polylines = [];
        for (var s = 0; s < segments.length; s++) {
            var polyline = L.polyline(segments[s], {
                color: style.color,
                weight: style.weight,
                opacity: style.opacity,
                dashArray: style.dashArray
            });
            polyline.bindPopup('<strong>' + name + '</strong>');
            polyline.addTo(trackLayer);
            polylines.push(polyline);
        }

        // Create animated marker at first valid point
        var marker = L.marker([vLat[0], vLon[0]], {
            icon: createSatIcon(style.color),
            zIndexOffset: 1000
        });
        marker.bindTooltip(name, {
            permanent: false,
            direction: 'top',
            offset: [0, -10]
        });
        marker.addTo(markerLayer);

        trackDataSets.push({
            type: trackType,
            lat: vLat,
            lon: vLon,
            origIdx: vIdx,  // Map back to original arrays for ECI telemetry
            timeS: timeS || [],
            style: style,
            name: name,
            marker: marker,
            polylines: polylines,
            visible: true
        });
    }

    function renderMultiTrackGeoJSON(geojson) {
        if (!geojson || !geojson.features) return;

        L.geoJSON(geojson, {
            style: function (feature) {
                var trackType = feature.properties.trackType || 'truth';
                var style = TRACK_STYLES[trackType] || TRACK_STYLES.truth;
                return {
                    color: style.color,
                    weight: style.weight,
                    opacity: style.opacity,
                    dashArray: style.dashArray
                };
            },
            onEachFeature: function (feature, layer) {
                if (feature.properties && feature.properties.name) {
                    layer.bindPopup(
                        '<strong>' + feature.properties.name + '</strong><br>' +
                        'Type: ' + (feature.properties.trackType || 'unknown')
                    );
                }
            }
        }).addTo(trackLayer);
    }

    function updateMarkerPositions(frame) {
        for (var i = 0; i < trackDataSets.length; i++) {
            var td = trackDataSets[i];
            var idx = Math.min(frame, td.lat.length - 1);
            td.marker.setLatLng([td.lat[idx], td.lon[idx]]);
        }

        updateTelemetry(frame);
        updateScrubber(frame);
        updateChartCursor(frame);
    }

    /**
     * Map a filtered-frame index back to the original data index.
     * The truth trackDataSet stores origIdx: an array mapping
     * filtered index -> original array index.
     */
    function mapFrameToOrigIdx(frame) {
        // Find the truth track (first track by convention)
        for (var i = 0; i < trackDataSets.length; i++) {
            if (trackDataSets[i].type === 'truth' && trackDataSets[i].origIdx) {
                var fIdx = Math.min(frame, trackDataSets[i].origIdx.length - 1);
                return trackDataSets[i].origIdx[fIdx];
            }
        }
        return frame;  // Fallback: frame == original index (e.g. SGP4 with no nulls)
    }

    function updateTelemetry(frame) {
        if (!orbitData) return;

        var setVal = function (id, val) {
            var el = document.getElementById(id);
            if (el) el.textContent = val;
        };

        // Map filtered frame back to original data index for raw array lookups
        var origFrame = mapFrameToOrigIdx(frame);

        // Time from truth track (use original index)
        var timeSec = 0;
        var truth = orbitData.truth;
        if (truth && truth.time_s && truth.time_s.length > 0) {
            var tIdx = Math.min(origFrame, truth.time_s.length - 1);
            timeSec = truth.time_s[tIdx] || 0;
        }

        // Elapsed time
        var hrs = timeSec / 3600;
        setVal('t2d-telem-elapsed', hrs.toFixed(2) + ' h');

        // Epoch time
        var totalSec = Math.floor(timeSec);
        var hh = String(Math.floor(totalSec / 3600)).padStart(2, '0');
        var mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
        var ss = String(totalSec % 60).padStart(2, '0');
        setVal('t2d-telem-time', 'T+' + hh + ':' + mm + ':' + ss);

        // Truth track telemetry (use origFrame for raw array access)
        if (truth && truth.lat) {
            var tI = Math.min(origFrame, truth.lat.length - 1);
            // Guard against null values at this index
            if (truth.lat[tI] !== null && truth.lon[tI] !== null) {
                setVal('t2d-telem-lat', truth.lat[tI].toFixed(2) + '\u00B0');
                setVal('t2d-telem-lon', truth.lon[tI].toFixed(2) + '\u00B0');
            }
            if (truth.alt_km[tI] !== null) {
                setVal('t2d-telem-alt', truth.alt_km[tI].toFixed(1) + ' km');
                // Range from nadir
                setVal('t2d-telem-range', truth.alt_km[tI].toFixed(1) + ' km');
                // Orbital period
                var r_km = 6371.0 + truth.alt_km[tI];
                if (r_km > 0) {
                    var mu = 398600.4418;
                    var period_s = 2 * Math.PI * Math.sqrt(Math.pow(r_km, 3) / mu);
                    setVal('t2d-telem-period', (period_s / 60).toFixed(1) + ' min');
                }
            }

            // Speed from ECI velocity
            if (truth.eci_x && tI > 0 &&
                truth.eci_x[tI] !== null && truth.eci_x[tI - 1] !== null) {
                var dx = truth.eci_x[tI] - truth.eci_x[tI - 1];
                var dy = truth.eci_y[tI] - truth.eci_y[tI - 1];
                var dz = truth.eci_z[tI] - truth.eci_z[tI - 1];
                var dt = (truth.time_s[tI] - truth.time_s[tI - 1]);
                if (dt > 0) {
                    var speed = Math.sqrt(dx * dx + dy * dy + dz * dz) / dt;
                    setVal('t2d-telem-speed', speed.toFixed(2) + ' km/s');

                    // Inclination from angular momentum
                    var rx = truth.eci_x[tI], ry = truth.eci_y[tI], rz = truth.eci_z[tI];
                    var vx2 = dx / dt, vy2 = dy / dt, vz2 = dz / dt;
                    var hx = ry * vz2 - rz * vy2;
                    var hy = rz * vx2 - rx * vz2;
                    var hz = rx * vy2 - ry * vx2;
                    var hMag = Math.sqrt(hx * hx + hy * hy + hz * hz);
                    if (hMag > 0) {
                        var incl = Math.acos(Math.min(1, Math.abs(hz) / hMag)) * 180 / Math.PI;
                        setVal('t2d-telem-incl', incl.toFixed(1) + '\u00B0');
                    }
                }
            }
        }

        // EKF-Truth error (use origFrame for both)
        var ekf = orbitData.ekf;
        if (ekf && ekf.eci_x && truth && truth.eci_x) {
            var eIdx = Math.min(origFrame, ekf.eci_x.length - 1);
            var tIdxE = Math.min(origFrame, truth.eci_x.length - 1);
            if (ekf.eci_x[eIdx] !== null && truth.eci_x[tIdxE] !== null) {
                var edx = ekf.eci_x[eIdx] - truth.eci_x[tIdxE];
                var edy = ekf.eci_y[eIdx] - truth.eci_y[tIdxE];
                var edz = ekf.eci_z[eIdx] - truth.eci_z[tIdxE];
                var errKm = Math.sqrt(edx * edx + edy * edy + edz * edz);
                setVal('t2d-telem-ekf-err', (errKm * 1000).toFixed(1) + ' m');
            }
        }

        // SGP4-Truth error (SGP4 has no nulls; truth may have nulls)
        var sgp4 = orbitData.sgp4;
        if (sgp4 && sgp4.eci_x && truth && truth.eci_x) {
            var sIdx = Math.min(origFrame, sgp4.eci_x.length - 1);
            var tIdxS = Math.min(origFrame, truth.eci_x.length - 1);
            if (sgp4.eci_x[sIdx] !== null && truth.eci_x[tIdxS] !== null) {
                var sdx = sgp4.eci_x[sIdx] - truth.eci_x[tIdxS];
                var sdy = sgp4.eci_y[sIdx] - truth.eci_y[tIdxS];
                var sdz = sgp4.eci_z[sIdx] - truth.eci_z[tIdxS];
                var sErr = Math.sqrt(sdx * sdx + sdy * sdy + sdz * sdz);
                setVal('t2d-telem-sgp4-err', (sErr * 1000).toFixed(1) + ' m');
            }
        }
    }

    function updateScrubber(frame) {
        if (scrubberDragging) return;
        var scrubber = document.getElementById('tracks2d-scrubber');
        if (scrubber) {
            scrubber.value = frame;
            var label = document.getElementById('tracks2d-scrubber-label');
            if (label) label.textContent = frame + ' / ' + scrubber.max;
        }
    }

    function clearTracks() {
        if (trackLayer) {
            trackLayer.clearLayers();
        }
        if (markerLayer) {
            markerLayer.clearLayers();
        }
        trackDataSets = [];
        orbitData = null;
        animFrame = 0;

        // Destroy charts
        if (rangeChart) { rangeChart.destroy(); rangeChart = null; }
        if (rangeRateChart) { rangeRateChart.destroy(); rangeRateChart = null; }
        chartTimeSeries = null;
    }

    function isInitialized() {
        return initialized;
    }

    function invalidateSize() {
        if (map) {
            setTimeout(function () { map.invalidateSize(); }, 100);
        }
    }

    function getMaxFrames() {
        var maxLen = 0;
        for (var i = 0; i < trackDataSets.length; i++) {
            if (trackDataSets[i].lat.length > maxLen) {
                maxLen = trackDataSets[i].lat.length;
            }
        }
        return maxLen;
    }

    function startAnimation() {
        animating = true;
    }

    function pauseAnimation() {
        animating = false;
    }

    function setAnimFrame(frame) {
        animFrame = frame;
        updateMarkerPositions(Math.floor(animFrame));
    }

    function getAnimFrame() {
        return Math.floor(animFrame);
    }

    function setAnimSpeedFromSlider(sliderVal) {
        var t = (sliderVal - 1) / 9;
        animSpeed = 0.05 * Math.pow(40, t);
    }

    function setScrubberDragging(val) {
        scrubberDragging = val;
    }

    // ========== Range / Range-Rate Charts ==========

    var RE_KM = 6371.0;  // Earth mean radius

    /**
     * Compute Range (altitude above Earth center) and Range-Rate from ECI data.
     * Range = sqrt(x² + y² + z²) - Re  [km altitude]
     * Range-Rate = d(Range)/dt  [km/s]
     *
     * Returns { time_h: [], range_km: [], range_rate_kms: [] }
     * with null entries where ECI data is null.
     */
    function computeRangeTimeSeries(trackObj) {
        if (!trackObj || !trackObj.eci_x) return null;

        var timeS = trackObj.time_s || [];
        var eciX = trackObj.eci_x;
        var eciY = trackObj.eci_y;
        var eciZ = trackObj.eci_z;
        var n = eciX.length;

        var timeH = [];
        var rangeKm = [];
        var rangeRateKms = [];

        for (var i = 0; i < n; i++) {
            var t = (timeS[i] !== null && timeS[i] !== undefined) ? timeS[i] / 3600.0 : null;
            timeH.push(t);

            if (eciX[i] === null || eciY[i] === null || eciZ[i] === null) {
                rangeKm.push(null);
                rangeRateKms.push(null);
                continue;
            }

            var r = Math.sqrt(eciX[i] * eciX[i] + eciY[i] * eciY[i] + eciZ[i] * eciZ[i]);
            var alt = r - RE_KM;
            rangeKm.push(alt);

            // Range-rate: finite difference d(|r|)/dt
            if (i > 0 && eciX[i - 1] !== null && eciY[i - 1] !== null && eciZ[i - 1] !== null &&
                timeS[i] !== null && timeS[i - 1] !== null) {
                var rPrev = Math.sqrt(eciX[i - 1] * eciX[i - 1] + eciY[i - 1] * eciY[i - 1] +
                    eciZ[i - 1] * eciZ[i - 1]);
                var dt = timeS[i] - timeS[i - 1];
                if (dt > 0) {
                    rangeRateKms.push((r - rPrev) / dt);
                } else {
                    rangeRateKms.push(null);
                }
            } else {
                rangeRateKms.push(null);
            }
        }

        return { time_h: timeH, range_km: rangeKm, range_rate_kms: rangeRateKms };
    }

    /**
     * Build Chart.js dark-theme options for scatter-line charts with time x-axis.
     * Uses linear x-axis (time in hours) for correct temporal alignment
     * across tracks with different sample rates.
     */
    function buildChartOptions(yLabel, yMin, yMax) {
        var opts = {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 0 },
            interaction: { mode: 'nearest', axis: 'x', intersect: false },
            scales: {
                x: {
                    type: 'linear',
                    title: { display: true, text: 'Time (hours)', color: '#8b949e' },
                    ticks: { color: '#8b949e', maxTicksLimit: 12 },
                    grid: { color: '#30363d' },
                    min: 0
                },
                y: {
                    title: { display: true, text: yLabel, color: '#8b949e' },
                    ticks: { color: '#8b949e' },
                    grid: { color: '#30363d' }
                }
            },
            plugins: {
                legend: { labels: { color: '#e6edf3', usePointStyle: true, boxWidth: 10 } },
                tooltip: {
                    mode: 'nearest',
                    callbacks: {
                        title: function (items) {
                            if (items.length > 0) {
                                return 'T = ' + items[0].parsed.x.toFixed(2) + ' h';
                            }
                            return '';
                        }
                    }
                },
                cursorLine: { timeH: 0 }
            }
        };

        // Optional y-axis clamping for better visualization of divergence
        if (yMin !== undefined) opts.scales.y.min = yMin;
        if (yMax !== undefined) opts.scales.y.max = yMax;

        return opts;
    }

    /**
     * Chart.js plugin: draws a vertical dashed cursor line at the current
     * time position (in hours) on the x-axis.
     */
    var cursorLinePlugin = {
        id: 'cursorLine',
        afterDraw: function (chart) {
            var opts = chart.options.plugins.cursorLine;
            if (!opts || opts.timeH === undefined) return;

            var xScale = chart.scales.x;
            if (!xScale) return;

            var xPixel = xScale.getPixelForValue(opts.timeH);
            var yTop = chart.chartArea.top;
            var yBottom = chart.chartArea.bottom;

            // Don't draw if out of visible range
            if (xPixel < chart.chartArea.left || xPixel > chart.chartArea.right) return;

            var ctx = chart.ctx;
            ctx.save();
            ctx.beginPath();
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = '#e6edf3';
            ctx.lineWidth = 1.5;
            ctx.moveTo(xPixel, yTop);
            ctx.lineTo(xPixel, yBottom);
            ctx.stroke();

            // Draw small triangle at top
            ctx.fillStyle = '#e6edf3';
            ctx.beginPath();
            ctx.moveTo(xPixel, yTop);
            ctx.lineTo(xPixel - 5, yTop - 8);
            ctx.lineTo(xPixel + 5, yTop - 8);
            ctx.closePath();
            ctx.fill();

            ctx.restore();
        }
    };

    // Register the cursor line plugin once
    if (typeof Chart !== 'undefined' && Chart.register) {
        Chart.register(cursorLinePlugin);
    }

    /**
     * Convert time_h and value arrays into Chart.js scatter {x, y} points,
     * skipping nulls. This ensures each track type is plotted at its
     * correct time position regardless of differing sample rates.
     */
    function toScatterData(timeH, values) {
        var pts = [];
        for (var i = 0; i < values.length; i++) {
            if (values[i] !== null && timeH[i] !== null &&
                !isNaN(values[i]) && !isNaN(timeH[i])) {
                pts.push({ x: timeH[i], y: values[i] });
            }
        }
        return pts;
    }

    /**
     * Compute y-axis limits from reference tracks (truth + sgp4),
     * adding padding. EKF divergence is intentionally allowed to
     * exceed these bounds, but we clamp the axis to keep the
     * nominal regime readable with the divergence visible at the edge.
     */
    function computeYLimits(chartTimeSeries, field) {
        var allVals = [];
        // Use truth and sgp4 to define the "nominal" range
        ['truth', 'sgp4'].forEach(function (key) {
            var ts = chartTimeSeries[key];
            if (!ts) return;
            var arr = ts[field];
            for (var i = 0; i < arr.length; i++) {
                if (arr[i] !== null && !isNaN(arr[i])) {
                    allVals.push(arr[i]);
                }
            }
        });
        if (allVals.length === 0) return { min: undefined, max: undefined };

        allVals.sort(function (a, b) { return a - b; });
        var nomMin = allVals[0];
        var nomMax = allVals[allVals.length - 1];
        var span = nomMax - nomMin;

        // Extend range by 80% so EKF divergence is partially visible
        // but doesn't crush the nominal-regime detail
        return {
            min: nomMin - span * 0.8,
            max: nomMax + span * 0.8
        };
    }

    /**
     * Build or rebuild both Range and Range-Rate charts from orbitData.
     * Uses scatter-line rendering with a linear time x-axis so tracks
     * with different sample rates (truth 600s, ekf 800s, sgp4 600s)
     * are temporally aligned correctly.
     */
    function buildRangeCharts() {
        if (!orbitData) return;

        // Pre-compute time series for each track type
        chartTimeSeries = {};
        var trackTypes = ['truth', 'ekf', 'sgp4'];
        for (var i = 0; i < trackTypes.length; i++) {
            var key = trackTypes[i];
            if (orbitData[key]) {
                chartTimeSeries[key] = computeRangeTimeSeries(orbitData[key]);
            }
        }

        // Determine max time for x-axis
        var maxTimeH = 0;
        for (var k in chartTimeSeries) {
            var ts = chartTimeSeries[k];
            if (!ts) continue;
            for (var j = ts.time_h.length - 1; j >= 0; j--) {
                if (ts.time_h[j] !== null) {
                    if (ts.time_h[j] > maxTimeH) maxTimeH = ts.time_h[j];
                    break;
                }
            }
        }

        // Dataset colors matching the track styles
        var dsConfig = {
            truth: { label: 'Truth (GPU RK4)', color: '#FF4444', dash: [] },
            ekf:   { label: 'EKF Estimated',   color: '#4488FF', dash: [8, 6] },
            sgp4:  { label: 'SGP4 (Toolbox)',   color: '#44BB44', dash: [4, 8] }
        };

        // Build scatter datasets for Range and Range-Rate
        var rangeDatasets = [];
        var rangeRateDatasets = [];

        for (var t = 0; t < trackTypes.length; t++) {
            var tt = trackTypes[t];
            var tsd = chartTimeSeries[tt];
            var cfg = dsConfig[tt];
            if (!tsd) continue;

            rangeDatasets.push({
                label: cfg.label,
                data: toScatterData(tsd.time_h, tsd.range_km),
                borderColor: cfg.color,
                backgroundColor: 'transparent',
                borderWidth: 2,
                borderDash: cfg.dash,
                pointRadius: 0,
                tension: 0.1,
                showLine: true,
                trackType: tt
            });

            rangeRateDatasets.push({
                label: cfg.label,
                data: toScatterData(tsd.time_h, tsd.range_rate_kms),
                borderColor: cfg.color,
                backgroundColor: 'transparent',
                borderWidth: 2,
                borderDash: cfg.dash,
                pointRadius: 0,
                tension: 0.1,
                showLine: true,
                trackType: tt
            });
        }

        // Compute y-axis bounds from nominal tracks (truth + sgp4)
        var rangeLimits = computeYLimits(chartTimeSeries, 'range_km');
        var rrLimits = computeYLimits(chartTimeSeries, 'range_rate_kms');

        // Destroy existing charts
        if (rangeChart) { rangeChart.destroy(); rangeChart = null; }
        if (rangeRateChart) { rangeRateChart.destroy(); rangeRateChart = null; }

        // Create Range chart
        var rangeCtx = document.getElementById('chart-range');
        if (rangeCtx) {
            var rangeOpts = buildChartOptions('Altitude (km)', rangeLimits.min, rangeLimits.max);
            rangeOpts.scales.x.max = maxTimeH;
            rangeChart = new Chart(rangeCtx.getContext('2d'), {
                type: 'scatter',
                data: { datasets: rangeDatasets },
                options: rangeOpts
            });
        }

        // Create Range-Rate chart
        var rrCtx = document.getElementById('chart-range-rate');
        if (rrCtx) {
            var rrOpts = buildChartOptions('Range-Rate (km/s)', rrLimits.min, rrLimits.max);
            rrOpts.scales.x.max = maxTimeH;
            rangeRateChart = new Chart(rrCtx.getContext('2d'), {
                type: 'scatter',
                data: { datasets: rangeRateDatasets },
                options: rrOpts
            });
        }
    }

    /**
     * Update the vertical cursor line position on both charts.
     * Converts the animation frame to time (hours) for the linear x-axis.
     * Throttled during animation to avoid excessive redraws.
     */
    var lastChartUpdateFrame = -1;
    function updateChartCursor(frame) {
        // Skip if cursor hasn't moved enough (throttle during animation)
        var origIdx = mapFrameToOrigIdx(frame);
        if (animating && Math.abs(origIdx - lastChartUpdateFrame) < 1) return;
        lastChartUpdateFrame = origIdx;

        // Look up time from truth track (reference)
        var timeH = 0;
        if (orbitData && orbitData.truth && orbitData.truth.time_s) {
            var tIdx = Math.min(origIdx, orbitData.truth.time_s.length - 1);
            var tSec = orbitData.truth.time_s[tIdx];
            if (tSec !== null && tSec !== undefined) {
                timeH = tSec / 3600.0;
            }
        }

        if (rangeChart) {
            rangeChart.options.plugins.cursorLine.timeH = timeH;
            rangeChart.update('none');
        }
        if (rangeRateChart) {
            rangeRateChart.options.plugins.cursorLine.timeH = timeH;
            rangeRateChart.update('none');
        }
    }

    /**
     * Toggle chart dataset visibility for a given track type.
     */
    function setChartTrackVisible(trackType, visible) {
        [rangeChart, rangeRateChart].forEach(function (chart) {
            if (!chart) return;
            for (var i = 0; i < chart.data.datasets.length; i++) {
                if (chart.data.datasets[i].trackType === trackType) {
                    chart.setDatasetVisibility(i, visible);
                }
            }
            chart.update('none');
        });
    }

    /**
     * Toggle visibility of a track type (truth, ekf, sgp4).
     * Hides/shows polylines and the animated marker.
     */
    function setTrackVisible(trackType, visible) {
        for (var i = 0; i < trackDataSets.length; i++) {
            var td = trackDataSets[i];
            if (td.type === trackType) {
                td.visible = visible;
                // Toggle polylines
                for (var j = 0; j < td.polylines.length; j++) {
                    if (visible) {
                        if (!trackLayer.hasLayer(td.polylines[j])) {
                            trackLayer.addLayer(td.polylines[j]);
                        }
                    } else {
                        trackLayer.removeLayer(td.polylines[j]);
                    }
                }
                // Toggle marker
                if (visible) {
                    if (!markerLayer.hasLayer(td.marker)) {
                        markerLayer.addLayer(td.marker);
                    }
                } else {
                    markerLayer.removeLayer(td.marker);
                }
                break;
            }
        }

        // Also toggle chart dataset visibility
        setChartTrackVisible(trackType, visible);
    }

    return {
        initMap: initMap,
        loadMultiTracks: loadMultiTracks,
        clearTracks: clearTracks,
        isInitialized: isInitialized,
        invalidateSize: invalidateSize,
        startAnimation: startAnimation,
        pauseAnimation: pauseAnimation,
        setAnimFrame: setAnimFrame,
        getAnimFrame: getAnimFrame,
        getMaxFrames: getMaxFrames,
        setAnimSpeedFromSlider: setAnimSpeedFromSlider,
        setScrubberDragging: setScrubberDragging,
        setTrackVisible: setTrackVisible,
        setChartTrackVisible: setChartTrackVisible
    };
})();
