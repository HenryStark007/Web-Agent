from typing import Any, Dict, List, Literal, Optional, Union
from pydantic import BaseModel, Field, field_validator


class SanitizedContext(BaseModel):
    redactedFields: List[str] = Field(default_factory=list)
    visibleActionableElements: List[str] = Field(default_factory=list)
    elements: Optional[List[Dict[str, Any]]] = Field(default_factory=list)


class AnalyzeRequest(BaseModel):
    task: str
    # Data URL (e.g. "data:image/png;base64,...."). Client guarantees this
    # screenshot was already redacted locally BEFORE this request was made.
    sanitized_screenshot_base64: str
    sanitized_context: SanitizedContext

    @field_validator("sanitized_screenshot_base64")
    @classmethod
    def must_be_data_url(cls, v: str) -> str:
        if not v.startswith("data:image"):
            raise ValueError("sanitized_screenshot_base64 must be a data:image/... URL")
        return v


class ClickAction(BaseModel):
    action: Literal["click"] = "click"
    target: str
    confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    reason: Optional[str] = None
    source: Optional[str] = None


class ClickCoordinateAction(BaseModel):
    action: Literal["click_coordinate"] = "click_coordinate"
    x: int
    y: int
    element_id: Optional[str] = None
    confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    reason: Optional[str] = None
    source: Optional[str] = None


class ScrollAction(BaseModel):
    action: Literal["scroll"] = "scroll"
    direction: Literal["up", "down"] = "down"
    amount: int = Field(default=400, ge=1, le=5000)
    confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    reason: Optional[str] = None
    source: Optional[str] = None


class TypeAction(BaseModel):
    action: Literal["type"] = "type"
    target: str  # name/placeholder/aria-label of the input field
    text: str    # text to type into the field
    confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    reason: Optional[str] = None
    source: Optional[str] = None


class WaitAction(BaseModel):
    action: Literal["wait"] = "wait"
    duration: int = Field(default=1000, ge=100, le=10000)
    reason: Optional[str] = None
    source: Optional[str] = None


class DoneAction(BaseModel):
    action: Literal["done"] = "done"
    reason: Optional[str] = None
    source: Optional[str] = None


AgentAction = Union[ClickAction, ClickCoordinateAction, ScrollAction, TypeAction, WaitAction, DoneAction]


class ErrorResponse(BaseModel):
    """Returned when something goes wrong — the extension should NOT execute any action."""
    error: str
    detail: str
    source: Optional[str] = None
