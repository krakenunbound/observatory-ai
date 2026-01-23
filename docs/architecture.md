# Observatory AI Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLAUDE AI ORCHESTRATOR                        │
│  "I want to image M33 tonight"                                  │
│  → Target analysis, planning, sequencing, monitoring            │
└─────────────────────────┬───────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────────┐
│                  OBSERVATORY WEB INTERFACE                       │
│  Port 8092 - Real-time status, manual control, session logs     │
└─────────────────────────┬───────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────────┐
│                    INDI CLIENT LAYER                             │
│  Node.js INDI client → connects to indiserver:7624              │
│  Translates high-level commands to INDI XML protocol            │
└─────────────────────────┬───────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────────┐
│                      INDI SERVER                                 │
│  indiserver -v indi_lx200_10micron indi_qhy_ccd ...             │
│  Manages all device drivers                                      │
└─────────────────────────┬───────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
     ┌─────────┐    ┌─────────┐    ┌─────────┐
     │  Mount  │    │ Cameras │    │ Weather │
     │  Focus  │    │ Filters │    │  Roof   │
     │ Rotator │    │  Guide  │    │  USB    │
     └─────────┘    └─────────┘    └─────────┘
```

## Components

### 1. Claude AI Orchestrator
The brain of the operation. Receives high-level requests and:
- Queries celestial databases for target info (coordinates, size, optimal imaging params)
- Checks weather conditions and safety
- Plans the imaging sequence (number of subs, exposure times, filters)
- Monitors progress and adapts to conditions
- Handles errors and recovery

### 2. Web Interface (Port 8092)
- Real-time dashboard showing all device states
- Manual override controls
- Session planning and scheduling
- Image preview (when available)
- Logs and alerts

### 3. INDI Client
Node.js module that:
- Connects to INDI server via TCP
- Parses XML device definitions
- Sends commands (setSwitch, setNumber, setText, setBLOB)
- Receives property updates
- Handles BLOB (image) data

### 4. Session Planner
Given a target like "M33":
1. Look up coordinates (RA: 01h 33m 50.9s, Dec: +30° 39' 37")
2. Calculate altitude/azimuth throughout the night
3. Determine optimal imaging window
4. Select appropriate OTA based on target size
5. Calculate exposure times based on camera and filters
6. Generate sequence: focus → slew → plate solve → guide → capture

### 5. Safety System
Before and during operations:
- Check weather (clouds, humidity, wind)
- Monitor roof state
- Verify mount is unparked before moving
- Park mount before closing roof
- Emergency abort capability

## INDI Protocol Basics

INDI uses XML messages over TCP (port 7624):

```xml
<!-- Get all device properties -->
<getProperties version="1.7"/>

<!-- Set a switch (e.g., connect camera) -->
<newSwitchVector device="QHY CCD" name="CONNECTION">
  <oneSwitch name="CONNECT">On</oneSwitch>
</newSwitchVector>

<!-- Set a number (e.g., exposure time) -->
<newNumberVector device="QHY CCD" name="CCD_EXPOSURE">
  <oneNumber name="CCD_EXPOSURE_VALUE">300</oneNumber>
</newNumberVector>

<!-- Slew to coordinates -->
<newNumberVector device="10 Micron" name="EQUATORIAL_EOD_COORD">
  <oneNumber name="RA">1.5641</oneNumber>
  <oneNumber name="DEC">30.6603</oneNumber>
</newNumberVector>
```

## Imaging Workflow for "Image M33"

1. **Pre-flight checks**
   - Weather safe? (Uranus device)
   - Roof open?
   - All devices connected?
   - Mount unparked?

2. **Setup**
   - Cool camera to target temp (-20°C)
   - Select appropriate OTA config (TEC 140 for M33's size)
   - Set rotator angle for framing

3. **Acquire Target**
   - Slew mount to M33 coordinates
   - Plate solve to verify pointing
   - Center if needed

4. **Focus**
   - Run autofocus routine with FocusCube
   - Use bright star near target
   - Store focus position

5. **Guiding**
   - Select guide star in OAG field
   - Calibrate guider
   - Start guiding, verify RMS < threshold

6. **Capture Sequence**
   - For color camera (QHY600C): RGB in one shot
   - For mono (QHY16200A): L-R-G-B-Ha-OIII-SII sequence
   - Dither between exposures
   - Monitor guiding, pause if degraded

7. **Monitoring**
   - Track clouds, humidity
   - Monitor mount tracking errors
   - Auto-pause for satellite trails (if detection available)

8. **Shutdown**
   - Park mount
   - Warm up camera
   - Close roof (if conditions warrant)
   - Generate session summary
