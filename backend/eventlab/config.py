import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Settings:
    db_path: str = field(default_factory=lambda: os.getenv("EVENTLAB_DB", "data/eventlab.db"))
    api_token: str = field(default_factory=lambda: os.getenv("EVENTLAB_API_TOKEN", ""))
    origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(
            o.strip()
            for o in os.getenv("EVENTLAB_ORIGINS", "http://localhost:5173").split(",")
            if o.strip()
        )
    )
    worker_enabled: bool = True
    tick_seconds: float = 0.15
