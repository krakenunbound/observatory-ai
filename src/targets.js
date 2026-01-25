// Deep Sky Object Database for Observatory AI
// Contains popular imaging targets with metadata

const TARGETS = {
    // Messier Objects
    "M1": {
        name: "Crab Nebula",
        type: "Supernova Remnant",
        constellation: "Taurus",
        ra: "05h 34m 31.94s",
        dec: "+22° 00' 52.2\"",
        ra_decimal: 5.5755,
        dec_decimal: 22.0145,
        magnitude: 8.4,
        size_arcmin: 6,
        recommended_ota: "EdgeHD",
        recommended_filters: ["Ha", "OIII", "RGB"],
        min_exposure: 120,
        notes: "Excellent narrowband target, strong Ha and OIII emission"
    },
    "M31": {
        name: "Andromeda Galaxy",
        type: "Spiral Galaxy",
        constellation: "Andromeda",
        ra: "00h 42m 44.3s",
        dec: "+41° 16' 09\"",
        ra_decimal: 0.7123,
        dec_decimal: 41.2692,
        magnitude: 3.4,
        size_arcmin: 190,
        recommended_ota: "TEC140",
        recommended_filters: ["LRGB"],
        min_exposure: 180,
        notes: "Very large, requires mosaic for full coverage. Core is bright."
    },
    "M33": {
        name: "Triangulum Galaxy",
        type: "Spiral Galaxy",
        constellation: "Triangulum",
        ra: "01h 33m 50.9s",
        dec: "+30° 39' 37\"",
        ra_decimal: 1.5641,
        dec_decimal: 30.6603,
        magnitude: 5.7,
        size_arcmin: 73,
        recommended_ota: "TEC140",
        recommended_filters: ["LRGB", "Ha"],
        min_exposure: 300,
        notes: "Low surface brightness, needs long exposures. Ha regions visible."
    },
    "M42": {
        name: "Orion Nebula",
        type: "Emission Nebula",
        constellation: "Orion",
        ra: "05h 35m 17.3s",
        dec: "-05° 23' 28\"",
        ra_decimal: 5.5881,
        dec_decimal: -5.3911,
        magnitude: 4.0,
        size_arcmin: 85,
        recommended_ota: "TEC140",
        recommended_filters: ["LRGB", "Ha", "OIII"],
        min_exposure: 30,
        notes: "Very bright core, HDR imaging recommended. Winter target."
    },
    "M45": {
        name: "Pleiades",
        type: "Open Cluster + Reflection Nebula",
        constellation: "Taurus",
        ra: "03h 47m 00s",
        dec: "+24° 07' 00\"",
        ra_decimal: 3.7833,
        dec_decimal: 24.1167,
        magnitude: 1.6,
        size_arcmin: 110,
        recommended_ota: "TEC140",
        recommended_filters: ["LRGB"],
        min_exposure: 180,
        notes: "Reflection nebulosity requires long exposures. Blue stars bright."
    },
    "M51": {
        name: "Whirlpool Galaxy",
        type: "Spiral Galaxy",
        constellation: "Canes Venatici",
        ra: "13h 29m 52.7s",
        dec: "+47° 11' 43\"",
        ra_decimal: 13.4980,
        dec_decimal: 47.1953,
        magnitude: 8.4,
        size_arcmin: 11,
        recommended_ota: "EdgeHD",
        recommended_filters: ["LRGB", "Ha"],
        min_exposure: 300,
        notes: "Classic spiral with companion NGC 5195. Ha shows HII regions."
    },
    "M57": {
        name: "Ring Nebula",
        type: "Planetary Nebula",
        constellation: "Lyra",
        ra: "18h 53m 35.1s",
        dec: "+33° 01' 45\"",
        ra_decimal: 18.8931,
        dec_decimal: 33.0292,
        magnitude: 8.8,
        size_arcmin: 1.5,
        recommended_ota: "EdgeHD",
        recommended_filters: ["LRGB", "OIII", "Ha"],
        min_exposure: 60,
        notes: "Small but bright. Benefits from long focal length."
    },
    "M81": {
        name: "Bode's Galaxy",
        type: "Spiral Galaxy",
        constellation: "Ursa Major",
        ra: "09h 55m 33.2s",
        dec: "+69° 03' 55\"",
        ra_decimal: 9.9259,
        dec_decimal: 69.0653,
        magnitude: 6.9,
        size_arcmin: 27,
        recommended_ota: "TEC140",
        recommended_filters: ["LRGB"],
        min_exposure: 300,
        notes: "Pair with M82 nearby. Excellent spiral structure."
    },
    "M82": {
        name: "Cigar Galaxy",
        type: "Starburst Galaxy",
        constellation: "Ursa Major",
        ra: "09h 55m 52.2s",
        dec: "+69° 40' 47\"",
        ra_decimal: 9.9312,
        dec_decimal: 69.6797,
        magnitude: 8.4,
        size_arcmin: 11,
        recommended_ota: "EdgeHD",
        recommended_filters: ["LRGB", "Ha"],
        min_exposure: 180,
        notes: "Strong Ha emission from starburst activity. Edge-on view."
    },
    "NGC7000": {
        name: "North America Nebula",
        type: "Emission Nebula",
        constellation: "Cygnus",
        ra: "20h 58m 47s",
        dec: "+44° 19' 48\"",
        ra_decimal: 20.9797,
        dec_decimal: 44.3300,
        magnitude: 4.0,
        size_arcmin: 120,
        recommended_ota: "TEC140",
        recommended_filters: ["Ha", "OIII", "SII"],
        min_exposure: 300,
        notes: "Huge nebula complex. Excellent narrowband target. Summer."
    },
    "IC1396": {
        name: "Elephant Trunk Nebula",
        type: "Emission Nebula",
        constellation: "Cepheus",
        ra: "21h 39m 06s",
        dec: "+57° 30' 00\"",
        ra_decimal: 21.6517,
        dec_decimal: 57.5000,
        magnitude: 3.5,
        size_arcmin: 170,
        recommended_ota: "TEC140",
        recommended_filters: ["Ha", "OIII", "SII"],
        min_exposure: 300,
        notes: "Large complex with iconic trunk feature. SHO palette excellent."
    },
    "NGC6992": {
        name: "Eastern Veil Nebula",
        type: "Supernova Remnant",
        constellation: "Cygnus",
        ra: "20h 56m 24s",
        dec: "+31° 43' 00\"",
        ra_decimal: 20.9400,
        dec_decimal: 31.7167,
        magnitude: 7.0,
        size_arcmin: 60,
        recommended_ota: "TEC140",
        recommended_filters: ["Ha", "OIII"],
        min_exposure: 180,
        notes: "Stunning filamentary structure. OIII dominant. Part of Veil complex."
    },
    "NGC2244": {
        name: "Rosette Nebula",
        type: "Emission Nebula",
        constellation: "Monoceros",
        ra: "06h 32m 24s",
        dec: "+04° 52' 00\"",
        ra_decimal: 6.5400,
        dec_decimal: 4.8667,
        magnitude: 4.8,
        size_arcmin: 80,
        recommended_ota: "TEC140",
        recommended_filters: ["Ha", "OIII", "SII"],
        min_exposure: 300,
        notes: "Winter nebula. Central cluster is bright. SHO palette works well."
    },
    "IC434": {
        name: "Horsehead Nebula",
        type: "Dark Nebula",
        constellation: "Orion",
        ra: "05h 40m 59s",
        dec: "-02° 27' 30\"",
        ra_decimal: 5.6831,
        dec_decimal: -2.4583,
        magnitude: 7.3,
        size_arcmin: 8,
        recommended_ota: "TEC140",
        recommended_filters: ["Ha", "RGB"],
        min_exposure: 300,
        notes: "Iconic dark nebula. Ha brings out the emission background."
    }
};

// Calculate altitude and azimuth for a target at given location and time
function calculateAltAz(ra_decimal, dec_decimal, lat, lon, date) {
    // Convert to radians
    const toRad = (deg) => deg * Math.PI / 180;
    const toDeg = (rad) => rad * 180 / Math.PI;

    // Julian date
    const JD = date.getTime() / 86400000 + 2440587.5;
    const T = (JD - 2451545.0) / 36525;

    // Greenwich Sidereal Time
    let GST = 280.46061837 + 360.98564736629 * (JD - 2451545) + T * T * (0.000387933 - T / 38710000);
    GST = ((GST % 360) + 360) % 360;

    // Local Sidereal Time
    let LST = GST + lon;
    LST = ((LST % 360) + 360) % 360;

    // Hour Angle
    const HA = LST - (ra_decimal * 15);
    const HA_rad = toRad(HA);

    const dec_rad = toRad(dec_decimal);
    const lat_rad = toRad(lat);

    // Altitude
    const sinAlt = Math.sin(dec_rad) * Math.sin(lat_rad) +
                   Math.cos(dec_rad) * Math.cos(lat_rad) * Math.cos(HA_rad);
    const alt = toDeg(Math.asin(sinAlt));

    // Azimuth
    const cosAz = (Math.sin(dec_rad) - Math.sin(toRad(alt)) * Math.sin(lat_rad)) /
                  (Math.cos(toRad(alt)) * Math.cos(lat_rad));
    let az = toDeg(Math.acos(Math.max(-1, Math.min(1, cosAz))));
    if (Math.sin(HA_rad) > 0) az = 360 - az;

    return { altitude: alt, azimuth: az, hourAngle: HA };
}

// Find best imaging window for a target
function findImagingWindow(target, lat, lon, date) {
    const windows = [];
    const startDate = new Date(date);
    startDate.setHours(18, 0, 0, 0); // Start at 6 PM

    for (let i = 0; i < 14 * 60; i += 15) { // Check every 15 min for 14 hours
        const checkTime = new Date(startDate.getTime() + i * 60000);
        const pos = calculateAltAz(target.ra_decimal, target.dec_decimal, lat, lon, checkTime);

        if (pos.altitude > 30) { // Above 30 degrees is good for imaging
            windows.push({
                time: checkTime,
                altitude: pos.altitude,
                azimuth: pos.azimuth
            });
        }
    }

    if (windows.length === 0) return null;

    // Find peak altitude
    const peak = windows.reduce((max, w) => w.altitude > max.altitude ? w : max, windows[0]);

    return {
        start: windows[0].time,
        end: windows[windows.length - 1].time,
        peak: peak.time,
        peakAltitude: peak.altitude,
        duration: (windows[windows.length - 1].time - windows[0].time) / 3600000
    };
}

// Suggest imaging parameters based on target and equipment
function suggestParameters(target, camera = 'QHY600C') {
    const params = {
        target: target.name,
        ota: target.recommended_ota,
        camera: camera,
        filters: target.recommended_filters,
        exposures: {}
    };

    if (camera === 'QHY600C') {
        // Color camera - single shot color
        params.exposures = {
            'RGB': { duration: target.min_exposure, count: 40 }
        };
    } else {
        // Mono camera with filters
        target.recommended_filters.forEach(filter => {
            if (filter === 'LRGB') {
                params.exposures['L'] = { duration: target.min_exposure, count: 30 };
                params.exposures['R'] = { duration: target.min_exposure, count: 15 };
                params.exposures['G'] = { duration: target.min_exposure, count: 15 };
                params.exposures['B'] = { duration: target.min_exposure, count: 15 };
            } else if (['Ha', 'OIII', 'SII'].includes(filter)) {
                params.exposures[filter] = { duration: 300, count: 20 }; // Narrowband needs longer
            } else if (filter === 'RGB') {
                params.exposures['R'] = { duration: target.min_exposure, count: 20 };
                params.exposures['G'] = { duration: target.min_exposure, count: 20 };
                params.exposures['B'] = { duration: target.min_exposure, count: 20 };
            }
        });
    }

    // Calculate total imaging time
    let totalSeconds = 0;
    for (const [filter, exp] of Object.entries(params.exposures)) {
        totalSeconds += exp.duration * exp.count;
    }
    params.totalImagingTime = totalSeconds / 3600; // hours

    return params;
}

// Get ranked targets for tonight based on current time and location
function getRankedTargets(lat, lon, minAltitude = 40) {
    const now = new Date();
    const ranked = [];

    for (const [id, target] of Object.entries(TARGETS)) {
        // Calculate current position
        const currentPos = calculateAltAz(target.ra_decimal, target.dec_decimal, lat, lon, now);

        // Find imaging window
        const window = findImagingWindow(target, lat, lon, now);

        if (!window) continue; // Not visible tonight

        // Calculate time remaining above minimum altitude
        let timeAboveMin = 0;
        const checkStart = new Date(Math.max(now.getTime(), window.start.getTime()));
        for (let t = checkStart.getTime(); t <= window.end.getTime(); t += 15 * 60000) {
            const pos = calculateAltAz(target.ra_decimal, target.dec_decimal, lat, lon, new Date(t));
            if (pos.altitude >= minAltitude) {
                timeAboveMin += 15;
            }
        }

        // Calculate when target reaches minimum altitude (setting)
        let setTime = null;
        if (currentPos.altitude >= minAltitude) {
            // Currently above min, find when it sets
            for (let t = now.getTime(); t <= window.end.getTime() + 3600000; t += 15 * 60000) {
                const pos = calculateAltAz(target.ra_decimal, target.dec_decimal, lat, lon, new Date(t));
                if (pos.altitude < minAltitude) {
                    setTime = new Date(t);
                    break;
                }
            }
        }

        // Calculate suggested exposure count based on available time
        const params = suggestParameters(target);
        const exposureTime = target.min_exposure || 120;
        const maxExposures = Math.floor((timeAboveMin * 60) / (exposureTime + 30)); // +30s for download/dither

        // Priority score: higher is better
        // - Bonus for being up now and high
        // - Bonus for longer imaging window
        // - Bonus for setting soon (image it before it's gone!)
        let priority = 0;

        if (currentPos.altitude >= minAltitude) {
            priority += 100; // Currently imageable
            priority += currentPos.altitude; // Higher is better

            // Urgency bonus: if it sets within 3 hours, boost priority
            if (setTime) {
                const hoursUntilSet = (setTime.getTime() - now.getTime()) / 3600000;
                if (hoursUntilSet < 3) {
                    priority += (3 - hoursUntilSet) * 30; // Up to 90 point bonus
                }
            }
        } else if (window.start > now) {
            // Rising later - lower priority but still viable
            const hoursUntilRise = (window.start.getTime() - now.getTime()) / 3600000;
            priority += 50 - hoursUntilRise * 10; // Closer rise time = higher priority
        }

        // Bonus for longer available window
        priority += Math.min(timeAboveMin / 60, 5) * 10; // Up to 50 points for 5+ hours

        ranked.push({
            id,
            ...target,
            currentAltitude: Math.round(currentPos.altitude * 10) / 10,
            currentAzimuth: Math.round(currentPos.azimuth),
            isUp: currentPos.altitude >= minAltitude,
            window: {
                start: window.start.toISOString(),
                end: window.end.toISOString(),
                peak: window.peak.toISOString(),
                peakAltitude: Math.round(window.peakAltitude * 10) / 10,
                duration: Math.round(window.duration * 10) / 10
            },
            timeAboveMinAlt: timeAboveMin, // minutes
            setTime: setTime ? setTime.toISOString() : null,
            suggestedExposures: Math.min(maxExposures, 50), // Cap at 50
            exposureTime: exposureTime,
            priority: Math.round(priority),
            params: params
        });
    }

    // Sort by priority (highest first)
    ranked.sort((a, b) => b.priority - a.priority);

    return ranked;
}

// Generate a session plan from selected targets
// targets can be array of IDs (strings) or objects with {id, exposures, exposureTime}
function generateSessionPlan(targets, lat, lon) {
    const now = new Date();
    const plan = {
        created: now.toISOString(),
        targets: [],
        totalExposureTime: 0,
        totalImages: 0,
        estimatedEnd: null,
        steps: []
    };

    // Get ranked info for each target
    const ranked = getRankedTargets(lat, lon);
    const targetMap = {};
    ranked.forEach(t => targetMap[t.id] = t);

    // Build targets list - handle both string IDs and objects with custom exposures
    const targetInputs = targets.map(t => {
        if (typeof t === 'string') {
            return { id: t, exposures: null, exposureTime: null };
        }
        return t;
    });

    // Add pre-session steps
    plan.steps.push({ action: 'CHECK_WEATHER', description: 'Verify weather conditions safe', status: 'pending', enabled: true });
    plan.steps.push({ action: 'COOL_CAMERA', description: 'Cool camera to -10°C', status: 'pending', enabled: true });
    plan.steps.push({ action: 'OPEN_ROOF', description: 'Open observatory roof', status: 'pending', enabled: true });
    plan.steps.push({ action: 'UNPARK_MOUNT', description: 'Unpark mount and enable tracking', status: 'pending', enabled: true });

    let currentTime = now.getTime() + 15 * 60000; // Start 15 min from now

    // Sort targets by optimal imaging order (by set time, earliest first)
    const orderedTargets = targetInputs
        .map(input => {
            const target = targetMap[input.id];
            if (!target) return null;
            return {
                ...target,
                customExposures: input.exposures,
                customExposureTime: input.exposureTime
            };
        })
        .filter(t => t)
        .sort((a, b) => {
            if (!a.setTime && !b.setTime) return b.priority - a.priority;
            if (!a.setTime) return 1;
            if (!b.setTime) return -1;
            return new Date(a.setTime).getTime() - new Date(b.setTime).getTime();
        });

    for (const target of orderedTargets) {
        // Use custom exposures if provided, otherwise use suggested
        const exposureCount = target.customExposures || target.suggestedExposures;
        const exposureTime = target.customExposureTime || target.exposureTime;
        const totalTargetTime = exposureCount * (exposureTime + 30); // +30s overhead

        plan.targets.push({
            id: target.id,
            name: target.name,
            ra: target.ra_decimal,
            dec: target.dec_decimal,
            exposureTime: exposureTime,
            exposureCount: exposureCount,
            totalTime: Math.round(totalTargetTime / 60), // minutes
            startTime: new Date(currentTime).toISOString()
        });

        // Add steps for this target (order: slew → autofocus → plate solve → capture)
        plan.steps.push({
            action: 'SLEW',
            target: target.id,
            description: `Slew to ${target.name}`,
            status: 'pending',
            enabled: true
        });
        plan.steps.push({
            action: 'AUTOFOCUS',
            target: target.id,
            description: `Autofocus on ${target.name}`,
            status: 'pending',
            enabled: true
        });
        plan.steps.push({
            action: 'PLATE_SOLVE',
            target: target.id,
            description: `Plate solve and center ${target.name}`,
            status: 'pending',
            enabled: true
        });
        plan.steps.push({
            action: 'CAPTURE',
            target: target.id,
            description: `Capture ${exposureCount} × ${exposureTime}s of ${target.name}`,
            exposureCount: exposureCount,
            exposureTime: exposureTime,
            status: 'pending',
            enabled: true
        });

        plan.totalExposureTime += totalTargetTime;
        plan.totalImages += exposureCount;
        currentTime += totalTargetTime * 1000 + 10 * 60000; // +10 min for slew/focus
    }

    // Add shutdown steps
    plan.steps.push({ action: 'PARK_MOUNT', description: 'Park mount', status: 'pending', enabled: true });
    plan.steps.push({ action: 'CLOSE_ROOF', description: 'Close observatory roof', status: 'pending', enabled: true });
    plan.steps.push({ action: 'WARM_CAMERA', description: 'Warm camera to ambient', status: 'pending', enabled: true });

    // Add upload step (enabled by default, can be unchecked for test sessions)
    const targetNames = plan.targets.map(t => t.id).join('-');
    const sessionDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    plan.steps.push({
        action: 'UPLOAD',
        description: `Zip and upload to Google Drive`,
        zipName: `${targetNames}_${sessionDate}_lights.zip`,
        status: 'pending',
        enabled: true
    });

    plan.estimatedEnd = new Date(currentTime).toISOString();
    plan.totalExposureTimeHours = Math.round(plan.totalExposureTime / 3600 * 10) / 10;

    return plan;
}

module.exports = { TARGETS, calculateAltAz, findImagingWindow, suggestParameters, getRankedTargets, generateSessionPlan };
