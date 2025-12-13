# services/api/models/mark.py
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4


def _gen_id() -> str:
  return f"m-{uuid4().hex[:10]}"


def _safe_float(val: Any) -> Optional[float]:
  try:
    if val is None:
      return None
    s = str(val).strip()
    if not s:
      return None
    return float(s)
  except Exception:
    return None


# ---------- low-level transformers (page size / rotation) ----------

def _normalize_rect_top_left(
  x: float,
  y: float,
  w: float,
  h: float,
  page_width: float,
  page_height: float,
  rotation_deg: int = 0,
) -> Tuple[float, float, float, float]:
  """
  Convert from ABSOLUTE px rect (x,y,w,h) in a *top-left* origin
  coordinate system to normalized [0..1] coords, accounting for
  rotation (0, 90, 180, 270) in the human-view orientation.
  """
  rot = rotation_deg % 360

  if page_width <= 0 or page_height <= 0:
    raise ValueError("page_width/page_height must be > 0")

  if rot == 0:
    nx = x / page_width
    ny = y / page_height
    nw = w / page_width
    nh = h / page_height
  elif rot == 90:
    nx = y / page_height
    ny = (page_width - (x + w)) / page_width
    nw = h / page_height
    nh = w / page_width
  elif rot == 180:
    nx = (page_width - (x + w)) / page_width
    ny = (page_height - (y + h)) / page_height
    nw = w / page_width
    nh = h / page_height
  elif rot == 270:
    nx = (page_height - (y + h)) / page_height
    ny = x / page_width
    nw = h / page_height
    nh = w / page_width
  else:
    raise ValueError(f"Unsupported rotation: {rotation_deg} (use 0/90/180/270)")

  return nx, ny, nw, nh


def _denormalize_rect_top_left(
  nx: float,
  ny: float,
  nw: float,
  nh: float,
  page_width: float,
  page_height: float,
  rotation_deg: int = 0,
) -> Tuple[float, float, float, float]:
  """
  Convert from normalized [0..1] coordinates back to absolute px rect
  (x,y,w,h) in a top-left origin coordinate system, accounting for
  rotation (0, 90, 180, 270) in human-view orientation.
  """
  rot = rotation_deg % 360

  if page_width <= 0 or page_height <= 0:
    raise ValueError("page_width/page_height must be > 0")

  if rot == 0:
    x = nx * page_width
    y = ny * page_height
    w = nw * page_width
    h = nh * page_height
  elif rot == 90:
    h = nw * page_height
    w = nh * page_width
    x = page_width - (ny * page_width + w)
    y = nx * page_height
  elif rot == 180:
    w = nw * page_width
    h = nh * page_height
    x = page_width - (nx * page_width + w)
    y = page_height - (ny * page_height + h)
  elif rot == 270:
    h = nw * page_height
    w = nh * page_width
    x = ny * page_width
    y = page_height - (nx * page_height + h)
  else:
    raise ValueError(f"Unsupported rotation: {rotation_deg} (use 0/90/180/270)")

  return x, y, w, h


@dataclass
class Mark:
  """
  Domain model for a single mark.

  All coordinates are NORMALIZED (0..1) with origin at top-left of the page
  in "human view" (after rotation).
  """

  mark_id: str = field(default_factory=_gen_id)
  mark_set_id: Optional[str] = None

  page_index: int = 0          # 0-based
  order_index: int = 0

  name: str = ""
  nx: float = 0.0
  ny: float = 0.0
  nw: float = 0.0
  nh: float = 0.0

  zoom_hint: Optional[float] = None
  label: Optional[str] = None
  instrument: Optional[str] = None
  is_required: bool = True

  # 🔴 NEW: required value fields (OCR + user-confirmed)
  required_value_ocr: Optional[str] = None
  required_value_conf: Optional[float] = None  # 0–100
  required_value_final: Optional[str] = None

  # --------------------
  # Validation
  # --------------------
  def validate(self) -> None:
    """
    Raises ValueError if any invariant is broken.
    """
    if self.page_index < 0:
      raise ValueError("page_index must be >= 0")

    if self.order_index < 0:
      raise ValueError("order_index must be >= 0")

    for field_name in ("nx", "ny", "nw", "nh"):
      v = getattr(self, field_name)
      if not (0.0 <= v <= 1.0):
        raise ValueError(f"{field_name} must be in [0, 1], got {v}")

    if self.nw == 0.0 or self.nh == 0.0:
      raise ValueError("nw and nh must be > 0 in normalized space")

    if self.zoom_hint is not None and self.zoom_hint <= 0.0:
      raise ValueError("zoom_hint, if provided, must be > 0")

    if self.name is None:
      raise ValueError("name must not be None (use empty string instead)")

  # --------------------
  # PDF/page-size/rotation helpers (domain-level)
  # --------------------
  @classmethod
  def from_pdf_rect(
    cls,
    *,
    mark_set_id: Optional[str],
    page_index: int,
    order_index: int,
    name: str,
    x: float,
    y: float,
    w: float,
    h: float,
    page_width: float,
    page_height: float,
    rotation_deg: int = 0,
    zoom_hint: Optional[float] = None,
    label: Optional[str] = None,
    instrument: Optional[str] = None,
    is_required: bool = True,
    required_value_ocr: Optional[str] = None,
    required_value_conf: Optional[float] = None,
    required_value_final: Optional[str] = None,
  ) -> "Mark":
    nx, ny, nw, nh = _normalize_rect_top_left(
      x=x,
      y=y,
      w=w,
      h=h,
      page_width=page_width,
      page_height=page_height,
      rotation_deg=rotation_deg,
    )

    mark = cls(
      mark_id=_gen_id(),
      mark_set_id=mark_set_id,
      page_index=page_index,
      order_index=order_index,
      name=name or "",
      nx=nx,
      ny=ny,
      nw=nw,
      nh=nh,
      zoom_hint=zoom_hint,
      label=label,
      instrument=instrument,
      is_required=is_required,
      required_value_ocr=required_value_ocr,
      required_value_conf=required_value_conf,
      required_value_final=required_value_final,
    )
    mark.validate()
    return mark

  def to_pdf_rect(
    self,
    page_width: float,
    page_height: float,
    rotation_deg: int = 0,
  ) -> Dict[str, float]:
    x, y, w, h = _denormalize_rect_top_left(
      nx=self.nx,
      ny=self.ny,
      nw=self.nw,
      nh=self.nh,
      page_width=page_width,
      page_height=page_height,
      rotation_deg=rotation_deg,
    )
    return {"x": x, "y": y, "w": w, "h": h}

  # --------------------
  # Conversions – storage layer (Sheets/DB)
  # --------------------
  @classmethod
  def from_storage(cls, row: Dict[str, Any]) -> "Mark":
    """
    Create from a storage row (Sheets/SQLite/etc).
    Adjust key names here to match your actual storage schema.
    """
    mark = cls(
      mark_id=row.get("mark_id") or _gen_id(),
      mark_set_id=row.get("mark_set_id"),
      page_index=int(row.get("page_index", 0)),
      order_index=int(row.get("order_index", 0)),
      name=(row.get("name") or "").strip(),
      nx=float(row.get("nx", 0.0)),
      ny=float(row.get("ny", 0.0)),
      nw=float(row.get("nw", 0.0)),
      nh=float(row.get("nh", 0.0)),
      zoom_hint=float(row["zoom_hint"]) if row.get("zoom_hint") is not None else None,
      label=row.get("label"),
      instrument=row.get("instrument"),
      is_required=bool(row.get("is_required", True)),
      required_value_ocr=row.get("required_value_ocr"),
      required_value_conf=_safe_float(row.get("required_value_conf")),
      required_value_final=row.get("required_value_final"),
    )
    mark.validate()
    return mark

  def to_storage(self) -> Dict[str, Any]:
    """
    Convert to a flat dict suitable for Sheets/DB adapters.
    """
    self.validate()
    return {
      "mark_id": self.mark_id,
      "mark_set_id": self.mark_set_id,
      "page_index": self.page_index,
      "order_index": self.order_index,
      "name": self.name,
      "nx": self.nx,
      "ny": self.ny,
      "nw": self.nw,
      "nh": self.nh,
      "zoom_hint": self.zoom_hint,
      "label": self.label,
      "instrument": self.instrument,
      "is_required": self.is_required,
      "required_value_ocr": self.required_value_ocr,
      "required_value_conf": self.required_value_conf,
      "required_value_final": self.required_value_final,
    }

  # --------------------
  # Conversions – API schemas (FastAPI / pydantic)
  # --------------------
  @classmethod
  def from_api(cls, data: Dict[str, Any], mark_set_id: Optional[str] = None) -> "Mark":
    """
    Build from an incoming API dict (e.g. request body).
    Assumes coordinates are already normalized 0..1 (as editor sends).
    """
    mark = cls(
      mark_id=data.get("mark_id") or _gen_id(),
      mark_set_id=data.get("mark_set_id") or mark_set_id,
      page_index=int(data.get("page_index", 0)),
      order_index=int(data.get("order_index", 0)),
      name=(data.get("name") or "").strip(),
      nx=float(data.get("nx", 0.0)),
      ny=float(data.get("ny", 0.0)),
      nw=float(data.get("nw", 0.0)),
      nh=float(data.get("nh", 0.0)),
      zoom_hint=float(data["zoom_hint"]) if data.get("zoom_hint") is not None else None,
      label=data.get("label"),
      instrument=data.get("instrument"),
      is_required=bool(data.get("is_required", True)),
      required_value_ocr=data.get("required_value_ocr"),
      required_value_conf=_safe_float(data.get("required_value_conf")),
      required_value_final=data.get("required_value_final"),
    )
    mark.validate()
    return mark

  def to_api(self) -> Dict[str, Any]:
    """
    Convert to shape returned to frontend (JSON).
    """
    self.validate()
    return {
      "mark_id": self.mark_id,
      "mark_set_id": self.mark_set_id,
      "page_index": self.page_index,
      "order_index": self.order_index,
      "name": self.name,
      "nx": self.nx,
      "ny": self.ny,
      "nw": self.nw,
      "nh": self.nh,
      "zoom_hint": self.zoom_hint,
      "label": self.label,
      "instrument": self.instrument,
      "is_required": self.is_required,
      "required_value_ocr": self.required_value_ocr,
      "required_value_conf": self.required_value_conf,
      "required_value_final": self.required_value_final,
    }


# ------------ helpers on whole lists ------------

def normalize_order_and_labels(marks: List[Mark]) -> List[Mark]:
  for idx, m in enumerate(marks):
    m.order_index = idx
  return marks


def validate_mark_list(marks: List[Mark]) -> None:
  for m in marks:
    m.validate()

  seen_ids = set()
  for m in marks:
    if m.mark_id in seen_ids:
      raise ValueError(f"Duplicate mark_id in list: {m.mark_id}")
    seen_ids.add(m.mark_id)
