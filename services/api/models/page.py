# services/api/models/page.py

from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple


@dataclass
class Page:
    """
    Lightweight page descriptor at domain level.
    """
    page_index: int          # 0-based
    width: float             # in PDF units
    height: float
    rotation: int = 0        # 0, 90, 180, 270


def norm_to_absolute(
    nx: float,
    ny: float,
    nw: float,
    nh: float,
    page: Page,
) -> Tuple[float, float, float, float]:
    """
    Convert normalized [0..1] rect (origin top-left) into PDF coordinates
    (origin bottom-left) for a potentially rotated page.
    Returns (x, y, width, height) in PDF user space.
    """

    # First compute rect in "unrotated-top-left" pixel space
    x_px = nx * page.width
    y_px = ny * page.height
    w_px = nw * page.width
    h_px = nh * page.height

    rot = page.rotation % 360

    if rot == 0:
      # PDF origin is bottom-left: y_flip = height - (y + h)
        return (
            x_px,
            page.height - (y_px + h_px),
            w_px,
            h_px,
        )

    elif rot == 90:
        # Page rotated clockwise: (x,y) axes swap.
        # Think in terms of rotating the normalized rect 90°.
        x_rot = y_px
        y_rot = page.width - (x_px + w_px)
        return (
            x_rot,
            page.height - (y_rot + h_px),
            w_px,
            h_px,
        )

    elif rot == 180:
        x_rot = page.width - (x_px + w_px)
        y_rot = page.height - (y_px + h_px)
        return (
            x_rot,
            page.height - (y_rot + h_px),
            w_px,
            h_px,
        )

    elif rot == 270:
        x_rot = page.height - (y_px + h_px)
        y_rot = x_px
        return (
            x_rot,
            page.height - (y_rot + h_px),
            w_px,
            h_px,
        )

    # Fallback: treat any weird angle like 0°
    return (
        x_px,
        page.height - (y_px + h_px),
        w_px,
        h_px,
    )


def absolute_to_norm(
    x: float,
    y: float,
    w: float,
    h: float,
    page: Page,
) -> Tuple[float, float, float, float]:
    """
    Reverse of norm_to_absolute (roughly).
    Takes PDF coords (origin bottom-left) + rotation -> normalized [0..1].
    """
    rot = page.rotation % 360

    if rot == 0:
        x_px = x
        y_px = page.height - (y + h)
    elif rot == 90:
        # Reverse of the 90° logic above
        x_px = page.width - (y + h)
        y_px = x
    elif rot == 180:
        x_px = page.width - (x + w)
        y_px = page.height - (y + h)
    elif rot == 270:
        x_px = y
        y_px = page.height - (x + w)
    else:
        x_px = x
        y_px = page.height - (y + h)

    nx = x_px / page.width
    ny = y_px / page.height
    nw = w / page.width
    nh = h / page.height

    return nx, ny, nw, nh
