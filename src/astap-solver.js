// ASTAP Plate Solver Integration
// Uses the locally compiled ASTAP CLI for astrometric solving

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ASTAP_CLI = '/home/kraken/bin/astap_cli';
const DATABASE_PATH = '/home/kraken/.local/share/astap';

class ASTAPSolver {
    constructor() {
        this.astapPath = ASTAP_CLI;
        this.databasePath = DATABASE_PATH;
    }

    // Check if ASTAP is available
    isAvailable() {
        return fs.existsSync(this.astapPath);
    }

    // Check if star database is installed
    hasDatabase() {
        // Check for any .290 files (ASTAP database format)
        try {
            const files = fs.readdirSync(this.databasePath);
            return files.some(f => f.endsWith('.290') || f.endsWith('.1476'));
        } catch {
            return false;
        }
    }

    // Solve an image
    async solve(imagePath, options = {}) {
        return new Promise((resolve, reject) => {
            if (!this.isAvailable()) {
                reject(new Error('ASTAP CLI not found at ' + this.astapPath));
                return;
            }

            if (!fs.existsSync(imagePath)) {
                reject(new Error('Image file not found: ' + imagePath));
                return;
            }

            const args = [
                '-f', imagePath,
                '-d', this.databasePath
            ];

            // Field of view (degrees)
            if (options.fov) {
                args.push('-fov', options.fov.toString());
            } else {
                args.push('-fov', '0'); // Auto-detect
            }

            // Search radius (degrees)
            if (options.radius) {
                args.push('-r', options.radius.toString());
            }

            // Hint coordinates (RA in hours, Dec as SPD)
            if (options.ra !== undefined) {
                args.push('-ra', options.ra.toString());
            }
            if (options.dec !== undefined) {
                // ASTAP uses South Pole Distance = 90 + Dec
                const spd = 90 + options.dec;
                args.push('-spd', spd.toString());
            }

            // Additional options
            if (options.downsample) {
                args.push('-z', options.downsample.toString());
            }

            if (options.update) {
                args.push('-update'); // Update FITS header
            }

            if (options.wcs) {
                args.push('-wcs'); // Write WCS file
            }

            console.log('[ASTAP] Running:', this.astapPath, args.join(' '));

            const process = spawn(this.astapPath, args);

            let stdout = '';
            let stderr = '';

            process.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            process.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            process.on('close', (code) => {
                if (code === 0) {
                    // Parse the results from the .ini file
                    const baseName = imagePath.replace(/\.[^.]+$/, '');
                    const iniFile = baseName + '.ini';

                    try {
                        const result = this.parseIniFile(iniFile);
                        result.success = true;
                        result.stdout = stdout;
                        resolve(result);
                    } catch (err) {
                        resolve({
                            success: true,
                            message: 'Solved but could not parse results',
                            stdout,
                            stderr
                        });
                    }
                } else {
                    reject(new Error(`ASTAP failed with code ${code}: ${stderr || stdout}`));
                }
            });

            process.on('error', (err) => {
                reject(new Error('Failed to start ASTAP: ' + err.message));
            });

            // Timeout after 2 minutes
            setTimeout(() => {
                process.kill();
                reject(new Error('ASTAP timeout'));
            }, 120000);
        });
    }

    // Parse ASTAP .ini result file
    parseIniFile(iniPath) {
        const content = fs.readFileSync(iniPath, 'utf8');
        const lines = content.split('\n');
        const result = {};

        for (const line of lines) {
            const [key, value] = line.split('=').map(s => s.trim());
            if (key && value) {
                // Parse numeric values
                const num = parseFloat(value);
                result[key.toLowerCase()] = isNaN(num) ? value : num;
            }
        }

        return {
            ra: result.crval1,          // RA in degrees
            dec: result.crval2,         // Dec in degrees
            raHours: result.crval1 / 15, // RA in hours
            pixelScale: result.cdelt2 ? Math.abs(result.cdelt2) * 3600 : null, // arcsec/pixel
            rotation: result.crota2,     // Rotation angle
            width: result.naxis1,
            height: result.naxis2,
            solved: result.pltsolvd === 'T' || result.pltsolvd === 1,
            raw: result
        };
    }

    // Get solver status
    getStatus() {
        return {
            available: this.isAvailable(),
            hasDatabase: this.hasDatabase(),
            astapPath: this.astapPath,
            databasePath: this.databasePath
        };
    }
}

module.exports = ASTAPSolver;

// Test if run directly
if (require.main === module) {
    const solver = new ASTAPSolver();
    console.log('ASTAP Status:', solver.getStatus());

    if (process.argv[2]) {
        solver.solve(process.argv[2], { fov: 5, wcs: true })
            .then(result => console.log('Result:', result))
            .catch(err => console.error('Error:', err.message));
    }
}
