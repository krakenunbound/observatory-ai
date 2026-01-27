// Copyright (c) 2024 Observatory AI Project
// All rights reserved.
//
// INDIGO 10Micron Mount driver
//
// Supports: GM1000HPS, GM2000QCI, GM2000HPS, GM3000HPS, GM4000QCI, GM4000HPS, AZ2000
//
// This driver implements the extended LX200 protocol used by 10Micron mounts,
// including features not available in generic LX200 drivers:
// - Ultra-precision mode
// - Alignment model building and management
// - Refraction model control
// - Unattended meridian flip
// - Satellite tracking (firmware 2.13.20+)
// - Extended status information

#ifndef indigo_mount_10micron_h
#define indigo_mount_10micron_h

#include <indigo/indigo_driver.h>
#include <indigo/indigo_mount_driver.h>

#ifdef __cplusplus
extern "C" {
#endif

// ----------------------------------------------------------------------------
// Driver info
// ----------------------------------------------------------------------------

#define MOUNT_10MICRON_NAME              "10Micron Mount"
#define MOUNT_10MICRON_DRIVER_NAME       "indigo_mount_10micron"
#define MOUNT_10MICRON_DRIVER_VERSION    0x0001

// ----------------------------------------------------------------------------
// Connection settings
// ----------------------------------------------------------------------------

#define TM_DEFAULT_PORT                  3490    // TCP port (also 3492 works)
#define TM_COMMAND_TIMEOUT               5       // seconds
#define TM_POLL_INTERVAL                 1.0     // seconds between status polls

// ----------------------------------------------------------------------------
// LX200 Standard Commands
// ----------------------------------------------------------------------------

// Get coordinates
#define TM_CMD_GET_RA                    ":GR#"      // Get RA (HH:MM:SS.ss)
#define TM_CMD_GET_DEC                   ":GD#"      // Get Dec (sDD*MM:SS.s)
#define TM_CMD_GET_ALT                   ":GA#"      // Get Altitude
#define TM_CMD_GET_AZ                    ":GZ#"      // Get Azimuth
#define TM_CMD_GET_SIDEREAL_TIME         ":GS#"      // Get sidereal time (HH:MM:SS)

// Set target coordinates
#define TM_CMD_SET_RA                    ":Sr"       // Set target RA (append HH:MM:SS#)
#define TM_CMD_SET_DEC                   ":Sd"       // Set target Dec (append sDD*MM:SS#)

// Motion control
#define TM_CMD_SLEW                      ":MS#"      // Slew to target
#define TM_CMD_ABORT                     ":Q#"       // Abort motion
#define TM_CMD_SYNC                      ":CM#"      // Sync to target

// Movement
#define TM_CMD_MOVE_NORTH                ":Mn#"      // Start moving north
#define TM_CMD_MOVE_SOUTH                ":Ms#"      // Start moving south
#define TM_CMD_MOVE_EAST                 ":Me#"      // Start moving east
#define TM_CMD_MOVE_WEST                 ":Mw#"      // Start moving west
#define TM_CMD_STOP_NORTH                ":Qn#"      // Stop moving north
#define TM_CMD_STOP_SOUTH                ":Qs#"      // Stop moving south
#define TM_CMD_STOP_EAST                 ":Qe#"      // Stop moving east
#define TM_CMD_STOP_WEST                 ":Qw#"      // Stop moving west

// Slew rates
#define TM_CMD_SLEW_RATE_GUIDE           ":RG#"      // Guide rate
#define TM_CMD_SLEW_RATE_CENTER          ":RC#"      // Centering rate
#define TM_CMD_SLEW_RATE_FIND            ":RM#"      // Find rate
#define TM_CMD_SLEW_RATE_MAX             ":RS#"      // Maximum rate

// ----------------------------------------------------------------------------
// 10Micron Specific Commands
// ----------------------------------------------------------------------------

// Ultra-precision mode (extra decimal digits in coordinates)
#define TM_CMD_ULTRA_PRECISION           ":U2#"

// Product information
#define TM_CMD_GET_PRODUCT_NAME          ":GVP#"     // Product name
#define TM_CMD_GET_CONTROL_BOX           ":GVZ#"     // Control box info
#define TM_CMD_GET_FIRMWARE_VERSION      ":GVN#"     // Firmware version
#define TM_CMD_GET_FIRMWARE_DATE         ":GVD#"     // Firmware date
#define TM_CMD_GET_FIRMWARE_TIME         ":GVT#"     // Firmware time

// Comprehensive status
#define TM_CMD_GET_INFO                  ":Ginfo#"   // RA,Dec,Side,Az,Alt,JD,Status,SlewStatus
#define TM_CMD_GET_STATUS                ":Gstat#"   // Mount status code

// Park/Unpark
#define TM_CMD_PARK                      ":KA#"      // Park mount
#define TM_CMD_UNPARK                    ":PO#"      // Unpark mount

// Tracking
#define TM_CMD_TRACK_ON                  ":AP#"      // Start tracking
#define TM_CMD_TRACK_OFF                 ":AL#"      // Stop tracking

// Meridian flip
#define TM_CMD_GET_UNATTENDED_FLIP       ":Guaf#"    // Get unattended flip (0/1)
#define TM_CMD_SET_UNATTENDED_FLIP_ON    ":Suaf1#"   // Enable unattended flip
#define TM_CMD_SET_UNATTENDED_FLIP_OFF   ":Suaf0#"   // Disable unattended flip
#define TM_CMD_FLIP                      ":FLIP#"    // Perform flip

// Refraction model
#define TM_CMD_GET_REFRACTION_TEMP       ":GRTMP#"   // Get temperature (°C)
#define TM_CMD_SET_REFRACTION_TEMP       ":SRTMP"    // Set temp (append ±TT.T#)
#define TM_CMD_GET_REFRACTION_PRESSURE   ":GRPRS#"   // Get pressure (hPa)
#define TM_CMD_SET_REFRACTION_PRESSURE   ":SRPRS"    // Set pressure (append PPPP.P#)

// Alignment/Modeling
#define TM_CMD_GET_ALIGN_STAR_COUNT      ":getalst#" // Number of alignment stars
#define TM_CMD_GET_ALIGN_POINT           ":getalp"   // Get point N (append N#)
#define TM_CMD_GET_MODEL_COUNT           ":modelcnt#"// Number of saved models
#define TM_CMD_NEW_ALIGN_START           ":newalig#" // Start new alignment
#define TM_CMD_NEW_ALIGN_POINT           ":newalpt"  // Add point (append params#)
#define TM_CMD_NEW_ALIGN_END             ":endalig#" // Finalize alignment
#define TM_CMD_DELETE_ALIGN              ":delalig#" // Delete alignment

// Sync configuration
#define TM_CMD_SYNC_MODE_OFFSET          ":CMCFG0#"  // Sync applies offset only
#define TM_CMD_SYNC_MODE_REFINE          ":CMCFG1#"  // Sync refines model

// Satellite tracking (firmware 2.13.20+)
#define TM_CMD_TLE_LOAD                  ":TLEL0"    // Load TLE (append TLE data)
#define TM_CMD_TLE_DATABASE              ":TLEDL"    // Load TLE from database (append index)
#define TM_CMD_TLE_PRECALC               ":TLEP"     // Precalculate transit (append JD,min)
#define TM_CMD_TLE_TRACK                 ":TLES#"    // Track satellite

// Date/Time
#define TM_CMD_SET_DATE                  ":SC"       // Set date (append YYYY-MM-DD#)

// ----------------------------------------------------------------------------
// Mount status codes (from :Gstat#)
// ----------------------------------------------------------------------------

typedef enum {
    TM_STATUS_TRACKING              = 0,
    TM_STATUS_STOPPED               = 1,
    TM_STATUS_SLEWING_SLOWEST       = 2,
    TM_STATUS_SLEWING_SLOW          = 3,
    TM_STATUS_SLEWING_MEDIUM        = 4,
    TM_STATUS_SLEWING_FAST          = 5,
    TM_STATUS_SLEWING_FASTEST       = 6,
    TM_STATUS_TRACKING_PAUSED       = 7,
    TM_STATUS_HOME                  = 8,
    TM_STATUS_PARK                  = 9,
    TM_STATUS_SLEWING_PARK          = 10,
    TM_STATUS_SLEWING_HOME          = 11,
    TM_STATUS_MOTOR_TEMP_WARNING    = 98,
    TM_STATUS_TRACKING_SATELLITE    = 99,
    TM_STATUS_UNKNOWN               = -1
} tm_mount_status_t;

// ----------------------------------------------------------------------------
// Pier side
// ----------------------------------------------------------------------------

typedef enum {
    TM_PIER_EAST = 0,   // Counterweight down on west, OTA pointing east
    TM_PIER_WEST = 1,   // Counterweight down on east, OTA pointing west
    TM_PIER_UNKNOWN = -1
} tm_pier_side_t;

// ----------------------------------------------------------------------------
// Alignment point structure
// ----------------------------------------------------------------------------

typedef struct {
    int index;
    double mount_ra;        // Mount reported RA
    double mount_dec;       // Mount reported Dec
    double solved_ra;       // Plate-solved RA
    double solved_dec;      // Plate-solved Dec
    char pier_side;         // 'E' or 'W'
    double sidereal_time;
    double error_arcsec;    // Pointing error
} tm_alignment_point_t;

// ----------------------------------------------------------------------------
// Parsed :Ginfo# response
// ----------------------------------------------------------------------------

typedef struct {
    double ra;              // Current RA (hours)
    double dec;             // Current Dec (degrees)
    char pier_side;         // 'E' or 'W'
    double az;              // Azimuth (degrees)
    double alt;             // Altitude (degrees)
    double julian_date;
    int status;             // Mount status
    int slew_status;        // Slew in progress
} tm_mount_info_t;

// ----------------------------------------------------------------------------
// Product info
// ----------------------------------------------------------------------------

typedef struct {
    char product_name[64];
    char control_box[64];
    char firmware_version[32];
    char firmware_date[32];
} tm_product_info_t;

// ----------------------------------------------------------------------------
// Custom property groups
// ----------------------------------------------------------------------------

#define TM_GROUP_PRODUCT     "Product"
#define TM_GROUP_ALIGNMENT   "Alignment"
#define TM_GROUP_REFRACTION  "Refraction"
#define TM_GROUP_SATELLITE   "Satellite"
#define TM_GROUP_ADVANCED    "Advanced"

// ----------------------------------------------------------------------------
// Driver entry point
// ----------------------------------------------------------------------------

extern indigo_result indigo_mount_10micron(indigo_driver_action action, indigo_driver_info *info);

#ifdef __cplusplus
}
#endif

#endif /* indigo_mount_10micron_h */
