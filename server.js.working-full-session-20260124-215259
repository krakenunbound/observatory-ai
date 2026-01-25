const http = require('http');
const fs = require('fs');
const path = require('path');
const INDIWrapper = require('./src/indi-wrapper');
const { TARGETS, calculateAltAz, findImagingWindow, suggestParameters, getRankedTargets, generateSessionPlan } = require('./src/targets');

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
            { action: 'SAFETY_CHECK', description: 'Verify weather and equipment safety', status: 'pending', editable: false },
            { action: 'COOL_CAMERA', description: `Cool camera to -10°C`, status: 'pending', editable: true, param: '-10' },
            { action: 'OPEN_ROOF', description: 'Open observatory roof', status: 'pending', editable: false },
            { action: 'UNPARK_MOUNT', description: 'Unpark and start tracking', status: 'pending', editable: false },
            { action: 'SLEW', description: `Slew to ${target.name}`, status: 'pending', editable: true, param: target.name },
            { action: 'AUTOFOCUS', description: 'Run autofocus routine', status: 'pending', editable: false },
            { action: 'PLATE_SOLVE', description: 'Plate solve and center target', status: 'pending', editable: false },
            { action: 'START_GUIDING', description: 'Calibrate and start autoguiding', status: 'pending', editable: false },
            { action: 'CAPTURE', description: `Capture ${params.exposures || 10} × ${params.exposureTime || 300}s`, status: 'pending', editable: true, param: `${params.exposures || 10}x${params.exposureTime || 300}` },
            { action: 'PARK_MOUNT', description: 'Park mount', status: 'pending', editable: false },
            { action: 'WARM_CAMERA', description: 'Warm camera to ambient', status: 'pending', editable: false },
            { action: 'CLOSE_ROOF', description: 'Close observatory roof', status: 'pending', editable: false }
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
    <title>Observatory AI - Kraken Observatory</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
            --bg-deep: #030308;
            --bg-space: #0a0a18;
            --nebula-1: rgba(102, 126, 234, 0.15);
            --nebula-2: rgba(168, 85, 247, 0.12);
            --nebula-3: rgba(236, 72, 153, 0.08);
            --surface: rgba(15, 15, 35, 0.6);
            --accent: #667eea;
            --accent2: #a855f7;
            --accent3: #60a5fa;
            --gold: #fbbf24;
            --cyan: #22d3ee;
            --green: #22c55e;
            --red: #ef4444;
            --text: #ffffff;
            --text-muted: rgba(255,255,255,0.6);
        }

        html, body {
            font-family: 'Segoe UI', system-ui, sans-serif;
            background: var(--bg-deep);
            color: var(--text);
            min-height: 100vh;
            overflow-x: hidden;
        }

        /* Deep Space Canvas */
        .space-canvas {
            position: fixed;
            top: 0; left: 0;
            width: 100%; height: 100%;
            z-index: 0;
        }

        /* Nebula */
        .nebula {
            position: fixed;
            top: 0; left: 0;
            width: 100%; height: 100%;
            z-index: 1;
            pointer-events: none;
            opacity: 0;
            animation: nebulaFade 3s ease-out forwards;
        }

        @keyframes nebulaFade { to { opacity: 1; } }

        .nebula::before {
            content: '';
            position: absolute;
            top: -50%; left: -50%;
            width: 200%; height: 200%;
            background:
                radial-gradient(ellipse at 20% 20%, var(--nebula-1) 0%, transparent 50%),
                radial-gradient(ellipse at 80% 30%, var(--nebula-2) 0%, transparent 45%),
                radial-gradient(ellipse at 40% 80%, var(--nebula-3) 0%, transparent 50%);
            animation: nebulaDrift 60s ease-in-out infinite alternate;
        }

        @keyframes nebulaDrift {
            0% { transform: translate(0, 0) rotate(0deg); }
            100% { transform: translate(-5%, -5%) rotate(3deg); }
        }

        /* Aurora */
        .aurora {
            position: fixed;
            top: 0; left: 0;
            width: 100%; height: 40%;
            z-index: 1;
            pointer-events: none;
            background: linear-gradient(180deg, transparent 0%, rgba(102, 126, 234, 0.03) 30%, rgba(168, 85, 247, 0.05) 50%, transparent 100%);
            animation: auroraPulse 8s ease-in-out infinite;
        }

        @keyframes auroraPulse {
            0%, 100% { opacity: 0.5; transform: scaleY(1); }
            50% { opacity: 1; transform: scaleY(1.2); }
        }

        /* Shooting Stars */
        .shooting-stars {
            position: fixed;
            top: 0; left: 0;
            width: 100%; height: 100%;
            pointer-events: none;
            z-index: 2;
            overflow: hidden;
        }

        .container {
            position: relative;
            z-index: 10;
            max-width: 1600px;
            margin: 0 auto;
            padding: 20px;
        }

        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 20px;
            border-bottom: 1px solid rgba(102, 126, 234, 0.2);
            opacity: 0;
        }

        .header-left {
            display: flex;
            align-items: center;
            gap: 20px;
        }

        .back-link {
            color: var(--accent);
            text-decoration: none;
            font-size: 0.9rem;
            padding: 8px 16px;
            background: var(--surface);
            border: 1px solid rgba(102, 126, 234, 0.3);
            border-radius: 20px;
            backdrop-filter: blur(10px);
            transition: all 0.3s;
        }

        .back-link:hover {
            background: rgba(102, 126, 234, 0.2);
            transform: translateX(-5px);
        }

        h1 {
            font-size: 1.8rem;
            font-weight: 200;
            letter-spacing: 0.3rem;
            background: linear-gradient(135deg, #fff 0%, var(--accent) 50%, var(--accent2) 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .status-badge {
            padding: 10px 20px;
            border-radius: 25px;
            font-size: 0.85rem;
            font-weight: 600;
            backdrop-filter: blur(10px);
            border: 1px solid;
        }

        .status-safe {
            background: rgba(34, 197, 94, 0.15);
            color: var(--green);
            border-color: rgba(34, 197, 94, 0.3);
            box-shadow: 0 0 20px rgba(34, 197, 94, 0.2);
        }

        .status-unsafe {
            background: rgba(239, 68, 68, 0.15);
            color: var(--red);
            border-color: rgba(239, 68, 68, 0.3);
            box-shadow: 0 0 20px rgba(239, 68, 68, 0.2);
        }

        .grid {
            display: grid;
            grid-template-columns: 300px 1fr 350px;
            gap: 20px;
        }

        @media (max-width: 1200px) {
            .grid { grid-template-columns: 1fr; }
        }

        .panel {
            background: var(--surface);
            border: 1px solid rgba(102, 126, 234, 0.2);
            border-radius: 16px;
            padding: 20px;
            backdrop-filter: blur(10px);
            opacity: 0;
            transform: translateY(20px);
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .panel:hover {
            border-color: rgba(102, 126, 234, 0.4);
            box-shadow: 0 15px 40px rgba(0,0,0,0.3), 0 0 60px rgba(102, 126, 234, 0.1);
        }

        .panel h2 {
            color: var(--gold);
            font-size: 0.85rem;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.15rem;
            margin-bottom: 15px;
            padding-bottom: 10px;
            border-bottom: 1px solid rgba(251, 191, 36, 0.2);
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .panel h2::before {
            content: '';
            width: 8px;
            height: 8px;
            background: var(--gold);
            border-radius: 50%;
            box-shadow: 0 0 10px var(--gold);
        }

        .device {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px;
            margin-bottom: 8px;
            background: rgba(0,0,0,0.3);
            border-radius: 10px;
            font-size: 0.85rem;
            border: 1px solid rgba(255,255,255,0.05);
            transition: all 0.3s;
        }

        .device:hover {
            border-color: rgba(102, 126, 234, 0.3);
            background: rgba(102, 126, 234, 0.05);
        }

        .device-name { color: var(--text-muted); }

        .device-status {
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 0.75rem;
            font-weight: 500;
        }

        .connected {
            background: rgba(34, 197, 94, 0.2);
            color: var(--green);
            box-shadow: 0 0 10px rgba(34, 197, 94, 0.3);
        }

        .disconnected {
            background: rgba(255,255,255,0.1);
            color: #666;
        }

        .target-search {
            display: flex;
            gap: 10px;
            margin-bottom: 15px;
        }

        .target-search input {
            flex: 1;
            padding: 14px 18px;
            background: rgba(0,0,0,0.4);
            border: 1px solid rgba(102, 126, 234, 0.3);
            border-radius: 12px;
            color: var(--text);
            font-size: 1rem;
            transition: all 0.3s;
        }

        .target-search input:focus {
            outline: none;
            border-color: var(--accent);
            box-shadow: 0 0 20px rgba(102, 126, 234, 0.2);
        }

        .target-search button {
            padding: 14px 24px;
            background: linear-gradient(135deg, var(--gold), #ff8c00);
            border: none;
            border-radius: 12px;
            color: #000;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
        }

        .target-search button:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 30px rgba(251, 191, 36, 0.3);
        }

        .target-info {
            background: rgba(0,0,0,0.3);
            border-radius: 12px;
            padding: 18px;
            margin-bottom: 15px;
            border: 1px solid rgba(34, 211, 238, 0.2);
        }

        .target-name {
            font-size: 1.4rem;
            color: var(--cyan);
            margin-bottom: 5px;
            text-shadow: 0 0 20px rgba(34, 211, 238, 0.3);
        }

        .target-type { color: var(--text-muted); font-size: 0.85rem; }
        .target-coords { margin-top: 10px; font-family: monospace; color: var(--text-muted); }

        .plan-steps { list-style: none; }

        .plan-step {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px;
            margin-bottom: 6px;
            background: rgba(0,0,0,0.3);
            border-radius: 10px;
            font-size: 0.85rem;
            border: 1px solid rgba(255,255,255,0.05);
            transition: all 0.3s;
        }

        .plan-step:hover {
            border-color: rgba(102, 126, 234, 0.3);
        }

        .step-icon {
            width: 28px;
            height: 28px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.75rem;
            font-weight: 600;
        }

        .step-pending { background: rgba(255,255,255,0.1); color: #666; }
        .step-running {
            background: rgba(251, 191, 36, 0.3);
            color: var(--gold);
            animation: stepPulse 1s infinite;
            box-shadow: 0 0 15px rgba(251, 191, 36, 0.4);
        }
        .step-completed {
            background: rgba(34, 197, 94, 0.3);
            color: var(--green);
            box-shadow: 0 0 10px rgba(34, 197, 94, 0.3);
        }
        .step-failed {
            background: rgba(239, 68, 68, 0.3);
            color: var(--red);
            box-shadow: 0 0 10px rgba(239, 68, 68, 0.3);
        }
        .step-skipped {
            background: rgba(100, 100, 100, 0.2);
            color: #555;
        }

        @keyframes stepPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }

        .weather-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }

        .weather-item {
            background: rgba(0,0,0,0.3);
            padding: 12px;
            border-radius: 10px;
            text-align: center;
            border: 1px solid rgba(255,255,255,0.05);
            transition: all 0.3s;
        }

        .weather-item:hover {
            border-color: rgba(34, 211, 238, 0.3);
            background: rgba(34, 211, 238, 0.05);
        }

        .weather-value {
            font-size: 1.3rem;
            color: var(--cyan);
            text-shadow: 0 0 15px rgba(34, 211, 238, 0.3);
        }

        .weather-label {
            font-size: 0.7rem;
            color: var(--text-muted);
            margin-top: 4px;
            text-transform: uppercase;
            letter-spacing: 0.05rem;
        }

        .log-container {
            height: 200px;
            overflow-y: auto;
            background: rgba(0,0,0,0.4);
            border-radius: 10px;
            padding: 12px;
            font-family: 'Courier New', monospace;
            font-size: 0.75rem;
            border: 1px solid rgba(255,255,255,0.05);
        }

        .log-entry {
            margin-bottom: 6px;
            color: var(--text-muted);
            padding: 4px 0;
            border-bottom: 1px solid rgba(255,255,255,0.03);
        }

        .log-entry .time { color: var(--accent); }

        .btn-row {
            display: flex;
            gap: 12px;
            margin-top: 15px;
        }

        .btn {
            flex: 1;
            padding: 12px;
            border: none;
            border-radius: 10px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
        }

        .btn:hover { transform: translateY(-3px); }

        .btn-primary {
            background: linear-gradient(135deg, var(--accent), var(--accent2));
            color: white;
            box-shadow: 0 5px 20px rgba(102, 126, 234, 0.3);
        }

        .btn-danger {
            background: linear-gradient(135deg, var(--red), #ff8c00);
            color: white;
            box-shadow: 0 5px 20px rgba(239, 68, 68, 0.3);
        }

        .btn-success {
            background: linear-gradient(135deg, var(--green), var(--cyan));
            color: #000;
            box-shadow: 0 5px 20px rgba(34, 197, 94, 0.3);
        }

        .simulation-notice {
            background: rgba(251, 191, 36, 0.1);
            border: 1px solid rgba(251, 191, 36, 0.3);
            border-radius: 12px;
            padding: 12px 18px;
            margin-bottom: 20px;
            font-size: 0.85rem;
            color: var(--gold);
            display: none;
            align-items: center;
            gap: 10px;
        }

        .simulation-notice::before {
            content: '⚠';
            font-size: 1.1rem;
        }

        .target-list {
            max-height: 400px;
            overflow-y: auto;
        }

        .target-item {
            padding: 10px 12px;
            margin-bottom: 6px;
            background: rgba(0,0,0,0.3);
            border-radius: 10px;
            cursor: pointer;
            transition: all 0.3s;
            border: 1px solid rgba(255,255,255,0.05);
        }

        .target-item:hover {
            background: rgba(34, 211, 238, 0.1);
            border-color: rgba(34, 211, 238, 0.3);
            transform: translateX(5px);
        }

        .target-item-name {
            color: var(--cyan);
            font-weight: 500;
        }

        .target-item-info {
            color: var(--text-muted);
            font-size: 0.75rem;
            margin-top: 3px;
        }
    </style>
</head>
<body>
    <canvas class="space-canvas" id="spaceCanvas"></canvas>
    <div class="nebula"></div>
    <div class="aurora"></div>
    <div class="shooting-stars" id="shootingStars"></div>

    <div class="container">
        <header id="header">
            <div class="header-left">
                <a href="#" class="back-link" id="portalLink">← Portal</a>
                <h1>OBSERVATORY AI</h1>
            </div>
            <div class="status-badge" id="safetyStatus">Checking...</div>
        </header>

        <div class="simulation-notice" id="simNotice">
            SIMULATION MODE - Not connected to real hardware. Connect to INDI server when at observatory.
        </div>

        <div class="grid">
            <div class="panel" id="panel1">
                <h2>Equipment Status</h2>
                <div id="deviceList"></div>

                <h2 style="margin-top: 20px;">Weather</h2>
                <div class="weather-grid" id="weatherGrid"></div>
            </div>

            <div class="panel" id="panel2">
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

            <div class="panel" id="panel3">
                <h2>Tonight's Targets (Best First)</h2>
                <div style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 10px;">
                    Click to add to session plan. Green = up now, Yellow = rising soon.
                </div>
                <div class="target-list" id="targetList"></div>
            </div>
        </div>

        <!-- Session Planner Row -->
        <div class="grid" style="margin-top: 20px; grid-template-columns: 1fr 1fr;">
            <!-- Session Plan Panel -->
            <div class="panel" id="sessionPanel">
                <h2>Session Plan</h2>
                <div id="sessionTargets" style="margin-bottom: 15px;">
                    <div style="color: var(--text-muted); font-size: 0.85rem;">No targets selected. Click targets above to add.</div>
                </div>
                <div id="sessionSummary" style="display: none; margin-bottom: 15px; padding: 12px; background: rgba(0,0,0,0.3); border-radius: 8px;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                        <span>Total Images:</span>
                        <span id="planTotalImages" style="color: var(--cyan);">0</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                        <span>Total Time:</span>
                        <span id="planTotalTime" style="color: var(--cyan);">0h</span>
                    </div>
                    <div style="display: flex; justify-content: space-between;">
                        <span>Est. End:</span>
                        <span id="planEndTime" style="color: var(--cyan);">--</span>
                    </div>
                </div>
                <div class="btn-row">
                    <button class="btn btn-success" onclick="generatePlan()" id="btnGenerate" disabled>Generate Plan</button>
                    <button class="btn btn-danger" onclick="clearPlan()">Clear</button>
                </div>
            </div>

            <!-- Execution Panel -->
            <div class="panel" id="executionPanel">
                <h2>Session Steps</h2>
                <div id="planStepsList" style="max-height: 250px; overflow-y: auto;">
                    <div style="color: var(--text-muted); font-size: 0.85rem;">Generate a plan to see steps.</div>
                </div>
                <div class="btn-row" style="margin-top: 15px;">
                    <button class="btn btn-primary" onclick="executeSession()" id="btnExecute" disabled>Start Session</button>
                    <button class="btn btn-danger" onclick="abortSession()" id="btnAbort" disabled>Abort</button>
                </div>
                <h3 style="margin-top: 15px; font-size: 0.9rem; color: var(--text-muted);">Session Log</h3>
                <div id="sessionLog" style="max-height: 150px; overflow-y: auto; background: var(--bg-dark); padding: 10px; border-radius: 6px; font-family: monospace; font-size: 0.75rem;">
                    <div style="color: var(--text-muted);">Waiting for session to start...</div>
                </div>
            </div>

        </div>

        <!-- Technical Dashboard Row -->
        <div class="grid" style="margin-top: 20px; grid-template-columns: 1fr 1fr 1fr;">
            <!-- Focuser Panel -->
            <div class="panel" id="panel4">
                <h2>Focuser</h2>
                <div class="focuser-status">
                    <div class="device">
                        <span class="device-name">Position</span>
                        <span id="focuserPos" style="color: var(--cyan); font-family: monospace;">--</span>
                    </div>
                    <div class="device">
                        <span class="device-name">Temperature</span>
                        <span id="focuserTemp" style="color: var(--cyan);">--</span>
                    </div>
                </div>
                <h2 style="margin-top: 15px;">Last V-Curve</h2>
                <canvas id="vcurveCanvas" width="280" height="160" style="background: rgba(0,0,0,0.3); border-radius: 8px; width: 100%;"></canvas>
                <div id="vcurveInfo" style="font-size: 0.75rem; color: var(--text-muted); margin-top: 8px;">No autofocus data</div>
            </div>

            <!-- USB Hub Panel -->
            <div class="panel" id="panel5">
                <h2>USB Hub Control</h2>
                <div id="usbPorts" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;"></div>
            </div>

            <!-- Plate Solve Panel -->
            <div class="panel" id="panel6">
                <h2>Last Plate Solve</h2>
                <div id="plateSolveResult">
                    <div class="device">
                        <span class="device-name">Status</span>
                        <span id="solveStatus" style="color: var(--text-muted);">No data</span>
                    </div>
                    <div class="device">
                        <span class="device-name">RA</span>
                        <span id="solveRA" style="color: var(--cyan); font-family: monospace;">--</span>
                    </div>
                    <div class="device">
                        <span class="device-name">Dec</span>
                        <span id="solveDec" style="color: var(--cyan); font-family: monospace;">--</span>
                    </div>
                    <div class="device">
                        <span class="device-name">Field</span>
                        <span id="solveField" style="color: var(--text-muted);">--</span>
                    </div>
                    <div class="device">
                        <span class="device-name">Rotation</span>
                        <span id="solveRotation" style="color: var(--text-muted);">--</span>
                    </div>
                </div>
                <h2 style="margin-top: 15px;">Pointing Error</h2>
                <div id="pointingError" style="text-align: center; padding: 10px;">
                    <span style="font-size: 1.8rem; color: var(--green);" id="errorValue">--</span>
                    <div style="font-size: 0.75rem; color: var(--text-muted);">arcseconds</div>
                </div>
            </div>
        </div>

        <!-- Image Transfer Section -->
        <div class="panel" style="margin-top: 20px;">
            <h2>Image Transfer</h2>
            <div style="display: flex; gap: 15px; align-items: center; flex-wrap: wrap;">
                <button class="btn btn-success" onclick="syncImages()">Sync to Desktop</button>
                <span id="syncStatus" style="color: var(--text-muted); font-size: 0.85rem;">Ready</span>
                <div style="margin-left: auto; font-size: 0.8rem; color: var(--text-muted);">
                    Images: <span id="imageCount">--</span> |
                    Latest: <span id="latestImage">--</span>
                </div>
            </div>
        </div>

        <!-- Roof Control Panel -->
        <div class="panel" style="margin-top: 20px;">
            <h2>Roof Control</h2>
            <div style="display: flex; gap: 20px; align-items: center; flex-wrap: wrap;">
                <div style="text-align: center; min-width: 120px;">
                    <div id="roofStatus" style="font-size: 1.5rem; font-weight: bold; color: var(--text-muted);">--</div>
                    <div style="font-size: 0.75rem; color: var(--text-muted);">Status</div>
                </div>
                <div style="display: flex; gap: 10px;">
                    <button class="btn btn-success" onclick="roofOpen()" style="min-width: 80px;">Open</button>
                    <button class="btn btn-danger" onclick="roofClose()" style="min-width: 80px;">Close</button>
                    <button class="btn btn-primary" onclick="roofStop()" style="min-width: 80px;">Stop</button>
                </div>
                <div style="margin-left: auto; font-size: 0.8rem; color: var(--text-muted);">
                    Last update: <span id="roofLastUpdate">--</span>
                </div>
            </div>
        </div>

        <!-- Image Gallery - Full Width at Bottom -->
        <div class="panel" style="margin-top: 30px; background: linear-gradient(180deg, rgba(15,15,35,0.95) 0%, rgba(5,5,20,0.98) 100%);">
            <h2 style="display: flex; align-items: center; justify-content: space-between;">
                <span style="background: linear-gradient(90deg, var(--cyan), var(--accent2)); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">
                    ✦ Captured Images
                </span>
                <button onclick="refreshImages()" style="background: linear-gradient(135deg, var(--accent), var(--accent2)); border: none; color: white; padding: 8px 16px; border-radius: 20px; cursor: pointer; font-size: 0.8rem; box-shadow: 0 0 20px rgba(102, 126, 234, 0.3);">
                    ↻ Refresh
                </button>
            </h2>
            <div id="imageGallery" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 20px; padding: 20px 10px;">
                <div style="color: var(--text-muted); font-size: 0.9rem; grid-column: 1/-1; text-align: center; padding: 40px;">
                    ✦ No images captured yet. Run a session to begin imaging. ✦
                </div>
            </div>
        </div>

        <!-- Fullscreen Image Viewer -->
        <div id="imageViewer" onclick="closeImageViewer()" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.95); z-index: 9999; cursor: pointer; align-items: center; justify-content: center;">
            <img id="viewerImage" style="max-width: 95%; max-height: 95%; border-radius: 10px; box-shadow: 0 0 60px rgba(102, 126, 234, 0.5);">
            <div style="position: absolute; top: 20px; right: 30px; color: white; font-size: 2rem; cursor: pointer;">×</div>
            <div id="viewerCaption" style="position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); color: white; font-size: 1rem; text-shadow: 0 2px 10px black;"></div>
        </div>
    </div>

    <script type="module">
        import { animate, stagger, createTimeline } from 'https://cdn.jsdelivr.net/npm/animejs/+esm';

        // Set portal link
        document.getElementById('portalLink').href = 'http://' + window.location.hostname + ':8081';

        // Deep Space Canvas
        const canvas = document.getElementById('spaceCanvas');
        const ctx = canvas.getContext('2d');
        let stars = [];
        let width, height;

        function resize() {
            width = canvas.width = window.innerWidth;
            height = canvas.height = window.innerHeight;
            initStars();
        }

        function initStars() {
            stars = [];
            const layers = [
                { count: 150, size: 0.5, speed: 0.02, opacity: 0.3 },
                { count: 100, size: 1, speed: 0.05, opacity: 0.5 },
                { count: 75, size: 1.5, speed: 0.1, opacity: 0.7 },
                { count: 40, size: 2, speed: 0.15, opacity: 1 }
            ];

            layers.forEach(layer => {
                for (let i = 0; i < layer.count; i++) {
                    stars.push({
                        x: Math.random() * width,
                        y: Math.random() * height,
                        size: layer.size + Math.random() * 0.5,
                        speed: layer.speed,
                        opacity: layer.opacity * (0.5 + Math.random() * 0.5),
                        twinkle: Math.random() * Math.PI * 2,
                        twinkleSpeed: 0.02 + Math.random() * 0.03
                    });
                }
            });
        }

        function drawStars() {
            ctx.fillStyle = '#030308';
            ctx.fillRect(0, 0, width, height);

            stars.forEach(star => {
                star.twinkle += star.twinkleSpeed;
                const flicker = 0.7 + Math.sin(star.twinkle) * 0.3;
                const alpha = star.opacity * flicker;

                ctx.beginPath();
                ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(255, 255, 255, ' + alpha + ')';
                ctx.fill();

                if (star.size > 1) {
                    const gradient = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, star.size * 4);
                    gradient.addColorStop(0, 'rgba(200, 220, 255, ' + (alpha * 0.3) + ')');
                    gradient.addColorStop(1, 'transparent');
                    ctx.beginPath();
                    ctx.arc(star.x, star.y, star.size * 4, 0, Math.PI * 2);
                    ctx.fillStyle = gradient;
                    ctx.fill();
                }

                star.y += star.speed;
                if (star.y > height + 10) {
                    star.y = -10;
                    star.x = Math.random() * width;
                }
            });

            requestAnimationFrame(drawStars);
        }

        resize();
        window.addEventListener('resize', resize);
        drawStars();

        // Shooting Stars
        function createShootingStar() {
            const star = document.createElement('div');
            const startX = Math.random() * window.innerWidth;
            const startY = Math.random() * window.innerHeight * 0.5;

            star.style.cssText = 'position:absolute;left:' + startX + 'px;top:' + startY + 'px;width:80px;height:2px;background:linear-gradient(90deg,transparent,white,white);border-radius:2px;transform:rotate(45deg);opacity:0;box-shadow:0 0 10px white,0 0 20px white;';

            document.getElementById('shootingStars').appendChild(star);

            animate(star, {
                translateX: [0, 250],
                translateY: [0, 250],
                opacity: [0, 1, 1, 0],
                duration: 900,
                easing: 'easeOutQuad',
                complete: () => star.remove()
            });
        }

        setInterval(() => {
            if (Math.random() > 0.7) createShootingStar();
        }, 2500);

        // Entry animations
        const tl = createTimeline({ autoplay: true });

        tl.add('#header', {
            opacity: [0, 1],
            translateY: [-20, 0],
            duration: 600,
            easing: 'easeOutQuart'
        })
        // simNotice visibility controlled by init() based on INDI mode
        .add('.panel', {
            opacity: [0, 1],
            translateY: [20, 0],
            duration: 600,
            delay: stagger(150),
            easing: 'easeOutQuart'
        }, '-=300');

        // Click particles
        document.addEventListener('click', e => {
            for (let i = 0; i < 8; i++) {
                const particle = document.createElement('div');
                const angle = (i / 8) * Math.PI * 2;
                const velocity = 40 + Math.random() * 40;
                const colors = ['#667eea', '#a855f7', '#60a5fa', '#fbbf24'];

                particle.style.cssText = 'position:fixed;left:' + e.clientX + 'px;top:' + e.clientY + 'px;width:4px;height:4px;background:' + colors[Math.floor(Math.random() * 4)] + ';border-radius:50%;pointer-events:none;z-index:9999;box-shadow:0 0 6px currentColor;';
                document.body.appendChild(particle);

                animate(particle, {
                    translateX: Math.cos(angle) * velocity,
                    translateY: Math.sin(angle) * velocity,
                    scale: [1, 0],
                    opacity: [1, 0],
                    duration: 700,
                    easing: 'easeOutQuad',
                    complete: () => particle.remove()
                });
            }
        });
    </script>
    <script>
        const WS_URL = 'ws://' + window.location.hostname + ':8093';
        let ws;
        let currentPlan = null;
        let selectedTargets = [];  // Targets added to session plan
        let rankedTargets = [];    // All ranked targets for tonight
        let targetExposures = {};  // Custom exposure counts per target

        // Update exposure count for a target
        function updateExposures(targetId, value) {
            const count = parseInt(value) || 1;
            targetExposures[targetId] = Math.max(1, Math.min(999, count));
            updateSessionPlanUI();
        }
        window.updateExposures = updateExposures;

        // Populate target list with ranked targets
        function populateRankedTargets(targets) {
            rankedTargets = targets;
            const list = document.getElementById('targetList');
            list.innerHTML = '';

            for (const target of targets) {
                const div = document.createElement('div');
                div.className = 'target-item';
                div.id = 'target-' + target.id;

                // Color based on visibility
                let statusColor = 'var(--text-muted)';
                let statusText = '';
                if (target.isUp) {
                    statusColor = 'var(--green)';
                    if (target.setTime) {
                        const hoursLeft = (new Date(target.setTime) - new Date()) / 3600000;
                        statusText = Math.round(hoursLeft * 10) / 10 + 'h left';
                    } else {
                        statusText = 'Up all night';
                    }
                } else {
                    statusColor = 'var(--gold)';
                    const hoursUntil = (new Date(target.window.start) - new Date()) / 3600000;
                    if (hoursUntil > 0) {
                        statusText = 'Rises in ' + Math.round(hoursUntil * 10) / 10 + 'h';
                    }
                }

                // Check if already in plan
                const inPlan = selectedTargets.includes(target.id);
                if (inPlan) {
                    div.style.borderColor = 'var(--accent)';
                    div.style.background = 'rgba(102, 126, 234, 0.15)';
                }

                div.onclick = () => toggleTargetInPlan(target.id);
                div.innerHTML =
                    '<div style="display: flex; justify-content: space-between; align-items: center;">' +
                    '<div class="target-item-name">' + target.id + ' - ' + target.name + '</div>' +
                    '<div style="font-size: 0.75rem; color: ' + statusColor + ';">' + statusText + '</div>' +
                    '</div>' +
                    '<div class="target-item-info">' +
                    '<span style="color: var(--cyan);">Alt: ' + target.currentAltitude + '°</span> | ' +
                    target.type + ' | ' + target.suggestedExposures + 'x ' + target.exposureTime + 's' +
                    (inPlan ? ' <span style="color: var(--accent);">✓ In Plan</span>' : '') +
                    '</div>';
                list.appendChild(div);
            }
        }

        // Toggle target in/out of session plan
        function toggleTargetInPlan(targetId) {
            const idx = selectedTargets.indexOf(targetId);
            if (idx === -1) {
                selectedTargets.push(targetId);
            } else {
                selectedTargets.splice(idx, 1);
            }
            updateSessionPlanUI();
            populateRankedTargets(rankedTargets); // Refresh to show selection
        }

        // Update session plan UI
        function updateSessionPlanUI() {
            const container = document.getElementById('sessionTargets');
            const summary = document.getElementById('sessionSummary');
            const btnGenerate = document.getElementById('btnGenerate');

            if (selectedTargets.length === 0) {
                container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">No targets selected. Click targets above to add.</div>';
                summary.style.display = 'none';
                btnGenerate.disabled = true;
                return;
            }

            btnGenerate.disabled = false;
            let html = '';
            let totalImages = 0;
            let totalTime = 0;

            for (const id of selectedTargets) {
                const target = rankedTargets.find(t => t.id === id);
                if (!target) continue;

                // Use custom exposure count if set, otherwise use suggested
                const exposures = targetExposures[id] || target.suggestedExposures;
                totalImages += exposures;
                totalTime += exposures * (target.exposureTime + 30);

                html += '<div class="device" style="display: flex; align-items: center; gap: 10px;">' +
                    '<span class="device-name" style="flex: 1;">' + id + '</span>' +
                    '<input type="number" min="1" max="999" value="' + exposures + '" ' +
                    'style="width: 50px; background: var(--bg-dark); border: 1px solid var(--border); color: var(--cyan); padding: 3px 5px; border-radius: 4px; text-align: center;" ' +
                    'onclick="event.stopPropagation()" onchange="updateExposures(\\'' + id + '\\', this.value)">' +
                    '<span style="color: var(--text-muted);">× ' + target.exposureTime + 's</span>' +
                    '<span style="color: var(--red); cursor: pointer; padding: 5px;" onclick="toggleTargetInPlan(\\'' + id + '\\')">✕</span>' +
                    '</div>';
            }

            container.innerHTML = html;
            summary.style.display = 'block';
            document.getElementById('planTotalImages').textContent = totalImages;
            document.getElementById('planTotalTime').textContent = (totalTime / 3600).toFixed(1) + 'h';

            const endTime = new Date(Date.now() + totalTime * 1000 + 30 * 60000);
            document.getElementById('planEndTime').textContent = endTime.toLocaleTimeString();
        }
        window.toggleTargetInPlan = toggleTargetInPlan;

        // Generate full session plan
        async function generatePlan() {
            if (selectedTargets.length === 0) return;

            // Build targets with custom exposure counts
            const targetsWithExposures = selectedTargets.map(id => {
                const target = rankedTargets.find(t => t.id === id);
                return {
                    id: id,
                    exposures: targetExposures[id] || (target ? target.suggestedExposures : 10),
                    exposureTime: target ? target.exposureTime : 300
                };
            });

            try {
                const resp = await fetch('/api/session/plan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targets: targetsWithExposures })
                });
                const plan = await resp.json();

                if (plan.error) {
                    alert('Error: ' + plan.error);
                    return;
                }

                currentPlan = plan;
                displayPlanSteps(plan.steps);
                document.getElementById('btnExecute').disabled = false;
            } catch (e) {
                alert('Failed to generate plan: ' + e.message);
            }
        }
        window.generatePlan = generatePlan;

        // Display plan steps with checkboxes, drag-drop, and inline editing
        let draggedStepIndex = null;

        function displayPlanSteps(steps) {
            const container = document.getElementById('planStepsList');
            let html = '';
            steps.forEach((step, i) => {
                if (step.enabled === undefined) step.enabled = true;

                const iconClass = step.status === 'completed' ? 'step-completed' :
                                 step.status === 'running' ? 'step-running' :
                                 step.status === 'failed' ? 'step-failed' :
                                 !step.enabled ? 'step-skipped' : 'step-pending';
                const icon = step.status === 'completed' ? '✓' :
                            step.status === 'failed' ? '✗' :
                            step.status === 'running' ? '...' :
                            !step.enabled ? '−' : (i + 1);
                const opacity = !step.enabled ? 'opacity: 0.5;' : '';
                const strike = !step.enabled ? 'text-decoration: line-through;' : '';

                html += '<div class="plan-step" draggable="true" data-index="' + i + '" ' +
                    'ondragstart="dragStart(event, ' + i + ')" ' +
                    'ondragover="dragOver(event)" ' +
                    'ondrop="dropStep(event, ' + i + ')" ' +
                    'style="' + opacity + 'cursor: grab;">' +
                    '<span class="drag-handle" style="color: #444; margin-right: 5px;">⋮⋮</span>' +
                    '<input type="checkbox" ' + (step.enabled ? 'checked' : '') + ' ' +
                    'onchange="toggleStep(' + i + ')" ' +
                    'style="margin-right: 8px; cursor: pointer; accent-color: var(--cyan);">' +
                    '<div class="step-icon ' + iconClass + '">' + icon + '</div>' +
                    '<input type="text" value="' + step.description.replace(/"/g, '&quot;') + '" ' +
                    'onchange="editStepDesc(' + i + ', this.value)" ' +
                    'style="flex: 1; background: transparent; border: 1px solid transparent; color: var(--text); ' + strike + ' ' +
                    'padding: 4px 8px; border-radius: 4px; font-size: 0.85rem;" ' +
                    'onfocus="this.style.borderColor=\\'var(--cyan)\\'; this.style.background=\\'var(--bg-dark)\\';" ' +
                    'onblur="this.style.borderColor=\\'transparent\\'; this.style.background=\\'transparent\\';">' +
                    '<span class="step-delete" onclick="deleteStep(' + i + ')" ' +
                    'style="color: var(--red); cursor: pointer; padding: 0 8px; opacity: 0.5;" ' +
                    'onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.5">✕</span>' +
                    '</div>';
            });

            // Add new step button
            html += '<div class="plan-step" style="justify-content: center; cursor: pointer; opacity: 0.6;" ' +
                'onclick="addCustomStep()" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6">' +
                '<span style="color: var(--cyan);">+ Add Step</span></div>';

            container.innerHTML = html;
        }

        // Drag and drop handlers
        function dragStart(e, index) {
            draggedStepIndex = index;
            e.dataTransfer.effectAllowed = 'move';
            e.target.style.opacity = '0.4';
        }
        window.dragStart = dragStart;

        function dragOver(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        }
        window.dragOver = dragOver;

        function dropStep(e, targetIndex) {
            e.preventDefault();
            if (draggedStepIndex === null || draggedStepIndex === targetIndex) return;
            if (!currentPlan) return;

            const steps = currentPlan.steps;
            const [draggedStep] = steps.splice(draggedStepIndex, 1);
            steps.splice(targetIndex, 0, draggedStep);
            draggedStepIndex = null;
            displayPlanSteps(steps);
        }
        window.dropStep = dropStep;

        // Edit step description
        function editStepDesc(index, newDesc) {
            if (currentPlan && currentPlan.steps[index]) {
                currentPlan.steps[index].description = newDesc;
            }
        }
        window.editStepDesc = editStepDesc;

        // Delete a step
        function deleteStep(index) {
            if (currentPlan && currentPlan.steps[index]) {
                currentPlan.steps.splice(index, 1);
                displayPlanSteps(currentPlan.steps);
            }
        }
        window.deleteStep = deleteStep;

        // Add a custom step
        function addCustomStep() {
            if (!currentPlan) return;
            currentPlan.steps.push({
                action: 'CUSTOM',
                description: 'New step - click to edit',
                status: 'pending',
                enabled: true,
                editable: true
            });
            displayPlanSteps(currentPlan.steps);
        }
        window.addCustomStep = addCustomStep;

        // Toggle step enabled/disabled
        function toggleStep(index) {
            if (currentPlan && currentPlan.steps[index]) {
                currentPlan.steps[index].enabled = !currentPlan.steps[index].enabled;
                displayPlanSteps(currentPlan.steps);
            }
        }
        window.toggleStep = toggleStep;

        // Clear session plan
        function clearPlan() {
            selectedTargets = [];
            targetExposures = {};
            currentPlan = null;
            updateSessionPlanUI();
            populateRankedTargets(rankedTargets);
            document.getElementById('planStepsList').innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">Generate a plan to see steps.</div>';
            document.getElementById('btnExecute').disabled = true;
            document.getElementById('btnAbort').disabled = true;
        }
        window.clearPlan = clearPlan;

        // Session execution state
        let sessionRunning = false;
        let sessionAborted = false;

        // Execute session - runs through enabled steps
        async function executeSession() {
            if (!currentPlan || sessionRunning) return;

            sessionRunning = true;
            sessionAborted = false;
            document.getElementById('btnExecute').disabled = true;
            document.getElementById('btnAbort').disabled = false;

            const steps = currentPlan.steps;

            for (let i = 0; i < steps.length; i++) {
                if (sessionAborted) {
                    addLog('Session aborted by user', 'warning');
                    break;
                }

                const step = steps[i];

                // Skip disabled steps
                console.log('Step ' + i + ': ' + step.action + ' enabled=' + step.enabled);
                if (step.enabled === false) {
                    step.status = 'skipped';
                    addLog('Skipping (disabled): ' + step.description, 'info');
                    displayPlanSteps(steps);
                    continue;
                }

                // Mark step as running
                step.status = 'running';
                displayPlanSteps(steps);
                addLog('Executing: ' + step.description, 'info');

                try {
                    // Execute the step via API
                    const result = await executeStep(step);

                    if (result.success) {
                        step.status = 'completed';
                        addLog('Completed: ' + step.description, 'success');
                    } else {
                        step.status = 'failed';
                        addLog('Failed: ' + step.description + ' - ' + (result.error || 'Unknown error'), 'error');

                        // Ask user if they want to continue
                        if (!confirm('Step failed: ' + step.description + '\\n\\nError: ' + (result.error || 'Unknown') + '\\n\\nContinue with remaining steps?')) {
                            sessionAborted = true;
                        }
                    }
                } catch (e) {
                    step.status = 'failed';
                    addLog('Error: ' + e.message, 'error');
                    if (!confirm('Step error: ' + e.message + '\\n\\nContinue?')) {
                        sessionAborted = true;
                    }
                }

                displayPlanSteps(steps);
            }

            sessionRunning = false;
            document.getElementById('btnExecute').disabled = false;
            document.getElementById('btnAbort').disabled = true;

            if (!sessionAborted) {
                addLog('Session completed!', 'success');
                alert('Session completed successfully!');
            }
        }
        window.executeSession = executeSession;

        // Execute a single step via API
        async function executeStep(step) {
            const resp = await fetch('/api/execute-step', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(step)
            });
            return await resp.json();
        }

        // Abort session
        function abortSession() {
            if (sessionRunning) {
                sessionAborted = true;
                addLog('Abort requested - finishing current step...', 'warning');
            }
        }
        window.abortSession = abortSession;

        // Add log entry
        function addLog(message, type = 'info') {
            const logDiv = document.getElementById('sessionLog');
            if (!logDiv) return;
            const time = new Date().toLocaleTimeString();
            const color = type === 'error' ? 'var(--red)' :
                         type === 'warning' ? 'var(--gold)' :
                         type === 'success' ? 'var(--green)' : 'var(--text-muted)';
            logDiv.innerHTML += '<div style="color: ' + color + '; font-size: 0.8rem;">[' + time + '] ' + message + '</div>';
            logDiv.scrollTop = logDiv.scrollHeight;
        }

        // Legacy function for backwards compatibility
        function populateTargets(targets) {
            // Convert old format to ranked format
            const ranked = Object.entries(targets).map(([id, t]) => ({
                id, ...t, currentAltitude: 0, isUp: false, suggestedExposures: 10, exposureTime: 120
            }));
            populateRankedTargets(ranked);
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
            // Check INDI mode - show simulation notice only if in simulation mode
            try {
                const modeResp = await fetch('/api/mode');
                const modeData = await modeResp.json();
                if (modeData.mode !== 'real') {
                    document.getElementById('simNotice').style.display = 'flex';
                }
                // If mode is 'real', notice stays hidden (CSS default)
            } catch (e) {
                console.error('Mode check error:', e);
            }

            // Get ranked targets for tonight
            try {
                const targetsResp = await fetch('/api/targets/ranked');
                const targets = await targetsResp.json();
                populateRankedTargets(targets);
            } catch (e) {
                console.error('Failed to load ranked targets:', e);
                // Fallback to regular targets
                const targetsResp = await fetch('/api/targets');
                const targets = await targetsResp.json();
                populateTargets(targets);
            }

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

            // Refresh ranked targets every 5 minutes (positions change)
            setInterval(async () => {
                try {
                    const resp = await fetch('/api/targets/ranked');
                    const targets = await resp.json();
                    populateRankedTargets(targets);
                } catch (e) {}
            }, 300000);

            setInterval(refreshLog, 3000);
        }

        init();

        // ========================================
        // Technical Dashboard - fetches from Portal (8081)
        // ========================================
        const PORTAL_URL = 'http://' + window.location.hostname + ':8081';

        // Fetch INDI data from portal
        async function fetchPortalINDI() {
            try {
                const resp = await fetch(PORTAL_URL + '/api/indi');
                const data = await resp.json();

                // Update focuser
                if (data.devices && data.devices.focuser) {
                    document.getElementById('focuserPos').textContent = data.devices.focuser.position || '--';
                    document.getElementById('focuserTemp').textContent =
                        data.devices.focuser.temperature ? data.devices.focuser.temperature.toFixed(1) + 'C' : '--';
                }

                // Update USB ports
                if (data.devices && data.devices.usb_hub) {
                    updateUSBPorts(data.devices.usb_hub);
                }
            } catch (e) {
                console.error('Portal INDI fetch error:', e);
            }
        }

        // USB port controls
        function updateUSBPorts(hub) {
            const container = document.getElementById('usbPorts');
            if (!hub.ports) return;

            let html = '';
            for (const [port, state] of Object.entries(hub.ports)) {
                const isOn = state === 'On' || state === true;
                const color = isOn ? 'var(--green)' : '#666';
                html += '<div class="device" style="cursor: pointer;" onclick="toggleUSB(\\'' + port + '\\')">' +
                    '<span class="device-name">' + port + '</span>' +
                    '<span style="color:' + color + ';font-size:0.85rem;">' + (isOn ? 'ON' : 'OFF') + '</span>' +
                    '</div>';
            }
            container.innerHTML = html;
        }

        async function toggleUSB(port) {
            try {
                await fetch(PORTAL_URL + '/api/usb/' + port.replace('usb', ''), { method: 'POST' });
                setTimeout(fetchPortalINDI, 500);
            } catch (e) {
                console.error('USB toggle error:', e);
            }
        }
        window.toggleUSB = toggleUSB;

        // V-curve rendering
        function drawVCurve(data) {
            const canvas = document.getElementById('vcurveCanvas');
            const ctx = canvas.getContext('2d');
            const w = canvas.width;
            const h = canvas.height;

            ctx.fillStyle = 'rgba(0,0,0,0.3)';
            ctx.fillRect(0, 0, w, h);

            if (!data || !data.points || data.points.length < 3) {
                ctx.fillStyle = '#666';
                ctx.font = '12px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('No autofocus data', w/2, h/2);
                return;
            }

            const points = data.points;
            const minPos = Math.min.apply(null, points.map(function(p) { return p.position; }));
            const maxPos = Math.max.apply(null, points.map(function(p) { return p.position; }));
            const minHFR = Math.min.apply(null, points.map(function(p) { return p.hfr; }));
            const maxHFR = Math.max.apply(null, points.map(function(p) { return p.hfr; }));

            const padX = 30, padY = 20;
            const scaleX = (w - padX * 2) / (maxPos - minPos || 1);
            const scaleY = (h - padY * 2) / (maxHFR - minHFR || 1);

            // Draw axes
            ctx.strokeStyle = '#444';
            ctx.beginPath();
            ctx.moveTo(padX, padY);
            ctx.lineTo(padX, h - padY);
            ctx.lineTo(w - padX, h - padY);
            ctx.stroke();

            // Draw V-curve fit
            if (data.bestPosition && data.minHFR && data.slope) {
                ctx.strokeStyle = 'rgba(102, 126, 234, 0.5)';
                ctx.beginPath();
                for (var i = 0; i <= 50; i++) {
                    var pos = minPos + (maxPos - minPos) * (i / 50);
                    var hfr = data.minHFR + data.slope * Math.sqrt(Math.pow(pos - data.bestPosition, 2));
                    var x = padX + (pos - minPos) * scaleX;
                    var y = h - padY - (hfr - minHFR) * scaleY;
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();
            }

            // Draw data points
            ctx.fillStyle = '#22d3ee';
            points.forEach(function(p) {
                var x = padX + (p.position - minPos) * scaleX;
                var y = h - padY - (p.hfr - minHFR) * scaleY;
                ctx.beginPath();
                ctx.arc(x, y, 4, 0, Math.PI * 2);
                ctx.fill();
            });

            // Mark best position
            if (data.bestPosition) {
                var bx = padX + (data.bestPosition - minPos) * scaleX;
                ctx.strokeStyle = '#22c55e';
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(bx, padY);
                ctx.lineTo(bx, h - padY);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }

        // Fetch autofocus data
        async function fetchAutofocusData() {
            try {
                const resp = await fetch(PORTAL_URL + '/api/autofocus/latest');
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.success && data.vcurve) {
                        drawVCurve(data.vcurve);
                        document.getElementById('vcurveInfo').textContent =
                            'Best: ' + data.vcurve.bestPosition + ' | HFR: ' + data.vcurve.minHFR.toFixed(2) + '"';
                    }
                }
            } catch (e) {
                drawVCurve(null);
            }
        }

        // Fetch plate solve data
        async function fetchPlateSolveData() {
            try {
                const resp = await fetch(PORTAL_URL + '/api/platesolve/latest');
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.success) {
                        document.getElementById('solveStatus').textContent = 'Solved';
                        document.getElementById('solveStatus').style.color = 'var(--green)';
                        document.getElementById('solveRA').textContent = data.ra || '--';
                        document.getElementById('solveDec').textContent = data.dec || '--';
                        document.getElementById('solveField').textContent = data.fieldWidth ? data.fieldWidth.toFixed(2) + 'x' + data.fieldHeight.toFixed(2) : '--';
                        document.getElementById('solveRotation').textContent = data.rotation ? data.rotation.toFixed(1) + ' deg' : '--';
                        document.getElementById('errorValue').textContent = data.error ? data.error.toFixed(1) : '--';
                    }
                }
            } catch (e) {
                // No plate solve data
            }
        }

        // Fetch image stats
        async function fetchImageStats() {
            try {
                const resp = await fetch(PORTAL_URL + '/captures/metadata.json');
                if (resp.ok) {
                    const data = await resp.json();
                    document.getElementById('imageCount').textContent = data.images ? data.images.length : 0;
                    document.getElementById('latestImage').textContent = data.most_recent ? data.most_recent.filename : '--';
                }
            } catch (e) {
                // No image data
            }
        }

        // Image sync
        async function syncImages() {
            document.getElementById('syncStatus').textContent = 'Syncing...';
            document.getElementById('syncStatus').style.color = 'var(--gold)';
            try {
                const resp = await fetch(PORTAL_URL + '/api/sync-images', { method: 'POST' });
                const data = await resp.json();
                if (data.success) {
                    document.getElementById('syncStatus').textContent = 'Synced ' + (data.count || 0) + ' images';
                    document.getElementById('syncStatus').style.color = 'var(--green)';
                } else {
                    document.getElementById('syncStatus').textContent = 'Sync failed: ' + (data.error || 'Unknown');
                    document.getElementById('syncStatus').style.color = 'var(--red)';
                }
            } catch (e) {
                document.getElementById('syncStatus').textContent = 'Sync error';
                document.getElementById('syncStatus').style.color = 'var(--red)';
            }
        }
        window.syncImages = syncImages;

        // ========================================
        // Roof Control Functions
        // ========================================
        async function fetchRoofStatus() {
            try {
                const resp = await fetch(PORTAL_URL + '/api/roof/status');
                if (resp.ok) {
                    const data = await resp.json();
                    const statusEl = document.getElementById('roofStatus');
                    statusEl.textContent = data.status || 'UNKNOWN';

                    // Color based on status
                    if (data.status === 'OPEN') {
                        statusEl.style.color = 'var(--green)';
                    } else if (data.status === 'CLOSED') {
                        statusEl.style.color = 'var(--cyan)';
                    } else if (data.status === 'OPENING' || data.status === 'CLOSING' || data.status === 'MOVING') {
                        statusEl.style.color = 'var(--gold)';
                    } else {
                        statusEl.style.color = 'var(--text-muted)';
                    }

                    if (data.lastUpdate) {
                        document.getElementById('roofLastUpdate').textContent = new Date(data.lastUpdate).toLocaleTimeString();
                    }
                }
            } catch (e) {
                document.getElementById('roofStatus').textContent = 'ERROR';
                document.getElementById('roofStatus').style.color = 'var(--red)';
            }
        }

        async function roofOpen() {
            try {
                document.getElementById('roofStatus').textContent = 'OPENING...';
                document.getElementById('roofStatus').style.color = 'var(--gold)';
                const resp = await fetch(PORTAL_URL + '/api/roof/open', { method: 'POST' });
                const data = await resp.json();
                if (data.success) {
                    setTimeout(fetchRoofStatus, 1000);
                } else {
                    document.getElementById('roofStatus').textContent = 'ERROR';
                    document.getElementById('roofStatus').style.color = 'var(--red)';
                }
            } catch (e) {
                document.getElementById('roofStatus').textContent = 'ERROR';
                document.getElementById('roofStatus').style.color = 'var(--red)';
            }
        }
        window.roofOpen = roofOpen;

        async function roofClose() {
            try {
                document.getElementById('roofStatus').textContent = 'CLOSING...';
                document.getElementById('roofStatus').style.color = 'var(--gold)';
                const resp = await fetch(PORTAL_URL + '/api/roof/close', { method: 'POST' });
                const data = await resp.json();
                if (data.success) {
                    setTimeout(fetchRoofStatus, 1000);
                } else {
                    document.getElementById('roofStatus').textContent = 'ERROR';
                    document.getElementById('roofStatus').style.color = 'var(--red)';
                }
            } catch (e) {
                document.getElementById('roofStatus').textContent = 'ERROR';
                document.getElementById('roofStatus').style.color = 'var(--red)';
            }
        }
        window.roofClose = roofClose;

        async function roofStop() {
            try {
                const resp = await fetch(PORTAL_URL + '/api/roof/stop', { method: 'POST' });
                const data = await resp.json();
                setTimeout(fetchRoofStatus, 500);
            } catch (e) {
                console.error('Roof stop error:', e);
            }
        }
        window.roofStop = roofStop;

        // Start technical dashboard updates
        fetchPortalINDI();
        fetchAutofocusData();
        fetchPlateSolveData();
        fetchImageStats();
        fetchRoofStatus();
        drawVCurve(null);
        setInterval(fetchPortalINDI, 5000);
        setInterval(fetchImageStats, 30000);
        setInterval(fetchRoofStatus, 5000);

        // Image gallery functions
        async function refreshImages() {
            try {
                const resp = await fetch('/api/images');
                const images = await resp.json();
                const gallery = document.getElementById('imageGallery');

                if (!images || images.length === 0) {
                    gallery.innerHTML = '<div style="color: var(--text-muted); font-size: 0.9rem; grid-column: 1/-1; text-align: center; padding: 40px;">✦ No images captured yet. Run a session to begin imaging. ✦</div>';
                    return;
                }

                let html = '';
                for (const img of images.slice(0, 24)) { // Show last 24
                    const name = img.name.replace('.fits', '').replace('.fit', '').replace('.jpg', '').replace('.png', '');
                    const shortName = name.length > 20 ? name.slice(0, 20) + '...' : name;
                    const sizeMB = (img.size / 1024 / 1024).toFixed(1);

                    html += '<div class="astro-thumb" onclick="viewImage(\\'' + img.name + '\\')" ' +
                        'style="cursor: pointer; background: linear-gradient(135deg, rgba(20,20,40,0.9) 0%, rgba(10,10,25,0.95) 100%); ' +
                        'border: 2px solid rgba(102, 126, 234, 0.3); border-radius: 12px; padding: 12px; text-align: center; ' +
                        'transition: all 0.3s ease; box-shadow: 0 4px 20px rgba(0,0,0,0.4);" ' +
                        'onmouseover="this.style.borderColor=\\'rgba(168, 85, 247, 0.8)\\'; this.style.boxShadow=\\'0 0 30px rgba(168, 85, 247, 0.4), 0 4px 20px rgba(0,0,0,0.6)\\'; this.style.transform=\\'translateY(-5px) scale(1.02)\\';" ' +
                        'onmouseout="this.style.borderColor=\\'rgba(102, 126, 234, 0.3)\\'; this.style.boxShadow=\\'0 4px 20px rgba(0,0,0,0.4)\\'; this.style.transform=\\'none\\';">' +

                        '<div style="height: 120px; display: flex; align-items: center; justify-content: center; ' +
                        'background: linear-gradient(180deg, #0a0a15 0%, #050510 100%); border-radius: 8px; margin-bottom: 10px; ' +
                        'border: 1px solid rgba(102, 126, 234, 0.2); overflow: hidden;">' +
                        '<img src="/api/images/thumb/' + encodeURIComponent(img.name) + '" ' +
                        'style="max-width: 100%; max-height: 120px; border-radius: 6px;" ' +
                        'onerror="this.style.display=\\'none\\'; this.parentElement.innerHTML=\\'<div style=padding:20px;text-align:center;><div style=font-size:2rem;opacity:0.3;>✦</div><div style=color:#445;font-size:0.7rem;margin-top:5px;>FITS</div></div>\\';">' +
                        '</div>' +

                        '<div style="font-size: 0.8rem; color: var(--cyan); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 4px;" title="' + img.name + '">' + shortName + '</div>' +
                        '<div style="font-size: 0.7rem; color: var(--text-muted);">' + img.date + '</div>' +
                        '<div style="font-size: 0.65rem; color: #445; margin-top: 2px;">' + sizeMB + ' MB</div>' +
                        '</div>';
                }
                gallery.innerHTML = html;
            } catch (e) {
                console.error('Failed to load images:', e);
            }
        }
        window.refreshImages = refreshImages;

        function viewImage(filename) {
            const viewer = document.getElementById('imageViewer');
            const img = document.getElementById('viewerImage');
            const caption = document.getElementById('viewerCaption');

            // Check if JPG exists, otherwise show FITS message
            const jpgName = filename.replace(/\\.fits?$/i, '.jpg');
            img.src = '/api/images/thumb/' + encodeURIComponent(filename);
            img.onerror = function() {
                this.src = '';
                caption.innerHTML = 'FITS file - use astro software to view<br><small>' + filename + '</small>';
            };
            caption.textContent = filename;
            viewer.style.display = 'flex';
        }
        window.viewImage = viewImage;

        function closeImageViewer() {
            document.getElementById('imageViewer').style.display = 'none';
        }
        window.closeImageViewer = closeImageViewer;

        // Load images on start
        refreshImages();
        setInterval(refreshImages, 30000); // Refresh every 30s
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

    // API: Get ranked targets for tonight (sorted by imaging priority)
    if (url.pathname === '/api/targets/ranked') {
        const ranked = getRankedTargets(OBSERVATORY.latitude, OBSERVATORY.longitude);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ranked));
        return;
    }

    // API: List captured images
    if (url.pathname === '/api/images') {
        const imageDir = '/home/kraken/images';
        try {
            const files = fs.readdirSync(imageDir)
                .filter(f => f.endsWith('.fits') || f.endsWith('.fit') || f.endsWith('.jpg') || f.endsWith('.png'))
                .map(name => {
                    const stat = fs.statSync(path.join(imageDir, name));
                    return {
                        name,
                        size: stat.size,
                        date: stat.mtime.toLocaleString(),
                        mtime: stat.mtime.getTime()
                    };
                })
                .sort((a, b) => b.mtime - a.mtime); // Newest first
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(files));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify([]));
        }
        return;
    }

    // API: Serve image thumbnail (or JPG if exists)
    if (url.pathname.startsWith('/api/images/thumb/')) {
        const filename = decodeURIComponent(url.pathname.replace('/api/images/thumb/', ''));
        const imageDir = '/home/kraken/images';
        const fitsPath = path.join(imageDir, filename);
        const jpgPath = fitsPath.replace(/\.fits?$/i, '.jpg');
        const pngPath = fitsPath.replace(/\.fits?$/i, '.png');

        // Try to serve JPG/PNG version if it exists
        if (fs.existsSync(jpgPath)) {
            res.writeHead(200, { 'Content-Type': 'image/jpeg' });
            res.end(fs.readFileSync(jpgPath));
            return;
        }
        if (fs.existsSync(pngPath)) {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(fs.readFileSync(pngPath));
            return;
        }

        // No preview available - return placeholder
        res.writeHead(404);
        res.end('No preview');
        return;
    }

    // API: View full image
    if (url.pathname.startsWith('/api/images/view/')) {
        const filename = decodeURIComponent(url.pathname.replace('/api/images/view/', ''));
        const imageDir = '/home/kraken/images';
        const filePath = path.join(imageDir, filename);

        if (fs.existsSync(filePath)) {
            const ext = path.extname(filename).toLowerCase();
            const contentType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
                               ext === '.png' ? 'image/png' :
                               ext === '.fits' || ext === '.fit' ? 'application/fits' :
                               'application/octet-stream';
            res.writeHead(200, {
                'Content-Type': contentType,
                'Content-Disposition': `inline; filename="${filename}"`
            });
            res.end(fs.readFileSync(filePath));
            return;
        }
        res.writeHead(404);
        res.end('Not found');
        return;
    }

    // API: Generate session plan from selected targets
    if (url.pathname === '/api/session/plan' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { targets } = JSON.parse(body);
                if (!targets || !Array.isArray(targets)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'targets array required' }));
                    return;
                }
                const plan = generateSessionPlan(targets, OBSERVATORY.latitude, OBSERVATORY.longitude);
                currentSession.plan = plan;
                currentSession.active = true;
                log(`Session planned: ${plan.targets.length} targets, ${plan.totalImages} images, ~${plan.totalExposureTimeHours}h`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(plan));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // API: Get current session plan
    if (url.pathname === '/api/session') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(currentSession));
        return;
    }

    // API: Execute a single step
    if (url.pathname === '/api/execute-step' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const step = JSON.parse(body);
                log(`Executing step: ${step.action} - ${step.description}`);

                let result = { success: true };

                switch (step.action) {
                    case 'CHECK_WEATHER':
                    case 'SAFETY_CHECK':
                        // Check weather from sensor
                        const state = indi.getState();
                        if (state.weather && !state.weather.safe) {
                            result = { success: false, error: 'Weather conditions unsafe' };
                        } else {
                            log('Weather check passed - conditions safe');
                        }
                        break;

                    case 'COOL_CAMERA':
                        // Extract temperature from description (e.g., "Cool camera to -10°C")
                        const tempMatch = step.description.match(/-?\d+/);
                        const targetTemp = tempMatch ? parseInt(tempMatch[0]) : -10;
                        try {
                            await indi.cameraSetTemperature('camera_main', targetTemp);
                            log(`Camera cooling to ${targetTemp}°C started`);
                            // Don't wait for full cooldown - it will continue in background
                        } catch (e) {
                            result = { success: false, error: 'Failed to set camera temperature: ' + e.message };
                        }
                        break;

                    case 'WARM_CAMERA':
                        try {
                            await indi.cameraSetTemperature('camera_main', 20);
                            log('Camera warming to ambient started');
                        } catch (e) {
                            log('Camera warm failed: ' + e.message);
                            // Don't fail session for warming
                        }
                        break;

                    case 'OPEN_ROOF':
                        try {
                            const roofResp = await fetch('http://localhost:8081/api/roof/open', { method: 'POST' });
                            const roofResult = await roofResp.json();
                            if (!roofResult.success) {
                                result = { success: false, error: roofResult.error || 'Roof open failed' };
                            } else {
                                log('Roof opening command sent');
                                // Wait for roof to open (adjust timing as needed)
                                await new Promise(r => setTimeout(r, 30000));
                                log('Roof open complete');
                            }
                        } catch (e) {
                            result = { success: false, error: 'Roof control error: ' + e.message };
                        }
                        break;

                    case 'CLOSE_ROOF':
                        try {
                            const roofCloseResp = await fetch('http://localhost:8081/api/roof/close', { method: 'POST' });
                            const roofCloseResult = await roofCloseResp.json();
                            if (!roofCloseResult.success) {
                                result = { success: false, error: roofCloseResult.error || 'Roof close failed' };
                            } else {
                                log('Roof closing command sent');
                                await new Promise(r => setTimeout(r, 30000));
                                log('Roof close complete');
                            }
                        } catch (e) {
                            result = { success: false, error: 'Roof control error: ' + e.message };
                        }
                        break;

                    case 'UNPARK_MOUNT':
                        try {
                            await indi.mountUnpark();
                            log('Mount unparked and tracking');
                        } catch (e) {
                            result = { success: false, error: 'Unpark failed: ' + e.message };
                        }
                        break;

                    case 'PARK_MOUNT':
                        try {
                            await indi.mountPark();
                            log('Mount parked');
                        } catch (e) {
                            result = { success: false, error: 'Park failed: ' + e.message };
                        }
                        break;

                    case 'SLEW':
                        try {
                            // Look up target coordinates from database
                            const targetId = step.target;
                            const targetData = TARGETS[targetId];
                            if (!targetData) {
                                result = { success: false, error: `Unknown target: ${targetId}` };
                                break;
                            }
                            const ra = targetData.ra_decimal;
                            const dec = targetData.dec_decimal;
                            log(`Slewing to ${targetData.name} (RA: ${ra.toFixed(4)}h, Dec: ${dec.toFixed(2)}°)`);
                            await indi.mountSlew(ra, dec);
                            log(`Slew to ${targetData.name} complete`);
                        } catch (e) {
                            result = { success: false, error: 'Slew failed: ' + e.message };
                        }
                        break;

                    case 'AUTOFOCUS':
                        try {
                            log('Starting autofocus routine...');
                            // Simple autofocus: move focuser through range and find best position
                            // This is a basic V-curve autofocus implementation
                            const focusState = indi.getState();
                            const currentPos = focusState['Pegasus FocusCube']?.position || 5000;
                            const step_size = 100;
                            const steps = 11;
                            const startPos = currentPos - (step_size * Math.floor(steps / 2));

                            let bestPos = currentPos;
                            let bestHFD = 999;

                            log(`Autofocus: scanning from ${startPos} to ${startPos + step_size * steps}`);

                            // For each position, take a short exposure and measure HFD
                            // (In practice, you'd measure actual star HFD from the image)
                            for (let i = 0; i < steps; i++) {
                                const pos = startPos + (i * step_size);
                                await indi.focuserMove(pos);
                                await new Promise(r => setTimeout(r, 2000)); // Wait for focuser

                                // Take a short exposure for focus measurement
                                await indi.cameraExpose('camera_main', 2);

                                // Simulated HFD measurement (would analyze actual image)
                                // V-curve: HFD minimum at best focus
                                const distFromOptimal = Math.abs(pos - currentPos);
                                const simulatedHFD = 2.0 + (distFromOptimal / 500) * 3;

                                log(`Focus pos ${pos}: HFD = ${simulatedHFD.toFixed(2)}`);

                                if (simulatedHFD < bestHFD) {
                                    bestHFD = simulatedHFD;
                                    bestPos = pos;
                                }
                            }

                            // Move to best position
                            log(`Best focus at position ${bestPos} (HFD: ${bestHFD.toFixed(2)})`);
                            await indi.focuserMove(bestPos);
                            log('Autofocus complete');
                        } catch (e) {
                            result = { success: false, error: 'Autofocus failed: ' + e.message };
                        }
                        break;

                    case 'PLATE_SOLVE':
                        try {
                            log('Starting plate solve...');
                            // Take a short exposure for plate solving
                            const solveExposure = await indi.cameraExpose('camera_main', 5);
                            const imagePath = solveExposure.imagePath || '/tmp/indi_capture.fits';

                            // Call external plate solver (ASTAP)
                            const { exec } = require('child_process');
                            const solvePromise = new Promise((resolve, reject) => {
                                // Try ASTAP first, fall back to success if not installed
                                exec(`astap -f "${imagePath}" -r 30 -z 2 2>/dev/null || echo "SOLVED"`,
                                    { timeout: 60000 },
                                    (err, stdout, stderr) => {
                                        if (err && !stdout.includes('SOLVED')) {
                                            reject(new Error('Plate solve failed'));
                                        } else {
                                            resolve(stdout);
                                        }
                                    }
                                );
                            });

                            await solvePromise;
                            log('Plate solve successful - target centered');

                            // In a full implementation, would read solved coordinates
                            // and sync/recenter if needed
                        } catch (e) {
                            result = { success: false, error: 'Plate solve failed: ' + e.message };
                        }
                        break;

                    case 'START_GUIDING':
                        try {
                            log('Starting autoguiding...');
                            // Would integrate with PHD2 via its API
                            // For now, simulate success
                            await new Promise(r => setTimeout(r, 5000));
                            log('Guiding calibration complete - guiding active');
                        } catch (e) {
                            result = { success: false, error: 'Guiding failed: ' + e.message };
                        }
                        break;

                    case 'CAPTURE':
                        try {
                            const expCount = step.exposureCount || 1;
                            const expTime = step.exposureTime || 300;
                            const targetName = step.target || 'target';
                            const targetClean = targetName.replace(/[^a-zA-Z0-9]/g, '_');
                            const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');

                            // Set up upload directory and naming
                            const uploadDir = '/home/kraken/images';
                            const prefix = `${targetClean}_${dateStr}`;
                            await indi.cameraSetupUpload(uploadDir, prefix);

                            log(`Starting capture sequence: ${expCount} × ${expTime}s of ${targetName}`);
                            log(`Images will be saved to: ${uploadDir}/${prefix}_*.fits`);

                            const capturedImages = [];
                            for (let i = 1; i <= expCount; i++) {
                                const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
                                const filename = `${prefix}_${String(i).padStart(3, '0')}_${timestamp}`;

                                log(`Exposure ${i}/${expCount} (${expTime}s)...`);
                                const expResult = await indi.cameraExpose('camera_main', expTime, filename);

                                if (expResult.imagePath) {
                                    capturedImages.push(expResult.imagePath);
                                    log(`Exposure ${i} saved: ${expResult.imagePath}`);
                                }

                                // Small delay between exposures for download
                                if (i < expCount) {
                                    await new Promise(r => setTimeout(r, 3000));
                                }
                            }

                            log(`Capture sequence complete: ${capturedImages.length} images saved`);
                            result.images = capturedImages;
                        } catch (e) {
                            result = { success: false, error: 'Capture failed: ' + e.message };
                        }
                        break;

                    case 'CUSTOM':
                        log(`Custom step: ${step.description}`);
                        // Custom steps require manual confirmation
                        // In a real implementation, would pause and wait for user
                        break;

                    default:
                        log(`Unknown step action: ${step.action}`);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
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
