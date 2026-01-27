# Pegasus Uranus Meteo Sensor - INDIGO Driver

INDIGO driver for the Pegasus Astro Uranus Meteo Sensor weather station.

## Features

- **Environmental Sensors**: Temperature, humidity, dew point, barometric pressure
- **Sky Monitoring**: IR sky temperature, cloud detection index
- **Sky Quality**: MPAS (mag/arcsec²), NELM, spectrum analysis
- **GPS**: Position, satellites, time synchronization
- **Weather Safety**: Configurable thresholds for automated alerts

## Serial Protocol

- **Baud Rate**: 115200
- **Terminator**: `\r\n`
- **Connection**: USB Serial

### Commands

| Command | Response | Description |
|---------|----------|-------------|
| `M#` | `MS_OK` | Handshake |
| `MA` | Colon-delimited values | All sensor readings |
| `GP` | Colon-delimited values | GPS data |
| `CI` | Colon-delimited values | Cloud info |
| `SQ` | Colon-delimited values | Sky quality |
| `SQ:1` | - | Trigger SQ measurement |

## INDIGO Properties

### Main Group

| Property | Type | Description |
|----------|------|-------------|
| `SENSORS` | Number (RO) | Environmental readings |
| `CLOUDS` | Number (RO) | Cloud detection data |
| `SKY_QUALITY` | Number (RO) | Sky brightness data |
| `GPS` | Number (RO) | GPS position and status |
| `AUX_WEATHER` | Number (RO) | Standard INDIGO weather interface |

### Advanced Group

| Property | Type | Description |
|----------|------|-------------|
| `THRESHOLDS` | Number (RW) | Alert threshold configuration |

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
   indigo_server indigo_aux_uranus
   ```

2. Connect using any INDIGO client (INDIGO Control Panel, Ain INDIGO, etc.)

3. Select the serial port in the CONNECTION property

4. Connect to start receiving sensor data

## Cloud Detection

The Uranus sensor uses IR temperature differential to detect clouds:

- **Clear sky**: ΔT > 30°C (sky much colder than ambient)
- **Partly cloudy**: 15°C < ΔT < 30°C
- **Cloudy**: ΔT < 15°C (sky temperature close to ambient)

The `CLOUD_INDEX` property shows cloud coverage as a percentage (0-100%).

## Weather Safety

Configure thresholds in the `THRESHOLDS` property:

- **TEMP_MIN/TEMP_MAX**: Safe temperature range
- **HUMIDITY_MAX**: Maximum safe humidity
- **CLOUD_MAX**: Maximum cloud coverage percentage
- **MPAS_MIN**: Minimum acceptable sky brightness

When any threshold is exceeded, the `AUX_WEATHER` property state changes to `ALERT`.

## License

BSD 2-Clause License

## References

- [Pegasus Astro Uranus Meteo Sensor](https://pegasusastro.com/products/uranus-meteo-sensor/)
- [INDIGO Astronomy](https://www.indigo-astronomy.org/)
- [INDI uranusmeteo driver](https://github.com/indilib/indi/blob/master/drivers/weather/uranusmeteo.cpp)
