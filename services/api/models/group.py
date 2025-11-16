# services/api/models/group.py

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from uuid import uuid4


def _gen_group_id() -> str:
  return f"g-{uuid4().hex[:10]}"


@dataclass
class Group:
  """
  Domain model for a group of marks (QC area).

  Coordinates are normalized (0..1) in page space, origin at top-left,
  same convention as Mark.
  """

  group_id: str = field(default_factory=_gen_group_id)
  mark_set_id: Optional[str] = None

  name: str = ""
  page_index: int = 0

  nx: float = 0.0
  ny: float = 0.0
  nw: float = 0.0
  nh: float = 0.0

  mark_ids: List[str] = field(default_factory=list)

  created_by: Optional[str] = None

  # --------------------
  # Validation
  # --------------------
  def validate(self) -> None:
    if self.page_index < 0:
      raise ValueError("page_index must be >= 0")

    for field_name in ("nx", "ny", "nw", "nh"):
      v = getattr(self, field_name)
      if not (0.0 <= v <= 1.0):
        raise ValueError(f"{field_name} must be in [0, 1], got {v}")

    if self.nw == 0.0 or self.nh == 0.0:
      raise ValueError("nw and nh must be > 0 in normalized space")

    # mark_ids can be empty (empty group is allowed by UI)
    if any(not mid for mid in self.mark_ids):
      raise ValueError("mark_ids must not contain empty IDs")

  # ------------ storage layer ------------

  @classmethod
  def from_storage(cls, row: Dict[str, Any]) -> "Group":
    # mark_ids may be stored as comma-separated string
    raw_ids = row.get("mark_ids") or row.get("mark_ids_csv") or ""
    if isinstance(raw_ids, str):
      mark_ids = [mid.strip() for mid in raw_ids.split(",") if mid.strip()]
    elif isinstance(raw_ids, list):
      mark_ids = [str(x) for x in raw_ids if x]
    else:
      mark_ids = []

    g = cls(
      group_id=row.get("group_id") or _gen_group_id(),
      mark_set_id=row.get("mark_set_id"),
      name=(row.get("name") or "").strip(),
      page_index=int(row.get("page_index", 0)),
      nx=float(row.get("nx", 0.0)),
      ny=float(row.get("ny", 0.0)),
      nw=float(row.get("nw", 0.0)),
      nh=float(row.get("nh", 0.0)),
      mark_ids=mark_ids,
      created_by=row.get("created_by"),
    )
    g.validate()
    return g

  def to_storage(self) -> Dict[str, Any]:
    self.validate()
    return {
      "group_id": self.group_id,
      "mark_set_id": self.mark_set_id,
      "name": self.name,
      "page_index": self.page_index,
      "nx": self.nx,
      "ny": self.ny,
      "nw": self.nw,
      "nh": self.nh,
      # you can change this to JSON array in DB if you prefer
      "mark_ids": ",".join(self.mark_ids),
      "created_by": self.created_by,
    }

  # ------------ API layer ------------

  @classmethod
  def from_api(cls, data: Dict[str, Any], mark_set_id: Optional[str] = None) -> "Group":
    raw_ids = data.get("mark_ids") or []
    if isinstance(raw_ids, list):
      mark_ids = [str(x) for x in raw_ids if x]
    else:
      mark_ids = []

    g = cls(
      group_id=data.get("group_id") or _gen_group_id(),
      mark_set_id=data.get("mark_set_id") or mark_set_id,
      name=(data.get("name") or "").strip(),
      page_index=int(data.get("page_index", 0)),
      nx=float(data.get("nx", 0.0)),
      ny=float(data.get("ny", 0.0)),
      nw=float(data.get("nw", 0.0)),
      nh=float(data.get("nh", 0.0)),
      mark_ids=mark_ids,
      created_by=data.get("created_by"),
    )
    g.validate()
    return g

  def to_api(self) -> Dict[str, Any]:
    self.validate()
    return {
      "group_id": self.group_id,
      "mark_set_id": self.mark_set_id,
      "name": self.name,
      "page_index": self.page_index,
      "nx": self.nx,
      "ny": self.ny,
      "nw": self.nw,
      "nh": self.nh,
      "mark_ids": self.mark_ids,
      "created_by": self.created_by,
    }


# ------------ list helpers ------------

def validate_group_list(groups: List[Group]) -> None:
  """
  Validate a list of groups; ensure group_ids are unique.
  """
  seen = set()
  for g in groups:
    g.validate()
    if g.group_id in seen:
      raise ValueError(f"Duplicate group_id in list: {g.group_id}")
    seen.add(g.group_id)
