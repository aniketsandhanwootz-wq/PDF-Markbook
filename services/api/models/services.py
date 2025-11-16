# services/api/models/services.py

from __future__ import annotations

from typing import Iterable, List

from .mark import Mark, normalize_order_and_labels, validate_mark_list
from .group import Group


class MarkSetService:
    """
    Business rules that apply to a whole mark-set:
      - validate list of marks
      - normalize ordering
      - run cross-mark checks
    """

    @staticmethod
    def from_api_payload(
        payload: Iterable[dict],
        mark_set_id: str,
    ) -> List[Mark]:
        marks = [Mark.from_api(m, mark_set_id=mark_set_id) for m in payload]
        # Per-mark validation
        validate_mark_list(marks)
        # Normalize order indexes
        normalize_order_and_labels(marks)
        return marks

    @staticmethod
    def to_api_payload(marks: Iterable[Mark]) -> List[dict]:
        return [m.to_api() for m in marks]

    @staticmethod
    def to_storage_rows(marks: Iterable[Mark]) -> List[dict]:
        return [m.to_storage() for m in marks]

    # Extra cross-mark validation hooks (add later if needed)
    @staticmethod
    def ensure_same_page_for_group(marks: List[Mark], page_index: int) -> None:
        """
        Example helper: ensure all given marks lie on the same page.
        """
        for m in marks:
            if m.page_index != page_index:
                raise ValueError(
                    f"Mark {m.mark_id} is on page {m.page_index + 1}, "
                    f"expected page {page_index + 1}"
                )


class GroupService:
    """
    Business rules for groups.
    """

    @staticmethod
    def from_api_payload(
        data: dict,
        mark_set_id: str,
    ) -> Group:
        group = Group.from_api(data, mark_set_id=mark_set_id)
        group.validate()
        return group

    @staticmethod
    def to_api_payload(group: Group) -> dict:
        return group.to_api()

    @staticmethod
    def to_storage_row(group: Group) -> dict:
        return group.to_storage()
