// Real INDI Client - Connects to actual INDI server
// Uses the INDI XML protocol over TCP

const net = require('net');
const { XMLParser } = require('fast-xml-parser');

class INDIClient {
    constructor(host = 'localhost', port = 7624) {
        this.host = host;
        this.port = port;
        this.socket = null;
        this.devices = {};
        this.connected = false;
        this.listeners = new Map();
        this.buffer = '';

        // XML parser for INDI messages
        this.parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '@_',
            textNodeName: '#text',
            trimValues: true
        });
    }

    // Connect to INDI server
    connect() {
        return new Promise((resolve, reject) => {
            this.socket = net.createConnection(this.port, this.host, () => {
                console.log(`[INDI] Connected to ${this.host}:${this.port}`);
                this.connected = true;

                // Request all device properties
                this.send('<getProperties version="1.7"/>');

                resolve();
            });

            this.socket.on('data', (data) => this.handleData(data));

            this.socket.on('error', (err) => {
                console.error('[INDI] Connection error:', err.message);
                this.connected = false;
                reject(err);
            });

            this.socket.on('close', () => {
                console.log('[INDI] Connection closed');
                this.connected = false;
            });
        });
    }

    // Handle incoming data from INDI server
    handleData(data) {
        this.buffer += data.toString();

        // INDI sends XML elements one by one, try to parse complete elements
        // Look for complete XML elements
        const patterns = [
            /<def\w+Vector[^>]*>[\s\S]*?<\/def\w+Vector>/g,
            /<set\w+Vector[^>]*>[\s\S]*?<\/set\w+Vector>/g,
            /<new\w+Vector[^>]*>[\s\S]*?<\/new\w+Vector>/g,
            /<delProperty[^>]*\/>/g,
            /<message[^>]*\/>/g,
            /<message[^>]*>[\s\S]*?<\/message>/g
        ];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(this.buffer)) !== null) {
                try {
                    this.parseINDIMessage(match[0]);
                } catch (e) {
                    // Incomplete or malformed XML, continue
                }
                this.buffer = this.buffer.replace(match[0], '');
            }
        }

        // Prevent buffer overflow
        if (this.buffer.length > 100000) {
            this.buffer = this.buffer.slice(-50000);
        }
    }

    // Parse and process INDI XML message
    parseINDIMessage(xml) {
        try {
            const parsed = this.parser.parse(xml);
            const rootKey = Object.keys(parsed)[0];
            const element = parsed[rootKey];

            if (!element) return;

            const device = element['@_device'];
            const name = element['@_name'];
            const state = element['@_state'];

            if (!device) return;

            // Initialize device if new
            if (!this.devices[device]) {
                this.devices[device] = { properties: {} };
                this.emit('newDevice', device);
            }

            // Handle different vector types
            if (rootKey.startsWith('def') || rootKey.startsWith('set')) {
                const propType = rootKey.replace(/^(def|set)/, '').replace('Vector', '').toLowerCase();

                this.devices[device].properties[name] = {
                    type: propType,
                    state: state,
                    perm: element['@_perm'],
                    label: element['@_label'],
                    group: element['@_group'],
                    values: this.extractValues(element, propType)
                };

                this.emit('propertyUpdate', device, name, this.devices[device].properties[name]);
            }
        } catch (e) {
            // Silently ignore parse errors for partial data
        }
    }

    // Extract values from INDI property element
    extractValues(element, type) {
        const values = {};
        const childKey = type === 'switch' ? 'defSwitch' :
                        type === 'number' ? 'defNumber' :
                        type === 'text' ? 'defText' :
                        type === 'light' ? 'defLight' :
                        type === 'blob' ? 'defBLOB' :
                        `one${type.charAt(0).toUpperCase() + type.slice(1)}`;

        // Handle both def* and one* element names
        const possibleKeys = [childKey, childKey.replace('def', 'one'), childKey.replace('def', 'set').replace('one', 'set')];

        for (const key of possibleKeys) {
            let children = element[key];
            if (!children) continue;

            if (!Array.isArray(children)) children = [children];

            for (const child of children) {
                const childName = child['@_name'];
                const value = child['#text'];

                if (type === 'number') {
                    values[childName] = {
                        value: parseFloat(value) || 0,
                        min: parseFloat(child['@_min']),
                        max: parseFloat(child['@_max']),
                        step: parseFloat(child['@_step']),
                        format: child['@_format'],
                        label: child['@_label']
                    };
                } else if (type === 'switch') {
                    values[childName] = {
                        value: value?.trim() === 'On',
                        label: child['@_label']
                    };
                } else {
                    values[childName] = {
                        value: value,
                        label: child['@_label']
                    };
                }
            }
        }
        return values;
    }

    // Send XML to INDI server
    send(xml) {
        if (this.socket && this.connected) {
            this.socket.write(xml);
        }
    }

    // Connect a device
    connectDevice(deviceName) {
        const xml = `<newSwitchVector device="${deviceName}" name="CONNECTION">
            <oneSwitch name="CONNECT">On</oneSwitch>
        </newSwitchVector>`;
        this.send(xml);
    }

    // Disconnect a device
    disconnectDevice(deviceName) {
        const xml = `<newSwitchVector device="${deviceName}" name="CONNECTION">
            <oneSwitch name="DISCONNECT">On</oneSwitch>
        </newSwitchVector>`;
        this.send(xml);
    }

    // Set a number property
    setNumber(device, property, values) {
        let oneNumbers = '';
        for (const [name, value] of Object.entries(values)) {
            oneNumbers += `<oneNumber name="${name}">${value}</oneNumber>`;
        }
        const xml = `<newNumberVector device="${device}" name="${property}">${oneNumbers}</newNumberVector>`;
        this.send(xml);
    }

    // Set a switch property
    setSwitch(device, property, switchName, value = true) {
        const xml = `<newSwitchVector device="${device}" name="${property}">
            <oneSwitch name="${switchName}">${value ? 'On' : 'Off'}</oneSwitch>
        </newSwitchVector>`;
        this.send(xml);
    }

    // Set a text property
    setText(device, property, values) {
        let oneTexts = '';
        for (const [name, value] of Object.entries(values)) {
            oneTexts += `<oneText name="${name}">${value}</oneText>`;
        }
        const xml = `<newTextVector device="${device}" name="${property}">${oneTexts}</newTextVector>`;
        this.send(xml);
    }

    // Event emitter functionality
    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event).push(callback);
    }

    emit(event, ...args) {
        const callbacks = this.listeners.get(event);
        if (callbacks) {
            callbacks.forEach(cb => cb(...args));
        }
    }

    // Get all devices
    getDevices() {
        return this.devices;
    }

    // Get device state
    getDevice(name) {
        return this.devices[name];
    }

    // Close connection
    disconnect() {
        if (this.socket) {
            this.socket.end();
            this.socket = null;
        }
        this.connected = false;
    }

    // ===== High-level telescope commands =====

    // Slew to coordinates (RA in hours, Dec in degrees)
    slewTo(ra, dec) {
        this.setNumber('10micron', 'EQUATORIAL_EOD_COORD', {
            'RA': ra,
            'DEC': dec
        });
    }

    // Park the telescope
    park() {
        this.setSwitch('10micron', 'TELESCOPE_PARK', 'PARK', true);
    }

    // Unpark the telescope
    unpark() {
        this.setSwitch('10micron', 'TELESCOPE_PARK', 'UNPARK', true);
    }

    // Start tracking
    track() {
        this.setSwitch('10micron', 'TELESCOPE_TRACK_STATE', 'TRACK_ON', true);
    }

    // Stop tracking
    stopTracking() {
        this.setSwitch('10micron', 'TELESCOPE_TRACK_STATE', 'TRACK_OFF', true);
    }

    // ===== High-level CCD commands =====

    // Configure upload settings (call before exposing)
    setupCCDUpload(directory, prefix = 'IMAGE_XXX') {
        // Set upload mode to LOCAL (save to disk)
        this.setSwitch('QHY CCD QHY600C-b4444f4', 'UPLOAD_MODE', 'UPLOAD_LOCAL', true);

        // Set upload directory and prefix
        this.setText('QHY CCD QHY600C-b4444f4', 'UPLOAD_SETTINGS', {
            'UPLOAD_DIR': directory,
            'UPLOAD_PREFIX': prefix
        });

        console.log(`[INDI] CCD upload configured: ${directory}/${prefix}`);
    }

    // Disable overscan (QHY specific)
    disableOverscan() {
        // Try to disable overscan if the property exists
        try {
            this.setSwitch('QHY CCD QHY600C-b4444f4', 'CCD_OVERSCAN', 'OVERSCAN_OFF', true);
            console.log('[INDI] Overscan disabled');
        } catch (e) {
            // Property might not exist on all cameras
            console.log('[INDI] Overscan property not found (may be OK)');
        }
    }

    // Take an exposure
    expose(seconds) {
        this.setNumber('QHY CCD QHY600C-b4444f4', 'CCD_EXPOSURE', {
            'CCD_EXPOSURE_VALUE': seconds
        });
    }

    // Set CCD temperature
    setCCDTemperature(temp) {
        this.setNumber('QHY CCD QHY600C-b4444f4', 'CCD_TEMPERATURE', {
            'CCD_TEMPERATURE_VALUE': temp
        });
    }

    // Set CCD binning
    setBinning(x, y) {
        this.setNumber('QHY CCD QHY600C-b4444f4', 'CCD_BINNING', {
            'HOR_BIN': x,
            'VER_BIN': y
        });
    }

    // ===== High-level focuser commands =====

    // Move focuser to absolute position
    focusTo(position) {
        this.setNumber('Pegasus FocusCube', 'ABS_FOCUS_POSITION', {
            'FOCUS_ABSOLUTE_POSITION': position
        });
    }

    // Move focuser relative
    focusRelative(steps) {
        this.setNumber('Pegasus FocusCube', 'REL_FOCUS_POSITION', {
            'FOCUS_RELATIVE_POSITION': Math.abs(steps)
        });
        // Set direction
        const dir = steps > 0 ? 'FOCUS_INWARD' : 'FOCUS_OUTWARD';
        this.setSwitch('Pegasus FocusCube', 'FOCUS_MOTION', dir, true);
    }
}

module.exports = INDIClient;
