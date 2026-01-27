# Pegasus Uranus Meteo Sensor INDIGO driver
# Copyright (c) 2024 Observatory AI Project

cmake_minimum_required(VERSION 3.10)
project(indigo_aux_uranus C)

# Find INDIGO
find_package(PkgConfig REQUIRED)
pkg_check_modules(INDIGO REQUIRED indigo)

# Driver source files
set(DRIVER_SOURCES
    indigo_aux_uranus.c
)

# Build as shared library (INDIGO driver)
add_library(indigo_aux_uranus SHARED ${DRIVER_SOURCES})

# Include directories
target_include_directories(indigo_aux_uranus PRIVATE
    ${INDIGO_INCLUDE_DIRS}
    ${CMAKE_CURRENT_SOURCE_DIR}
)

# Link libraries
target_link_libraries(indigo_aux_uranus
    ${INDIGO_LIBRARIES}
    pthread
    m
)

# Compiler flags
target_compile_options(indigo_aux_uranus PRIVATE
    -Wall
    -Wextra
    -O2
)

# Set output name without 'lib' prefix
set_target_properties(indigo_aux_uranus PROPERTIES
    PREFIX ""
    OUTPUT_NAME "indigo_aux_uranus"
)

# Install
install(TARGETS indigo_aux_uranus
    LIBRARY DESTINATION lib/indigo
)

# Also build standalone executable for testing
add_executable(indigo_aux_uranus_standalone ${DRIVER_SOURCES})

target_include_directories(indigo_aux_uranus_standalone PRIVATE
    ${INDIGO_INCLUDE_DIRS}
    ${CMAKE_CURRENT_SOURCE_DIR}
)

target_link_libraries(indigo_aux_uranus_standalone
    ${INDIGO_LIBRARIES}
    pthread
    m
)

target_compile_definitions(indigo_aux_uranus_standalone PRIVATE
    INDIGO_LINUX
)
