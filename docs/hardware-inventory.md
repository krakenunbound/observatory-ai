# Observatory Hardware Inventory

## Location
Desert observatory with roll-off roof, Starlink internet (pending installation)

## Mount
- **10 Micron 2000HPS** - High precision equatorial mount
  - INDI Driver: `indi_lx200_10micron` or `indi_eqmod_telescope`
  - Connection: USB/Serial
  - Capabilities: GoTo, tracking, parking, PEC

## Optical Tube Assemblies (OTAs)
1. **TEC 140mm EDO APO** - F/5 (700mm focal length)
   - Wide field imaging, galaxies, nebulae
   - Field of view with QHY600: ~3.8° x 2.5°

2. **Celestron 11" EdgeHD** - F/10 (2800mm focal length)
   - Deep sky, planetary, small targets
   - Field of view with QHY600: ~0.95° x 0.63°

## Cameras
1. **QHY 600C** - Full frame cooled color (OSC)
   - Sensor: Sony IMX455, 61MP
   - Pixel size: 3.76μm
   - For LRGB broadband imaging

2. **QHY 16200A** - Mono with filter wheel
   - Sensor: 16.2MP APS-H
   - 7-position filter wheel: L, R, G, B, Ha, OIII, SII
   - For narrowband and high-resolution mono imaging

## Guide Camera
- **Starlight Xpress Lodestar X2**
  - Via Off-Axis Guider (OAG)
  - INDI Driver: `indi_sx_ccd`

## Focuser
- **Pegasus Astro FocusCube**
  - INDI Driver: `indi_pegasus_focuscube`
  - Stepper motor, temperature compensation capable

## Rotator
- **Pegasus Astro Falcon Rotator V1**
  - INDI Driver: `indi_pegasus_falcon`
  - For framing and mosaic alignment

## USB Hub
- **Pegasus Astro USB Hub**
  - Individual port power control
  - INDI Driver: `indi_pegasus_upb` (if Ultimate Power Box) or similar
  - Can cycle devices for connection issues

## Weather Station
- **Pegasus Astro Uranus**
  - INDI Driver: `indi_pegasus_uranus`
  - Monitors: temperature, humidity, dew point, cloud cover, sky quality
  - Critical for automated safety decisions

## Roof Control
- **Arduino Nano + Relay Board**
  - Custom integration needed
  - INDI Driver: Can use `indi_rolloffino` or custom
  - Safety interlock with mount parking

## Lighting
- **LED Light Panel**
  - Arduino controlled (possibly same Nano)
  - For flat field calibration frames

## Software Stack
- **KStars** - Planetarium and planning
- **Ekos** - Equipment control and automation (part of KStars)
- **INDI** - Instrument Neutral Distributed Interface (device drivers)
- **ASTAP** - Plate solving (astrometric calibration)
- **PHD2** - Alternative guiding (optional, Ekos has internal guider)

## Network
- **Starlink** - Internet connectivity (installation pending)
- Enables remote operation and Claude AI integration
