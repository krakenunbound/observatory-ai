# 10Micron Mount Modeling - Research & Implementation

## Overview

The 10Micron GM2000 uses an extended LX200 protocol for mount modeling. The mount can store up to 100 alignment points (3 base + 97 refine points) and multiple named models.

## Connection Details

- **IP**: 192.168.1.103
- **Port**: 3490 (or 3492)
- **Protocol**: TCP/LX200 extended

## Key Commands

### Reading Current Model

| Command | Response | Description |
|---------|----------|-------------|
| `:getalst#` | `N#` | Number of alignment stars in current model |
| `:getalpN#` | Complex | Get alignment point N details (1-based index) |
| `:modelcnt#` | `N#` | Number of saved models |

### Creating New Model

| Command | Description |
|---------|-------------|
| `:newalig#` | Start new alignment specification |
| `:newalptMRA,MDEC,MSIDE,PRA,PDEC,SIDTIME#` | Add alignment point |
| `:endalig#` | Finalize alignment and compute model |
| `:delalig#` | Delete current alignment model |

### Alignment Point Format (`:newalpt`)

Parameters:
- `MRA` - Mount reported RA (where mount thinks it's pointing)
- `MDEC` - Mount reported Dec
- `MSIDE` - Pier side (E/W)
- `PRA` - Plate-solved RA (actual position from plate solve)
- `PDEC` - Plate-solved Dec
- `SIDTIME` - Local sidereal time at measurement

### Sync Behavior Configuration

| Command | Description |
|---------|-------------|
| `:CMCFG0#` | Sync applies offset correction only |
| `:CMCFG1#` | Sync refines alignment model (adds point) |

### Refraction Model

| Command | Description |
|---------|-------------|
| `:GRTMP#` | Get temperature (Celsius) |
| `:SRTMP+TT.T#` | Set temperature |
| `:GRPRS#` | Get pressure (hPa) |
| `:SRPRSPPPP.P#` | Set pressure |

## Implementation Plan

### Phase 1: Read Current Model
1. Query `:getalst#` to get point count
2. Loop `:getalpN#` for N=1 to count
3. Parse response to extract RA/Dec/error for each point
4. Display points on sky map with error magnitude

### Phase 2: Model Management
1. Display model statistics (point count, RMS error)
2. Identify outlier points (high error)
3. Implement point deletion (requires rebuilding model without that point)
4. Clear model (`:delalig#`)

### Phase 3: Automated Model Building
1. Generate optimal sky point distribution (grid or spiral pattern)
2. Filter for currently visible points (above horizon, not in exclusion zones)
3. For each point:
   - Slew to target coordinates
   - Take short exposure
   - Plate solve with ASTAP
   - Send `:newalpt` with mount coords + solved coords
4. Finalize with `:endalig#`

### Phase 4: Model Refinement
1. Set `:CMCFG1#` (syncs refine model)
2. Slew to areas with poor coverage
3. Plate solve and sync to add refinement points
4. Monitor model improvement

## Optimal Point Distribution

For best model coverage, use a modified Fibonacci spiral or grid pattern:
- Distribute points evenly in altitude/azimuth
- Concentrate more points near the horizon (higher refraction)
- Avoid meridian during initial build
- Include points at various hour angles

### Suggested Minimum Points

| Use Case | Points | Notes |
|----------|--------|-------|
| Visual | 6-12 | Basic coverage |
| Wide-field imaging | 20-30 | f/5 or slower |
| Narrow-field imaging | 40-60 | f/7 or faster |
| Ultra-precision | 80-100 | Long focal length, unguided |

## ASTAP Integration

ASTAP is already installed at `/home/kraken/bin/astap_cli`

```bash
# Plate solve with position hint
/home/kraken/bin/astap_cli -f image.fits -fov 1.93 -r 10 -ra 5.58 -spd 95.39 -d /home/kraken/.local/share/astap/

# Output: image.ini with CRVAL1 (RA), CRVAL2 (Dec)
```

Parse the `.ini` file to get solved coordinates.

## References

- [INDI 10Micron Driver](https://github.com/indilib/indi/blob/master/drivers/telescope/lx200_10micron.cpp)
- [INDI Forum Discussion](https://indilib.org/forum/mounts/2484-10micron-mount-modelling.html)
- [10Micron Command Protocol v2.15.1](https://www.ap-i.net/mantis/file_download.php?file_id=1224&type=bug)
- [Cloudy Nights - Building 10Micron Models](https://www.cloudynights.com/topic/569991-building-10micron-mount-models/)

## Notes

- Mount uses JNow coordinates (Epoch of Date), not J2000
- Maximum 100 alignment points (3 base + 97 refine)
- Model names: max 15 characters, case-sensitive
- Always set refraction parameters before building model
