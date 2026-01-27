# Kraken Observatory Control System - User Manual

**Version:** 1.0.0
**Last Updated:** January 26, 2026
**Author:** Claude AI (with krakenunbound)

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Quick Start](#2-quick-start)
3. [Services Reference](#3-services-reference)
4. [Observatory AI Control](#4-observatory-ai-control)
5. [Mount Modeling](#5-mount-modeling)
6. [Focuser Profiling](#6-focuser-profiling)
7. [INDI Integration](#7-indi-integration)
8. [Plate Solving](#8-plate-solving)
9. [Web Terminals](#9-web-terminals)
10. [Remote Access](#10-remote-access)
11. [Troubleshooting](#11-troubleshooting)
12. [API Reference](#12-api-reference)

---

## 1. System Overview

The Kraken Observatory Control System is a comprehensive suite of web-based tools for controlling and monitoring a remote astronomical observatory. It runs on NixOS and provides:

- **Real-time equipment control** via INDI protocol
- **AI-assisted imaging sessions** with automatic planning
- **Mount modeling tools** for 10Micron GM2000
- **Focuser profiling** with temperature compensation
- **Plate solving** using ASTAP with Gaia DR3 database
- **Weather monitoring** and safety interlocks
- **Remote web access** via Cloudflare tunnel

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    WEB BROWSER (Any Device)                      │
│  Observatory Portal (8081) | Observatory AI (8092) | Terminals   │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────────┐
│                    KRAKEN NIXOS SERVER                           │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │ Observatory  │  │  Observatory │  │    Astro     │           │
│  │   Portal     │  │      AI      │  │  Dashboard   │           │
│  │   (8081)     │  │    (8092)    │  │   (8091)     │           │
│  └──────────────┘  └──────────────┘  └──────────────┘           │
│                              │                                   │
│  ┌───────────────────────────▼───────────────────────────────┐  │
│  │                     INDI Server (7624)                     │  │
│  │   Mount | Camera | Focuser | Filter Wheel | Weather        │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        ┌─────────┐    ┌─────────────┐   ┌─────────┐
        │10Micron │    │  QHY 600C   │   │ Weather │
        │GM2000   │    │  Camera     │   │ Station │
        └─────────┘    └─────────────┘   └─────────┘
```

---

## 2. Quick Start

### Accessing the System

1. **Local Network**: Navigate to `http://192.168.2.65:8081` (or use `kraken-nix.local:8081`)
2. **Remote Access**: Use the Cloudflare tunnel URL (requires authentication)

### Main Dashboard

The Observatory Portal (port 8081) provides:
- Quick links to all services
- Equipment status overview
- Weather conditions
- Security camera feed

### Starting an Imaging Session

1. Open **Observatory AI** (port 8092)
2. Check equipment status (all devices should show green)
3. Select a target from the dropdown or enter coordinates
4. Click "Plan Session" to calculate optimal imaging parameters
5. Execute the workflow steps in order: Safety → Roof → Cool → Unpark → Slew → Solve → Focus → Capture

---

## 3. Services Reference

### Active Services

| Port | Service | Description | URL |
|------|---------|-------------|-----|
| 3000 | Gitea | Git server for backups | http://localhost:3000 |
| 7624 | INDI Server | Telescope control protocol | TCP only |
| 7680 | Claude Dashboard | AI assistant web interface | http://localhost:7680 |
| 7681 | Claude Terminal | tmux session (web terminal) | http://localhost:7681 |
| 7682 | NixOS Shell | Direct zsh terminal access | http://localhost:7682 |
| 8080 | Python Dashboard | Simple dashboard | http://localhost:8080 |
| 8081 | Observatory Portal | Main dashboard | http://localhost:8081 |
| 8088 | GoServe | File server | http://localhost:8088 |
| 8091 | Astro Dashboard | NASA APOD, ISS, moon phase | http://localhost:8091 |
| 8092 | Observatory AI | AI telescope control | http://localhost:8092 |
| 8443 | VS Code Server | Browser-based IDE | http://localhost:8443 |

### Docker Containers

| Container | Ports | Purpose |
|-----------|-------|---------|
| gitea | 3000 (web), 2222 (ssh) | Git server |
| code-server | 8443 | VS Code in browser |

### Systemd Services

All critical services are managed by systemd with auto-restart:

```bash
# Check service status
sudo systemctl status observatory-ai

# Restart a service
sudo systemctl restart observatory-ai

# View logs
journalctl -u observatory-ai -f
```

---

## 4. Observatory AI Control

### Web Interface (Port 8092)

The main control interface provides:

- **Equipment Status Panel**: Real-time device states
- **Session Control**: Start/stop imaging sessions
- **Target Selection**: 14+ DSO targets with coordinates
- **Workflow Automation**: Step-by-step execution
- **Image Gallery**: Preview captured frames
- **Mount Control**: Slew, park, unpark
- **Mount Modeling**: Alignment point visualization

### Workflow Steps

1. **Safety Check**: Verify weather conditions
2. **Open Roof**: Send roof open command (requires confirmation)
3. **Cool Camera**: Start camera cooling to target temperature
4. **Unpark Mount**: Enable tracking
5. **Slew to Target**: GoTo target coordinates
6. **Plate Solve**: Verify pointing accuracy
7. **Autofocus**: Run focus routine
8. **Start Guiding**: Enable autoguiding
9. **Capture**: Begin exposure sequence
10. **Shutdown**: Park mount, close roof, warm camera

### Target Database

Built-in targets include:
- **Galaxies**: M31, M33, M51, M101
- **Nebulae**: M42, NGC 7000, IC 1396
- **Clusters**: M45 (Pleiades)
- **Planetary**: M57 (Ring Nebula)

---

## 5. Mount Modeling

### Overview

The 10Micron GM2000 mount supports alignment models with up to 100 points. The system provides tools to:

- View current model points on a sky map
- Generate optimal point distributions
- Manage refraction parameters
- Build automated models with plate solving

### Sky Map Visualization

Access via Observatory AI → Mount Modeling panel:

- **Polar projection** showing altitude/azimuth
- **Color-coded points**: Green (good), Orange (medium), Red (high error)
- **Tooltips** with RA, Dec, and error values
- **Generated points** shown in purple (suggestions)

### Generating Optimal Points

1. Set **Target Points** (6-100, recommended 30 for wide-field)
2. Set **Minimum Altitude** (default 20°)
3. Click **Generate Points**
4. Points are distributed using Fibonacci spiral for even coverage

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/mount/model` | GET | Model summary (star count, saved models) |
| `/api/mount/model/points` | GET | All alignment points |
| `/api/mount/model` | DELETE | Delete current model |
| `/api/mount/model/refraction` | POST | Set temperature/pressure |
| `/api/mount/model/sync-mode` | POST | Set sync behavior (offset/refine) |

### LX200 Commands Reference

| Command | Response | Description |
|---------|----------|-------------|
| `:getalst#` | N# | Number of alignment stars |
| `:getalpN#` | Complex | Get point N details |
| `:newalig#` | V# | Start new alignment |
| `:newalpt...#` | E# | Add alignment point |
| `:endalig#` | V# | Finalize alignment |
| `:delalig#` | 1# | Delete alignment |

---

## 6. Focuser Profiling

### Purpose

The focuser profiling system characterizes:
- **Backlash**: Dead zone when reversing direction
- **Step size**: Optimal autofocus increments
- **Temperature compensation**: Focus drift with temperature

### Running a Profile (Fast Mode ~10 min)

1. Open Observatory AI → Focuser section
2. Select or create a profile for your scope
3. Click **Run Profiling**
4. Wait for completion (~10 minutes)

### Profile Parameters

| Scope Type | Typical Backlash | Step Size | Settle Time |
|------------|------------------|-----------|-------------|
| Refractor | 40 steps | 100 | 1500ms |
| Newtonian | 50 steps | 100 | 1500ms |
| SCT | 150 steps | 150 | 2500ms |
| RC | 80 steps | 120 | 2000ms |

### Fast Profiling Algorithm

The improved algorithm (v2) uses:
- Single-pass coarse backlash detection (50-step increments)
- 1.5s exposures instead of full exposure time
- Early exit when HFR change detected
- 10% safety margin on measured values

---

## 7. INDI Integration

### Connecting to INDI Server

The system automatically connects to INDI on port 7624. Supported devices:

| Device | INDI Driver | Status |
|--------|-------------|--------|
| 10Micron Mount | indi_lx200_10micron | Auto-detect |
| QHY 600C | indi_qhy_ccd | Auto-detect |
| Pegasus FocusCube | indi_pegasus_focuscube | Auto-detect |
| Uranus Weather | indi_pegasus_uranus | Auto-detect |

### Manual INDI Commands

```bash
# List connected devices
indi_getprop

# Get mount position
indi_getprop "10micron.EQUATORIAL_EOD_COORD.*"

# Set switch (e.g., connect)
indi_setprop "QHY CCD.CONNECTION.CONNECT=On"

# Start exposure
indi_setprop "QHY CCD.CCD_EXPOSURE.CCD_EXPOSURE_VALUE=60"
```

### Simulation Mode

When INDI server is unavailable, the system falls back to simulation mode:
- All devices report "connected" with simulated values
- Commands are logged but not executed
- Useful for testing UI and workflows

---

## 8. Plate Solving

### ASTAP Configuration

- **Binary**: `/home/kraken/bin/astap_cli`
- **Database**: D80 (Gaia DR3, magnitude 18)
- **Location**: `~/.local/share/astap/`

### Usage

```bash
# Plate solve with position hint
/home/kraken/bin/astap_cli -f image.fits -fov 1.93 -r 10 -ra 5.58 -spd 95.39 -d ~/.local/share/astap/
```

### Performance

| Scenario | Solve Time |
|----------|------------|
| Unknown FOV | ~6 seconds |
| Known FOV | 0.6-0.8 seconds |
| Accuracy | < 1 arcminute |
| FOV range | 0.15° - 6° |

---

## 9. Web Terminals

### Claude Terminal (Port 7681)

- Connects to tmux session `claude-web`
- 50,000 lines scrollback
- Mouse scrolling enabled
- Used by Claude AI for system commands

### NixOS Shell (Port 7682)

- Direct zsh shell access
- Full NixOS environment
- Useful for system administration

### tmux Commands

```bash
# Attach to Claude session
tmux attach-session -t claude-web

# List sessions
tmux ls

# Scroll up (in copy mode)
Ctrl+b [    # Enter copy mode
q           # Exit copy mode
```

---

## 10. Remote Access

### Cloudflare Tunnel

When accessed remotely via krakenunbound.com:

| Path | Service |
|------|---------|
| `/` | Observatory Portal |
| `/ai/` | Observatory AI |
| `/claude/` | Claude Dashboard |
| `/terminal/` | Claude Terminal |
| `/shell/` | NixOS Shell |

### Caddy Reverse Proxy

Routes are configured in `/etc/nixos/configuration.nix`:

```nix
services.caddy = {
  enable = true;
  virtualHosts."krakenunbound.com" = {
    extraConfig = ''
      reverse_proxy /ai/* localhost:8092
      reverse_proxy /shell/* localhost:7682
      # ... etc
    '';
  };
};
```

---

## 11. Troubleshooting

### Service Won't Start

```bash
# Check status
sudo systemctl status observatory-ai

# Check logs
journalctl -u observatory-ai -n 50

# Restart
sudo systemctl restart observatory-ai
```

### INDI Connection Failed

```bash
# Check if INDI server is running
ss -tlnp | grep 7624

# Restart INDI server
sudo systemctl restart indi-server

# Test connection
indi_getprop -h localhost -p 7624
```

### Mount Not Responding

1. Check network connection to mount (192.168.1.103:3490)
2. Verify you're on GMARS network (192.168.1.x)
3. Try direct LX200 test: `nc 192.168.1.103 3490` then send `:GVP#`

### Plate Solve Fails

1. Check ASTAP database exists: `ls ~/.local/share/astap/`
2. Verify image has stars (exposure long enough)
3. Check FOV hint is correct
4. Try without position hint: `-r 180` (full sky search)

### Docker Container Issues

```bash
# List containers
docker ps -a

# Restart container
docker restart gitea

# View logs
docker logs gitea
```

---

## 12. API Reference

### Observatory AI API

#### Session Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/status` | GET | Full system status |
| `GET /api/targets` | GET | Available DSO targets |
| `POST /api/plan` | POST | Create imaging session |
| `POST /api/execute/:step` | POST | Execute workflow step |
| `GET /api/session/log` | GET | Session log entries |

#### Mount Control

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/mount/status` | GET | Mount position and state |
| `POST /api/mount/slew` | POST | Slew to target |
| `POST /api/mount/park` | POST | Park mount |
| `POST /api/mount/unpark` | POST | Unpark mount |
| `GET /api/mount/check-target` | GET | Check if target is safe |

#### Camera Control

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/camera/status` | GET | Camera state and temperature |
| `POST /api/camera/cool` | POST | Start cooling |
| `POST /api/camera/expose` | POST | Take exposure |

#### Focuser Control

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/focuser/status` | GET | Position and temperature |
| `POST /api/focuser/move` | POST | Move to position |
| `GET /api/focuser/profiles` | GET | List profiles |
| `POST /api/focuser/profile/run` | POST | Run profiling |

#### Plate Solving

| Endpoint | Method | Description |
|----------|--------|-------------|
| `POST /api/solve` | POST | Plate solve image |
| `GET /api/solve/status` | GET | Solve status |

---

## Appendix A: File Locations

| File/Directory | Purpose |
|----------------|---------|
| `/home/kraken/projects/observatory-ai/` | Main AI control system |
| `/home/kraken/projects/portal/` | Observatory portal |
| `/home/kraken/projects/astro-dashboard/` | Astronomy dashboard |
| `/home/kraken/.observatory/` | User data (profiles, logs) |
| `/home/kraken/.local/share/astap/` | ASTAP star database |
| `/etc/nixos/configuration.nix` | NixOS system config |

## Appendix B: Dependencies

### System Packages (NixOS)
- Node.js 22.x
- Python 3.13
- Go 1.24
- Docker
- Git
- tmux
- ttyd

### NPM Packages
- fast-xml-parser (INDI XML parsing)

### External Tools
- ASTAP (plate solving) - built from source
- D80 Gaia database (1.2GB)

---

*End of User Manual*
