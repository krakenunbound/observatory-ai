// Copyright (c) 2024 Observatory AI Project
// All rights reserved.
//
// INDIGO Pegasus Uranus Meteo Sensor driver
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice,
//    this list of conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND.

#ifndef indigo_aux_uranus_h
#define indigo_aux_uranus_h

#include <indigo/indigo_driver.h>
#include <indigo/indigo_aux_driver.h>

#ifdef __cplusplus
extern "C" {
#endif

// ----------------------------------------------------------------------------
// Driver info
// ----------------------------------------------------------------------------

#define AUX_URANUS_NAME              "Pegasus Uranus Meteo"
#define AUX_URANUS_DRIVER_NAME       "indigo_aux_uranus"
#define AUX_URANUS_DRIVER_VERSION    0x0001

// ----------------------------------------------------------------------------
// Serial communication
// ----------------------------------------------------------------------------

#define URANUS_DEFAULT_BAUDRATE      115200
#define URANUS_COMMAND_TIMEOUT       2      // seconds
#define URANUS_POLL_INTERVAL         10.0   // seconds between sensor reads

// ----------------------------------------------------------------------------
// Commands (terminated with \r\n, responses also \r\n terminated)
// ----------------------------------------------------------------------------

#define URANUS_CMD_HANDSHAKE         "M#"       // Response: MS_OK
#define URANUS_CMD_SENSORS           "MA"       // All sensor readings
#define URANUS_CMD_GPS               "GP"       // GPS data
#define URANUS_CMD_CLOUDS            "CI"       // Cloud information
#define URANUS_CMD_SKYQUALITY        "SQ"       // Sky quality reading
#define URANUS_CMD_SKYQUALITY_START  "SQ:1"     // Trigger SQ measurement
#define URANUS_CMD_SET_UTC_OFFSET    "C3:"      // Set UTC offset (append value)

// Handshake response
#define URANUS_HANDSHAKE_RESPONSE    "MS_OK"

// ----------------------------------------------------------------------------
// Sensor indices for MA response parsing
// ----------------------------------------------------------------------------

typedef enum {
    URANUS_SENSOR_AMBIENT_TEMP = 0,
    URANUS_SENSOR_HUMIDITY,
    URANUS_SENSOR_DEW_POINT,
    URANUS_SENSOR_PRESSURE_ABS,
    URANUS_SENSOR_PRESSURE_REL,
    URANUS_SENSOR_BARO_ALTITUDE,
    URANUS_SENSOR_SKY_TEMP,
    URANUS_SENSOR_IR_TEMP,
    URANUS_SENSOR_BATTERY_VOLTAGE,
    URANUS_SENSOR_BATTERY_USAGE,
    URANUS_SENSOR_COUNT
} uranus_sensor_index_t;

// ----------------------------------------------------------------------------
// Cloud indices for CI response parsing
// ----------------------------------------------------------------------------

typedef enum {
    URANUS_CLOUD_TEMP_DIFF = 0,
    URANUS_CLOUD_INDEX,
    URANUS_CLOUD_SKY_TEMP,
    URANUS_CLOUD_AMBIENT_TEMP,
    URANUS_CLOUD_EMISSIVITY,
    URANUS_CLOUD_COUNT
} uranus_cloud_index_t;

// ----------------------------------------------------------------------------
// Sky quality indices for SQ response parsing
// ----------------------------------------------------------------------------

typedef enum {
    URANUS_SQ_MPAS = 0,          // Magnitude per arcsec squared
    URANUS_SQ_NELM,              // Naked eye limiting magnitude
    URANUS_SQ_FULL_SPECTRUM,
    URANUS_SQ_VISUAL_SPECTRUM,
    URANUS_SQ_IR_SPECTRUM,
    URANUS_SQ_COUNT
} uranus_skyquality_index_t;

// ----------------------------------------------------------------------------
// GPS indices for GP response parsing
// ----------------------------------------------------------------------------

typedef enum {
    URANUS_GPS_FIX = 0,
    URANUS_GPS_UNIX_TIME,
    URANUS_GPS_UTC_OFFSET,
    URANUS_GPS_LATITUDE,
    URANUS_GPS_LONGITUDE,
    URANUS_GPS_SATELLITES,
    URANUS_GPS_SPEED_KPH,
    URANUS_GPS_BEARING,
    URANUS_GPS_COUNT
} uranus_gps_index_t;

// ----------------------------------------------------------------------------
// Weather alert thresholds (defaults)
// ----------------------------------------------------------------------------

#define URANUS_THRESHOLD_CLOUD_ALERT     85.0    // Cloud index % for alert
#define URANUS_THRESHOLD_MPAS_ALERT      15.0    // Sky brightness for alert
#define URANUS_THRESHOLD_TEMP_MIN       -20.0    // Min safe temperature
#define URANUS_THRESHOLD_TEMP_MAX        50.0    // Max safe temperature
#define URANUS_THRESHOLD_HUMIDITY_ALERT  75.0    // Humidity % for alert

// ----------------------------------------------------------------------------
// Driver entry point
// ----------------------------------------------------------------------------

extern indigo_result indigo_aux_uranus(indigo_driver_action action, indigo_driver_info *info);

#ifdef __cplusplus
}
#endif

#endif /* indigo_aux_uranus_h */
