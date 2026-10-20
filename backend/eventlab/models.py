from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Service(StrEnum):
    payment = "payment"
    inventory = "inventory"
    notification = "notification"


class Scenario(StrEnum):
    healthy = "healthy"
    retry = "retry"
    dead_letter = "dead_letter"
    duplicate = "duplicate"
    outbox_recovery = "outbox_recovery"
    direct_loss = "direct_loss"


class RunCreate(StrictModel):
    name: str = Field(default="Meu experimento", min_length=1, max_length=80)
    scenario: Scenario = Scenario.healthy
    max_attempts: int = Field(default=3, ge=1, le=8)
    retry_base_ms: int = Field(default=1000, ge=100, le=10000)


class OrderCreate(StrictModel):
    customer: str = Field(default="Ada Lovelace", min_length=1, max_length=80)
    product: str = Field(default="Mechanical keyboard", min_length=1, max_length=100)
    quantity: int = Field(default=1, ge=1, le=100)
    unit_price_cents: int = Field(default=24900, ge=1, le=100000000)
    publish_gap: bool = False


class FaultPatch(StrictModel):
    paused: bool | None = None
    fail_next: int | None = Field(default=None, ge=0, le=1000)
    latency_ms: int | None = Field(default=None, ge=0, le=15000)
    ack_loss_next: int | None = Field(default=None, ge=0, le=100)


class RunPatch(StrictModel):
    paused: bool
