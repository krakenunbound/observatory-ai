// INDI Wrapper - Provides unified interface for both real INDI and simulation
// Automatically detects and connects to real INDI server if available

const INDIClient = require('./indi-client');
const INDISimulator = require('./indi-simulator');

class INDIWrapper {
    constructor(options = {}) {
        this.host = options.host || 'localhost';
        this.port = options.port || 7624;
        this.mode = 'unknown';  // 'real' or 'simulation'

        this.realClient = null;
        this.simulator = null;
        this.devices = {};
        this.listeners = [];

        // Device name mappings (real INDI names -> our names)
        this.deviceMap = {
            'Telescope Simulator': 'mount',
            'CCD Simulator': 'camera_main',
            'Focuser Simulator': 'focuser',
            'Guide Simulator': 'guider'
        };

        this.reverseMap = Object.fromEntries(
            Object.entries(this.deviceMap).map(([k, v]) => [v, k])
        );
    }

    // Try to connect to real INDI server, fall back to simulation
    async init() {
        try {
            console.log(`[INDI] Attempting to connect to INDI server at ${this.host}:${this.port}...`);

            this.realClient = new INDIClient(this.host, this.port);

            // Set up event forwarding
            this.realClient.on('newDevice', (device) => {
                console.log(`[INDI] Real device discovered: ${device}`);
                this.emit('newDevice', device);
            });

            this.realClient.on('propertyUpdate', (device, property, data) => {
                const ourName = this.deviceMap[device] || device;
                this.emit('propertyUpdate', ourName, property, data);
            });

            await this.realClient.connect();

            // Wait for devices to be discovered
            await new Promise(r => setTimeout(r, 2000));

            const devices = this.realClient.getDevices();
            const deviceCount = Object.keys(devices).length;

            if (deviceCount > 0) {
                this.mode = 'real';
                this.devices = devices;
                console.log(`[INDI] Connected to real INDI server with ${deviceCount} devices`);

                // Auto-connect all discovered devices
                for (const deviceName of Object.keys(devices)) {
                    console.log(`[INDI] Auto-connecting device: ${deviceName}`);
                    this.realClient.connectDevice(deviceName);
                }
                await new Promise(r => setTimeout(r, 1000));

                return { mode: 'real', devices: Object.keys(devices) };
            } else {
                throw new Error('No devices found on INDI server');
            }
        } catch (err) {
            console.log(`[INDI] Could not connect to real INDI: ${err.message}`);
            console.log('[INDI] Falling back to simulation mode');

            this.mode = 'simulation';
            this.simulator = new INDISimulator();
            this.simulator.startWeatherSimulation();

            this.simulator.onUpdate((device, property, value) => {
                this.emit('propertyUpdate', device, property, value);
            });

            return { mode: 'simulation', devices: Object.keys(this.simulator.devices) };
        }
    }

    // Subscribe to updates
    onUpdate(callback) {
        this.listeners.push(callback);
    }

    emit(event, ...args) {
        this.listeners.forEach(cb => {
            try {
                cb(event, ...args);
            } catch (e) {
                console.error('[INDI] Listener error:', e);
            }
        });
    }

    // Get current state of all devices
    getState() {
        if (this.mode === 'real') {
            const state = {};
            const devices = this.realClient.getDevices();

            for (const [name, device] of Object.entries(devices)) {
                const ourName = this.deviceMap[name] || name;
                const props = device.properties;

                // Extract connection status
                const connected = props.CONNECTION?.values?.CONNECT?.value || false;

                // Extract relevant properties based on device type
                const deviceState = { name, connected };

                if (ourName === 'mount' || name.toLowerCase().includes('telescope') || name.toLowerCase().includes('10micron')) {
                    const coords = props.EQUATORIAL_EOD_COORD?.values || {};
                    deviceState.ra = coords.RA?.value || 0;
                    deviceState.dec = coords.DEC?.value || 0;
                    deviceState.tracking = props.TELESCOPE_TRACK_STATE?.values?.TRACK_ON?.value || false;
                    deviceState.parked = props.TELESCOPE_PARK?.values?.PARK?.value || false;
                    // Get Alt/Az if available
                    const altaz = props.HORIZONTAL_COORD?.values || {};
                    deviceState.alt = altaz.ALT?.value ?? null;
                    deviceState.az = altaz.AZ?.value ?? null;
                }

                if (ourName === 'camera_main' || ourName === 'camera_mono' || name.toLowerCase().includes('ccd')) {
                    const temp = props.CCD_TEMPERATURE?.values || {};
                    deviceState.temperature = temp.CCD_TEMPERATURE_VALUE?.value || 20;
                    deviceState.exposing = props.CCD_EXPOSURE?.state === 'Busy';
                }

                if (ourName === 'focuser' || name.toLowerCase().includes('focus')) {
                    const pos = props.ABS_FOCUS_POSITION?.values || {};
                    deviceState.position = pos.FOCUS_ABSOLUTE_POSITION?.value || 0;
                    // Get focuser temperature (Pegasus FocusCube has temp sensor)
                    const temp = props.FOCUS_TEMPERATURE?.values || {};
                    deviceState.temperature = temp.TEMPERATURE?.value ?? null;
                }

                state[ourName] = deviceState;
            }

            // Parse weather from Uranus Meteo Sensor if available
            const weatherDevice = devices['Uranus Meteo Sensor'];
            if (weatherDevice) {
                const wProps = weatherDevice.properties;
                const wConnected = wProps.CONNECTION?.values?.CONNECT?.value || false;

                // Uranus Meteo Sensor uses SENSORS group for raw values
                const sensors = wProps.SENSORS?.values || {};
                const skyQuality = wProps.SKYQUALITY?.values || {};
                const weatherParams = wProps.WEATHER_PARAMETERS?.values || {};
                const weatherStatus = wProps.WEATHER_STATUS?.values || {};

                // Check if all weather statuses are OK
                const tempOk = weatherStatus.WEATHER_TEMPERATURE?.value === 'Ok';
                const humidOk = weatherStatus.WEATHER_HUMIDITY?.value === 'Ok';
                const cloudOk = weatherStatus.WEATHER_CLOUD?.value === 'Ok';
                const isSafe = tempOk && humidOk && cloudOk;

                state.weather = {
                    name: 'Uranus Meteo Sensor',
                    connected: wConnected,
                    temperature: sensors.AmbientTemperature?.value ?? 15,
                    humidity: sensors.RelativeHumidity?.value ?? 50,
                    dewPoint: sensors.DewPoint?.value ?? 5,
                    pressure: sensors.AbsolutePressure?.value ?? 1013,
                    skyTemperature: sensors.SkyTemperature?.value ?? null,
                    cloudCover: weatherParams.WEATHER_CLOUD?.value ?? 0,
                    skyQuality: skyQuality.MPAS?.value ?? null,
                    windSpeed: 0,  // Uranus Meteo Sensor doesn't have wind sensor
                    safe: isSafe
                };
            } else {
                // Fallback to simulated if no weather device found
                state.weather = {
                    name: 'Weather (simulated)',
                    connected: true,
                    temperature: 15,
                    humidity: 45,
                    dewPoint: 5,
                    cloudCover: 10,
                    skyQuality: 21.5,
                    windSpeed: 5,
                    safe: true
                };
            }

            state.roof = {
                name: 'Roof (simulated)',
                connected: true,
                state: 'CLOSED',
                position: 0
            };

            return state;
        } else {
            return this.simulator.getState();
        }
    }

    // Connect a device
    async connect(deviceKey) {
        if (this.mode === 'real') {
            const realName = this.reverseMap[deviceKey] || deviceKey;
            console.log(`[INDI] Connecting device: ${realName}`);
            this.realClient.connectDevice(realName);
            await new Promise(r => setTimeout(r, 1000));
            return { success: true };
        } else {
            return await this.simulator.connect(deviceKey);
        }
    }

    // Disconnect a device
    async disconnect(deviceKey) {
        if (this.mode === 'real') {
            const realName = this.reverseMap[deviceKey] || deviceKey;
            this.realClient.disconnectDevice(realName);
            return { success: true };
        } else {
            return await this.simulator.disconnect(deviceKey);
        }
    }

    // Mount commands
    async mountSlew(ra, dec) {
        if (this.mode === 'real') {
            console.log(`[INDI] Slewing to RA=${ra}h, Dec=${dec}°`);
            this.realClient.slewTo(ra, dec);
            // Wait for slew to complete (poll position)
            await this.waitForSlew(ra, dec);
            return { success: true };
        } else {
            return await this.simulator.mountSlew(ra, dec);
        }
    }

    async waitForSlew(targetRA, targetDec, timeout = 120000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            await new Promise(r => setTimeout(r, 1000));
            const devices = this.realClient.getDevices();
            const telescope = devices['10micron'];
            if (telescope) {
                const coords = telescope.properties.EQUATORIAL_EOD_COORD?.values;
                if (coords) {
                    const ra = coords.RA?.value;
                    const dec = coords.DEC?.value;
                    const raError = Math.abs(ra - targetRA);
                    const decError = Math.abs(dec - targetDec);
                    if (raError < 0.01 && decError < 0.1) {
                        console.log(`[INDI] Slew complete: RA=${ra.toFixed(4)}, Dec=${dec.toFixed(4)}`);
                        return;
                    }
                }
            }
        }
        console.log('[INDI] Slew timeout');
    }

    async mountPark() {
        if (this.mode === 'real') {
            console.log('[INDI] Parking mount');
            this.realClient.park();
            await new Promise(r => setTimeout(r, 5000));
            return { success: true };
        } else {
            return await this.simulator.mountPark();
        }
    }

    async mountUnpark() {
        if (this.mode === 'real') {
            console.log('[INDI] Unparking mount');
            this.realClient.unpark();
            await new Promise(r => setTimeout(r, 2000));
            return { success: true };
        } else {
            return await this.simulator.mountUnpark();
        }
    }

    // Camera commands

    // Configure camera upload settings
    async cameraSetupUpload(directory, prefix = 'IMAGE_XXX') {
        this.uploadDir = directory;
        this.uploadPrefix = prefix;
        if (this.mode === 'real') {
            this.realClient.setupCCDUpload(directory, prefix);
            this.realClient.disableOverscan();
            return { success: true };
        }
        return { success: true };
    }

    async cameraSetTemperature(deviceKey, temp) {
        if (this.mode === 'real') {
            console.log(`[INDI] Setting camera temperature to ${temp}°C`);
            this.realClient.setCCDTemperature(temp);
            return { success: true };
        } else {
            return await this.simulator.cameraSetTemperature(deviceKey, temp);
        }
    }

    async cameraExpose(deviceKey, duration, filename = null) {
        if (this.mode === 'real') {
            console.log(`[INDI] Starting ${duration}s exposure`);
            this.realClient.expose(duration);
            await new Promise(r => setTimeout(r, (duration + 5) * 1000)); // +5s for download

            // Return expected image path based on upload settings
            const dir = this.uploadDir || '/home/kraken/images';
            const imagePath = `${dir}/${filename || 'capture'}.fits`;
            return { success: true, imagePath };
        } else {
            return await this.simulator.cameraExpose(deviceKey, duration);
        }
    }

    // Focuser commands
    async focuserMove(position) {
        if (this.mode === 'real') {
            console.log(`[INDI] Moving focuser to position ${position}`);
            this.realClient.focusTo(position);
            await new Promise(r => setTimeout(r, 3000));
            return { success: true };
        } else {
            return await this.simulator.focuserMove(position);
        }
    }

    // Track last focuser move direction for backlash compensation
    lastFocuserDirection = null;
    lastFocuserPosition = null;

    // Focuser move with backlash compensation
    // profile: { backlash: { inwardToOutward, outwardToInward }, reverseDirection, preferredFinalDirection }
    async focuserMoveWithBacklash(targetPosition, profile = null, settleTime = 2000) {
        // Get current position
        const state = this.getState();
        const focuserDevice = state['Pegasus FocusCube'] || state['focuser'] || {};
        const currentPos = focuserDevice.position || this.lastFocuserPosition || 0;

        // Determine direction
        let direction = targetPosition > currentPos ? 'FOCUS_OUTWARD' : 'FOCUS_INWARD';

        // Reverse if profile says so
        if (profile && profile.reverseDirection) {
            direction = direction === 'FOCUS_INWARD' ? 'FOCUS_OUTWARD' : 'FOCUS_INWARD';
        }

        // Check if we need backlash compensation (direction reversal)
        let backlashSteps = 0;
        if (profile && profile.backlash && this.lastFocuserDirection) {
            if (this.lastFocuserDirection === 'FOCUS_INWARD' && direction === 'FOCUS_OUTWARD') {
                backlashSteps = profile.backlash.inwardToOutward || 0;
            } else if (this.lastFocuserDirection === 'FOCUS_OUTWARD' && direction === 'FOCUS_INWARD') {
                backlashSteps = profile.backlash.outwardToInward || 0;
            }
        }

        // Apply backlash compensation: overshoot then approach
        if (backlashSteps > 0) {
            const overshoot = direction === 'FOCUS_OUTWARD' ? targetPosition + backlashSteps : targetPosition - backlashSteps;
            console.log(`[INDI] Backlash compensation: overshooting to ${overshoot} before ${targetPosition}`);
            await this.focuserMove(overshoot);
            await new Promise(r => setTimeout(r, settleTime));
        }

        // Move to final target
        await this.focuserMove(targetPosition);
        await new Promise(r => setTimeout(r, settleTime));

        // Track direction for next move
        this.lastFocuserDirection = direction;
        this.lastFocuserPosition = targetPosition;

        return { success: true, direction, backlashApplied: backlashSteps > 0 };
    }

    // SCT-specific final approach: ensures we approach from the preferred direction
    async focuserFinalApproach(targetPosition, profile, settleTime = 2000) {
        if (!profile || profile.scopeType !== 'SCT') {
            // Non-SCT: just move directly with backlash compensation
            return this.focuserMoveWithBacklash(targetPosition, profile, settleTime);
        }

        // SCT: approach from preferred direction to seat the mirror
        const preferInward = profile.preferredFinalDirection === 'FOCUS_INWARD';
        const backlash = preferInward ?
            (profile.backlash?.outwardToInward || 100) :
            (profile.backlash?.inwardToOutward || 100);

        // Overshoot in opposite direction, then approach from preferred
        const overshootPos = preferInward ?
            targetPosition + backlash + 50 :  // Go outward first
            targetPosition - backlash - 50;   // Go inward first

        console.log(`[INDI] SCT final approach: overshoot to ${overshootPos}, then approach ${targetPosition} from ${profile.preferredFinalDirection}`);

        await this.focuserMove(overshootPos);
        await new Promise(r => setTimeout(r, settleTime));

        await this.focuserMove(targetPosition);
        await new Promise(r => setTimeout(r, settleTime));

        // Track direction
        this.lastFocuserDirection = profile.preferredFinalDirection;
        this.lastFocuserPosition = targetPosition;

        return { success: true, direction: profile.preferredFinalDirection, sctApproach: true };
    }

    // Filter wheel commands (simulation only for now)
    async filterChange(position) {
        if (this.mode === 'simulation') {
            return await this.simulator.filterChange(position);
        }
        return { success: true, filter: `Filter ${position}` };
    }

    // Roof commands (simulation only for now)
    async roofOpen() {
        if (this.mode === 'simulation') {
            return await this.simulator.roofOpen();
        }
        console.log('[INDI] Roof open (simulated)');
        return { success: true };
    }

    async roofClose() {
        if (this.mode === 'simulation') {
            return await this.simulator.roofClose();
        }
        console.log('[INDI] Roof close (simulated)');
        return { success: true };
    }

    // Calculate cloud cover from temperature differential
    // Clear sky is much colder than ambient (~-30°C or more)
    // Cloudy sky is closer to ambient temperature
    calculateCloudCover(ambientTemp, skyTemp) {
        if (ambientTemp == null || skyTemp == null) {
            return null;  // Can't calculate without both readings
        }
        const diff = ambientTemp - skyTemp;
        // diff >= 30°C = clear (0%), diff <= 0 = overcast (100%)
        const cloudPercent = Math.max(0, Math.min(100, 100 - (diff / 30) * 100));
        return Math.round(cloudPercent);
    }

    // Get mode info
    getMode() {
        return this.mode;
    }

    // Cleanup
    shutdown() {
        if (this.realClient) {
            this.realClient.disconnect();
        }
    }
}

module.exports = INDIWrapper;
