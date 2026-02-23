/**
 * LEO Constellation Digital Twin — 3D Orbit Visualization
 *
 * Renders Earth sphere with orbit tracks using Three.js.
 * Supports truth (red), EKF estimated (blue), and SGP4 validation (green)
 * trajectories with animated position markers.
 */

var Orbit3D = (function () {
    'use strict';

    var RE_KM = 6371.0;  // Earth radius in km (ECI data exported in km)
    var SCALE = 1.0 / RE_KM;  // Normalize so Earth = unit sphere
    var ARTIFACT_BASE = 'data/artifacts';
    var OMEGA_EARTH = 7.2921159e-5;  // Earth sidereal rotation rate [rad/s]

    var scene, camera, renderer, controls;
    var earthGroup;  // Group that rotates with Earth (mesh + wireframe + equator)
    var earthMesh;
    var trackGroups = [];  // {line, marker, points, color, name, groundLine, visible, groundVisible}
    var animationId = null;
    var animating = false;
    var animFrame = 0;
    var animSpeed = 0.15;  // Points per frame (fractional for smooth slow motion)
    var initialized = false;
    var timeLabel = null;
    var currentData = null;
    var groundTracksVisible = true;  // Master toggle for all ground tracks

    function initScene(containerId) {
        if (initialized) return;

        var container = document.getElementById(containerId);
        if (!container) return;

        var w = container.clientWidth;
        var h = container.clientHeight || 600;

        // Scene
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0d1117);

        // Camera
        camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 100);
        camera.position.set(0, 0, 4);

        // Renderer
        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(w, h);
        renderer.setPixelRatio(window.devicePixelRatio);
        container.appendChild(renderer.domElement);

        // Controls
        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.minDistance = 1.5;
        controls.maxDistance = 20;

        // Lights
        var ambientLight = new THREE.AmbientLight(0x404060, 1.0);
        scene.add(ambientLight);
        var dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
        dirLight.position.set(5, 3, 5);
        scene.add(dirLight);

        // Earth group — rotates as a unit to simulate sidereal rotation
        // Orbits are in ECI (inertial frame), so the Earth must rotate
        // underneath to match geographic coordinates from eci2latlon.
        earthGroup = new THREE.Group();
        scene.add(earthGroup);

        // Earth sphere with topographic texture
        var earthGeo = new THREE.SphereGeometry(1, 64, 64);
        var earthMat = new THREE.MeshPhongMaterial({
            color: 0x1a3a5c,
            emissive: 0x050a12,
            specular: 0x333355,
            shininess: 15,
            transparent: true,
            opacity: 0.92
        });
        earthMesh = new THREE.Mesh(earthGeo, earthMat);
        earthGroup.add(earthMesh);

        // Load Earth texture (Blue Marble from NASA — public domain)
        var textureLoader = new THREE.TextureLoader();
        textureLoader.load(
            'https://unpkg.com/three-globe@2.24.4/example/img/earth-blue-marble.jpg',
            function (texture) {
                earthMesh.material = new THREE.MeshPhongMaterial({
                    map: texture,
                    specular: 0x222244,
                    shininess: 10,
                    transparent: true,
                    opacity: 0.95
                });
                earthMesh.material.needsUpdate = true;
            },
            undefined,
            function () {
                // Texture load failed — keep solid blue sphere
                console.warn('Earth texture unavailable, using solid sphere.');
            }
        );

        // Wireframe grid for Earth surface (rotates with Earth)
        var wireGeo = new THREE.SphereGeometry(1.002, 36, 18);
        var wireMat = new THREE.MeshBasicMaterial({
            color: 0x2a5a8a,
            wireframe: true,
            transparent: true,
            opacity: 0.15
        });
        var wireframe = new THREE.Mesh(wireGeo, wireMat);
        earthGroup.add(wireframe);

        // Equator ring (fixed in inertial frame — doesn't rotate with Earth)
        var eqGeo = new THREE.RingGeometry(1.003, 1.006, 128);
        var eqMat = new THREE.MeshBasicMaterial({
            color: 0x3a7abd,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.4
        });
        var equator = new THREE.Mesh(eqGeo, eqMat);
        equator.rotation.x = Math.PI / 2;
        scene.add(equator);  // Equator stays in inertial frame

        // Axis indicator (Z-axis = Earth rotation)
        var axisGeo = new THREE.CylinderGeometry(0.005, 0.005, 3, 8);
        var axisMat = new THREE.MeshBasicMaterial({
            color: 0x555577,
            transparent: true,
            opacity: 0.3
        });
        var axis = new THREE.Mesh(axisGeo, axisMat);
        scene.add(axis);

        // Time label overlay
        timeLabel = document.createElement('div');
        timeLabel.style.cssText = 'position:absolute;bottom:12px;left:12px;' +
            'color:#8b949e;font-size:13px;font-family:monospace;' +
            'background:rgba(13,17,23,0.8);padding:4px 10px;border-radius:4px;';
        timeLabel.textContent = 'Time: —';
        container.style.position = 'relative';
        container.appendChild(timeLabel);

        // Resize handler
        window.addEventListener('resize', function () {
            var w2 = container.clientWidth;
            var h2 = container.clientHeight || 600;
            camera.aspect = w2 / h2;
            camera.updateProjectionMatrix();
            renderer.setSize(w2, h2);
        });

        initialized = true;
        renderLoop();
    }

    function renderLoop() {
        animationId = requestAnimationFrame(renderLoop);
        controls.update();

        if (animating) {
            advanceAnimation();
        }

        renderer.render(scene, camera);
    }

    function eciToThreeJS(x_km, y_km, z_km) {
        // ECI: X=vernal equinox, Y=90deg east, Z=north pole
        // Three.js: Y-up convention
        // Map: ECI_X -> Three_X, ECI_Z -> Three_Y, ECI_Y -> Three_Z
        return new THREE.Vector3(
            x_km * SCALE,
            z_km * SCALE,
            y_km * SCALE
        );
    }

    function drawOrbitTrack(eciData, colorHex, name) {
        var points = [];
        var n = eciData.eci_x.length;

        for (var i = 0; i < n; i++) {
            // Skip null/NaN entries (satellite may have re-entered)
            if (eciData.eci_x[i] === null || eciData.eci_y[i] === null ||
                eciData.eci_z[i] === null) {
                break;  // All subsequent entries will also be null
            }
            var pt = eciToThreeJS(eciData.eci_x[i], eciData.eci_y[i], eciData.eci_z[i]);
            points.push(pt);
        }

        // Orbit line
        var geometry = new THREE.BufferGeometry().setFromPoints(points);
        var material = new THREE.LineBasicMaterial({
            color: colorHex,
            linewidth: 2,
            transparent: true,
            opacity: 0.85
        });
        var line = new THREE.Line(geometry, material);
        scene.add(line);

        // Position marker sphere
        var markerGeo = new THREE.SphereGeometry(0.025, 16, 16);
        var markerMat = new THREE.MeshBasicMaterial({
            color: colorHex,
            transparent: true,
            opacity: 1.0
        });
        var marker = new THREE.Mesh(markerGeo, markerMat);
        if (points.length > 0) {
            marker.position.copy(points[0]);
        }
        scene.add(marker);

        // Glow effect for marker
        var glowGeo = new THREE.SphereGeometry(0.04, 16, 16);
        var glowMat = new THREE.MeshBasicMaterial({
            color: colorHex,
            transparent: true,
            opacity: 0.3
        });
        var glow = new THREE.Mesh(glowGeo, glowMat);
        marker.add(glow);

        // Build a time array matching the valid points (truncated at first null)
        var validTimes = [];
        var allTimes = eciData.time_s || [];
        for (var ti = 0; ti < points.length && ti < allTimes.length; ti++) {
            validTimes.push(allTimes[ti] !== null ? allTimes[ti] : 0);
        }

        // Ground track: project orbit onto Earth surface (ECEF, rotates with Earth)
        // Uses lat/lon from data if available, otherwise projects ECI radially
        var groundLine = null;
        if (eciData.lat && eciData.lon) {
            groundLine = createGroundTrackFromLatLon(
                eciData.lat, eciData.lon, colorHex);
        } else {
            groundLine = createGroundTrackFromECI(
                eciData.eci_x, eciData.eci_y, eciData.eci_z,
                allTimes, colorHex);
        }
        if (groundLine) {
            groundLine.visible = groundTracksVisible;
        }

        trackGroups.push({
            line: line,
            marker: marker,
            points: points,
            times: validTimes,
            color: colorHex,
            name: name,
            groundLine: groundLine,
            visible: true,
            groundVisible: groundTracksVisible
        });
    }

    function createGroundTrackFromLatLon(latArr, lonArr, colorHex) {
        // Convert lat/lon (degrees) to ECEF on the unit sphere
        // This is added to earthGroup so it rotates with the Earth texture
        var SURFACE_R = 1.004;  // Slightly above surface for visibility
        var segments = [];
        var current = [];
        var prevLon = null;

        for (var i = 0; i < latArr.length; i++) {
            // Skip null/NaN entries (satellite may have re-entered)
            if (latArr[i] === null || lonArr[i] === null ||
                isNaN(latArr[i]) || isNaN(lonArr[i])) {
                // End current segment at null boundary
                if (current.length >= 2) segments.push(current);
                current = [];
                prevLon = null;
                continue;
            }

            var latRad = latArr[i] * Math.PI / 180;
            var lonRad = lonArr[i] * Math.PI / 180;

            // ECEF coordinates on unit sphere:
            // x = cos(lat)*cos(lon), y = cos(lat)*sin(lon), z = sin(lat)
            // Map to Three.js Y-up: Three_X=ECEF_X, Three_Y=ECEF_Z, Three_Z=ECEF_Y
            var cx = SURFACE_R * Math.cos(latRad) * Math.cos(lonRad);
            var cy = SURFACE_R * Math.cos(latRad) * Math.sin(lonRad);
            var cz = SURFACE_R * Math.sin(latRad);

            // Split at antimeridian crossings (lon jump > 180 degrees)
            if (prevLon !== null && Math.abs(lonArr[i] - prevLon) > 180) {
                if (current.length >= 2) segments.push(current);
                current = [];
            }
            prevLon = lonArr[i];
            current.push(new THREE.Vector3(cx, cz, cy));
        }
        if (current.length >= 2) segments.push(current);

        // Create a Group to hold all segments
        var group = new THREE.Group();
        for (var s = 0; s < segments.length; s++) {
            var geo = new THREE.BufferGeometry().setFromPoints(segments[s]);
            var mat = new THREE.LineBasicMaterial({
                color: colorHex,
                transparent: true,
                opacity: 0.4,
                linewidth: 1
            });
            group.add(new THREE.Line(geo, mat));
        }
        earthGroup.add(group);
        return group;
    }

    function createGroundTrackFromECI(eciX, eciY, eciZ, timeS, colorHex) {
        // Fallback: project ECI positions to ECEF then onto Earth surface
        var SURFACE_R = 1.004;
        var segments = [];
        var current = [];
        var prevLon = null;

        for (var i = 0; i < eciX.length; i++) {
            // Skip null/NaN entries
            if (eciX[i] === null || eciY[i] === null || eciZ[i] === null ||
                isNaN(eciX[i]) || isNaN(eciY[i]) || isNaN(eciZ[i])) {
                if (current.length >= 2) segments.push(current);
                current = [];
                prevLon = null;
                continue;
            }

            var t = (timeS.length > i && timeS[i] !== null) ? timeS[i] : 0;
            var theta = OMEGA_EARTH * t;

            // Rotate ECI to ECEF: apply -theta around Z (ECI Z = north)
            var cosT = Math.cos(theta), sinT = Math.sin(theta);
            var ecefX = cosT * eciX[i] + sinT * eciY[i];
            var ecefY = -sinT * eciX[i] + cosT * eciY[i];
            var ecefZ = eciZ[i];

            // Normalize to unit sphere surface
            var r = Math.sqrt(ecefX * ecefX + ecefY * ecefY + ecefZ * ecefZ);
            if (r < 1) continue;
            var nx = SURFACE_R * ecefX / r;
            var ny = SURFACE_R * ecefY / r;
            var nz = SURFACE_R * ecefZ / r;

            // Compute lon for antimeridian split (> 180 degrees)
            var lon = Math.atan2(ecefY, ecefX) * 180 / Math.PI;
            if (prevLon !== null && Math.abs(lon - prevLon) > 180) {
                if (current.length >= 2) segments.push(current);
                current = [];
            }
            prevLon = lon;

            // Map ECEF to Three.js (Y-up): Three_X=ECEF_X, Three_Y=ECEF_Z, Three_Z=ECEF_Y
            current.push(new THREE.Vector3(nx, nz, ny));
        }
        if (current.length >= 2) segments.push(current);

        var group = new THREE.Group();
        for (var s = 0; s < segments.length; s++) {
            var geo = new THREE.BufferGeometry().setFromPoints(segments[s]);
            var mat = new THREE.LineBasicMaterial({
                color: colorHex,
                transparent: true,
                opacity: 0.4,
                linewidth: 1
            });
            group.add(new THREE.Line(geo, mat));
        }
        earthGroup.add(group);
        return group;
    }

    function clearTracks() {
        for (var i = 0; i < trackGroups.length; i++) {
            scene.remove(trackGroups[i].line);
            scene.remove(trackGroups[i].marker);
            trackGroups[i].line.geometry.dispose();
            trackGroups[i].line.material.dispose();
            // Remove ground track from earthGroup
            if (trackGroups[i].groundLine) {
                earthGroup.remove(trackGroups[i].groundLine);
                trackGroups[i].groundLine.traverse(function (child) {
                    if (child.geometry) child.geometry.dispose();
                    if (child.material) child.material.dispose();
                });
            }
        }
        trackGroups = [];
        animFrame = 0;
    }

    function loadOrbitData(satId) {
        clearTracks();

        return fetch(ARTIFACT_BASE + '/orbits/sat_' + satId + '_orbits.json')
            .then(function (r) {
                if (!r.ok) throw new Error('Failed to load orbit data for sat ' + satId);
                return r.json();
            })
            .then(function (data) {
                currentData = data;

                // Draw truth track (red)
                if (data.truth && data.truth.eci_x) {
                    drawOrbitTrack(data.truth, 0xFF4444, 'Truth');
                }

                // Draw EKF track (blue)
                if (data.ekf && data.ekf.eci_x) {
                    drawOrbitTrack(data.ekf, 0x4488FF, 'EKF Estimated');
                }

                // Draw SGP4 track (green)
                if (data.sgp4 && data.sgp4.eci_x) {
                    drawOrbitTrack(data.sgp4, 0x44BB44, 'SGP4 Validation');
                }

                // Reset camera to fit tracks
                camera.position.set(0, 1.5, 3.5);
                controls.target.set(0, 0, 0);
                controls.update();

                updateTimeLabel(0);
            })
            .catch(function (err) {
                console.warn('Orbit 3D:', err.message);
            });
    }

    function advanceAnimation() {
        if (trackGroups.length === 0) return;

        var maxLen = 0;
        for (var i = 0; i < trackGroups.length; i++) {
            if (trackGroups[i].points.length > maxLen) {
                maxLen = trackGroups[i].points.length;
            }
        }

        animFrame += animSpeed;
        if (animFrame >= maxLen) {
            animFrame = 0;
        }

        // Interpolate between track points for smooth sub-frame motion
        var floorIdx = Math.floor(animFrame);
        var frac = animFrame - floorIdx;

        for (var j = 0; j < trackGroups.length; j++) {
            var tg = trackGroups[j];
            var idx0 = Math.min(floorIdx, tg.points.length - 1);
            var idx1 = Math.min(idx0 + 1, tg.points.length - 1);

            if (frac > 0 && idx0 !== idx1) {
                tg.marker.position.lerpVectors(tg.points[idx0], tg.points[idx1], frac);
            } else {
                tg.marker.position.copy(tg.points[idx0]);
            }
        }

        updateTimeLabel(Math.floor(animFrame));
    }

    function updateTimeLabel(frame) {
        if (!timeLabel) return;

        // Use truth track time if available
        var timeSec = 0;
        if (trackGroups.length > 0 && trackGroups[0].times.length > 0) {
            var idx = Math.min(frame, trackGroups[0].times.length - 1);
            timeSec = trackGroups[0].times[idx];
        }
        var hours = (timeSec / 3600).toFixed(2);
        timeLabel.textContent = 'Time: ' + hours + ' h  |  Frame: ' + frame;

        // Rotate Earth to match sidereal rotation at current simulation time.
        // ECI Z-axis (north pole) maps to Three.js Y-axis, so Earth rotates
        // around Y. The rotation angle matches eci2latlon.m: theta = omega * t.
        // The Blue Marble texture has its seam (antimeridian) at the -X/+Z
        // boundary of the UV sphere, so we add a PI offset to align the
        // prime meridian (lon=0) with ECI X-axis at t=0.
        if (earthGroup) {
            var theta = OMEGA_EARTH * timeSec;
            earthGroup.rotation.y = theta + Math.PI;
        }

        // Update telemetry panel
        updateTelemetry(frame, timeSec);

        // Update scrubber slider position (if not user-dragging)
        var scrubber = document.getElementById('orbit3d-scrubber');
        if (scrubber && !scrubberDragging) {
            scrubber.value = frame;
            var label = document.getElementById('orbit3d-scrubber-label');
            if (label) label.textContent = frame + ' / ' + scrubber.max;
        }
    }

    var scrubberDragging = false;

    function updateTelemetry(frame, timeSec) {
        if (!currentData) return;

        var setVal = function (id, val) {
            var el = document.getElementById(id);
            if (el) el.textContent = val;
        };

        // Elapsed time
        var hrs = timeSec / 3600;
        setVal('telem-elapsed', hrs.toFixed(2) + ' h');

        // Epoch time (offset from simulation start)
        var totalSec = Math.floor(timeSec);
        var hh = String(Math.floor(totalSec / 3600)).padStart(2, '0');
        var mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
        var ss = String(totalSec % 60).padStart(2, '0');
        setVal('telem-time', 'T+' + hh + ':' + mm + ':' + ss);

        // Truth track telemetry
        var truth = currentData.truth;
        if (truth && truth.lat) {
            var tIdx = Math.min(frame, truth.lat.length - 1);

            // Guard against null entries (satellite may have re-entered)
            if (truth.lat[tIdx] !== null && truth.lon[tIdx] !== null) {
                setVal('telem-lat', truth.lat[tIdx].toFixed(2) + '°');
                setVal('telem-lon', truth.lon[tIdx].toFixed(2) + '°');
            }
            if (truth.alt_km[tIdx] !== null) {
                setVal('telem-alt', truth.alt_km[tIdx].toFixed(1) + ' km');
                // Range from nadir (Earth surface directly below)
                setVal('telem-range', truth.alt_km[tIdx].toFixed(1) + ' km');
                // Orbital period (from altitude using Kepler's 3rd law)
                var r_km = 6371.0 + truth.alt_km[tIdx];
                if (r_km > 0) {
                    var mu_km3s2 = 398600.4418;
                    var period_s = 2 * Math.PI * Math.sqrt(Math.pow(r_km, 3) / mu_km3s2);
                    setVal('telem-period', (period_s / 60).toFixed(1) + ' min');
                }
            }

            // Speed from ECI velocity (approximate from position differences)
            if (truth.eci_x && tIdx > 0 &&
                truth.eci_x[tIdx] !== null && truth.eci_x[tIdx - 1] !== null) {
                var dx = truth.eci_x[tIdx] - truth.eci_x[tIdx - 1];
                var dy = truth.eci_y[tIdx] - truth.eci_y[tIdx - 1];
                var dz = truth.eci_z[tIdx] - truth.eci_z[tIdx - 1];
                var dt = (truth.time_s[tIdx] - truth.time_s[tIdx - 1]);
                if (dt > 0) {
                    var speed_kms = Math.sqrt(dx * dx + dy * dy + dz * dz) / dt;
                    setVal('telem-speed', speed_kms.toFixed(2) + ' km/s');

                    // Inclination from orbit data (angular momentum at current point)
                    var rx = truth.eci_x[tIdx], ry = truth.eci_y[tIdx], rz = truth.eci_z[tIdx];
                    var vx = dx / dt, vy = dy / dt, vz = dz / dt;
                    var hx = ry * vz - rz * vy;
                    var hy = rz * vx - rx * vz;
                    var hz = rx * vy - ry * vx;
                    var hMag = Math.sqrt(hx * hx + hy * hy + hz * hz);
                    if (hMag > 0) {
                        var incl = Math.acos(Math.min(1, Math.abs(hz) / hMag)) * 180 / Math.PI;
                        setVal('telem-incl', incl.toFixed(1) + '°');
                    }
                }
            }
        }

        // EKF-Truth position error
        var ekf = currentData.ekf;
        if (ekf && ekf.eci_x && truth && truth.eci_x) {
            var eIdx = Math.min(frame, ekf.eci_x.length - 1);
            var tIdxE = Math.min(frame, truth.eci_x.length - 1);
            if (ekf.eci_x[eIdx] !== null && truth.eci_x[tIdxE] !== null) {
                var edx = ekf.eci_x[eIdx] - truth.eci_x[tIdxE];
                var edy = ekf.eci_y[eIdx] - truth.eci_y[tIdxE];
                var edz = ekf.eci_z[eIdx] - truth.eci_z[tIdxE];
                var errKm = Math.sqrt(edx * edx + edy * edy + edz * edz);
                setVal('telem-ekf-err', (errKm * 1000).toFixed(1) + ' m');
            }
        }

        // SGP4-Truth position error
        var sgp4 = currentData.sgp4;
        if (sgp4 && sgp4.eci_x && truth && truth.eci_x) {
            var sIdx = Math.min(frame, sgp4.eci_x.length - 1);
            var tIdxS = Math.min(frame, truth.eci_x.length - 1);
            if (sgp4.eci_x[sIdx] !== null && truth.eci_x[tIdxS] !== null) {
                var sdx = sgp4.eci_x[sIdx] - truth.eci_x[tIdxS];
                var sdy = sgp4.eci_y[sIdx] - truth.eci_y[tIdxS];
                var sdz = sgp4.eci_z[sIdx] - truth.eci_z[tIdxS];
                var sErrKm = Math.sqrt(sdx * sdx + sdy * sdy + sdz * sdz);
                setVal('telem-sgp4-err', (sErrKm * 1000).toFixed(1) + ' m');
            }
        }
    }

    function startAnimation() {
        animating = true;
    }

    function pauseAnimation() {
        animating = false;
    }

    function isInitialized() {
        return initialized;
    }

    function setAnimSpeed(speed) {
        // Speed slider maps 1-10 to 0.05-2.0 points per frame
        // 1 = ultra-slow (0.05 pts/frame, ~48 min for full orbit at 60fps)
        // 5 = moderate  (0.5 pts/frame, ~4.8 sec per orbit)
        // 10 = fast     (2.0 pts/frame, ~1.2 sec per orbit)
        animSpeed = Math.max(0.05, Math.min(2.0, speed));
    }

    function setAnimSpeedFromSlider(sliderVal) {
        // Map slider value (1-10) to exponential speed curve
        // 1 -> 0.05, 3 -> 0.15, 5 -> 0.5, 8 -> 1.0, 10 -> 2.0
        var t = (sliderVal - 1) / 9;  // 0 to 1
        animSpeed = 0.05 * Math.pow(40, t);  // Exponential: 0.05 to 2.0
    }

    function getAnimFrame() {
        return Math.floor(animFrame);
    }

    function setAnimFrame(frame) {
        animFrame = frame;
        var floorIdx = Math.floor(animFrame);
        for (var j = 0; j < trackGroups.length; j++) {
            var tg = trackGroups[j];
            var idx = Math.min(floorIdx, tg.points.length - 1);
            tg.marker.position.copy(tg.points[idx]);
        }
        updateTimeLabel(floorIdx);
    }

    function getMaxFrames() {
        var maxLen = 0;
        for (var i = 0; i < trackGroups.length; i++) {
            if (trackGroups[i].points.length > maxLen) {
                maxLen = trackGroups[i].points.length;
            }
        }
        return maxLen;
    }

    function getCurrentData() {
        return currentData;
    }

    /**
     * Toggle visibility of a specific orbit track by name.
     * @param {string} name - Track name ('Truth', 'EKF Estimated', 'SGP4 Validation')
     * @param {boolean} visible - Whether to show the track
     */
    function setTrackVisible(name, visible) {
        for (var i = 0; i < trackGroups.length; i++) {
            if (trackGroups[i].name === name) {
                trackGroups[i].visible = visible;
                trackGroups[i].line.visible = visible;
                trackGroups[i].marker.visible = visible;
                break;
            }
        }
    }

    /**
     * Toggle ground track visibility for a specific orbit track.
     * @param {string} name - Track name
     * @param {boolean} visible - Whether to show the ground track
     */
    function setGroundTrackVisible(name, visible) {
        for (var i = 0; i < trackGroups.length; i++) {
            if (trackGroups[i].name === name) {
                trackGroups[i].groundVisible = visible;
                if (trackGroups[i].groundLine) {
                    trackGroups[i].groundLine.visible = visible && groundTracksVisible;
                }
                break;
            }
        }
    }

    /**
     * Master toggle for all ground tracks.
     * @param {boolean} visible - Whether to show all ground tracks
     */
    function setAllGroundTracksVisible(visible) {
        groundTracksVisible = visible;
        for (var i = 0; i < trackGroups.length; i++) {
            if (trackGroups[i].groundLine) {
                trackGroups[i].groundLine.visible = visible && trackGroups[i].groundVisible;
            }
        }
    }

    /**
     * Get the list of track group descriptors (for building toggle UI).
     * @returns {Array} Array of {name, color, visible, groundVisible}
     */
    function getTrackInfo() {
        return trackGroups.map(function (tg) {
            return {
                name: tg.name,
                color: '#' + tg.color.toString(16).padStart(6, '0'),
                visible: tg.visible,
                groundVisible: tg.groundVisible
            };
        });
    }

    return {
        initScene: initScene,
        loadOrbitData: loadOrbitData,
        startAnimation: startAnimation,
        pauseAnimation: pauseAnimation,
        clearTracks: clearTracks,
        isInitialized: isInitialized,
        setAnimSpeed: setAnimSpeed,
        setAnimSpeedFromSlider: setAnimSpeedFromSlider,
        getAnimFrame: getAnimFrame,
        setAnimFrame: setAnimFrame,
        getMaxFrames: getMaxFrames,
        getCurrentData: getCurrentData,
        setTrackVisible: setTrackVisible,
        setGroundTrackVisible: setGroundTrackVisible,
        setAllGroundTracksVisible: setAllGroundTracksVisible,
        getTrackInfo: getTrackInfo
    };
})();
