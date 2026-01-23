// Plate solving using astrometry.net API
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const API_URL = 'nova.astrometry.net';

class PlateSolver {
    constructor(apiKey = '') {
        this.apiKey = apiKey;
        this.sessionKey = null;
    }

    // Make HTTPS request
    request(options, postData = null) {
        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: API_URL,
                ...options
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve(data);
                    }
                });
            });
            req.on('error', reject);
            if (postData) req.write(postData);
            req.end();
        });
    }

    // Login to get session key (anonymous login if no API key)
    async login() {
        const payload = JSON.stringify({
            apikey: this.apiKey || 'DEMO_KEY'
        });

        const result = await this.request({
            path: '/api/login',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength('request-json=' + encodeURIComponent(payload))
            }
        }, 'request-json=' + encodeURIComponent(payload));

        if (result.status === 'success') {
            this.sessionKey = result.session;
            console.log('Logged in, session:', this.sessionKey);
            return true;
        }
        console.error('Login failed:', result);
        return false;
    }

    // Submit URL for solving
    async submitUrl(imageUrl) {
        if (!this.sessionKey) await this.login();

        const payload = JSON.stringify({
            session: this.sessionKey,
            url: imageUrl,
            scale_units: 'degwidth',
            scale_lower: 0.1,
            scale_upper: 180,
            center_ra: 10.68,  // M31 approx
            center_dec: 41.27,
            radius: 30
        });

        const result = await this.request({
            path: '/api/url_upload',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength('request-json=' + encodeURIComponent(payload))
            }
        }, 'request-json=' + encodeURIComponent(payload));

        console.log('Submit result:', result);
        return result;
    }

    // Check submission status
    async checkStatus(subId) {
        const result = await this.request({
            path: `/api/submissions/${subId}`,
            method: 'GET'
        });
        return result;
    }

    // Get job results
    async getJobResults(jobId) {
        const result = await this.request({
            path: `/api/jobs/${jobId}/info`,
            method: 'GET'
        });
        return result;
    }

    // Get calibration data
    async getCalibration(jobId) {
        const result = await this.request({
            path: `/api/jobs/${jobId}/calibration`,
            method: 'GET'
        });
        return result;
    }
}

// Test with a known astronomical image URL
async function testSolve() {
    const solver = new PlateSolver();
    
    // Use a sample M31 image URL
    const imageUrl = 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/98/Andromeda_Galaxy_%28with_h-alpha%29.jpg/640px-Andromeda_Galaxy_%28with_h-alpha%29.jpg';
    
    console.log('Submitting image for plate solving...');
    console.log('URL:', imageUrl);
    
    const submission = await solver.submitUrl(imageUrl);
    
    if (submission.subid) {
        console.log('Submission ID:', submission.subid);
        console.log('Check status at: https://nova.astrometry.net/status/' + submission.subid);
        
        // Poll for status
        console.log('\nPolling for completion...');
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 10000)); // Wait 10 seconds
            
            const status = await solver.checkStatus(submission.subid);
            console.log(`Status [${i+1}/30]:`, status.processing_started ? 'Processing...' : 'Queued', 
                       'Jobs:', status.jobs || 'none');
            
            if (status.jobs && status.jobs.length > 0 && status.jobs[0] !== null) {
                const jobId = status.jobs[0];
                console.log('\nJob started:', jobId);
                
                // Wait for job completion
                await new Promise(r => setTimeout(r, 5000));
                
                const calibration = await solver.getCalibration(jobId);
                if (calibration.ra !== undefined) {
                    console.log('\n=== PLATE SOLVE SUCCESS ===');
                    console.log('RA:', calibration.ra.toFixed(4), 'degrees');
                    console.log('Dec:', calibration.dec.toFixed(4), 'degrees');
                    console.log('Orientation:', calibration.orientation?.toFixed(2), 'degrees');
                    console.log('Pixel scale:', calibration.pixscale?.toFixed(3), 'arcsec/pixel');
                    console.log('Field width:', (calibration.radius * 2)?.toFixed(2), 'degrees');
                    return calibration;
                }
            }
        }
    }
    
    return null;
}

module.exports = { PlateSolver };

// Run test if called directly
if (require.main === module) {
    testSolve().catch(console.error);
}
