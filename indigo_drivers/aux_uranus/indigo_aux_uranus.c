// Copyright (c) 2024 Observatory AI Project
// All rights reserved.
//
// INDIGO Pegasus Uranus Meteo Sensor driver
//
// Based on the INDI uranusmeteo driver and INDIGO driver patterns.
// Serial protocol: 115200 baud, commands terminated with \r\n
//
// Supported sensors:
// - Environmental: temperature, humidity, dew point, pressure
// - Sky: IR temperature, cloud detection
// - Sky quality: MPAS, NELM, spectrum analysis
// - GPS: position, time, satellites

#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <math.h>
#include <pthread.h>
#include <termios.h>
#include <fcntl.h>
#include <errno.h>

#include <indigo/indigo_driver_xml.h>
#include <indigo/indigo_io.h>
#include <indigo/indigo_aux_driver.h>

#include "indigo_aux_uranus.h"

// ----------------------------------------------------------------------------
// Driver version
// ----------------------------------------------------------------------------

#define DRIVER_VERSION         0x0001
#define DRIVER_NAME            "indigo_aux_uranus"

// ----------------------------------------------------------------------------
// Private data structure
// ----------------------------------------------------------------------------

typedef struct {
    int handle;                          // Serial port handle
    bool connected;
    pthread_mutex_t mutex;

    // Device info
    char serial_number[64];
    char firmware_version[64];

    // Sensor data cache
    double sensors[URANUS_SENSOR_COUNT];
    double clouds[URANUS_CLOUD_COUNT];
    double skyquality[URANUS_SQ_COUNT];
    double gps[URANUS_GPS_COUNT];

    // Timing
    indigo_timer *sensor_timer;
    double poll_interval;

    // Properties
    indigo_property *device_info_property;
    indigo_property *sensors_property;
    indigo_property *clouds_property;
    indigo_property *skyquality_property;
    indigo_property *gps_property;
    indigo_property *weather_property;
    indigo_property *thresholds_property;

} uranus_private_data;

// ----------------------------------------------------------------------------
// Device declaration
// ----------------------------------------------------------------------------

static indigo_device *uranus_device = NULL;

// ----------------------------------------------------------------------------
// Serial communication
// ----------------------------------------------------------------------------

static bool uranus_open(indigo_device *device) {
    uranus_private_data *private_data = (uranus_private_data *)device->private_data;

    char *name = DEVICE_PORT_ITEM->text.value;
    private_data->handle = indigo_open_serial_with_speed(name, URANUS_DEFAULT_BAUDRATE);

    if (private_data->handle < 0) {
        INDIGO_DRIVER_ERROR(DRIVER_NAME, "Failed to open serial port %s", name);
        return false;
    }

    INDIGO_DRIVER_DEBUG(DRIVER_NAME, "Connected to %s", name);
    return true;
}

static void uranus_close(indigo_device *device) {
    uranus_private_data *private_data = (uranus_private_data *)device->private_data;

    if (private_data->handle >= 0) {
        close(private_data->handle);
        private_data->handle = -1;
    }
}

static bool uranus_command(indigo_device *device, const char *command, char *response, int response_len) {
    uranus_private_data *private_data = (uranus_private_data *)device->private_data;

    pthread_mutex_lock(&private_data->mutex);

    // Clear any pending input
    tcflush(private_data->handle, TCIOFLUSH);

    // Send command with \r\n terminator
    char cmd_buf[256];
    snprintf(cmd_buf, sizeof(cmd_buf), "%s\r\n", command);

    if (indigo_write(private_data->handle, cmd_buf, strlen(cmd_buf)) == false) {
        INDIGO_DRIVER_ERROR(DRIVER_NAME, "Failed to send command: %s", command);
        pthread_mutex_unlock(&private_data->mutex);
        return false;
    }

    // Read response
    if (response && response_len > 0) {
        memset(response, 0, response_len);

        int total = 0;
        int timeout_ms = URANUS_COMMAND_TIMEOUT * 1000;

        while (total < response_len - 1 && timeout_ms > 0) {
            fd_set fds;
            struct timeval tv;

            FD_ZERO(&fds);
            FD_SET(private_data->handle, &fds);
            tv.tv_sec = 0;
            tv.tv_usec = 100000; // 100ms

            int result = select(private_data->handle + 1, &fds, NULL, NULL, &tv);

            if (result > 0) {
                char c;
                if (read(private_data->handle, &c, 1) == 1) {
                    if (c == '\n') {
                        // End of response
                        break;
                    }
                    if (c != '\r') {
                        response[total++] = c;
                    }
                }
            }
            timeout_ms -= 100;
        }

        response[total] = '\0';
        INDIGO_DRIVER_DEBUG(DRIVER_NAME, "Command '%s' -> '%s'", command, response);
    }

    pthread_mutex_unlock(&private_data->mutex);
    return true;
}

// ----------------------------------------------------------------------------
// Handshake
// ----------------------------------------------------------------------------

static bool uranus_handshake(indigo_device *device) {
    char response[64];

    if (!uranus_command(device, URANUS_CMD_HANDSHAKE, response, sizeof(response))) {
        return false;
    }

    if (strstr(response, URANUS_HANDSHAKE_RESPONSE) == NULL) {
        INDIGO_DRIVER_ERROR(DRIVER_NAME, "Handshake failed, expected %s got %s",
                           URANUS_HANDSHAKE_RESPONSE, response);
        return false;
    }

    return true;
}

// ----------------------------------------------------------------------------
// Parse colon-delimited response into array
// ----------------------------------------------------------------------------

static int uranus_parse_response(const char *response, double *values, int max_values) {
    char *copy = strdup(response);
    char *token;
    char *saveptr;
    int count = 0;

    // Skip the command echo if present (e.g., "MA:" prefix)
    char *data = strchr(copy, ':');
    if (data) {
        data++; // Skip the colon
    } else {
        data = copy;
    }

    token = strtok_r(data, ":", &saveptr);
    while (token && count < max_values) {
        values[count++] = atof(token);
        token = strtok_r(NULL, ":", &saveptr);
    }

    free(copy);
    return count;
}

// ----------------------------------------------------------------------------
// Read sensors
// ----------------------------------------------------------------------------

static bool uranus_read_sensors(indigo_device *device) {
    uranus_private_data *private_data = (uranus_private_data *)device->private_data;
    char response[512];

    // Read all sensors (MA command)
    if (uranus_command(device, URANUS_CMD_SENSORS, response, sizeof(response))) {
        uranus_parse_response(response, private_data->sensors, URANUS_SENSOR_COUNT);
    }

    // Read cloud data (CI command)
    if (uranus_command(device, URANUS_CMD_CLOUDS, response, sizeof(response))) {
        uranus_parse_response(response, private_data->clouds, URANUS_CLOUD_COUNT);
    }

    // Read sky quality (SQ command)
    if (uranus_command(device, URANUS_CMD_SKYQUALITY, response, sizeof(response))) {
        uranus_parse_response(response, private_data->skyquality, URANUS_SQ_COUNT);
    }

    // Read GPS (GP command)
    if (uranus_command(device, URANUS_CMD_GPS, response, sizeof(response))) {
        uranus_parse_response(response, private_data->gps, URANUS_GPS_COUNT);
    }

    return true;
}

// ----------------------------------------------------------------------------
// Update properties from cached sensor data
// ----------------------------------------------------------------------------

static void uranus_update_properties(indigo_device *device) {
    uranus_private_data *private_data = (uranus_private_data *)device->private_data;

    // Update sensor property
    if (private_data->sensors_property) {
        private_data->sensors_property->items[0].number.value = private_data->sensors[URANUS_SENSOR_AMBIENT_TEMP];
        private_data->sensors_property->items[1].number.value = private_data->sensors[URANUS_SENSOR_HUMIDITY];
        private_data->sensors_property->items[2].number.value = private_data->sensors[URANUS_SENSOR_DEW_POINT];
        private_data->sensors_property->items[3].number.value = private_data->sensors[URANUS_SENSOR_PRESSURE_ABS];
        private_data->sensors_property->items[4].number.value = private_data->sensors[URANUS_SENSOR_PRESSURE_REL];
        private_data->sensors_property->items[5].number.value = private_data->sensors[URANUS_SENSOR_BARO_ALTITUDE];
        private_data->sensors_property->items[6].number.value = private_data->sensors[URANUS_SENSOR_SKY_TEMP];
        private_data->sensors_property->items[7].number.value = private_data->sensors[URANUS_SENSOR_IR_TEMP];
        private_data->sensors_property->items[8].number.value = private_data->sensors[URANUS_SENSOR_BATTERY_VOLTAGE];
        private_data->sensors_property->state = INDIGO_OK_STATE;
        indigo_update_property(device, private_data->sensors_property, NULL);
    }

    // Update clouds property
    if (private_data->clouds_property) {
        private_data->clouds_property->items[0].number.value = private_data->clouds[URANUS_CLOUD_TEMP_DIFF];
        private_data->clouds_property->items[1].number.value = private_data->clouds[URANUS_CLOUD_INDEX];
        private_data->clouds_property->items[2].number.value = private_data->clouds[URANUS_CLOUD_SKY_TEMP];
        private_data->clouds_property->items[3].number.value = private_data->clouds[URANUS_CLOUD_AMBIENT_TEMP];
        private_data->clouds_property->items[4].number.value = private_data->clouds[URANUS_CLOUD_EMISSIVITY];
        private_data->clouds_property->state = INDIGO_OK_STATE;
        indigo_update_property(device, private_data->clouds_property, NULL);
    }

    // Update sky quality property
    if (private_data->skyquality_property) {
        private_data->skyquality_property->items[0].number.value = private_data->skyquality[URANUS_SQ_MPAS];
        private_data->skyquality_property->items[1].number.value = private_data->skyquality[URANUS_SQ_NELM];
        private_data->skyquality_property->items[2].number.value = private_data->skyquality[URANUS_SQ_FULL_SPECTRUM];
        private_data->skyquality_property->items[3].number.value = private_data->skyquality[URANUS_SQ_VISUAL_SPECTRUM];
        private_data->skyquality_property->items[4].number.value = private_data->skyquality[URANUS_SQ_IR_SPECTRUM];
        private_data->skyquality_property->state = INDIGO_OK_STATE;
        indigo_update_property(device, private_data->skyquality_property, NULL);
    }

    // Update GPS property
    if (private_data->gps_property) {
        private_data->gps_property->items[0].number.value = private_data->gps[URANUS_GPS_FIX];
        private_data->gps_property->items[1].number.value = private_data->gps[URANUS_GPS_LATITUDE];
        private_data->gps_property->items[2].number.value = private_data->gps[URANUS_GPS_LONGITUDE];
        private_data->gps_property->items[3].number.value = private_data->gps[URANUS_GPS_SATELLITES];
        private_data->gps_property->items[4].number.value = private_data->gps[URANUS_GPS_SPEED_KPH];
        private_data->gps_property->items[5].number.value = private_data->gps[URANUS_GPS_BEARING];
        private_data->gps_property->state = (private_data->gps[URANUS_GPS_FIX] > 0) ? INDIGO_OK_STATE : INDIGO_BUSY_STATE;
        indigo_update_property(device, private_data->gps_property, NULL);
    }

    // Update standard weather property
    if (private_data->weather_property) {
        // Temperature
        private_data->weather_property->items[0].number.value = private_data->sensors[URANUS_SENSOR_AMBIENT_TEMP];
        // Humidity
        private_data->weather_property->items[1].number.value = private_data->sensors[URANUS_SENSOR_HUMIDITY];
        // Dew point
        private_data->weather_property->items[2].number.value = private_data->sensors[URANUS_SENSOR_DEW_POINT];
        // Wind speed (Uranus doesn't have wind sensor, set to 0)
        private_data->weather_property->items[3].number.value = 0;
        // Rain (Uranus doesn't have rain sensor, set to 0)
        private_data->weather_property->items[4].number.value = 0;
        // Sky brightness (MPAS)
        private_data->weather_property->items[5].number.value = private_data->skyquality[URANUS_SQ_MPAS];
        // Sky temperature
        private_data->weather_property->items[6].number.value = private_data->sensors[URANUS_SENSOR_SKY_TEMP];
        // Cloud coverage
        private_data->weather_property->items[7].number.value = private_data->clouds[URANUS_CLOUD_INDEX];

        // Determine overall state based on thresholds
        bool safe = true;
        double temp = private_data->sensors[URANUS_SENSOR_AMBIENT_TEMP];
        double humidity = private_data->sensors[URANUS_SENSOR_HUMIDITY];
        double clouds = private_data->clouds[URANUS_CLOUD_INDEX];

        if (private_data->thresholds_property) {
            double temp_min = private_data->thresholds_property->items[0].number.value;
            double temp_max = private_data->thresholds_property->items[1].number.value;
            double humidity_max = private_data->thresholds_property->items[2].number.value;
            double cloud_max = private_data->thresholds_property->items[3].number.value;

            if (temp < temp_min || temp > temp_max) safe = false;
            if (humidity > humidity_max) safe = false;
            if (clouds > cloud_max) safe = false;
        }

        private_data->weather_property->state = safe ? INDIGO_OK_STATE : INDIGO_ALERT_STATE;
        indigo_update_property(device, private_data->weather_property, NULL);
    }
}

// ----------------------------------------------------------------------------
// Timer callback for periodic sensor reading
// ----------------------------------------------------------------------------

static void uranus_timer_callback(indigo_device *device) {
    uranus_private_data *private_data = (uranus_private_data *)device->private_data;

    if (!private_data->connected) {
        return;
    }

    uranus_read_sensors(device);
    uranus_update_properties(device);

    // Reschedule timer
    indigo_reschedule_timer(device, private_data->poll_interval, &private_data->sensor_timer);
}

// ----------------------------------------------------------------------------
// Initialize properties
// ----------------------------------------------------------------------------

static void uranus_init_properties(indigo_device *device) {
    uranus_private_data *private_data = (uranus_private_data *)device->private_data;

    // -------------------------------------------------------------------------
    // Device info property
    // -------------------------------------------------------------------------
    private_data->device_info_property = indigo_init_text_property(NULL, device->name,
        "DEVICE_INFO", AUX_MAIN_GROUP, "Device Info", INDIGO_OK_STATE, INDIGO_RO_PERM, 2);
    indigo_init_text_item(private_data->device_info_property->items + 0,
        "SERIAL_NUMBER", "Serial Number", "");
    indigo_init_text_item(private_data->device_info_property->items + 1,
        "FIRMWARE", "Firmware", "");

    // -------------------------------------------------------------------------
    // Environmental sensors property
    // -------------------------------------------------------------------------
    private_data->sensors_property = indigo_init_number_property(NULL, device->name,
        "SENSORS", AUX_MAIN_GROUP, "Environmental Sensors", INDIGO_OK_STATE, INDIGO_RO_PERM, 9);
    indigo_init_number_item(private_data->sensors_property->items + 0,
        "AMBIENT_TEMP", "Ambient Temp (°C)", -40, 80, 0.1, 0);
    indigo_init_number_item(private_data->sensors_property->items + 1,
        "HUMIDITY", "Humidity (%)", 0, 100, 0.1, 0);
    indigo_init_number_item(private_data->sensors_property->items + 2,
        "DEW_POINT", "Dew Point (°C)", -40, 80, 0.1, 0);
    indigo_init_number_item(private_data->sensors_property->items + 3,
        "PRESSURE_ABS", "Absolute Pressure (hPa)", 300, 1100, 0.1, 0);
    indigo_init_number_item(private_data->sensors_property->items + 4,
        "PRESSURE_REL", "Relative Pressure (hPa)", 300, 1100, 0.1, 0);
    indigo_init_number_item(private_data->sensors_property->items + 5,
        "BARO_ALTITUDE", "Barometric Altitude (m)", -500, 9000, 1, 0);
    indigo_init_number_item(private_data->sensors_property->items + 6,
        "SKY_TEMP", "Sky Temperature (°C)", -80, 50, 0.1, 0);
    indigo_init_number_item(private_data->sensors_property->items + 7,
        "IR_TEMP", "IR Temperature (°C)", -80, 50, 0.1, 0);
    indigo_init_number_item(private_data->sensors_property->items + 8,
        "BATTERY_VOLTAGE", "Battery Voltage (V)", 0, 6, 0.01, 0);

    // -------------------------------------------------------------------------
    // Cloud detection property
    // -------------------------------------------------------------------------
    private_data->clouds_property = indigo_init_number_property(NULL, device->name,
        "CLOUDS", AUX_MAIN_GROUP, "Cloud Detection", INDIGO_OK_STATE, INDIGO_RO_PERM, 5);
    indigo_init_number_item(private_data->clouds_property->items + 0,
        "TEMP_DIFF", "Temp Differential (°C)", -50, 50, 0.1, 0);
    indigo_init_number_item(private_data->clouds_property->items + 1,
        "CLOUD_INDEX", "Cloud Index (%)", 0, 100, 1, 0);
    indigo_init_number_item(private_data->clouds_property->items + 2,
        "CLOUD_SKY_TEMP", "Cloud Sky Temp (°C)", -80, 50, 0.1, 0);
    indigo_init_number_item(private_data->clouds_property->items + 3,
        "CLOUD_AMBIENT_TEMP", "Cloud Ambient Temp (°C)", -40, 80, 0.1, 0);
    indigo_init_number_item(private_data->clouds_property->items + 4,
        "EMISSIVITY", "IR Emissivity", 0, 1, 0.01, 0);

    // -------------------------------------------------------------------------
    // Sky quality property
    // -------------------------------------------------------------------------
    private_data->skyquality_property = indigo_init_number_property(NULL, device->name,
        "SKY_QUALITY", AUX_MAIN_GROUP, "Sky Quality", INDIGO_OK_STATE, INDIGO_RO_PERM, 5);
    indigo_init_number_item(private_data->skyquality_property->items + 0,
        "MPAS", "MPAS (mag/arcsec²)", 0, 25, 0.01, 0);
    indigo_init_number_item(private_data->skyquality_property->items + 1,
        "NELM", "NELM (mag)", 0, 8, 0.1, 0);
    indigo_init_number_item(private_data->skyquality_property->items + 2,
        "FULL_SPECTRUM", "Full Spectrum", 0, 100000, 1, 0);
    indigo_init_number_item(private_data->skyquality_property->items + 3,
        "VISUAL_SPECTRUM", "Visual Spectrum", 0, 100000, 1, 0);
    indigo_init_number_item(private_data->skyquality_property->items + 4,
        "IR_SPECTRUM", "IR Spectrum", 0, 100000, 1, 0);

    // -------------------------------------------------------------------------
    // GPS property
    // -------------------------------------------------------------------------
    private_data->gps_property = indigo_init_number_property(NULL, device->name,
        "GPS", AUX_MAIN_GROUP, "GPS", INDIGO_OK_STATE, INDIGO_RO_PERM, 6);
    indigo_init_number_item(private_data->gps_property->items + 0,
        "FIX", "Fix Status", 0, 3, 1, 0);
    indigo_init_number_item(private_data->gps_property->items + 1,
        "LATITUDE", "Latitude (°)", -90, 90, 0.000001, 0);
    indigo_init_number_item(private_data->gps_property->items + 2,
        "LONGITUDE", "Longitude (°)", -180, 180, 0.000001, 0);
    indigo_init_number_item(private_data->gps_property->items + 3,
        "SATELLITES", "Satellites", 0, 50, 1, 0);
    indigo_init_number_item(private_data->gps_property->items + 4,
        "SPEED", "Speed (km/h)", 0, 1000, 0.1, 0);
    indigo_init_number_item(private_data->gps_property->items + 5,
        "BEARING", "Bearing (°)", 0, 360, 0.1, 0);

    // -------------------------------------------------------------------------
    // Standard weather property (for compatibility with INDIGO weather interface)
    // -------------------------------------------------------------------------
    private_data->weather_property = indigo_init_number_property(NULL, device->name,
        AUX_WEATHER_PROPERTY_NAME, AUX_MAIN_GROUP, "Weather", INDIGO_OK_STATE, INDIGO_RO_PERM, 8);
    indigo_init_number_item(private_data->weather_property->items + 0,
        AUX_WEATHER_TEMPERATURE_ITEM_NAME, "Temperature (°C)", -40, 80, 0.1, 0);
    indigo_init_number_item(private_data->weather_property->items + 1,
        AUX_WEATHER_HUMIDITY_ITEM_NAME, "Humidity (%)", 0, 100, 0.1, 0);
    indigo_init_number_item(private_data->weather_property->items + 2,
        AUX_WEATHER_DEWPOINT_ITEM_NAME, "Dew Point (°C)", -40, 80, 0.1, 0);
    indigo_init_number_item(private_data->weather_property->items + 3,
        AUX_WEATHER_WIND_SPEED_ITEM_NAME, "Wind Speed (m/s)", 0, 100, 0.1, 0);
    indigo_init_number_item(private_data->weather_property->items + 4,
        AUX_WEATHER_RAIN_ITEM_NAME, "Rain", 0, 100, 1, 0);
    indigo_init_number_item(private_data->weather_property->items + 5,
        AUX_WEATHER_SKY_BRIGHTNESS_ITEM_NAME, "Sky Brightness (MPAS)", 0, 25, 0.01, 0);
    indigo_init_number_item(private_data->weather_property->items + 6,
        AUX_WEATHER_SKY_TEMPERATURE_ITEM_NAME, "Sky Temperature (°C)", -80, 50, 0.1, 0);
    indigo_init_number_item(private_data->weather_property->items + 7,
        "CLOUD_COVER", "Cloud Cover (%)", 0, 100, 1, 0);

    // -------------------------------------------------------------------------
    // Thresholds property
    // -------------------------------------------------------------------------
    private_data->thresholds_property = indigo_init_number_property(NULL, device->name,
        "THRESHOLDS", AUX_ADVANCED_GROUP, "Alert Thresholds", INDIGO_OK_STATE, INDIGO_RW_PERM, 5);
    indigo_init_number_item(private_data->thresholds_property->items + 0,
        "TEMP_MIN", "Min Safe Temp (°C)", -50, 50, 1, URANUS_THRESHOLD_TEMP_MIN);
    indigo_init_number_item(private_data->thresholds_property->items + 1,
        "TEMP_MAX", "Max Safe Temp (°C)", 0, 80, 1, URANUS_THRESHOLD_TEMP_MAX);
    indigo_init_number_item(private_data->thresholds_property->items + 2,
        "HUMIDITY_MAX", "Max Safe Humidity (%)", 0, 100, 1, URANUS_THRESHOLD_HUMIDITY_ALERT);
    indigo_init_number_item(private_data->thresholds_property->items + 3,
        "CLOUD_MAX", "Max Cloud Cover (%)", 0, 100, 1, URANUS_THRESHOLD_CLOUD_ALERT);
    indigo_init_number_item(private_data->thresholds_property->items + 4,
        "MPAS_MIN", "Min Sky Brightness (MPAS)", 0, 25, 0.1, URANUS_THRESHOLD_MPAS_ALERT);
}

// ----------------------------------------------------------------------------
// Device attach callback
// ----------------------------------------------------------------------------

static indigo_result uranus_attach(indigo_device *device) {
    assert(device != NULL);
    assert(PRIVATE_DATA != NULL);

    if (indigo_aux_attach(device, DRIVER_NAME, DRIVER_VERSION, INDIGO_INTERFACE_AUX_WEATHER | INDIGO_INTERFACE_AUX_GPS) == INDIGO_OK) {
        uranus_private_data *private_data = (uranus_private_data *)device->private_data;

        pthread_mutex_init(&private_data->mutex, NULL);
        private_data->handle = -1;
        private_data->connected = false;
        private_data->poll_interval = URANUS_POLL_INTERVAL;

        uranus_init_properties(device);

        INDIGO_DEVICE_ATTACH_LOG(DRIVER_NAME, device->name);
        return indigo_aux_enumerate_properties(device, NULL, NULL);
    }
    return INDIGO_FAILED;
}

// ----------------------------------------------------------------------------
// Enumerate properties callback
// ----------------------------------------------------------------------------

static indigo_result uranus_enumerate_properties(indigo_device *device, indigo_client *client, indigo_property *property) {
    if (indigo_property_match(CONNECTION_PROPERTY, property))
        indigo_define_property(device, CONNECTION_PROPERTY, NULL);

    if (IS_CONNECTED) {
        uranus_private_data *private_data = (uranus_private_data *)device->private_data;

        if (indigo_property_match(private_data->device_info_property, property))
            indigo_define_property(device, private_data->device_info_property, NULL);
        if (indigo_property_match(private_data->sensors_property, property))
            indigo_define_property(device, private_data->sensors_property, NULL);
        if (indigo_property_match(private_data->clouds_property, property))
            indigo_define_property(device, private_data->clouds_property, NULL);
        if (indigo_property_match(private_data->skyquality_property, property))
            indigo_define_property(device, private_data->skyquality_property, NULL);
        if (indigo_property_match(private_data->gps_property, property))
            indigo_define_property(device, private_data->gps_property, NULL);
        if (indigo_property_match(private_data->weather_property, property))
            indigo_define_property(device, private_data->weather_property, NULL);
        if (indigo_property_match(private_data->thresholds_property, property))
            indigo_define_property(device, private_data->thresholds_property, NULL);
    }

    return indigo_aux_enumerate_properties(device, client, property);
}

// ----------------------------------------------------------------------------
// Change property callback
// ----------------------------------------------------------------------------

static indigo_result uranus_change_property(indigo_device *device, indigo_client *client, indigo_property *property) {
    assert(device != NULL);
    assert(DEVICE_CONTEXT != NULL);
    assert(property != NULL);

    uranus_private_data *private_data = (uranus_private_data *)device->private_data;

    // -------------------------------------------------------------------------
    // Connection property
    // -------------------------------------------------------------------------
    if (indigo_property_match(CONNECTION_PROPERTY, property)) {
        if (indigo_ignore_connection_change(device, property))
            return INDIGO_OK;

        indigo_property_copy_values(CONNECTION_PROPERTY, property, false);
        CONNECTION_PROPERTY->state = INDIGO_BUSY_STATE;
        indigo_update_property(device, CONNECTION_PROPERTY, NULL);

        if (CONNECTION_CONNECTED_ITEM->sw.value) {
            // Connect
            if (uranus_open(device)) {
                if (uranus_handshake(device)) {
                    private_data->connected = true;
                    CONNECTION_PROPERTY->state = INDIGO_OK_STATE;

                    // Define properties
                    indigo_define_property(device, private_data->device_info_property, NULL);
                    indigo_define_property(device, private_data->sensors_property, NULL);
                    indigo_define_property(device, private_data->clouds_property, NULL);
                    indigo_define_property(device, private_data->skyquality_property, NULL);
                    indigo_define_property(device, private_data->gps_property, NULL);
                    indigo_define_property(device, private_data->weather_property, NULL);
                    indigo_define_property(device, private_data->thresholds_property, NULL);

                    // Initial sensor read
                    uranus_read_sensors(device);
                    uranus_update_properties(device);

                    // Start timer for periodic updates
                    indigo_set_timer(device, private_data->poll_interval, uranus_timer_callback, &private_data->sensor_timer);
                } else {
                    uranus_close(device);
                    CONNECTION_PROPERTY->state = INDIGO_ALERT_STATE;
                    indigo_update_property(device, CONNECTION_PROPERTY, "Handshake failed");
                }
            } else {
                CONNECTION_PROPERTY->state = INDIGO_ALERT_STATE;
                indigo_update_property(device, CONNECTION_PROPERTY, "Failed to open port");
            }
        } else {
            // Disconnect
            if (private_data->sensor_timer) {
                indigo_cancel_timer(device, &private_data->sensor_timer);
            }

            indigo_delete_property(device, private_data->device_info_property, NULL);
            indigo_delete_property(device, private_data->sensors_property, NULL);
            indigo_delete_property(device, private_data->clouds_property, NULL);
            indigo_delete_property(device, private_data->skyquality_property, NULL);
            indigo_delete_property(device, private_data->gps_property, NULL);
            indigo_delete_property(device, private_data->weather_property, NULL);
            indigo_delete_property(device, private_data->thresholds_property, NULL);

            uranus_close(device);
            private_data->connected = false;
            CONNECTION_PROPERTY->state = INDIGO_OK_STATE;
        }

        indigo_update_property(device, CONNECTION_PROPERTY, NULL);
        return INDIGO_OK;
    }

    // -------------------------------------------------------------------------
    // Thresholds property
    // -------------------------------------------------------------------------
    if (indigo_property_match(private_data->thresholds_property, property)) {
        indigo_property_copy_values(private_data->thresholds_property, property, false);
        private_data->thresholds_property->state = INDIGO_OK_STATE;
        indigo_update_property(device, private_data->thresholds_property, NULL);
        return INDIGO_OK;
    }

    return indigo_aux_change_property(device, client, property);
}

// ----------------------------------------------------------------------------
// Device detach callback
// ----------------------------------------------------------------------------

static indigo_result uranus_detach(indigo_device *device) {
    assert(device != NULL);

    uranus_private_data *private_data = (uranus_private_data *)device->private_data;

    if (private_data->sensor_timer) {
        indigo_cancel_timer(device, &private_data->sensor_timer);
    }

    if (private_data->connected) {
        uranus_close(device);
    }

    pthread_mutex_destroy(&private_data->mutex);

    // Release properties
    indigo_release_property(private_data->device_info_property);
    indigo_release_property(private_data->sensors_property);
    indigo_release_property(private_data->clouds_property);
    indigo_release_property(private_data->skyquality_property);
    indigo_release_property(private_data->gps_property);
    indigo_release_property(private_data->weather_property);
    indigo_release_property(private_data->thresholds_property);

    INDIGO_DEVICE_DETACH_LOG(DRIVER_NAME, device->name);
    return indigo_aux_detach(device);
}

// ----------------------------------------------------------------------------
// Driver entry point
// ----------------------------------------------------------------------------

indigo_result indigo_aux_uranus(indigo_driver_action action, indigo_driver_info *info) {
    static indigo_driver_action last_action = INDIGO_DRIVER_SHUTDOWN;

    SET_DRIVER_INFO(info, AUX_URANUS_NAME, __FUNCTION__, DRIVER_VERSION, false, last_action);

    if (action == last_action)
        return INDIGO_OK;

    switch (action) {
        case INDIGO_DRIVER_INIT:
            last_action = action;

            uranus_private_data *private_data = indigo_safe_malloc(sizeof(uranus_private_data));
            memset(private_data, 0, sizeof(uranus_private_data));

            uranus_device = indigo_safe_malloc_copy(sizeof(indigo_device), &(indigo_device){
                .name = AUX_URANUS_NAME,
                .driver_info = info,
                .private_data = private_data,
                .attach = uranus_attach,
                .enumerate_properties = uranus_enumerate_properties,
                .change_property = uranus_change_property,
                .detach = uranus_detach
            });

            indigo_attach_device(uranus_device);
            break;

        case INDIGO_DRIVER_SHUTDOWN:
            VERIFY_NOT_CONNECTED(uranus_device);
            last_action = action;

            if (uranus_device != NULL) {
                indigo_detach_device(uranus_device);
                free(uranus_device->private_data);
                free(uranus_device);
                uranus_device = NULL;
            }
            break;

        case INDIGO_DRIVER_INFO:
            break;
    }

    return INDIGO_OK;
}
