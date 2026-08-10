#!/usr/bin/env python3
"""Render a cut-line PDF at 300 dpi and measure its plate geometry."""

import argparse

import numpy as np
import pypdfium2 as pdfium


DPI = 300
MM_PER_PIXEL = 25.4 / DPI
CARD_H = 55.0
ROWS = 5
MARGIN_Y = 11.0


def groups(indices: np.ndarray) -> list[np.ndarray]:
    if not len(indices):
        return []
    return np.split(indices, np.where(np.diff(indices) > 1)[0] + 1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('pdf')
    parser.add_argument('--scale-y', type=float, default=1.011)
    parser.add_argument('--shift-y', type=float, default=1.0)
    args = parser.parse_args()

    page = pdfium.PdfDocument(args.pdf)[0]
    # pypdfium2 returns BGR on this platform.
    image = page.render(scale=DPI / 72).to_numpy()[:, :, :3].astype(np.int16)

    # SVG cut lines are #adbccc => BGR (204, 188, 173).  Requiring most of
    # the five-row height rejects card artwork and the horizontal rules.
    cut_colour = np.array([204, 188, 173])
    cut_mask = np.max(np.abs(image - cut_colour), axis=2) < 25
    min_run = CARD_H * ROWS * args.scale_y / MM_PER_PIXEL * 0.70
    candidates = np.flatnonzero(cut_mask.sum(axis=0) > min_run)
    runs = groups(candidates)
    xs = [(float(run.mean()) + 0.5) * MM_PER_PIXEL for run in runs]
    if len(xs) != 3:
        raise SystemExit(f'expected 3 vertical cut lines, found {len(xs)}: {xs}')

    print('vertical cut lines x (mm): ' + ', '.join(f'{x:.2f}' for x in xs))
    print(f'total plate width (mm): {xs[-1] - xs[0]:.2f}')

    # Ruler and its note are #1b56a8 => BGR (168, 86, 27).  Only inspect
    # pixels above row 1, so blue artwork in the cards cannot contaminate it.
    row_top = MARGIN_Y + args.shift_y
    row_top_px = max(0, round(row_top / MM_PER_PIXEL))
    ruler_colour = np.array([168, 86, 27])
    ruler_mask = np.max(np.abs(image[:row_top_px] - ruler_colour), axis=2) < 35
    ys = np.flatnonzero(ruler_mask.any(axis=1))
    if not len(ys):
        raise SystemExit('ruler pixels were not found above row 1')
    ruler_bottom = (float(ys[-1]) + 1.0) * MM_PER_PIXEL
    print(f'ruler bottom y (mm): {ruler_bottom:.2f}')
    print(f'row 1 top y (mm): {row_top:.2f}')
    print(f'ruler clearance (mm): {row_top - ruler_bottom:.2f}')


if __name__ == '__main__':
    main()
