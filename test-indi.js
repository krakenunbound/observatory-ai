// Test script for real INDI connection
const INDIClient = require('./src/indi-client');

async function main() {
    const client = new INDIClient('localhost', 7624);

    // Listen for events
    client.on('newDevice', (device) => {
        console.log(`[NEW DEVICE] ${device}`);
    });

    client.on('propertyUpdate', (device, property, data) => {
        if (property === 'CONNECTION' || property === 'EQUATORIAL_EOD_COORD' ||
            property === 'CCD_EXPOSURE' || property === 'ABS_FOCUS_POSITION') {
            console.log(`[UPDATE] ${device}.${property}:`, JSON.stringify(data.values, null, 2));
        }
    });

    try {
        // Connect to INDI server
        console.log('Connecting to INDI server...');
        await client.connect();

        // Wait for initial property definitions
        await new Promise(r => setTimeout(r, 2000));

        // List discovered devices
        console.log('\n=== Discovered Devices ===');
        const devices = client.getDevices();
        for (const [name, device] of Object.entries(devices)) {
            const props = Object.keys(device.properties).length;
            console.log(`  ${name}: ${props} properties`);
        }

        // Connect the telescope simulator
        console.log('\n=== Connecting Telescope Simulator ===');
        client.connectDevice('Telescope Simulator');
        await new Promise(r => setTimeout(r, 1000));

        // Connect the CCD simulator
        console.log('\n=== Connecting CCD Simulator ===');
        client.connectDevice('CCD Simulator');
        await new Promise(r => setTimeout(r, 1000));

        // Connect the focuser
        console.log('\n=== Connecting Focuser Simulator ===');
        client.connectDevice('Focuser Simulator');
        await new Promise(r => setTimeout(r, 1000));

        // Slew to a target (M31 coordinates: RA 00h 42m 44s, Dec +41 16')
        console.log('\n=== Slewing to M31 ===');
        const m31_ra = 0.7123;   // hours
        const m31_dec = 41.269;  // degrees
        client.slewTo(m31_ra, m31_dec);

        // Wait and check position
        await new Promise(r => setTimeout(r, 3000));

        const telescope = client.getDevice('Telescope Simulator');
        if (telescope?.properties['EQUATORIAL_EOD_COORD']) {
            const coords = telescope.properties['EQUATORIAL_EOD_COORD'].values;
            console.log(`Current position: RA=${coords.RA?.value?.toFixed(4)}h, Dec=${coords.DEC?.value?.toFixed(4)}°`);
        }

        // Take a short test exposure
        console.log('\n=== Taking 1 second test exposure ===');
        client.expose(1);

        // Move focuser
        console.log('\n=== Moving focuser to position 25000 ===');
        client.focusTo(25000);

        await new Promise(r => setTimeout(r, 3000));

        // Final device status
        console.log('\n=== Final Device Status ===');
        for (const [name, device] of Object.entries(client.getDevices())) {
            const conn = device.properties['CONNECTION']?.values;
            const connected = conn?.CONNECT?.value ? 'CONNECTED' : 'DISCONNECTED';
            console.log(`  ${name}: ${connected}`);
        }

        // Disconnect
        console.log('\nTest complete. Disconnecting...');
        client.disconnect();

    } catch (err) {
        console.error('Error:', err.message);
    }
}

main();
