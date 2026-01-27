// 10Micron Mount Modeling Module
// Provides direct LX200 command interface for alignment model management

const net = require('net');

class MountModeling {
    constructor(options = {}) {
        this.host = options.host || '192.168.1.103';
        this.port = options.port || 3490;
        this.timeout = options.timeout || 5000;
    }

    // Send a raw LX200 command and get response
    async sendCommand(command) {
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            let response = '';
            let timeoutHandle;

            socket.setTimeout(this.timeout);

            socket.on('connect', () => {
                // LX200 commands start with : and end with #
                const fullCmd = command.startsWith(':') ? command : `:${command}`;
                const cmdWithTerm = fullCmd.endsWith('#') ? fullCmd : `${fullCmd}#`;
                socket.write(cmdWithTerm);
            });

            socket.on('data', (data) => {
                response += data.toString();
                // Most LX200 responses end with #
                if (response.includes('#')) {
                    clearTimeout(timeoutHandle);
                    socket.destroy();
                    resolve(response.replace(/#$/, ''));
                }
            });

            socket.on('timeout', () => {
                socket.destroy();
                reject(new Error('Command timeout'));
            });

            socket.on('error', (err) => {
                clearTimeout(timeoutHandle);
                reject(err);
            });

            socket.on('close', () => {
                // If we got data but no # terminator, return what we have
                if (response && !response.includes('#')) {
                    resolve(response);
                }
            });

            // Backup timeout
            timeoutHandle = setTimeout(() => {
                socket.destroy();
                if (response) {
                    resolve(response);
                } else {
                    reject(new Error('Command timeout'));
                }
            }, this.timeout);

            socket.connect(this.port, this.host);
        });
    }

    // Get number of alignment stars in current model
    async getAlignmentStarCount() {
        try {
            const response = await this.sendCommand(':getalst#');
            return parseInt(response, 10) || 0;
        } catch (err) {
            console.error('[MountModeling] Error getting star count:', err.message);
            return 0;
        }
    }

    // Get details of a specific alignment point (1-based index)
    async getAlignmentPoint(index) {
        try {
            const response = await this.sendCommand(`:getalp${index}#`);
            // Response format varies by firmware, parse as needed
            // Typical: RA,Dec,Error or more complex format
            return this.parseAlignmentPoint(response, index);
        } catch (err) {
            console.error(`[MountModeling] Error getting point ${index}:`, err.message);
            return null;
        }
    }

    // Parse alignment point response
    parseAlignmentPoint(response, index) {
        // Format depends on firmware version
        // Try common formats
        const parts = response.split(',');
        if (parts.length >= 2) {
            return {
                index,
                mountRA: parseFloat(parts[0]) || 0,
                mountDec: parseFloat(parts[1]) || 0,
                solvedRA: parts.length > 2 ? parseFloat(parts[2]) : null,
                solvedDec: parts.length > 3 ? parseFloat(parts[3]) : null,
                error: parts.length > 4 ? parseFloat(parts[4]) : null,
                raw: response
            };
        }
        return { index, raw: response };
    }

    // Get all alignment points
    async getAllAlignmentPoints() {
        const count = await this.getAlignmentStarCount();
        const points = [];

        for (let i = 1; i <= count; i++) {
            const point = await this.getAlignmentPoint(i);
            if (point) {
                points.push(point);
            }
        }

        return {
            count,
            points
        };
    }

    // Get number of saved models
    async getModelCount() {
        try {
            const response = await this.sendCommand(':modelcnt#');
            return parseInt(response, 10) || 0;
        } catch (err) {
            console.error('[MountModeling] Error getting model count:', err.message);
            return 0;
        }
    }

    // Delete current alignment model
    async deleteAlignment() {
        try {
            const response = await this.sendCommand(':delalig#');
            return response === '1' || response.includes('1');
        } catch (err) {
            console.error('[MountModeling] Error deleting alignment:', err.message);
            return false;
        }
    }

    // Start new alignment
    async startNewAlignment() {
        try {
            const response = await this.sendCommand(':newalig#');
            return response === '1' || response.includes('V');
        } catch (err) {
            console.error('[MountModeling] Error starting alignment:', err.message);
            return false;
        }
    }

    // Add alignment point
    // MRA, MDEC: Mount reported position
    // PRA, PDEC: Plate-solved actual position
    // MSIDE: Pier side ('E' or 'W')
    // SIDTIME: Local sidereal time
    async addAlignmentPoint(mRA, mDec, mSide, pRA, pDec, sidTime) {
        try {
            const cmd = `:newalpt${mRA},${mDec},${mSide},${pRA},${pDec},${sidTime}#`;
            const response = await this.sendCommand(cmd);
            return response.includes('E') || response === '1'; // 'E' for "entered"
        } catch (err) {
            console.error('[MountModeling] Error adding point:', err.message);
            return false;
        }
    }

    // Finalize alignment
    async endAlignment() {
        try {
            const response = await this.sendCommand(':endalig#');
            return response.includes('V') || response === '1';
        } catch (err) {
            console.error('[MountModeling] Error ending alignment:', err.message);
            return false;
        }
    }

    // Set sync mode (0 = offset only, 1 = refine model)
    async setSyncMode(mode) {
        try {
            const response = await this.sendCommand(`:CMCFG${mode}#`);
            return true;
        } catch (err) {
            console.error('[MountModeling] Error setting sync mode:', err.message);
            return false;
        }
    }

    // Get refraction temperature
    async getRefractionTemp() {
        try {
            const response = await this.sendCommand(':GRTMP#');
            return parseFloat(response) || null;
        } catch (err) {
            return null;
        }
    }

    // Set refraction temperature (Celsius)
    async setRefractionTemp(temp) {
        try {
            const sign = temp >= 0 ? '+' : '';
            const response = await this.sendCommand(`:SRTMP${sign}${temp.toFixed(1)}#`);
            return response === '1';
        } catch (err) {
            return false;
        }
    }

    // Get refraction pressure
    async getRefractionPressure() {
        try {
            const response = await this.sendCommand(':GRPRS#');
            return parseFloat(response) || null;
        } catch (err) {
            return null;
        }
    }

    // Set refraction pressure (hPa)
    async setRefractionPressure(pressure) {
        try {
            const response = await this.sendCommand(`:SRPRS${pressure.toFixed(1)}#`);
            return response === '1';
        } catch (err) {
            return false;
        }
    }

    // Get local sidereal time
    async getSiderealTime() {
        try {
            const response = await this.sendCommand(':GS#');
            return response; // Returns HH:MM:SS
        } catch (err) {
            return null;
        }
    }

    // Get mount info (consolidated status)
    async getMountInfo() {
        try {
            const response = await this.sendCommand(':Ginfo#');
            // Response: RA,DEC,SIDE,AZ,ALT,JD,STATUS,SLEWSTATUS
            const parts = response.split(',');
            if (parts.length >= 8) {
                return {
                    ra: parseFloat(parts[0]),
                    dec: parseFloat(parts[1]),
                    pierSide: parts[2],
                    az: parseFloat(parts[3]),
                    alt: parseFloat(parts[4]),
                    julianDate: parseFloat(parts[5]),
                    status: parts[6],
                    slewStatus: parts[7]
                };
            }
            return { raw: response };
        } catch (err) {
            return null;
        }
    }

    // Test connection to mount
    async testConnection() {
        try {
            const response = await this.sendCommand(':GVP#');
            return {
                connected: true,
                product: response
            };
        } catch (err) {
            return {
                connected: false,
                error: err.message
            };
        }
    }
}

module.exports = MountModeling;
