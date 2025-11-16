"""
Storage adapter interface for PDF Markbook.
Defines the contract that all storage backends must implement.
"""

from typing import Protocol, List, Dict, Any, Optional


class StorageAdapter(Protocol):
    """
    Protocol defining the interface for all storage adapters.

    This allows swapping between SQLite, Google Sheets, PostgreSQL, etc.
    without changing the router or business logic code.

    NOTE:
    - This protocol is aligned with the current Google Sheets implementation
      (SheetsAdapter) so all routers can type-check cleanly.
    """

    # ========== Documents ==========

    def list_documents(self) -> List[Dict[str, Any]]:
        """
        Return all documents as dictionaries.
        Used mainly by admin / maintenance flows.
        """
        ...

    def create_document(
        self,
        pdf_url: str,
        created_by: Optional[str] = None,
        part_number: Optional[str] = None,
        project_name: Optional[str] = None,
        external_id: Optional[str] = None,
        master_editors: Optional[str] = None,
    ) -> str:
        """
        Create a new document.

        Args:
            pdf_url: URL of the PDF document (usually cleaned storage.googleapis.com URL)
            created_by: Optional user ID/email of creator
            part_number: Optional business part number
            project_name: Optional project name
            external_id: Optional business identifier (e.g. Glide id: ProjectName+PartName)
            master_editors: Optional comma-separated list of emails allowed to edit master markset

        Returns:
            Generated document ID (doc_id).
        """
        ...

    def get_document(self, doc_id: str) -> Optional[Dict[str, Any]]:
        """
        Fetch a document row by its doc_id.

        Returns:
            Dict with document fields, or None if not found.
        """
        ...

    def get_document_by_business_key(
        self,
        *,
        project_name: str,
        external_id: str,
        part_number: str,
    ) -> Optional[Dict[str, Any]]:
        """
        Resolve a document by the 3-part business key:
        (project_name, external_id, part_number).

        All values are treated as trimmed strings.
        """
        ...

    def get_document_by_identifier(self, identifier: str) -> Optional[Dict[str, Any]]:
        """
        Legacy helper: try to resolve a document by a single identifier.

        Resolution order (implementation-dependent):
            1) doc_id exact match
            2) external_id exact match
            3) part_number exact match

        Returns:
            Dict with document fields, or None if not found.
        """
        ...

    def update_document(self, doc_id: str, updates: Dict[str, Any]) -> None:
        """
        Update fields on a document row.

        Implementations should:
            - overwrite only the provided keys
            - update 'updated_at' internally
        """
        ...

    # ========== Pages ==========

    def bootstrap_pages(
        self,
        doc_id: str,
        page_count: int,
        dims: List[Dict[str, Any]],
    ) -> None:
        """
        Bootstrap pages for a document.

        Args:
            doc_id: Document ID
            page_count: Total number of pages
            dims: List of page dimensions, each with:
                - page_index: 0-based page index
                - width_pt: Page width in points
                - height_pt: Page height in points
                - rotation_deg: Page rotation (0, 90, 180, 270)

        Raises:
            ValueError / HTTPException 409 if pages already exist for this document.
        """
        ...

    # ========== Mark Sets ==========

    def create_mark_set(
        self,
        doc_id: str,
        label: str,
        created_by: Optional[str] = None,
        marks: Optional[List[Dict[str, Any]]] = None,
        is_master: bool = False,
        description: Optional[str] = None,
    ) -> str:
        """
        Create a new mark set (optionally with initial marks).

        Args:
            doc_id: Document ID
            label: Mark set label/version/name for UI
            created_by: Optional user id / email
            marks: Optional list of mark dictionaries with fields such as:
                - page_index: 0-based page index
                - order_index: sequential navigation order (0..n-1)
                - label: display label (A, B, C, ...)
                - instrument: instrument name
                - is_required: bool
                - nx, ny, nw, nh: normalized coordinates
            is_master: Whether this mark set should be the master for this doc
            description: Optional free-text description

        Returns:
            Generated mark_set_id
        """
        ...

    def list_mark_sets_by_document(self, doc_id: str) -> List[Dict[str, Any]]:
        """
        List all mark sets belonging to a document.

        Returns:
            List of dicts with at least:
                - mark_set_id
                - doc_id
                - name
                - description
                - is_active
                - is_master
                - created_by
                - created_at
                - updated_by (optional)
                - update_history (optional JSON string)
        """
        ...

    def count_marks_by_mark_set(self, doc_id: str) -> Dict[str, int]:
        """
        For a given document, return a mapping:
            { mark_set_id: number_of_marks }

        Used by the Editor to show mark counts in the markset list.
        """
        ...

    def activate_mark_set(self, mark_set_id: str) -> None:
        """
        Activate a mark set (and deactivate all others for the same document).

        Args:
            mark_set_id: Mark set ID to activate

        Raises:
            ValueError / HTTPException 404 if mark set not found.
        """
        ...

    def set_master_mark_set(self, mark_set_id: str) -> None:
        """
        Mark this mark set as the single master for its document (is_master=TRUE).
        All other mark sets on the same document must become is_master=FALSE.
        """
        ...

    def update_mark_set(self, mark_set_id: str, label: Optional[str], updated_by: str) -> None:
        """
        Update mark set metadata (e.g. rename) and append to update_history.

        Args:
            mark_set_id: ID of the mark set to update
            label: New label/name (if not None)
            updated_by: Who performed the update
        """
        ...

    def clone_mark_set(self, mark_set_id: str, new_label: str, created_by: Optional[str]) -> str:
        """
        Deep-clone a mark set + its marks into a new mark set
        on the same document.

        Returns:
            Newly created mark_set_id.
        """
        ...

    def delete_mark_set(self, mark_set_id: str, requested_by: Optional[str] = None) -> None:
        """
        Delete a non-master mark set and all its dependent data
        (marks, groups, user inputs, reports).

        Implementations should enforce:
            - Cannot delete master markset
            - Only creator can delete (if requested_by provided)
        """
        ...

    # ========== Marks ==========

    def list_marks(self, mark_set_id: str) -> List[Dict[str, Any]]:
        """
        List all marks in a mark set, ordered by order_index.

        Returns:
            List of mark dictionaries with fields like:
                - mark_id
                - page_index
                - order_index
                - label
                - instrument
                - is_required
                - nx, ny, nw, nh
                - (optionally) zoom_hint, padding_pct, anchor
                - (optionally) other backend-specific fields

        Implementations may include extra fields; callers should be tolerant.
        """
        ...

    def list_distinct_instruments(self) -> List[str]:
        """
        Return a sorted list of distinct non-empty instrument names
        from all marks.

        Used by /instruments/suggestions endpoint.
        """
        ...

    def patch_mark(self, mark_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Partially update a mark.

        Typically used for:
            - instrument
            - is_required
            - display preferences

        Args:
            mark_id: Mark ID
            data: Partial update dict

        Returns:
            Updated mark dict.
        """
        ...

    # ========== Groups ==========

    def create_group(
        self,
        mark_set_id: str,
        page_index: int,
        name: str,
        nx: float,
        ny: float,
        nw: float,
        nh: float,
        mark_ids: List[str],
        created_by: Optional[str] = None,
    ) -> str:
        """
        Create a group rectangle for a QC mark_set.

        Returns:
            Generated group_id.
        """
        ...

    def list_groups(self, mark_set_id: str) -> List[Dict[str, Any]]:
        """
        List all groups for a given QC mark_set_id.
        """
        ...

    def list_groups_for_mark_set(self, mark_set_id: str) -> List[Dict[str, Any]]:
        """
        Same as list_groups; kept for compatibility with existing code.
        """
        ...

    def update_group(self, group_id: str, updates: Dict[str, Any]) -> Dict[str, Any]:
        """
        Update mutable fields of a group:
        - name, nx, ny, nw, nh, page_index, mark_ids

        Returns:
            Updated group row as dict.
        """
        ...

    def delete_group(self, group_id: str) -> None:
        """
        Delete a single group by group_id.
        """
        ...

    # ========== User Inputs (QC Values) ==========

    def create_user_input(
        self,
        mark_id: str,
        mark_set_id: str,
        user_value: str,
        submitted_by: str,
    ) -> str:
        """
        Persist a single user QC value for a mark.

        Returns:
            Generated input_id.
        """
        ...

    def create_user_inputs_batch(
        self,
        mark_set_id: str,
        entries: Dict[str, str],
        submitted_by: str,
    ) -> int:
        """
        Persist multiple user QC values in one call.

        Args:
            mark_set_id: Mark set ID
            entries: {mark_id: user_value}
            submitted_by: Who submitted

        Returns:
            Number of rows written.
        """
        ...

    def get_user_inputs(
        self,
        mark_set_id: str,
        submitted_by: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Fetch user input rows for a mark set, optionally filtered by user.

        Returns:
            List of dicts with fields:
                - input_id
                - mark_id
                - mark_set_id
                - user_value
                - submitted_at
                - submitted_by
        """
        ...

    def update_user_input(self, input_id: str, user_value: str) -> Dict[str, Any]:
        """
        Update a single user input row and return the updated row.
        """
        ...

    def delete_user_input(self, input_id: str) -> None:
        """
        Delete a single user input row.

        Raises:
            ValueError / HTTPException 404 if not found.
        """
        ...

    # ========== Reports ==========

    def create_report_record(
        self,
        mark_set_id: str,
        inspection_doc_url: str,
        created_by: Optional[str],
    ) -> str:
        """
        Persist a report metadata record (e.g. generated PDF URL).

        Returns:
            Generated report_id.
        """
        ...

    def list_reports(self, mark_set_id: str) -> List[Dict[str, Any]]:
        """
        List report records for a mark set.
        """
        ...
