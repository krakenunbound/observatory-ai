#!/usr/bin/env python3
"""
FITS to JPG preview generator with proper astronomical stretching.
Uses Midtone Transfer Function (MTF) for optimal star/nebula visibility.
"""

import sys
import numpy as np
from astropy.io import fits
from PIL import Image

def auto_stretch(image, target_bg=0.25, sigma_clip=2.8):
    """
    Automatically stretches a linear astronomical image using MTF.
    :param image: 2D numpy array (the image)
    :param target_bg: The desired background level (0 to 1)
    :param sigma_clip: How many standard deviations to clip from the mean
    """
    # Handle NaN/Inf values
    image = np.nan_to_num(image, nan=0.0, posinf=0.0, neginf=0.0)

    # 1. Normalize to 0.0 - 1.0
    img_min = np.min(image)
    img_max = np.max(image)
    if img_max == img_min:
        return np.zeros_like(image)
    data = (image - img_min) / (img_max - img_min)

    # 2. Calculate statistics
    mean = np.mean(data)
    std = np.std(data)

    # 3. Determine clipping points
    shadow_clip = max(0, mean - (sigma_clip * std))

    # 4. Calculate the Midtone Transfer Function (MTF) parameter
    if shadow_clip >= 1 or (shadow_clip + target_bg - 1) == 0:
        m = 0.5
    else:
        m = (target_bg * (shadow_clip - 1)) / (shadow_clip + target_bg - 1)

    # 5. Apply the stretch
    denominator = (2 * m - 1) * (data - shadow_clip) - m
    # Avoid division by zero
    denominator = np.where(denominator == 0, 1e-10, denominator)

    stretched = np.where(data > shadow_clip,
                         ((m - 1) * (data - shadow_clip)) / denominator,
                         0)

    return np.clip(stretched, 0, 1)


def process_fits(fits_path, output_path, max_size=800):
    """
    Convert FITS to stretched JPG preview.
    """
    try:
        with fits.open(fits_path) as hdul:
            data = hdul[0].data

            if data is None:
                print(f"Error: No image data in {fits_path}")
                return False

            # Handle 3D data (color or multi-extension)
            if len(data.shape) == 3:
                # If RGB, process each channel
                if data.shape[0] == 3:
                    r = auto_stretch(data[0])
                    g = auto_stretch(data[1])
                    b = auto_stretch(data[2])
                    stretched = np.stack([r, g, b], axis=-1)
                else:
                    # Take first plane
                    stretched = auto_stretch(data[0])
            else:
                stretched = auto_stretch(data)

            # Convert to 8-bit
            img_8bit = (stretched * 255).astype(np.uint8)

            # Create PIL image
            if len(img_8bit.shape) == 3:
                img = Image.fromarray(img_8bit, mode='RGB')
            else:
                img = Image.fromarray(img_8bit, mode='L')

            # Resize if needed
            if max(img.size) > max_size:
                ratio = max_size / max(img.size)
                new_size = (int(img.size[0] * ratio), int(img.size[1] * ratio))
                img = img.resize(new_size, Image.LANCZOS)

            # Save as JPG
            img.save(output_path, 'JPEG', quality=90)
            print(f"Created preview: {output_path}")
            return True

    except Exception as e:
        print(f"Error processing {fits_path}: {e}")
        return False


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: fits_preview.py input.fits output.jpg")
        sys.exit(1)

    success = process_fits(sys.argv[1], sys.argv[2])
    sys.exit(0 if success else 1)
