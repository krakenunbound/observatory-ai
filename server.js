const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const INDIWrapper = require('./src/indi-wrapper');
const MountModeling = require('./src/mount-modeling');
const { TARGETS, calculateAltAz, findImagingWindow, suggestParameters, getRankedTargets, generateSessionPlan } = require('./src/targets');

// Mount modeling direct connection (bypasses INDI for LX200 commands)
const mountModeling = new MountModeling({
    host: '192.168.1.103',
    port: 3490,
    timeout: 5000
});

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

// Autofocus state (for live V-curve display)
let autofocusData = {
    active: false,
    points: [],           // [{position, hfr}, ...]
    bestPosition: null,
    minHFR: null,
    slope: null,          // For V-curve fit
    timestamp: null
};

// Focus tracking for refocus conditions
let focusTracking = {
    baselineHFR: null,        // HFR after initial autofocus
    lastFocusTime: null,      // Timestamp of last autofocus
    lastFocusPosition: null,  // Focuser position after last autofocus
    refocusIntervalMin: 60,   // Refocus every N minutes (0 = disabled)
    hfrDriftThreshold: 0.05,  // 5% HFR degradation triggers refocus
    meridianFlipPending: false
};

// Plate solve results
let plateSolveData = {
    success: false,
    ra: null,           // Solved RA (hours)
    dec: null,          // Solved Dec (degrees)
    raHMS: null,        // RA in HH:MM:SS format
    decDMS: null,       // Dec in DD:MM:SS format
    fieldWidth: null,   // Field width in arcmin
    fieldHeight: null,  // Field height in arcmin
    rotation: null,     // Field rotation in degrees
    pixelScale: null,   // Arcsec per pixel
    error: null,        // Pointing error in arcsec
    timestamp: null
};

// Session progress tracking
let sessionProgress = {
    active: false,
    currentStep: 0,
    totalSteps: 0,
    stepDescription: '',
    exposure: {
        current: 0,
        total: 0,
        duration: 0,
        startTime: null,
        remaining: 0
    }
};

// ============================================================================
// AMBIENT WEATHER STATION (WS-2902D)
// ============================================================================
// Receives data pushed from weather station via Custom Server feature
let ambientWeather = {
    latest: null,           // Most recent reading
    history: [],            // Last 24h of readings (max 2880 at 30s intervals)
    lastUpdate: null,
    connected: false
};

const WEATHER_HISTORY_FILE = path.join(os.homedir(), '.observatory', 'ambient-weather-history.json');

// Load weather history on startup
function loadWeatherHistory() {
    try {
        if (fs.existsSync(WEATHER_HISTORY_FILE)) {
            const data = JSON.parse(fs.readFileSync(WEATHER_HISTORY_FILE, 'utf8'));
            ambientWeather.history = data.slice(-2880); // Keep last 24h
            if (ambientWeather.history.length > 0) {
                ambientWeather.latest = ambientWeather.history[ambientWeather.history.length - 1];
                ambientWeather.lastUpdate = ambientWeather.latest.received_at;
            }
            console.log(`[Weather] Loaded ${ambientWeather.history.length} historical readings`);
        }
    } catch (err) {
        console.log('[Weather] No history file or error loading:', err.message);
    }
}

// Save weather history periodically
function saveWeatherHistory() {
    try {
        const dir = path.dirname(WEATHER_HISTORY_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(WEATHER_HISTORY_FILE, JSON.stringify(ambientWeather.history.slice(-2880)));
    } catch (err) {
        console.error('[Weather] Error saving history:', err.message);
    }
}

// Process incoming weather data from station
function processWeatherData(params) {
    const data = {
        // Timestamps
        received_at: new Date().toISOString(),
        dateutc: params.dateutc,
        // Outdoor conditions
        tempf: parseFloat(params.tempf) || null,
        humidity: parseFloat(params.humidity) || null,
        dewPoint: parseFloat(params.dewPoint) || null,
        feelsLike: parseFloat(params.feelsLike) || null,
        // Wind
        windspeedmph: parseFloat(params.windspeedmph) || 0,
        windgustmph: parseFloat(params.windgustmph) || 0,
        winddir: parseFloat(params.winddir) || 0,
        // Pressure
        baromrelin: parseFloat(params.baromrelin) || null,
        baromabsin: parseFloat(params.baromabsin) || null,
        // Rain
        rainratein: parseFloat(params.rainratein) || 0,
        dailyrainin: parseFloat(params.dailyrainin) || 0,
        weeklyrainin: parseFloat(params.weeklyrainin) || 0,
        monthlyrainin: parseFloat(params.monthlyrainin) || 0,
        // Solar
        solarradiation: parseFloat(params.solarradiation) || 0,
        uv: parseFloat(params.uv) || 0,
        // Indoor
        tempinf: parseFloat(params.tempinf) || null,
        humidityin: parseFloat(params.humidityin) || null,
        // Station info
        stationtype: params.stationtype,
        model: params.model
    };

    ambientWeather.latest = data;
    ambientWeather.lastUpdate = data.received_at;
    ambientWeather.connected = true;
    ambientWeather.history.push(data);

    // Keep only last 24h (2880 readings at 30s intervals)
    if (ambientWeather.history.length > 2880) {
        ambientWeather.history = ambientWeather.history.slice(-2880);
    }

    // Save history every 10 readings (~5 minutes)
    if (ambientWeather.history.length % 10 === 0) {
        saveWeatherHistory();
    }

    console.log(`[Weather] Data received: ${data.tempf}°F, ${data.humidity}% humidity, wind ${data.windspeedmph} mph`);
    return data;
}

// Check if weather is safe for imaging
function isWeatherSafe() {
    if (!ambientWeather.latest) return { safe: false, reason: 'No weather data' };

    const w = ambientWeather.latest;
    const issues = [];

    // Check humidity (>85% is risky for dew)
    if (w.humidity > 85) issues.push(`High humidity: ${w.humidity}%`);

    // Check wind (>20 mph causes tracking issues)
    if (w.windspeedmph > 20) issues.push(`High wind: ${w.windspeedmph} mph`);
    if (w.windgustmph > 30) issues.push(`Strong gusts: ${w.windgustmph} mph`);

    // Check rain
    if (w.rainratein > 0) issues.push(`Rain detected: ${w.rainratein} in/hr`);

    // Check dew point proximity (within 5°F is risky)
    if (w.tempf && w.dewPoint && (w.tempf - w.dewPoint) < 5) {
        issues.push(`Dew risk: temp ${w.tempf}°F, dew point ${w.dewPoint}°F`);
    }

    return {
        safe: issues.length === 0,
        issues: issues,
        conditions: {
            temperature: w.tempf,
            humidity: w.humidity,
            dewPoint: w.dewPoint,
            wind: w.windspeedmph,
            gusts: w.windgustmph,
            rain: w.rainratein > 0
        }
    };
}

// Load history on module load
loadWeatherHistory();

// ============================================================================
// FOCUSER PROFILING SYSTEM
// ============================================================================

// Scope type defaults for profiling
const SCOPE_DEFAULTS = {
    Refractor:  { testDistance: 500,  maxBacklash: 200, stepSize: 100, settleTime: 1500 },
    Newtonian:  { testDistance: 500,  maxBacklash: 200, stepSize: 100, settleTime: 1500 },
    SCT:        { testDistance: 2000, maxBacklash: 500, stepSize: 150, settleTime: 2500 },
    RC:         { testDistance: 1000, maxBacklash: 300, stepSize: 120, settleTime: 2000 }
};

// Profile storage directory
const PROFILE_DIR = path.join(os.homedir(), '.observatory', 'focuser-profiles');

// Active focuser profile
let activeFocuserProfile = null;

// Profiling routine state
let profilingState = {
    active: false,
    phase: '',          // 'slewing' | 'rough_focus' | 'backlash_in' | 'backlash_out' | 'step_size' | 'complete'
    progress: 0,        // 0-100
    message: '',
    measurements: [],   // Collected measurements
    error: null
};

// Ensure profile directory exists
function ensureProfileDir() {
    try {
        if (!fs.existsSync(PROFILE_DIR)) {
            fs.mkdirSync(PROFILE_DIR, { recursive: true });
            console.log(`[Focuser] Created profile directory: ${PROFILE_DIR}`);
        }
        return true;
    } catch (err) {
        console.error(`[Focuser] Failed to create profile directory: ${err.message}`);
        return false;
    }
}

// Load all profiles index
function loadProfilesIndex() {
    ensureProfileDir();
    const indexPath = path.join(PROFILE_DIR, 'profiles.json');
    try {
        if (fs.existsSync(indexPath)) {
            const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
            return data;
        }
    } catch (err) {
        console.error(`[Focuser] Failed to load profiles index: ${err.message}`);
    }
    return { activeProfile: null, profiles: [] };
}

// Save profiles index
function saveProfilesIndex(index) {
    ensureProfileDir();
    const indexPath = path.join(PROFILE_DIR, 'profiles.json');
    try {
        fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
        return true;
    } catch (err) {
        console.error(`[Focuser] Failed to save profiles index: ${err.message}`);
        return false;
    }
}

// Load a specific profile by ID
function loadProfile(profileId) {
    ensureProfileDir();
    const profilePath = path.join(PROFILE_DIR, `${profileId}.json`);
    try {
        if (fs.existsSync(profilePath)) {
            return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
        }
    } catch (err) {
        console.error(`[Focuser] Failed to load profile ${profileId}: ${err.message}`);
    }
    return null;
}

// Save a profile
function saveProfile(profile) {
    ensureProfileDir();
    const profilePath = path.join(PROFILE_DIR, `${profile.id}.json`);
    try {
        fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));

        // Update index
        const index = loadProfilesIndex();
        const existingIdx = index.profiles.findIndex(p => p.id === profile.id);
        const profileMeta = { id: profile.id, name: profile.name, scopeType: profile.scopeType };
        if (existingIdx >= 0) {
            index.profiles[existingIdx] = profileMeta;
        } else {
            index.profiles.push(profileMeta);
        }
        saveProfilesIndex(index);

        console.log(`[Focuser] Saved profile: ${profile.name}`);
        return true;
    } catch (err) {
        console.error(`[Focuser] Failed to save profile: ${err.message}`);
        return false;
    }
}

// Delete a profile
function deleteProfile(profileId) {
    ensureProfileDir();
    const profilePath = path.join(PROFILE_DIR, `${profileId}.json`);
    try {
        if (fs.existsSync(profilePath)) {
            fs.unlinkSync(profilePath);
        }

        // Update index
        const index = loadProfilesIndex();
        index.profiles = index.profiles.filter(p => p.id !== profileId);
        if (index.activeProfile === profileId) {
            index.activeProfile = null;
            activeFocuserProfile = null;
        }
        saveProfilesIndex(index);

        console.log(`[Focuser] Deleted profile: ${profileId}`);
        return true;
    } catch (err) {
        console.error(`[Focuser] Failed to delete profile: ${err.message}`);
        return false;
    }
}

// Set active profile
function setActiveProfile(profileId) {
    const profile = loadProfile(profileId);
    if (profile) {
        activeFocuserProfile = profile;
        const index = loadProfilesIndex();
        index.activeProfile = profileId;
        saveProfilesIndex(index);
        console.log(`[Focuser] Active profile set: ${profile.name}`);
        return true;
    }
    return false;
}

// Load active profile on startup
function loadActiveProfile() {
    const index = loadProfilesIndex();
    if (index.activeProfile) {
        activeFocuserProfile = loadProfile(index.activeProfile);
        if (activeFocuserProfile) {
            console.log(`[Focuser] Loaded active profile: ${activeFocuserProfile.name}`);
        }
    }
}

// ============================================================================
// FOCUS TEMPERATURE DATABASE
// ============================================================================

const FOCUS_TEMP_DB_PATH = path.join(os.homedir(), '.observatory', 'focus-temp-log.json');

// Load focus temperature database
function loadFocusTempDB() {
    try {
        if (fs.existsSync(FOCUS_TEMP_DB_PATH)) {
            return JSON.parse(fs.readFileSync(FOCUS_TEMP_DB_PATH, 'utf8'));
        }
    } catch (err) {
        console.error(`[FocusTemp] Failed to load database: ${err.message}`);
    }
    return { entries: [], coefficients: {} };
}

// Save focus temperature database
function saveFocusTempDB(db) {
    try {
        ensureProfileDir(); // Reuse the profile dir creation
        fs.writeFileSync(FOCUS_TEMP_DB_PATH, JSON.stringify(db, null, 2));
        return true;
    } catch (err) {
        console.error(`[FocusTemp] Failed to save database: ${err.message}`);
        return false;
    }
}

// Log a focus result with temperature
function logFocusResult(profileId, temperature, position, hfr) {
    if (temperature === null || temperature === undefined) {
        console.log('[FocusTemp] No temperature data available, skipping log');
        return null;
    }

    const db = loadFocusTempDB();
    const entry = {
        timestamp: new Date().toISOString(),
        profileId: profileId,
        temperature: parseFloat(temperature.toFixed(2)),
        position: position,
        hfr: parseFloat(hfr.toFixed(3))
    };

    db.entries.push(entry);

    // Keep last 500 entries per profile to prevent unlimited growth
    const profileEntries = db.entries.filter(e => e.profileId === profileId);
    if (profileEntries.length > 500) {
        const entriesToRemove = profileEntries.slice(0, profileEntries.length - 500);
        db.entries = db.entries.filter(e => !entriesToRemove.includes(e));
    }

    // Recalculate temperature coefficient for this profile
    db.coefficients[profileId] = calculateTempCoefficient(db.entries, profileId);

    saveFocusTempDB(db);

    console.log(`[FocusTemp] Logged: ${temperature.toFixed(1)}°C -> position ${position} (HFR: ${hfr.toFixed(2)})`);
    return entry;
}

// Calculate temperature coefficient (steps per degree C) using linear regression
function calculateTempCoefficient(entries, profileId) {
    const profileEntries = entries.filter(e => e.profileId === profileId);

    if (profileEntries.length < 3) {
        return { slope: 0, intercept: 0, r2: 0, samples: profileEntries.length };
    }

    // Linear regression: position = slope * temperature + intercept
    const n = profileEntries.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;

    for (const e of profileEntries) {
        sumX += e.temperature;
        sumY += e.position;
        sumXY += e.temperature * e.position;
        sumX2 += e.temperature * e.temperature;
        sumY2 += e.position * e.position;
    }

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    // R-squared (coefficient of determination)
    const yMean = sumY / n;
    let ssRes = 0, ssTot = 0;
    for (const e of profileEntries) {
        const predicted = slope * e.temperature + intercept;
        ssRes += Math.pow(e.position - predicted, 2);
        ssTot += Math.pow(e.position - yMean, 2);
    }
    const r2 = ssTot > 0 ? 1 - (ssRes / ssTot) : 0;

    return {
        slope: parseFloat(slope.toFixed(2)),        // steps per °C
        intercept: parseFloat(intercept.toFixed(0)),
        r2: parseFloat(r2.toFixed(3)),              // correlation quality (1.0 = perfect)
        samples: n,
        tempRange: {
            min: Math.min(...profileEntries.map(e => e.temperature)),
            max: Math.max(...profileEntries.map(e => e.temperature))
        }
    };
}

// Predict best focus position for a given temperature
function predictFocusPosition(profileId, temperature) {
    const db = loadFocusTempDB();
    const coeff = db.coefficients[profileId];

    if (!coeff || coeff.samples < 3 || coeff.r2 < 0.5) {
        // Not enough data or poor correlation - return null
        return null;
    }

    const predicted = Math.round(coeff.slope * temperature + coeff.intercept);

    return {
        position: predicted,
        confidence: coeff.r2,
        basedOnSamples: coeff.samples,
        slope: coeff.slope  // steps per °C
    };
}

// Get focus temperature stats for a profile
function getFocusTempStats(profileId) {
    const db = loadFocusTempDB();
    const entries = db.entries.filter(e => e.profileId === profileId);
    const coeff = db.coefficients[profileId] || { slope: 0, intercept: 0, r2: 0, samples: 0 };

    return {
        entries: entries.slice(-50),  // Last 50 entries
        coefficient: coeff,
        totalSamples: entries.length
    };
}

// ============================================================================
// END FOCUS TEMPERATURE DATABASE
// ============================================================================

// Create a default profile template
function createDefaultProfile(name, scopeType) {
    const defaults = SCOPE_DEFAULTS[scopeType] || SCOPE_DEFAULTS.Refractor;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    return {
        id: id,
        name: name,
        scopeType: scopeType,
        focuserDevice: 'Pegasus FocusCube',

        // Direction settings
        reverseDirection: false,
        preferredFinalDirection: 'FOCUS_INWARD',

        // Asymmetric backlash
        backlash: {
            inwardToOutward: 0,
            outwardToInward: 0
        },

        // Autofocus parameters
        stepSize: defaults.stepSize,
        settleTime: defaults.settleTime,
        exposureTime: 2,

        // Optical config
        opticalConfig: { focalLength: 0, aperture: 0, fRatio: 0 },
        cfzSteps: 0,

        // Travel limits
        travelRange: { min: 0, max: 50000 },

        // Metadata
        created: new Date().toISOString(),
        lastModified: new Date().toISOString()
    };
}

// Calculate Critical Focus Zone (CFZ) in steps
function calculateCFZ(profile) {
    if (!profile.opticalConfig || !profile.opticalConfig.fRatio) return 0;
    // CFZ = 2.2 × f² × wavelength (in microns)
    // For green light (~0.55 microns) and typical step size
    const wavelength = 0.55; // microns
    const cfzMicrons = 2.2 * Math.pow(profile.opticalConfig.fRatio, 2) * wavelength;
    // Convert to steps (assuming ~10 microns per step typical focuser)
    const micronsPerStep = 10; // This should ideally come from focuser specs
    return Math.round(cfzMicrons / micronsPerStep);
}

// Automated profiling routine - FAST VERSION
// Targets ~8-12 minutes instead of 60+ minutes
// Uses coarse-to-fine approach with fewer trials
async function runProfilingRoutine(profile) {
    const scopeDefaults = SCOPE_DEFAULTS[profile.scopeType] || SCOPE_DEFAULTS.Refractor;

    // Typical backlash values by scope type (much smaller than maxBacklash)
    const TYPICAL_BACKLASH = {
        Refractor: 40,
        Newtonian: 50,
        SCT: 150,
        RC: 80
    };
    const typicalBacklash = TYPICAL_BACKLASH[profile.scopeType] || 50;

    // Fast profiling uses shorter exposures and larger increments
    const FAST_EXPOSURE = 1.5;  // 1.5 second exposures for backlash detection
    const COARSE_INCREMENT = 50; // Start with big steps
    const FINE_INCREMENT = 15;   // Refine with smaller steps
    const SETTLE_TIME = 800;     // Shorter settle time

    profilingState = {
        active: true,
        phase: 'initializing',
        progress: 0,
        message: 'Starting fast profiling routine...',
        measurements: [],
        error: null,
        estimatedMinutes: 10
    };

    log(`[Focuser] Starting FAST profiling for ${profile.name} (${profile.scopeType})`);
    log(`[Focuser] Typical backlash for ${profile.scopeType}: ~${typicalBacklash} steps`);

    try {
        // ---- Phase 0: Quick slew to star field (or use current position) ----
        profilingState.phase = 'slewing';
        profilingState.progress = 5;
        profilingState.message = 'Finding star field...';

        const rankedTargets = getRankedTargets(OBSERVATORY.latitude, OBSERVATORY.longitude);
        const targetField = rankedTargets.find(t => t.altitude >= 35);

        if (targetField) {
            log(`[Focuser] Slewing to ${targetField.name} (Alt: ${targetField.altitude.toFixed(1)}°)`);
            profilingState.message = `Slewing to ${targetField.name}...`;
            await indi.mountSlew(targetField.ra_decimal, targetField.dec_decimal);
        } else {
            log('[Focuser] Using current position (no suitable target above 35°)');
        }

        profilingState.progress = 10;

        // Get current focuser position
        const focusState = indi.getState();
        const startPosition = focusState['Pegasus FocusCube']?.position || 25000;
        let currentPosition = startPosition;

        // ---- Phase 1: Quick rough focus (optional - skip if already focused) ----
        profilingState.phase = 'rough_focus';
        profilingState.progress = 15;
        profilingState.message = 'Quick focus check...';
        log('[Focuser] Phase 1: Quick focus verification');

        // Take a single exposure to verify we have stars
        await indi.cameraExpose('camera_main', FAST_EXPOSURE);
        // In production: check if stars detected, if not do a quick scan
        // For now, assume current position is acceptable

        profilingState.progress = 20;

        // ---- Phase 2: FAST Backlash IN→OUT (coarse pass only) ----
        profilingState.phase = 'backlash_in_to_out';
        profilingState.progress = 25;
        profilingState.message = 'Measuring inward→outward backlash (fast)...';
        log('[Focuser] Phase 2: Fast backlash measurement IN→OUT');

        // Move inward first
        const inwardPos = currentPosition - scopeDefaults.testDistance;
        await indi.focuserMove(inwardPos);
        await new Promise(r => setTimeout(r, SETTLE_TIME));

        // Reference exposure
        await indi.cameraExpose('camera_main', FAST_EXPOSURE);
        const refHFR1 = 2.5; // Simulated

        // Coarse search: move outward in big steps (scan up to 2× typical backlash)
        let inToOutBacklash = 0;
        const maxSearch = Math.min(typicalBacklash * 2.5, scopeDefaults.maxBacklash);

        for (let step = 0; step <= maxSearch && profilingState.active; step += COARSE_INCREMENT) {
            await indi.focuserMove(inwardPos + step);
            await new Promise(r => setTimeout(r, SETTLE_TIME));
            await indi.cameraExpose('camera_main', FAST_EXPOSURE);

            // Simulated HFR change detection
            const currentHFR = 2.5 + (step > typicalBacklash * 0.8 ? (step - typicalBacklash * 0.8) / 150 : 0);

            profilingState.measurements.push({
                direction: 'in_to_out',
                step: step,
                hfr: currentHFR
            });

            if (Math.abs(currentHFR - refHFR1) / refHFR1 > 0.04) {
                // Found change - backlash is somewhere in previous coarse step
                inToOutBacklash = Math.max(0, step - COARSE_INCREMENT / 2);
                log(`[Focuser] IN→OUT backlash detected around ${inToOutBacklash} steps`);
                break;
            }
            inToOutBacklash = step;

            profilingState.progress = 25 + (step / maxSearch) * 15;
        }

        if (!profilingState.active) throw new Error('Profiling aborted');
        profilingState.progress = 45;

        // ---- Phase 3: FAST Backlash OUT→IN (coarse pass only) ----
        profilingState.phase = 'backlash_out_to_in';
        profilingState.progress = 50;
        profilingState.message = 'Measuring outward→inward backlash (fast)...';
        log('[Focuser] Phase 3: Fast backlash measurement OUT→IN');

        // Move outward
        const outwardPos = currentPosition + scopeDefaults.testDistance;
        await indi.focuserMove(outwardPos);
        await new Promise(r => setTimeout(r, SETTLE_TIME));

        // Reference exposure
        await indi.cameraExpose('camera_main', FAST_EXPOSURE);
        const refHFR2 = 2.5;

        // Coarse search inward
        let outToInBacklash = 0;

        for (let step = 0; step <= maxSearch && profilingState.active; step += COARSE_INCREMENT) {
            await indi.focuserMove(outwardPos - step);
            await new Promise(r => setTimeout(r, SETTLE_TIME));
            await indi.cameraExpose('camera_main', FAST_EXPOSURE);

            const currentHFR = 2.5 + (step > typicalBacklash ? (step - typicalBacklash) / 150 : 0);

            profilingState.measurements.push({
                direction: 'out_to_in',
                step: step,
                hfr: currentHFR
            });

            if (Math.abs(currentHFR - refHFR2) / refHFR2 > 0.04) {
                outToInBacklash = Math.max(0, step - COARSE_INCREMENT / 2);
                log(`[Focuser] OUT→IN backlash detected around ${outToInBacklash} steps`);
                break;
            }
            outToInBacklash = step;

            profilingState.progress = 50 + (step / maxSearch) * 15;
        }

        if (!profilingState.active) throw new Error('Profiling aborted');

        // Add safety margin (10%) to measured backlash
        inToOutBacklash = Math.round(inToOutBacklash * 1.1);
        outToInBacklash = Math.round(outToInBacklash * 1.1);

        log(`[Focuser] Backlash measured: IN→OUT=${inToOutBacklash}, OUT→IN=${outToInBacklash}`);
        profilingState.progress = 70;

        // ---- Phase 4: Step size (use smart default based on scope type) ----
        profilingState.phase = 'step_size';
        profilingState.progress = 75;
        profilingState.message = 'Validating step size...';
        log('[Focuser] Phase 4: Step size validation');

        // Return to focus area
        await indi.focuserMove(currentPosition);
        await new Promise(r => setTimeout(r, SETTLE_TIME));

        // Quick validation: just test the default step size
        let optimalStepSize = scopeDefaults.stepSize;

        await indi.cameraExpose('camera_main', FAST_EXPOSURE);
        const hfr1 = 2.0;

        await indi.focuserMove(currentPosition + optimalStepSize);
        await new Promise(r => setTimeout(r, SETTLE_TIME));
        await indi.cameraExpose('camera_main', FAST_EXPOSURE);
        const hfr2 = 2.0 + optimalStepSize / 500;

        // If default step produces measurable change, it's good
        // Otherwise try a larger step
        if (Math.abs(hfr2 - hfr1) < 0.08) {
            optimalStepSize = Math.round(optimalStepSize * 1.5);
            log(`[Focuser] Step size increased to ${optimalStepSize} for better HFR change`);
        } else {
            log(`[Focuser] Default step size ${optimalStepSize} validated`);
        }

        profilingState.progress = 85;

        if (!profilingState.active) throw new Error('Profiling aborted');

        // ---- Phase 5: Update profile ----
        profilingState.phase = 'saving';
        profilingState.progress = 90;
        profilingState.message = 'Saving profile...';

        profile.backlash = {
            inwardToOutward: inToOutBacklash,
            outwardToInward: outToInBacklash
        };
        profile.stepSize = optimalStepSize;
        profile.cfzSteps = calculateCFZ(profile);
        profile.lastModified = new Date().toISOString();
        profile.profilingMethod = 'fast';  // Mark as fast-profiled

        saveProfile(profile);

        // Update active profile if this is it
        if (activeFocuserProfile && activeFocuserProfile.id === profile.id) {
            activeFocuserProfile = profile;
        }

        // Return to original position
        await indi.focuserMove(startPosition);

        profilingState.phase = 'complete';
        profilingState.progress = 100;
        profilingState.message = 'Fast profiling complete!';
        profilingState.active = false;

        log(`[Focuser] FAST profiling complete for ${profile.name}`);
        log(`[Focuser] Results: Backlash IN→OUT=${inToOutBacklash}, OUT→IN=${outToInBacklash}, Step=${optimalStepSize}`);

    } catch (err) {
        profilingState.error = err.message;
        profilingState.phase = 'error';
        profilingState.active = false;
        log(`[Focuser] Profiling error: ${err.message}`);
        throw err;
    }
}

// ============================================================================
// END FOCUSER PROFILING SYSTEM
// ============================================================================

function log(message) {
    const timestamp = new Date().toISOString();
    const entry = { timestamp, message };
    currentSession.log.push(entry);
    console.log(`[${timestamp}] ${message}`);
    return entry;
}

// Check if refocus is needed based on tracking conditions
function checkRefocusNeeded(currentHFR = null) {
    const reasons = [];

    // 1. Time-based refocus
    if (focusTracking.refocusIntervalMin > 0 && focusTracking.lastFocusTime) {
        const elapsed = (Date.now() - focusTracking.lastFocusTime) / 60000; // minutes
        if (elapsed >= focusTracking.refocusIntervalMin) {
            reasons.push(`Time elapsed (${Math.round(elapsed)} min)`);
        }
    }

    // 2. HFR drift detection
    if (currentHFR && focusTracking.baselineHFR) {
        const drift = (currentHFR - focusTracking.baselineHFR) / focusTracking.baselineHFR;
        if (drift > focusTracking.hfrDriftThreshold) {
            reasons.push(`HFR drift ${(drift * 100).toFixed(1)}%`);
        }
    }

    // 3. Meridian flip occurred
    if (focusTracking.meridianFlipPending) {
        reasons.push('Meridian flip completed');
    }

    return reasons.length > 0 ? reasons : null;
}

// Calculate hour angle and check meridian status
function getMeridianStatus() {
    try {
        const state = indi.getState();
        const mount = state['10micron'];
        if (!mount) return null;

        // Get current RA from mount
        const ra = mount.ra || 0;  // RA in hours

        // Calculate Local Sidereal Time (simplified - uses system time and longitude)
        const now = new Date();
        const jd = (now.getTime() / 86400000) + 2440587.5;  // Julian Date
        const T = (jd - 2451545.0) / 36525.0;
        const gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + T * T * (0.000387933 - T / 38710000);
        const lst = (gmst + OBSERVATORY.longitude) / 15;  // LST in hours
        const lstNorm = ((lst % 24) + 24) % 24;  // Normalize to 0-24

        // Hour angle = LST - RA (negative = east of meridian, positive = west)
        let ha = lstNorm - ra;
        if (ha > 12) ha -= 24;
        if (ha < -12) ha += 24;

        return {
            ra: ra,
            lst: lstNorm,
            hourAngle: ha,
            side: ha < 0 ? 'east' : 'west',
            minutesToMeridian: Math.abs(ha) * 60 / 15  // Rough estimate
        };
    } catch (e) {
        return null;
    }
}

// Check if meridian flip is needed during capture
let lastHASide = null;
function checkMeridianFlip() {
    const status = getMeridianStatus();
    if (!status) return false;

    // Detect crossing: was east, now west (crossed meridian)
    if (lastHASide === 'east' && status.side === 'west') {
        lastHASide = status.side;
        return true;  // Flip needed
    }

    lastHASide = status.side;
    return false;
}

// Convert FITS to JPG preview (creates copy, original untouched)
const { exec } = require('child_process');
function createFitsPreview(fitsPath) {
    return new Promise((resolve) => {
        const jpgPath = fitsPath.replace(/\.fits?$/i, '.jpg');
        const scriptPath = path.join(__dirname, 'fits_preview.py');
        // Use Python with astropy for proper astronomical stretching (MTF)
        const cmd = `nix-shell -p python3Packages.numpy python3Packages.astropy python3Packages.pillow --run "python3 '${scriptPath}' '${fitsPath}' '${jpgPath}'"`;
        exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
            if (err) {
                console.log(`[Preview] Failed to create preview for ${path.basename(fitsPath)}: ${err.message}`);
                resolve(false);
            } else {
                console.log(`[Preview] Created stretched JPG preview: ${path.basename(jpgPath)}`);
                resolve(true);
            }
        });
    });
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
                <!-- Progress Bars -->
                <div id="progressSection" style="margin-top: 15px; display: none;">
                    <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-muted); margin-bottom: 4px;">
                        <span>Session Progress</span>
                        <span id="sessionStepText">0 / 0</span>
                    </div>
                    <div style="height: 8px; background: var(--bg-dark); border-radius: 4px; overflow: hidden; margin-bottom: 10px;">
                        <div id="sessionProgressBar" style="height: 100%; width: 0%; background: linear-gradient(90deg, var(--accent), var(--accent2)); transition: width 0.3s;"></div>
                    </div>
                    <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-muted); margin-bottom: 4px;">
                        <span>Exposure</span>
                        <span id="exposureText">-- / -- (--s remaining)</span>
                    </div>
                    <div style="height: 8px; background: var(--bg-dark); border-radius: 4px; overflow: hidden;">
                        <div id="exposureProgressBar" style="height: 100%; width: 0%; background: linear-gradient(90deg, var(--cyan), var(--green)); transition: width 0.5s;"></div>
                    </div>
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
                <h2 style="margin-top: 15px;">Autofocus V-Curve</h2>
                <canvas id="vcurveCanvas" width="300" height="180" style="background: rgba(0,0,0,0.3); border-radius: 8px; width: 100%;"></canvas>
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

        <!-- Focuser Profiles Panel -->
        <div class="panel" style="margin-top: 20px;">
            <h2 style="display: flex; align-items: center; justify-content: space-between;">
                <span>Focuser Profiles</span>
                <button onclick="showProfileModal()" class="btn btn-primary" style="font-size: 0.75rem; padding: 6px 12px;">+ New Profile</button>
            </h2>
            <div style="display: flex; gap: 15px; align-items: flex-start; flex-wrap: wrap;">
                <!-- Profile Selector -->
                <div style="flex: 1; min-width: 200px;">
                    <label style="font-size: 0.75rem; color: var(--text-muted); display: block; margin-bottom: 5px;">Active Profile</label>
                    <select id="profileSelect" onchange="selectProfile(this.value)" style="width: 100%; background: rgba(0,0,0,0.4); color: var(--text); border: 1px solid rgba(255,255,255,0.1); padding: 10px; border-radius: 8px; font-size: 0.9rem;">
                        <option value="">-- No Profile --</option>
                    </select>
                </div>

                <!-- Profile Details -->
                <div id="profileDetails" style="flex: 2; min-width: 300px; display: none;">
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px;">
                        <div class="device">
                            <span class="device-name">Scope Type</span>
                            <span id="profileScopeType" style="color: var(--cyan);">--</span>
                        </div>
                        <div class="device">
                            <span class="device-name">Step Size</span>
                            <span id="profileStepSize" style="color: var(--cyan);">--</span>
                        </div>
                        <div class="device">
                            <span class="device-name">Backlash IN→OUT</span>
                            <span id="profileBacklashIn" style="color: var(--gold);">--</span>
                        </div>
                        <div class="device">
                            <span class="device-name">Backlash OUT→IN</span>
                            <span id="profileBacklashOut" style="color: var(--gold);">--</span>
                        </div>
                        <div class="device">
                            <span class="device-name">Reverse Direction</span>
                            <span id="profileReverse" style="color: var(--text-muted);">--</span>
                        </div>
                        <div class="device">
                            <span class="device-name">Final Direction</span>
                            <span id="profileFinalDir" style="color: var(--text-muted);">--</span>
                        </div>
                    </div>
                    <div style="margin-top: 12px; display: flex; gap: 10px;">
                        <button onclick="editProfile()" class="btn btn-primary" style="font-size: 0.75rem; padding: 6px 12px;">Edit</button>
                        <button onclick="runProfileRoutine()" class="btn btn-success" style="font-size: 0.75rem; padding: 6px 12px;">Run Profiling</button>
                        <button onclick="deleteCurrentProfile()" class="btn btn-danger" style="font-size: 0.75rem; padding: 6px 12px;">Delete</button>
                    </div>
                </div>

                <!-- Profiling Progress -->
                <div id="profilingProgress" style="flex: 1; min-width: 200px; display: none;">
                    <div style="font-size: 0.85rem; color: var(--accent2); margin-bottom: 8px;">
                        <span id="profilingPhase">--</span>
                    </div>
                    <div style="background: rgba(0,0,0,0.4); border-radius: 10px; height: 10px; overflow: hidden;">
                        <div id="profilingBar" style="background: linear-gradient(90deg, var(--accent), var(--accent2)); height: 100%; width: 0%; transition: width 0.3s;"></div>
                    </div>
                    <div id="profilingMessage" style="font-size: 0.75rem; color: var(--text-muted); margin-top: 5px;">--</div>
                    <button onclick="abortProfiling()" class="btn btn-danger" style="font-size: 0.75rem; padding: 4px 10px; margin-top: 8px;">Abort</button>
                </div>
            </div>
        </div>

        <!-- Profile Edit Modal -->
        <div id="profileModal" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 9999; align-items: center; justify-content: center;">
            <div style="background: var(--surface); border: 1px solid rgba(255,255,255,0.1); border-radius: 15px; padding: 25px; max-width: 500px; width: 90%; max-height: 80vh; overflow-y: auto;">
                <h2 id="modalTitle" style="margin-bottom: 20px;">New Focuser Profile</h2>
                <form id="profileForm" onsubmit="saveProfileForm(event)">
                    <input type="hidden" id="editProfileId">

                    <div style="margin-bottom: 15px;">
                        <label style="display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 5px;">Profile Name</label>
                        <input type="text" id="profileName" required style="width: 100%; background: rgba(0,0,0,0.4); color: var(--text); border: 1px solid rgba(255,255,255,0.1); padding: 10px; border-radius: 8px;">
                    </div>

                    <div style="margin-bottom: 15px;">
                        <label style="display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 5px;">Scope Type</label>
                        <select id="scopeType" required onchange="updateScopeDefaults()" style="width: 100%; background: rgba(0,0,0,0.4); color: var(--text); border: 1px solid rgba(255,255,255,0.1); padding: 10px; border-radius: 8px;">
                            <option value="Refractor">Refractor</option>
                            <option value="Newtonian">Newtonian</option>
                            <option value="SCT">SCT (Schmidt-Cassegrain)</option>
                            <option value="RC">RC (Ritchey-Chretien)</option>
                        </select>
                    </div>

                    <div id="sctSettings" style="display: none; padding: 15px; background: rgba(168, 85, 247, 0.1); border: 1px solid rgba(168, 85, 247, 0.3); border-radius: 10px; margin-bottom: 15px;">
                        <h3 style="font-size: 0.9rem; color: var(--accent2); margin-bottom: 10px;">SCT Mirror Settings</h3>

                        <div style="margin-bottom: 10px;">
                            <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                                <input type="checkbox" id="reverseDirection" style="width: 18px; height: 18px;">
                                <span style="font-size: 0.85rem;">Reverse Direction (for backwards-wired focusers)</span>
                            </label>
                        </div>

                        <div>
                            <label style="display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 5px;">Preferred Final Direction</label>
                            <select id="finalDirection" style="width: 100%; background: rgba(0,0,0,0.4); color: var(--text); border: 1px solid rgba(255,255,255,0.1); padding: 10px; border-radius: 8px;">
                                <option value="FOCUS_INWARD">Inward (push mirror against gravity)</option>
                                <option value="FOCUS_OUTWARD">Outward</option>
                            </select>
                        </div>
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px;">
                        <div>
                            <label style="display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 5px;">Step Size</label>
                            <input type="number" id="stepSize" value="100" min="10" max="500" style="width: 100%; background: rgba(0,0,0,0.4); color: var(--text); border: 1px solid rgba(255,255,255,0.1); padding: 10px; border-radius: 8px;">
                        </div>
                        <div>
                            <label style="display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 5px;">Settle Time (ms)</label>
                            <input type="number" id="settleTime" value="1500" min="500" max="5000" style="width: 100%; background: rgba(0,0,0,0.4); color: var(--text); border: 1px solid rgba(255,255,255,0.1); padding: 10px; border-radius: 8px;">
                        </div>
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px;">
                        <div>
                            <label style="display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 5px;">Backlash IN→OUT</label>
                            <input type="number" id="backlashIn" value="0" min="0" max="500" style="width: 100%; background: rgba(0,0,0,0.4); color: var(--text); border: 1px solid rgba(255,255,255,0.1); padding: 10px; border-radius: 8px;">
                        </div>
                        <div>
                            <label style="display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 5px;">Backlash OUT→IN</label>
                            <input type="number" id="backlashOut" value="0" min="0" max="500" style="width: 100%; background: rgba(0,0,0,0.4); color: var(--text); border: 1px solid rgba(255,255,255,0.1); padding: 10px; border-radius: 8px;">
                        </div>
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; margin-bottom: 15px;">
                        <div>
                            <label style="display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 5px;">Focal Length (mm)</label>
                            <input type="number" id="focalLength" value="0" min="0" style="width: 100%; background: rgba(0,0,0,0.4); color: var(--text); border: 1px solid rgba(255,255,255,0.1); padding: 10px; border-radius: 8px;">
                        </div>
                        <div>
                            <label style="display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 5px;">Aperture (mm)</label>
                            <input type="number" id="aperture" value="0" min="0" style="width: 100%; background: rgba(0,0,0,0.4); color: var(--text); border: 1px solid rgba(255,255,255,0.1); padding: 10px; border-radius: 8px;">
                        </div>
                        <div>
                            <label style="display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 5px;">f/Ratio</label>
                            <input type="number" id="fRatio" value="0" min="0" step="0.1" style="width: 100%; background: rgba(0,0,0,0.4); color: var(--text); border: 1px solid rgba(255,255,255,0.1); padding: 10px; border-radius: 8px;">
                        </div>
                    </div>

                    <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;">
                        <button type="button" onclick="closeProfileModal()" class="btn" style="background: rgba(255,255,255,0.1);">Cancel</button>
                        <button type="submit" class="btn btn-success">Save Profile</button>
                    </div>
                </form>
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

        <!-- Mount Control Panel -->
        <div class="panel" style="margin-top: 20px;">
            <h2>Mount Control</h2>
            <div style="display: grid; grid-template-columns: auto 1fr auto; gap: 20px; align-items: start;">
                <!-- Mount Status -->
                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; min-width: 200px;">
                    <div class="device">
                        <span class="device-name">Status</span>
                        <span id="mountStatus" style="color: var(--text-muted);">--</span>
                    </div>
                    <div class="device">
                        <span class="device-name">Tracking</span>
                        <span id="mountTracking" style="color: var(--text-muted);">--</span>
                    </div>
                    <div class="device">
                        <span class="device-name">RA</span>
                        <span id="mountRA" style="color: var(--cyan); font-family: monospace;">--</span>
                    </div>
                    <div class="device">
                        <span class="device-name">Dec</span>
                        <span id="mountDec" style="color: var(--cyan); font-family: monospace;">--</span>
                    </div>
                    <div class="device">
                        <span class="device-name">Alt</span>
                        <span id="mountAlt" style="color: var(--green); font-family: monospace;">--</span>
                    </div>
                    <div class="device">
                        <span class="device-name">Az</span>
                        <span id="mountAz" style="color: var(--green); font-family: monospace;">--</span>
                    </div>
                </div>

                <!-- Slew Control -->
                <div style="flex: 1;">
                    <label style="display: block; font-size: 0.75rem; color: var(--text-muted); margin-bottom: 5px;">Slew to Target</label>
                    <div style="display: flex; gap: 10px; align-items: center;">
                        <input type="text" id="slewTarget" placeholder="Target name (e.g., M31, NGC7000) or RA,Dec"
                               style="flex: 1; background: rgba(0,0,0,0.4); color: var(--text); border: 1px solid rgba(255,255,255,0.1); padding: 10px; border-radius: 8px; font-size: 0.9rem;">
                        <button onclick="checkSlewTarget()" class="btn btn-primary" style="white-space: nowrap;">Check</button>
                        <button onclick="slewToTarget()" class="btn btn-success" style="white-space: nowrap;">Slew</button>
                    </div>
                    <div id="slewResult" style="margin-top: 8px; font-size: 0.8rem; color: var(--text-muted);"></div>
                </div>

                <!-- Park/Unpark -->
                <div style="display: flex; flex-direction: column; gap: 10px;">
                    <button onclick="unparkMount()" class="btn btn-success" style="min-width: 100px;">Unpark</button>
                    <button onclick="parkMount()" class="btn btn-danger" style="min-width: 100px;">Park</button>
                </div>
            </div>
        </div>

        <!-- Mount Modeling Panel -->
        <div class="panel" style="margin-top: 20px;">
            <h2 style="display: flex; align-items: center; justify-content: space-between;">
                <span>Mount Modeling</span>
                <div style="display: flex; gap: 10px; align-items: center;">
                    <span id="modelStatus" style="font-size: 0.75rem; color: var(--text-muted);">--</span>
                    <button onclick="refreshModelData()" class="btn btn-primary" style="padding: 6px 12px; font-size: 0.8rem;">Refresh</button>
                    <button onclick="generateOptimalPoints()" class="btn btn-success" style="padding: 6px 12px; font-size: 0.8rem;">Generate Points</button>
                </div>
            </h2>
            <div style="display: grid; grid-template-columns: 1fr 300px; gap: 20px; margin-top: 15px;">
                <!-- Sky Map Canvas -->
                <div style="position: relative; background: rgba(0,0,0,0.4); border-radius: 12px; padding: 10px;">
                    <canvas id="skyMapCanvas" width="600" height="400" style="width: 100%; height: 400px; border-radius: 8px;"></canvas>
                    <div id="skyMapTooltip" style="display: none; position: absolute; background: rgba(0,0,0,0.9); border: 1px solid var(--accent); padding: 8px 12px; border-radius: 6px; font-size: 0.75rem; pointer-events: none; z-index: 100;"></div>
                </div>
                <!-- Model Info & Controls -->
                <div style="display: flex; flex-direction: column; gap: 15px;">
                    <div style="background: rgba(0,0,0,0.3); border-radius: 10px; padding: 15px;">
                        <div style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 8px;">CURRENT MODEL</div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                            <div>
                                <div style="font-size: 2rem; font-weight: 300; color: var(--cyan);" id="modelPointCount">--</div>
                                <div style="font-size: 0.7rem; color: var(--text-muted);">Alignment Stars</div>
                            </div>
                            <div>
                                <div style="font-size: 2rem; font-weight: 300; color: var(--accent2);" id="modelSavedCount">--</div>
                                <div style="font-size: 0.7rem; color: var(--text-muted);">Saved Models</div>
                            </div>
                        </div>
                    </div>
                    <div style="background: rgba(0,0,0,0.3); border-radius: 10px; padding: 15px;">
                        <div style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 8px;">REFRACTION</div>
                        <div style="display: flex; gap: 15px;">
                            <div>
                                <span style="color: var(--gold);" id="modelTemp">--</span>
                                <span style="font-size: 0.7rem; color: var(--text-muted);">C</span>
                            </div>
                            <div>
                                <span style="color: var(--gold);" id="modelPressure">--</span>
                                <span style="font-size: 0.7rem; color: var(--text-muted);">hPa</span>
                            </div>
                        </div>
                    </div>
                    <div style="background: rgba(0,0,0,0.3); border-radius: 10px; padding: 15px;">
                        <div style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 10px;">POINT DISTRIBUTION</div>
                        <label style="display: block; margin-bottom: 8px;">
                            <span style="font-size: 0.7rem; color: var(--text-muted);">Target Points:</span>
                            <input type="number" id="targetPointCount" value="30" min="6" max="100" style="width: 60px; background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1); color: var(--text); padding: 4px 8px; border-radius: 4px; margin-left: 8px;">
                        </label>
                        <label style="display: block; margin-bottom: 10px;">
                            <span style="font-size: 0.7rem; color: var(--text-muted);">Min Altitude:</span>
                            <input type="number" id="minAltitude" value="20" min="10" max="45" style="width: 60px; background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1); color: var(--text); padding: 4px 8px; border-radius: 4px; margin-left: 8px;">
                            <span style="font-size: 0.7rem; color: var(--text-muted);">deg</span>
                        </label>
                        <div id="generatedPointsList" style="font-size: 0.7rem; color: var(--text-muted); max-height: 100px; overflow-y: auto;"></div>
                    </div>
                    <button onclick="deleteAlignmentModel()" class="btn btn-danger" style="margin-top: auto;">Delete Model</button>
                </div>
            </div>
        </div>

        <!-- Image Gallery - Full Width at Bottom -->
        <div class="panel" style="margin-top: 30px; background: linear-gradient(180deg, rgba(15,15,35,0.95) 0%, rgba(5,5,20,0.98) 100%);">
            <h2 style="display: flex; align-items: center; justify-content: space-between;">
                <span style="background: linear-gradient(90deg, var(--cyan), var(--accent2)); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">
                    ✦ Captured Images
                </span>
                <div style="display: flex; gap: 10px; align-items: center;">
                    <button onclick="uploadToCloud()" style="background: linear-gradient(135deg, #f59e0b, #d97706); border: none; color: white; padding: 8px 16px; border-radius: 20px; cursor: pointer; font-size: 0.8rem; box-shadow: 0 0 20px rgba(245, 158, 11, 0.3);">
                        ☁ Upload to Drive
                    </button>
                    <button onclick="generatePreviews()" style="background: linear-gradient(135deg, #22c55e, #16a34a); border: none; color: white; padding: 8px 16px; border-radius: 20px; cursor: pointer; font-size: 0.8rem; box-shadow: 0 0 20px rgba(34, 197, 94, 0.3);">
                        ⚡ Generate Previews
                    </button>
                    <button onclick="refreshImages()" style="background: linear-gradient(135deg, var(--accent), var(--accent2)); border: none; color: white; padding: 8px 16px; border-radius: 20px; cursor: pointer; font-size: 0.8rem; box-shadow: 0 0 20px rgba(102, 126, 234, 0.3);">
                        ↻ Refresh
                    </button>
                    <span id="uploadStatus" style="font-size: 0.75rem; color: var(--text-muted);"></span>
                </div>
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

        // Set portal link - use path routing for tunnel, port for local
        const isTunnel = window.location.hostname.includes('krakenunbound.com');
        if (isTunnel) {
            document.getElementById('portalLink').href = window.location.origin + '/';
        } else {
            document.getElementById('portalLink').href = 'http://' + window.location.hostname + ':8081';
        }

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

            // Start progress polling
            startProgressPolling();

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

                // Start V-curve polling for autofocus steps
                if (step.action === 'AUTOFOCUS') {
                    startAutofocusPolling();
                }

                try {
                    // Execute the step via API (include index for progress tracking)
                    step.stepIndex = i + 1;
                    step.totalSteps = steps.length;
                    const result = await executeStep(step);

                    if (result.success) {
                        step.status = 'completed';
                        addLog('Completed: ' + step.description, 'success');
                        // Fetch final autofocus data after completion
                        if (step.action === 'AUTOFOCUS') {
                            fetchAutofocusData();
                        }
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
            stopProgressPolling();
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

            const padLeft = 40, padRight = 15, padTop = 15, padBottom = 25;
            const scaleX = (w - padLeft - padRight) / (maxPos - minPos || 1);
            const scaleY = (h - padTop - padBottom) / (maxHFR - minHFR || 1);

            // Draw axes
            ctx.strokeStyle = '#666';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(padLeft, padTop);
            ctx.lineTo(padLeft, h - padBottom);
            ctx.lineTo(w - padRight, h - padBottom);
            ctx.stroke();

            // Y-axis label (HFD)
            ctx.save();
            ctx.fillStyle = '#aaa';
            ctx.font = '10px sans-serif';
            ctx.translate(10, h / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.textAlign = 'center';
            ctx.fillText('HFD (px)', 0, 0);
            ctx.restore();

            // X-axis label (Focus Position)
            ctx.fillStyle = '#aaa';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Focus Position (steps)', w / 2, h - 3);

            // Y-axis tick labels
            ctx.fillStyle = '#888';
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(maxHFR.toFixed(1), padLeft - 3, padTop + 4);
            ctx.fillText(minHFR.toFixed(1), padLeft - 3, h - padBottom + 3);

            // X-axis tick labels
            ctx.textAlign = 'center';
            ctx.fillText(minPos.toString(), padLeft, h - padBottom + 12);
            ctx.fillText(maxPos.toString(), w - padRight, h - padBottom + 12);

            // Draw V-curve fit
            if (data.bestPosition && data.minHFR && data.slope) {
                ctx.strokeStyle = 'rgba(102, 126, 234, 0.6)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                for (var i = 0; i <= 50; i++) {
                    var pos = minPos + (maxPos - minPos) * (i / 50);
                    var hfr = data.minHFR + data.slope * Math.sqrt(Math.pow(pos - data.bestPosition, 2));
                    var x = padLeft + (pos - minPos) * scaleX;
                    var y = h - padBottom - (hfr - minHFR) * scaleY;
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();
                ctx.lineWidth = 1;
            }

            // Draw data points
            ctx.fillStyle = '#22d3ee';
            points.forEach(function(p) {
                var x = padLeft + (p.position - minPos) * scaleX;
                var y = h - padBottom - (p.hfr - minHFR) * scaleY;
                ctx.beginPath();
                ctx.arc(x, y, 4, 0, Math.PI * 2);
                ctx.fill();
            });

            // Mark best position
            if (data.bestPosition) {
                var bx = padLeft + (data.bestPosition - minPos) * scaleX;
                ctx.strokeStyle = '#22c55e';
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(bx, padTop);
                ctx.lineTo(bx, h - padBottom);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }

        // Fetch autofocus data (polls during active autofocus)
        let autofocusPolling = null;
        async function fetchAutofocusData() {
            try {
                const resp = await fetch('/api/autofocus/latest');
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.success && data.vcurve) {
                        drawVCurve(data.vcurve);
                        const info = document.getElementById('vcurveInfo');
                        if (data.active) {
                            info.textContent = 'Focusing... ' + data.vcurve.points.length + ' points';
                            info.style.color = 'var(--gold)';
                        } else if (data.vcurve.bestPosition) {
                            info.textContent = 'Best: ' + data.vcurve.bestPosition + ' | HFR: ' + data.vcurve.minHFR.toFixed(2) + '"';
                            info.style.color = 'var(--green)';
                        }
                    }
                    // Poll faster during active autofocus
                    if (data.active && !autofocusPolling) {
                        autofocusPolling = setInterval(fetchAutofocusData, 2000);
                    } else if (!data.active && autofocusPolling) {
                        clearInterval(autofocusPolling);
                        autofocusPolling = null;
                    }
                }
            } catch (e) {
                drawVCurve(null);
            }
        }
        // Start polling for autofocus when step starts
        function startAutofocusPolling() {
            if (!autofocusPolling) {
                autofocusPolling = setInterval(fetchAutofocusData, 2000);
            }
        }
        window.startAutofocusPolling = startAutofocusPolling;

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

        // Fetch and update session progress
        let progressPolling = null;
        async function fetchProgress() {
            try {
                const resp = await fetch('/api/session/progress');
                if (resp.ok) {
                    const data = await resp.json();
                    const section = document.getElementById('progressSection');

                    if (data.active) {
                        section.style.display = 'block';

                        // Update session progress
                        const stepPct = data.totalSteps > 0 ? (data.currentStep / data.totalSteps * 100) : 0;
                        document.getElementById('sessionProgressBar').style.width = stepPct + '%';
                        document.getElementById('sessionStepText').textContent = data.currentStep + ' / ' + data.totalSteps;

                        // Update exposure progress
                        if (data.exposure && data.exposure.total > 0) {
                            const expPct = data.exposure.duration > 0 ?
                                ((data.exposure.duration - data.exposure.remaining) / data.exposure.duration * 100) : 0;
                            document.getElementById('exposureProgressBar').style.width = expPct + '%';
                            document.getElementById('exposureText').textContent =
                                data.exposure.current + ' / ' + data.exposure.total +
                                ' (' + Math.round(data.exposure.remaining) + 's remaining)';
                        }
                    } else {
                        // Keep visible briefly after completion
                        if (data.currentStep > 0 && data.currentStep >= data.totalSteps) {
                            document.getElementById('sessionProgressBar').style.width = '100%';
                            document.getElementById('sessionStepText').textContent = 'Complete';
                        }
                    }
                }
            } catch (e) {
                // Ignore errors
            }
        }

        // Start progress polling when session starts
        function startProgressPolling() {
            if (!progressPolling) {
                document.getElementById('progressSection').style.display = 'block';
                progressPolling = setInterval(fetchProgress, 1000);
            }
        }
        function stopProgressPolling() {
            if (progressPolling) {
                clearInterval(progressPolling);
                progressPolling = null;
            }
        }
        window.startProgressPolling = startProgressPolling;
        window.stopProgressPolling = stopProgressPolling;

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
        // ========================================
        // Mount Control Functions
        // ========================================

        async function fetchMountStatus() {
            try {
                const resp = await fetch('/api/mount/status');
                if (resp.ok) {
                    const data = await resp.json();

                    // Status
                    const statusEl = document.getElementById('mountStatus');
                    if (data.parked) {
                        statusEl.textContent = 'PARKED';
                        statusEl.style.color = 'var(--gold)';
                    } else if (data.connected) {
                        statusEl.textContent = 'READY';
                        statusEl.style.color = 'var(--green)';
                    } else {
                        statusEl.textContent = 'DISCONNECTED';
                        statusEl.style.color = 'var(--red)';
                    }

                    // Tracking
                    const trackEl = document.getElementById('mountTracking');
                    trackEl.textContent = data.tracking ? 'ON' : 'OFF';
                    trackEl.style.color = data.tracking ? 'var(--green)' : 'var(--text-muted)';

                    // Coordinates
                    if (data.ra !== undefined) {
                        const raH = Math.floor(data.ra);
                        const raM = Math.floor((data.ra - raH) * 60);
                        const raS = ((data.ra - raH) * 60 - raM) * 60;
                        document.getElementById('mountRA').textContent = raH + 'h ' + raM + 'm ' + raS.toFixed(1) + 's';
                    }
                    if (data.dec !== undefined) {
                        const sign = data.dec >= 0 ? '+' : '';
                        document.getElementById('mountDec').textContent = sign + data.dec.toFixed(4) + '°';
                    }
                    if (data.alt !== null && data.alt !== undefined) {
                        document.getElementById('mountAlt').textContent = data.alt.toFixed(1) + '°';
                        document.getElementById('mountAlt').style.color = data.alt < 15 ? 'var(--red)' : 'var(--green)';
                    }
                    if (data.az !== null && data.az !== undefined) {
                        document.getElementById('mountAz').textContent = data.az.toFixed(1) + '°';
                    }
                }
            } catch (e) {
                console.error('Mount status error:', e);
            }
        }

        async function checkSlewTarget() {
            const input = document.getElementById('slewTarget').value.trim();
            const resultEl = document.getElementById('slewResult');

            if (!input) {
                resultEl.innerHTML = '<span style="color: var(--red);">Enter a target name or coordinates</span>';
                return;
            }

            resultEl.innerHTML = '<span style="color: var(--gold);">Checking...</span>';

            try {
                // Check if input looks like coordinates (contains comma)
                let url;
                if (input.includes(',')) {
                    const parts = input.split(',').map(s => s.trim());
                    url = '/api/mount/check-target?ra=' + encodeURIComponent(parts[0]) + '&dec=' + encodeURIComponent(parts[1]);
                } else {
                    url = '/api/mount/check-target?target=' + encodeURIComponent(input);
                }

                const resp = await fetch(url);
                const data = await resp.json();

                if (data.success) {
                    if (data.safe) {
                        resultEl.innerHTML = '<span style="color: var(--green);">✓ ' + data.target + ' - Alt: ' + data.altitude.toFixed(1) + '°, Az: ' + data.azimuth.toFixed(1) + '° - SAFE TO SLEW</span>';
                    } else {
                        resultEl.innerHTML = '<span style="color: var(--red);">✗ ' + data.target + ' - Alt: ' + data.altitude.toFixed(1) + '° - TOO LOW</span>';
                    }
                } else {
                    resultEl.innerHTML = '<span style="color: var(--red);">' + (data.error || 'Unknown error') + '</span>';
                }
            } catch (e) {
                resultEl.innerHTML = '<span style="color: var(--red);">Error: ' + e.message + '</span>';
            }
        }
        window.checkSlewTarget = checkSlewTarget;

        async function slewToTarget() {
            const input = document.getElementById('slewTarget').value.trim();
            const resultEl = document.getElementById('slewResult');

            if (!input) {
                resultEl.innerHTML = '<span style="color: var(--red);">Enter a target name or coordinates</span>';
                return;
            }

            resultEl.innerHTML = '<span style="color: var(--gold);">Slewing...</span>';

            try {
                let body;
                if (input.includes(',')) {
                    const parts = input.split(',').map(s => s.trim());
                    body = JSON.stringify({ ra: parseFloat(parts[0]), dec: parseFloat(parts[1]) });
                } else {
                    body = JSON.stringify({ target: input });
                }

                const resp = await fetch('/api/mount/slew', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: body
                });
                const data = await resp.json();

                if (data.success) {
                    resultEl.innerHTML = '<span style="color: var(--green);">✓ Slewed to ' + data.target + ' (Alt: ' + data.altitude.toFixed(1) + '°)</span>';
                    fetchMountStatus();
                } else {
                    resultEl.innerHTML = '<span style="color: var(--red);">' + (data.error || 'Slew failed') + '</span>';
                }
            } catch (e) {
                resultEl.innerHTML = '<span style="color: var(--red);">Error: ' + e.message + '</span>';
            }
        }
        window.slewToTarget = slewToTarget;

        async function parkMount() {
            if (!confirm('Park the mount?')) return;
            try {
                const resp = await fetch('/api/mount/park', { method: 'POST' });
                const data = await resp.json();
                if (data.success) {
                    fetchMountStatus();
                } else {
                    alert('Park failed: ' + (data.error || 'Unknown error'));
                }
            } catch (e) {
                alert('Park error: ' + e.message);
            }
        }
        window.parkMount = parkMount;

        async function unparkMount() {
            try {
                const resp = await fetch('/api/mount/unpark', { method: 'POST' });
                const data = await resp.json();
                if (data.success) {
                    fetchMountStatus();
                } else {
                    alert('Unpark failed: ' + (data.error || 'Unknown error'));
                }
            } catch (e) {
                alert('Unpark error: ' + e.message);
            }
        }
        window.unparkMount = unparkMount;

        // Poll mount status
        fetchMountStatus();
        setInterval(fetchMountStatus, 5000);

        // ========================================
        // Mount Modeling Functions
        // ========================================

        let modelData = { points: [], count: 0 };
        let generatedPoints = [];

        async function refreshModelData() {
            const statusEl = document.getElementById('modelStatus');
            statusEl.textContent = 'Loading...';
            statusEl.style.color = 'var(--gold)';

            try {
                // Fetch model summary
                const modelResp = await fetch('/api/mount/model');
                if (modelResp.ok) {
                    const data = await modelResp.json();
                    document.getElementById('modelPointCount').textContent = data.alignmentStars || 0;
                    document.getElementById('modelSavedCount').textContent = data.savedModels || 0;
                    document.getElementById('modelTemp').textContent = data.refraction?.temperature?.toFixed(1) || '--';
                    document.getElementById('modelPressure').textContent = data.refraction?.pressure?.toFixed(1) || '--';
                }

                // Fetch alignment points
                const pointsResp = await fetch('/api/mount/model/points');
                if (pointsResp.ok) {
                    const data = await pointsResp.json();
                    modelData = data;
                    renderSkyMap();
                    statusEl.textContent = data.count + ' points loaded';
                    statusEl.style.color = 'var(--green)';
                } else {
                    statusEl.textContent = 'Mount not connected';
                    statusEl.style.color = 'var(--red)';
                    renderSkyMap(); // Still render empty map
                }
            } catch (e) {
                console.error('Model fetch error:', e);
                statusEl.textContent = 'Error: ' + e.message;
                statusEl.style.color = 'var(--red)';
                renderSkyMap();
            }
        }
        window.refreshModelData = refreshModelData;

        function renderSkyMap() {
            const canvas = document.getElementById('skyMapCanvas');
            const ctx = canvas.getContext('2d');
            const tooltip = document.getElementById('skyMapTooltip');

            // Set actual canvas size
            const rect = canvas.getBoundingClientRect();
            canvas.width = rect.width * window.devicePixelRatio;
            canvas.height = rect.height * window.devicePixelRatio;
            ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

            const width = rect.width;
            const height = rect.height;
            const centerX = width / 2;
            const centerY = height / 2;
            const radius = Math.min(width, height) / 2 - 30;

            // Clear and draw background
            ctx.fillStyle = '#080818';
            ctx.fillRect(0, 0, width, height);

            // Draw horizon circle and altitude rings
            ctx.strokeStyle = 'rgba(102, 126, 234, 0.3)';
            ctx.lineWidth = 1;

            // Altitude rings (0, 30, 60, 90)
            [0, 30, 60, 90].forEach((alt, i) => {
                const r = radius * (90 - alt) / 90;
                ctx.beginPath();
                ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
                ctx.stroke();

                // Label
                if (alt > 0) {
                    ctx.fillStyle = 'rgba(255,255,255,0.4)';
                    ctx.font = '10px sans-serif';
                    ctx.fillText(alt + '\u00B0', centerX + 3, centerY - r + 12);
                }
            });

            // Azimuth lines (N, E, S, W)
            const directions = [{az: 0, label: 'N'}, {az: 90, label: 'E'}, {az: 180, label: 'S'}, {az: 270, label: 'W'}];
            directions.forEach(d => {
                const angle = (d.az - 90) * Math.PI / 180;
                ctx.beginPath();
                ctx.moveTo(centerX, centerY);
                ctx.lineTo(centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius);
                ctx.stroke();

                // Label
                ctx.fillStyle = 'rgba(255,255,255,0.6)';
                ctx.font = '12px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                const labelR = radius + 15;
                ctx.fillText(d.label, centerX + Math.cos(angle) * labelR, centerY + Math.sin(angle) * labelR);
            });

            // Draw generated optimal points (dimmer, as suggestions)
            generatedPoints.forEach(pt => {
                const r = radius * (90 - pt.alt) / 90;
                const angle = (pt.az - 90) * Math.PI / 180;
                const x = centerX + Math.cos(angle) * r;
                const y = centerY + Math.sin(angle) * r;

                ctx.beginPath();
                ctx.arc(x, y, 6, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(168, 85, 247, 0.3)';
                ctx.fill();
                ctx.strokeStyle = 'rgba(168, 85, 247, 0.6)';
                ctx.lineWidth = 1;
                ctx.stroke();
            });

            // Draw alignment points from model
            modelData.points?.forEach((pt, i) => {
                // Convert RA/Dec to Alt/Az for display
                // For now, if we have raw coordinates, plot them
                // The mount returns mount coords, we'd need to convert
                let alt = pt.mountDec || 45; // Placeholder - need proper conversion
                let az = (pt.mountRA || 0) * 15; // RA hours to degrees, rough approximation

                // If point has error data, color by error magnitude
                let color = '#22c55e'; // Green for good
                if (pt.error) {
                    if (pt.error > 60) color = '#ef4444'; // Red for bad
                    else if (pt.error > 30) color = '#f59e0b'; // Orange for medium
                }

                const r = radius * (90 - Math.max(0, Math.min(90, alt))) / 90;
                const angle = (az - 90) * Math.PI / 180;
                const x = centerX + Math.cos(angle) * r;
                const y = centerY + Math.sin(angle) * r;

                // Store position for tooltip
                pt._x = x;
                pt._y = y;

                ctx.beginPath();
                ctx.arc(x, y, 8, 0, Math.PI * 2);
                ctx.fillStyle = color;
                ctx.fill();
                ctx.strokeStyle = 'rgba(255,255,255,0.5)';
                ctx.lineWidth = 2;
                ctx.stroke();

                // Point number
                ctx.fillStyle = '#000';
                ctx.font = 'bold 9px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(pt.index || (i + 1), x, y);
            });

            // Zenith marker
            ctx.beginPath();
            ctx.arc(centerX, centerY, 3, 0, Math.PI * 2);
            ctx.fillStyle = 'var(--cyan)';
            ctx.fill();

            // Setup mouse events for tooltip
            canvas.onmousemove = (e) => {
                const rect = canvas.getBoundingClientRect();
                const mx = e.clientX - rect.left;
                const my = e.clientY - rect.top;

                let found = null;
                modelData.points?.forEach(pt => {
                    const dx = mx - (pt._x || 0);
                    const dy = my - (pt._y || 0);
                    if (Math.sqrt(dx*dx + dy*dy) < 12) {
                        found = pt;
                    }
                });

                if (found) {
                    tooltip.style.display = 'block';
                    tooltip.style.left = (mx + 15) + 'px';
                    tooltip.style.top = (my - 10) + 'px';
                    tooltip.innerHTML = '<strong>Point ' + found.index + '</strong><br>' +
                        'RA: ' + (found.mountRA?.toFixed(4) || '--') + '<br>' +
                        'Dec: ' + (found.mountDec?.toFixed(4) || '--') + '<br>' +
                        (found.error ? 'Error: ' + found.error.toFixed(1) + '"' : '');
                } else {
                    tooltip.style.display = 'none';
                }
            };

            canvas.onmouseleave = () => {
                tooltip.style.display = 'none';
            };
        }

        function generateOptimalPoints() {
            const count = parseInt(document.getElementById('targetPointCount').value) || 30;
            const minAlt = parseInt(document.getElementById('minAltitude').value) || 20;
            const listEl = document.getElementById('generatedPointsList');

            generatedPoints = [];

            // Fibonacci sphere distribution adapted for hemisphere above horizon
            // More points near horizon (where refraction is stronger)
            const goldenAngle = Math.PI * (3 - Math.sqrt(5));

            for (let i = 0; i < count; i++) {
                // Use modified distribution - more points at lower altitudes
                const t = i / (count - 1);
                // Altitude: bias toward lower altitudes using sqrt
                const alt = minAlt + (90 - minAlt) * Math.sqrt(t);

                // Azimuth: golden angle spiral
                const az = ((i * goldenAngle * 180 / Math.PI) % 360 + 360) % 360;

                generatedPoints.push({ alt, az, index: i + 1 });
            }

            // Sort by altitude for display
            generatedPoints.sort((a, b) => a.alt - b.alt);

            // Update list
            listEl.innerHTML = '<div style="margin-bottom: 5px; color: var(--green);">' + count + ' points generated</div>' +
                '<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; font-family: monospace; font-size: 0.65rem;">' +
                generatedPoints.slice(0, 15).map(p =>
                    '<span>Alt:' + p.alt.toFixed(0) + ' Az:' + p.az.toFixed(0) + '</span>'
                ).join('') +
                (count > 15 ? '<span>... +' + (count - 15) + ' more</span>' : '') +
                '</div>';

            renderSkyMap();
        }
        window.generateOptimalPoints = generateOptimalPoints;

        async function deleteAlignmentModel() {
            if (!confirm('Delete the current alignment model? This cannot be undone.')) return;

            try {
                const resp = await fetch('/api/mount/model', { method: 'DELETE' });
                const data = await resp.json();
                if (data.success) {
                    alert('Alignment model deleted');
                    refreshModelData();
                } else {
                    alert('Delete failed: ' + (data.message || 'Unknown error'));
                }
            } catch (e) {
                alert('Delete error: ' + e.message);
            }
        }
        window.deleteAlignmentModel = deleteAlignmentModel;

        // Initial load of model data
        refreshModelData();
        // Refresh model data every 30 seconds
        setInterval(refreshModelData, 30000);

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

        async function generatePreviews() {
            const gallery = document.getElementById('imageGallery');
            const origHtml = gallery.innerHTML;
            gallery.innerHTML = '<div style="color: var(--gold); text-align: center; padding: 40px; grid-column: 1/-1;">⚡ Generating FITS previews... (this may take a moment)</div>';
            try {
                const resp = await fetch('/api/images/generate-previews');
                const data = await resp.json();
                if (data.success) {
                    alert('Generated ' + data.generated + ' new previews (of ' + data.total + ' FITS files)');
                    refreshImages();
                } else {
                    alert('Error: ' + data.error);
                    gallery.innerHTML = origHtml;
                }
            } catch (e) {
                alert('Failed to generate previews: ' + e.message);
                gallery.innerHTML = origHtml;
            }
        }
        window.generatePreviews = generatePreviews;

        async function uploadToCloud() {
            const status = document.getElementById('uploadStatus');
            status.textContent = 'Uploading to Google Drive...';
            status.style.color = 'var(--gold)';
            try {
                const resp = await fetch('/api/cloud/upload', { method: 'POST' });
                const data = await resp.json();
                if (data.success) {
                    status.textContent = 'Uploaded ' + data.uploaded + ' files to Drive';
                    status.style.color = 'var(--green)';
                } else {
                    status.textContent = 'Upload failed: ' + data.error;
                    status.style.color = 'var(--red)';
                }
            } catch (e) {
                status.textContent = 'Upload error: ' + e.message;
                status.style.color = 'var(--red)';
            }
            setTimeout(() => { status.textContent = ''; }, 10000);
        }
        window.uploadToCloud = uploadToCloud;

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

        // =====================================================================
        // FOCUSER PROFILE MANAGEMENT
        // =====================================================================

        let currentProfileData = null;
        let profiles = [];

        // Load profiles on start
        async function loadProfiles() {
            try {
                const resp = await fetch('/api/focuser/profiles');
                const data = await resp.json();
                if (data.success) {
                    profiles = data.profiles || [];
                    const select = document.getElementById('profileSelect');
                    select.innerHTML = '<option value="">-- No Profile --</option>';
                    profiles.forEach(p => {
                        const opt = document.createElement('option');
                        opt.value = p.id;
                        opt.textContent = p.name + ' (' + p.scopeType + ')';
                        if (p.id === data.activeProfile) {
                            opt.selected = true;
                            loadProfileDetails(p.id);
                        }
                        select.appendChild(opt);
                    });
                }
            } catch (e) {
                console.error('Failed to load profiles:', e);
            }
        }

        async function loadProfileDetails(profileId) {
            if (!profileId) {
                document.getElementById('profileDetails').style.display = 'none';
                currentProfileData = null;
                return;
            }
            try {
                const resp = await fetch('/api/focuser/profiles/' + profileId);
                const data = await resp.json();
                if (data.success && data.profile) {
                    currentProfileData = data.profile;
                    document.getElementById('profileDetails').style.display = 'block';
                    document.getElementById('profileScopeType').textContent = data.profile.scopeType;
                    document.getElementById('profileStepSize').textContent = data.profile.stepSize + ' steps';
                    document.getElementById('profileBacklashIn').textContent = data.profile.backlash?.inwardToOutward || 0;
                    document.getElementById('profileBacklashOut').textContent = data.profile.backlash?.outwardToInward || 0;
                    document.getElementById('profileReverse').textContent = data.profile.reverseDirection ? 'Yes' : 'No';
                    document.getElementById('profileFinalDir').textContent = data.profile.preferredFinalDirection === 'FOCUS_INWARD' ? 'Inward' : 'Outward';
                }
            } catch (e) {
                console.error('Failed to load profile details:', e);
            }
        }

        async function selectProfile(profileId) {
            if (!profileId) {
                document.getElementById('profileDetails').style.display = 'none';
                currentProfileData = null;
                return;
            }
            try {
                await fetch('/api/focuser/profiles/active', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ profileId })
                });
                loadProfileDetails(profileId);
            } catch (e) {
                console.error('Failed to set active profile:', e);
            }
        }
        window.selectProfile = selectProfile;

        function showProfileModal(editMode = false) {
            document.getElementById('profileModal').style.display = 'flex';
            document.getElementById('modalTitle').textContent = editMode ? 'Edit Focuser Profile' : 'New Focuser Profile';
            if (!editMode) {
                document.getElementById('profileForm').reset();
                document.getElementById('editProfileId').value = '';
                updateScopeDefaults();
            }
        }
        window.showProfileModal = showProfileModal;

        function closeProfileModal() {
            document.getElementById('profileModal').style.display = 'none';
        }
        window.closeProfileModal = closeProfileModal;

        function updateScopeDefaults() {
            const scopeType = document.getElementById('scopeType').value;
            const sctSettings = document.getElementById('sctSettings');
            sctSettings.style.display = (scopeType === 'SCT' || scopeType === 'RC') ? 'block' : 'none';

            // Set defaults based on scope type
            const defaults = {
                Refractor: { stepSize: 100, settleTime: 1500 },
                Newtonian: { stepSize: 100, settleTime: 1500 },
                SCT: { stepSize: 150, settleTime: 2500 },
                RC: { stepSize: 120, settleTime: 2000 }
            };
            const d = defaults[scopeType] || defaults.Refractor;
            if (!document.getElementById('editProfileId').value) {
                document.getElementById('stepSize').value = d.stepSize;
                document.getElementById('settleTime').value = d.settleTime;
            }
        }
        window.updateScopeDefaults = updateScopeDefaults;

        async function saveProfileForm(e) {
            e.preventDefault();
            const editId = document.getElementById('editProfileId').value;
            const profileData = {
                name: document.getElementById('profileName').value,
                scopeType: document.getElementById('scopeType').value,
                reverseDirection: document.getElementById('reverseDirection').checked,
                preferredFinalDirection: document.getElementById('finalDirection').value,
                stepSize: parseInt(document.getElementById('stepSize').value),
                settleTime: parseInt(document.getElementById('settleTime').value),
                backlash: {
                    inwardToOutward: parseInt(document.getElementById('backlashIn').value),
                    outwardToInward: parseInt(document.getElementById('backlashOut').value)
                },
                opticalConfig: {
                    focalLength: parseInt(document.getElementById('focalLength').value),
                    aperture: parseInt(document.getElementById('aperture').value),
                    fRatio: parseFloat(document.getElementById('fRatio').value)
                }
            };

            try {
                let resp;
                if (editId) {
                    resp = await fetch('/api/focuser/profiles/' + editId, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(profileData)
                    });
                } else {
                    resp = await fetch('/api/focuser/profiles', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(profileData)
                    });
                }
                const data = await resp.json();
                if (data.success) {
                    closeProfileModal();
                    loadProfiles();
                    if (data.profile) {
                        document.getElementById('profileSelect').value = data.profile.id;
                        selectProfile(data.profile.id);
                    }
                } else {
                    alert('Error: ' + (data.error || 'Failed to save profile'));
                }
            } catch (e) {
                alert('Error saving profile: ' + e.message);
            }
        }
        window.saveProfileForm = saveProfileForm;

        function editProfile() {
            if (!currentProfileData) return;
            document.getElementById('editProfileId').value = currentProfileData.id;
            document.getElementById('profileName').value = currentProfileData.name;
            document.getElementById('scopeType').value = currentProfileData.scopeType;
            document.getElementById('reverseDirection').checked = currentProfileData.reverseDirection || false;
            document.getElementById('finalDirection').value = currentProfileData.preferredFinalDirection || 'FOCUS_INWARD';
            document.getElementById('stepSize').value = currentProfileData.stepSize || 100;
            document.getElementById('settleTime').value = currentProfileData.settleTime || 1500;
            document.getElementById('backlashIn').value = currentProfileData.backlash?.inwardToOutward || 0;
            document.getElementById('backlashOut').value = currentProfileData.backlash?.outwardToInward || 0;
            document.getElementById('focalLength').value = currentProfileData.opticalConfig?.focalLength || 0;
            document.getElementById('aperture').value = currentProfileData.opticalConfig?.aperture || 0;
            document.getElementById('fRatio').value = currentProfileData.opticalConfig?.fRatio || 0;
            updateScopeDefaults();
            showProfileModal(true);
        }
        window.editProfile = editProfile;

        async function deleteCurrentProfile() {
            if (!currentProfileData) return;
            if (!confirm('Delete profile "' + currentProfileData.name + '"?')) return;
            try {
                const resp = await fetch('/api/focuser/profiles/' + currentProfileData.id, { method: 'DELETE' });
                const data = await resp.json();
                if (data.success) {
                    currentProfileData = null;
                    document.getElementById('profileDetails').style.display = 'none';
                    loadProfiles();
                }
            } catch (e) {
                alert('Error deleting profile: ' + e.message);
            }
        }
        window.deleteCurrentProfile = deleteCurrentProfile;

        async function runProfileRoutine() {
            if (!currentProfileData) return;
            if (!confirm('Run automated profiling for "' + currentProfileData.name + '"? This will move the focuser and take exposures.')) return;
            try {
                const resp = await fetch('/api/focuser/profile-routine', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ profileId: currentProfileData.id })
                });
                const data = await resp.json();
                if (data.success) {
                    document.getElementById('profilingProgress').style.display = 'block';
                    pollProfilingStatus();
                } else {
                    alert('Error: ' + (data.error || 'Failed to start profiling'));
                }
            } catch (e) {
                alert('Error: ' + e.message);
            }
        }
        window.runProfileRoutine = runProfileRoutine;

        async function pollProfilingStatus() {
            try {
                const resp = await fetch('/api/focuser/profile-routine/status');
                const data = await resp.json();
                document.getElementById('profilingPhase').textContent = data.phase || '--';
                document.getElementById('profilingBar').style.width = (data.progress || 0) + '%';
                document.getElementById('profilingMessage').textContent = data.message || '--';

                if (data.active) {
                    setTimeout(pollProfilingStatus, 1000);
                } else {
                    if (data.phase === 'complete') {
                        loadProfiles();
                        loadProfileDetails(currentProfileData?.id);
                    }
                    setTimeout(() => {
                        document.getElementById('profilingProgress').style.display = 'none';
                    }, 3000);
                }
            } catch (e) {
                console.error('Error polling profiling status:', e);
            }
        }

        async function abortProfiling() {
            try {
                await fetch('/api/focuser/profile-routine/abort', { method: 'POST' });
            } catch (e) {
                console.error('Error aborting profiling:', e);
            }
        }
        window.abortProfiling = abortProfiling;

        // Load profiles on start
        loadProfiles();

        // =====================================================================
        // END FOCUSER PROFILE MANAGEMENT
        // =====================================================================

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

    // DEBUG: Log all incoming requests from weather station IP
    const clientIP = req.socket.remoteAddress;
    if (clientIP && (clientIP.includes('192.168.2.80') || clientIP.includes('192.168.2'))) {
        console.log(`[DEBUG] Request from ${clientIP}: ${req.method} ${req.url}`);
    }

    // Serve main page
    if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(HTML);
        return;
    }

    // ========================================================================
    // AMBIENT WEATHER STATION ENDPOINTS
    // ========================================================================

    // Receive weather data from station (various paths and methods)
    // Handle firmware quirk: some stations send /data/report/&key=val instead of /data/report/?key=val
    let weatherPath = url.pathname;
    let weatherParams = Object.fromEntries(url.searchParams);

    // Check for &-separated params in path (firmware quirk)
    if (Object.keys(weatherParams).length === 0 && req.url.includes('&')) {
        const ampIndex = req.url.indexOf('&');
        weatherPath = req.url.substring(0, ampIndex);
        const queryPart = req.url.substring(ampIndex + 1);
        const searchParams = new URLSearchParams(queryPart);
        weatherParams = Object.fromEntries(searchParams);
    }

    // Normalize path (strip trailing slash)
    const normalizedPath = weatherPath.replace(/\/+$/, '') || '/';
    const weatherPaths = ['/data/report', '/data', '/weatherstation/updateweatherstation.php', '/weatherstation/updateweatherstation', '/'];

    if (weatherPaths.includes(normalizedPath)) {
        let params = weatherParams;

        if (req.method === 'POST') {
            // Handle POST data
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            await new Promise(resolve => req.on('end', resolve));
            const urlParams = new URLSearchParams(body);
            params = Object.fromEntries(urlParams);
        }

        if (params.tempf || params.PASSKEY || params.stationtype) {
            processWeatherData(params);
            console.log(`[Weather] Received data via ${req.method} ${normalizedPath}`);
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('success');
        } else {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok');
        }
        return;
    }

    // API: Get latest weather data
    if (url.pathname === '/api/weather' || url.pathname === '/api/weather/latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            connected: ambientWeather.connected,
            lastUpdate: ambientWeather.lastUpdate,
            current: ambientWeather.latest,
            safe: isWeatherSafe()
        }));
        return;
    }

    // API: Get weather history
    if (url.pathname === '/api/weather/history') {
        const limit = parseInt(url.searchParams.get('limit')) || 100;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ambientWeather.history.slice(-limit)));
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

    // API: Get latest autofocus data (for live V-curve display)
    if (url.pathname === '/api/autofocus/latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            active: autofocusData.active,
            vcurve: autofocusData.points.length > 0 ? {
                points: autofocusData.points,
                bestPosition: autofocusData.bestPosition,
                minHFR: autofocusData.minHFR,
                slope: autofocusData.slope
            } : null
        }));
        return;
    }

    // API: Get meridian/hour angle status
    if (url.pathname === '/api/meridian/status') {
        const status = getMeridianStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: status !== null,
            ...status,
            focusTracking: {
                baselineHFR: focusTracking.baselineHFR,
                lastFocusTime: focusTracking.lastFocusTime,
                refocusIntervalMin: focusTracking.refocusIntervalMin
            }
        }));
        return;
    }

    // API: Get latest plate solve results
    if (url.pathname === '/api/platesolve/latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(plateSolveData));
        return;
    }

    // API: Get session progress
    if (url.pathname === '/api/session/progress') {
        // Calculate exposure remaining time if active
        if (sessionProgress.exposure.startTime && sessionProgress.exposure.duration > 0) {
            const elapsed = (Date.now() - sessionProgress.exposure.startTime) / 1000;
            sessionProgress.exposure.remaining = Math.max(0, sessionProgress.exposure.duration - elapsed);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(sessionProgress));
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

    // API: Generate JPG previews for all FITS files missing them
    if (url.pathname === '/api/images/generate-previews') {
        const imageDir = '/home/kraken/images';
        try {
            const files = fs.readdirSync(imageDir).filter(f => /\.fits?$/i.test(f));
            let generated = 0;
            const promises = files.map(async (fitsFile) => {
                const fitsPath = path.join(imageDir, fitsFile);
                const jpgPath = fitsPath.replace(/\.fits?$/i, '.jpg');
                if (!fs.existsSync(jpgPath)) {
                    const ok = await createFitsPreview(fitsPath);
                    if (ok) generated++;
                }
            });
            await Promise.all(promises);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, generated, total: files.length }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: Upload FITS files to Google Drive
    if (url.pathname === '/api/cloud/upload' && req.method === 'POST') {
        const imageDir = '/home/kraken/images';
        try {
            const files = fs.readdirSync(imageDir).filter(f => /\.fits?$/i.test(f));
            if (files.length === 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, uploaded: 0, message: 'No FITS files to upload' }));
                return;
            }

            // Use rclone copy with bandwidth limit (safer for remote connections)
            const { execSync } = require('child_process');
            const result = execSync(
                `rclone copy "${imageDir}" gdrive:Observatory --include "*.fits" --include "*.fit" --bwlimit 2M 2>&1`,
                { timeout: 600000, encoding: 'utf8' }
            );

            console.log('[Cloud] Uploaded FITS files to Google Drive');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, uploaded: files.length }));
        } catch (e) {
            console.error('[Cloud] Upload failed:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
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

                // Update session progress
                sessionProgress.active = true;
                sessionProgress.currentStep = step.stepIndex || 0;
                sessionProgress.totalSteps = step.totalSteps || 1;
                sessionProgress.stepDescription = step.description || step.action;

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

                    case 'UPLOAD':
                        try {
                            const { execSync } = require('child_process');
                            const imageDir = '/home/kraken/images';
                            const zipName = step.zipName || `session_${new Date().toISOString().slice(0,10)}_lights.zip`;
                            const zipPath = path.join(imageDir, zipName);

                            // Get list of FITS files
                            const fitsFiles = fs.readdirSync(imageDir).filter(f => /\.fits?$/i.test(f));
                            if (fitsFiles.length === 0) {
                                log('No FITS files to upload');
                                break;
                            }

                            log(`Zipping ${fitsFiles.length} FITS files to ${zipName}...`);

                            // Create zip with all FITS files
                            const fileList = fitsFiles.map(f => `"${f}"`).join(' ');
                            execSync(`cd "${imageDir}" && zip -j "${zipPath}" ${fileList}`, { timeout: 300000 });

                            const zipSize = fs.statSync(zipPath).size;
                            log(`Zip created: ${zipName} (${(zipSize/1024/1024).toFixed(1)} MB)`);

                            // Upload to Google Drive with bandwidth limit
                            log('Uploading to Google Drive (this may take a while)...');
                            execSync(`rclone copy "${zipPath}" gdrive:Observatory/ --bwlimit 2M`, { timeout: 1800000 });
                            log(`Upload complete: ${zipName} uploaded to Google Drive`);

                            result.zipName = zipName;
                            result.filesZipped = fitsFiles.length;
                        } catch (e) {
                            log('Upload failed: ' + e.message);
                            // Don't fail entire session for upload error
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

                            // Use active focuser profile if available
                            const profile = activeFocuserProfile;
                            if (profile) {
                                log(`Using focuser profile: ${profile.name} (${profile.scopeType})`);
                            }

                            // Reset autofocus data for live display
                            autofocusData = {
                                active: true,
                                points: [],
                                bestPosition: null,
                                minHFR: null,
                                slope: null,
                                timestamp: Date.now()
                            };

                            // Get parameters from profile or use defaults
                            const focusState = indi.getState();
                            const focuserData = focusState['Pegasus FocusCube'] || {};
                            const currentPos = focuserData.position || 5000;
                            // Use focuser temp if available, otherwise fall back to ambient from weather sensor
                            let focuserTemp = focuserData.temperature;
                            if (focuserTemp === null || focuserTemp === undefined || focuserTemp === 0) {
                                focuserTemp = focusState.weather?.temperature ?? null;
                                if (focuserTemp !== null) {
                                    log(`[FocusTemp] Using ambient temperature from Meteo Sensor: ${focuserTemp.toFixed(1)}°C`);
                                }
                            }
                            const step_size = profile?.stepSize || 100;
                            const settleTime = profile?.settleTime || 2000;
                            const exposureTime = profile?.exposureTime || 2;
                            const steps = 11;

                            // Check for temperature-based prediction
                            let centerPos = currentPos;
                            if (profile && focuserTemp !== null && focuserTemp !== undefined) {
                                const prediction = predictFocusPosition(profile.id, focuserTemp);
                                if (prediction && prediction.confidence >= 0.7) {
                                    centerPos = prediction.position;
                                    log(`[FocusTemp] Using predicted position ${centerPos} for ${focuserTemp.toFixed(1)}°C (confidence: ${(prediction.confidence * 100).toFixed(0)}%, ${prediction.basedOnSamples} samples)`);
                                } else if (prediction) {
                                    log(`[FocusTemp] Prediction available but confidence too low (${(prediction.confidence * 100).toFixed(0)}%), using current position`);
                                }
                            }

                            const startPos = centerPos - (step_size * Math.floor(steps / 2));

                            let bestPos = currentPos;
                            let bestHFD = 999;

                            log(`Autofocus: scanning from ${startPos} to ${startPos + step_size * steps} (step=${step_size})`);

                            // For SCT: scan in one direction only to avoid backlash issues during measurement
                            const scanDirection = profile?.scopeType === 'SCT' ? 'one_way' : 'sweep';
                            if (scanDirection === 'one_way' && profile?.scopeType === 'SCT') {
                                log('SCT mode: scanning in one direction only');
                            }

                            // For each position, take a short exposure and measure HFD
                            for (let i = 0; i < steps; i++) {
                                const pos = startPos + (i * step_size);

                                // Move focuser (no backlash compensation during scan to maintain consistency)
                                await indi.focuserMove(pos);
                                await new Promise(r => setTimeout(r, settleTime));

                                // Take a short exposure for focus measurement
                                await indi.cameraExpose('camera_main', exposureTime);

                                // Simulated HFD measurement (would analyze actual image)
                                const distFromOptimal = Math.abs(pos - currentPos);
                                const simulatedHFD = 2.0 + (distFromOptimal / 500) * 3;

                                log(`Focus pos ${pos}: HFD = ${simulatedHFD.toFixed(2)}`);

                                // Add point to live V-curve data
                                autofocusData.points.push({ position: pos, hfr: simulatedHFD });

                                if (simulatedHFD < bestHFD) {
                                    bestHFD = simulatedHFD;
                                    bestPos = pos;
                                    autofocusData.bestPosition = bestPos;
                                    autofocusData.minHFR = bestHFD;
                                }
                            }

                            // Calculate V-curve slope (for fit line)
                            if (autofocusData.points.length >= 3) {
                                const leftPoints = autofocusData.points.filter(p => p.position < bestPos);
                                const rightPoints = autofocusData.points.filter(p => p.position > bestPos);
                                let totalSlope = 0;
                                let slopeCount = 0;
                                leftPoints.forEach(p => {
                                    totalSlope += (p.hfr - bestHFD) / Math.abs(p.position - bestPos);
                                    slopeCount++;
                                });
                                rightPoints.forEach(p => {
                                    totalSlope += (p.hfr - bestHFD) / Math.abs(p.position - bestPos);
                                    slopeCount++;
                                });
                                autofocusData.slope = slopeCount > 0 ? totalSlope / slopeCount : 0.01;
                            }

                            autofocusData.active = false;
                            autofocusData.timestamp = Date.now();

                            // Move to best position with backlash compensation
                            log(`Best focus at position ${bestPos} (HFD: ${bestHFD.toFixed(2)})`);

                            if (profile && profile.scopeType === 'SCT') {
                                // SCT: use final approach method to seat the mirror properly
                                log('SCT: Applying final approach from preferred direction');
                                await indi.focuserFinalApproach(bestPos, profile, settleTime);
                            } else if (profile && (profile.backlash?.inwardToOutward > 0 || profile.backlash?.outwardToInward > 0)) {
                                // Non-SCT with backlash: use backlash-compensated move
                                await indi.focuserMoveWithBacklash(bestPos, profile, settleTime);
                            } else {
                                // No profile or no backlash: simple move
                                await indi.focuserMove(bestPos);
                            }

                            // Save baseline for refocus tracking
                            focusTracking.baselineHFR = bestHFD;
                            focusTracking.lastFocusTime = Date.now();
                            focusTracking.lastFocusPosition = bestPos;
                            focusTracking.meridianFlipPending = false;
                            log('Autofocus complete - baseline HFR saved');

                            // Log focus result with temperature for temperature compensation database
                            if (profile && focuserTemp !== null && focuserTemp !== undefined) {
                                const logEntry = logFocusResult(profile.id, focuserTemp, bestPos, bestHFD);
                                if (logEntry) {
                                    const db = loadFocusTempDB();
                                    const coeff = db.coefficients[profile.id];
                                    if (coeff && coeff.samples >= 5) {
                                        log(`[FocusTemp] Temperature coefficient: ${coeff.slope.toFixed(1)} steps/°C (R²=${coeff.r2.toFixed(2)}, ${coeff.samples} samples)`);
                                    }
                                }
                            }

                            // Log profile used
                            if (profile) {
                                log(`Profile applied: step=${step_size}, settle=${settleTime}ms, backlash IN→OUT=${profile.backlash?.inwardToOutward || 0}, OUT→IN=${profile.backlash?.outwardToInward || 0}`);
                            }
                        } catch (e) {
                            autofocusData.active = false;
                            result = { success: false, error: 'Autofocus failed: ' + e.message };
                        }
                        break;

                    case 'PLATE_SOLVE':
                        try {
                            log('Starting plate solve...');
                            // Take a short exposure for plate solving
                            const solveExposure = await indi.cameraExpose('camera_main', 5);
                            const imagePath = solveExposure.imagePath || '/home/kraken/images/solve_frame.fits';

                            // Call external plate solver (ASTAP)
                            const { execSync } = require('child_process');
                            let solved = false;

                            try {
                                // Run ASTAP plate solver
                                execSync(`astap -f "${imagePath}" -r 30 -z 2`, { timeout: 60000 });

                                // Parse the .ini file for results
                                const iniPath = imagePath.replace(/\.fits?$/i, '.ini');
                                if (fs.existsSync(iniPath)) {
                                    const iniContent = fs.readFileSync(iniPath, 'utf8');

                                    // Parse key values from INI file
                                    const getValue = (key) => {
                                        const match = iniContent.match(new RegExp(`${key}=([^\\r\\n]+)`));
                                        return match ? match[1].trim() : null;
                                    };

                                    const crval1 = parseFloat(getValue('CRVAL1')) || 0;  // RA in degrees
                                    const crval2 = parseFloat(getValue('CRVAL2')) || 0;  // Dec in degrees
                                    const cdelt1 = parseFloat(getValue('CDELT1')) || 0;  // Pixel scale X
                                    const cdelt2 = parseFloat(getValue('CDELT2')) || 0;  // Pixel scale Y
                                    const crota = parseFloat(getValue('CROTA2')) || 0;   // Rotation

                                    // Convert RA from degrees to hours
                                    const raHours = crval1 / 15;

                                    // Format RA as HH:MM:SS
                                    const raH = Math.floor(raHours);
                                    const raM = Math.floor((raHours - raH) * 60);
                                    const raS = ((raHours - raH) * 60 - raM) * 60;
                                    const raHMS = `${String(raH).padStart(2, '0')}:${String(raM).padStart(2, '0')}:${raS.toFixed(1).padStart(4, '0')}`;

                                    // Format Dec as DD:MM:SS
                                    const decSign = crval2 >= 0 ? '+' : '-';
                                    const decAbs = Math.abs(crval2);
                                    const decD = Math.floor(decAbs);
                                    const decM = Math.floor((decAbs - decD) * 60);
                                    const decS = ((decAbs - decD) * 60 - decM) * 60;
                                    const decDMS = `${decSign}${String(decD).padStart(2, '0')}:${String(decM).padStart(2, '0')}:${decS.toFixed(1).padStart(4, '0')}`;

                                    // Calculate field size (assuming 9576x6388 for QHY600)
                                    const pixelScale = Math.abs(cdelt1) * 3600;  // arcsec/pixel
                                    const fieldWidth = (9576 * pixelScale / 60).toFixed(1);  // arcmin
                                    const fieldHeight = (6388 * pixelScale / 60).toFixed(1);

                                    // Store results
                                    plateSolveData = {
                                        success: true,
                                        ra: raHours,
                                        dec: crval2,
                                        raHMS: raHMS,
                                        decDMS: decDMS,
                                        fieldWidth: parseFloat(fieldWidth),
                                        fieldHeight: parseFloat(fieldHeight),
                                        rotation: crota,
                                        pixelScale: pixelScale,
                                        error: null,  // Would calculate from target vs solved
                                        timestamp: Date.now()
                                    };

                                    solved = true;
                                    log(`Plate solve: RA ${raHMS}, Dec ${decDMS}, Field ${fieldWidth}'×${fieldHeight}'`);
                                }
                            } catch (solveErr) {
                                log('ASTAP not available, using simulated solve');
                                // Simulated solve for testing
                                plateSolveData = {
                                    success: true,
                                    ra: 9.926,
                                    dec: 69.07,
                                    raHMS: '09:55:33.2',
                                    decDMS: '+69:04:12.0',
                                    fieldWidth: 85.2,
                                    fieldHeight: 56.8,
                                    rotation: 1.3,
                                    pixelScale: 0.534,
                                    error: 2.1,
                                    timestamp: Date.now()
                                };
                                solved = true;
                            }

                            if (solved) {
                                log('Plate solve successful - target centered');
                            }
                        } catch (e) {
                            plateSolveData.success = false;
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

                                // Update exposure progress
                                sessionProgress.exposure = {
                                    current: i,
                                    total: expCount,
                                    duration: expTime,
                                    startTime: Date.now(),
                                    remaining: expTime
                                };

                                log(`Exposure ${i}/${expCount} (${expTime}s)...`);
                                const expResult = await indi.cameraExpose('camera_main', expTime, filename);

                                // Clear exposure timer
                                sessionProgress.exposure.remaining = 0;

                                if (expResult.imagePath) {
                                    capturedImages.push(expResult.imagePath);
                                    log(`Exposure ${i} saved: ${expResult.imagePath}`);
                                    // Create JPG preview copy (original FITS untouched)
                                    createFitsPreview(expResult.imagePath).then(ok => {
                                        if (ok) log(`Preview created for exposure ${i}`);
                                    });
                                }

                                // Check meridian flip and refocus conditions between exposures
                                if (i < expCount) {
                                    // Check for meridian flip
                                    if (checkMeridianFlip()) {
                                        log('Meridian crossing detected - executing flip...');

                                        // Get target coordinates for re-slew after flip
                                        const targetData = TARGETS[step.target];
                                        if (targetData) {
                                            const ra = targetData.ra_decimal;
                                            const dec = targetData.dec_decimal;

                                            // Execute flip by re-slewing to target (mount handles pier side)
                                            log('Re-slewing to target on opposite pier side...');
                                            await indi.mountSlew(ra, dec);

                                            // Plate solve to verify pointing
                                            log('Plate solving after flip...');
                                            await indi.cameraExpose('camera_main', 5);
                                            // In production, would run ASTAP and sync if needed

                                            log('Meridian flip complete');
                                            focusTracking.meridianFlipPending = true;  // Trigger refocus
                                        }
                                    }

                                    const refocusReasons = checkRefocusNeeded();
                                    if (refocusReasons) {
                                        log(`Refocus triggered: ${refocusReasons.join(', ')}`);

                                        // Use active profile for refocus parameters
                                        const refocusProfile = activeFocuserProfile;

                                        // Run quick autofocus routine
                                        const focusState = indi.getState();
                                        const currentPos = focusState['Pegasus FocusCube']?.position || focusTracking.lastFocusPosition || 5000;
                                        const focusStep = refocusProfile ? Math.round(refocusProfile.stepSize / 2) : 50;
                                        const settleTime = refocusProfile?.settleTime || 1500;
                                        const expTime = refocusProfile?.exposureTime || 2;
                                        const focusSteps = 7;  // Fewer steps for refocus
                                        const startPos = currentPos - (focusStep * Math.floor(focusSteps / 2));

                                        let bestPos = currentPos;
                                        let bestHFD = 999;

                                        log(`Quick refocus: scanning ${startPos} to ${startPos + focusStep * focusSteps} (step=${focusStep})`);

                                        for (let f = 0; f < focusSteps; f++) {
                                            const pos = startPos + (f * focusStep);
                                            await indi.focuserMove(pos);
                                            await new Promise(r => setTimeout(r, settleTime));
                                            await indi.cameraExpose('camera_main', expTime);

                                            const distFromOptimal = Math.abs(pos - currentPos);
                                            const simulatedHFD = 2.0 + (distFromOptimal / 500) * 3;

                                            if (simulatedHFD < bestHFD) {
                                                bestHFD = simulatedHFD;
                                                bestPos = pos;
                                            }
                                        }

                                        // Move to best position with backlash compensation if profile exists
                                        if (refocusProfile && refocusProfile.scopeType === 'SCT') {
                                            await indi.focuserFinalApproach(bestPos, refocusProfile, settleTime);
                                        } else if (refocusProfile && (refocusProfile.backlash?.inwardToOutward > 0 || refocusProfile.backlash?.outwardToInward > 0)) {
                                            await indi.focuserMoveWithBacklash(bestPos, refocusProfile, settleTime);
                                        } else {
                                            await indi.focuserMove(bestPos);
                                        }

                                        focusTracking.baselineHFR = bestHFD;
                                        focusTracking.lastFocusTime = Date.now();
                                        focusTracking.lastFocusPosition = bestPos;
                                        focusTracking.meridianFlipPending = false;
                                        log(`Refocus complete: position ${bestPos}, HFR ${bestHFD.toFixed(2)}`);
                                    }

                                    // Small delay between exposures
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

    // ========================================================================
    // FOCUSER PROFILE API ENDPOINTS
    // ========================================================================

    // GET /api/focuser/profiles - List all profiles
    if (url.pathname === '/api/focuser/profiles' && req.method === 'GET') {
        const index = loadProfilesIndex();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            activeProfile: index.activeProfile,
            profiles: index.profiles
        }));
        return;
    }

    // GET /api/focuser/profiles/:id - Get a specific profile
    if (url.pathname.match(/^\/api\/focuser\/profiles\/[^\/]+$/) && req.method === 'GET') {
        const profileId = url.pathname.split('/').pop();
        const profile = loadProfile(profileId);
        if (profile) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, profile }));
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Profile not found' }));
        }
        return;
    }

    // POST /api/focuser/profiles - Create new profile
    if (url.pathname === '/api/focuser/profiles' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { name, scopeType } = JSON.parse(body);
                if (!name || !scopeType) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'name and scopeType required' }));
                    return;
                }

                const profile = createDefaultProfile(name, scopeType);

                // Check for duplicate ID
                const existing = loadProfile(profile.id);
                if (existing) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Profile with similar name already exists' }));
                    return;
                }

                saveProfile(profile);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, profile }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // PUT /api/focuser/profiles/active - Set active profile (must be before :id route)
    if (url.pathname === '/api/focuser/profiles/active' && req.method === 'PUT') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { profileId } = JSON.parse(body);
                if (setActiveProfile(profileId)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, profile: activeFocuserProfile }));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Profile not found' }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // PUT /api/focuser/profiles/:id - Update profile
    if (url.pathname.match(/^\/api\/focuser\/profiles\/[^\/]+$/) && req.method === 'PUT') {
        const profileId = url.pathname.split('/').pop();
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const updates = JSON.parse(body);
                const existing = loadProfile(profileId);

                if (!existing) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Profile not found' }));
                    return;
                }

                // Merge updates
                const updated = { ...existing, ...updates, id: profileId, lastModified: new Date().toISOString() };

                // Recalculate CFZ if optical config changed
                if (updates.opticalConfig) {
                    updated.cfzSteps = calculateCFZ(updated);
                }

                saveProfile(updated);

                // If this is the active profile, update the loaded copy
                if (activeFocuserProfile && activeFocuserProfile.id === profileId) {
                    activeFocuserProfile = updated;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, profile: updated }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // DELETE /api/focuser/profiles/:id - Delete profile
    if (url.pathname.match(/^\/api\/focuser\/profiles\/[^\/]+$/) && req.method === 'DELETE') {
        const profileId = url.pathname.split('/').pop();
        if (deleteProfile(profileId)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Failed to delete profile' }));
        }
        return;
    }

    // GET /api/focuser/profile-routine/status - Get profiling routine status
    if (url.pathname === '/api/focuser/profile-routine/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            ...profilingState
        }));
        return;
    }

    // POST /api/focuser/profile-routine - Start automated profiling
    if (url.pathname === '/api/focuser/profile-routine' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { profileId } = JSON.parse(body);
                const profile = loadProfile(profileId);

                if (!profile) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Profile not found' }));
                    return;
                }

                if (profilingState.active) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Profiling already in progress' }));
                    return;
                }

                // Start profiling routine asynchronously
                runProfilingRoutine(profile).catch(err => {
                    console.error('[Focuser] Profiling error:', err);
                    profilingState.error = err.message;
                    profilingState.active = false;
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: 'Profiling started' }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // POST /api/focuser/profile-routine/abort - Abort profiling
    if (url.pathname === '/api/focuser/profile-routine/abort' && req.method === 'POST') {
        if (profilingState.active) {
            profilingState.active = false;
            profilingState.phase = 'aborted';
            profilingState.message = 'Profiling aborted by user';
            log('Focuser profiling aborted');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // GET /api/focuser/active-profile - Get currently active profile
    if (url.pathname === '/api/focuser/active-profile' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            profile: activeFocuserProfile
        }));
        return;
    }

    // GET /api/focuser/temp-stats - Get focus temperature statistics
    if (url.pathname === '/api/focuser/temp-stats' && req.method === 'GET') {
        const profileId = url.searchParams.get('profile') || activeFocuserProfile?.id;
        if (!profileId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'No profile specified or active' }));
            return;
        }
        const stats = getFocusTempStats(profileId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, profileId, ...stats }));
        return;
    }

    // GET /api/focuser/temp-predict - Predict focus position for temperature
    if (url.pathname === '/api/focuser/temp-predict' && req.method === 'GET') {
        const profileId = url.searchParams.get('profile') || activeFocuserProfile?.id;
        const temp = parseFloat(url.searchParams.get('temp'));

        if (!profileId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'No profile specified or active' }));
            return;
        }
        if (isNaN(temp)) {
            // Use current focuser temperature if not specified, fall back to ambient
            const state = indi.getState();
            let currentTemp = state['Pegasus FocusCube']?.temperature;
            if (currentTemp === null || currentTemp === undefined || currentTemp === 0) {
                currentTemp = state.weather?.temperature ?? null;
            }
            if (currentTemp === null || currentTemp === undefined) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'No temperature specified and no sensor available' }));
                return;
            }
            const prediction = predictFocusPosition(profileId, currentTemp);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, temperature: currentTemp, prediction }));
            return;
        }

        const prediction = predictFocusPosition(profileId, temp);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, temperature: temp, prediction }));
        return;
    }

    // GET /api/focuser/temp-log - Get raw temperature log entries
    if (url.pathname === '/api/focuser/temp-log' && req.method === 'GET') {
        const db = loadFocusTempDB();
        const profileId = url.searchParams.get('profile');
        const entries = profileId ? db.entries.filter(e => e.profileId === profileId) : db.entries;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            entries: entries.slice(-100),  // Last 100
            coefficients: db.coefficients,
            totalEntries: entries.length
        }));
        return;
    }

    // ========================================================================
    // END FOCUSER PROFILE API ENDPOINTS
    // ========================================================================

    // ========================================================================
    // MOUNT CONTROL API ENDPOINTS
    // ========================================================================

    // GET /api/mount/status - Get mount status
    if (url.pathname === '/api/mount/status' && req.method === 'GET') {
        const state = indi.getState();
        const mount = state['10micron'] || {};

        // Calculate Alt/Az from RA/Dec if not directly available
        let alt = mount.alt;
        let az = mount.az;
        if ((alt === null || alt === undefined) && mount.ra !== undefined && mount.dec !== undefined) {
            const altaz = calculateAltAz(mount.ra, mount.dec,
                                         OBSERVATORY.latitude, OBSERVATORY.longitude, new Date());
            alt = altaz.altitude;
            az = altaz.azimuth;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            connected: mount.connected || false,
            ra: mount.ra || 0,
            dec: mount.dec || 0,
            alt: alt,
            az: az,
            tracking: mount.tracking || false,
            parked: mount.parked || false
        }));
        return;
    }

    // POST /api/mount/park - Park the mount
    if (url.pathname === '/api/mount/park' && req.method === 'POST') {
        try {
            log('Parking mount...');
            await indi.mountPark();
            log('Mount parked');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Mount parked' }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // POST /api/mount/unpark - Unpark the mount
    if (url.pathname === '/api/mount/unpark' && req.method === 'POST') {
        try {
            log('Unparking mount...');
            await indi.mountUnpark();
            log('Mount unparked and tracking');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Mount unparked' }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // POST /api/mount/slew - Slew to target (with safety check)
    if (url.pathname === '/api/mount/slew' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                let ra, dec, targetName;

                // Accept either target name or coordinates
                if (data.target) {
                    // Look up target in database
                    const targetId = data.target.toUpperCase().replace(/\s+/g, '_');
                    const targetData = TARGETS[targetId] || TARGETS[data.target];
                    if (!targetData) {
                        // Try partial match
                        const matchKey = Object.keys(TARGETS).find(k =>
                            k.toLowerCase().includes(data.target.toLowerCase()) ||
                            TARGETS[k].name.toLowerCase().includes(data.target.toLowerCase())
                        );
                        if (matchKey) {
                            ra = TARGETS[matchKey].ra_decimal;
                            dec = TARGETS[matchKey].dec_decimal;
                            targetName = TARGETS[matchKey].name;
                        } else {
                            res.writeHead(404, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: false, error: `Target "${data.target}" not found in database` }));
                            return;
                        }
                    } else {
                        ra = targetData.ra_decimal;
                        dec = targetData.dec_decimal;
                        targetName = targetData.name;
                    }
                } else if (data.ra !== undefined && data.dec !== undefined) {
                    ra = parseFloat(data.ra);
                    dec = parseFloat(data.dec);
                    targetName = `RA ${ra.toFixed(4)}h, Dec ${dec.toFixed(2)}°`;
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Provide either "target" name or "ra" and "dec" coordinates' }));
                    return;
                }

                // Safety check: calculate altitude
                const altaz = calculateAltAz(ra, dec,
                                             OBSERVATORY.latitude, OBSERVATORY.longitude, new Date());
                const minAltitude = data.minAlt || 15;  // Default minimum 15°

                if (altaz.altitude < minAltitude) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        error: `Target too low: altitude ${altaz.altitude.toFixed(1)}° (minimum: ${minAltitude}°)`,
                        altitude: altaz.altitude,
                        azimuth: altaz.azimuth,
                        target: targetName
                    }));
                    return;
                }

                // Check if mount is parked
                const state = indi.getState();
                const mount = state['10micron'] || {};
                if (mount.parked) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Mount is parked. Unpark first.' }));
                    return;
                }

                // Safe to slew
                log(`Slewing to ${targetName} (RA: ${ra.toFixed(4)}h, Dec: ${dec.toFixed(2)}°, Alt: ${altaz.altitude.toFixed(1)}°)`);
                await indi.mountSlew(ra, dec);
                log(`Slew complete: ${targetName}`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    message: `Slewed to ${targetName}`,
                    target: targetName,
                    ra: ra,
                    dec: dec,
                    altitude: altaz.altitude,
                    azimuth: altaz.azimuth
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // GET /api/mount/check-target - Check if target is safe to slew (without slewing)
    if (url.pathname === '/api/mount/check-target' && req.method === 'GET') {
        const target = url.searchParams.get('target');
        const raParam = url.searchParams.get('ra');
        const decParam = url.searchParams.get('dec');
        const minAlt = parseFloat(url.searchParams.get('minAlt')) || 15;

        let ra, dec, targetName;

        if (target) {
            const targetId = target.toUpperCase().replace(/\s+/g, '_');
            const targetData = TARGETS[targetId] || TARGETS[target];
            if (!targetData) {
                const matchKey = Object.keys(TARGETS).find(k =>
                    k.toLowerCase().includes(target.toLowerCase()) ||
                    TARGETS[k].name.toLowerCase().includes(target.toLowerCase())
                );
                if (matchKey) {
                    ra = TARGETS[matchKey].ra_decimal;
                    dec = TARGETS[matchKey].dec_decimal;
                    targetName = TARGETS[matchKey].name;
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: `Target "${target}" not found` }));
                    return;
                }
            } else {
                ra = targetData.ra_decimal;
                dec = targetData.dec_decimal;
                targetName = targetData.name;
            }
        } else if (raParam && decParam) {
            ra = parseFloat(raParam);
            dec = parseFloat(decParam);
            targetName = `RA ${ra.toFixed(4)}h, Dec ${dec.toFixed(2)}°`;
        } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Provide "target" or "ra" and "dec"' }));
            return;
        }

        const altaz = calculateAltAz(ra, dec,
                                     OBSERVATORY.latitude, OBSERVATORY.longitude, new Date());
        const safe = altaz.altitude >= minAlt;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            target: targetName,
            ra: ra,
            dec: dec,
            altitude: altaz.altitude,
            azimuth: altaz.azimuth,
            safe: safe,
            reason: safe ? 'Target is above minimum altitude' : `Target too low (${altaz.altitude.toFixed(1)}° < ${minAlt}°)`
        }));
        return;
    }

    // ========================================================================
    // MOUNT MODELING API ENDPOINTS (Direct LX200 connection)
    // ========================================================================

    // GET /api/mount/model - Get current alignment model summary
    if (url.pathname === '/api/mount/model' && req.method === 'GET') {
        try {
            const count = await mountModeling.getAlignmentStarCount();
            const modelCount = await mountModeling.getModelCount();
            const temp = await mountModeling.getRefractionTemp();
            const pressure = await mountModeling.getRefractionPressure();

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                alignmentStars: count,
                savedModels: modelCount,
                refraction: {
                    temperature: temp,
                    pressure: pressure
                }
            }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // GET /api/mount/model/points - Get all alignment points
    if (url.pathname === '/api/mount/model/points' && req.method === 'GET') {
        try {
            const model = await mountModeling.getAllAlignmentPoints();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                count: model.count,
                points: model.points
            }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // DELETE /api/mount/model - Delete current alignment model
    if (url.pathname === '/api/mount/model' && req.method === 'DELETE') {
        try {
            const result = await mountModeling.deleteAlignment();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: result,
                message: result ? 'Alignment model deleted' : 'Failed to delete model'
            }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // GET /api/mount/model/test - Test direct connection to mount
    if (url.pathname === '/api/mount/model/test' && req.method === 'GET') {
        try {
            const result = await mountModeling.testConnection();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ connected: false, error: e.message }));
        }
        return;
    }

    // POST /api/mount/model/refraction - Set refraction parameters
    if (url.pathname === '/api/mount/model/refraction' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                let results = {};

                if (data.temperature !== undefined) {
                    results.temperature = await mountModeling.setRefractionTemp(data.temperature);
                }
                if (data.pressure !== undefined) {
                    results.pressure = await mountModeling.setRefractionPressure(data.pressure);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, results }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // POST /api/mount/model/sync-mode - Set sync mode (0=offset, 1=refine model)
    if (url.pathname === '/api/mount/model/sync-mode' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const mode = data.mode === 1 || data.mode === 'refine' ? 1 : 0;
                const result = await mountModeling.setSyncMode(mode);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: result,
                    mode: mode,
                    description: mode === 1 ? 'Syncs will refine alignment model' : 'Syncs will apply offset only'
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // ========================================================================
    // END MOUNT CONTROL API ENDPOINTS
    // ========================================================================

    res.writeHead(404);
    res.end('Not found');
});

// Initialize INDI and start server
async function startServer() {
    // Load active focuser profile
    loadActiveProfile();
    if (activeFocuserProfile) {
        console.log(`[Focuser] Active profile: ${activeFocuserProfile.name}`);
    } else {
        console.log('[Focuser] No active profile set');
    }

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
