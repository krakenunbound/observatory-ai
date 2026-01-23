// INDI Device Simulator
// Simulates observatory hardware for testing when not connected to real devices

class INDISimulator {
    constructor() {
        this.devices = {
            mount: {
                name: "10 Micron 2000HPS",
                driver: "indi_lx200_10micron",
                connected: false,
                properties: {
                    ra: 0,
                    dec: 0,
                    tracking: false,
                    parked: true,
                    slewing: false,
                    pierSide: 'WEST'
                }
            },
            camera_main: {
                name: "QHY 600C",
                driver: "indi_qhy_ccd",
                connected: false,
                properties: {
                    temperature: 20,
                    targetTemp: -20,
                    cooling: false,
                    coolerPower: 0,
                    exposing: false,
                    exposure: 0,
                    gain: 100,
                    offset: 10
                }
            },
            camera_mono: {
                name: "QHY 16200A",
                driver: "indi_qhy_ccd",
                connected: false,
                properties: {
                    temperature: 20,
                    targetTemp: -20,
                    cooling: false,
                    coolerPower: 0,
                    exposing: false,
                    exposure: 0,
                    gain: 0,
                    offset: 50,
                    filter: 1
                }
            },
            guider: {
                name: "Lodestar X2",
                driver: "indi_sx_ccd",
                connected: false,
                properties: {
                    exposing: false,
                    exposure: 2,
                    guiding: false,
                    rmsRA: 0,
                    rmsDEC: 0
                }
            },
            focuser: {
                name: "Pegasus FocusCube",
                driver: "indi_pegasus_focuscube",
                connected: false,
                properties: {
                    position: 25000,
                    temperature: 15,
                    moving: false,
                    maxPosition: 50000
                }
            },
            rotator: {
                name: "Pegasus Falcon",
                driver: "indi_pegasus_falcon",
                connected: false,
                properties: {
                    angle: 0,
                    moving: false
                }
            },
            filterwheel: {
                name: "QHY CFW3",
                driver: "indi_qhy_wheel",
                connected: false,
                properties: {
                    position: 1,
                    moving: false,
                    filters: ['L', 'R', 'G', 'B', 'Ha', 'OIII', 'SII']
                }
            },
            weather: {
                name: "Pegasus Uranus",
                driver: "indi_pegasus_uranus",
                connected: false,
                properties: {
                    temperature: 12,
                    humidity: 45,
                    dewPoint: 2,
                    cloudCover: 10,
                    skyQuality: 21.5,
                    windSpeed: 5,
                    safe: true
                }
            },
            roof: {
                name: "Arduino Roof Controller",
                driver: "indi_rolloffino",
                connected: false,
                properties: {
                    state: 'CLOSED', // CLOSED, OPENING, OPEN, CLOSING
                    position: 0  // 0 = closed, 100 = open
                }
            },
            usbhub: {
                name: "Pegasus USB Hub",
                driver: "indi_pegasus_upb",
                connected: false,
                properties: {
                    ports: [true, true, true, true, true, true]
                }
            }
        };

        this.listeners = [];
    }

    // Subscribe to device updates
    onUpdate(callback) {
        this.listeners.push(callback);
    }

    emit(device, property, value) {
        this.listeners.forEach(cb => cb(device, property, value));
    }

    // Connect/disconnect device
    async connect(deviceKey) {
        const device = this.devices[deviceKey];
        if (!device) return { success: false, error: 'Device not found' };

        // Simulate connection delay
        await this.delay(500 + Math.random() * 1000);

        device.connected = true;
        this.emit(deviceKey, 'connected', true);
        return { success: true };
    }

    async disconnect(deviceKey) {
        const device = this.devices[deviceKey];
        if (!device) return { success: false, error: 'Device not found' };

        device.connected = false;
        this.emit(deviceKey, 'connected', false);
        return { success: true };
    }

    // Mount commands
    async mountSlew(ra, dec) {
        const mount = this.devices.mount;
        if (!mount.connected) return { success: false, error: 'Mount not connected' };
        if (mount.properties.parked) return { success: false, error: 'Mount is parked' };

        mount.properties.slewing = true;
        this.emit('mount', 'slewing', true);

        // Simulate slew time based on distance
        const distance = Math.sqrt(
            Math.pow(ra - mount.properties.ra, 2) +
            Math.pow(dec - mount.properties.dec, 2)
        );
        const slewTime = Math.min(30000, distance * 100 + 2000);

        await this.delay(slewTime);

        mount.properties.ra = ra;
        mount.properties.dec = dec;
        mount.properties.slewing = false;
        this.emit('mount', 'slewing', false);
        this.emit('mount', 'position', { ra, dec });

        return { success: true };
    }

    async mountPark() {
        const mount = this.devices.mount;
        if (!mount.connected) return { success: false, error: 'Mount not connected' };

        mount.properties.slewing = true;
        this.emit('mount', 'slewing', true);

        await this.delay(5000);

        mount.properties.parked = true;
        mount.properties.tracking = false;
        mount.properties.slewing = false;
        this.emit('mount', 'parked', true);
        this.emit('mount', 'slewing', false);

        return { success: true };
    }

    async mountUnpark() {
        const mount = this.devices.mount;
        if (!mount.connected) return { success: false, error: 'Mount not connected' };

        await this.delay(1000);

        mount.properties.parked = false;
        mount.properties.tracking = true;
        this.emit('mount', 'parked', false);
        this.emit('mount', 'tracking', true);

        return { success: true };
    }

    // Camera commands
    async cameraSetTemperature(deviceKey, temp) {
        const camera = this.devices[deviceKey];
        if (!camera || !camera.connected) return { success: false, error: 'Camera not connected' };

        camera.properties.targetTemp = temp;
        camera.properties.cooling = true;
        this.emit(deviceKey, 'targetTemp', temp);
        this.emit(deviceKey, 'cooling', true);

        // Simulate cooling
        this.simulateCooling(deviceKey);

        return { success: true };
    }

    async simulateCooling(deviceKey) {
        const camera = this.devices[deviceKey];
        if (!camera) return;

        const interval = setInterval(() => {
            if (!camera.properties.cooling || !camera.connected) {
                clearInterval(interval);
                return;
            }

            const diff = camera.properties.targetTemp - camera.properties.temperature;
            if (Math.abs(diff) < 0.5) {
                camera.properties.temperature = camera.properties.targetTemp;
                clearInterval(interval);
            } else {
                camera.properties.temperature += diff * 0.1;
                camera.properties.coolerPower = Math.min(100, Math.abs(diff) * 5);
            }
            this.emit(deviceKey, 'temperature', camera.properties.temperature);
            this.emit(deviceKey, 'coolerPower', camera.properties.coolerPower);
        }, 1000);
    }

    async cameraExpose(deviceKey, duration) {
        const camera = this.devices[deviceKey];
        if (!camera || !camera.connected) return { success: false, error: 'Camera not connected' };

        camera.properties.exposing = true;
        camera.properties.exposure = duration;
        this.emit(deviceKey, 'exposing', true);

        // Simulate exposure countdown
        const startTime = Date.now();
        const interval = setInterval(() => {
            const elapsed = (Date.now() - startTime) / 1000;
            const remaining = Math.max(0, duration - elapsed);
            this.emit(deviceKey, 'exposureRemaining', remaining);

            if (remaining <= 0) {
                clearInterval(interval);
                camera.properties.exposing = false;
                this.emit(deviceKey, 'exposing', false);
                this.emit(deviceKey, 'imageReady', true);
            }
        }, 500);

        await this.delay(duration * 1000);
        return { success: true, imagePath: `/tmp/simulated_${deviceKey}_${Date.now()}.fits` };
    }

    // Focuser commands
    async focuserMove(position) {
        const focuser = this.devices.focuser;
        if (!focuser.connected) return { success: false, error: 'Focuser not connected' };

        focuser.properties.moving = true;
        this.emit('focuser', 'moving', true);

        const steps = Math.abs(position - focuser.properties.position);
        const moveTime = steps / 10; // ~10 steps per ms

        await this.delay(moveTime);

        focuser.properties.position = position;
        focuser.properties.moving = false;
        this.emit('focuser', 'position', position);
        this.emit('focuser', 'moving', false);

        return { success: true };
    }

    // Filter wheel commands
    async filterChange(position) {
        const fw = this.devices.filterwheel;
        if (!fw.connected) return { success: false, error: 'Filter wheel not connected' };

        fw.properties.moving = true;
        this.emit('filterwheel', 'moving', true);

        await this.delay(2000 + Math.random() * 1000);

        fw.properties.position = position;
        fw.properties.moving = false;
        this.emit('filterwheel', 'position', position);
        this.emit('filterwheel', 'moving', false);

        return { success: true, filter: fw.properties.filters[position - 1] };
    }

    // Roof commands
    async roofOpen() {
        const roof = this.devices.roof;
        if (!roof.connected) return { success: false, error: 'Roof controller not connected' };
        if (roof.properties.state === 'OPEN') return { success: true };

        // Safety check - mount must be parked
        if (!this.devices.mount.properties.parked) {
            return { success: false, error: 'Cannot open roof - mount not parked' };
        }

        roof.properties.state = 'OPENING';
        this.emit('roof', 'state', 'OPENING');

        // Simulate roof opening
        for (let i = 0; i <= 100; i += 5) {
            await this.delay(500);
            roof.properties.position = i;
            this.emit('roof', 'position', i);
        }

        roof.properties.state = 'OPEN';
        this.emit('roof', 'state', 'OPEN');

        return { success: true };
    }

    async roofClose() {
        const roof = this.devices.roof;
        if (!roof.connected) return { success: false, error: 'Roof controller not connected' };
        if (roof.properties.state === 'CLOSED') return { success: true };

        // Safety check - mount must be parked
        if (!this.devices.mount.properties.parked) {
            return { success: false, error: 'Cannot close roof - mount not parked' };
        }

        roof.properties.state = 'CLOSING';
        this.emit('roof', 'state', 'CLOSING');

        for (let i = 100; i >= 0; i -= 5) {
            await this.delay(500);
            roof.properties.position = i;
            this.emit('roof', 'position', i);
        }

        roof.properties.state = 'CLOSED';
        this.emit('roof', 'state', 'CLOSED');

        return { success: true };
    }

    // Weather simulation
    startWeatherSimulation() {
        setInterval(() => {
            const weather = this.devices.weather;
            if (!weather.connected) return;

            // Slight random variations
            weather.properties.temperature += (Math.random() - 0.5) * 0.2;
            weather.properties.humidity += (Math.random() - 0.5) * 1;
            weather.properties.humidity = Math.max(0, Math.min(100, weather.properties.humidity));
            weather.properties.cloudCover += (Math.random() - 0.5) * 2;
            weather.properties.cloudCover = Math.max(0, Math.min(100, weather.properties.cloudCover));

            // Update dew point
            weather.properties.dewPoint = weather.properties.temperature -
                ((100 - weather.properties.humidity) / 5);

            // Determine if safe
            weather.properties.safe = weather.properties.cloudCover < 50 &&
                                      weather.properties.humidity < 85 &&
                                      weather.properties.windSpeed < 25;

            this.emit('weather', 'update', weather.properties);
        }, 5000);
    }

    // Get all device states
    getState() {
        const state = {};
        for (const [key, device] of Object.entries(this.devices)) {
            state[key] = {
                name: device.name,
                connected: device.connected,
                ...device.properties
            };
        }
        return state;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = INDISimulator;
