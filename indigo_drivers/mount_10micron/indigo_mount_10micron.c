// Copyright (c) 2024 Observatory AI Project
// All rights reserved.
//
// INDIGO 10Micron Mount driver
//
// Based on the INDI lx200_10micron driver and INDIGO driver patterns.
// Implements extended LX200 protocol over TCP (ports 3490/3492).
//
// Supported features:
// - Standard LX200: slew, sync, park, track, motion control
// - Ultra-precision mode
// - Product information and firmware details
// - Alignment model building and management
// - Refraction model (temperature/pressure)
// - Unattended meridian flip
// - Satellite tracking (firmware 2.13.20+)

#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <math.h>
#include <pthread.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <errno.h>
#include <fcntl.h>

#include <indigo/indigo_driver_xml.h>
#include <indigo/indigo_io.h>
#include <indigo/indigo_mount_driver.h>

#include "indigo_mount_10micron.h"

// ----------------------------------------------------------------------------
// Driver version
// ----------------------------------------------------------------------------

#define DRIVER_VERSION         0x0001
#define DRIVER_NAME            "indigo_mount_10micron"

// ----------------------------------------------------------------------------
// Private data structure
// ----------------------------------------------------------------------------

typedef struct {
    int handle;                          // TCP socket handle
    bool connected;
    pthread_mutex_t mutex;

    // Product info
    tm_product_info_t product_info;

    // Current mount state
    tm_mount_info_t mount_info;
    tm_mount_status_t status;
    bool tracking;
    bool parked;
    bool slewing;
    bool unattended_flip;

    // Refraction model
    double refraction_temp;
    double refraction_pressure;

    // Alignment model
    int alignment_star_count;
    int model_count;

    // Timing
    indigo_timer *position_timer;
    double poll_interval;

    // Custom properties
    indigo_property *product_info_property;
    indigo_property *firmware_info_property;
    indigo_property *refraction_property;
    indigo_property *alignment_info_property;
    indigo_property *alignment_action_property;
    indigo_property *unattended_flip_property;
    indigo_property *sync_mode_property;
    indigo_property *satellite_tle_property;
    indigo_property *satellite_action_property;

} tm_private_data;

// Private data accessor
#define PRIVATE_DATA ((tm_private_data *)device->private_data)

// ----------------------------------------------------------------------------
// Device declaration
// ----------------------------------------------------------------------------

static indigo_device *tm_device = NULL;

// ----------------------------------------------------------------------------
// TCP communication
// ----------------------------------------------------------------------------

static bool tm_open(indigo_device *device, const char *host, int port) {
    tm_private_data *private_data = PRIVATE_DATA;

    struct hostent *server = gethostbyname(host);
    if (server == NULL) {
        INDIGO_DRIVER_ERROR(DRIVER_NAME, "Failed to resolve hostname: %s", host);
        return false;
    }

    private_data->handle = socket(AF_INET, SOCK_STREAM, 0);
    if (private_data->handle < 0) {
        INDIGO_DRIVER_ERROR(DRIVER_NAME, "Failed to create socket");
        return false;
    }

    struct sockaddr_in serv_addr;
    memset(&serv_addr, 0, sizeof(serv_addr));
    serv_addr.sin_family = AF_INET;
    memcpy(&serv_addr.sin_addr.s_addr, server->h_addr, server->h_length);
    serv_addr.sin_port = htons(port);

    // Set socket timeout
    struct timeval tv;
    tv.tv_sec = TM_COMMAND_TIMEOUT;
    tv.tv_usec = 0;
    setsockopt(private_data->handle, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(private_data->handle, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    if (connect(private_data->handle, (struct sockaddr *)&serv_addr, sizeof(serv_addr)) < 0) {
        INDIGO_DRIVER_ERROR(DRIVER_NAME, "Failed to connect to %s:%d", host, port);
        close(private_data->handle);
        private_data->handle = -1;
        return false;
    }

    INDIGO_DRIVER_DEBUG(DRIVER_NAME, "Connected to %s:%d", host, port);
    return true;
}

static void tm_close(indigo_device *device) {
    tm_private_data *private_data = PRIVATE_DATA;

    if (private_data->handle >= 0) {
        close(private_data->handle);
        private_data->handle = -1;
    }
}

// Send command and receive response
static bool tm_command(indigo_device *device, const char *command, char *response, int response_len) {
    tm_private_data *private_data = PRIVATE_DATA;

    pthread_mutex_lock(&private_data->mutex);

    // Send command
    int cmd_len = strlen(command);
    if (send(private_data->handle, command, cmd_len, 0) != cmd_len) {
        INDIGO_DRIVER_ERROR(DRIVER_NAME, "Failed to send command: %s", command);
        pthread_mutex_unlock(&private_data->mutex);
        return false;
    }

    // Read response if requested
    if (response && response_len > 0) {
        memset(response, 0, response_len);
        int total = 0;

        while (total < response_len - 1) {
            char c;
            int n = recv(private_data->handle, &c, 1, 0);
            if (n <= 0) {
                break;
            }
            if (c == '#') {
                // End of LX200 response
                break;
            }
            response[total++] = c;
        }
        response[total] = '\0';

        INDIGO_DRIVER_DEBUG(DRIVER_NAME, "Command '%s' -> '%s'", command, response);
    }

    pthread_mutex_unlock(&private_data->mutex);
    return true;
}

// Send command, no response expected
static bool tm_command_blind(indigo_device *device, const char *command) {
    return tm_command(device, command, NULL, 0);
}

// ----------------------------------------------------------------------------
// Coordinate parsing helpers
// ----------------------------------------------------------------------------

// Parse RA from HH:MM:SS.ss format to hours
static double tm_parse_ra(const char *str) {
    int h, m;
    double s;
    if (sscanf(str, "%d:%d:%lf", &h, &m, &s) == 3) {
        return h + m / 60.0 + s / 3600.0;
    }
    return 0;
}

// Parse Dec from sDD*MM:SS.s format to degrees
static double tm_parse_dec(const char *str) {
    int d, m;
    double s;
    char sign = '+';

    if (str[0] == '+' || str[0] == '-') {
        sign = str[0];
        str++;
    }

    // Handle both * and : as degree separator
    if (sscanf(str, "%d*%d:%lf", &d, &m, &s) == 3 ||
        sscanf(str, "%d:%d:%lf", &d, &m, &s) == 3) {
        double dec = d + m / 60.0 + s / 3600.0;
        return (sign == '-') ? -dec : dec;
    }
    return 0;
}

// Format RA for LX200 command
static void tm_format_ra(double ra, char *buf, size_t len) {
    int h = (int)ra;
    int m = (int)((ra - h) * 60);
    double s = ((ra - h) * 60 - m) * 60;
    snprintf(buf, len, "%02d:%02d:%05.2f", h, m, s);
}

// Format Dec for LX200 command
static void tm_format_dec(double dec, char *buf, size_t len) {
    char sign = (dec >= 0) ? '+' : '-';
    dec = fabs(dec);
    int d = (int)dec;
    int m = (int)((dec - d) * 60);
    double s = ((dec - d) * 60 - m) * 60;
    snprintf(buf, len, "%c%02d*%02d:%04.1f", sign, d, m, s);
}

// ----------------------------------------------------------------------------
// Mount initialization and status
// ----------------------------------------------------------------------------

static bool tm_enable_ultra_precision(indigo_device *device) {
    return tm_command_blind(device, TM_CMD_ULTRA_PRECISION);
}

static bool tm_get_product_info(indigo_device *device) {
    tm_private_data *private_data = PRIVATE_DATA;
    char response[128];

    if (tm_command(device, TM_CMD_GET_PRODUCT_NAME, response, sizeof(response))) {
        strncpy(private_data->product_info.product_name, response, sizeof(private_data->product_info.product_name) - 1);
    }

    if (tm_command(device, TM_CMD_GET_CONTROL_BOX, response, sizeof(response))) {
        strncpy(private_data->product_info.control_box, response, sizeof(private_data->product_info.control_box) - 1);
    }

    if (tm_command(device, TM_CMD_GET_FIRMWARE_VERSION, response, sizeof(response))) {
        strncpy(private_data->product_info.firmware_version, response, sizeof(private_data->product_info.firmware_version) - 1);
    }

    if (tm_command(device, TM_CMD_GET_FIRMWARE_DATE, response, sizeof(response))) {
        strncpy(private_data->product_info.firmware_date, response, sizeof(private_data->product_info.firmware_date) - 1);
    }

    return true;
}

static bool tm_get_mount_info(indigo_device *device) {
    tm_private_data *private_data = PRIVATE_DATA;
    char response[256];

    if (!tm_command(device, TM_CMD_GET_INFO, response, sizeof(response))) {
        return false;
    }

    // Parse :Ginfo# response: RA,DEC,Side,Az,Alt,JD,Status,SlewStatus
    double ra, dec, az, alt, jd;
    char side;
    int status, slew_status;

    if (sscanf(response, "%lf,%lf,%c,%lf,%lf,%lf,%d,%d",
               &ra, &dec, &side, &az, &alt, &jd, &status, &slew_status) == 8) {
        private_data->mount_info.ra = ra;
        private_data->mount_info.dec = dec;
        private_data->mount_info.pier_side = side;
        private_data->mount_info.az = az;
        private_data->mount_info.alt = alt;
        private_data->mount_info.julian_date = jd;
        private_data->mount_info.status = status;
        private_data->mount_info.slew_status = slew_status;

        private_data->status = (tm_mount_status_t)status;
        private_data->slewing = (slew_status != 0) ||
                                (status >= TM_STATUS_SLEWING_SLOWEST && status <= TM_STATUS_SLEWING_FASTEST) ||
                                (status == TM_STATUS_SLEWING_PARK || status == TM_STATUS_SLEWING_HOME);
        private_data->tracking = (status == TM_STATUS_TRACKING || status == TM_STATUS_TRACKING_SATELLITE);
        private_data->parked = (status == TM_STATUS_PARK);

        return true;
    }

    return false;
}

static bool tm_get_coordinates(indigo_device *device, double *ra, double *dec) {
    char response[64];

    if (tm_command(device, TM_CMD_GET_RA, response, sizeof(response))) {
        *ra = tm_parse_ra(response);
    } else {
        return false;
    }

    if (tm_command(device, TM_CMD_GET_DEC, response, sizeof(response))) {
        *dec = tm_parse_dec(response);
    } else {
        return false;
    }

    return true;
}

static bool tm_get_refraction(indigo_device *device) {
    tm_private_data *private_data = PRIVATE_DATA;
    char response[32];

    if (tm_command(device, TM_CMD_GET_REFRACTION_TEMP, response, sizeof(response))) {
        private_data->refraction_temp = atof(response);
    }

    if (tm_command(device, TM_CMD_GET_REFRACTION_PRESSURE, response, sizeof(response))) {
        private_data->refraction_pressure = atof(response);
    }

    return true;
}

static bool tm_set_refraction_temp(indigo_device *device, double temp) {
    char cmd[32];
    char sign = (temp >= 0) ? '+' : '-';
    snprintf(cmd, sizeof(cmd), "%s%c%.1f#", TM_CMD_SET_REFRACTION_TEMP, sign, fabs(temp));
    return tm_command_blind(device, cmd);
}

static bool tm_set_refraction_pressure(indigo_device *device, double pressure) {
    char cmd[32];
    snprintf(cmd, sizeof(cmd), "%s%.1f#", TM_CMD_SET_REFRACTION_PRESSURE, pressure);
    return tm_command_blind(device, cmd);
}

static bool tm_get_alignment_info(indigo_device *device) {
    tm_private_data *private_data = PRIVATE_DATA;
    char response[32];

    if (tm_command(device, TM_CMD_GET_ALIGN_STAR_COUNT, response, sizeof(response))) {
        private_data->alignment_star_count = atoi(response);
    }

    if (tm_command(device, TM_CMD_GET_MODEL_COUNT, response, sizeof(response))) {
        private_data->model_count = atoi(response);
    }

    return true;
}

static bool tm_get_unattended_flip(indigo_device *device) {
    tm_private_data *private_data = PRIVATE_DATA;
    char response[16];

    if (tm_command(device, TM_CMD_GET_UNATTENDED_FLIP, response, sizeof(response))) {
        private_data->unattended_flip = (response[0] == '1');
        return true;
    }
    return false;
}

// ----------------------------------------------------------------------------
// Motion control
// ----------------------------------------------------------------------------

static bool tm_slew_to(indigo_device *device, double ra, double dec) {
    char ra_str[32], dec_str[32], cmd[64];

    // Set target RA
    tm_format_ra(ra, ra_str, sizeof(ra_str));
    snprintf(cmd, sizeof(cmd), "%s%s#", TM_CMD_SET_RA, ra_str);
    if (!tm_command_blind(device, cmd)) return false;

    // Set target Dec
    tm_format_dec(dec, dec_str, sizeof(dec_str));
    snprintf(cmd, sizeof(cmd), "%s%s#", TM_CMD_SET_DEC, dec_str);
    if (!tm_command_blind(device, cmd)) return false;

    // Start slew
    char response[16];
    if (tm_command(device, TM_CMD_SLEW, response, sizeof(response))) {
        // 0 = slew possible, 1 = object below horizon, 2 = object below limit
        return (response[0] == '0');
    }

    return false;
}

static bool tm_sync_to(indigo_device *device, double ra, double dec) {
    char ra_str[32], dec_str[32], cmd[64];

    // Set target RA
    tm_format_ra(ra, ra_str, sizeof(ra_str));
    snprintf(cmd, sizeof(cmd), "%s%s#", TM_CMD_SET_RA, ra_str);
    if (!tm_command_blind(device, cmd)) return false;

    // Set target Dec
    tm_format_dec(dec, dec_str, sizeof(dec_str));
    snprintf(cmd, sizeof(cmd), "%s%s#", TM_CMD_SET_DEC, dec_str);
    if (!tm_command_blind(device, cmd)) return false;

    // Sync
    char response[64];
    return tm_command(device, TM_CMD_SYNC, response, sizeof(response));
}

static bool tm_abort(indigo_device *device) {
    return tm_command_blind(device, TM_CMD_ABORT);
}

static bool tm_park(indigo_device *device) {
    return tm_command_blind(device, TM_CMD_PARK);
}

static bool tm_unpark(indigo_device *device) {
    return tm_command_blind(device, TM_CMD_UNPARK);
}

static bool tm_set_tracking(indigo_device *device, bool on) {
    return tm_command_blind(device, on ? TM_CMD_TRACK_ON : TM_CMD_TRACK_OFF);
}

// ----------------------------------------------------------------------------
// Alignment model management
// ----------------------------------------------------------------------------

static bool tm_start_new_alignment(indigo_device *device) {
    char response[16];
    if (tm_command(device, TM_CMD_NEW_ALIGN_START, response, sizeof(response))) {
        return (response[0] == '1' || strchr(response, 'V') != NULL);
    }
    return false;
}

static bool tm_add_alignment_point(indigo_device *device,
                                   double mra, double mdec, char mside,
                                   double pra, double pdec, double sidtime) {
    char cmd[128];
    snprintf(cmd, sizeof(cmd), "%s%.6f,%.6f,%c,%.6f,%.6f,%.6f#",
             TM_CMD_NEW_ALIGN_POINT, mra, mdec, mside, pra, pdec, sidtime);

    char response[16];
    if (tm_command(device, cmd, response, sizeof(response))) {
        return (strchr(response, 'E') != NULL || response[0] == '1');
    }
    return false;
}

static bool tm_end_alignment(indigo_device *device) {
    char response[16];
    if (tm_command(device, TM_CMD_NEW_ALIGN_END, response, sizeof(response))) {
        return (strchr(response, 'V') != NULL || response[0] == '1');
    }
    return false;
}

static bool tm_delete_alignment(indigo_device *device) {
    char response[16];
    if (tm_command(device, TM_CMD_DELETE_ALIGN, response, sizeof(response))) {
        return (response[0] == '1');
    }
    return false;
}

// ----------------------------------------------------------------------------
// Update properties from mount state
// ----------------------------------------------------------------------------

static void tm_update_properties(indigo_device *device) {
    tm_private_data *private_data = PRIVATE_DATA;

    // Update equatorial coordinates
    MOUNT_EQUATORIAL_COORDINATES_RA_ITEM->number.value = private_data->mount_info.ra;
    MOUNT_EQUATORIAL_COORDINATES_DEC_ITEM->number.value = private_data->mount_info.dec;

    if (private_data->slewing) {
        MOUNT_EQUATORIAL_COORDINATES_PROPERTY->state = INDIGO_BUSY_STATE;
    } else {
        MOUNT_EQUATORIAL_COORDINATES_PROPERTY->state = INDIGO_OK_STATE;
    }
    indigo_update_property(device, MOUNT_EQUATORIAL_COORDINATES_PROPERTY, NULL);

    // Update horizontal coordinates if available
    if (MOUNT_HORIZONTAL_COORDINATES_PROPERTY) {
        MOUNT_HORIZONTAL_COORDINATES_ALT_ITEM->number.value = private_data->mount_info.alt;
        MOUNT_HORIZONTAL_COORDINATES_AZ_ITEM->number.value = private_data->mount_info.az;
        MOUNT_HORIZONTAL_COORDINATES_PROPERTY->state = INDIGO_OK_STATE;
        indigo_update_property(device, MOUNT_HORIZONTAL_COORDINATES_PROPERTY, NULL);
    }

    // Update tracking state
    MOUNT_TRACKING_ON_ITEM->sw.value = private_data->tracking;
    MOUNT_TRACKING_OFF_ITEM->sw.value = !private_data->tracking;
    MOUNT_TRACKING_PROPERTY->state = INDIGO_OK_STATE;
    indigo_update_property(device, MOUNT_TRACKING_PROPERTY, NULL);

    // Update park state
    MOUNT_PARK_PARKED_ITEM->sw.value = private_data->parked;
    MOUNT_PARK_UNPARKED_ITEM->sw.value = !private_data->parked;
    MOUNT_PARK_PROPERTY->state = private_data->parked ? INDIGO_OK_STATE : INDIGO_OK_STATE;
    indigo_update_property(device, MOUNT_PARK_PROPERTY, NULL);

    // Update pier side
    if (MOUNT_SIDE_OF_PIER_PROPERTY) {
        MOUNT_SIDE_OF_PIER_EAST_ITEM->sw.value = (private_data->mount_info.pier_side == 'E');
        MOUNT_SIDE_OF_PIER_WEST_ITEM->sw.value = (private_data->mount_info.pier_side == 'W');
        indigo_update_property(device, MOUNT_SIDE_OF_PIER_PROPERTY, NULL);
    }

    // Update refraction property
    if (private_data->refraction_property) {
        private_data->refraction_property->items[0].number.value = private_data->refraction_temp;
        private_data->refraction_property->items[1].number.value = private_data->refraction_pressure;
        indigo_update_property(device, private_data->refraction_property, NULL);
    }

    // Update alignment info
    if (private_data->alignment_info_property) {
        private_data->alignment_info_property->items[0].number.value = private_data->alignment_star_count;
        private_data->alignment_info_property->items[1].number.value = private_data->model_count;
        indigo_update_property(device, private_data->alignment_info_property, NULL);
    }

    // Update unattended flip
    if (private_data->unattended_flip_property) {
        private_data->unattended_flip_property->items[0].sw.value = private_data->unattended_flip;
        private_data->unattended_flip_property->items[1].sw.value = !private_data->unattended_flip;
        indigo_update_property(device, private_data->unattended_flip_property, NULL);
    }
}

// ----------------------------------------------------------------------------
// Timer callback for periodic status polling
// ----------------------------------------------------------------------------

static void tm_timer_callback(indigo_device *device) {
    tm_private_data *private_data = PRIVATE_DATA;

    if (!private_data->connected) {
        return;
    }

    // Read mount status
    tm_get_mount_info(device);
    tm_update_properties(device);

    // Reschedule timer
    indigo_reschedule_timer(device, private_data->poll_interval, &private_data->position_timer);
}

// ----------------------------------------------------------------------------
// Initialize custom properties
// ----------------------------------------------------------------------------

static void tm_init_properties(indigo_device *device) {
    tm_private_data *private_data = PRIVATE_DATA;

    // Product info property
    private_data->product_info_property = indigo_init_text_property(NULL, device->name,
        "PRODUCT_INFO", TM_GROUP_PRODUCT, "Product Info", INDIGO_OK_STATE, INDIGO_RO_PERM, 2);
    indigo_init_text_item(private_data->product_info_property->items + 0,
        "NAME", "Name", "");
    indigo_init_text_item(private_data->product_info_property->items + 1,
        "CONTROL_BOX", "Control Box", "");

    // Firmware info property
    private_data->firmware_info_property = indigo_init_text_property(NULL, device->name,
        "FIRMWARE_INFO", TM_GROUP_PRODUCT, "Firmware", INDIGO_OK_STATE, INDIGO_RO_PERM, 2);
    indigo_init_text_item(private_data->firmware_info_property->items + 0,
        "VERSION", "Version", "");
    indigo_init_text_item(private_data->firmware_info_property->items + 1,
        "DATE", "Date", "");

    // Refraction model property
    private_data->refraction_property = indigo_init_number_property(NULL, device->name,
        "REFRACTION_MODEL", TM_GROUP_REFRACTION, "Refraction Model", INDIGO_OK_STATE, INDIGO_RW_PERM, 2);
    indigo_init_number_item(private_data->refraction_property->items + 0,
        "TEMPERATURE", "Temperature (°C)", -40, 50, 0.1, 15);
    indigo_init_number_item(private_data->refraction_property->items + 1,
        "PRESSURE", "Pressure (hPa)", 500, 1100, 0.1, 1013);

    // Alignment info property
    private_data->alignment_info_property = indigo_init_number_property(NULL, device->name,
        "ALIGNMENT_INFO", TM_GROUP_ALIGNMENT, "Alignment Model", INDIGO_OK_STATE, INDIGO_RO_PERM, 2);
    indigo_init_number_item(private_data->alignment_info_property->items + 0,
        "STAR_COUNT", "Alignment Stars", 0, 100, 1, 0);
    indigo_init_number_item(private_data->alignment_info_property->items + 1,
        "MODEL_COUNT", "Saved Models", 0, 10, 1, 0);

    // Alignment action property
    private_data->alignment_action_property = indigo_init_switch_property(NULL, device->name,
        "ALIGNMENT_ACTION", TM_GROUP_ALIGNMENT, "Alignment Actions", INDIGO_OK_STATE, INDIGO_RW_PERM,
        INDIGO_ANY_OF_MANY_RULE, 3);
    indigo_init_switch_item(private_data->alignment_action_property->items + 0,
        "START_NEW", "Start New Alignment", false);
    indigo_init_switch_item(private_data->alignment_action_property->items + 1,
        "END", "End Alignment", false);
    indigo_init_switch_item(private_data->alignment_action_property->items + 2,
        "DELETE", "Delete Alignment", false);

    // Unattended flip property
    private_data->unattended_flip_property = indigo_init_switch_property(NULL, device->name,
        "UNATTENDED_FLIP", TM_GROUP_ADVANCED, "Unattended Flip", INDIGO_OK_STATE, INDIGO_RW_PERM,
        INDIGO_ONE_OF_MANY_RULE, 2);
    indigo_init_switch_item(private_data->unattended_flip_property->items + 0,
        "ENABLED", "Enabled", false);
    indigo_init_switch_item(private_data->unattended_flip_property->items + 1,
        "DISABLED", "Disabled", true);

    // Sync mode property
    private_data->sync_mode_property = indigo_init_switch_property(NULL, device->name,
        "SYNC_MODE", TM_GROUP_ALIGNMENT, "Sync Mode", INDIGO_OK_STATE, INDIGO_RW_PERM,
        INDIGO_ONE_OF_MANY_RULE, 2);
    indigo_init_switch_item(private_data->sync_mode_property->items + 0,
        "OFFSET", "Offset Only", true);
    indigo_init_switch_item(private_data->sync_mode_property->items + 1,
        "REFINE", "Refine Model", false);

    // Satellite TLE property
    private_data->satellite_tle_property = indigo_init_text_property(NULL, device->name,
        "SATELLITE_TLE", TM_GROUP_SATELLITE, "Satellite TLE", INDIGO_OK_STATE, INDIGO_RW_PERM, 3);
    indigo_init_text_item(private_data->satellite_tle_property->items + 0,
        "LINE0", "Name", "");
    indigo_init_text_item(private_data->satellite_tle_property->items + 1,
        "LINE1", "Line 1", "");
    indigo_init_text_item(private_data->satellite_tle_property->items + 2,
        "LINE2", "Line 2", "");

    // Satellite action property
    private_data->satellite_action_property = indigo_init_switch_property(NULL, device->name,
        "SATELLITE_ACTION", TM_GROUP_SATELLITE, "Satellite Tracking", INDIGO_OK_STATE, INDIGO_RW_PERM,
        INDIGO_ANY_OF_MANY_RULE, 2);
    indigo_init_switch_item(private_data->satellite_action_property->items + 0,
        "LOAD_TLE", "Load TLE", false);
    indigo_init_switch_item(private_data->satellite_action_property->items + 1,
        "TRACK", "Track Satellite", false);
}

// ----------------------------------------------------------------------------
// Device attach callback
// ----------------------------------------------------------------------------

static indigo_result tm_attach(indigo_device *device) {
    assert(device != NULL);
    assert(PRIVATE_DATA != NULL);

    if (indigo_mount_attach(device, DRIVER_NAME, DRIVER_VERSION) == INDIGO_OK) {
        tm_private_data *private_data = PRIVATE_DATA;

        pthread_mutex_init(&private_data->mutex, NULL);
        private_data->handle = -1;
        private_data->connected = false;
        private_data->poll_interval = TM_POLL_INTERVAL;

        // Initialize mount-specific properties
        tm_init_properties(device);

        // Set device interface
        DEVICE_PORT_PROPERTY->hidden = false;
        DEVICE_PORTS_PROPERTY->hidden = false;

        // Set default port to TCP
        strncpy(DEVICE_PORT_ITEM->text.value, "tcp://192.168.1.103:3490", INDIGO_VALUE_SIZE);

        INDIGO_DEVICE_ATTACH_LOG(DRIVER_NAME, device->name);
        return indigo_mount_enumerate_properties(device, NULL, NULL);
    }
    return INDIGO_FAILED;
}

// ----------------------------------------------------------------------------
// Enumerate properties callback
// ----------------------------------------------------------------------------

static indigo_result tm_enumerate_properties(indigo_device *device, indigo_client *client, indigo_property *property) {
    if (IS_CONNECTED) {
        tm_private_data *private_data = PRIVATE_DATA;

        if (indigo_property_match(private_data->product_info_property, property))
            indigo_define_property(device, private_data->product_info_property, NULL);
        if (indigo_property_match(private_data->firmware_info_property, property))
            indigo_define_property(device, private_data->firmware_info_property, NULL);
        if (indigo_property_match(private_data->refraction_property, property))
            indigo_define_property(device, private_data->refraction_property, NULL);
        if (indigo_property_match(private_data->alignment_info_property, property))
            indigo_define_property(device, private_data->alignment_info_property, NULL);
        if (indigo_property_match(private_data->alignment_action_property, property))
            indigo_define_property(device, private_data->alignment_action_property, NULL);
        if (indigo_property_match(private_data->unattended_flip_property, property))
            indigo_define_property(device, private_data->unattended_flip_property, NULL);
        if (indigo_property_match(private_data->sync_mode_property, property))
            indigo_define_property(device, private_data->sync_mode_property, NULL);
        if (indigo_property_match(private_data->satellite_tle_property, property))
            indigo_define_property(device, private_data->satellite_tle_property, NULL);
        if (indigo_property_match(private_data->satellite_action_property, property))
            indigo_define_property(device, private_data->satellite_action_property, NULL);
    }

    return indigo_mount_enumerate_properties(device, client, property);
}

// ----------------------------------------------------------------------------
// Change property callback
// ----------------------------------------------------------------------------

static indigo_result tm_change_property(indigo_device *device, indigo_client *client, indigo_property *property) {
    assert(device != NULL);
    assert(DEVICE_CONTEXT != NULL);
    assert(property != NULL);

    tm_private_data *private_data = PRIVATE_DATA;

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
            // Parse TCP address from port string
            char *port_str = DEVICE_PORT_ITEM->text.value;
            char host[256] = "192.168.1.103";
            int port = TM_DEFAULT_PORT;

            if (strncmp(port_str, "tcp://", 6) == 0) {
                port_str += 6;
            }

            char *colon = strchr(port_str, ':');
            if (colon) {
                strncpy(host, port_str, colon - port_str);
                host[colon - port_str] = '\0';
                port = atoi(colon + 1);
            } else {
                strncpy(host, port_str, sizeof(host) - 1);
            }

            // Connect
            if (tm_open(device, host, port)) {
                // Enable ultra-precision mode
                tm_enable_ultra_precision(device);

                // Get product info
                tm_get_product_info(device);

                // Update product info properties
                strncpy(private_data->product_info_property->items[0].text.value,
                        private_data->product_info.product_name, INDIGO_VALUE_SIZE);
                strncpy(private_data->product_info_property->items[1].text.value,
                        private_data->product_info.control_box, INDIGO_VALUE_SIZE);
                strncpy(private_data->firmware_info_property->items[0].text.value,
                        private_data->product_info.firmware_version, INDIGO_VALUE_SIZE);
                strncpy(private_data->firmware_info_property->items[1].text.value,
                        private_data->product_info.firmware_date, INDIGO_VALUE_SIZE);

                // Get initial state
                tm_get_mount_info(device);
                tm_get_refraction(device);
                tm_get_alignment_info(device);
                tm_get_unattended_flip(device);

                private_data->connected = true;
                CONNECTION_PROPERTY->state = INDIGO_OK_STATE;

                // Define custom properties
                indigo_define_property(device, private_data->product_info_property, NULL);
                indigo_define_property(device, private_data->firmware_info_property, NULL);
                indigo_define_property(device, private_data->refraction_property, NULL);
                indigo_define_property(device, private_data->alignment_info_property, NULL);
                indigo_define_property(device, private_data->alignment_action_property, NULL);
                indigo_define_property(device, private_data->unattended_flip_property, NULL);
                indigo_define_property(device, private_data->sync_mode_property, NULL);
                indigo_define_property(device, private_data->satellite_tle_property, NULL);
                indigo_define_property(device, private_data->satellite_action_property, NULL);

                // Start status timer
                indigo_set_timer(device, 0, tm_timer_callback, &private_data->position_timer);

                indigo_update_property(device, CONNECTION_PROPERTY,
                                       "Connected to %s", private_data->product_info.product_name);
            } else {
                CONNECTION_PROPERTY->state = INDIGO_ALERT_STATE;
                indigo_update_property(device, CONNECTION_PROPERTY, "Failed to connect");
            }
        } else {
            // Disconnect
            if (private_data->position_timer) {
                indigo_cancel_timer(device, &private_data->position_timer);
            }

            indigo_delete_property(device, private_data->product_info_property, NULL);
            indigo_delete_property(device, private_data->firmware_info_property, NULL);
            indigo_delete_property(device, private_data->refraction_property, NULL);
            indigo_delete_property(device, private_data->alignment_info_property, NULL);
            indigo_delete_property(device, private_data->alignment_action_property, NULL);
            indigo_delete_property(device, private_data->unattended_flip_property, NULL);
            indigo_delete_property(device, private_data->sync_mode_property, NULL);
            indigo_delete_property(device, private_data->satellite_tle_property, NULL);
            indigo_delete_property(device, private_data->satellite_action_property, NULL);

            tm_close(device);
            private_data->connected = false;
            CONNECTION_PROPERTY->state = INDIGO_OK_STATE;
        }

        indigo_update_property(device, CONNECTION_PROPERTY, NULL);
        return INDIGO_OK;
    }

    // -------------------------------------------------------------------------
    // Equatorial coordinates (slew/sync)
    // -------------------------------------------------------------------------
    if (indigo_property_match(MOUNT_EQUATORIAL_COORDINATES_PROPERTY, property)) {
        indigo_property_copy_values(MOUNT_EQUATORIAL_COORDINATES_PROPERTY, property, false);

        double ra = MOUNT_EQUATORIAL_COORDINATES_RA_ITEM->number.value;
        double dec = MOUNT_EQUATORIAL_COORDINATES_DEC_ITEM->number.value;

        if (MOUNT_ON_COORDINATES_SET_SYNC_ITEM->sw.value) {
            // Sync
            if (tm_sync_to(device, ra, dec)) {
                MOUNT_EQUATORIAL_COORDINATES_PROPERTY->state = INDIGO_OK_STATE;
            } else {
                MOUNT_EQUATORIAL_COORDINATES_PROPERTY->state = INDIGO_ALERT_STATE;
            }
        } else {
            // Slew
            if (tm_slew_to(device, ra, dec)) {
                MOUNT_EQUATORIAL_COORDINATES_PROPERTY->state = INDIGO_BUSY_STATE;
            } else {
                MOUNT_EQUATORIAL_COORDINATES_PROPERTY->state = INDIGO_ALERT_STATE;
            }
        }

        indigo_update_property(device, MOUNT_EQUATORIAL_COORDINATES_PROPERTY, NULL);
        return INDIGO_OK;
    }

    // -------------------------------------------------------------------------
    // Abort motion
    // -------------------------------------------------------------------------
    if (indigo_property_match(MOUNT_ABORT_MOTION_PROPERTY, property)) {
        indigo_property_copy_values(MOUNT_ABORT_MOTION_PROPERTY, property, false);

        if (MOUNT_ABORT_MOTION_ITEM->sw.value) {
            tm_abort(device);
            MOUNT_ABORT_MOTION_ITEM->sw.value = false;
            MOUNT_ABORT_MOTION_PROPERTY->state = INDIGO_OK_STATE;
        }

        indigo_update_property(device, MOUNT_ABORT_MOTION_PROPERTY, NULL);
        return INDIGO_OK;
    }

    // -------------------------------------------------------------------------
    // Tracking
    // -------------------------------------------------------------------------
    if (indigo_property_match(MOUNT_TRACKING_PROPERTY, property)) {
        indigo_property_copy_values(MOUNT_TRACKING_PROPERTY, property, false);

        bool tracking = MOUNT_TRACKING_ON_ITEM->sw.value;
        if (tm_set_tracking(device, tracking)) {
            MOUNT_TRACKING_PROPERTY->state = INDIGO_OK_STATE;
        } else {
            MOUNT_TRACKING_PROPERTY->state = INDIGO_ALERT_STATE;
        }

        indigo_update_property(device, MOUNT_TRACKING_PROPERTY, NULL);
        return INDIGO_OK;
    }

    // -------------------------------------------------------------------------
    // Park
    // -------------------------------------------------------------------------
    if (indigo_property_match(MOUNT_PARK_PROPERTY, property)) {
        indigo_property_copy_values(MOUNT_PARK_PROPERTY, property, false);

        if (MOUNT_PARK_PARKED_ITEM->sw.value) {
            if (tm_park(device)) {
                MOUNT_PARK_PROPERTY->state = INDIGO_BUSY_STATE;
            } else {
                MOUNT_PARK_PROPERTY->state = INDIGO_ALERT_STATE;
            }
        } else {
            if (tm_unpark(device)) {
                MOUNT_PARK_PROPERTY->state = INDIGO_OK_STATE;
            } else {
                MOUNT_PARK_PROPERTY->state = INDIGO_ALERT_STATE;
            }
        }

        indigo_update_property(device, MOUNT_PARK_PROPERTY, NULL);
        return INDIGO_OK;
    }

    // -------------------------------------------------------------------------
    // Refraction model
    // -------------------------------------------------------------------------
    if (indigo_property_match(private_data->refraction_property, property)) {
        indigo_property_copy_values(private_data->refraction_property, property, false);

        double temp = private_data->refraction_property->items[0].number.value;
        double pressure = private_data->refraction_property->items[1].number.value;

        tm_set_refraction_temp(device, temp);
        tm_set_refraction_pressure(device, pressure);
        tm_get_refraction(device);

        private_data->refraction_property->state = INDIGO_OK_STATE;
        indigo_update_property(device, private_data->refraction_property, NULL);
        return INDIGO_OK;
    }

    // -------------------------------------------------------------------------
    // Alignment actions
    // -------------------------------------------------------------------------
    if (indigo_property_match(private_data->alignment_action_property, property)) {
        indigo_property_copy_values(private_data->alignment_action_property, property, false);

        if (private_data->alignment_action_property->items[0].sw.value) {
            // Start new alignment
            if (tm_start_new_alignment(device)) {
                private_data->alignment_action_property->state = INDIGO_OK_STATE;
                indigo_update_property(device, private_data->alignment_action_property, "New alignment started");
            } else {
                private_data->alignment_action_property->state = INDIGO_ALERT_STATE;
            }
        } else if (private_data->alignment_action_property->items[1].sw.value) {
            // End alignment
            if (tm_end_alignment(device)) {
                tm_get_alignment_info(device);
                private_data->alignment_action_property->state = INDIGO_OK_STATE;
                indigo_update_property(device, private_data->alignment_action_property, "Alignment completed");
            } else {
                private_data->alignment_action_property->state = INDIGO_ALERT_STATE;
            }
        } else if (private_data->alignment_action_property->items[2].sw.value) {
            // Delete alignment
            if (tm_delete_alignment(device)) {
                tm_get_alignment_info(device);
                private_data->alignment_action_property->state = INDIGO_OK_STATE;
                indigo_update_property(device, private_data->alignment_action_property, "Alignment deleted");
            } else {
                private_data->alignment_action_property->state = INDIGO_ALERT_STATE;
            }
        }

        // Reset switches
        private_data->alignment_action_property->items[0].sw.value = false;
        private_data->alignment_action_property->items[1].sw.value = false;
        private_data->alignment_action_property->items[2].sw.value = false;

        indigo_update_property(device, private_data->alignment_action_property, NULL);
        return INDIGO_OK;
    }

    // -------------------------------------------------------------------------
    // Unattended flip
    // -------------------------------------------------------------------------
    if (indigo_property_match(private_data->unattended_flip_property, property)) {
        indigo_property_copy_values(private_data->unattended_flip_property, property, false);

        bool enabled = private_data->unattended_flip_property->items[0].sw.value;
        tm_command_blind(device, enabled ? TM_CMD_SET_UNATTENDED_FLIP_ON : TM_CMD_SET_UNATTENDED_FLIP_OFF);
        tm_get_unattended_flip(device);

        private_data->unattended_flip_property->state = INDIGO_OK_STATE;
        indigo_update_property(device, private_data->unattended_flip_property, NULL);
        return INDIGO_OK;
    }

    // -------------------------------------------------------------------------
    // Sync mode
    // -------------------------------------------------------------------------
    if (indigo_property_match(private_data->sync_mode_property, property)) {
        indigo_property_copy_values(private_data->sync_mode_property, property, false);

        if (private_data->sync_mode_property->items[0].sw.value) {
            tm_command_blind(device, TM_CMD_SYNC_MODE_OFFSET);
        } else {
            tm_command_blind(device, TM_CMD_SYNC_MODE_REFINE);
        }

        private_data->sync_mode_property->state = INDIGO_OK_STATE;
        indigo_update_property(device, private_data->sync_mode_property, NULL);
        return INDIGO_OK;
    }

    return indigo_mount_change_property(device, client, property);
}

// ----------------------------------------------------------------------------
// Device detach callback
// ----------------------------------------------------------------------------

static indigo_result tm_detach(indigo_device *device) {
    assert(device != NULL);

    tm_private_data *private_data = PRIVATE_DATA;

    if (private_data->position_timer) {
        indigo_cancel_timer(device, &private_data->position_timer);
    }

    if (private_data->connected) {
        tm_close(device);
    }

    pthread_mutex_destroy(&private_data->mutex);

    // Release properties
    indigo_release_property(private_data->product_info_property);
    indigo_release_property(private_data->firmware_info_property);
    indigo_release_property(private_data->refraction_property);
    indigo_release_property(private_data->alignment_info_property);
    indigo_release_property(private_data->alignment_action_property);
    indigo_release_property(private_data->unattended_flip_property);
    indigo_release_property(private_data->sync_mode_property);
    indigo_release_property(private_data->satellite_tle_property);
    indigo_release_property(private_data->satellite_action_property);

    INDIGO_DEVICE_DETACH_LOG(DRIVER_NAME, device->name);
    return indigo_mount_detach(device);
}

// ----------------------------------------------------------------------------
// Driver entry point
// ----------------------------------------------------------------------------

indigo_result indigo_mount_10micron(indigo_driver_action action, indigo_driver_info *info) {
    static indigo_driver_action last_action = INDIGO_DRIVER_SHUTDOWN;

    SET_DRIVER_INFO(info, MOUNT_10MICRON_NAME, __FUNCTION__, DRIVER_VERSION, false, last_action);

    if (action == last_action)
        return INDIGO_OK;

    switch (action) {
        case INDIGO_DRIVER_INIT:
            last_action = action;

            tm_private_data *private_data = indigo_safe_malloc(sizeof(tm_private_data));
            memset(private_data, 0, sizeof(tm_private_data));

            tm_device = indigo_safe_malloc_copy(sizeof(indigo_device), &(indigo_device){
                .name = MOUNT_10MICRON_NAME,
                .driver_info = info,
                .private_data = private_data,
                .attach = tm_attach,
                .enumerate_properties = tm_enumerate_properties,
                .change_property = tm_change_property,
                .detach = tm_detach
            });

            indigo_attach_device(tm_device);
            break;

        case INDIGO_DRIVER_SHUTDOWN:
            VERIFY_NOT_CONNECTED(tm_device);
            last_action = action;

            if (tm_device != NULL) {
                indigo_detach_device(tm_device);
                free(tm_device->private_data);
                free(tm_device);
                tm_device = NULL;
            }
            break;

        case INDIGO_DRIVER_INFO:
            break;
    }

    return INDIGO_OK;
}
