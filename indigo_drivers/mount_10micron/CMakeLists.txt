# 10Micron Mount INDIGO driver
# Copyright (c) 2024 Observatory AI Project

cmake_minimum_required(VERSION 3.10)
project(indigo_mount_10micron C)

# Find INDIGO
find_package(PkgConfig REQUIRED)
pkg_check_modules(INDIGO REQUIRED indigo)

# Driver source files
set(DRIVER_SOURCES
    indigo_mount_10micron.c
)

# Build as shared library (INDIGO driver)
add_library(indigo_mount_10micron SHARED ${DRIVER_SOURCES})

# Include directories
target_include_directories(indigo_mount_10micron PRIVATE
    ${INDIGO_INCLUDE_DIRS}
    ${CMAKE_CURRENT_SOURCE_DIR}
)

# Link libraries
target_link_libraries(indigo_mount_10micron
    ${INDIGO_LIBRARIES}
    pthread
    m
)

# Compiler flags
target_compile_options(indigo_mount_10micron PRIVATE
    -Wall
    -Wextra
    -O2
)

# Set output name without 'lib' prefix
set_target_properties(indigo_mount_10micron PROPERTIES
    PREFIX ""
    OUTPUT_NAME "indigo_mount_10micron"
)

# Install
install(TARGETS indigo_mount_10micron
    LIBRARY DESTINATION lib/indigo
)

# Also build standalone executable for testing
add_executable(indigo_mount_10micron_standalone ${DRIVER_SOURCES})

target_include_directories(indigo_mount_10micron_standalone PRIVATE
    ${INDIGO_INCLUDE_DIRS}
    ${CMAKE_CURRENT_SOURCE_DIR}
)

target_link_libraries(indigo_mount_10micron_standalone
    ${INDIGO_LIBRARIES}
    pthread
    m
)

target_compile_definitions(indigo_mount_10micron_standalone PRIVATE
    INDIGO_LINUX
)
