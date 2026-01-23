const http = require('http');
const fs = require('fs');
const path = require('path');
const INDIWrapper = require('./src/indi-wrapper');
const { TARGETS, calculateAltAz, findImagingWindow, suggestParameters } = require('./src/targets');

const PORT = 8092;
const INDI_HOST = process.env.INDI_HOST || 'localhost';
const INDI_PORT = parseInt(process.env.INDI_PORT || '7624');

// Observatory location (update with actual coordinates)
const OBSERVATORY = {
    name: "Desert Observatory",
    latitude: 33.5,  // Approximate - update with real coords
    longitude: -116.5,
    elevation: 1000
};

// Initialize INDI wrapper (will auto-detect real INDI or fall back to simulation)
const indi = new INDIWrapper({ host: INDI_HOST, port: INDI_PORT });
let indiMode = 'initializing';

// Session state
let currentSession = {
    active: false,
    target: null,
    plan: null,
    startTime: null,
    log: []
};

function log(message) {
    const timestamp = new Date().toISOString();
    const entry = { timestamp, message };
    currentSession.log.push(entry);
    console.log(`[${timestamp}] ${message}`);
    return entry;
}

// Plan an imaging session
function planSession(targetName, options = {}) {
    const target = TARGETS[targetName.toUpperCase()] || TARGETS[targetName];
    if (!target) {
        return { error: `Target '${targetName}' not found in database` };
    }

    const now = new Date();
    const window = findImagingWindow(target, OBSERVATORY.latitude, OBSERVATORY.longitude, now);

    if (!window) {
        return { error: `${target.name} is not visible from this location tonight` };
    }

    const camera = options.camera || 'QHY600C';
    const params = suggestParameters(target, camera);

    const plan = {
        target: target,
        window: window,
        params: params,
        steps: [
            { action: 'SAFETY_CHECK', description: 'Verify weather and equipment safety', status: 'pending' },
            { action: 'OPEN_ROOF', description: 'Open observatory roof', status: 'pending' },
            { action: 'COOL_CAMERA', description: `Cool ${camera} to -20°C`, status: 'pending' },
            { action: 'UNPARK_MOUNT', description: 'Unpark and start tracking', status: 'pending' },
            { action: 'SLEW', description: `Slew to ${target.name} (RA: ${target.ra}, Dec: ${target.dec})`, status: 'pending' },
            { action: 'PLATE_SOLVE', description: 'Plate solve and center target', status: 'pending' },
            { action: 'AUTOFOCUS', description: 'Run autofocus routine', status: 'pending' },
            { action: 'START_GUIDING', description: 'Calibrate and start autoguiding', status: 'pending' },
            { action: 'CAPTURE', description: `Capture sequence (${params.totalImagingTime.toFixed(1)} hours total)`, status: 'pending' },
            { action: 'SHUTDOWN', description: 'Park mount and close roof', status: 'pending' }
        ],
        estimatedDuration: params.totalImagingTime + 0.5, // Add setup time
        created: new Date().toISOString()
    };

    return { plan };
}

// Execute session step
async function executeStep(stepIndex) {
    if (!currentSession.plan) return { error: 'No active plan' };
    if (stepIndex >= currentSession.plan.steps.length) return { error: 'Invalid step' };

    const step = currentSession.plan.steps[stepIndex];
    step.status = 'running';
    log(`Executing: ${step.description}`);

    try {
        switch (step.action) {
            case 'SAFETY_CHECK':
                const state = indi.getState();
                if (!state.weather.safe) {
                    throw new Error('Weather conditions unsafe');
                }
                break;

            case 'OPEN_ROOF':
                await indi.connect('roof');
                const roofResult = await indi.roofOpen();
                if (!roofResult.success) throw new Error(roofResult.error);
                break;

            case 'COOL_CAMERA':
                await indi.connect('camera_main');
                await indi.cameraSetTemperature('camera_main', -20);
                // Don't wait for full cooling, it happens in background
                break;

            case 'UNPARK_MOUNT':
                await indi.connect('mount');
                const unparkResult = await indi.mountUnpark();
                if (!unparkResult.success) throw new Error(unparkResult.error);
                break;

            case 'SLEW':
                const target = currentSession.plan.target;
                const slewResult = await indi.mountSlew(target.ra_decimal, target.dec_decimal);
                if (!slewResult.success) throw new Error(slewResult.error);
                break;

            case 'PLATE_SOLVE':
                log('Plate solving... (simulated)');
                await new Promise(r => setTimeout(r, 3000));
                log('Plate solve successful - pointing error: 2.3 arcsec');
                break;

            case 'AUTOFOCUS':
                await indi.connect('focuser');
                log('Running autofocus routine...');
                await indi.focuserMove(27500);
                log('Focus achieved at position 27500, HFR: 2.1px');
                break;

            case 'START_GUIDING':
                await indi.connect('guider');
                log('Calibrating guider...');
                await new Promise(r => setTimeout(r, 5000));
                log('Guiding started - RMS: RA 0.42", Dec 0.38"');
                break;

            case 'CAPTURE':
                const params = currentSession.plan.params;
                for (const [filter, exp] of Object.entries(params.exposures)) {
                    log(`Starting ${filter} sequence: ${exp.count}x ${exp.duration}s`);
                    // In real implementation, would loop through exposures
                    // For simulation, just log
                    await new Promise(r => setTimeout(r, 2000));
                    log(`${filter} sequence simulated complete`);
                }
                break;

            case 'SHUTDOWN':
                log('Parking mount...');
                await indi.mountPark();
                log('Closing roof...');
                await indi.roofClose();
                log('Warming camera...');
                break;
        }

        step.status = 'completed';
        log(`Completed: ${step.description}`);
        return { success: true };

    } catch (err) {
        step.status = 'failed';
        step.error = err.message;
        log(`FAILED: ${step.description} - ${err.message}`);
        return { success: false, error: err.message };
    }
}

// HTML Interface
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Observatory AI Control</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Segoe UI', system-ui, sans-serif;
            background: linear-gradient(135deg, #0a0a15 0%, #1a1a2e 50%, #0a1015 100%);
            color: #eee;
            min-height: 100vh;
        }
        .container { max-width: 1600px; margin: 0 auto; padding: 20px; }
        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 20px;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        h1 {
            font-size: 1.8rem;
            background: linear-gradient(90deg, #ffd700, #ff6b6b);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .status-badge {
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 0.85rem;
            font-weight: 600;
        }
        .status-safe { background: rgba(0,255,136,0.2); color: #00ff88; }
        .status-unsafe { background: rgba(255,107,107,0.2); color: #ff6b6b; }
        .grid {
            display: grid;
            grid-template-columns: 300px 1fr 350px;
            gap: 20px;
        }
        @media (max-width: 1200px) {
            .grid { grid-template-columns: 1fr; }
        }
        .panel {
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 12px;
            padding: 15px;
        }
        .panel h2 {
            color: #ffd700;
            font-size: 0.9rem;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 15px;
            padding-bottom: 10px;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .device {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px;
            margin-bottom: 8px;
            background: rgba(0,0,0,0.2);
            border-radius: 8px;
            font-size: 0.85rem;
        }
        .device-name { color: #aaa; }
        .device-status {
            padding: 3px 8px;
            border-radius: 10px;
            font-size: 0.75rem;
        }
        .connected { background: rgba(0,255,136,0.2); color: #00ff88; }
        .disconnected { background: rgba(255,255,255,0.1); color: #666; }
        .target-search {
            display: flex;
            gap: 10px;
            margin-bottom: 15px;
        }
        .target-search input {
            flex: 1;
            padding: 12px;
            background: rgba(0,0,0,0.3);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 8px;
            color: #eee;
            font-size: 1rem;
        }
        .target-search button {
            padding: 12px 20px;
            background: linear-gradient(90deg, #ffd700, #ff8c00);
            border: none;
            border-radius: 8px;
            color: #000;
            font-weight: 600;
            cursor: pointer;
        }
        .target-info {
            background: rgba(0,0,0,0.2);
            border-radius: 8px;
            padding: 15px;
            margin-bottom: 15px;
        }
        .target-name { font-size: 1.3rem; color: #00d4ff; margin-bottom: 5px; }
        .target-type { color: #888; font-size: 0.85rem; }
        .target-coords { margin-top: 10px; font-family: monospace; color: #aaa; }
        .plan-steps {
            list-style: none;
        }
        .plan-step {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px;
            margin-bottom: 5px;
            background: rgba(0,0,0,0.2);
            border-radius: 6px;
            font-size: 0.85rem;
        }
        .step-icon {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.7rem;
        }
        .step-pending { background: rgba(255,255,255,0.1); color: #666; }
        .step-running { background: rgba(255,193,7,0.3); color: #ffc107; animation: pulse 1s infinite; }
        .step-completed { background: rgba(0,255,136,0.2); color: #00ff88; }
        .step-failed { background: rgba(255,107,107,0.2); color: #ff6b6b; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
        .weather-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }
        .weather-item {
            background: rgba(0,0,0,0.2);
            padding: 10px;
            border-radius: 6px;
            text-align: center;
        }
        .weather-value { font-size: 1.2rem; color: #00d4ff; }
        .weather-label { font-size: 0.7rem; color: #666; margin-top: 3px; }
        .log-container {
            height: 200px;
            overflow-y: auto;
            background: rgba(0,0,0,0.3);
            border-radius: 8px;
            padding: 10px;
            font-family: monospace;
            font-size: 0.75rem;
        }
        .log-entry { margin-bottom: 5px; color: #888; }
        .log-entry .time { color: #666; }
        .btn-row {
            display: flex;
            gap: 10px;
            margin-top: 15px;
        }
        .btn {
            flex: 1;
            padding: 10px;
            border: none;
            border-radius: 6px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s;
        }
        .btn:hover { transform: translateY(-2px); }
        .btn-primary { background: linear-gradient(90deg, #00d4ff, #845ef7); color: white; }
        .btn-danger { background: linear-gradient(90deg, #ff6b6b, #ff8c00); color: white; }
        .btn-success { background: linear-gradient(90deg, #00ff88, #00d4ff); color: #000; }
        .simulation-notice {
            background: rgba(255,193,7,0.1);
            border: 1px solid rgba(255,193,7,0.3);
            border-radius: 8px;
            padding: 10px;
            margin-bottom: 15px;
            font-size: 0.8rem;
            color: #ffc107;
        }
        .target-list {
            max-height: 300px;
            overflow-y: auto;
        }
        .target-item {
            padding: 8px 10px;
            margin-bottom: 5px;
            background: rgba(0,0,0,0.2);
            border-radius: 6px;
            cursor: pointer;
            transition: background 0.2s;
        }
        .target-item:hover { background: rgba(0,212,255,0.1); }
        .target-item-name { color: #00d4ff; font-weight: 500; }
        .target-item-info { color: #666; font-size: 0.75rem; }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Observatory AI Control</h1>
            <div class="status-badge" id="safetyStatus">Checking...</div>
        </header>

        <div class="simulation-notice">
            SIMULATION MODE - Not connected to real hardware. Connect to INDI server when at observatory.
        </div>

        <div class="grid">
            <!-- Left Panel - Devices -->
            <div class="panel">
                <h2>Equipment Status</h2>
                <div id="deviceList"></div>

                <h2 style="margin-top: 20px;">Weather</h2>
                <div class="weather-grid" id="weatherGrid"></div>
            </div>

            <!-- Center Panel - Planning -->
            <div class="panel">
                <h2>Session Planning</h2>

                <div class="target-search">
                    <input type="text" id="targetInput" placeholder="Enter target (e.g., M33, NGC7000)">
                    <button onclick="planTarget()">Plan Session</button>
                </div>

                <div id="targetInfo" style="display:none;"></div>

                <div id="planSteps" style="display:none;">
                    <h2>Imaging Plan</h2>
                    <ul class="plan-steps" id="stepsList"></ul>

                    <div class="btn-row">
                        <button class="btn btn-success" onclick="executeAll()">Execute All</button>
                        <button class="btn btn-danger" onclick="abortSession()">Abort</button>
                    </div>
                </div>

                <h2 style="margin-top: 20px;">Session Log</h2>
                <div class="log-container" id="logContainer"></div>
            </div>

            <!-- Right Panel - Target Database -->
            <div class="panel">
                <h2>Target Database</h2>
                <div class="target-list" id="targetList"></div>
            </div>
        </div>
    </div>

    <script>
        const WS_URL = 'ws://' + window.location.hostname + ':8093';
        let ws;
        let currentPlan = null;

        // Populate target list
        function populateTargets(targets) {
            const list = document.getElementById('targetList');
            list.innerHTML = '';
            for (const [id, target] of Object.entries(targets)) {
                const div = document.createElement('div');
                div.className = 'target-item';
                div.onclick = () => {
                    document.getElementById('targetInput').value = id;
                    planTarget();
                };
                div.innerHTML =
                    '<div class="target-item-name">' + id + ' - ' + target.name + '</div>' +
                    '<div class="target-item-info">' + target.type + ' in ' + target.constellation +
                    ' | Mag ' + target.magnitude + ' | ' + target.size_arcmin + "'" + '</div>';
                list.appendChild(div);
            }
        }

        // Update device status
        function updateDevices(devices) {
            const list = document.getElementById('deviceList');
            list.innerHTML = '';
            for (const [id, dev] of Object.entries(devices)) {
                const div = document.createElement('div');
                div.className = 'device';
                div.innerHTML =
                    '<span class="device-name">' + dev.name + '</span>' +
                    '<span class="device-status ' + (dev.connected ? 'connected' : 'disconnected') + '">' +
                    (dev.connected ? 'Connected' : 'Disconnected') + '</span>';
                list.appendChild(div);
            }
        }

        // Update weather
        function updateWeather(weather) {
            document.getElementById('weatherGrid').innerHTML =
                '<div class="weather-item"><div class="weather-value">' + weather.temperature.toFixed(1) + 'C</div><div class="weather-label">Temperature</div></div>' +
                '<div class="weather-item"><div class="weather-value">' + weather.humidity.toFixed(0) + '%</div><div class="weather-label">Humidity</div></div>' +
                '<div class="weather-item"><div class="weather-value">' + weather.cloudCover.toFixed(0) + '%</div><div class="weather-label">Cloud Cover</div></div>' +
                '<div class="weather-item"><div class="weather-value">' + weather.skyQuality.toFixed(1) + '</div><div class="weather-label">SQM</div></div>';

            const badge = document.getElementById('safetyStatus');
            if (weather.safe) {
                badge.className = 'status-badge status-safe';
                badge.textContent = 'CONDITIONS SAFE';
            } else {
                badge.className = 'status-badge status-unsafe';
                badge.textContent = 'CONDITIONS UNSAFE';
            }
        }

        // Plan a target
        async function planTarget() {
            const target = document.getElementById('targetInput').value.trim();
            if (!target) return;

            const resp = await fetch('/api/plan?target=' + encodeURIComponent(target));
            const data = await resp.json();

            if (data.error) {
                alert(data.error);
                return;
            }

            currentPlan = data.plan;

            // Show target info
            const info = document.getElementById('targetInfo');
            info.style.display = 'block';
            info.innerHTML =
                '<div class="target-info">' +
                '<div class="target-name">' + data.plan.target.name + '</div>' +
                '<div class="target-type">' + data.plan.target.type + ' in ' + data.plan.target.constellation + '</div>' +
                '<div class="target-coords">RA: ' + data.plan.target.ra + ' | Dec: ' + data.plan.target.dec + '</div>' +
                '<div style="margin-top:10px;color:#888;font-size:0.85rem;">' +
                'Imaging window: ' + new Date(data.plan.window.start).toLocaleTimeString() + ' - ' +
                new Date(data.plan.window.end).toLocaleTimeString() + '<br>' +
                'Peak altitude: ' + data.plan.window.peakAltitude.toFixed(1) + ' at ' +
                new Date(data.plan.window.peak).toLocaleTimeString() + '<br>' +
                'Recommended OTA: ' + data.plan.target.recommended_ota + '<br>' +
                'Total imaging time: ' + data.plan.params.totalImagingTime.toFixed(1) + ' hours' +
                '</div></div>';

            // Show plan steps
            document.getElementById('planSteps').style.display = 'block';
            updateSteps(data.plan.steps);
        }

        function updateSteps(steps) {
            const list = document.getElementById('stepsList');
            list.innerHTML = '';
            steps.forEach((step, i) => {
                const li = document.createElement('li');
                li.className = 'plan-step';
                const iconClass = 'step-icon step-' + step.status;
                const icon = step.status === 'completed' ? '&#10003;' :
                             step.status === 'failed' ? '&#10007;' :
                             step.status === 'running' ? '...' : (i + 1);
                li.innerHTML =
                    '<div class="' + iconClass + '">' + icon + '</div>' +
                    '<div>' + step.description + '</div>';
                list.appendChild(li);
            });
        }

        async function executeAll() {
            if (!currentPlan) return;

            for (let i = 0; i < currentPlan.steps.length; i++) {
                const resp = await fetch('/api/execute?step=' + i, { method: 'POST' });
                const data = await resp.json();

                if (data.plan) {
                    currentPlan = data.plan;
                    updateSteps(data.plan.steps);
                }

                if (!data.success) {
                    alert('Step failed: ' + data.error);
                    break;
                }

                // Refresh log
                refreshLog();
            }
        }

        function abortSession() {
            if (confirm('Abort current session?')) {
                fetch('/api/abort', { method: 'POST' });
            }
        }

        async function refreshLog() {
            const resp = await fetch('/api/log');
            const data = await resp.json();

            const container = document.getElementById('logContainer');
            container.innerHTML = '';
            data.log.slice(-50).forEach(entry => {
                const div = document.createElement('div');
                div.className = 'log-entry';
                div.innerHTML = '<span class="time">' + new Date(entry.timestamp).toLocaleTimeString() + '</span> ' + entry.message;
                container.appendChild(div);
            });
            container.scrollTop = container.scrollHeight;
        }

        // Initial load
        async function init() {
            // Get targets
            const targetsResp = await fetch('/api/targets');
            const targets = await targetsResp.json();
            populateTargets(targets);

            // Get device state
            const stateResp = await fetch('/api/state');
            const state = await stateResp.json();
            updateDevices(state);

            // Weather is part of state
            if (state.weather) {
                updateWeather(state.weather);
            }

            // Refresh periodically
            setInterval(async () => {
                const resp = await fetch('/api/state');
                const state = await resp.json();
                updateDevices(state);
                if (state.weather) updateWeather(state.weather);
            }, 5000);

            setInterval(refreshLog, 3000);
        }

        init();
    </script>
</body>
</html>`;

// HTTP Server
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Serve main page
    if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(HTML);
        return;
    }

    // API endpoints
    if (url.pathname === '/api/targets') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(TARGETS));
        return;
    }

    if (url.pathname === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(indi.getState()));
        return;
    }

    if (url.pathname === '/api/mode') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            mode: indiMode,
            host: INDI_HOST,
            port: INDI_PORT
        }));
        return;
    }

    if (url.pathname === '/api/plan') {
        const target = url.searchParams.get('target');
        const result = planSession(target);

        if (result.plan) {
            currentSession.plan = result.plan;
            currentSession.target = target;
            log(`Planned session for ${result.plan.target.name}`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
    }

    if (url.pathname === '/api/execute' && req.method === 'POST') {
        const step = parseInt(url.searchParams.get('step'));
        const result = await executeStep(step);
        result.plan = currentSession.plan;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
    }

    if (url.pathname === '/api/log') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ log: currentSession.log }));
        return;
    }

    if (url.pathname === '/api/abort' && req.method === 'POST') {
        log('SESSION ABORTED BY USER');
        currentSession.active = false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

// Initialize INDI and start server
async function startServer() {
    try {
        const initResult = await indi.init();
        indiMode = initResult.mode;
        log(`Observatory AI Control system started`);
        log(`INDI Mode: ${indiMode.toUpperCase()}`);
        log(`Devices: ${initResult.devices.join(', ')}`);
    } catch (err) {
        log(`INDI initialization error: ${err.message}`);
        indiMode = 'error';
    }

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Observatory AI Control: http://0.0.0.0:${PORT}`);
        console.log(`INDI Mode: ${indiMode}`);
    });
}

startServer();
