# Observatory AI Control System

A comprehensive web-based telescope control and automation system for astronomical observatories. Built with Node.js and integrating with INDI (Instrument Neutral Distributed Interface) for real hardware control.

## Features

- **Real INDI Integration**: Connects to INDI server for telescope, camera, focuser, and weather control
- **ASTAP Plate Solving**: Built-in plate solving with Gaia DR3 database support
- **Session Planning**: Automatic calculation of optimal imaging windows for DSO targets
- **Mount Modeling**: 10Micron GM2000 alignment model visualization and management
- **Focuser Profiling**: Automated backlash measurement and temperature compensation
- **Weather Safety**: Integrated weather monitoring with automatic safety responses
- **Full Workflow Automation**: Safety → Roof → Cool → Unpark → Slew → Solve → Focus → Guide → Capture

## Screenshots

The web interface provides:
- Real-time equipment status dashboard
- Target selection with 14+ DSO objects
- Mount modeling sky map with alignment points
- Session logs and image gallery
- Manual override controls

## Installation

### Prerequisites

- Node.js 18+
- INDI server with appropriate drivers
- ASTAP plate solver (optional but recommended)

### Quick Start

```bash
# Clone the repository
git clone https://github.com/yourusername/observatory-ai.git
cd observatory-ai

# Install dependencies
npm install

# Start the server
node server.js
```

The server will start on port 8092: http://localhost:8092

### ASTAP Setup (Optional)

For plate solving support:

1. Download ASTAP from [hnsky.org](https://www.hnsky.org/astap.htm)
2. Download the D80 star database (~1.2GB)
3. Extract database to `~/.local/share/astap/`

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Web Interface (port 8092)                     │
├─────────────────────────────────────────────────────────────────┤
│                         server.js                                │
├──────────────┬──────────────────┬───────────────────────────────┤
│ indi-wrapper │   astap-solver   │      mount-modeling           │
├──────────────┼──────────────────┼───────────────────────────────┤
│ indi-client  │   astap_cli      │   LX200 protocol              │
│ (XML/TCP)    │   (D80 database) │   (10Micron specific)         │
├──────────────┴──────────────────┴───────────────────────────────┤
│                   INDI Server (port 7624)                        │
│          Telescope | Camera | Focuser | Weather                  │
└─────────────────────────────────────────────────────────────────┘
```

## Supported Hardware

| Device Type | Tested Models | INDI Driver |
|-------------|---------------|-------------|
| Mount | 10Micron GM2000 | indi_lx200_10micron |
| Camera | QHY 600C | indi_qhy_ccd |
| Focuser | Pegasus FocusCube 2 | indi_pegasus_focuscube |
| Weather | Pegasus Uranus | indi_pegasus_uranus |

## API Reference

### Session Control

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/status` | GET | Full system status |
| `GET /api/targets` | GET | Available DSO targets |
| `POST /api/plan` | POST | Create imaging session |
| `POST /api/execute/:step` | POST | Execute workflow step |

### Mount Control

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/mount/status` | GET | Mount position and state |
| `POST /api/mount/slew` | POST | Slew to coordinates |
| `POST /api/mount/park` | POST | Park mount |
| `GET /api/mount/model` | GET | Alignment model info |

### Camera Control

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/camera/status` | GET | Camera state |
| `POST /api/camera/expose` | POST | Take exposure |

### Plate Solving

| Endpoint | Method | Description |
|----------|--------|-------------|
| `POST /api/solve` | POST | Solve an image |

## Configuration

Configuration is done via environment variables or editing `server.js`:

```javascript
// Observatory location
const OBSERVATORY = {
    latitude: 34.0522,
    longitude: -118.2437,
    elevation: 100
};

// INDI server
const INDI_HOST = 'localhost';
const INDI_PORT = 7624;
```

## Documentation

- [User Manual](docs/USER-MANUAL.md) - Complete usage guide
- [Architecture](docs/architecture.md) - System design
- [Hardware Inventory](docs/hardware-inventory.md) - Supported equipment
- [10Micron Modeling](docs/10MICRON-MODELING.md) - Mount modeling reference

## Project Structure

```
observatory-ai/
├── server.js              # Main Express server
├── src/
│   ├── indi-client.js     # INDI XML protocol client
│   ├── indi-wrapper.js    # Auto-detect real/simulation
│   ├── astap-solver.js    # ASTAP CLI wrapper
│   ├── mount-modeling.js  # 10Micron LX200 commands
│   ├── plate-solve.js     # Plate solving utilities
│   └── targets.js         # DSO target database
├── docs/
│   ├── USER-MANUAL.md     # User documentation
│   ├── architecture.md    # System architecture
│   └── 10MICRON-MODELING.md
└── package.json
```

## Recent Updates

### v1.1.0 (January 2026)
- Added Mount Modeling sky map visualization
- Fibonacci spiral algorithm for optimal point distribution
- Fast focuser profiling (~10 min vs 60+ min)

### v1.0.0
- Initial release with INDI integration
- ASTAP plate solving
- Session automation workflow

## Credits

- [INDI Library](https://indilib.org/) - Instrument Neutral Distributed Interface
- [ASTAP](https://www.hnsky.org/astap.htm) - Astrometric STAcking Program by Han Kleijn
- [Gaia DR3](https://www.cosmos.esa.int/web/gaia) - ESA star catalog

## License

MIT License - See [LICENSE](LICENSE) file for details.

---

*Built for the GMARS (Gold Mountain Astronomical Research Station) observatory*
