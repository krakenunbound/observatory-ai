# Observatory AI Control System

A real telescope control and plate-solving system for automated astrophotography.

## Features

- **Real INDI Integration**: Connects to actual INDI server (port 7624) with XML protocol
- **ASTAP Plate Solving**: Built from source, uses D80 Gaia database (1.2GB)
- **Session Planning**: Calculate optimal imaging windows for deep sky objects
- **14 DSO Targets**: M1, M31, M33, M42, M45, M51, M57, M101, NGC 7000, IC 1396, etc.
- **Full Workflow Automation**: Safety → Roof → Cool → Unpark → Slew → Solve → Focus → Guide → Capture → Shutdown

## Installation

### Prerequisites (NixOS)
```bash
nix-env -iA nixos.indilib nixos.indi-full nixos.fpc nixos.lazarus
```

### ASTAP Plate Solver
Built from source (pre-built binaries don't work on NixOS):
```bash
git clone https://github.com/han-k59/astap
cd astap
lazbuild --lazarusdir=/nix/var/nix/profiles/default/share/lazarus -B astap_command_line_linux.lpi
cp astap_cli ~/bin/
```

### D80 Star Database
Download from [hnsky.org](https://www.hnsky.org/astap.htm) or via Google Drive.
Extract to `~/.local/share/astap/`

### Run
```bash
cd /home/kraken/projects/observatory-ai
node server.js
```
Access at http://192.168.2.65:8092

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Web Interface                         │
│                    (port 8092)                          │
├─────────────────────────────────────────────────────────┤
│                     server.js                            │
├──────────────┬──────────────────┬───────────────────────┤
│ indi-wrapper │   astap-solver   │   session-planner     │
├──────────────┼──────────────────┼───────────────────────┤
│ indi-client  │   astap_cli      │   target-database     │
│ (XML/TCP)    │   (D80 database) │   (14 DSOs)           │
├──────────────┴──────────────────┴───────────────────────┤
│              INDI Server (port 7624)                     │
│     Telescope | Camera | Focuser | FilterWheel          │
└─────────────────────────────────────────────────────────┘
```

## Plate Solving Performance

Tested on real astrophotography data (M33 Triangulum Galaxy):

| Metric | Value |
|--------|-------|
| Solve time (unknown FOV) | 6.4 seconds |
| Solve time (known FOV) | 0.6-0.8 seconds |
| Accuracy | < 1 arcminute |
| Database | D80 (Gaia DR3, mag 18) |
| FOV range | 0.15° - 6° |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Web interface |
| `GET /api/status` | System status |
| `GET /api/targets` | Available DSO targets |
| `GET /api/mode` | INDI mode (real/simulation) |
| `POST /api/plan` | Create imaging session |
| `POST /api/execute/:step` | Execute workflow step |
| `POST /api/solve` | Plate solve an image |

## Files

- `server.js` - Main Express server
- `src/indi-client.js` - Real INDI XML protocol client
- `src/indi-wrapper.js` - Auto-detects real/simulation mode
- `src/astap-solver.js` - ASTAP CLI wrapper
- `src/simulator.js` - Fallback hardware simulation

## Credits

- [INDI Library](https://indilib.org/) - Instrument Neutral Distributed Interface
- [ASTAP](https://www.hnsky.org/astap.htm) - Astrometric STAcking Program by Han Kleijn
- [Gaia DR3](https://www.cosmos.esa.int/web/gaia) - ESA star catalog

## License

MIT
