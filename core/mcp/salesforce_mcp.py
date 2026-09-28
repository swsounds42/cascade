#!/usr/bin/env python3
"""
Salesforce MCP Server — Campaign management tools for Claude Code.

Connects to Salesforce via the OAuth client-credentials flow (the connected
app needs that flow enabled).
Provides campaign CRUD, deep cloning (with member statuses), and raw SOQL.

Environment variables required:
  SALESFORCE_CLIENT_ID
  SALESFORCE_CLIENT_SECRET
  SALESFORCE_INSTANCE_URL   (e.g. https://yourcompany.my.salesforce.com)
"""

import json
import os
import re
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx
from mcp.server.fastmcp import Context, FastMCP
from pydantic import BaseModel, ConfigDict, Field, field_validator

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CHARACTER_LIMIT = 25_000
SF_API_VERSION = "v62.0"

# Fields to copy when cloning a campaign (excludes system/read-only fields)
CAMPAIGN_CLONE_FIELDS = [
    "Type", "Status", "StartDate", "EndDate", "IsActive",
    "Description", "ParentId", "ExpectedRevenue", "BudgetedCost",
    "ActualCost", "ExpectedResponse", "NumberSent",
    "CampaignMemberRecordTypeId",
]


# ---------------------------------------------------------------------------
# Lifespan — authenticate once, reuse the token
# ---------------------------------------------------------------------------

@dataclass
class SalesforceContext:
    client: httpx.AsyncClient
    instance_url: str
    access_token: str
    api_base: str = field(init=False)

    def __post_init__(self):
        self.api_base = f"{self.instance_url}/services/data/{SF_API_VERSION}"


@asynccontextmanager
async def sf_lifespan(server: FastMCP) -> AsyncIterator[SalesforceContext]:
    """Authenticate with Salesforce on startup, close client on shutdown."""
    client_id = os.environ["SALESFORCE_CLIENT_ID"]
    client_secret = os.environ["SALESFORCE_CLIENT_SECRET"]
    instance_url = os.environ["SALESFORCE_INSTANCE_URL"].rstrip("/")

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Client Credentials OAuth flow (no password needed)
        resp = await client.post(
            f"{instance_url}/services/oauth2/token",
            data={
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret,
            },
        )
        resp.raise_for_status()
        auth = resp.json()
        access_token = auth["access_token"]
        # Salesforce may return a different instance URL
        resolved_url = auth.get("instance_url", instance_url)

        api_client = httpx.AsyncClient(
            timeout=30.0,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
        )
        try:
            yield SalesforceContext(
                client=api_client,
                instance_url=resolved_url,
                access_token=access_token,
            )
        finally:
            await api_client.aclose()


# ---------------------------------------------------------------------------
# Server init
# ---------------------------------------------------------------------------

mcp = FastMCP("salesforce_mcp", lifespan=sf_lifespan)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sf(ctx: Context) -> SalesforceContext:
    """Shorthand to get the Salesforce context from a tool."""
    return ctx.request_context.lifespan_context


def _handle_sf_error(e: Exception) -> str:
    """Format Salesforce API errors for the LLM."""
    if isinstance(e, httpx.HTTPStatusError):
        status = e.response.status_code
        try:
            body = e.response.json()
        except Exception:
            body = e.response.text
        if status == 400:
            # Salesforce returns a list of error dicts
            if isinstance(body, list):
                msgs = [err.get("message", str(err)) for err in body]
                return f"Error 400: {'; '.join(msgs)}"
            return f"Error 400: {body}"
        if status == 401:
            return "Error 401: Session expired or invalid credentials. Restart the MCP server."
        if status == 403:
            return "Error 403: Insufficient permissions. The connected user may be read-only."
        if status == 404:
            return "Error 404: Resource not found. Check the record ID."
        return f"Error {status}: {body}"
    if isinstance(e, httpx.TimeoutException):
        return "Error: Request timed out. Try a narrower query."
    return f"Error: {type(e).__name__}: {e}"


async def _soql(ctx: Context, query: str) -> dict:
    """Run a SOQL query and return the parsed response."""
    sf = _sf(ctx)
    resp = await sf.client.get(f"{sf.api_base}/query", params={"q": query})
    resp.raise_for_status()
    return resp.json()


async def _soql_all(ctx: Context, query: str) -> List[dict]:
    """Run a SOQL query and follow nextRecordsUrl for all results."""
    sf = _sf(ctx)
    resp = await sf.client.get(f"{sf.api_base}/query", params={"q": query})
    resp.raise_for_status()
    data = resp.json()
    records = data.get("records", [])
    while not data.get("done", True) and data.get("nextRecordsUrl"):
        resp = await sf.client.get(f"{sf.instance_url}{data['nextRecordsUrl']}")
        resp.raise_for_status()
        data = resp.json()
        records.extend(data.get("records", []))
    return records


async def _create_sobject(ctx: Context, sobject: str, payload: dict) -> dict:
    """Create a Salesforce record."""
    sf = _sf(ctx)
    resp = await sf.client.post(f"{sf.api_base}/sobjects/{sobject}", json=payload)
    resp.raise_for_status()
    return resp.json()


async def _update_sobject(ctx: Context, sobject: str, record_id: str, payload: dict) -> None:
    """Update a Salesforce record (PATCH)."""
    sf = _sf(ctx)
    resp = await sf.client.patch(f"{sf.api_base}/sobjects/{sobject}/{record_id}", json=payload)
    resp.raise_for_status()


def _clean_record(record: dict) -> dict:
    """Remove Salesforce metadata keys (attributes) from a record."""
    return {k: v for k, v in record.items() if k != "attributes"}


def _truncate(text: str) -> str:
    """Truncate text to CHARACTER_LIMIT with a notice."""
    if len(text) <= CHARACTER_LIMIT:
        return text
    return text[:CHARACTER_LIMIT] + "\n\n⚠️ Response truncated. Use filters or LIMIT to narrow results."


async def _analytics_get(ctx: Context, path: str, params: Optional[dict] = None) -> dict:
    """GET against the Analytics REST API."""
    sf = _sf(ctx)
    resp = await sf.client.get(f"{sf.api_base}/analytics/{path}", params=params)
    resp.raise_for_status()
    return resp.json()


async def _analytics_post(ctx: Context, path: str, payload: Optional[dict] = None) -> dict:
    """POST against the Analytics REST API."""
    sf = _sf(ctx)
    resp = await sf.client.post(f"{sf.api_base}/analytics/{path}", json=payload or {})
    resp.raise_for_status()
    return resp.json()


async def _analytics_patch(ctx: Context, path: str, payload: dict) -> dict:
    """PATCH against the Analytics REST API."""
    sf = _sf(ctx)
    resp = await sf.client.patch(f"{sf.api_base}/analytics/{path}", json=payload)
    resp.raise_for_status()
    return resp.json()


async def _analytics_put(ctx: Context, path: str, payload: Optional[dict] = None) -> dict:
    """PUT against the Analytics REST API."""
    sf = _sf(ctx)
    resp = await sf.client.put(f"{sf.api_base}/analytics/{path}", json=payload or {})
    resp.raise_for_status()
    return resp.json()


async def _metadata_soap(ctx: Context, action: str, body_xml: str) -> str:
    """Execute a Metadata SOAP API call. Returns the response XML body."""
    sf = _sf(ctx)
    envelope = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" '
        'xmlns:met="http://soap.sforce.com/2006/04/metadata">'
        "<soapenv:Header>"
        "<met:SessionHeader>"
        f"<met:sessionId>{sf.access_token}</met:sessionId>"
        "</met:SessionHeader>"
        "</soapenv:Header>"
        f"<soapenv:Body>{body_xml}</soapenv:Body>"
        "</soapenv:Envelope>"
    )
    resp = await sf.client.post(
        f"{sf.instance_url}/services/Soap/m/{SF_API_VERSION.lstrip('v')}",
        content=envelope,
        headers={
            "Content-Type": "text/xml; charset=UTF-8",
            "SOAPAction": action,
        },
    )
    resp.raise_for_status()
    return resp.text


def _listview_metadata_xml(
    full_name: str,
    label: str,
    filter_scope: str,
    columns: Optional[List[str]],
    filters: Optional[List[Dict[str, str]]],
    boolean_filter: Optional[str] = None,
    shared_to_all: bool = True,
) -> str:
    """Build a ListView metadata XML fragment for the Metadata SOAP API."""
    parts = [
        '<met:metadata xsi:type="met:ListView" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
        f"<met:fullName>{full_name}</met:fullName>",
        f"<met:label>{label}</met:label>",
        f"<met:filterScope>{filter_scope}</met:filterScope>",
    ]
    if columns:
        for c in columns:
            parts.append(f"<met:columns>{c}</met:columns>")
    if filters:
        for f in filters:
            parts.append("<met:filters>")
            parts.append(f"<met:field>{f['field']}</met:field>")
            parts.append(f"<met:operation>{f.get('operation', 'equals')}</met:operation>")
            if f.get("value") is not None:
                # Escape XML special chars in value
                val = str(f["value"]).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                parts.append(f"<met:value>{val}</met:value>")
            parts.append("</met:filters>")
    if boolean_filter:
        parts.append(f"<met:booleanFilter>{boolean_filter}</met:booleanFilter>")
    if shared_to_all:
        parts.append("<met:sharedTo><met:allInternalUsers></met:allInternalUsers></met:sharedTo>")
    parts.append("</met:metadata>")
    return "\n".join(parts)


def _parse_metadata_result(xml: str) -> dict:
    """Parse success/failure from a Metadata SOAP response."""
    success = "success>true" in xml
    messages = re.findall(r"<message>(.*?)</message>", xml)
    full_name = re.findall(r"<fullName>(.*?)</fullName>", xml)
    return {
        "success": success,
        "messages": messages,
        "full_name": full_name[0] if full_name else None,
    }


# ---------------------------------------------------------------------------
# Input models
# ---------------------------------------------------------------------------

class ResponseFormat(str, Enum):
    MARKDOWN = "markdown"
    JSON = "json"


class SoqlInput(BaseModel):
    """Run an arbitrary SOQL query against Salesforce."""
    model_config = ConfigDict(str_strip_whitespace=True)
    query: str = Field(..., description="SOQL query string (e.g. \"SELECT Id, Name FROM Campaign LIMIT 10\")", min_length=5)
    response_format: ResponseFormat = Field(default=ResponseFormat.MARKDOWN)


class ListCampaignsInput(BaseModel):
    """Filter and list campaigns."""
    model_config = ConfigDict(str_strip_whitespace=True)
    status: Optional[str] = Field(default=None, description="Campaign status filter (e.g. 'Planned', 'In Progress', 'Completed', 'Aborted')")
    type: Optional[str] = Field(default=None, description="Campaign type filter")
    name_contains: Optional[str] = Field(default=None, description="Filter campaigns whose name contains this string (case-insensitive)")
    is_active: Optional[bool] = Field(default=None, description="Filter by IsActive flag")
    created_after: Optional[str] = Field(default=None, description="ISO date (YYYY-MM-DD). Only campaigns created on or after this date.")
    limit: int = Field(default=50, ge=1, le=200, description="Max results")
    response_format: ResponseFormat = Field(default=ResponseFormat.MARKDOWN)


class GetCampaignInput(BaseModel):
    """Get a single campaign by ID or name."""
    model_config = ConfigDict(str_strip_whitespace=True)
    campaign_id: Optional[str] = Field(default=None, description="Salesforce Campaign ID (18-char)")
    name: Optional[str] = Field(default=None, description="Exact campaign name (used if campaign_id is not provided)")
    response_format: ResponseFormat = Field(default=ResponseFormat.MARKDOWN)

    @field_validator("campaign_id", "name")
    @classmethod
    def at_least_one(cls, v, info):
        # Validated together after all fields are set
        return v


class CloneCampaignInput(BaseModel):
    """Deep-clone a single campaign, including CampaignMemberStatus records."""
    model_config = ConfigDict(str_strip_whitespace=True)
    source_campaign_id: str = Field(..., description="ID of the campaign to clone")
    new_name: Optional[str] = Field(default=None, description="Name for the cloned campaign. Defaults to 'Copy of <original>'.")
    new_status: Optional[str] = Field(default="Planned", description="Status for the new campaign")
    new_start_date: Optional[str] = Field(default=None, description="New StartDate (YYYY-MM-DD)")
    new_end_date: Optional[str] = Field(default=None, description="New EndDate (YYYY-MM-DD)")
    clone_member_statuses: bool = Field(default=True, description="Also clone CampaignMemberStatus records")


class CloneCampaignsBulkInput(BaseModel):
    """Clone multiple campaigns at once — built for quarterly transitions."""
    model_config = ConfigDict(str_strip_whitespace=True)
    source_campaign_ids: List[str] = Field(..., description="List of Campaign IDs to clone", min_length=1, max_length=50)
    name_replace: Optional[str] = Field(default=None, description="Text to find in campaign names (e.g. 'Q1')")
    name_replace_with: Optional[str] = Field(default=None, description="Replacement text (e.g. 'Q2')")
    name_suffix: Optional[str] = Field(default=None, description="Suffix to append if not using find/replace (e.g. ' - Q2 Copy')")
    new_status: Optional[str] = Field(default="Planned", description="Status for all new campaigns")
    new_start_date: Optional[str] = Field(default=None, description="Shared StartDate for all clones (YYYY-MM-DD)")
    new_end_date: Optional[str] = Field(default=None, description="Shared EndDate for all clones (YYYY-MM-DD)")
    clone_member_statuses: bool = Field(default=True, description="Also clone CampaignMemberStatus records")


class UpdateCampaignInput(BaseModel):
    """Update fields on an existing campaign."""
    model_config = ConfigDict(str_strip_whitespace=True)
    campaign_id: str = Field(..., description="ID of the campaign to update")
    fields: Dict[str, Any] = Field(..., description="Dict of field names → new values (e.g. {\"Status\": \"In Progress\", \"EndDate\": \"2026-06-30\"})")


# --- Report input models ---

class ListReportsInput(BaseModel):
    """Search and list Salesforce reports."""
    model_config = ConfigDict(str_strip_whitespace=True)
    search: Optional[str] = Field(default=None, description="Search string — matches report name")
    folder_name: Optional[str] = Field(default=None, description="Filter to reports in this folder name")
    limit: int = Field(default=50, ge=1, le=200, description="Max results")
    response_format: ResponseFormat = Field(default=ResponseFormat.MARKDOWN)


class ListReportTypesInput(BaseModel):
    """Discover available report types."""
    model_config = ConfigDict(str_strip_whitespace=True)
    search: Optional[str] = Field(default=None, description="Filter report types by name (case-insensitive)")


class DescribeReportInput(BaseModel):
    """Get full metadata for a report."""
    model_config = ConfigDict(str_strip_whitespace=True)
    report_id: str = Field(..., description="Salesforce Report ID (15 or 18 char)")
    response_format: ResponseFormat = Field(default=ResponseFormat.MARKDOWN)


class CreateReportInput(BaseModel):
    """Create a new Salesforce report."""
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(..., description="Report name")
    report_type_id: str = Field(..., description="Report type API name (e.g. 'Opportunity', 'Contact'). Use sf_list_report_types to discover available types.")
    folder_id: str = Field(..., description="ID of the folder to save the report in")
    report_format: str = Field(default="TABULAR", description="TABULAR, SUMMARY, or MATRIX")
    detail_columns: Optional[List[str]] = Field(default=None, description="List of column API names to include (e.g. ['ACCOUNT_NAME', 'CREATED_DATE', 'AMOUNT'])")
    standard_date_column: Optional[str] = Field(default=None, description="Column for the standard date filter (e.g. 'CREATED_DATE')")
    standard_date_duration: Optional[str] = Field(default=None, description="Date range token (e.g. 'THIS_QUARTER', 'LAST_30_DAYS')")
    filters: Optional[List[Dict[str, str]]] = Field(default=None, description="Custom filters: [{\"column\": \"STAGE_NAME\", \"operator\": \"equals\", \"value\": \"Closed Won\"}]")
    groupings_down: Optional[List[Dict[str, str]]] = Field(default=None, description="Row groupings: [{\"name\": \"ACCOUNT_NAME\", \"dateGranularity\": \"NONE\"}]")


class UpdateReportFiltersInput(BaseModel):
    """Update filters on a single report."""
    model_config = ConfigDict(str_strip_whitespace=True)
    report_id: str = Field(..., description="Salesforce Report ID")
    standard_date_duration: Optional[str] = Field(default=None, description="New durationValue (e.g. 'THIS_QUARTER', 'LAST_QUARTER', 'THIS_FISCAL_YEAR', 'CUSTOM')")
    standard_date_column: Optional[str] = Field(default=None, description="Column for date filter (e.g. 'CREATED_DATE'). Only needed if changing the date field.")
    standard_date_start: Optional[str] = Field(default=None, description="Start date (YYYY-MM-DD) when durationValue is 'CUSTOM'")
    standard_date_end: Optional[str] = Field(default=None, description="End date (YYYY-MM-DD) when durationValue is 'CUSTOM'")
    filter_updates: Optional[Dict[str, str]] = Field(default=None, description='Dict mapping filter index to new value. E.g. {"0": "THIS_QUARTER", "2": "2026-01-01"}')
    response_format: ResponseFormat = Field(default=ResponseFormat.MARKDOWN)


class UpdateReportInput(BaseModel):
    """General-purpose report metadata update."""
    model_config = ConfigDict(str_strip_whitespace=True)
    report_id: str = Field(..., description="Salesforce Report ID")
    metadata: Dict[str, Any] = Field(..., description="Dict of reportMetadata fields to update (e.g. {\"name\": \"New Name\", \"detailColumns\": [...]})")


class BulkUpdateReportFiltersInput(BaseModel):
    """Bulk update filters across multiple reports."""
    model_config = ConfigDict(str_strip_whitespace=True)
    report_ids: List[str] = Field(..., description="List of Report IDs to update", min_length=1, max_length=50)
    standard_date_duration: Optional[str] = Field(default=None, description="New durationValue for the standard date filter (e.g. 'THIS_QUARTER')")
    standard_date_column: Optional[str] = Field(default=None, description="Column for the standard date filter")
    standard_date_start: Optional[str] = Field(default=None, description="Start date when durationValue is 'CUSTOM'")
    standard_date_end: Optional[str] = Field(default=None, description="End date when durationValue is 'CUSTOM'")
    filter_value_replace: Optional[str] = Field(default=None, description="Find this value in any custom filter (e.g. 'LAST_QUARTER')")
    filter_value_replace_with: Optional[str] = Field(default=None, description="Replace with this value (e.g. 'THIS_QUARTER')")
    dry_run: bool = Field(default=True, description="If True (default), only preview changes. Set False to apply.")


class RunReportInput(BaseModel):
    """Run a report and get results."""
    model_config = ConfigDict(str_strip_whitespace=True)
    report_id: str = Field(..., description="Salesforce Report ID")
    include_details: bool = Field(default=False, description="Include detail rows (can be large). Default returns summary only.")
    response_format: ResponseFormat = Field(default=ResponseFormat.MARKDOWN)


# --- Dashboard input models ---

class ListDashboardsInput(BaseModel):
    """Search and list Salesforce dashboards."""
    model_config = ConfigDict(str_strip_whitespace=True)
    search: Optional[str] = Field(default=None, description="Search string — matches dashboard name")
    folder_name: Optional[str] = Field(default=None, description="Filter to dashboards in this folder name")
    limit: int = Field(default=50, ge=1, le=200, description="Max results")
    response_format: ResponseFormat = Field(default=ResponseFormat.MARKDOWN)


class DescribeDashboardInput(BaseModel):
    """Get full metadata for a dashboard."""
    model_config = ConfigDict(str_strip_whitespace=True)
    dashboard_id: str = Field(..., description="Salesforce Dashboard ID")
    response_format: ResponseFormat = Field(default=ResponseFormat.MARKDOWN)


class CreateDashboardInput(BaseModel):
    """Create a new Salesforce dashboard."""
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(..., description="Dashboard name")
    folder_id: str = Field(..., description="ID of the folder to save the dashboard in")
    description: Optional[str] = Field(default=None, description="Dashboard description")
    components: Optional[List[Dict[str, Any]]] = Field(default=None, description="Dashboard components: [{\"reportId\": \"...\", \"componentType\": \"Chart\", \"header\": \"My Chart\"}]")


class UpdateDashboardInput(BaseModel):
    """Update dashboard metadata."""
    model_config = ConfigDict(str_strip_whitespace=True)
    dashboard_id: str = Field(..., description="Salesforce Dashboard ID")
    metadata: Dict[str, Any] = Field(..., description="Dict of dashboard metadata fields to update")


class RefreshDashboardInput(BaseModel):
    """Trigger an async dashboard refresh."""
    model_config = ConfigDict(str_strip_whitespace=True)
    dashboard_id: str = Field(..., description="Salesforce Dashboard ID")


# --- List View input models ---

class ListListViewsInput(BaseModel):
    """Search and list Salesforce list views."""
    model_config = ConfigDict(str_strip_whitespace=True)
    sobject_type: str = Field(..., description="Object type (e.g. 'Contact', 'Lead', 'Account', 'Opportunity')")
    search: Optional[str] = Field(default=None, description="Filter list views by name (case-insensitive)")
    limit: int = Field(default=50, ge=1, le=200, description="Max results")
    response_format: ResponseFormat = Field(default=ResponseFormat.MARKDOWN)


class DescribeListViewInput(BaseModel):
    """Get full metadata for a list view."""
    model_config = ConfigDict(str_strip_whitespace=True)
    sobject_type: str = Field(..., description="Object type (e.g. 'Contact')")
    listview_id: str = Field(..., description="ListView ID")
    response_format: ResponseFormat = Field(default=ResponseFormat.MARKDOWN)


class CreateListViewInput(BaseModel):
    """Create a new list view via the Tooling API."""
    model_config = ConfigDict(str_strip_whitespace=True)
    sobject_type: str = Field(..., description="Object type (e.g. 'Contact', 'Lead')")
    name: str = Field(..., description="List view name")
    filter_scope: str = Field(default="Everything", description="Scope: 'Everything', 'Mine', 'MyTerritory', 'MyTeamTerritory', 'Team'")
    columns: Optional[List[str]] = Field(default=None, description="Column API names to display (e.g. ['Name', 'Email', 'Phone', 'CreatedDate'])")
    filters: Optional[List[Dict[str, str]]] = Field(default=None, description="Filters: [{\"field\": \"LeadSource\", \"operation\": \"equals\", \"value\": \"Web\"}]. Operations: equals, notEqual, lessThan, greaterThan, lessOrEqual, greaterOrEqual, contains, notContain, startsWith, includes, excludes")
    boolean_filter: Optional[str] = Field(default=None, description="Boolean logic for filters (e.g. '1 AND (2 OR 3)'). If omitted, all filters are ANDed.")


class UpdateListViewInput(BaseModel):
    """Update a list view's filters, columns, or scope."""
    model_config = ConfigDict(str_strip_whitespace=True)
    sobject_type: str = Field(..., description="Object type (e.g. 'Contact') — needed to build the Metadata API fullName")
    listview_id: str = Field(..., description="ListView ID")
    name: Optional[str] = Field(default=None, description="New label for the list view")
    filter_scope: Optional[str] = Field(default=None, description="Scope: 'Everything', 'Mine', 'MyTerritory', 'MyTeamTerritory', 'Team'")
    columns: Optional[List[str]] = Field(default=None, description="Column API names to display")
    filters: Optional[List[Dict[str, str]]] = Field(default=None, description="Replacement filters (replaces all existing)")
    boolean_filter: Optional[str] = Field(default=None, description="Boolean logic for filters")


class RunListViewInput(BaseModel):
    """Run a list view and return results."""
    model_config = ConfigDict(str_strip_whitespace=True)
    sobject_type: str = Field(..., description="Object type (e.g. 'Contact')")
    listview_id: str = Field(..., description="ListView ID")
    limit: int = Field(default=50, ge=1, le=200, description="Max results")
    response_format: ResponseFormat = Field(default=ResponseFormat.MARKDOWN)


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@mcp.tool(
    name="sf_query",
    annotations={
        "title": "Run SOQL Query",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def sf_query(params: SoqlInput, ctx: Context) -> str:
    """Run an arbitrary SOQL query against Salesforce.

    Use this for ad-hoc exploration when the purpose-built tools don't cover your need.
    Returns up to 2000 records by default (Salesforce limit). Add LIMIT to your query for faster results.

    Examples:
      - "SELECT Id, Name, Status FROM Campaign WHERE Status = 'In Progress'"
      - "SELECT Id, Name FROM Account WHERE Industry = 'Technology' LIMIT 20"
    """
    try:
        data = await _soql(ctx, params.query)
        records = [_clean_record(r) for r in data.get("records", [])]
        total = data.get("totalSize", len(records))

        if not records:
            return f"No records found for query:\n```\n{params.query}\n```"

        if params.response_format == ResponseFormat.MARKDOWN:
            lines = [f"**{total} record(s) returned**\n"]
            for r in records:
                lines.append("---")
                for k, v in r.items():
                    lines.append(f"- **{k}**: {v}")
            return _truncate("\n".join(lines))
        else:
            return _truncate(json.dumps({"totalSize": total, "records": records}, indent=2, default=str))

    except Exception as e:
        return _handle_sf_error(e)


@mcp.tool(
    name="sf_list_campaigns",
    annotations={
        "title": "List Salesforce Campaigns",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def sf_list_campaigns(params: ListCampaignsInput, ctx: Context) -> str:
    """List campaigns with optional filters for status, type, name, active flag, and creation date.

    Great for finding campaigns to clone or getting an overview of Q1 vs Q2 campaigns.

    Returns: Campaign Name, ID, Status, Type, StartDate, EndDate, IsActive.
    """
    try:
        conditions = []
        if params.status:
            conditions.append(f"Status = '{params.status}'")
        if params.type:
            conditions.append(f"Type = '{params.type}'")
        if params.name_contains:
            conditions.append(f"Name LIKE '%{params.name_contains}%'")
        if params.is_active is not None:
            conditions.append(f"IsActive = {'true' if params.is_active else 'false'}")
        if params.created_after:
            conditions.append(f"CreatedDate >= {params.created_after}T00:00:00Z")

        where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
        query = f"SELECT Id, Name, Status, Type, StartDate, EndDate, IsActive, ParentId, CreatedDate FROM Campaign{where} ORDER BY CreatedDate DESC LIMIT {params.limit}"

        data = await _soql(ctx, query)
        records = [_clean_record(r) for r in data.get("records", [])]
        total = data.get("totalSize", len(records))

        if not records:
            return "No campaigns found matching your filters."

        if params.response_format == ResponseFormat.MARKDOWN:
            lines = [f"**{total} campaign(s) found**\n"]
            lines.append("| Name | ID | Status | Type | Start | End | Active |")
            lines.append("|------|-----|--------|------|-------|-----|--------|")
            for r in records:
                lines.append(
                    f"| {r.get('Name','')} | {r.get('Id','')} "
                    f"| {r.get('Status','')} | {r.get('Type','')} "
                    f"| {r.get('StartDate','')} | {r.get('EndDate','')} "
                    f"| {r.get('IsActive','')} |"
                )
            return _truncate("\n".join(lines))
        else:
            return _truncate(json.dumps({"totalSize": total, "records": records}, indent=2, default=str))

    except Exception as e:
        return _handle_sf_error(e)


@mcp.tool(
    name="sf_get_campaign",
    annotations={
        "title": "Get Campaign Details",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def sf_get_campaign(params: GetCampaignInput, ctx: Context) -> str:
    """Get full details for a single campaign, including its CampaignMemberStatus values.

    Provide either campaign_id or name. If name is used, returns the first exact match.
    """
    try:
        if not params.campaign_id and not params.name:
            return "Error: Provide either campaign_id or name."

        if params.campaign_id:
            cid = params.campaign_id
        else:
            data = await _soql(ctx, f"SELECT Id FROM Campaign WHERE Name = '{params.name}' LIMIT 1")
            recs = data.get("records", [])
            if not recs:
                return f"No campaign found with name '{params.name}'."
            cid = recs[0]["Id"]

        # Get campaign fields
        all_fields = ",".join(["Id", "Name"] + CAMPAIGN_CLONE_FIELDS + ["CreatedDate", "LastModifiedDate", "NumberOfContacts", "NumberOfLeads", "NumberOfResponses"])
        # Deduplicate in case of overlap
        all_fields = ",".join(dict.fromkeys(all_fields.split(",")))
        data = await _soql(ctx, f"SELECT {all_fields} FROM Campaign WHERE Id = '{cid}'")
        recs = data.get("records", [])
        if not recs:
            return f"No campaign found with ID '{cid}'."
        campaign = _clean_record(recs[0])

        # Get member statuses
        statuses = await _soql_all(ctx, f"SELECT Id, Label, IsDefault, HasResponded, SortOrder FROM CampaignMemberStatus WHERE CampaignId = '{cid}' ORDER BY SortOrder")
        statuses = [_clean_record(s) for s in statuses]

        if params.response_format == ResponseFormat.MARKDOWN:
            lines = [f"# {campaign.get('Name', 'Campaign')}\n"]
            for k, v in campaign.items():
                if v is not None:
                    lines.append(f"- **{k}**: {v}")
            if statuses:
                lines.append("\n## Member Statuses")
                for s in statuses:
                    default = " *(default)*" if s.get("IsDefault") else ""
                    responded = " ✓responded" if s.get("HasResponded") else ""
                    lines.append(f"- {s.get('Label','')}{default}{responded} (sort: {s.get('SortOrder','')})")
            return _truncate("\n".join(lines))
        else:
            result = {"campaign": campaign, "member_statuses": statuses}
            return _truncate(json.dumps(result, indent=2, default=str))

    except Exception as e:
        return _handle_sf_error(e)


async def _clone_single_campaign(
    ctx: Context,
    source_id: str,
    new_name: Optional[str],
    new_status: Optional[str],
    new_start_date: Optional[str],
    new_end_date: Optional[str],
    clone_member_statuses: bool,
) -> dict:
    """Core clone logic — returns {"success": bool, "id": str, "name": str, "error": str?}."""
    # Fetch source campaign
    fields = ",".join(["Id", "Name"] + CAMPAIGN_CLONE_FIELDS)
    data = await _soql(ctx, f"SELECT {fields} FROM Campaign WHERE Id = '{source_id}'")
    recs = data.get("records", [])
    if not recs:
        return {"success": False, "source_id": source_id, "error": f"Campaign {source_id} not found."}

    source = _clean_record(recs[0])
    clone_name = new_name or f"Copy of {source['Name']}"

    # Build payload — only include non-None fields
    payload = {"Name": clone_name}
    for f_name in CAMPAIGN_CLONE_FIELDS:
        if f_name == "Status" and new_status:
            payload["Status"] = new_status
        elif f_name == "StartDate" and new_start_date:
            payload["StartDate"] = new_start_date
        elif f_name == "EndDate" and new_end_date:
            payload["EndDate"] = new_end_date
        elif source.get(f_name) is not None:
            payload[f_name] = source[f_name]

    # Create the new campaign
    result = await _create_sobject(ctx, "Campaign", payload)
    new_id = result.get("id")
    if not new_id:
        return {"success": False, "source_id": source_id, "error": f"Create returned no ID: {result}"}

    # Clone CampaignMemberStatus records
    statuses_cloned = 0
    if clone_member_statuses:
        statuses = await _soql_all(
            ctx,
            f"SELECT Label, IsDefault, HasResponded, SortOrder FROM CampaignMemberStatus WHERE CampaignId = '{source_id}' ORDER BY SortOrder",
        )
        # New campaigns come with default statuses (Sent, Responded).
        # We need to check what already exists and only add missing ones.
        existing = await _soql_all(
            ctx,
            f"SELECT Label FROM CampaignMemberStatus WHERE CampaignId = '{new_id}'",
        )
        existing_labels = {_clean_record(s).get("Label", "").lower() for s in existing}

        for s in [_clean_record(st) for st in statuses]:
            label = s.get("Label", "")
            if label.lower() in existing_labels:
                continue
            try:
                await _create_sobject(ctx, "CampaignMemberStatus", {
                    "CampaignId": new_id,
                    "Label": label,
                    "HasResponded": s.get("HasResponded", False),
                    "SortOrder": s.get("SortOrder", 1),
                })
                statuses_cloned += 1
            except Exception:
                pass  # Non-critical — default statuses may conflict

    return {
        "success": True,
        "source_id": source_id,
        "source_name": source["Name"],
        "new_id": new_id,
        "new_name": clone_name,
        "statuses_cloned": statuses_cloned,
    }


@mcp.tool(
    name="sf_clone_campaign",
    annotations={
        "title": "Clone a Campaign",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": True,
    },
)
async def sf_clone_campaign(params: CloneCampaignInput, ctx: Context) -> str:
    """Deep-clone a single Salesforce campaign, including its CampaignMemberStatus records.

    Creates a new campaign with the same field values as the source.
    Override name, status, start/end dates as needed.

    Use sf_clone_campaigns_bulk for cloning multiple campaigns at once (e.g. Q1 → Q2).
    """
    try:
        result = await _clone_single_campaign(
            ctx,
            source_id=params.source_campaign_id,
            new_name=params.new_name,
            new_status=params.new_status,
            new_start_date=params.new_start_date,
            new_end_date=params.new_end_date,
            clone_member_statuses=params.clone_member_statuses,
        )
        if result["success"]:
            sf = _sf(ctx)
            link = f"{sf.instance_url}/lightning/r/Campaign/{result['new_id']}/view"
            return (
                f"Campaign cloned successfully.\n\n"
                f"- **Source**: {result['source_name']} ({result['source_id']})\n"
                f"- **New**: {result['new_name']} ({result['new_id']})\n"
                f"- **Member statuses cloned**: {result['statuses_cloned']}\n"
                f"- **Link**: {link}"
            )
        else:
            return f"Clone failed: {result.get('error', 'Unknown error')}"

    except Exception as e:
        return _handle_sf_error(e)


@mcp.tool(
    name="sf_clone_campaigns_bulk",
    annotations={
        "title": "Bulk Clone Campaigns (Q1→Q2)",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": True,
    },
)
async def sf_clone_campaigns_bulk(params: CloneCampaignsBulkInput, ctx: Context) -> str:
    """Clone multiple campaigns at once — designed for quarterly transitions.

    Provide a list of source Campaign IDs. For each one:
    1. Creates a new campaign with the same fields
    2. Optionally renames using find/replace (e.g. 'Q1' → 'Q2') or suffix
    3. Copies CampaignMemberStatus records

    Example: Clone all Q1 campaigns to Q2 by passing IDs from sf_list_campaigns
    with name_replace='Q1' and name_replace_with='Q2'.
    """
    try:
        results = []
        for source_id in params.source_campaign_ids:
            # Determine new name
            new_name = None  # Will be set after fetching source
            if params.name_replace and params.name_replace_with is not None:
                # We need the source name first — _clone_single_campaign handles default naming,
                # but we want to do find/replace. Fetch the name.
                data = await _soql(ctx, f"SELECT Name FROM Campaign WHERE Id = '{source_id}' LIMIT 1")
                recs = data.get("records", [])
                if recs:
                    original_name = _clean_record(recs[0]).get("Name", "")
                    new_name = original_name.replace(params.name_replace, params.name_replace_with)
            elif params.name_suffix:
                data = await _soql(ctx, f"SELECT Name FROM Campaign WHERE Id = '{source_id}' LIMIT 1")
                recs = data.get("records", [])
                if recs:
                    new_name = _clean_record(recs[0]).get("Name", "") + params.name_suffix

            result = await _clone_single_campaign(
                ctx,
                source_id=source_id,
                new_name=new_name,
                new_status=params.new_status,
                new_start_date=params.new_start_date,
                new_end_date=params.new_end_date,
                clone_member_statuses=params.clone_member_statuses,
            )
            results.append(result)

        # Format results
        successes = [r for r in results if r.get("success")]
        failures = [r for r in results if not r.get("success")]
        sf = _sf(ctx)

        lines = [f"## Bulk Clone Results\n", f"**{len(successes)}/{len(results)} succeeded**\n"]

        if successes:
            lines.append("### Cloned")
            lines.append("| Source | New Campaign | New ID | Statuses Cloned |")
            lines.append("|--------|-------------|--------|-----------------|")
            for r in successes:
                link = f"{sf.instance_url}/lightning/r/Campaign/{r['new_id']}/view"
                lines.append(
                    f"| {r.get('source_name','')} | {r.get('new_name','')} | [{r['new_id']}]({link}) | {r.get('statuses_cloned',0)} |"
                )

        if failures:
            lines.append("\n### Failed")
            for r in failures:
                lines.append(f"- **{r.get('source_id', '?')}**: {r.get('error', 'Unknown')}")

        return _truncate("\n".join(lines))

    except Exception as e:
        return _handle_sf_error(e)


@mcp.tool(
    name="sf_update_campaign",
    annotations={
        "title": "Update Campaign Fields",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def sf_update_campaign(params: UpdateCampaignInput, ctx: Context) -> str:
    """Update one or more fields on an existing campaign.

    Pass a dict of field names to new values. Common fields:
    Name, Status, Type, StartDate, EndDate, IsActive, Description, ParentId.

    Example: {"Status": "In Progress", "EndDate": "2026-06-30"}
    """
    try:
        await _update_sobject(ctx, "Campaign", params.campaign_id, params.fields)
        sf = _sf(ctx)
        link = f"{sf.instance_url}/lightning/r/Campaign/{params.campaign_id}/view"
        updated = ", ".join(f"{k}={v}" for k, v in params.fields.items())
        return f"Campaign updated.\n- **ID**: {params.campaign_id}\n- **Updated**: {updated}\n- **Link**: {link}"
    except Exception as e:
        return _handle_sf_error(e)


# ---------------------------------------------------------------------------
# Report tools
# ---------------------------------------------------------------------------

@mcp.tool(
    name="sf_list_reports",
    annotations={
        "title": "List Salesforce Reports",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def sf_list_reports(params: ListReportsInput, ctx: Context) -> str:
    """Search and list Salesforce reports by name or folder.

    Examples:
      - Search by name: search="Pipeline"
      - Filter by folder: folder_name="Sales Reports"
      - Combine both: search="Q2", folder_name="Marketing"
    """
    try:
        # If only search (no folder filter), use Analytics API for speed
        if params.search and not params.folder_name:
            data = await _analytics_get(ctx, "reports", params={"q": params.search})
            # Analytics API returns a flat list of report descriptors
            reports = data if isinstance(data, list) else []
            reports = reports[:params.limit]

            if not reports:
                return f"No reports found matching '{params.search}'."

            if params.response_format == ResponseFormat.MARKDOWN:
                lines = [f"**{len(reports)} report(s) found**\n"]
                lines.append("| Name | ID | Folder | Format |")
                lines.append("|------|-----|--------|--------|")
                for r in reports:
                    lines.append(
                        f"| {r.get('name','')} | {r.get('id','')} "
                        f"| {r.get('folderLabel', r.get('folderName', ''))} "
                        f"| {r.get('reportFormat','')} |"
                    )
                return _truncate("\n".join(lines))
            else:
                return _truncate(json.dumps(reports, indent=2, default=str))

        # SOQL path — supports folder filtering
        conditions = []
        if params.search:
            conditions.append(f"Name LIKE '%{params.search}%'")
        if params.folder_name:
            conditions.append(f"FolderName = '{params.folder_name}'")

        where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
        query = f"SELECT Id, Name, FolderName, Description, LastRunDate, Format FROM Report{where} ORDER BY LastRunDate DESC NULLS LAST LIMIT {params.limit}"

        data = await _soql(ctx, query)
        records = [_clean_record(r) for r in data.get("records", [])]
        total = data.get("totalSize", len(records))

        if not records:
            return "No reports found matching your filters."

        if params.response_format == ResponseFormat.MARKDOWN:
            lines = [f"**{total} report(s) found**\n"]
            lines.append("| Name | ID | Folder | Format | Last Run |")
            lines.append("|------|-----|--------|--------|----------|")
            for r in records:
                lines.append(
                    f"| {r.get('Name','')} | {r.get('Id','')} "
                    f"| {r.get('FolderName','')} | {r.get('Format','')} "
                    f"| {r.get('LastRunDate','')} |"
                )
            return _truncate("\n".join(lines))
        else:
            return _truncate(json.dumps({"totalSize": total, "records": records}, indent=2, default=str))

    except Exception as e:
        return _handle_sf_error(e)


@mcp.tool(
    name="sf_list_report_types",
    annotations={
        "title": "List Report Types",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def sf_list_report_types(params: ListReportTypesInput, ctx: Context) -> str:
    """Discover available Salesforce report types.

    Use this before creating a report to find the correct report_type_id.
    Each type determines which objects and fields are available.

    Example: search="Opportunity" to find opportunity-based report types.
    """
    try:
        data = await _analytics_get(ctx, "reportTypes")
        types = data if isinstance(data, list) else []

        if params.search:
            search_lower = params.search.lower()
            types = [t for t in types if search_lower in t.get("label", "").lower()]

        if not types:
            return f"No report types found{' matching ' + repr(params.search) if params.search else ''}."

        lines = [f"**{len(types)} report type(s) found**\n"]
        lines.append("| Type Name | Type ID | Description |")
        lines.append("|-----------|---------|-------------|")
        for t in types[:100]:  # Cap at 100 to avoid huge output
            lines.append(
                f"| {t.get('label','')} | {t.get('type','')} "
                f"| {(t.get('description','') or '')[:80]} |"
            )
        return _truncate("\n".join(lines))

    except Exception as e:
        return _handle_sf_error(e)


@mcp.tool(
    name="sf_describe_report",
    annotations={
        "title": "Describe Report Metadata",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def sf_describe_report(params: DescribeReportInput, ctx: Context) -> str:
    """Get full metadata for a report — filters, date range, columns, groupings.

    Shows filter index numbers for use with sf_update_report_filters.
    Use this to inspect a report before modifying it.
    """
    try:
        data = await _analytics_get(ctx, f"reports/{params.report_id}/describe")
        meta = data.get("reportMetadata", {})
        extended = data.get("reportExtendedMetadata", {})

        sf = _sf(ctx)
        link = f"{sf.instance_url}/lightning/r/Report/{params.report_id}/view"

        if params.response_format == ResponseFormat.JSON:
            return _truncate(json.dumps(data, indent=2, default=str))

        lines = [f"# {meta.get('name', 'Report')}\n"]
        lines.append(f"- **ID**: {meta.get('id', params.report_id)}")
        lines.append(f"- **Report Type**: {meta.get('reportType', {}).get('label', 'Unknown')}")
        lines.append(f"- **Format**: {meta.get('reportFormat', 'Unknown')}")
        lines.append(f"- **Link**: {link}")

        # Standard date filter
        sdf = meta.get("standardDateFilter", {})
        if sdf:
            lines.append(f"\n## Standard Date Filter")
            lines.append(f"- **Column**: {sdf.get('column', 'N/A')}")
            lines.append(f"- **Duration**: {sdf.get('durationValue', 'N/A')}")
            if sdf.get("startDate"):
                lines.append(f"- **Start**: {sdf['startDate']}")
            if sdf.get("endDate"):
                lines.append(f"- **End**: {sdf['endDate']}")

        # Custom filters
        filters = meta.get("reportFilters", [])
        if filters:
            lines.append(f"\n## Custom Filters ({len(filters)})")
            for i, f in enumerate(filters):
                lines.append(f"- **[{i}]** {f.get('column','')} {f.get('operator','')} `{f.get('value','')}`")

        # Groupings
        groupings_down = meta.get("groupingsDown", [])
        groupings_across = meta.get("groupingsAcross", [])
        if groupings_down or groupings_across:
            lines.append(f"\n## Groupings")
            for g in groupings_down:
                granularity = f" ({g['dateGranularity']})" if g.get("dateGranularity") and g["dateGranularity"] != "NONE" else ""
                lines.append(f"- **Row**: {g.get('name','')}{granularity}")
            for g in groupings_across:
                granularity = f" ({g['dateGranularity']})" if g.get("dateGranularity") and g["dateGranularity"] != "NONE" else ""
                lines.append(f"- **Column**: {g.get('name','')}{granularity}")

        # Detail columns
        columns = meta.get("detailColumns", [])
        if columns:
            # Try to resolve column labels from extended metadata
            col_info = extended.get("detailColumnInfo", {})
            lines.append(f"\n## Columns ({len(columns)})")
            for c in columns:
                label = col_info.get(c, {}).get("label", c)
                lines.append(f"- {label} (`{c}`)")

        return _truncate("\n".join(lines))

    except Exception as e:
        return _handle_sf_error(e)


@mcp.tool(
    name="sf_create_report",
    annotations={
        "title": "Create Report",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": True,
    },
)
async def sf_create_report(params: CreateReportInput, ctx: Context) -> str:
    """Create a new Salesforce report from scratch.

    Workflow: Use sf_list_report_types to find the report_type_id first.

    Example:
      name="Q2 Pipeline by Stage"
      report_type_id="Opportunity"
      folder_id="00lXXXXXX"
      report_format="SUMMARY"
      detail_columns=["ACCOUNT_NAME", "OPPORTUNITY_NAME", "AMOUNT", "CLOSE_DATE"]
      standard_date_column="CLOSE_DATE"
      standard_date_duration="THIS_QUARTER"
      groupings_down=[{"name": "STAGE_NAME", "dateGranularity": "NONE"}]
    """
    try:
        metadata: Dict[str, Any] = {
            "name": params.name,
            "reportType": {"type": params.report_type_id},
            "folderId": params.folder_id,
            "reportFormat": params.report_format,
        }

        if params.detail_columns:
            metadata["detailColumns"] = params.detail_columns

        if params.standard_date_column or params.standard_date_duration:
            sdf: Dict[str, Any] = {}
            if params.standard_date_column:
                sdf["column"] = params.standard_date_column
            if params.standard_date_duration:
                sdf["durationValue"] = params.standard_date_duration
            metadata["standardDateFilter"] = sdf

        if params.filters:
            metadata["reportFilters"] = [
                {
                    "column": f["column"],
                    "operator": f.get("operator", "equals"),
                    "value": f["value"],
                }
                for f in params.filters
            ]

        if params.groupings_down:
            metadata["groupingsDown"] = [
                {
                    "name": g["name"],
                    "sortAggregate": g.get("sortAggregate"),
                    "dateGranularity": g.get("dateGranularity", "NONE"),
                }
                for g in params.groupings_down
            ]

        data = await _analytics_post(ctx, "reports", {"reportMetadata": metadata})
        new_meta = data.get("reportMetadata", {})
        new_id = new_meta.get("id", "unknown")

        sf = _sf(ctx)
        link = f"{sf.instance_url}/lightning/r/Report/{new_id}/view"
        return (
            f"Report created.\n\n"
            f"- **Name**: {new_meta.get('name', params.name)}\n"
            f"- **ID**: {new_id}\n"
            f"- **Format**: {new_meta.get('reportFormat', params.report_format)}\n"
            f"- **Link**: {link}"
        )

    except Exception as e:
        return _handle_sf_error(e)


@mcp.tool(
    name="sf_update_report_filters",
    annotations={
        "title": "Update Report Filters",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def sf_update_report_filters(params: UpdateReportFiltersInput, ctx: Context) -> str:
    """Update the standard date filter or custom filters on a single report.

    Use sf_describe_report first to see current filter state and index numbers.

    Examples:
      - Flip date range: standard_date_duration="THIS_QUARTER"
      - Custom date: standard_date_duration="CUSTOM", standard_date_start="2026-01-01", standard_date_end="2026-03-31"
      - Update filter at index 0: filter_updates={"0": "Closed Won"}
    """
    try:
        # Fetch current metadata
        data = await _analytics_get(ctx, f"reports/{params.report_id}/describe")
        meta = data.get("reportMetadata", {})
        report_name = meta.get("name", params.report_id)

        changes = []
        patch: Dict[str, Any] = {}

        # Standard date filter updates
        if params.standard_date_duration or params.standard_date_column or params.standard_date_start or params.standard_date_end:
            old_sdf = meta.get("standardDateFilter", {})
            new_sdf = dict(old_sdf)  # Copy current values

            if params.standard_date_duration:
                changes.append(f"Standard date duration: `{old_sdf.get('durationValue')}` → `{params.standard_date_duration}`")
                new_sdf["durationValue"] = params.standard_date_duration
            if params.standard_date_column:
                changes.append(f"Standard date column: `{old_sdf.get('column')}` → `{params.standard_date_column}`")
                new_sdf["column"] = params.standard_date_column
            if params.standard_date_start:
                changes.append(f"Start date: `{old_sdf.get('startDate')}` → `{params.standard_date_start}`")
                new_sdf["startDate"] = params.standard_date_start
            if params.standard_date_end:
                changes.append(f"End date: `{old_sdf.get('endDate')}` → `{params.standard_date_end}`")
                new_sdf["endDate"] = params.standard_date_end

            patch["standardDateFilter"] = new_sdf

        # Custom filter updates by index
        if params.filter_updates:
            old_filters = list(meta.get("reportFilters", []))
            new_filters = [dict(f) for f in old_filters]

            for idx_str, new_value in params.filter_updates.items():
                idx = int(idx_str)
                if 0 <= idx < len(new_filters):
                    old_val = new_filters[idx].get("value", "")
                    changes.append(f"Filter [{idx}] ({new_filters[idx].get('column','')}): `{old_val}` → `{new_value}`")
                    new_filters[idx]["value"] = new_value
                else:
                    changes.append(f"Filter [{idx}]: **skipped** (index out of range, report has {len(old_filters)} filters)")

            patch["reportFilters"] = new_filters

        if not changes:
            return "No changes specified. Provide standard_date_duration, filter_updates, or other filter parameters."

        # Apply
        await _analytics_patch(ctx, f"reports/{params.report_id}", {"reportMetadata": patch})

        sf = _sf(ctx)
        link = f"{sf.instance_url}/lightning/r/Report/{params.report_id}/view"

        lines = [f"**{report_name}** updated.\n"]
        for c in changes:
            lines.append(f"- {c}")
        lines.append(f"\n[Open in Salesforce]({link})")
        return "\n".join(lines)

    except Exception as e:
        return _handle_sf_error(e)


@mcp.tool(
    name="sf_update_report",
    annotations={
        "title": "Update Report Metadata",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def sf_update_report(params: UpdateReportInput, ctx: Context) -> str:
    """General-purpose report update — change name, columns, groupings, or any metadata field.

    Pass a dict of reportMetadata fields to update. For filter-specific changes,
    use sf_update_report_filters instead.

    Example: {"name": "New Report Name", "detailColumns": ["ACCOUNT_NAME", "AMOUNT"]}
    """
    try:
        data = await _analytics_patch(
            ctx, f"reports/{params.report_id}", {"reportMetadata": params.metadata}
        )
        new_meta = data.get("reportMetadata", {})
        sf = _sf(ctx)
        link = f"{sf.instance_url}/lightning/r/Report/{params.report_id}/view"
        updated = ", ".join(f"{k}={v}" for k, v in params.metadata.items() if not isinstance(v, (list, dict)))
        return f"Report updated.\n- **ID**: {params.report_id}\n- **Name**: {new_meta.get('name', 'Unknown')}\n- **Updated**: {updated}\n- **Link**: {link}"
    except Exception as e:
        return _handle_sf_error(e)


@mcp.tool(
    name="sf_bulk_update_report_filters",
    annotations={
        "title": "Bulk Update Report Filters",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": True,
    },
)
async def sf_bulk_update_report_filters(params: BulkUpdateReportFiltersInput, ctx: Context) -> str:
    """Apply the same filter change across multiple reports. Dry-run by default.

    Designed for quarterly transitions — e.g. flip all reports from LAST_QUARTER to THIS_QUARTER.

    Two modes of operation:
    1. Standard date filter: set standard_date_duration to change the date range
    2. Custom filter find/replace: set filter_value_replace and filter_value_replace_with

    Always runs with dry_run=True first to preview. Set dry_run=False to apply.
    """
    try:
        results = []

        for report_id in params.report_ids:
            try:
                data = await _analytics_get(ctx, f"reports/{report_id}/describe")
                meta = data.get("reportMetadata", {})
                report_name = meta.get("name", report_id)
                changes = []
                patch: Dict[str, Any] = {}

                # Standard date filter
                if params.standard_date_duration:
                    old_sdf = meta.get("standardDateFilter", {})
                    old_val = old_sdf.get("durationValue", "N/A")
                    if old_val != params.standard_date_duration:
                        new_sdf = dict(old_sdf)
                        new_sdf["durationValue"] = params.standard_date_duration
                        if params.standard_date_column:
                            new_sdf["column"] = params.standard_date_column
                        if params.standard_date_start:
                            new_sdf["startDate"] = params.standard_date_start
                        if params.standard_date_end:
                            new_sdf["endDate"] = params.standard_date_end
                        patch["standardDateFilter"] = new_sdf
                        changes.append(f"Date: `{old_val}` → `{params.standard_date_duration}`")

                # Custom filter find/replace
                if params.filter_value_replace and params.filter_value_replace_with is not None:
                    old_filters = list(meta.get("reportFilters", []))
                    new_filters = [dict(f) for f in old_filters]
                    for i, f in enumerate(new_filters):
                        if f.get("value") == params.filter_value_replace:
                            changes.append(f"Filter [{i}] ({f.get('column','')}): `{f['value']}` → `{params.filter_value_replace_with}`")
                            new_filters[i]["value"] = params.filter_value_replace_with
                    if any(f.get("value") == params.filter_value_replace_with for f in new_filters):
                        patch["reportFilters"] = new_filters

                if not changes:
                    results.append({"id": report_id, "name": report_name, "status": "skipped", "reason": "no matching filters"})
                    continue

                if not params.dry_run:
                    await _analytics_patch(ctx, f"reports/{report_id}", {"reportMetadata": patch})

                results.append({
                    "id": report_id,
                    "name": report_name,
                    "status": "would_change" if params.dry_run else "updated",
                    "changes": changes,
                })

            except Exception as report_err:
                results.append({"id": report_id, "name": report_id, "status": "error", "reason": str(report_err)})

        # Format output
        mode = "DRY RUN — no changes applied" if params.dry_run else "APPLIED"
        changed = [r for r in results if r["status"] in ("would_change", "updated")]
        skipped = [r for r in results if r["status"] == "skipped"]
        errors = [r for r in results if r["status"] == "error"]

        lines = [f"## Bulk Filter Update ({mode})\n"]
        lines.append(f"**{len(changed)} changed** | {len(skipped)} skipped | {len(errors)} errors\n")

        if changed:
            lines.append("### Changes")
            for r in changed:
                lines.append(f"**{r['name']}** ({r['id']})")
                for c in r.get("changes", []):
                    lines.append(f"  - {c}")

        if skipped:
            lines.append("\n### Skipped (no matching filters)")
            for r in skipped:
                lines.append(f"- {r['name']} ({r['id']})")

        if errors:
            lines.append("\n### Errors")
            for r in errors:
                lines.append(f"- {r['name']}: {r.get('reason', 'Unknown')}")

        if params.dry_run and changed:
            lines.append(f"\n**To apply, re-run with `dry_run=False`.**")

        return _truncate("\n".join(lines))

    except Exception as e:
        return _handle_sf_error(e)


@mcp.tool(
    name="sf_run_report",
    annotations={
        "title": "Run Report",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def sf_run_report(params: RunReportInput, ctx: Context) -> str:
    """Run a report and return the results — summary aggregates and optionally detail rows.

    Useful for verifying filter changes worked or spot-checking report output.
    Default returns summary only (faster). Set include_details=True for row-level data.
    """
    try:
        payload: Dict[str, Any] = {}
        if not params.include_details:
            # Suppress detail rows for faster execution
            payload = {"reportMetadata": {"detailColumns": []}}

        data = await _analytics_post(ctx, f"reports/{params.report_id}", payload)
        meta = data.get("reportMetadata", {})
        fact_map = data.get("factMap", {})
        report_name = meta.get("name", params.report_id)

        if params.response_format == ResponseFormat.JSON:
            return _truncate(json.dumps(data, indent=2, default=str))

        lines = [f"# {report_name} — Results\n"]

        # Summary info
        lines.append(f"- **Report Format**: {meta.get('reportFormat', 'Unknown')}")
        sdf = meta.get("standardDateFilter", {})
        if sdf:
            lines.append(f"- **Date Range**: {sdf.get('durationValue', 'N/A')} on {sdf.get('column', 'N/A')}")

        # Aggregates from factMap
        agg_info = data.get("reportExtendedMetadata", {}).get("aggregateColumnInfo", {})

        # Grand totals are in the "T!T" key (or similar)
        grand_total_key = None
        for key in fact_map:
            if key.startswith("T") or key == "T!T":
                grand_total_key = key
                break

        if grand_total_key and fact_map.get(grand_total_key):
            aggs = fact_map[grand_total_key].get("aggregates", [])
            if aggs:
                lines.append(f"\n## Totals")
                agg_keys = list(agg_info.keys())
                for i, agg in enumerate(aggs):
                    label = agg_keys[i] if i < len(agg_keys) else f"Aggregate {i}"
                    agg_label = agg_info.get(label, {}).get("label", label)
                    lines.append(f"- **{agg_label}**: {agg.get('label', agg.get('value', 'N/A'))}")

        # Grouping rows (for SUMMARY/MATRIX reports)
        groupings = data.get("groupingsDown", {}).get("groupings", [])
        if groupings:
            lines.append(f"\n## Groups ({len(groupings)} rows)")
            for g in groupings[:50]:  # Cap display
                group_key = g.get("key", "")
                fact_key = f"{group_key}!T"
                group_aggs = fact_map.get(fact_key, {}).get("aggregates", [])
                agg_vals = []
                agg_keys = list(agg_info.keys())
                for i, agg in enumerate(group_aggs):
                    agg_label = agg_info.get(agg_keys[i], {}).get("label", "") if i < len(agg_keys) else ""
                    agg_vals.append(f"{agg_label}: {agg.get('label', agg.get('value', ''))}")
                agg_str = " | ".join(agg_vals) if agg_vals else ""
                lines.append(f"- **{g.get('label', group_key)}**: {agg_str}")

            if len(groupings) > 50:
                lines.append(f"  ... and {len(groupings) - 50} more")

        # Detail rows (if requested and available)
        if params.include_details:
            detail_cols = meta.get("detailColumns", [])
            col_info = data.get("reportExtendedMetadata", {}).get("detailColumnInfo", {})
            if detail_cols and "T!T" in fact_map:
                rows = fact_map["T!T"].get("rows", [])
                if rows:
                    lines.append(f"\n## Detail Rows ({len(rows)} total)")
                    # Header
                    headers = [col_info.get(c, {}).get("label", c) for c in detail_cols]
                    lines.append("| " + " | ".join(headers) + " |")
                    lines.append("| " + " | ".join(["---"] * len(headers)) + " |")
                    for row in rows[:100]:
                        cells = row.get("dataCells", [])
                        vals = [str(c.get("label", c.get("value", ""))) for c in cells]
                        lines.append("| " + " | ".join(vals) + " |")
                    if len(rows) > 100:
                        lines.append(f"\n*Showing 100 of {len(rows)} rows.*")

        return _truncate("\n".join(lines))

    except Exception as e:
        return _handle_sf_error(e)


# ---------------------------------------------------------------------------
# Dashboard tools
# ---------------------------------------------------------------------------

@mcp.tool(
    name="sf_list_dashboards",
    annotations={
        "title": "List Salesforce Dashboards",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def sf_list_dashboards(params: ListDashboardsInput, ctx: Context) -> str:
    """Search and list Salesforce dashboards by name or folder.

    Examples:
      - Search by name: search="Pipeline"
      - Filter by folder: folder_name="Sales Dashboards"
    """
    try:
        # SOQL on Dashboard object for folder filtering
        conditions = []
        if params.search:
            conditions.append(f"Title LIKE '%{params.search}%'")
        if params.folder_name:
            conditions.append(f"FolderName = '{params.folder_name}'")

        where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
        query = f"SELECT Id, Title, FolderName, Description, LastReferencedDate FROM Dashboard{where} ORDER BY LastReferencedDate DESC NULLS LAST LIMIT {params.limit}"

        data = await _soql(ctx, query)
        records = [_clean_record(r) for r in data.get("records", [])]
        total = data.get("totalSize", len(records))

        if not records:
            return "No dashboards found matching your filters."

        if params.response_format == ResponseFormat.MARKDOWN:
            lines = [f"**{total} dashboard(s) found**\n"]
            lines.append("| Title | ID | Folder | Last Referenced |")
            lines.append("|-------|-----|--------|-----------------|")
            for r in records:
                lines.append(
                    f"| {r.get('Title','')} | {r.get('Id','')} "
                    f"| {r.get('FolderName','')} "
                    f"| {r.get('LastReferencedDate','')} |"
                )
            return _truncate("\n".join(lines))
        else:
            return _truncate(json.dumps({"totalSize": total, "records": records}, indent=2, default=str))

    except Exception as e:
        return _handle_sf_error(e)


@mcp.tool(
    name="sf_describe_dashboard",
    annotations={
        "title": "Describe Dashboard",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def sf_describe_dashboard(params: DescribeDashboardInput, ctx: Context) -> str:
    """Get full metadata for a dashboard — components, source reports, filters, layout.

    Shows which reports feed each dashboard component.
    """
    try:
        data = await _analytics_get(ctx, f"dashboards/{params.dashboard_id}/describe")
        meta = data.get("dashboardMetadata", {})
        components = meta.get("components", [])

        sf = _sf(ctx)
        link = f"{sf.instance_url}/lightning/r/Dashboard/{params.dashboard_id}/view"

        if params.response_format == ResponseFormat.JSON:
            return _truncate(json.dumps(data, indent=2, default=str))

        lines = [f"# {meta.get('name', 'Dashboard')}\n"]
        lines.append(f"- **ID**: {meta.get('id', params.dashboard_id)}")
        if meta.get("description"):
            lines.append(f"- **Description**: {meta['description']}")
        lines.append(f"- **Running User**: {meta.get('runningUser', {}).get('displayName', 'N/A')}")
        lines.append(f"- **Link**: {link}")

        # Filters
        filters = meta.get("dashboardFilters", [])
        if filters:
            lines.append(f"\n## Filters ({len(filters)})")
            for f in filters:
                lines.append(f"- **{f.get('name', 'Filter')}**: {f.get('column', 'N/A')}")

        # Components
        if components:
            lines.append(f"\n## Components ({len(components)})")
            for c in components:
                props = c.get("properties", {})
                report_id = props.get("reportId", "N/A")
                header = c.get("header", "Unnamed")
                comp_type = c.get("componentType", "Unknown")
                lines.append(f"- **{header}** ({comp_type}) → Report: `{report_id}`")

        return _truncate("\n".join(lines))

    except Exception as e:
        return _handle_sf_error(e)


@mcp.tool(
    name="sf_create_dashboard",
    annotations={
        "title": "Create Dashboard",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": True,
    },
)
async def sf_create_dashboard(params: CreateDashboardInput, ctx: Context) -> str:
    """Create a new Salesforce dashboard.

    Create reports first with sf_create_report, then assemble them into a dashboard.

    Example components:
      [{"reportId": "00OXXXX", "componentType": "Chart", "header": "Pipeline by Stage"}]
    """
    try:
        metadata: Dict[str, Any] = {
            "name": params.name,
            "folderId": params.folder_id,
        }
        if params.description:
            metadata["description"] = params.description
        if params.components:
            metadata["components"] = [
                {
                    "componentType": c.get("componentType", "Chart"),
                    "header": c.get("header", ""),
                    "properties": {"reportId": c["reportId"]},
                }
                for c in params.components
            ]

        data = await _analytics_post(ctx, "dashboards", {"dashboardMetadata": metadata})
        new_meta = data.get("dashboardMetadata", {})
        new_id = new_meta.get("id", "unknown")

        sf = _sf(ctx)
        link = f"{sf.instance_url}/lightning/r/Dashboard/{new_id}/view"
        return (
            f"Dashboard created.\n\n"
            f"- **Name**: {new_meta.get('name', params.name)}\n"
            f"- **ID**: {new_id}\n"
            f"- **Components**: {len(params.components or [])}\n"
            f"- **Link**: {link}"
        )

    except Exception as e:
        return _handle_sf_error(e)


@mcp.tool(
    name="sf_update_dashboard",
    annotations={
        "title": "Update Dashboard",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def sf_update_dashboard(params: UpdateDashboardInput, ctx: Context) -> str:
    """Update dashboard metadata — name, components, filters, layout.

    Pass a dict of dashboardMetadata fields to update.
    Example: {"name": "New Name", "description": "Updated description"}
    """
    try:
        data = await _analytics_patch(
            ctx, f"dashboards/{params.dashboard_id}", {"dashboardMetadata": params.metadata}
        )
        new_meta = data.get("dashboardMetadata", {})
        sf = _sf(ctx)
        link = f"{sf.instance_url}/lightning/r/Dashboard/{params.dashboard_id}/view"
        return f"Dashboard updated.\n- **ID**: {params.dashboard_id}\n- **Name**: {new_meta.get('name', 'Unknown')}\n- **Link**: {link}"
    except Exception as e:
        return _handle_sf_error(e)


@mcp.tool(
    name="sf_refresh_dashboard",
    annotations={
        "title": "Refresh Dashboard",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def sf_refresh_dashboard(params: RefreshDashboardInput, ctx: Context) -> str:
    """Trigger an async dashboard refresh.

    Salesforce will re-run all component reports and update the dashboard data.
    """
    try:
        data = await _analytics_put(ctx, f"dashboards/{params.dashboard_id}")
        status = data.get("statusUrl", "submitted")
        sf = _sf(ctx)
        link = f"{sf.instance_url}/lightning/r/Dashboard/{params.dashboard_id}/view"
        return f"Dashboard refresh triggered.\n- **ID**: {params.dashboard_id}\n- **Status**: {status}\n- **Link**: {link}"
    except Exception as e:
        return _handle_sf_error(e)


# ---------------------------------------------------------------------------
# List View tools
# ---------------------------------------------------------------------------

@mcp.tool(
    name="sf_list_listviews",
    annotations={
        "title": "List List Views",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def sf_list_listviews(params: ListListViewsInput, ctx: Context) -> str:
    """List available list views for a given object type.

    Examples:
      - All Contact list views: sobject_type="Contact"
      - Search by name: sobject_type="Lead", search="MQL"
    """
    try:
        conditions = [f"SobjectType = '{params.sobject_type}'"]
        if params.search:
            conditions.append(f"Name LIKE '%{params.search}%'")

        where = f" WHERE {' AND '.join(conditions)}"
        query = f"SELECT Id, Name, DeveloperName, SobjectType, CreatedDate, LastModifiedDate FROM ListView{where} ORDER BY Name LIMIT {params.limit}"

        data = await _soql(ctx, query)
        records = [_clean_record(r) for r in data.get("records", [])]
        total = data.get("totalSize", len(records))

        if not records:
            return f"No list views found for {params.sobject_type}."

        if params.response_format == ResponseFormat.MARKDOWN:
            lines = [f"**{total} list view(s) found for {params.sobject_type}**\n"]
            lines.append("| Name | ID | Developer Name | Last Modified |")
            lines.append("|------|-----|----------------|---------------|")
            for r in records:
                lines.append(
                    f"| {r.get('Name','')} | {r.get('Id','')} "
                    f"| {r.get('DeveloperName','')} "
                    f"| {r.get('LastModifiedDate','')} |"
                )
            return _truncate("\n".join(lines))
        else:
            return _truncate(json.dumps({"totalSize": total, "records": records}, indent=2, default=str))

    except Exception as e:
        return _handle_sf_error(e)


@mcp.tool(
    name="sf_describe_listview",
    annotations={
        "title": "Describe List View",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def sf_describe_listview(params: DescribeListViewInput, ctx: Context) -> str:
    """Get full metadata for a list view — columns, filters, scope.

    Use this to inspect a list view before modifying it.
    """
    try:
        # Use the standard REST API describe endpoint
        sf = _sf(ctx)
        resp = await sf.client.get(
            f"{sf.api_base}/sobjects/{params.sobject_type}/listviews/{params.listview_id}/describe"
        )
        resp.raise_for_status()
        data = resp.json()

        link = f"{sf.instance_url}/lightning/o/{params.sobject_type}/list?filterName={params.listview_id}"

        if params.response_format == ResponseFormat.JSON:
            return _truncate(json.dumps(data, indent=2, default=str))

        lines = [f"# {data.get('label', 'List View')}\n"]
        lines.append(f"- **ID**: {data.get('id', params.listview_id)}")
        lines.append(f"- **Object**: {params.sobject_type}")
        lines.append(f"- **Scope**: {data.get('scope', 'N/A')}")
        lines.append(f"- **Link**: {link}")

        # Columns
        columns = data.get("columns", [])
        if columns:
            lines.append(f"\n## Columns ({len(columns)})")
            for c in columns:
                hidden = " *(hidden)*" if c.get("hidden") else ""
                lines.append(f"- {c.get('label', '')} (`{c.get('fieldNameOrPath', '')}`){hidden}")

        # Where clause / filters
        where_clause = data.get("whereCondition", {})
        conditions = where_clause.get("conditions", []) if where_clause else []
        if conditions:
            lines.append(f"\n## Filters ({len(conditions)})")
            for i, cond in enumerate(conditions):
                field = cond.get("field", "")
                op = cond.get("operator", "")
                values = cond.get("values", [])
                val_str = ", ".join(str(v) for v in values) if values else ""
                lines.append(f"- **[{i}]** {field} {op} `{val_str}`")

        # Order by
        order_by = data.get("orderBy", [])
        if order_by:
            lines.append(f"\n## Sort")
            for o in order_by:
                direction = "DESC" if o.get("isAscending") is False else "ASC"
                lines.append(f"- {o.get('fieldNameOrPath', '')} {direction}")

        return _truncate("\n".join(lines))

    except Exception as e:
        return _handle_sf_error(e)


@mcp.tool(
    name="sf_create_listview",
    annotations={
        "title": "Create List View",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": True,
    },
)
async def sf_create_listview(params: CreateListViewInput, ctx: Context) -> str:
    """Create a new list view for any object type via the Metadata SOAP API.

    Example:
      sobject_type="Contact"
      name="Q2 Inbound Leads"
      columns=["FULL_NAME", "CONTACT.EMAIL", "LeadSource", "CreatedDate"]
      filters=[{"field": "LeadSource", "operation": "equals", "value": "Demo Request"}]
      filter_scope="Everything"

    Note: Column names use Metadata API conventions — standard fields use
    uppercase tokens (FULL_NAME, CONTACT.EMAIL, ACCOUNT.NAME) while custom
    fields use their API name (My_Field__c).
    """
    try:
        # Build developer name from the label (alphanumeric + underscores)
        dev_name = re.sub(r"[^A-Za-z0-9]+", "_", params.name).strip("_")
        full_name = f"{params.sobject_type}.{dev_name}"

        xml = _listview_metadata_xml(
            full_name=full_name,
            label=params.name,
            filter_scope=params.filter_scope,
            columns=params.columns,
            filters=params.filters,
            boolean_filter=params.boolean_filter,
        )

        resp_xml = await _metadata_soap(ctx, "createMetadata", f"<met:createMetadata>{xml}</met:createMetadata>")
        result = _parse_metadata_result(resp_xml)

        if not result["success"]:
            return f"Failed to create list view: {'; '.join(result['messages'])}"

        # Look up the new ID
        data = await _soql(ctx, f"SELECT Id FROM ListView WHERE DeveloperName = '{dev_name}' AND SobjectType = '{params.sobject_type}' LIMIT 1")
        records = data.get("records", [])
        new_id = _clean_record(records[0])["Id"] if records else "unknown"

        sf = _sf(ctx)
        link = f"{sf.instance_url}/lightning/o/{params.sobject_type}/list?filterName={new_id}"
        return (
            f"List view created.\n\n"
            f"- **Name**: {params.name}\n"
            f"- **ID**: {new_id}\n"
            f"- **Object**: {params.sobject_type}\n"
            f"- **Link**: {link}"
        )

    except Exception as e:
        return _handle_sf_error(e)


@mcp.tool(
    name="sf_update_listview",
    annotations={
        "title": "Update List View",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def sf_update_listview(params: UpdateListViewInput, ctx: Context) -> str:
    """Update a list view's label, filters, columns, or scope via the Metadata SOAP API.

    Use sf_describe_listview first to see the current state.
    Filters and columns are replaced entirely — include all you want, not just changes.

    Example:
      sobject_type="Contact"
      listview_id="00BXXXX"
      filters=[{"field": "CreatedDate", "operation": "greaterThan", "value": "THIS_QUARTER"}]
      columns=["FULL_NAME", "CONTACT.EMAIL", "Phone"]
    """
    try:
        # Look up the DeveloperName for this list view
        data = await _soql(
            ctx,
            f"SELECT Id, Name, DeveloperName FROM ListView WHERE Id = '{params.listview_id}' LIMIT 1",
        )
        records = data.get("records", [])
        if not records:
            return f"No list view found with ID '{params.listview_id}'."
        lv = _clean_record(records[0])
        dev_name = lv["DeveloperName"]
        current_label = lv["Name"]

        full_name = f"{params.sobject_type}.{dev_name}"
        label = params.name or current_label

        # Describe current state for fields the user didn't specify
        sf = _sf(ctx)
        desc_resp = await sf.client.get(
            f"{sf.api_base}/sobjects/{params.sobject_type}/listviews/{params.listview_id}/describe"
        )
        desc_resp.raise_for_status()
        desc = desc_resp.json()

        # Use provided values or fall back to current
        filter_scope = params.filter_scope or desc.get("scope", "Everything")

        # Columns — use provided or extract from current describe
        columns = params.columns
        if columns is None:
            columns = [c.get("fieldNameOrPath", "") for c in desc.get("columns", []) if not c.get("hidden")]

        # Filters — use provided or extract from current describe
        filters = params.filters
        if filters is None:
            where_cond = desc.get("whereCondition", {})
            current_conditions = where_cond.get("conditions", []) if where_cond else []
            filters = [
                {
                    "field": c.get("field", ""),
                    "operation": c.get("operator", "equals"),
                    "value": ", ".join(str(v) for v in c.get("values", [])),
                }
                for c in current_conditions
            ]

        xml = _listview_metadata_xml(
            full_name=full_name,
            label=label,
            filter_scope=filter_scope,
            columns=columns,
            filters=filters,
            boolean_filter=params.boolean_filter,
        )

        resp_xml = await _metadata_soap(ctx, "updateMetadata", f"<met:updateMetadata>{xml}</met:updateMetadata>")
        result = _parse_metadata_result(resp_xml)

        if not result["success"]:
            return f"Failed to update list view: {'; '.join(result['messages'])}"

        link = f"{sf.instance_url}/lightning/o/{params.sobject_type}/list?filterName={params.listview_id}"

        changes = []
        if params.name:
            changes.append(f"Name: {params.name}")
        if params.filter_scope:
            changes.append(f"Scope: {params.filter_scope}")
        if params.columns:
            changes.append(f"Columns: {len(params.columns)}")
        if params.filters:
            changes.append(f"Filters: {len(params.filters)}")
        if params.boolean_filter:
            changes.append(f"Boolean filter: {params.boolean_filter}")

        return (
            f"List view updated.\n\n"
            f"- **ID**: {params.listview_id}\n"
            f"- **Updated**: {', '.join(changes)}\n"
            f"- **Link**: {link}"
        )

    except Exception as e:
        return _handle_sf_error(e)


@mcp.tool(
    name="sf_run_listview",
    annotations={
        "title": "Run List View",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": True,
    },
)
async def sf_run_listview(params: RunListViewInput, ctx: Context) -> str:
    """Run a list view and return the results.

    Useful for verifying filter changes or previewing list view output.
    """
    try:
        sf = _sf(ctx)
        resp = await sf.client.get(
            f"{sf.api_base}/sobjects/{params.sobject_type}/listviews/{params.listview_id}/results",
            params={"limit": params.limit},
        )
        resp.raise_for_status()
        data = resp.json()

        columns = data.get("columns", [])
        records = data.get("records", [])
        total = data.get("size", len(records))

        if not records:
            return "List view returned no results."

        if params.response_format == ResponseFormat.JSON:
            return _truncate(json.dumps(data, indent=2, default=str))

        lines = [f"**{total} record(s)** (showing {len(records)})\n"]

        # Table header from columns
        col_labels = [c.get("label", c.get("fieldNameOrPath", "")) for c in columns if not c.get("hidden")]
        col_fields = [c.get("fieldNameOrPath", "") for c in columns if not c.get("hidden")]

        if col_labels:
            lines.append("| " + " | ".join(col_labels) + " |")
            lines.append("| " + " | ".join(["---"] * len(col_labels)) + " |")

            for rec in records[:100]:
                row_cols = rec.get("columns", [])
                # Build a lookup from fieldNameOrPath to value
                col_values = {}
                for rc in row_cols:
                    col_values[rc.get("fieldNameOrPath", "")] = rc.get("value") or ""
                vals = [str(col_values.get(f, "")) for f in col_fields]
                lines.append("| " + " | ".join(vals) + " |")

            if len(records) > 100:
                lines.append(f"\n*Showing 100 of {total} records.*")

        return _truncate("\n".join(lines))

    except Exception as e:
        return _handle_sf_error(e)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    mcp.run(transport="stdio")
