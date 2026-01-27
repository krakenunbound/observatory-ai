# 10Micron Mount - INDIGO Driver

INDIGO driver for 10Micron GM series mounts using the extended LX200 protocol.

## Supported Mounts

- GM1000HPS
- GM2000QCI / GM2000HPS
- GM3000HPS
- GM4000QCI / GM4000HPS
- AZ2000

## Features

### Standard Mount Functions
- Slew to coordinates (RA/Dec, Alt/Az)
- Sync to coordinates
- Park / Unpark
- Tracking control
- Motion control (N/S/E/W)
- Abort motion

### 10Micron-Specific Features

| Feature | Description |
|---------|-------------|
| **Ultra-Precision Mode** | Extra decimal digits for precise coordinates |
| **Product Information** | Model, control box, firmware version/date |
| **Refraction Model** | Temperature and pressure for atmospheric correction |
| **Alignment Model** | Star count, model management, build new models |
| **Unattended Flip** | Automatic meridian flip control |
| **Sync Modes** | Offset-only or model refinement |
| **Satellite Tracking** | TLE loading and tracking (firmware 2.13.20+) |

## Connection

The driver connects via TCP to the mount's ethernet interface.

- **Default IP**: 192.168.1.103
- **Port**: 3490 (or 3492)
- **Protocol**: Extended LX200 over TCP

### Connection String Format

```
tcp://192.168.1.103:3490
```

Or simply:
```
192.168.1.103:3490
```

## INDIGO Properties

### Standard Mount Properties

| Property | Type | Description |
|----------|------|-------------|
| `MOUNT_EQUATORIAL_COORDINATES` | Number (RW) | RA/Dec coordinates |
| `MOUNT_HORIZONTAL_COORDINATES` | Number (RO) | Alt/Az coordinates |
| `MOUNT_TRACKING` | Switch (RW) | Tracking on/off |
| `MOUNT_PARK` | Switch (RW) | Park/Unpark |
| `MOUNT_SIDE_OF_PIER` | Switch (RO) | East/West pier side |

### 10Micron-Specific Properties

| Property | Group | Type | Description |
|----------|-------|------|-------------|
| `PRODUCT_INFO` | Product | Text (RO) | Mount name and control box |
| `FIRMWARE_INFO` | Product | Text (RO) | Firmware version and date |
| `REFRACTION_MODEL` | Refraction | Number (RW) | Temperature (°C) and pressure (hPa) |
| `ALIGNMENT_INFO` | Alignment | Number (RO) | Star count and saved models |
| `ALIGNMENT_ACTION` | Alignment | Switch (RW) | Start/End/Delete alignment |
| `SYNC_MODE` | Alignment | Switch (RW) | Offset only / Refine model |
| `UNATTENDED_FLIP` | Advanced | Switch (RW) | Enable/Disable auto flip |
| `SATELLITE_TLE` | Satellite | Text (RW) | TLE data for satellite tracking |
| `SATELLITE_ACTION` | Satellite | Switch (RW) | Load TLE / Track satellite |

## LX200 Commands Reference

### Standard LX200
| Command | Description |
|---------|-------------|
| `:GR#` | Get RA |
| `:GD#` | Get Dec |
| `:Sr...#` | Set target RA |
| `:Sd...#` | Set target Dec |
| `:MS#` | Slew to target |
| `:Q#` | Abort |
| `:CM#` | Sync |

### 10Micron Extensions
| Command | Description |
|---------|-------------|
| `:U2#` | Ultra-precision mode |
| `:Ginfo#` | Full status (RA,Dec,Side,Az,Alt,JD,Status) |
| `:Gstat#` | Mount status code |
| `:KA#` | Park |
| `:PO#` | Unpark |
| `:AP#` / `:AL#` | Start/Stop tracking |
| `:GRTMP#` / `:SRTMP#` | Get/Set refraction temperature |
| `:GRPRS#` / `:SRPRS#` | Get/Set refraction pressure |
| `:getalst#` | Alignment star count |
| `:newalig#` | Start new alignment |
| `:newalpt...#` | Add alignment point |
| `:endalig#` | End alignment |
| `:Guaf#` / `:Suaf#` | Get/Set unattended flip |
| `:CMCFG0#` / `:CMCFG1#` | Sync mode (offset/refine) |

## Building

### Prerequisites

- INDIGO SDK installed
- CMake 3.10+
- GCC or compatible C compiler

### Build Steps

```bash
mkdir build && cd build
cmake ..
make
```

### Installation

```bash
sudo make install
```

The driver will be installed to `/lib/indigo/` by default.

## Usage

1. Start INDIGO server with the driver:
   ```bash
   indigo_server indigo_mount_10micron
   ```

2. Connect using any INDIGO client

3. Set the connection string to your mount's IP address:
   ```
   tcp://192.168.1.103:3490
   ```

4. Connect to begin controlling the mount

## Alignment Model Building

To build a new alignment model:

1. Set `SYNC_MODE` to "Refine Model" if you want syncs to add points
2. Click "Start New Alignment" in `ALIGNMENT_ACTION`
3. Slew to various positions, plate-solve, and sync
4. Click "End Alignment" to compute the model

Or use the mount's native alignment point format via `:newalpt` commands.

## Weather Integration

For best pointing accuracy, set the refraction model parameters:

- **Temperature**: Current ambient temperature in °C
- **Pressure**: Current barometric pressure in hPa

These can be automatically updated from a weather station via an INDIGO agent.

## Satellite Tracking

Requires firmware 2.13.20 or newer.

1. Enter TLE data in `SATELLITE_TLE` (name, line1, line2)
2. Click "Load TLE" in `SATELLITE_ACTION`
3. Click "Track Satellite" to begin tracking

## License

BSD 2-Clause License

## References

- [10Micron Mounts](https://www.10micron.eu/)
- [INDIGO Astronomy](https://www.indigo-astronomy.org/)
- [INDI lx200_10micron driver](https://github.com/indilib/indi/blob/master/drivers/telescope/lx200_10micron.cpp)
- [10Micron Command Protocol](https://www.10micron.eu/support/)
